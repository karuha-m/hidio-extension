const API = 'https://hidio.app';
const FREE = 5;
const $ = (id) => document.getElementById(id);
const mac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
const HINTS = {
  dot: 'A faint dot sits in the corner of the page. Hover it to read the answer.',
  clipboard: `Nothing appears on the page. When the Hidio icon shows ✓, paste the answer with ${mac ? '⌘' : 'Ctrl'}+V.`,
  panel: 'Answers show up only here, beside the page, with every step.',
};
const SOURCES = {
  page: 'Whole screen',
  click: 'Double-click',
  area: 'Selected area',
  text: 'Highlighted text',
  image: 'Image',
  history: 'Saved answer',
};
const COMMANDS = {
  solve: 'Answer the question on screen',
  snip: 'Select a question',
  'cycle-mode': 'Switch answer mode',
};
const ACTIONS = { signin: 'Sign in', upgrade: 'Unlock unlimited answers', retry: 'Try again' };

let user = null;
let view = 'login';
let email = '';
let shown = null;
let viewingHistory = false;
let siteHost = '';

// ---------- helpers ----------
async function api(path, body) {
  const { token } = await chrome.storage.local.get('token');
  const res = await fetch(`${API}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch((err) => {
    console.error('unreadable response', path, res.status, err);
    return {};
  });
  if (res.status === 401 && token) await chrome.storage.local.remove('token');
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { data });
  return data;
}

async function busy(btn, task) {
  btn.classList.add('busy');
  btn.disabled = true;
  try {
    return await task();
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    console.debug('no host for', url, err.message);
    return '';
  }
}

const plain = (md) =>
  md
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*/g, '')
    .trim();

function keysHtml(shortcut) {
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
  return parts.map((k) => `<kbd>${k.replace(/[<>&]/g, '')}</kbd>`).join('');
}

async function copyText(btn, text, label) {
  await navigator.clipboard.writeText(text);
  btn.classList.add('done');
  btn.lastChild.textContent = 'Copied';
  setTimeout(() => {
    btn.classList.remove('done');
    btn.lastChild.textContent = label;
  }, 1400);
}

// ---------- views ----------
function go(next) {
  view = user ? next : 'login';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `v-${view}`;
  for (const b of $('tools').querySelectorAll('[data-go]')) b.classList.toggle('on', b.dataset.go === view);
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function showUser(u) {
  user = u;
  $('tools').hidden = !u;
  $('plan').hidden = !u;
  if (!u) return go('login');
  const free = u.freeLeft ?? 0;
  $('plan').textContent = u.plan ? 'Unlimited' : `${free} free left`;
  $('plan').classList.toggle('paid', !!u.plan);
  $('quota').hidden = !!u.plan || free === 0;
  for (const [i, pip] of [...$('pips').children].entries()) pip.classList.toggle('on', i < free);
  $('quotaText').textContent = `${free} of ${FREE} free answers left`;
  $('paywall').hidden = !!u.plan || free > 0;
  $('acctEmail').textContent = u.email || '';
  $('acctPlan').textContent = u.plan
    ? `${u.plan === 'weekly' ? 'Weekly' : 'Monthly'} plan · ${u.cancelAtPeriodEnd ? 'ends' : 'renews'} ${new Date(u.planUntil * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : 'Free plan';
  if (view === 'login') go('home');
}

let lastRefresh = 0;
async function refreshUser() {
  lastRefresh = Date.now();
  const { token } = await chrome.storage.local.get('token');
  if (!token) return showUser(null);
  try {
    showUser((await api('/me')).user);
  } catch (err) {
    console.error('loading account failed', err);
    const { token: still } = await chrome.storage.local.get('token');
    if (!still) showUser(null);
  }
}

// ---------- sign in ----------
const boxes = [...$('otp').querySelectorAll('input')];
let resendTimer = 0;

function countdown(seconds) {
  clearInterval(resendTimer);
  let left = seconds;
  const btn = $('resend');
  const tick = () => {
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Resend in ${left}s` : 'Resend code';
    left -= 1;
    if (left < -1) clearInterval(resendTimer);
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

function codeStep(wait) {
  $('emailForm').hidden = true;
  $('codeForm').hidden = false;
  $('sentTo').textContent = email;
  for (const b of boxes) {
    b.value = '';
    b.classList.remove('filled');
  }
  boxes[0].focus();
  countdown(wait);
}

async function sendCode(btn) {
  $('loginErr').textContent = '';
  try {
    const r = await busy(btn, () => api('/auth/start', { email }));
    codeStep(r.resendAfter || 60);
  } catch (err) {
    // A code went out less than a minute ago: it is still valid, so go straight to entering it.
    if (err.data?.retryAfter) return codeStep(err.data.retryAfter);
    $('loginErr').textContent = err.message;
    shake($('loginErr'));
  }
}

function fillFrom(i, digits) {
  for (const [k, d] of [...digits].entries()) if (boxes[i + k]) boxes[i + k].value = d;
  const next = Math.min(i + digits.length, boxes.length - 1);
  boxes[next].focus();
  for (const b of boxes) b.classList.toggle('filled', !!b.value);
  if (boxes.every((b) => b.value)) $('codeForm').requestSubmit();
}

boxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    const digits = box.value.replace(/\D/g, '');
    box.value = '';
    if (digits) fillFrom(i, digits.slice(0, boxes.length - i));
    else box.classList.remove('filled');
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      boxes[i - 1].value = '';
      boxes[i - 1].classList.remove('filled');
      boxes[i - 1].focus();
      e.preventDefault();
    }
    if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
    if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
  });
  box.addEventListener('paste', (e) => {
    const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '');
    if (!digits) return;
    e.preventDefault();
    fillFrom(i, digits.slice(0, boxes.length - i));
  });
});

$('emailForm').addEventListener('submit', (e) => {
  e.preventDefault();
  email = $('email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    $('loginErr').textContent = 'Enter a valid email address.';
    shake($('email'));
    return;
  }
  sendCode(e.submitter || $('emailForm').querySelector('button'));
});
$('resend').addEventListener('click', () => sendCode($('resend')));
$('changeEmail').addEventListener('click', () => {
  $('codeForm').hidden = true;
  $('emailForm').hidden = false;
  $('loginErr').textContent = '';
  $('email').focus();
});
$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const code = boxes.map((b) => b.value).join('');
  const btn = $('codeForm').querySelector('button[type=submit]');
  if (code.length < 6) return shake($('otp'));
  try {
    const r = await busy(btn, () => api('/auth/verify', { email, code }));
    await chrome.storage.local.set({ token: r.token });
    showUser(r.user);
  } catch (err) {
    $('loginErr').textContent = err.message;
    shake($('otp'));
    for (const b of boxes) {
      b.value = '';
      b.classList.remove('filled');
    }
    boxes[0].focus();
  }
});
$('signout').addEventListener('click', async () => {
  await api('/auth/logout', {}).catch((err) => console.error('sign out failed', err));
  await chrome.storage.local.remove(['token', 'history']);
  await chrome.storage.session.remove(['last', 'thumb', 'ctx']);
  $('codeForm').hidden = true;
  $('emailForm').hidden = false;
  showUser(null);
});

// ---------- mode ----------
const MODES = ['dot', 'clipboard', 'panel'];
function showMode(mode) {
  $('modes').style.setProperty('--i', MODES.indexOf(mode));
  for (const b of $('modes').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.mode === mode);
  $('modeHint').textContent = HINTS[mode];
}
$('modes').addEventListener('click', (e) => {
  const mode = e.target.closest('button')?.dataset.mode;
  if (mode) chrome.storage.sync.set({ mode });
});

// ---------- answer ----------
function answerHtml(md) {
  const parts = HidioMD.split(md);
  if (!parts) return HidioMD.render(md);
  return `<p class="label">Answer</p><div class="answer">${HidioMD.render(parts.answer)}</div>${parts.rest ? `<div class="why">${HidioMD.render(parts.rest)}</div>` : ''}`;
}

function addCaret(el) {
  let n = el;
  while (n.lastElementChild && n.tagName !== 'PRE') n = n.lastElementChild;
  n.insertAdjacentHTML('beforeend', '<span class="caret"></span>');
}

function errorHtml(action) {
  return `<div class="error-box"><p></p>${action ? `<button type="button" class="btn ghost" data-act="${action}">${ACTIONS[action]}</button>` : ''}</div>`;
}

function fillBody(el, item) {
  if (item.status === 'loading') {
    el.innerHTML = '<div class="skeleton"><p>Reading the question…</p><i></i><i></i><i></i></div>';
  } else if (item.status === 'error') {
    el.innerHTML = errorHtml(item.action);
    el.querySelector('.error-box p').textContent = item.error;
  } else {
    el.innerHTML = answerHtml(item.text || '');
    if (item.status === 'streaming') addCaret(el);
  }
}

function renderLast(last, thumb) {
  shown = last;
  $('empty').hidden = !!last;
  $('card').hidden = !last;
  if (!last) return;
  const host = hostOf(last.url);
  const source = SOURCES[last.kind] || SOURCES.page;
  $('src').innerHTML = `${host ? '<b></b> · ' : ''}${source} · ${ago(last.at || last.id)}`;
  if (host) $('src').querySelector('b').textContent = host;
  $('shotBtn').hidden = !thumb;
  if (thumb) $('thumb').src = thumb;
  else $('card').classList.remove('open-shot');
  fillBody($('body'), last);

  const done = last.status === 'done';
  $('cardActions').hidden = !done;
  $('again').hidden = viewingHistory;
  $('askForm').hidden = !done || viewingHistory;

  const turns = $('turns');
  turns.innerHTML = '';
  for (const t of last.turns || []) {
    const row = document.createElement('div');
    row.className = 'turn';
    row.innerHTML = '<p class="q"></p><div class="body"></div>';
    row.querySelector('.q').textContent = t.ask;
    fillBody(row.querySelector('.body'), t);
    turns.appendChild(row);
  }
  const asking = (last.turns || []).some((t) => t.status === 'loading' || t.status === 'streaming');
  $('ask').disabled = asking;
  $('askForm').querySelector('button').disabled = asking;
  if (last.action === 'upgrade') $('paywall').hidden = false;
  if (done || last.status === 'error') {
    if (Date.now() - lastRefresh > 1500) refreshUser();
  }
}

async function loadLast() {
  const { last, thumb } = await chrome.storage.session.get(['last', 'thumb']);
  viewingHistory = false;
  renderLast(last || null, thumb || '');
}

$('card').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'retry') chrome.runtime.sendMessage({ type: 'retry' });
  if (act === 'signin') {
    chrome.storage.local.remove('token');
    showUser(null);
  }
  if (act === 'upgrade') chrome.runtime.sendMessage({ type: 'open', path: '/app/?plans=1' });
});
$('shotBtn').addEventListener('click', () => $('card').classList.toggle('open-shot'));
$('copyAnswer').addEventListener('click', (e) =>
  copyText(e.currentTarget, HidioMD.shortAnswer(shown?.text || ''), 'Copy answer'),
);
$('copyAll').addEventListener('click', (e) => copyText(e.currentTarget, plain(shown?.text || ''), 'Copy all'));
$('again').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'retry' }));
$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const ask = $('ask').value.trim();
  if (!ask) return shake($('ask'));
  $('ask').value = '';
  chrome.runtime.sendMessage({ type: 'follow-up', ask });
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
$('solveBtn').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab) chrome.runtime.sendMessage({ type: 'solve-tab', tabId: tab.id });
});
$('snipBtn').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab) chrome.runtime.sendMessage({ type: 'snip-tab', tabId: tab.id });
});

// ---------- history ----------
async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const list = $('history');
  list.innerHTML = '';
  $('historyEmpty').hidden = history.length > 0;
  $('clearHistory').hidden = !history.length;
  for (const h of history) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'h';
    row.innerHTML = '<b></b><small></small>';
    row.querySelector('b').textContent = HidioMD.shortAnswer(h.text).slice(0, 160) || '(empty)';
    row.querySelector('small').textContent = [hostOf(h.url), ago(h.at)].filter(Boolean).join(' · ');
    row.addEventListener('click', () => {
      viewingHistory = true;
      renderLast({ id: h.id, at: h.at, url: h.url, kind: 'history', status: 'done', text: h.text, turns: [] }, '');
      go('home');
    });
    list.appendChild(row);
  }
}
$('clearHistory').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  renderHistory();
});

// ---------- settings ----------
async function renderSettings() {
  const s = await chrome.storage.sync.get(['dblclick', 'off', 'dotCorner', 'dotSize', 'dotOpacity']);
  $('dblclick').checked = s.dblclick ?? true;
  showDot(s.dotCorner || 'br', s.dotSize ?? 8, s.dotOpacity ?? 30);
  await renderSite(s);
  const cmds = await chrome.commands.getAll();
  const list = $('shortcutList');
  list.innerHTML = '';
  for (const c of cmds) {
    if (!COMMANDS[c.name]) continue;
    const dt = document.createElement('dt');
    dt.textContent = COMMANDS[c.name];
    const dd = document.createElement('dd');
    dd.innerHTML = c.shortcut
      ? `<span class="keys inline">${keysHtml(c.shortcut)}</span>`
      : '<span class="unset">Not set</span>';
    list.append(dt, dd);
  }
  $('version').textContent = `Hidio ${chrome.runtime.getManifest().version}`;
}

async function renderSite(s) {
  const tab = await activeTab();
  siteHost = /^https?:/.test(tab?.url || '') ? new URL(tab.url).hostname : '';
  $('siteRow').hidden = !siteHost;
  $('siteName').textContent = siteHost.replace(/^www\./, '');
  $('siteOn').checked = !(s.off || []).includes(siteHost);
  $('siteOn').disabled = !(s.dblclick ?? true);
  $('siteRow').style.opacity = (s.dblclick ?? true) ? '' : '0.5';
}

function showDot(corner, size, opacity) {
  $('corners').dataset.c = corner;
  for (const b of $('corners').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.corner === corner);
  $('dotSize').value = size;
  $('dotOpacity').value = opacity;
  $('dotSizeOut').textContent = `${size}px`;
  $('dotOpacityOut').textContent = `${opacity}%`;
  $('previewDot').style.setProperty('--s', `${size}px`);
  $('previewDot').style.setProperty('--a', Math.max(opacity / 100, 0.04));
}

$('dblclick').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ dblclick: e.target.checked });
  renderSite(await chrome.storage.sync.get(['dblclick', 'off']));
});
$('siteOn').addEventListener('change', async (e) => {
  const { off = [] } = await chrome.storage.sync.get('off');
  const next = e.target.checked ? off.filter((h) => h !== siteHost) : [...new Set([...off, siteHost])];
  await chrome.storage.sync.set({ off: next });
});
$('corners').addEventListener('click', (e) => {
  const corner = e.target.closest('button')?.dataset.corner;
  if (corner) {
    chrome.storage.sync.set({ dotCorner: corner });
    showDot(corner, +$('dotSize').value, +$('dotOpacity').value);
  }
});
for (const id of ['dotSize', 'dotOpacity']) {
  // Preview follows the slider live; the page's dot updates when the slider is released.
  $(id).addEventListener('input', () => showDot($('corners').dataset.c, +$('dotSize').value, +$('dotOpacity').value));
  $(id).addEventListener('change', () => chrome.storage.sync.set({ [id]: +$(id).value }));
}
$('shortcuts').addEventListener('click', () => {
  if (chrome.commands.openShortcutSettings) chrome.commands.openShortcutSettings();
  else chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---------- wiring ----------
document.addEventListener('click', (e) => {
  const goTo = e.target.closest('[data-go]')?.dataset.go;
  if (goTo) {
    if (goTo === 'home' && viewingHistory) loadLast();
    go(goTo === view && goTo !== 'home' ? 'home' : goTo);
  }
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open) chrome.runtime.sendMessage({ type: 'open', path: open });
});

async function fillKeys() {
  const cmds = await chrome.commands.getAll();
  for (const el of document.querySelectorAll('.keys[data-cmd]')) {
    const c = cmds.find((x) => x.name === el.dataset.cmd);
    el.innerHTML = c?.shortcut ? keysHtml(c.shortcut) : '';
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && (changes.last || changes.thumb)) loadLast();
  if (area === 'local' && changes.history && view === 'history') renderHistory();
  if (area === 'local' && changes.token) refreshUser();
  if (area === 'sync' && changes.mode) showMode(changes.mode.newValue || 'dot');
});
chrome.tabs.onActivated.addListener(async () => {
  if (view === 'settings') renderSite(await chrome.storage.sync.get(['dblclick', 'off']));
});
// Back from the checkout tab: show the new plan without a reload.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastRefresh > 5000) refreshUser();
});
window.addEventListener('focus', () => {
  if (Date.now() - lastRefresh > 5000) {
    refreshUser();
    fillKeys();
  }
});

(async () => {
  const { mode = 'dot' } = await chrome.storage.sync.get('mode');
  showMode(mode);
  fillKeys();
  await loadLast();
  const { token } = await chrome.storage.local.get('token');
  if (token) {
    // Signed in already: show the answer view right away while the account loads.
    user = {};
    $('tools').hidden = false;
  }
  go('home');
  refreshUser();
})();
