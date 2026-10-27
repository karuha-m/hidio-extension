(() => {
  // After an update the old copy is orphaned (its runtime is gone) and the fresh injection takes over.
  if (window.__hidio?.()) return;
  window.__hidio = () => !!chrome.runtime?.id;
  const alive = () => !!chrome.runtime?.id;
  const top = window === window.top;
  // Random element names: nothing on the page is called "hidio" for a page script to look for.
  const tag = () => `x-${Math.random().toString(36).slice(2, 9)}`;

  // ---- picking a question ----
  function questionText(el) {
    let node = el instanceof Element ? el : el?.parentElement;
    let text = '';
    while (node && node !== document.body) {
      // innerText (not textContent) keeps the visible layout: line breaks between options, no hidden text.
      // biome-ignore lint/performance/useDomNodeTextContent: visible text is what the student sees
      text = (node.innerText || '').trim();
      if (text.length >= 120) break;
      node = node.parentElement;
    }
    return text.slice(0, 4000);
  }

  async function onDblclick(e) {
    if (!alive()) return document.removeEventListener('dblclick', onDblclick, true);
    if (e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
      return;
    const ok = await chrome.runtime
      .sendMessage({
        type: 'dblclick',
        text: questionText(e.target),
        point: { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight },
      })
      .catch((err) => console.debug('hidio unreachable', err.message));
    // The double-click also highlighted a word; clear it so the page looks untouched.
    if (ok) window.getSelection()?.removeAllRanges();
  }
  document.addEventListener('dblclick', onDblclick, true);

  if (!top) return;

  // Signing in on hidio.app signs the extension in too.
  if (location.hostname === 'hidio.app') {
    const share = () => {
      const token = localStorage.getItem('hidio_token');
      if (token && alive()) chrome.runtime.sendMessage({ type: 'web-token', token });
    };
    share();
    window.addEventListener('hidio-signed-in', share);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'answer') render(msg);
    if (msg.type === 'snip') snip();
    reply(true);
  });

  // ---- dot mode: a faint dot in a corner, the answer only while hovered ----
  const prefs = { corner: 'br', dotSize: 8, dotOpacity: 30 };
  let host;
  let root;
  let current;

  chrome.storage.sync.get(['dotCorner', 'dotSize', 'dotOpacity']).then(applyPrefs);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !alive()) return;
    if (changes.mode && changes.mode.newValue !== 'dot') removeDot();
    if (changes.dotCorner || changes.dotSize || changes.dotOpacity)
      chrome.storage.sync.get(['dotCorner', 'dotSize', 'dotOpacity']).then(applyPrefs);
  });

  function applyPrefs(s) {
    prefs.corner = s.dotCorner || 'br';
    prefs.dotSize = s.dotSize ?? 8;
    prefs.dotOpacity = s.dotOpacity ?? 30;
    if (!host) return;
    place();
  }

  function place() {
    const v = prefs.corner[0] === 't' ? 'top' : 'bottom';
    const h = prefs.corner[1] === 'l' ? 'left' : 'right';
    host.style.cssText = `all:initial;position:fixed;${v}:6px;${h}:6px;z-index:2147483647;`;
    const w = root.querySelector('.w');
    w.dataset.v = v;
    w.dataset.h = h;
    w.style.setProperty('--size', `${prefs.dotSize}px`);
    w.style.setProperty('--alpha', prefs.dotOpacity / 100);
  }

  function removeDot() {
    host?.remove();
    host = root = null;
  }

  function ui() {
    if (root) return root;
    host = document.createElement(tag());
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .w{position:relative;padding:6px;display:flex}
      .d{width:var(--size);height:var(--size);border-radius:50%;background:#1c1b18;opacity:var(--alpha);transition:opacity .2s,transform .2s}
      .w:hover .d{opacity:max(var(--alpha),.85);transform:scale(1.15)}
      .d.loading{animation:p 1s ease-in-out infinite}
      .d.err{background:#b9412b}
      @keyframes p{50%{opacity:calc(var(--alpha) * .25)}}
      .c{position:absolute;width:min(360px,calc(100vw - 32px));max-height:min(60vh,520px);overflow:auto;box-sizing:border-box;
         background:#fffdf7;color:#1c1b18;border:1px solid #e4dfd3;border-radius:12px;padding:12px 14px 10px;
         font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left;
         box-shadow:0 1px 2px rgb(28 27 24/.08),0 18px 40px -16px rgb(28 27 24/.45);
         opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .16s,transform .16s,visibility 0s .16s}
      .w[data-v=bottom] .c{bottom:calc(var(--size) + 14px)}.w[data-v=top] .c{top:calc(var(--size) + 14px);transform:translateY(-4px)}
      .w[data-h=right] .c{right:0}.w[data-h=left] .c{left:0}
      .w:hover .c{opacity:1;visibility:visible;transform:none;transition:opacity .16s,transform .16s}
      .k{font-size:11.5px;color:#77736a;margin:0 0 3px}
      .a{font-size:15.5px;font-weight:650;margin:0 0 8px}
      .a p{display:inline;box-shadow:inset 0 -.42em 0 #ffe14d;box-decoration-break:clone;-webkit-box-decoration-break:clone}
      .a pre{display:block;box-shadow:none}
      .r{color:#47443d;font-size:13.5px;border-top:1px dashed #e4dfd3;padding-top:8px}
      p{margin:0 0 6px}
      pre{white-space:pre-wrap;background:#f2eee4;padding:7px 9px;border-radius:7px;margin:0 0 6px}
      code{font:12.5px/1.45 ui-monospace,Menlo,Consolas,monospace}
      ul,ol{margin:0 0 6px;padding-left:18px}li{margin:0 0 2px}li.sub{margin-left:14px;list-style:circle}
      .e{color:#b9412b}
      .f{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:#77736a}
      button{all:unset;cursor:pointer;font:600 12.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1b18;
         padding:6px 10px;border-radius:7px;border:1px solid #e4dfd3;background:#fff}
      button:hover{background:#fff4b8;border-color:#1c1b18}
      .go{background:#1c1b18;color:#fff;border-color:#1c1b18}.go:hover{background:#3a3832;color:#fff}
      .dots::after{content:"";animation:t 1.2s steps(4) infinite}
      @keyframes t{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
    </style><div class="w"><div class="c"></div><div class="d"></div></div>`;
    root.querySelector('.c').addEventListener('click', onCardClick);
    document.documentElement.appendChild(host);
    place();
    return root;
  }

  const ACTIONS = { signin: 'Sign in', upgrade: 'Unlock unlimited answers', retry: 'Try again' };

  function render(msg) {
    if (msg.mode !== 'dot') return removeDot();
    current = msg;
    const r = ui();
    if (!host.isConnected) document.documentElement.appendChild(host);
    const busy = msg.status === 'loading' || msg.status === 'streaming';
    r.querySelector('.d').className = `d${busy ? ' loading' : ''}${msg.status === 'error' ? ' err' : ''}`;
    const card = r.querySelector('.c');
    if (msg.status === 'error') {
      card.innerHTML = `<p class="e"></p>${msg.action ? `<div class="f"><span></span><button class="go" data-act="${msg.action}">${ACTIONS[msg.action]}</button></div>` : ''}`;
      card.querySelector('.e').textContent = msg.error;
      return;
    }
    if (!msg.text) {
      card.innerHTML = '<p class="k dots">Reading the question</p>';
      return;
    }
    const parts = HidioMD.split(msg.text);
    card.innerHTML = parts
      ? `<p class="k">Answer</p><div class="a">${HidioMD.render(parts.answer)}</div>${parts.rest ? `<div class="r">${HidioMD.render(parts.rest)}</div>` : ''}`
      : HidioMD.render(msg.text);
    if (msg.status === 'done')
      card.insertAdjacentHTML(
        'beforeend',
        '<div class="f"><span>Only you can see this</span><button data-act="copy">Copy answer</button></div>',
      );
  }

  async function onCardClick(e) {
    const act = e.target.closest('button')?.dataset.act;
    if (!act || !alive()) return;
    if (act === 'copy') {
      await navigator.clipboard.writeText(HidioMD.shortAnswer(current.text));
      e.target.textContent = 'Copied';
      setTimeout(() => {
        e.target.textContent = 'Copy answer';
      }, 1400);
    }
    if (act === 'retry') chrome.runtime.sendMessage({ type: 'retry' });
    if (act === 'signin') chrome.runtime.sendMessage({ type: 'open', path: '/app/?from=ext' });
    if (act === 'upgrade') chrome.runtime.sendMessage({ type: 'open', path: '/app/?plans=1' });
  }

  // ---- area select: drag a box around the question ----
  let snipping = false;
  function snip() {
    if (snipping) return;
    snipping = true;
    const el = document.createElement(tag());
    el.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
    const sr = el.attachShadow({ mode: 'closed' });
    sr.innerHTML = `<style>
      .s{position:fixed;inset:0;background:rgb(28 27 24/.32);animation:in .15s ease-out}
      .b{position:fixed;border:2px solid #ffe14d;border-radius:4px;box-shadow:0 0 0 100vmax rgb(28 27 24/.32);display:none}
      .t{position:fixed;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;
         background:#1c1b18;color:#fff;font:600 13.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
         padding:10px 14px;border-radius:999px;box-shadow:0 10px 30px -10px rgb(0 0 0/.5);white-space:nowrap;
         animation:drop .22s cubic-bezier(.2,.8,.2,1)}
      .t i{width:8px;height:8px;border-radius:50%;background:#ffe14d}
      kbd{font:600 11px/1 system-ui,sans-serif;padding:3px 6px;border-radius:4px;background:#3a3832;color:#fff;border-bottom:2px solid #000}
      @keyframes in{from{opacity:0}}
      @keyframes drop{from{opacity:0;transform:translate(-50%,-8px)}}
    </style><div class="s"></div><div class="b"></div><div class="t"><i></i>Drag a box around the question<kbd>Esc</kbd></div>`;
    const shade = sr.querySelector('.s');
    const box = sr.querySelector('.b');
    let start = null;
    let rect = null;

    const close = () => {
      snipping = false;
      el.remove();
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return close();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      rect = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        w: Math.abs(e.clientX - start.x),
        h: Math.abs(e.clientY - start.y),
      };
      shade.style.display = 'none';
      Object.assign(box.style, {
        display: 'block',
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
      });
    });
    el.addEventListener('pointerup', () => {
      const picked = rect && rect.w > 10 && rect.h > 10 ? { ...rect, vw: window.innerWidth } : null;
      close();
      if (!picked || !alive()) return;
      // Wait until the overlay is gone from the screen before the tab is captured.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          setTimeout(() => chrome.runtime.sendMessage({ type: 'snipped', rect: picked }), 30),
        ),
      );
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      close();
    });
    window.addEventListener('keydown', onKey, true);
    document.documentElement.appendChild(el);
  }
})();
