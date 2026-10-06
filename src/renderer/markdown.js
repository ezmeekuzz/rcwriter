// Minimal, escape-first Markdown renderer for previewing articles.
(function (root) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-external>$1</a>');
    return s;
  }

  function stripFrontMatter(src) {
    return src.replace(/^---\n[\s\S]*?\n---\n?/, '');
  }

  function render(src) {
    const lines = stripFrontMatter(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = [], list = null, quote = [], code = null;

    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); quote = []; } };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (code !== null) {
        if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
        else code.push(raw);
        continue;
      }
      if (/^```/.test(line)) { flushAll(); code = []; continue; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushAll(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
      if (/^(-{3,}|\*{3,})$/.test(line)) { flushAll(); out.push('<hr />'); continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara(); flushQuote();
        if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
        list.items.push(m[1]); continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara(); flushQuote();
        if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
        list.items.push(m[1]); continue;
      }
      if (!line.trim()) { flushAll(); continue; }
      flushList(); flushQuote();
      para.push(line.trim());
    }
    if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    flushAll();
    return out.join('\n');
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown: render, stripFrontMatter };
  else { root.renderMarkdown = render; root.stripFrontMatter = stripFrontMatter; }
})(this);
