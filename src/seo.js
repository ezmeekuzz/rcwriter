// SEO automations: daily rank tracking from Search Console, an indexing watch
// for new articles, title and meta description tests that keep or roll back
// themselves, and topic maps that fill a writer's plan.
const enhance = require('./enhance');
const sitesLib = require('./sites');

const DAY = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const today = () => new Date().toLocaleDateString('en-CA');
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
// Typical CTR by position, used to spot pages whose titles under-perform.
const EXPECTED_CTR = [0, 28, 15, 10, 7, 5, 4, 3, 2.5, 2.2, 2, 1.4, 1.2, 1, 0.9, 0.8];
const expectedCtr = (pos) => EXPECTED_CTR[Math.max(1, Math.min(15, Math.round(pos)))] || 0.7;
const dueAt = (t) => { const [h, m] = String(t).split(':').map(Number); const x = new Date(); x.setHours(h || 0, m || 0, 0, 0); return x; };

function createSeo({ store, google, ai, builtins, auditor, notify, onChange, queueAction, addTask, postsFor, refresh }) {
  const d = () => store.data;
  const st = () => d().autoState || (d().autoState = {});
  const cfg = (site) => ({ keywords: [], rankAlerts: true, indexWatch: true, titleTests: { enabled: false, mode: 'approve', maxActive: 3 },
    contentDecay: { enabled: false, mode: 'approve', dropPct: 30, minClicks: 10, maxPerRun: 2, cooldownDays: 45 }, ...(site.seo || {}) });
  const busy = new Set();
  const gsc = (site) => site.google && site.google.gscSite && google.configured() ? site.google.gscSite : null;

  // ---------- rank tracking ----------
  async function checkRanks(site) {
    const prop = gsc(site);
    const c = cfg(site);
    if (!prop || !c.keywords.length) return null;
    const end = iso(Date.now() - 2 * DAY);
    const start = iso(Date.now() - 8 * DAY);
    const all = d().ranks || (d().ranks = {});
    const mine = all[site.id] || (all[site.id] = {});
    const moves = [];
    for (const kw of c.keywords.slice(0, 100)) {
      let row = null;
      try {
        const r = await google.gscPerformance(prop, { dimensions: ['query'], startDate: start, endDate: end, queryContains: kw, rowLimit: 50 });
        row = r.rows.find((x) => x.keys[0].toLowerCase() === kw.toLowerCase()) || null;
      } catch (e) { return { error: e.message }; }
      const hist = mine[kw] || (mine[kw] = []);
      const snap = { date: end, position: row ? row.position : null, clicks: row ? row.clicks : 0, impressions: row ? row.impressions : 0 };
      if (hist.length && hist[hist.length - 1].date === end) hist[hist.length - 1] = snap; else hist.push(snap);
      if (hist.length > 180) hist.splice(0, hist.length - 180);
      const week = hist.filter((h) => new Date(h.date) <= new Date(Date.parse(end) - 6 * DAY)).pop();
      if (week && week.position && snap.position) {
        const delta = snap.position - week.position;
        if (week.position <= 10 && snap.position > 10) moves.push({ kw, from: week.position, to: snap.position, type: 'lost page 1' });
        else if (delta >= 5) moves.push({ kw, from: week.position, to: snap.position, type: 'dropped' });
        else if (week.position > 10 && snap.position <= 10) moves.push({ kw, from: week.position, to: snap.position, type: 'reached page 1' });
        else if (delta <= -5) moves.push({ kw, from: week.position, to: snap.position, type: 'rose' });
      } else if (week && week.position && !snap.position) moves.push({ kw, from: week.position, to: null, type: 'no longer ranking' });
    }
    st()[`ranks:${site.id}`] = today();
    const bad = moves.filter((m) => /lost|dropped|no longer/.test(m.type));
    if (bad.length && c.rankAlerts !== false) {
      const txt = bad.slice(0, 4).map((m) => `"${m.kw}" ${m.from} → ${m.to ?? 'gone'}`).join(', ');
      store.log('error', `${site.name} rankings: ${bad.length} keyword${bad.length > 1 ? 's' : ''} fell over the last week: ${txt}.`);
      notify(`${site.name}: rankings fell`, `${txt}${bad.length > 4 ? ` and ${bad.length - 4} more` : ''}.`, { view: 'audits', tab: 'rankings' });
    }
    const good = moves.filter((m) => /reached|rose/.test(m.type));
    if (good.length) store.log('info', `${site.name} rankings: ${good.map((m) => `"${m.kw}" ${m.from} → ${m.to}`).slice(0, 5).join(', ')}.`);
    store.save();
    onChange();
    return { moves };
  }

  async function suggestKeywords(site) {
    const prop = gsc(site);
    if (!prop) throw new Error('Link Search Console to this website first.');
    const r = await google.gscPerformance(prop, { dimensions: ['query'], rowLimit: 300 });
    return r.rows.filter((x) => x.impressions >= 30 && x.keys[0].split(' ').length >= 2).sort((a, b) => b.impressions - a.impressions).slice(0, 25).map((x) => ({ keyword: x.keys[0], position: x.position, impressions: x.impressions }));
  }

  // ---------- indexing watch ----------
  function watchUrl(site, url, title = '') {
    if (!gsc(site) || cfg(site).indexWatch === false || !url) return;
    const list = d().indexWatch || (d().indexWatch = []);
    if (list.some((x) => x.url === url)) return;
    list.unshift({ id: store.uid(), siteId: site.id, url, title, addedAt: new Date().toISOString(), status: 'waiting' });
    d().indexWatch = list.slice(0, 1000);
  }

  async function checkIndexing(site) {
    const prop = gsc(site);
    if (!prop) return;
    const list = (d().indexWatch || []).filter((x) => x.siteId === site.id && x.status !== 'indexed' && Date.now() - new Date(x.addedAt) < 60 * DAY);
    for (const item of list.slice(0, 40)) {
      try {
        const r = await google.gscInspect(prop, item.url);
        Object.assign(item, { lastCheckAt: new Date().toISOString(), verdict: r.verdict, coverage: r.coverage, lastCrawl: r.lastCrawl || null });
        if (r.verdict === 'PASS' || /indexed/i.test(r.coverage || '') && !/not indexed/i.test(r.coverage || '')) { item.status = 'indexed'; item.indexedAt = new Date().toISOString(); continue; }
        item.status = 'not indexed';
        const age = (Date.now() - new Date(item.addedAt)) / DAY;
        if (age >= 7 && !item.notifiedAt) {
          item.notifiedAt = new Date().toISOString();
          notify(`Not indexed yet: ${site.name}`, `${clip(item.title || item.url, 80)}: ${r.coverage || 'Google has not indexed it'} after ${Math.floor(age)} days.`, { view: 'audits', tab: 'rankings' });
          addTask({ title: `Get "${clip(item.title || item.url, 80)}" indexed`, siteId: site.id, priority: 'medium', source: 'monitor', link: item.url,
            notes: `Search Console says: ${r.coverage || 'not indexed'}${r.lastCrawl ? ` (last crawled ${r.lastCrawl})` : ' (not crawled yet)'}. Request indexing in Search Console, link to it from a few related posts and check it's in the sitemap.` });
        }
      } catch (e) { item.error = e.message; break; }
    }
    st()[`index:${site.id}`] = today();
    store.save();
    onChange();
  }

  // ---------- title and meta description tests ----------
  async function wpPostForUrl(site, url) {
    const slug = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() || '');
    if (!slug) return null;
    const auth = { user: site.username, pass: store.decrypt(site.secret) };
    for (const type of ['posts', 'pages']) {
      const rows = await sitesLib.wpRequest(site, auth, `/wp/v2/${type}`, { query: { slug, context: 'edit', _fields: 'id,link,title,excerpt' }, purpose: 'audit' });
      const hit = (rows || []).find((r) => String(r.link).replace(/\/+$/, '') === url.replace(/\/+$/, '')) || (rows || [])[0];
      if (hit) return { type, id: hit.id, title: hit.title && (hit.title.raw ?? enhance.htmlText(hit.title.rendered)), excerpt: hit.excerpt && (hit.excerpt.raw ?? hit.excerpt.rendered) };
    }
    return null;
  }

  async function pageStats(prop, url, start, end) {
    const r = await google.gscPerformance(prop, { dimensions: ['page'], startDate: start, endDate: end, pageContains: url, rowLimit: 20 });
    const row = r.rows.find((x) => x.keys[0] === url) || { clicks: 0, impressions: 0, ctr: 0, position: null };
    return { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position };
  }

  async function startTitleTests(site) {
    const prop = gsc(site);
    const c = cfg(site);
    if (!prop || site.type !== 'wordpress' || !site.secret || !c.titleTests.enabled) return { started: 0 };
    const tests = d().titleTests || (d().titleTests = []);
    const active = tests.filter((t) => t.siteId === site.id && ['running', 'waiting'].includes(t.status));
    let room = Math.max(0, (Number(c.titleTests.maxActive) || 3) - active.length);
    if (!room) return { started: 0 };
    const recent = new Set(tests.filter((t) => t.siteId === site.id && Date.now() - new Date(t.createdAt) < 120 * DAY).map((t) => t.url));
    const r = await google.gscPerformance(prop, { dimensions: ['page'], rowLimit: 500 });
    const cands = r.rows.filter((x) => x.impressions >= 200 && x.position <= 15 && !recent.has(x.keys[0]) && x.ctr < expectedCtr(x.position) * 0.6)
      .sort((a, b) => (b.impressions * (expectedCtr(b.position) - b.ctr)) - (a.impressions * (expectedCtr(a.position) - a.ctr)));
    let started = 0;
    for (const p of cands) {
      if (!room) break;
      const url = p.keys[0];
      let post;
      try { post = await wpPostForUrl(site, url); } catch (e) { if (e.blocked || e.paused) break; continue; }
      if (!post) continue;
      const q = await google.gscPerformance(prop, { dimensions: ['query'], pageContains: url, rowLimit: 10 });
      const resp = await ai({
        system: 'You are an SEO copywriter improving click-through rate from Google results. You answer only with JSON.',
        prompt: `Page: ${url}\nCurrent title: ${post.title}\nCurrent excerpt (used as meta description by many themes): ${clip(enhance.htmlText(post.excerpt || ''), 300)}\nIt ranks at position ${p.position} with ${p.impressions} impressions and ${p.ctr}% CTR in 28 days; about ${expectedCtr(p.position)}% is typical.\nTop searches it shows for: ${q.rows.map((x) => `${x.keys[0]} (${x.impressions})`).join(', ')}\n\nWrite a more compelling title (under 60 characters, main search phrase near the start, specific benefit or number, no clickbait, no brand unless it's already there) and a meta description (140 to 155 characters, answers the search, invites the click). Return only JSON: {"title": "...", "excerpt": "...", "why": "one sentence"}`,
        maxTokens: 600
      });
      const j = enhance.parseJson(resp.text);
      if (!j.title) continue;
      const end = iso(Date.now() - 2 * DAY);
      const base = await pageStats(prop, url, iso(Date.now() - 29 * DAY), end);
      const test = { id: store.uid(), siteId: site.id, url, postType: post.type, postId: post.id, oldTitle: post.title, oldExcerpt: post.excerpt || '', newTitle: j.title.slice(0, 70), newExcerpt: String(j.excerpt || '').slice(0, 160),
        why: j.why || '', baseline: base, createdAt: new Date().toISOString(), status: 'waiting' };
      const res = await queueAction({ connectorId: `wp:${site.id}`, connectorName: `WordPress (${site.name})`, jobName: `Title test: ${site.name}`, siteId: site.id, siteUrl: site.url.replace(/^https?:\/\//, ''),
        tool: 'wp_update_title_excerpt', risk: 'safe', args: { type: post.type, id: post.id, title: test.newTitle, excerpt: test.newExcerpt }, reason: `Title test for ${url}: CTR ${p.ctr}% at position ${p.position}. ${j.why || ''}`,
        preview: `Before: ${post.title}\nAfter: ${test.newTitle}`, titleTestId: test.id }, c.titleTests.mode === 'auto' ? 'auto' : 'approve');
      if (res === 'applied') { test.status = 'running'; test.startedAt = new Date().toISOString(); }
      tests.unshift(test);
      started += 1;
      room -= 1;
    }
    st()[`titletests:${site.id}`] = today();
    if (started) notify(`Title tests: ${site.name}`, `${started} new test${started > 1 ? 's' : ''}${c.titleTests.mode === 'auto' ? ' started' : ' waiting for your approval'}. RCWriter checks the results after 28 days.`, { view: 'audits', tab: c.titleTests.mode === 'auto' ? 'rankings' : 'approvals' });
    store.save();
    onChange();
    return { started };
  }

  async function evaluateTitleTests() {
    const tests = d().titleTests || [];
    for (const t of tests) {
      if (t.status === 'waiting') {
        const ap = d().approvals.find((a) => a.titleTestId === t.id);
        if (ap && ap.status === 'approved') { t.status = 'running'; t.startedAt = ap.decidedAt; }
        else if (ap && ['rejected', 'failed'].includes(ap.status)) t.status = 'cancelled';
        continue;
      }
      if (t.status !== 'running' || Date.now() - new Date(t.startedAt) < 31 * DAY) continue;
      const site = d().sites.find((x) => x.id === t.siteId);
      const prop = site && gsc(site);
      if (!prop) continue;
      const startAt = new Date(new Date(t.startedAt).getTime() + 2 * DAY);
      const after = await pageStats(prop, t.url, iso(startAt), iso(startAt.getTime() + 27 * DAY));
      t.after = after;
      const better = t.baseline.ctr ? (after.ctr - t.baseline.ctr) / t.baseline.ctr : after.ctr > 0 ? 1 : 0;
      t.change = Math.round(better * 100);
      if (better >= 0.1 || (after.clicks > t.baseline.clicks * 1.15 && better > -0.05)) {
        t.status = 'kept';
        notify(`Title test won: ${site.name}`, `"${clip(t.newTitle, 60)}" lifted CTR from ${t.baseline.ctr}% to ${after.ctr}%. Kept.`, { view: 'audits', tab: 'rankings' });
      } else {
        try {
          await queueAction({ connectorId: `wp:${site.id}`, connectorName: `WordPress (${site.name})`, jobName: `Title test: ${site.name}`, siteId: site.id, siteUrl: site.url.replace(/^https?:\/\//, ''),
            tool: 'wp_update_title_excerpt', risk: 'safe', args: { type: t.postType, id: t.postId, title: t.oldTitle, excerpt: t.oldExcerpt }, reason: `Title test didn't beat the original (CTR ${t.baseline.ctr}% → ${after.ctr}%), so the old title is back.` }, 'auto');
          t.status = 'reverted';
          notify(`Title test ended: ${site.name}`, `The new title didn't improve CTR (${t.baseline.ctr}% → ${after.ctr}%), so the original is back.`, { view: 'audits', tab: 'rankings' });
        } catch (e) { t.error = e.message; }
      }
      t.endedAt = new Date().toISOString();
    }
    store.save();
    onChange();
  }

  // ---------- content decay: refresh pages that are losing search traffic ----------
  async function pagesPerf(prop, start, end) {
    const r = await google.gscPerformance(prop, { dimensions: ['page'], startDate: start, endDate: end, rowLimit: 1000 });
    const map = new Map();
    for (const x of r.rows || []) map.set(x.keys[0].replace(/\/+$/, ''), { clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position });
    return map;
  }

  // Compare the last 28 days of Search Console page traffic with the 28 before
  // it, find pages that have lost clicks (content decay), and refresh the worst
  // offenders through the revise engine. Respects a per-page cooldown so the
  // same URL isn't refreshed repeatedly.
  async function checkDecay(site, { manual = false } = {}) {
    const prop = gsc(site);
    const c = cfg(site);
    if (!prop) { if (manual) throw new Error('Link Search Console to this website first.'); return { found: 0 }; }
    if (!manual && !c.contentDecay.enabled) return { found: 0 };
    const dropPct = Math.max(10, Math.min(90, Number(c.contentDecay.dropPct) || 30));
    const minClicks = Math.max(1, Number(c.contentDecay.minClicks) || 10);
    const maxPerRun = Math.max(1, Math.min(10, Number(c.contentDecay.maxPerRun) || 2));
    const cooldown = Math.max(7, Number(c.contentDecay.cooldownDays) || 45) * DAY;

    const recent = await pagesPerf(prop, iso(Date.now() - 30 * DAY), iso(Date.now() - 2 * DAY));
    const prior = await pagesPerf(prop, iso(Date.now() - 58 * DAY), iso(Date.now() - 31 * DAY));
    const log = d().contentRefreshes || (d().contentRefreshes = []);
    const lastFor = (url) => log.filter((x) => x.siteId === site.id && x.url === url).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];

    const decayed = [];
    for (const [url, p] of prior) {
      if (p.clicks < minClicks) continue;
      const now = recent.get(url) || { clicks: 0, impressions: 0, ctr: 0, position: null };
      const lostClicks = p.clicks - now.clicks;
      const clicksDrop = p.clicks ? (lostClicks / p.clicks) * 100 : 0;
      const posWorse = p.position && now.position ? now.position - p.position : 0;
      const decaying = clicksDrop >= dropPct || (posWorse >= 3 && now.clicks < p.clicks);
      if (!decaying) continue;
      const prev = lastFor(url);
      if (prev && Date.now() - new Date(prev.startedAt) < cooldown) continue; // still cooling down
      decayed.push({ url, prior: p, recent: now, lostClicks, clicksDrop: Math.round(clicksDrop), posWorse: Math.round(posWorse) });
    }
    decayed.sort((a, b) => b.lostClicks - a.lostClicks);
    st()[`decay:${site.id}`] = today();

    const picked = decayed.slice(0, maxPerRun);
    const started = [];
    for (const item of picked) {
      let queries = [];
      try {
        const q = await google.gscPerformance(prop, { dimensions: ['query'], startDate: iso(Date.now() - 58 * DAY), endDate: iso(Date.now() - 2 * DAY), pageContains: item.url, rowLimit: 8 });
        queries = (q.rows || []).sort((a, b) => b.impressions - a.impressions).slice(0, 8).map((x) => x.keys[0]);
      } catch { /* queries are a nice-to-have */ }
      const title = item.url.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/').pop() || item.url;
      const brief = [
        `This existing page has been losing search traffic and needs a refresh — do NOT create a new page, and keep its URL unchanged.`,
        `Page: ${item.url}`,
        `Search Console: clicks fell from ${item.prior.clicks} to ${item.recent.clicks} over the last 28 days vs the 28 before${item.posWorse >= 3 ? `, and its average position slipped by about ${item.posWorse}` : ''}.`,
        queries.length ? `It earns impressions for these searches, so make sure the page answers them well: ${queries.join(', ')}.` : '',
        'Refresh it: update anything outdated (facts, stats, years, prices, screenshots), expand thin or shallow sections with genuinely useful detail, tighten the introduction, improve headings and the title/meta for the searches above, add or update an FAQ and structured data where it helps, and fix broken or stale links. Keep the existing structure, tone and internal links intact; make no unrelated changes.'
      ].filter(Boolean).join('\n');

      let jobId = null;
      try {
        const job = refresh ? refresh(site, { url: item.url, title, brief, mode: c.contentDecay.mode || 'approve' }) : null;
        jobId = job && job.id;
      } catch (e) { item.error = e.message; }
      const rec = { id: store.uid(), siteId: site.id, url: item.url, title, startedAt: new Date().toISOString(),
        baseline: { clicks: item.prior.clicks, position: item.prior.position }, recentAtStart: { clicks: item.recent.clicks, position: item.recent.position },
        lostClicks: item.lostClicks, clicksDrop: item.clicksDrop, queries, mode: c.contentDecay.mode || 'approve', jobId, status: jobId ? 'refreshing' : 'failed', error: item.error || null };
      log.unshift(rec);
      if (jobId) started.push(rec);
    }
    d().contentRefreshes = log.slice(0, 500);

    if (started.length) {
      const names = started.map((r) => clip(r.title, 40)).join(', ');
      notify(`Content refresh: ${site.name}`, `${started.length} decaying page${started.length > 1 ? 's' : ''} being refreshed (${names})${(c.contentDecay.mode || 'approve') === 'auto' ? '' : ' — waiting for your approval'}.`,
        { view: 'audits', tab: (c.contentDecay.mode || 'approve') === 'auto' ? 'rankings' : 'approvals' });
      store.log('info', `${site.name}: refreshing ${started.length} page${started.length > 1 ? 's' : ''} that lost search traffic.`);
    } else if (manual) {
      store.log('info', `${site.name}: no decaying pages found that need a refresh right now.`);
    }
    store.save();
    onChange();
    return { found: decayed.length, started: started.length };
  }

  // 30+ days after a refresh, check whether the page's traffic recovered.
  async function evaluateRefreshes() {
    const log = d().contentRefreshes || [];
    for (const r of log) {
      if (r.status !== 'refreshing' || r.evaluatedAt || Date.now() - new Date(r.startedAt) < 32 * DAY) continue;
      const site = d().sites.find((x) => x.id === r.siteId);
      const prop = site && gsc(site);
      if (!prop) continue;
      try {
        const after = await pageStats(prop, r.url, iso(Date.now() - 30 * DAY), iso(Date.now() - 2 * DAY));
        r.after = { clicks: after.clicks, position: after.position };
        r.evaluatedAt = new Date().toISOString();
        const base = (r.recentAtStart && r.recentAtStart.clicks) || 0;
        const recovered = after.clicks >= Math.max(r.baseline.clicks * 0.9, base * 1.2);
        r.status = recovered ? 'recovered' : 'no change';
        notify(`Refresh ${recovered ? 'recovered traffic' : 'didn\'t recover yet'}: ${site.name}`,
          `"${clip(r.title, 50)}" — clicks ${base} → ${after.clicks} (was ${r.baseline.clicks} before the decline).`, { view: 'audits', tab: 'rankings' });
      } catch { /* try again next week */ }
    }
    store.save();
    onChange();
  }

  // ---------- topic maps ----------
  async function planTopics(writer, { count = 12 } = {}) {
    const site = d().sites.find((x) => x.id === writer.siteId) || null;
    let posts = [];
    try { posts = site ? await postsFor(site) : []; } catch { /* plan without them */ }
    const system = `You are an SEO content strategist building a topic map (pillar pages and supporting articles in clusters) for ${site ? `${site.name} (${site.url})` : 'a website'}. Use the tools for real keyword data when available. You answer only with JSON.`;
    const task = [
      `Themes: ${String(writer.topics || '').trim() || '(use the writer focus)'}`,
      writer.instructions ? `Writer focus: ${clip(writer.instructions, 1500)}` : '',
      posts.length ? `Already published (don't repeat; use them as pillars or link targets where they fit):\n${posts.slice(0, 120).map((p) => `- ${p.title} | ${p.link}`).join('\n')}` : '',
      `Plan ${count} new articles in 2 to 4 clusters. Prefer keywords with real searches and low difficulty, avoid cannibalisation with existing articles, and order them so pillar articles come first.`,
      'Return only JSON: {"clusters": [{"name": "...", "pillar": "title or URL of the pillar", "articles": [{"title": "...", "keyword": "...", "volume": <number or null>, "difficulty": <number or null>, "intent": "..."}]}]}'
    ].filter(Boolean).join('\n\n');
    let text;
    const canResearch = (writer.researchConnectorIds || []).length || (site && gsc(site));
    if (canResearch) {
      try {
        text = (await auditor.research({ name: `Topic map for ${writer.name}`, siteId: site ? site.id : '', siteUrl: site ? site.url : '', connectorIds: writer.researchConnectorIds || [], builtinKinds: ['google'],
          provider: writer.provider, model: writer.model, system, task, maxToolCalls: 30, maxMinutes: 20 })).text;
      } catch { text = null; }
    }
    if (!text) text = (await ai({ system, prompt: task, maxTokens: 4000 })).text;
    const j = enhance.parseJson(text);
    const plan = [];
    for (const c of j.clusters || []) {
      for (const a of c.articles || []) plan.push({ id: store.uid(), title: String(a.title || '').trim(), keyword: String(a.keyword || '').trim(), volume: a.volume ?? null, difficulty: a.difficulty ?? null, intent: a.intent || '', cluster: c.name || '', pillar: c.pillar || '', status: 'planned' });
    }
    if (!plan.length) throw new Error('The plan came back empty. Try again.');
    writer.plan = [...(writer.plan || []).filter((p) => p.status === 'written'), ...plan];
    writer.planAt = new Date().toISOString();
    store.save();
    onChange();
    return plan;
  }

  // Next planned item as a topic for the generator.
  function nextPlanned(writer) {
    const p = (writer.plan || []).find((x) => x.status === 'planned');
    if (!p) return null;
    return { item: p, topic: [`Write this article: ${p.title}`, p.keyword ? `Target keyword: "${p.keyword}". Use it in the title, the first paragraph and one H2.` : '', p.intent ? `Search intent: ${p.intent}.` : '',
      p.cluster ? `It belongs to the "${p.cluster}" topic cluster${p.pillar ? `; link to the pillar article (${p.pillar}) where it helps` : ''}.` : ''].filter(Boolean).join('\n') };
  }

  // ---------- schedule ----------
  async function once(key, fn) {
    if (busy.has(key)) return;
    busy.add(key);
    try { await fn(); } catch (e) { store.log('error', `${key.split(':')[0]}: ${e.message}`); store.save(); onChange(); } finally { busy.delete(key); }
  }

  function tick() {
    const D = d();
    if (!D || D.settings.paused) return;
    const now = new Date();
    for (const s of D.sites) {
      if (!gsc(s)) continue;
      const c = cfg(s);
      if (c.keywords.length && st()[`ranks:${s.id}`] !== today() && now >= dueAt('07:00')) { st()[`ranks:${s.id}`] = today(); once(`Rank tracking:${s.id}`, () => checkRanks(s)); }
      if ((D.indexWatch || []).some((x) => x.siteId === s.id && x.status !== 'indexed') && st()[`index:${s.id}`] !== today() && now >= dueAt('11:00')) { st()[`index:${s.id}`] = today(); once(`Indexing watch:${s.id}`, () => checkIndexing(s)); }
      if (c.titleTests.enabled && now.getDay() === 1 && st()[`titletests:${s.id}`] !== today() && now >= dueAt('09:30')) { st()[`titletests:${s.id}`] = today(); once(`Title tests:${s.id}`, () => startTitleTests(s)); }
      if (c.contentDecay.enabled && now.getDay() === 2 && st()[`decay:${s.id}`] !== today() && now >= dueAt('10:00')) { st()[`decay:${s.id}`] = today(); once(`Content decay:${s.id}`, () => checkDecay(s)); }
    }
    if ((D.titleTests || []).some((t) => ['running', 'waiting'].includes(t.status)) && st().titleEval !== today()) { st().titleEval = today(); once('Title test results', () => evaluateTitleTests()); }
    if ((D.contentRefreshes || []).some((r) => r.status === 'refreshing') && st().decayEval !== today()) { st().decayEval = today(); once('Refresh results', () => evaluateRefreshes()); }
  }

  return { tick, checkRanks, suggestKeywords, watchUrl, checkIndexing, startTitleTests, evaluateTitleTests, checkDecay, evaluateRefreshes, planTopics, nextPlanned, expectedCtr };
}

module.exports = { createSeo, expectedCtr };
