// Competitor & backlink radar: on a weekly schedule, uses the Ahrefs / Semrush
// connectors to check a site's own backlink profile and a list of competitor
// domains, then compares the result with the previous snapshot and surfaces
// what changed — lost backlinks, competitors' new content and keywords they now
// outrank you for — as alerts and tasks. All data comes from the connectors
// through the read-only research engine; nothing is invented.
const enhance = require('./enhance');

const DAY = 864e5;
const today = () => new Date().toLocaleDateString('en-CA');
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
const host = (u) => { try { return new URL(/^https?:\/\//.test(u) ? u : `https://${u}`).host.replace(/^www\./, ''); } catch { return String(u || '').replace(/^www\./, '').replace(/\/.*$/, ''); } };

// Pure diff of two radar snapshots. Exported for testing.
function diffSnapshot(prev, cur) {
  const p = prev || {};
  const seenLost = new Set((p.lostBacklinks || []).map((b) => `${b.domain}→${b.target || ''}`));
  const seenContent = new Set((p.competitorContent || []).map((c) => c.url));
  const newLost = (cur.lostBacklinks || []).filter((b) => b && b.domain && !seenLost.has(`${b.domain}→${b.target || ''}`));
  const newContent = (cur.competitorContent || []).filter((c) => c && c.url && !seenContent.has(c.url));
  const refDelta = (typeof cur.refDomains === 'number' && typeof p.refDomains === 'number') ? cur.refDomains - p.refDomains : null;
  const newOverlap = (cur.losingKeywords || []).filter((k) => k && k.keyword && !(p.losingKeywords || []).some((x) => x.keyword === k.keyword && x.competitor === k.competitor));
  return { newLost, newContent, refDelta, newOverlap };
}

function mergeSnapshot(prev, cur) {
  const p = prev || {};
  const byLost = new Map();
  for (const b of [...(p.lostBacklinks || []), ...(cur.lostBacklinks || [])]) if (b && b.domain) byLost.set(`${b.domain}→${b.target || ''}`, b);
  const byUrl = new Map();
  for (const c of [...(p.competitorContent || []), ...(cur.competitorContent || [])]) if (c && c.url) byUrl.set(c.url, c);
  return { at: new Date().toISOString(), refDomains: typeof cur.refDomains === 'number' ? cur.refDomains : p.refDomains,
    lostBacklinks: [...byLost.values()].slice(-500), competitorContent: [...byUrl.values()].slice(-500), losingKeywords: (cur.losingKeywords || []).slice(0, 100) };
}

function createRadar({ store, research, assistantChoice, notify, addTask, onChange }) {
  const d = () => store.data;
  const st = () => d().autoState || (d().autoState = {});
  const cfg = (site) => ({ enabled: false, competitors: [], ...(site.radar || {}) });
  const busy = new Set();

  function seoConnectorIds() {
    return (d().connectors || []).filter((c) => ['ahrefs', 'semrush'].includes(c.preset)).map((c) => c.id);
  }

  async function fetchData(site, competitors, connIds) {
    const choice = assistantChoice();
    const domain = host(site.url);
    const system = 'You are an SEO competitive-intelligence analyst. Use ONLY the Ahrefs/Semrush tools for real figures — never estimate or invent. If a figure is unavailable, use null or omit it. Answer with STRICT JSON and nothing else.';
    const task = [
      `My site: ${domain}`,
      competitors.length ? `Competitors: ${competitors.join(', ')}` : 'No competitors given — focus on my own backlinks and lost rankings.',
      'Using the connected SEO tools, gather, for roughly the last 30 days:',
      '1. My site\'s current number of referring domains, and up to 15 notable REFERRING DOMAINS I recently LOST (dropped backlinks).',
      '2. For each competitor, up to 5 of their NEW or notably updated top pages (title + URL).',
      '3. Up to 15 keywords where a competitor now OUTRANKS my site (keyword, the competitor domain, their position, my position).',
      'Return ONLY this JSON shape:',
      '{"refDomains": <number|null>, "lostBacklinks": [{"domain": "...", "target": "<my url or null>"}], "competitorContent": [{"competitor": "...", "title": "...", "url": "..."}], "losingKeywords": [{"keyword": "...", "competitor": "...", "theirPos": <number|null>, "myPos": <number|null>}]}'
    ].join('\n');
    const r = await research({ name: `Radar: ${site.name}`, siteId: site.id, siteUrl: domain, connectorIds: connIds, builtinKinds: [],
      provider: choice.provider, model: choice.model, system, task, maxToolCalls: 30, maxMinutes: 20, requireTools: true });
    const j = enhance.parseJson(r.text) || {};
    return {
      refDomains: typeof j.refDomains === 'number' ? j.refDomains : null,
      lostBacklinks: (j.lostBacklinks || []).filter((b) => b && b.domain).map((b) => ({ domain: host(b.domain), target: b.target || null })).slice(0, 30),
      competitorContent: (j.competitorContent || []).filter((c) => c && c.url).map((c) => ({ competitor: host(c.competitor || ''), title: String(c.title || c.url).slice(0, 160), url: String(c.url) })).slice(0, 40),
      losingKeywords: (j.losingKeywords || []).filter((k) => k && k.keyword).map((k) => ({ keyword: String(k.keyword).slice(0, 120), competitor: host(k.competitor || ''), theirPos: k.theirPos ?? null, myPos: k.myPos ?? null })).slice(0, 30)
    };
  }

  async function run(site, { manual = false } = {}) {
    const c = cfg(site);
    if (!manual && !c.enabled) return { ran: false };
    if (!site.url) { if (manual) throw new Error('This website has no URL set.'); return { ran: false }; }
    const connIds = seoConnectorIds();
    if (!connIds.length) { if (manual) throw new Error('Connect Ahrefs or Semrush first (AI providers → Connectors), so the radar has data to read.'); return { ran: false }; }
    const competitors = (c.competitors || []).map(host).filter(Boolean).slice(0, 5);

    const cur = await fetchData(site, competitors, connIds);
    const snaps = d().radarSnaps || (d().radarSnaps = {});
    const prev = snaps[site.id] || null;
    const diff = diffSnapshot(prev, cur);
    snaps[site.id] = mergeSnapshot(prev, cur);
    st()[`radar:${site.id}`] = today();

    // Tasks for the most actionable findings (first run only records the baseline).
    let tasksMade = 0;
    if (prev && addTask) {
      for (const b of diff.newLost.slice(0, 5)) { addTask({ title: `Lost a backlink from ${b.domain}`, siteId: site.id, priority: 'medium', source: 'monitor', link: b.target || `https://${b.domain}`, notes: `The radar noticed ${b.domain} no longer links to ${site.name}${b.target ? ` (was pointing at ${b.target})` : ''}. Consider reaching out to restore it or replacing the link.` }); tasksMade += 1; }
      for (const ct of diff.newContent.slice(0, 5)) { addTask({ title: `Competitor published: ${clip(ct.title, 60)}`, siteId: site.id, priority: 'low', source: 'monitor', link: ct.url, notes: `${ct.competitor} has new content: ${ct.url}. Consider covering this topic (or better) on ${site.name}.` }); tasksMade += 1; }
    }

    const log = d().radarRuns || (d().radarRuns = []);
    log.unshift({ id: store.uid(), siteId: site.id, at: new Date().toISOString(), competitors, refDomains: cur.refDomains, refDelta: diff.refDelta,
      newLost: diff.newLost.slice(0, 20), newContent: diff.newContent.slice(0, 20), losingKeywords: cur.losingKeywords.slice(0, 20), tasksMade, baseline: !prev });
    d().radarRuns = log.slice(0, 200);

    if (prev) {
      const bits = [];
      if (diff.newLost.length) bits.push(`${diff.newLost.length} lost backlink${diff.newLost.length > 1 ? 's' : ''}`);
      if (diff.newContent.length) bits.push(`${diff.newContent.length} new competitor page${diff.newContent.length > 1 ? 's' : ''}`);
      if (diff.refDelta !== null && diff.refDelta !== 0) bits.push(`referring domains ${diff.refDelta > 0 ? '+' : ''}${diff.refDelta}`);
      if (bits.length) {
        notify(`Competitor radar: ${site.name}`, `${bits.join(', ')}.${tasksMade ? ` ${tasksMade} task${tasksMade > 1 ? 's' : ''} added.` : ''}`, { view: 'audits', tab: 'rankings' });
        store.log('info', `${site.name} radar: ${bits.join(', ')}.`);
      }
    } else {
      store.log('info', `${site.name} radar: baseline recorded (${cur.lostBacklinks.length} lost links, ${cur.competitorContent.length} competitor pages, ${cur.losingKeywords.length} losing keywords).`);
    }
    store.save();
    onChange();
    return { ran: true, newLost: diff.newLost.length, newContent: diff.newContent.length, refDelta: diff.refDelta, tasksMade, baseline: !prev };
  }

  async function once(key, fn) {
    if (busy.has(key)) return;
    busy.add(key);
    try { await fn(); } catch (e) { store.log('error', `Radar: ${e.message}`); store.save(); onChange(); } finally { busy.delete(key); }
  }

  function tick() {
    const D = d();
    if (!D || D.settings.paused) return;
    const now = new Date();
    if (now.getDay() !== 4 || now.getHours() < 8) return; // Thursdays, from 08:00
    for (const s of D.sites) {
      const c = cfg(s);
      if (c.enabled && st()[`radar:${s.id}`] !== today()) { st()[`radar:${s.id}`] = today(); once(`Radar:${s.id}`, () => run(s)); }
    }
  }

  return { tick, run, diffSnapshot };
}

module.exports = { createRadar, diffSnapshot, mergeSnapshot };
