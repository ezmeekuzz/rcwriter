// Safe-deploy guard: after an audit or revision applies changes to a live site,
// load the key pages in a headless browser and check they still work — HTTP ok,
// no WSOD or PHP fatal/database errors, and no drastic visual collapse against
// the last known-good snapshot. On hard breakage it automatically rolls the
// run's changes back (when set to auto); otherwise it alerts and files a task.
// This lets the owner raise autonomy without fear of a change taking the site down.
const fs = require('fs');
const path = require('path');

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); };

function createDeployGuard({ store, capture, revert, notify, addTask, onChange, userDataDir }) {
  const d = () => store.data;
  const dir = path.join(userDataDir || '.', 'guard');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  const cfg = (site) => ({ enabled: false, mode: 'auto', ...(site.deployGuard || {}) });

  function originOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } }
  function pagesToCheck(site, rec) {
    const host = originOf(site.url);
    const urls = new Set();
    if (site.url) urls.add(site.url.replace(/\/+$/, ''));
    for (const p of (site.webdev && site.webdev.keyPages) || []) if (/^https?:\/\//.test(p)) urls.add(p.replace(/\/+$/, ''));
    // Add any same-site page URLs mentioned in this run's changes.
    for (const c of (d().changes || []).filter((x) => x.runId === (rec && rec.id))) {
      const found = `${c.preview || ''} ${c.reason || ''} ${(c.args && c.args.url) || ''}`.match(/https?:\/\/[^\s"'<>)]+/g) || [];
      for (const u of found) { const clean = u.replace(/[.,]$/, '').replace(/\/+$/, ''); if (host && originOf(clean) === host) urls.add(clean); }
    }
    return [...urls].slice(0, 6);
  }

  const baseFile = (siteId, url) => path.join(dir, `${siteId}_${hash(url)}.png`);

  function loadBaseline(siteId, url) {
    const f = baseFile(siteId, url);
    try { if (fs.existsSync(f)) return capture.load(f); } catch { /* none */ }
    return null;
  }
  function saveBaseline(siteId, url, snap) {
    try { if (snap && snap.png) fs.writeFileSync(baseFile(siteId, url), snap.png); } catch { /* best effort */ }
  }

  // Load a page and decide whether it is hard-broken.
  async function checkPage(siteId, url) {
    let snap;
    try { snap = await capture(url); } catch (e) { return { url, ok: false, reason: `could not load (${clip(e.message, 60)})`, hard: true, snap: null }; }
    const status = snap.status;
    if (status && status >= 400) return { url, ok: false, reason: `HTTP ${status}`, hard: true, snap };
    if (snap.errorText) return { url, ok: false, reason: snap.errorText, hard: true, snap };
    if (status === null && !snap.title) return { url, ok: false, reason: 'page did not load', hard: true, snap };
    // Visual collapse vs last known good (soft signal only — content edits change pixels legitimately).
    let diffPercent = null;
    const base = loadBaseline(siteId, url);
    if (base) { try { diffPercent = capture.diff(base, snap).percent; } catch { /* ignore */ } }
    return { url, ok: true, reason: '', hard: false, diffPercent, snap };
  }

  // Called after an audit/revision run finishes. Verifies and may roll back.
  async function verifyRun(site, rec) {
    const c = cfg(site);
    if (!c.enabled || !site || !site.url || !rec || (rec.applied || 0) < 1) return null;
    const pages = pagesToCheck(site, rec);
    if (!pages.length) return null;

    const results = [];
    for (const url of pages) results.push(await checkPage(site.id, url));
    const broken = results.filter((r) => r.hard);
    const bigDiff = results.filter((r) => !r.hard && r.diffPercent !== null && r.diffPercent >= 75);

    const runChanges = (d().changes || []).filter((x) => x.runId === rec.id && x.status === 'applied');
    let reverted = 0;
    if (broken.length && c.mode === 'auto' && runChanges.length) {
      for (const ch of runChanges) { try { await revert(ch.id); reverted += 1; } catch { /* leave it; reported below */ } }
    }

    const rebroken = [];
    if (reverted) { // confirm the site is healthy again after rollback
      for (const r of broken) { const re = await checkPage(site.id, r.url); if (re.hard) rebroken.push(re.url); }
    }

    // Update known-good snapshots for pages that are healthy and unchanged-enough.
    for (const r of results) if (r.ok && r.snap && (r.diffPercent === null || r.diffPercent < 75)) saveBaseline(site.id, r.url, r.snap);

    const entry = { id: store.uid(), siteId: site.id, at: new Date().toISOString(), runId: rec.id, jobName: rec.name || '',
      pages: results.map((r) => ({ url: r.url, ok: r.ok, reason: r.reason, diffPercent: r.diffPercent })),
      broken: broken.map((r) => r.url), reverted, mode: c.mode,
      verdict: broken.length ? (reverted ? (rebroken.length ? 'reverted-still-broken' : 'reverted') : 'broken') : bigDiff.length ? 'changed-a-lot' : 'ok' };
    const log = d().deployChecks || (d().deployChecks = []);
    log.unshift(entry);
    d().deployChecks = log.slice(0, 200);

    if (broken.length) {
      const what = broken.map((r) => `${clip(r.url.replace(/^https?:\/\//, ''), 40)} (${r.reason})`).join('; ');
      if (reverted && !rebroken.length) {
        notify(`Reverted a breaking change: ${site.name}`, `A change broke ${what}. RCWriter rolled back ${reverted} change${reverted > 1 ? 's' : ''} from this run and the site is healthy again.`, { view: 'audits', tab: 'changes' });
        store.log('error', `${site.name}: safe-deploy guard rolled back ${reverted} change${reverted > 1 ? 's' : ''} after ${what}.`);
      } else {
        notify(`Site may be broken: ${site.name}`, `${what}.${reverted ? ' Rollback was attempted but the page is still failing.' : ''} Check it now.`, { view: 'audits', tab: 'changes' });
        store.log('error', `${site.name}: safe-deploy guard found ${what}${reverted ? ' (rollback did not fully fix it)' : ''}.`);
        if (addTask) addTask({ title: `Fix broken page on ${site.name}`, siteId: site.id, priority: 'high', source: 'monitor', notes: `The safe-deploy guard found after an AI change: ${what}. ${c.mode === 'auto' ? 'Automatic rollback ' + (reverted ? 'did not resolve it.' : 'had no undoable changes.') : 'Guard is in warn-only mode, so nothing was rolled back.'}` });
      }
    } else if (bigDiff.length) {
      notify(`Big visual change: ${site.name}`, `${bigDiff.map((r) => `${clip(r.url.replace(/^https?:\/\//, ''), 40)} (~${r.diffPercent}% changed)`).join('; ')}. It still loads fine — just check it looks right.`, { view: 'audits', tab: 'changes' });
    }
    store.save();
    onChange();
    return entry;
  }

  return { verifyRun };
}

module.exports = { createDeployGuard };
