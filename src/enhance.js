// Steps around writing an article: an editor's quality check, a featured image
// with alt text, schema markup (JSON-LD) and links from older posts.
const fs = require('fs');

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}\n[…truncated]` : s; };
const plain = (md) => String(md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();

// Pulls the first JSON object or array out of a model's answer.
function parseJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fence ? fence[1] : s;
  const start = cand.search(/[{[]/);
  if (start >= 0) {
    let tries = 0;
    for (let end = cand.length; end > start && tries < 400; end--) {
      const ch = cand[end - 1];
      if (ch !== '}' && ch !== ']') continue;
      tries += 1;
      try { return JSON.parse(cand.slice(start, end)); } catch { /* keep looking */ }
    }
  }
  throw new Error('The AI did not return the expected JSON.');
}

// ---------- article files ----------
function splitFront(fileText) {
  const m = String(fileText).match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return m ? { front: m[0], body: fileText.slice(m[0].length) } : { front: '', body: fileText };
}

function rewriteBody(filePath, newBody) {
  const { front } = splitFront(fs.readFileSync(filePath, 'utf8'));
  fs.writeFileSync(filePath, `${front}${String(newBody).trim()}\n`, 'utf8');
}

// ---------- quality check ----------
async function qualityCheck({ writer, knowledge, text, ai }) {
  const prompt = [
    writer.instructions && `## The writer's standing instructions\n${writer.instructions}`,
    writer.attitude && `## Required voice\n${writer.attitude}`,
    knowledge && `## Knowledge (the source of truth)\n${clip(knowledge, 40000)}`,
    `## Target\nAbout ${Number(writer.targetWords) || 1000} words, written in ${writer.language || 'English'}.`,
    `## Draft\n${text}`,
    [
      '## Your job',
      'Review the draft as a strict senior editor. Check:',
      '1. It follows every standing instruction.',
      '2. Every fact, price, date, number and name agrees with the knowledge. Flag claims that contradict it, and specific claims it does not support that could be wrong.',
      '3. It has the required voice, with no filler, repetition or generic AI phrasing ("in today\'s fast-paced world", "delve", "unlock").',
      '4. The title is specific, the structure is clear and the length is about right.',
      '5. It fully answers what a reader searching for this topic wants.',
      'Return only JSON: {"score": <1-10>, "mustFix": <true if anything is factually wrong or an instruction is broken>, "issues": ["specific problem and how to fix it", ...]}'
    ].join('\n')
  ].filter(Boolean).join('\n\n');
  const r = await ai({ system: 'You are a meticulous editor. You answer only with JSON.', prompt, maxTokens: 3000 });
  const j = parseJson(r.text);
  const score = Math.max(1, Math.min(10, Math.round(Number(j.score) || 0)));
  return { score, mustFix: !!j.mustFix, issues: (Array.isArray(j.issues) ? j.issues : []).map(String).filter(Boolean).slice(0, 15) };
}

async function revise({ system, text, issues, ai, maxTokens }) {
  const prompt = `Here is your draft:\n\n${text}\n\nYour editor found these problems:\n- ${issues.join('\n- ')}\n\nRewrite the article so every problem is fixed. Keep everything that already works. Return only the finished article in Markdown, with the title as a single H1 on the first line, and nothing else.`;
  const r = await ai({ system, prompt, maxTokens });
  if (!r.text || r.text.length < text.length * 0.5) throw new Error('The revision came back much shorter than the draft, so the draft was kept.');
  return r.text;
}

// ---------- featured image ----------
async function imageBrief({ ai, title, text, source }) {
  const prompt = `Article title: ${title}\n\nArticle start:\n${clip(plain(text), 3000)}\n\nPlan the featured image for this article. Return only JSON:\n{"prompt": "a detailed description of a realistic photograph that fits the article, with no text, words, logos or watermarks in it", "query": "2 to 4 words to search a stock photo library", "alt": "alt text under 125 characters that describes the image for someone who can't see it, naturally including the article's main topic"}${source === 'pexels' ? '\nThe image will come from a stock photo search, so make the query concrete and visual.' : ''}`;
  const r = await ai({ system: 'You plan images for articles. You answer only with JSON.', prompt, maxTokens: 800 });
  const j = parseJson(r.text);
  return { prompt: String(j.prompt || title), query: String(j.query || title).slice(0, 80), alt: String(j.alt || title).slice(0, 150) };
}

async function makeImage({ source, brief, openaiKey, pexelsKey, model }) {
  if (source === 'openai') {
    if (!openaiKey) throw new Error('Add an OpenAI API key under AI providers to generate images.');
    const m = model || 'gpt-image-1';
    const body = { model: m, prompt: `${brief.prompt}. Photorealistic, natural light. No text, words, letters, logos or watermarks.`, n: 1, size: m.startsWith('dall-e') ? '1792x1024' : '1536x1024' };
    if (m.startsWith('dall-e')) body.response_format = 'b64_json';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5 * 60000)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI images: ${(j.error && j.error.message) || res.status}`);
    const b64 = j.data && j.data[0] && j.data[0].b64_json;
    if (!b64) throw new Error('OpenAI returned no image.');
    return { buffer: Buffer.from(b64, 'base64'), mime: 'image/png', ext: 'png', alt: brief.alt, credit: '' };
  }
  if (source === 'pexels') {
    if (!pexelsKey) throw new Error('Add a free Pexels API key in Settings, Images.');
    const u = new URL('https://api.pexels.com/v1/search');
    u.searchParams.set('query', brief.query);
    u.searchParams.set('orientation', 'landscape');
    u.searchParams.set('per_page', '8');
    const res = await fetch(u, { headers: { authorization: pexelsKey }, signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Pexels: ${j.error || res.status}`);
    const photos = j.photos || [];
    if (!photos.length) throw new Error(`Pexels has no photos for "${brief.query}".`);
    const p = photos[Math.floor(Math.random() * Math.min(3, photos.length))];
    const img = await fetch(p.src.large2x || p.src.large || p.src.original, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error(`Couldn't download the Pexels photo (${img.status}).`);
    const buffer = Buffer.from(await img.arrayBuffer());
    return { buffer, mime: 'image/jpeg', ext: 'jpg', alt: p.alt && p.alt.length > 15 ? p.alt.slice(0, 150) : brief.alt /* Pexels' own alt describes the actual photo */, credit: `Photo by ${p.photographer} on Pexels`, creditUrl: p.url };
  }
  throw new Error('Unknown image source.');
}

// ---------- schema markup ----------
function faqFromMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  let inFaq = false;
  let faqLevel = 0;
  const out = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].replace(/[*_`]/g, '').trim();
      if (/\b(faq|faqs|frequently asked|common questions)\b/i.test(text)) { inFaq = true; faqLevel = level; cur = null; continue; }
      if (inFaq && level <= faqLevel) { inFaq = false; cur = null; continue; }
      if (inFaq) { cur = { q: text, a: [] }; out.push(cur); continue; }
    }
    if (!inFaq) continue;
    const bold = line.match(/^\s*(?:\*\*|__)(.+?\?)(?:\*\*|__)\s*(.*)$/);
    if (bold) { cur = { q: bold[1].trim(), a: bold[2] ? [bold[2]] : [] }; out.push(cur); continue; }
    if (cur && line.trim()) cur.a.push(line);
  }
  return out.map((x) => ({ q: x.q, a: plain(x.a.join(' ')) })).filter((x) => x.q.endsWith('?') && x.a.length > 10).slice(0, 20);
}

function buildSchema({ writer, title, excerpt, markdown, siteName, imageUrl, url, date = new Date() }) {
  const types = writer.schemaTypes || [];
  const graph = [];
  const b = writer.business || {};
  const org = b.name ? { '@type': 'Organization', name: b.name, ...(b.url ? { url: b.url } : {}) } : siteName ? { '@type': 'Organization', name: siteName } : null;
  if (types.includes('article')) {
    graph.push({
      '@type': writer.schemaArticleType === 'BlogPosting' ? 'BlogPosting' : 'Article',
      headline: String(title).slice(0, 110),
      ...(excerpt ? { description: excerpt } : {}),
      datePublished: date.toISOString(), dateModified: date.toISOString(),
      inLanguage: writer.language && /^[a-z]{2}(-[A-Z]{2})?$/.test(writer.language) ? writer.language : undefined,
      ...(imageUrl ? { image: imageUrl } : {}),
      ...(url ? { mainEntityOfPage: url } : {}),
      ...(org ? { author: org, publisher: org } : {})
    });
  }
  if (types.includes('faq')) {
    const faq = faqFromMarkdown(markdown);
    if (faq.length >= 2) graph.push({ '@type': 'FAQPage', mainEntity: faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) });
  }
  if (types.includes('localBusiness') && b.name) {
    graph.push({
      '@type': b.type || 'LocalBusiness', name: b.name,
      ...(b.url ? { url: b.url } : {}), ...(b.phone ? { telephone: b.phone } : {}), ...(b.address ? { address: b.address } : {}),
      ...(b.area ? { areaServed: b.area } : {}), ...(b.priceRange ? { priceRange: b.priceRange } : {})
    });
  }
  return graph.length ? { '@context': 'https://schema.org', '@graph': JSON.parse(JSON.stringify(graph)) } : null;
}

const schemaScript = (schema) => `\n<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>\n`;

// ---------- internal links ----------
// Wraps the first plain-text occurrence of `anchor` in a link. Skips text inside
// tags, existing links, headings, scripts, styles and HTML comments.
function insertLink(html, anchor, url) {
  const a = String(anchor || '').trim();
  if (a.length < 3) return { ok: false, reason: 'anchor too short' };
  const src = String(html || '');
  if (src.includes(`href="${url}"`) || src.includes(`href='${url}'`)) return { ok: false, reason: 'already links there' };
  const parts = src.split(/(<!--[\s\S]*?-->|<[^>]+>)/);
  let inA = 0, inH = 0, inSkip = 0;
  const tryFind = (text, ci) => (ci ? text.toLowerCase().indexOf(a.toLowerCase()) : text.indexOf(a));
  for (const ci of [false, true]) {
    inA = 0; inH = 0; inSkip = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i % 2 === 1) {
        if (p.startsWith('<!--')) continue;
        const m = p.match(/^<\s*(\/?)\s*([a-zA-Z0-9]+)/);
        if (!m) continue;
        const close = !!m[1];
        const tag = m[2].toLowerCase();
        const d = close ? -1 : (/\/\s*>$/.test(p) ? 0 : 1);
        if (tag === 'a') inA = Math.max(0, inA + d);
        else if (/^h[1-6]$/.test(tag)) inH = Math.max(0, inH + d);
        else if (['script', 'style', 'figcaption', 'button', 'code', 'pre'].includes(tag)) inSkip = Math.max(0, inSkip + d);
        continue;
      }
      if (inA || inH || inSkip) continue;
      const k = tryFind(p, ci);
      if (k < 0) continue;
      const found = p.slice(k, k + a.length);
      parts[i] = `${p.slice(0, k)}<a href="${url}">${found}</a>${p.slice(k + a.length)}`;
      return { ok: true, html: parts.join(''), anchor: found };
    }
  }
  return { ok: false, reason: 'phrase not found in plain text' };
}

const htmlText = (h) => String(h || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

async function pickRelated({ ai, title, summary, posts, max = 3 }) {
  if (!posts.length) return [];
  const prompt = `New article: "${title}"\n${clip(summary, 1200)}\n\nExisting articles on the same site (id | title):\n${posts.slice(0, 150).map((p) => `${p.id} | ${p.title}`).join('\n')}\n\nWhich existing articles are closely related, so a reader of them would genuinely benefit from a link to the new article? Pick at most ${max}, best first, or none if nothing is closely related. Return only JSON: {"ids": [id, ...]}`;
  const r = await ai({ system: 'You are an SEO editor planning internal links. You answer only with JSON.', prompt, maxTokens: 500 });
  const j = parseJson(r.text);
  const ids = (Array.isArray(j) ? j : j.ids || []).map(Number).filter((id) => posts.some((p) => p.id === id));
  return [...new Set(ids)].slice(0, max);
}

async function pickAnchor({ ai, newTitle, postTitle, html }) {
  const text = clip(htmlText(html), 14000);
  const prompt = `This is the text of the article "${postTitle}":\n\n${text}\n\nWe want to add one link from it to a new article titled "${newTitle}". Find an exact phrase of 2 to 7 words that already appears in the text above (copy it character for character, not from a heading), where a link to the new article would feel natural to a reader. Return only JSON: {"anchor": "exact phrase"} or {"anchor": null} if there is no natural place.`;
  const r = await ai({ system: 'You are an SEO editor placing internal links. You answer only with JSON.', prompt, maxTokens: 300 });
  const j = parseJson(r.text);
  return j && j.anchor ? String(j.anchor).trim() : null;
}

module.exports = { parseJson, splitFront, rewriteBody, qualityCheck, revise, imageBrief, makeImage, buildSchema, schemaScript, faqFromMarkdown, insertLink, htmlText, pickRelated, pickAnchor, plain };
