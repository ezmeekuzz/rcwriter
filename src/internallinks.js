// Site-wide internal linking: read all of a WordPress site's posts, work out
// which ones have few or no incoming internal links (orphans), and add
// contextual links to them from other relevant posts — one link per source,
// using a real phrase that already appears in the source so nothing is
// rewritten. Links go through the same approval/auto flow as everything else.
const enhance = require('./enhance');
const sitesLib = require('./sites');

const DAY = 864e5;
const today = () => new Date().toLocaleDateString('en-CA');
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
const STOP = new Set('the a an and or of for to in on at by with from your you our we is are be how what why when guide best top vs your their this that these those it its as into about over under more most new'.split(' '));

function createInternalLinks({ store, queueAction, notify, onChange }) {
  const d = () => store.data;
  const st = () => d().autoState || (d().autoState = {});
  const cfg = (site) => ({ enabled: false, mode: 'approve', maxTargets: 5, maxLinks: 10, ...(site.internalLinks || {}) });
  const busy = new Set();

  async function fetchPosts(site) {
    const auth = { user: site.username, pass: store.decrypt(site.secret) };
    const posts = [];
    for (let page = 1; page <= 4; page++) {
      const rows = await sitesLib.wpRequest(site, auth, '/wp/v2/posts', { query: { per_page: 100, page, status: 'publish', context: 'edit', _fields: 'id,title,link,content' }, purpose: 'audit' });
      if (!rows || !rows.length) break;
      for (const r of rows) {
        const raw = (r.content && (r.content.raw ?? r.content.rendered)) || '';
        posts.push({ id: r.id, title: enhance.htmlText(String(r.title && (r.title.raw || r.title.rendered) || '')), link: String(r.link || '').replace(/\/+$/, ''), raw });
      }
      if (rows.length < 100) break;
    }
    return posts;
  }

  // Significant contiguous phrases from a title, longest first (2–6 words).
  function anchorCandidates(title) {
    const words = String(title).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
    const out = [];
    for (let len = Math.min(6, words.length); len >= 2; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const span = words.slice(i, i + len);
        if (STOP.has(span[0].toLowerCase()) || STOP.has(span[span.length - 1].toLowerCase())) continue;
        if (span.filter((w) => !STOP.has(w.toLowerCase())).length < 2) continue;
        out.push(span.join(' '));
      }
    }
    return [...new Set(out)];
  }

  // Find a phrase from the target's title that appears verbatim in the source's
  // plain text, returned with the source's original casing. Null if none fits.
  function findAnchor(targetTitle, sourcePlain) {
    const hay = sourcePlain.toLowerCase();
    for (const cand of anchorCandidates(targetTitle)) {
      const at = hay.indexOf(cand.toLowerCase());
      if (at >= 0) {
        const anchor = sourcePlain.slice(at, at + cand.length);
        const n = anchor.trim().split(/\s+/).length;
        if (n >= 2 && n <= 7 && anchor.trim().length >= 6) return anchor.trim();
      }
    }
    return null;
  }

  function linkedUrls(raw) {
    const set = new Set();
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(raw))) set.add(m[1].replace(/\/+$/, '').replace(/#.*$/, ''));
    return set;
  }

  async function analyze(site, { manual = false } = {}) {
    const c = cfg(site);
    if (site.type !== 'wordpress' || !site.secret) { if (manual) throw new Error('Internal linking needs a connected WordPress site.'); return { targets: 0, queued: 0 }; }
    if (!manual && !c.enabled) return { targets: 0, queued: 0 };
    const maxTargets = Math.max(1, Math.min(20, Number(c.maxTargets) || 5));
    const maxLinks = Math.max(1, Math.min(40, Number(c.maxLinks) || 10));

    const posts = await fetchPosts(site);
    if (posts.length < 3) { if (manual) throw new Error('Not enough published posts to link between yet.'); return { targets: 0, queued: 0 }; }
    const byUrl = new Map(posts.map((p) => [p.link, p]));
    const plain = new Map(posts.map((p) => [p.id, enhance.htmlText(p.raw)]));
    const outLinks = new Map(posts.map((p) => [p.id, linkedUrls(p.raw)]));

    // Incoming internal links per post.
    const incoming = new Map(posts.map((p) => [p.id, 0]));
    for (const p of posts) for (const u of outLinks.get(p.id)) { const t = byUrl.get(u); if (t && t.id !== p.id) incoming.set(t.id, incoming.get(t.id) + 1); }

    // Targets: orphans (0) first, then thin (1), smallest first.
    const targets = posts.filter((p) => incoming.get(p.id) <= 1).sort((a, b) => incoming.get(a.id) - incoming.get(b.id)).slice(0, maxTargets);
    const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{4,}/g) || []);

    const siteUrl = site.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    let queued = 0; let applied = 0; const pairs = [];
    for (const target of targets) {
      if (queued + applied >= maxLinks) break;
      const tTok = tokens(`${target.title} ${plain.get(target.id).slice(0, 400)}`);
      // Candidate sources: don't already link to target, aren't the target, score by topical overlap.
      const cands = posts.filter((s) => s.id !== target.id && !outLinks.get(s.id).has(target.link))
        .map((s) => { const sTok = tokens(`${s.title} ${plain.get(s.id).slice(0, 600)}`); let overlap = 0; for (const w of tTok) if (sTok.has(w)) overlap += 1; return { s, overlap }; })
        .filter((x) => x.overlap >= 2).sort((a, b) => b.overlap - a.overlap).slice(0, 6);
      for (const { s } of cands) {
        if (queued + applied >= maxLinks) break;
        const anchor = findAnchor(target.title, plain.get(s.id));
        if (!anchor) continue;
        const check = enhance.insertLink(s.raw, anchor, target.link); // pre-validate against real content
        if (!check.ok) continue;
        const preview = `In "${clip(s.title, 60)}": link "${check.anchor || anchor}" → ${target.link}`;
        const res = await queueAction({ connectorId: `wp:${site.id}`, connectorName: `WordPress (${site.name})`, jobName: `Internal links: ${site.name}`, siteId: site.id, siteUrl,
          tool: 'wp_add_internal_link', risk: 'safe', args: { type: 'posts', id: s.id, anchorText: check.anchor || anchor, url: target.link },
          reason: `"${clip(target.title, 60)}" had ${incoming.get(target.id)} internal link${incoming.get(target.id) === 1 ? '' : 's'} pointing to it. Linking it from "${clip(s.title, 60)}".`, preview }, c.mode === 'auto' ? 'auto' : 'approve');
        if (res === 'applied') applied += 1; else queued += 1;
        pairs.push({ from: s.title, to: target.title, anchor: check.anchor || anchor });
        break; // one incoming link per target per run keeps it natural
      }
    }

    const log = d().internalLinkRuns || (d().internalLinkRuns = []);
    log.unshift({ id: store.uid(), siteId: site.id, at: new Date().toISOString(), posts: posts.length, orphans: posts.filter((p) => incoming.get(p.id) === 0).length, targets: targets.length, queued, applied, mode: c.mode, pairs: pairs.slice(0, 40) });
    d().internalLinkRuns = log.slice(0, 200);
    st()[`illinks:${site.id}`] = today();

    if (queued || applied) {
      notify(`Internal links: ${site.name}`, `${queued + applied} link${queued + applied > 1 ? 's' : ''} to under-linked pages ${c.mode === 'auto' ? 'added' : 'waiting for approval'}.`,
        { view: 'audits', tab: c.mode === 'auto' ? 'changes' : 'approvals' });
      store.log('info', `${site.name}: ${queued + applied} internal link${queued + applied > 1 ? 's' : ''} to orphan/thin pages ${c.mode === 'auto' ? 'added' : 'queued'}.`);
    } else if (manual) {
      store.log('info', `${site.name}: no new internal-link opportunities found (pages are already well linked, or no natural anchor existed).`);
    }
    store.save();
    onChange();
    return { targets: targets.length, queued, applied, orphans: posts.filter((p) => incoming.get(p.id) === 0).length };
  }

  async function once(key, fn) {
    if (busy.has(key)) return;
    busy.add(key);
    try { await fn(); } catch (e) { store.log('error', `Internal links: ${e.message}`); store.save(); onChange(); } finally { busy.delete(key); }
  }

  function tick() {
    const D = d();
    if (!D || D.settings.paused) return;
    const now = new Date();
    if (now.getDay() !== 3) return; // Wednesdays
    for (const s of D.sites) {
      const c = cfg(s);
      if (c.enabled && s.type === 'wordpress' && s.secret && st()[`illinks:${s.id}`] !== today() && now.getHours() >= 10) { st()[`illinks:${s.id}`] = today(); once(`Internal links:${s.id}`, () => analyze(s)); }
    }
  }

  return { tick, analyze };
}

module.exports = { createInternalLinks };
