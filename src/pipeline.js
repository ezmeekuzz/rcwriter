// The extra steps a writer can run around each article:
//  before writing: keyword research (picks the topic)
//  after writing:  quality check (and one revision), featured image, schema file
//  after publishing: links to the new article from related older posts
const fs = require('fs');
const path = require('path');
const generator = require('./generator');
const enhance = require('./enhance');
const sites = require('./sites');

function createPipeline({ store, providers, builtins, auditor, providerConfig, postsFor }) {
  const d = () => store.data;

  const aiFor = (writer) => (o) => providers.generate(writer.provider, {
    ...providerConfig(writer.provider), model: writer.model, system: o.system, prompt: o.prompt, maxTokens: o.maxTokens || 4000, temperature: null
  });

  const readBody = (article) => enhance.splitFront(fs.readFileSync(article.path, 'utf8')).body.trim();

  // ---------- keyword research ----------
  async function researchTopic(writer) {
    const site = d().sites.find((x) => x.id === writer.siteId) || null;
    let posts = [];
    try { posts = site ? await postsFor(site) : []; } catch { /* write without them */ }
    const used = (writer.usedKeywords || []).slice(0, 60);
    const calls = Math.max(5, Math.min(40, Number(writer.researchMaxCalls) || 20));
    const system = `You are an SEO strategist choosing the next article for ${site ? `${site.name} (${site.url})` : 'this website'}. You use the tools to get real data and never invent numbers.`;
    const task = [
      `Themes and seed topics:\n${String(writer.topics || '').trim() || '(none given; use the writer focus below)'}`,
      writer.instructions ? `Writer focus:\n${String(writer.instructions).slice(0, 1500)}` : '',
      `Language: ${writer.language || 'English'}${writer.researchCountry ? `. Market: ${writer.researchCountry}` : ''}.`,
      posts.length ? `Articles already on the site (title | URL):\n${posts.slice(0, 120).map((p) => `- ${p.title} | ${p.link}`).join('\n')}` : '',
      used.length ? `Keywords this writer already used (don't pick these or close variants):\n- ${used.join('\n- ')}` : '',
      [
        'Steps:',
        '1. Use the keyword tools (for example Ahrefs Keywords Explorer or Semrush keyword research) to find keywords related to the themes with real monthly searches and low difficulty (keyword difficulty under about 30, or low competition).',
        '2. If Search Console tools are available, queries where the site already appears at positions 4 to 30 without a dedicated article are excellent picks.',
        '3. Cannibalisation check: drop any keyword that an existing article already targets (same subject or very similar title), or that an existing page already ranks for in the top 10.',
        '4. Pick the single best keyword for a new article.',
        `Be efficient: use at most about ${calls} tool calls.`
      ].join('\n'),
      'Return only JSON: {"keyword": "...", "secondary": ["..."], "volume": <monthly searches or null>, "difficulty": <number or null>, "intent": "informational|commercial|transactional|navigational", "why": "one sentence", "title": "suggested title", "linkTo": ["URLs of existing related articles worth linking to"]}'
    ].filter(Boolean).join('\n\n');
    const r = await auditor.research({
      name: `Keyword research for ${writer.name}`, siteId: site ? site.id : '', siteUrl: site ? site.url : '',
      connectorIds: writer.researchConnectorIds || [], builtinKinds: ['google'], provider: writer.provider, model: writer.model,
      system, task, maxToolCalls: calls + 4, maxMinutes: 15
    });
    const k = enhance.parseJson(r.text);
    if (!k || !k.keyword) throw new Error('The research did not name a keyword.');
    const kw = { keyword: String(k.keyword).trim(), secondary: (k.secondary || []).map(String).slice(0, 6), volume: k.volume ?? null, difficulty: k.difficulty ?? null,
      intent: k.intent || '', why: k.why || '', title: k.title || '', linkTo: (k.linkTo || []).map(String).filter((u) => /^https?:/.test(u)).slice(0, 4) };
    writer.usedKeywords = [kw.keyword, ...(writer.usedKeywords || []).filter((x) => x !== kw.keyword)].slice(0, 100);
    const topic = [
      `Target keyword: "${kw.keyword}"${kw.volume ? ` (about ${kw.volume} searches a month` : ''}${kw.volume && kw.difficulty !== null ? `, difficulty ${kw.difficulty})` : kw.volume ? ')' : ''}.`,
      kw.intent ? `Search intent: ${kw.intent}. Answer what that searcher wants, completely.` : '',
      kw.secondary.length ? `Also cover these related searches naturally: ${kw.secondary.join(', ')}.` : '',
      kw.title ? `Suggested title (improve it if you can): ${kw.title}` : '',
      kw.linkTo.length ? `Link to these related articles where it helps the reader: ${kw.linkTo.join(', ')}` : '',
      'Use the target keyword in the title, the first paragraph and at least one H2.'
    ].filter(Boolean).join('\n');
    return { topic, keyword: kw };
  }

  // ---------- after writing ----------
  async function afterWrite(writer, article, log) {
    const ai = aiFor(writer);
    if (writer.qualityCheck) {
      const min = Math.max(1, Math.min(10, Number(writer.qualityMinScore) || 7));
      try {
        const knowledge = [String(writer.knowledge || '').trim(), generator.readKnowledgeFiles(writer.knowledgeFiles)].filter(Boolean).join('\n\n');
        let text = readBody(article);
        let q = await enhance.qualityCheck({ writer, knowledge, text, ai });
        const first = q;
        if (writer.qualityRevise !== false && (q.mustFix || q.score < min) && q.issues.length) {
          try {
            const { system } = generator.buildPrompts(writer, { mode: 'open' }, []);
            const revised = await enhance.revise({ system, text, issues: q.issues, ai, maxTokens: Number(writer.maxTokens) || 8000 });
            enhance.rewriteBody(article.path, revised);
            text = revised;
            article.title = generator.extractTitle(revised);
            article.words = generator.countWords(revised);
            q = await enhance.qualityCheck({ writer, knowledge, text, ai });
            q.revised = true;
            q.firstScore = first.score;
            q.firstIssues = first.issues;
          } catch (e) { log(`Couldn't revise "${article.title}": ${e.message}`); }
        }
        article.quality = { ...q, min, passed: q.score >= min && !q.mustFix, checkedAt: new Date().toISOString() };
      } catch (e) {
        article.quality = { error: e.message, passed: false, checkedAt: new Date().toISOString() };
        log(`Quality check of "${article.title}" didn't run: ${e.message}`);
      }
    }

    if (writer.imageSource && writer.imageSource !== 'none') {
      try {
        const brief = await enhance.imageBrief({ ai, title: article.title, text: readBody(article), source: writer.imageSource });
        const img = await enhance.makeImage({
          source: writer.imageSource, brief, openaiKey: store.getKey('openai'),
          pexelsKey: store.decrypt((d().images || {}).pexelsKey), model: (d().images || {}).model
        });
        const file = article.path.replace(/\.md$/, `.${img.ext}`);
        fs.writeFileSync(file, img.buffer);
        article.image = { path: file, alt: img.alt, credit: img.credit || '', creditUrl: img.creditUrl || '', mime: img.mime, source: writer.imageSource };
      } catch (e) {
        article.imageError = e.message;
        log(`No featured image for "${article.title}": ${e.message}`);
      }
    }

    if ((writer.schemaTypes || []).length) {
      try {
        const schema = schemaFor(writer, article, null);
        if (schema) {
          const file = article.path.replace(/\.md$/, '.schema.json');
          fs.writeFileSync(file, JSON.stringify(schema, null, 2));
          article.schemaPath = file;
        }
      } catch (e) { log(`Schema for "${article.title}" wasn't created: ${e.message}`); }
    }
  }

  function schemaFor(writer, article, site) {
    if (!writer || !(writer.schemaTypes || []).length) return null;
    const parts = sites.splitArticle(fs.readFileSync(article.path, 'utf8'));
    return enhance.buildSchema({ writer, title: parts.title || article.title, excerpt: parts.excerpt, markdown: parts.markdown, siteName: site ? site.name : '' });
  }

  function imageFor(article) {
    if (!article.image || !article.image.path) return null;
    try {
      const buffer = fs.readFileSync(article.image.path);
      return { buffer, mime: article.image.mime || 'image/png', filename: path.basename(article.image.path), alt: article.image.alt, credit: article.image.credit, creditUrl: article.image.creditUrl };
    } catch { return null; }
  }

  // ---------- links from older posts ----------
  // mode: 'approve' queues each link in Approvals; 'auto' adds them now.
  async function linkFromOlderPosts(article, site, writer, mode = 'approve') {
    if (site.type !== 'wordpress' || !site.secret) throw new Error('Links from older posts need a connected WordPress site.');
    const pub = article.published;
    if (!pub || !pub.url || pub.status !== 'publish') throw new Error('Publish the article first, so older posts link to a live page.');
    const ai = aiFor(writer);
    const auth = { user: site.username, pass: store.decrypt(site.secret) };
    const posts = (await postsFor(site, true)).filter((p) => p.id !== pub.remoteId && p.link !== pub.url);
    const body = readBody(article);
    const ids = await enhance.pickRelated({ ai, title: article.title, summary: enhance.plain(body).slice(0, 1200), posts, max: Math.max(1, Math.min(5, Number(writer.linkOlderMax) || 3)) });
    const tool = builtins.resolve(`wp:${site.id}`, 'wp_add_internal_link');
    const out = { planned: 0, applied: 0, queued: 0, skipped: [] };
    for (const id of ids) {
      const post = posts.find((p) => p.id === id);
      try {
        const full = await sites.wpRequest(site, auth, `/wp/v2/posts/${id}`, { query: { context: 'edit' } });
        const html = full.content && full.content.raw;
        const anchor = await enhance.pickAnchor({ ai, newTitle: article.title, postTitle: post.title, html });
        if (!anchor) { out.skipped.push(`${post.title}: no natural place for a link`); continue; }
        const check = enhance.insertLink(html, anchor, pub.url);
        if (!check.ok) { out.skipped.push(`${post.title}: ${check.reason}`); continue; }
        out.planned += 1;
        const plainText = enhance.htmlText(html);
        const at = plainText.toLowerCase().indexOf(anchor.toLowerCase());
        const preview = at >= 0 ? `…${plainText.slice(Math.max(0, at - 90), at)}[${plainText.slice(at, at + anchor.length)}]${plainText.slice(at + anchor.length, at + anchor.length + 90)}…` : anchor;
        const base = { jobId: null, runId: null, jobName: `Links to "${article.title}"`, siteUrl: site.url.replace(/^https?:\/\//, ''), siteId: site.id,
          connectorId: `wp:${site.id}`, connectorName: `WordPress (${site.name})`, tool: 'wp_add_internal_link', risk: 'safe',
          args: { type: 'posts', id, anchorText: anchor, url: pub.url }, reason: `Link "${anchor}" in "${post.title}" to the new article`, preview, articleId: article.id };
        if (mode === 'auto' && tool) {
          const r = await tool.run(base.args);
          d().changes.unshift({ id: store.uid(), ...base, via: 'auto-link', status: 'applied', result: r.text, before: r.before, at: new Date().toISOString() });
          out.applied += 1;
        } else {
          if (!d().approvals.some((a) => a.status === 'pending' && a.tool === base.tool && a.siteId === site.id && a.args.id === id && a.args.url === pub.url)) {
            d().approvals.unshift({ id: store.uid(), ...base, status: 'pending', createdAt: new Date().toISOString(), note: '' });
            out.queued += 1;
          }
        }
      } catch (e) {
        if (e.blocked || e.paused) throw e;
        out.skipped.push(`${post ? post.title : id}: ${e.message}`);
      }
    }
    article.linkedFrom = { ...out, at: new Date().toISOString() };
    store.save();
    return out;
  }

  return { researchTopic, afterWrite, schemaFor, imageFor, linkFromOlderPosts };
}

module.exports = { createPipeline };
