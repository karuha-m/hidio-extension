const API = 'https://hidio.app';
const $ = (id) => document.getElementById(id);
const HINTS = {
  dot: 'A faint dot in the bottom-right corner of the page. Hover it to read the answer.',
  clipboard: 'Nothing is shown on the page. The answer is copied — paste it with Ctrl/⌘+V.',
  panel: 'Answers appear only here, in the side panel.',
};
let email = '';

async function api(path, body) {
  const { token } = await chrome.storage.local.get('token');
  const res = await fetch(`${API}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (res.status === 401) await chrome.storage.local.remove('token');
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showUser(user) {
  $('login').hidden = !!user;
  $('main').hidden = !user;
  if (!user) {
    $('plan').textContent = '';
    return;
  }
  $('plan').textContent = user.plan
    ? `${user.plan === 'weekly' ? 'Weekly' : 'Monthly'} plan`
    : `${user.freeLeft} free left`;
  $('upgrade').hidden = !!user.plan;
}

async function refreshUser() {
  const { token } = await chrome.storage.local.get('token');
  if (!token) return showUser(null);
  try {
    showUser((await api('/me')).user);
  } catch (err) {
    console.error('loading account failed', err);
    const { token: still } = await chrome.storage.local.get('token');
    showUser(still ? { plan: null, freeLeft: '?' } : null);
  }
}

function renderLast(last) {
  const box = $('answer');
  if (!last) return;
  box.hidden = false;
  if (last.status === 'error') {
    box.innerHTML = '<p class="err"></p>';
    box.querySelector('p').textContent = last.error;
    if (last.paywall) $('upgrade').hidden = false;
  } else {
    box.innerHTML = last.text ? HidioMD.render(last.text) : '<p class="muted">Reading your screen…</p>';
  }
  if (last.status === 'done') refreshUser();
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const list = $('history');
  list.innerHTML = '';
  for (const h of history) {
    const row = document.createElement('div');
    row.className = 'h';
    row.textContent = HidioMD.shortAnswer(h.text).slice(0, 90) || '(empty)';
    row.addEventListener('click', () => renderLast({ status: 'shown', text: h.text }));
    list.appendChild(row);
  }
}

async function setMode(mode) {
  await chrome.storage.sync.set({ mode });
  for (const b of $('modes').children) b.classList.toggle('on', b.dataset.mode === mode);
  $('modeHint').textContent = HINTS[mode];
}

$('emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  email = $('email').value.trim();
  try {
    await api('/auth/start', { email });
    $('emailForm').hidden = true;
    $('codeForm').hidden = false;
    $('sentTo').textContent = email;
    $('code').focus();
  } catch (err) {
    $('loginErr').textContent = err.message;
  }
});
$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const r = await api('/auth/verify', { email, code: $('code').value });
    await chrome.storage.local.set({ token: r.token });
    showUser(r.user);
  } catch (err) {
    $('loginErr').textContent = err.message;
  }
});
$('signout').addEventListener('click', async () => {
  await api('/auth/logout', {}).catch((err) => console.error('sign out failed', err));
  await chrome.storage.local.remove(['token', 'history']);
  showUser(null);
});
$('modes').addEventListener('click', (e) => e.target.dataset.mode && setMode(e.target.dataset.mode));
$('solveBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'solve-active' }));
$('upgrade').addEventListener('click', () => chrome.tabs.create({ url: `${API}/app/?plans=1` }));
$('account').addEventListener('click', () => {
  chrome.tabs.create({ url: `${API}/app/` });
});
$('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
$('dblclick').addEventListener('change', (e) => chrome.storage.sync.set({ dblclick: e.target.checked }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.last) renderLast(changes.last.newValue);
  if (area === 'local' && changes.history) renderHistory();
  if (area === 'local' && changes.token && !changes.token.newValue) showUser(null);
  if (area === 'sync' && changes.mode) setMode(changes.mode.newValue);
});

(async () => {
  const { mode = 'dot', dblclick = true } = await chrome.storage.sync.get(['mode', 'dblclick']);
  $('dblclick').checked = dblclick;
  setMode(mode);
  renderLast((await chrome.storage.session.get('last')).last);
  renderHistory();
  refreshUser();
})();
