// Chrome loads this as a service worker (md.js pulled in here); Firefox lists md.js before it in background.scripts.
if (typeof importScripts === 'function') importScripts('md.js');

const API = 'https://hidio.app';
const MODES = ['dot', 'clipboard', 'panel'];
const BADGE = {
  loading: ['…', '#1c1b18'],
  streaming: ['…', '#1c1b18'],
  done: ['✓', '#2f7d4f'],
  error: ['!', '#b9412b'],
};
const CANT_READ =
  "Hidio can't read this page. Browsers keep their own pages and the extension store private — open the question in a normal tab.";

// Opening the side panel only works synchronously inside a click / shortcut, so the mode is kept in memory.
let mode = 'dot';
const modeReady = chrome.storage.sync.get('mode').then((s) => {
  mode = s.mode || 'dot';
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.mode) mode = changes.mode.newValue || 'dot';
});

if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('side panel behavior', err));
} else {
  chrome.action.onClicked.addListener(() => browser.sidebarAction.toggle());
}

function openPanel(tab) {
  const open = chrome.sidePanel ? chrome.sidePanel.open({ windowId: tab.windowId }) : browser.sidebarAction.open();
  open.catch((err) => console.debug('panel not opened', err.message));
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const s = await chrome.storage.sync.get(['mode', 'dblclick']);
  if (!s.mode) await chrome.storage.sync.set({ mode: 'dot', dblclick: true });
  menus();
  // Chrome only injects content scripts into pages loaded after install, so tabs that are already open get them now.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => inject(t.id)));
  if (reason === 'install') chrome.tabs.create({ url: `${API}/install/?installed=1` });
});
chrome.runtime.onStartup.addListener(menus);

function menus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'text', title: 'Answer “%s” with Hidio', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'image', title: 'Answer this image with Hidio', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'area', title: 'Select a question to answer', contexts: ['page', 'frame'] });
  });
}

function inject(tabId) {
  return chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ['md.js', 'content.js'] })
    .then(() => true)
    .catch((err) => {
      console.debug('cannot inject', tabId, err.message);
      return false;
    });
}

// Tabs we cannot script (browser pages, the PDF viewer) until they navigate somewhere else.
const unreachable = new Set();
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') unreachable.delete(tabId);
});

async function toTab(tabId, msg) {
  if (unreachable.has(tabId)) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (err) {
    // Tabs opened before install or update have no content script yet; restricted pages never will.
    if (!(await inject(tabId))) {
      unreachable.add(tabId);
      return null;
    }
    return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch((retryErr) => {
      console.debug('tab not reachable', err.message, retryErr.message);
      return null;
    });
  }
}

function badge(tabId, status, id) {
  const [text, color] = BADGE[status] || ['', '#1c1b18'];
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch((err) => console.debug('badge', err.message));
  chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' }).catch((err) => console.debug('badge', err.message));
  chrome.action.setBadgeText({ tabId, text }).catch((err) => console.debug('badge', err.message));
  if (status === 'done' || status === 'error')
    setTimeout(async () => {
      const { last } = await chrome.storage.session.get('last');
      if (last?.id === id)
        chrome.action.setBadgeText({ tabId, text: '' }).catch((err) => console.debug('badge', err.message));
    }, 20_000);
}

// Every change to the current answer goes through one queue, so streamed chunks and follow-ups never overwrite each other.
let queue = Promise.resolve();
function update(id, patch) {
  const run = queue.then(async () => {
    const { last } = await chrome.storage.session.get('last');
    if (id && last?.id !== id) return null;
    const next = typeof patch === 'function' ? patch(last) : { ...last, ...patch };
    await chrome.storage.session.set({ last: next });
    return next;
  });
  // One failed write must not block every later one.
  queue = run.catch((err) => console.error('answer state update failed', err));
  return run;
}

function show(tabId, last) {
  if (!last) return;
  badge(tabId, last.status, last.id);
  const { id, status, text, error, action } = last;
  toTab(tabId, { type: 'answer', mode, id, status, text, error, action });
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function jpeg(source, { crop, maxSide = 2400, quality = 0.88 } = {}) {
  const bmp = await createImageBitmap(await (await fetch(source)).blob());
  const area = crop || { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const scale = Math.min(1, maxSide / Math.max(area.w, area.h));
  const w = Math.max(1, Math.round(area.w * scale));
  const h = Math.max(1, Math.round(area.h * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, area.x, area.y, area.w, area.h, 0, 0, w, h);
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
}

async function capture(tab, rect) {
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (!rect) return jpeg(shot);
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const s = bmp.width / rect.vw;
  const pad = 8;
  const x = Math.max(0, Math.round((rect.x - pad) * s));
  const y = Math.max(0, Math.round((rect.y - pad) * s));
  const crop = {
    x,
    y,
    w: Math.min(bmp.width - x, Math.round((rect.w + pad * 2) * s)),
    h: Math.min(bmp.height - y, Math.round((rect.h + pad * 2) * s)),
  };
  return jpeg(shot, { crop });
}

async function stream(body, onText) {
  const { token } = await chrome.storage.local.get('token');
  if (!token) throw Object.assign(new Error('Sign in to Hidio to get answers.'), { action: 'signin' });
  let res;
  try {
    res = await fetch(`${API}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, mode: 'full', source: 'ext' }),
    });
  } catch (err) {
    console.error('solve request failed', err);
    throw Object.assign(new Error('Could not reach Hidio. Check your connection and try again.'), { action: 'retry' });
  }
  if (!res.ok) {
    const data = await res.json().catch((err) => {
      console.error('solve error body unreadable', res.status, err);
      return {};
    });
    if (res.status === 401) await chrome.storage.local.remove('token');
    const action = res.status === 401 ? 'signin' : data.paywall ? 'upgrade' : res.status === 429 ? null : 'retry';
    throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { action });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let pushed = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (Date.now() - pushed > 90) {
        pushed = Date.now();
        await onText(text);
      }
    }
  } catch (err) {
    console.error('answer stream broke', err);
    throw Object.assign(new Error('The answer was cut off. Try again — it did not use up an answer.'), {
      action: 'retry',
    });
  }
  return text;
}

async function fail(tab, kind, error, action = null) {
  const last = {
    id: Date.now(),
    kind,
    status: 'error',
    text: '',
    error,
    action,
    url: tab.url,
    at: Date.now(),
    turns: [],
  };
  await chrome.storage.session.set({ last, thumb: '' });
  show(tab.id, last);
}

async function solve(tab, { kind = 'page', text, point, rect, image } = {}) {
  await modeReady;
  const id = Date.now();
  const tabId = tab.id;
  const base = { id, kind, status: 'loading', text: '', error: '', action: null, url: tab.url, at: id, turns: [] };
  await chrome.storage.session.set({ last: base, thumb: '' });
  show(tabId, base);

  const { token } = await chrome.storage.local.get('token');
  if (!token)
    return show(
      tabId,
      await update(id, { status: 'error', error: 'Sign in to Hidio to get answers.', action: 'signin' }),
    );

  if (!image) {
    try {
      image = await capture(tab, rect);
    } catch (err) {
      console.error('capture failed', err);
      return show(tabId, await update(id, { status: 'error', error: CANT_READ }));
    }
  }
  const ctx = { image, text, point, tabId, windowId: tab.windowId, url: tab.url, kind };
  await chrome.storage.session.set({ ctx });
  jpeg(image, { maxSide: 640, quality: 0.72 })
    .then(async (thumb) => {
      const { last } = await chrome.storage.session.get('last');
      if (last?.id === id) await chrome.storage.session.set({ thumb });
    })
    .catch((err) => console.error('thumbnail failed', err));

  try {
    const answer = await stream({ image, text, point }, async (t) =>
      show(tabId, await update(id, { status: 'streaming', text: t })),
    );
    const done = await update(id, { status: 'done', text: answer });
    if (!done) return;
    show(tabId, done);
    if (mode === 'clipboard') await copy(HidioMD.shortAnswer(answer));
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ id, text: answer, url: tab.url, at: id });
    await chrome.storage.local.set({ history: history.slice(0, 30) });
  } catch (err) {
    show(tabId, await update(id, { status: 'error', error: err.message, action: err.action ?? null }));
  }
}

async function followUp(ask) {
  const { last, ctx } = await chrome.storage.session.get(['last', 'ctx']);
  if (last?.status !== 'done' || !ctx) return;
  const id = last.id;
  const n = last.turns.length;
  const turns = [{ role: 'model', text: last.text }];
  for (const t of last.turns)
    if (t.status === 'done') turns.push({ role: 'user', text: t.ask }, { role: 'model', text: t.text });
  turns.push({ role: 'user', text: ask });
  const setTurn = (patch) =>
    update(id, (l) => ({ ...l, turns: l.turns.map((t, i) => (i === n ? { ...t, ...patch } : t)) }));

  await update(id, (l) => ({ ...l, turns: [...l.turns, { ask, text: '', status: 'loading' }] }));
  badge(ctx.tabId, 'loading', id);
  try {
    const answer = await stream({ image: ctx.image, text: ctx.text, point: ctx.point, turns }, (t) =>
      setTurn({ status: 'streaming', text: t }),
    );
    await setTurn({ status: 'done', text: answer });
    badge(ctx.tabId, 'done', id);
  } catch (err) {
    await setTurn({ status: 'error', error: err.message, action: err.action ?? null });
    badge(ctx.tabId, 'error', id);
  }
}

async function retry() {
  const { ctx } = await chrome.storage.session.get('ctx');
  if (!ctx) return;
  const tab = await chrome.tabs.get(ctx.tabId).catch(() => ({ id: ctx.tabId, windowId: ctx.windowId, url: ctx.url }));
  solve(tab, { kind: ctx.kind, image: ctx.image, text: ctx.text, point: ctx.point });
}

let ensuring = null;
async function copy(text) {
  // Firefox runs the background as a page, so it can write the clipboard itself.
  if (!chrome.offscreen) return navigator.clipboard.writeText(text);
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

async function snip(tab) {
  if (!(await toTab(tab.id, { type: 'snip' }))) fail(tab, 'area', CANT_READ);
}

async function fromKeys(tab) {
  // Whatever the student highlighted, in the page or inside an embedded quiz frame, tells the model which question.
  const frames = await chrome.scripting
    .executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => String(getSelection() || '').trim() })
    .catch((err) => {
      console.debug('selection not readable', err.message);
      return [];
    });
  const text = frames
    .map((f) => f.result)
    .find(Boolean)
    ?.slice(0, 4000);
  solve(tab, { kind: text ? 'text' : 'page', text });
}

async function siteAllowed(url) {
  const { dblclick = true, off = [] } = await chrome.storage.sync.get(['dblclick', 'off']);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (err) {
    console.debug('no host', url, err.message);
  }
  return dblclick && !off.includes(host);
}

async function openSite(path) {
  // The extension's session rides along in the hash, so the website opens already signed in to the same account.
  const { token } = await chrome.storage.local.get('token');
  chrome.tabs.create({ url: `${API}${path}${token ? `#t=${token}` : ''}` });
}

async function adopt(token) {
  const { token: mine } = await chrome.storage.local.get('token');
  if (mine || !token) return;
  const res = await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) await chrome.storage.local.set({ token });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tab = sender.tab;
  if (msg.type === 'dblclick' && tab) {
    siteAllowed(tab.url).then((ok) => {
      reply(ok);
      if (ok) solve(tab, { kind: 'click', text: msg.text, point: sender.frameId === 0 ? msg.point : undefined });
    });
    return true;
  }
  if (msg.type === 'snipped' && tab) solve(tab, { kind: 'area', rect: msg.rect });
  if (msg.type === 'web-token') adopt(msg.token).catch((err) => console.error('adopting web sign-in failed', err));
  if (msg.type === 'solve-tab' || msg.type === 'snip-tab')
    chrome.tabs.get(msg.tabId).then((t) => (msg.type === 'solve-tab' ? fromKeys(t) : snip(t)));
  if (msg.type === 'retry') retry();
  if (msg.type === 'follow-up') followUp(msg.ask);
  if (msg.type === 'open') openSite(msg.path);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) return;
  if ((command === 'solve' || command === 'snip') && mode === 'panel') openPanel(tab);
  if (command === 'solve') fromKeys(tab);
  if (command === 'snip') snip(tab);
  if (command === 'cycle-mode') {
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    await chrome.storage.sync.set({ mode: next });
    // The toolbar badge says which mode is on without drawing anything on the page.
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#1c1b18' });
    chrome.action.setBadgeText({ tabId: tab.id, text: { dot: 'DOT', clipboard: 'CLIP', panel: 'SIDE' }[next] });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 1800);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (mode === 'panel') openPanel(tab);
  if (info.menuItemId === 'text') solve(tab, { kind: 'text', text: info.selectionText });
  if (info.menuItemId === 'area') snip(tab);
  if (info.menuItemId === 'image') {
    const image = await jpeg(info.srcUrl).catch((err) => {
      console.error('image not readable, answering from the screen instead', err);
      return undefined;
    });
    solve(tab, { kind: 'image', image });
  }
});
