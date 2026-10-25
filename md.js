// Minimal, escape-first Markdown renderer for answers (shared by the site and the extension).
(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

  function render(md) {
    const out = [];
    const parts = md.split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^[^\n]*\n/, '');
        out.push(`<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`);
        return;
      }
      let list = null;
      const close = () => {
        if (list) out.push(`</${list}>`);
        list = null;
      };
      for (const line of part.split('\n')) {
        const ul = /^\s*[-*]\s+(.*)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        if (ul || ol) {
          const kind = ul ? 'ul' : 'ol';
          if (list !== kind) {
            close();
            out.push(`<${kind}>`);
            list = kind;
          }
          const nested = /^\s{2,}/.test(line) ? ' class="sub"' : '';
          const value = ol ? ` value="${/\d+/.exec(line)[0]}"` : '';
          out.push(`<li${value}${nested}>${inline((ul || ol)[1])}</li>`);
        } else {
          close();
          if (h) out.push(`<p><strong>${inline(h[2])}</strong></p>`);
          else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
        }
      }
      close();
    });
    return out.join('');
  }

  /** The line after "Answer:" — what clipboard mode copies and dot mode shows first. */
  function shortAnswer(md) {
    const m = /\*\*Answer:\*\*\s*([\s\S]*?)(?:\n\s*\n|\*\*Why|$)/i.exec(md);
    const text = (m ? m[1] : md)
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/\*\*/g, '')
      .trim();
    return text;
  }

  globalThis.HidioMD = { render, shortAnswer };
})();
