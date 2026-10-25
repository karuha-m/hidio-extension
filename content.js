(() => {
  if (window.__hidio) return;
  window.__hidio = true;
  const top = window === window.top;

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

  document.addEventListener(
    'dblclick',
    async (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      const { dblclick = true } = await chrome.storage.sync.get('dblclick');
      if (!dblclick) return;
      window.getSelection()?.removeAllRanges();
      chrome.runtime.sendMessage({
        type: 'solve',
        text: questionText(e.target),
        point: {
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight,
        },
      });
    },
    true,
  );

  if (!top) return;

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'selection') reply({ text: String(window.getSelection() || '').slice(0, 4000) });
    if (msg.type === 'answer') render(msg);
    if (msg.type === 'mode') flashMode(msg.mode);
  });

  // ---- dot mode: a faint dot in the corner, the answer only while hovered ----
  let host;
  let root;
  function ui() {
    if (root) return root;
    host = document.createElement('hidio-dot');
    host.style.cssText = 'all:initial;position:fixed;right:10px;bottom:10px;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .d{width:8px;height:8px;border-radius:50%;background:#1c1b18;opacity:.28;margin-left:auto;transition:opacity .2s}
      .d.loading{animation:p 1s infinite}
      .d.err{background:#b9412b}
      @keyframes p{50%{opacity:.06}}
      .c{display:none;position:absolute;right:0;bottom:14px;width:340px;max-height:60vh;overflow:auto;background:#fffdf7;color:#1c1b18;
         border:1px solid #e4dfd3;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:11px 13px;border-radius:10px;box-shadow:0 12px 28px -12px #1c1b1855}
      .w:hover .c{display:block}
      .w:hover .d{opacity:.85}
      .c p{margin:0 0 6px}
      .c pre{white-space:pre-wrap;background:#f2eee4;padding:6px 8px;border-radius:6px;margin:0 0 6px}
      .c code{font:12px ui-monospace,Menlo,monospace}.c ul,.c ol{margin:0 0 6px;padding-left:18px}
      .c a{color:#1c1b18;text-decoration-color:#e0b800;text-decoration-thickness:2px}.c li.sub{margin-left:16px;list-style:circle}
    </style><div class="w"><div class="c"></div><div class="d"></div></div>`;
    document.documentElement.appendChild(host);
    return root;
  }

  function render(msg) {
    if (msg.mode !== 'dot') {
      host?.remove();
      host = root = null;
      return;
    }
    const r = ui();
    if (!host.isConnected) document.documentElement.appendChild(host);
    const dot = r.querySelector('.d');
    const card = r.querySelector('.c');
    dot.className = `d${msg.status === 'loading' || msg.status === 'streaming' ? ' loading' : ''}${msg.status === 'error' ? ' err' : ''}`;
    if (msg.status === 'error') {
      card.innerHTML = `<p></p>${msg.paywall ? '<a href="#" data-up>Unlock unlimited answers</a>' : ''}`;
      card.querySelector('p').textContent = msg.error;
      card.querySelector('[data-up]')?.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'open-upgrade' });
      });
    } else {
      card.innerHTML = msg.text ? HidioMD.render(msg.text) : '<p>Reading…</p>';
    }
  }

  function flashMode(mode) {
    render({
      mode: 'dot',
      status: 'done',
      text: `**Mode:** ${mode === 'dot' ? 'Dot' : mode === 'clipboard' ? 'Clipboard' : 'Side panel'}`,
    });
    setTimeout(() => {
      if (mode !== 'dot') render({ mode });
    }, 1200);
  }
})();
