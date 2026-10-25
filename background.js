const API = 'https://hidio.app';
const MODES = ['dot', 'clipboard', 'panel'];

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('side panel behavior', err));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { mode } = await chrome.storage.sync.get('mode');
  if (!mode) await chrome.storage.sync.set({ mode: 'dot', dblclick: true });
  if (reason === 'install') chrome.tabs.create({ url: `${API}/install/?installed=1` });
});

async function setLast(patch) {
  const { last } = await chrome.storage.session.get('last');
  const next = { ...(last || {}), ...patch };
  await chrome.storage.session.set({ last: next });
  return next;
}

function toTab(tabId, msg) {
  // Pages without the content script (chrome:// pages, the Web Store) reject; the side panel still gets the answer.
  return chrome.tabs
    .sendMessage(tabId, msg, { frameId: 0 })
    .catch((err) => console.debug('tab not reachable', err.message));
}

let ensuring = null;
async function copy(text) {
  if (!(await chrome.offscreen.hasDocument())) {
    ensuring ??= chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy the answer to the clipboard',
    });
    await ensuring;
    ensuring = null;
  }
  await chrome.runtime.sendMessage({ type: 'copy', text });
}

async function solve(tab, hint = {}) {
  const { token } = await chrome.storage.local.get('token');
  const { mode = 'dot' } = await chrome.storage.sync.get('mode');
  const id = Date.now();
  const show = async (patch) => {
    const last = await setLast({ id, ...patch });
    toTab(tab.id, { type: 'answer', mode, ...last });
  };

  if (!token)
    return show({
      status: 'error',
      error: 'Sign in to Hidio first: click the Hidio icon in your toolbar.',
      text: '',
    });
  await show({ status: 'loading', text: '', error: '', url: tab.url });

  let image;
  try {
    image = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 85,
    });
  } catch (err) {
    console.error('capture failed', err);
    return show({
      status: 'error',
      error: 'Chrome does not allow reading this page. Open the question in a normal tab and try again.',
    });
  }

  try {
    const res = await fetch(`${API}/api/solve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        image,
        text: hint.text,
        point: hint.point,
        mode: 'full',
        source: 'ext',
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      if (res.status === 401) await chrome.storage.local.remove('token');
      return show({
        status: 'error',
        error: data.error,
        paywall: !!data.paywall,
      });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    let lastPush = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (Date.now() - lastPush > 120) {
        lastPush = Date.now();
        await show({ status: 'streaming', text });
      }
    }
    await show({ status: 'done', text });
    if (mode === 'clipboard') {
      const md = text.match(/\*\*Answer:\*\*\s*([\s\S]*?)(?:\n\s*\n|\*\*Why|$)/i);
      await copy(
        (md ? md[1] : text)
          .replace(/```[a-z]*\n?/gi, '')
          .replace(/\*\*/g, '')
          .trim(),
      );
    }
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ id, text, url: tab.url, at: Date.now() });
    await chrome.storage.local.set({ history: history.slice(0, 20) });
  } catch (err) {
    console.error('solve failed', err);
    await show({
      status: 'error',
      error: 'Could not reach Hidio. Check your connection and try again.',
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'solve' && sender.tab) {
    const point = sender.frameId === 0 ? msg.point : undefined;
    solve(sender.tab, { text: msg.text, point });
  }
  if (msg.type === 'solve-active') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab && solve(tab));
  }
  if (msg.type === 'open-upgrade') chrome.tabs.create({ url: `${API}/app/?plans=1` });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'solve' && tab) {
    const picked = await chrome.tabs.sendMessage(tab.id, { type: 'selection' }, { frameId: 0 }).catch(() => null);
    solve(tab, { text: picked?.text });
  }
  if (command === 'cycle-mode') {
    const { mode = 'dot' } = await chrome.storage.sync.get('mode');
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    await chrome.storage.sync.set({ mode: next });
    if (tab) toTab(tab.id, { type: 'mode', mode: next });
  }
});
