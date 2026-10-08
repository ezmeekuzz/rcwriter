// Website monitoring: uptime (paced through the host guard), SSL certificate
// expiry (a TLS handshake, which doesn't load any page) and Search Console
// traffic drops, which can start an audit automatically.
const tls = require('tls');

const MIN = 60000;
const HOUR = 60 * MIN;
const today = () => new Date().toLocaleDateString('en-CA');

const DEFAULTS = { enabled: false, uptime: true, intervalMin: 30, ssl: true, sslDays: 14, traffic: true, dropPct: 30, minClicks: 30, trafficTime: '07:30', onDropJobId: '' };

function certInfo(host) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 15000, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate() || {};
      const out = { validTo: c.valid_to ? new Date(c.valid_to).toISOString() : null, issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || '', authorized: sock.authorized, error: sock.authorizationError ? String(sock.authorizationError) : null };
      sock.end();
      resolve(out);
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('timed out')); });
    sock.on('error', reject);
  });
}

function createMonitor({ store, google, guard, notify, runAudit, onChange }) {
  const busy = new Set();
  let timer = null;

  const cfg = (site) => ({ ...DEFAULTS, ...(site.monitor || {}) });
  const state = (id) => {
    const all = store.data.monitorState || (store.data.monitorState = {});
    return all[id] || (all[id] = { history: [] });
  };

  async function checkUp(site) {
    const t0 = Date.now();
    try {
      const res = await guard.guardedFetch(site.url, { method: 'GET', redirect: 'follow', headers: { accept: 'text/html,*/*' }, signal: AbortSignal.timeout(30000) }, { purpose: 'monitor' });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ok: res.status < 500, code: res.status, ms: Date.now() - t0 };
    } catch (e) {
      if (e.paused || e.blocked) return { ok: null, code: null, note: 'Not checked: the host\'s bot protection paused direct requests.' };
      return { ok: false, code: 0, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'timed out after 30 seconds' : String((e.cause && e.cause.code) || e.message) };
    }
  }

  async function uptime(site, c, s, force) {
    const now = Date.now();
    const due = force || !s.lastCheckAt || now - new Date(s.lastCheckAt).getTime() >= c.intervalMin * MIN || (s.failingSince && s.status !== 'down' && now - new Date(s.lastCheckAt).getTime() >= 2 * MIN);
    if (!due) return;
    const r = await checkUp(site);
    s.lastCheckAt = new Date().toISOString();
    s.last = r;
    s.history = [...(s.history || []), { at: s.lastCheckAt, ok: r.ok, code: r.code, ms: r.ms }].slice(-200);
    if (r.ok === false) {
      if (!s.failingSince) s.failingSince = s.lastCheckAt;
      else if (s.status !== 'down' && now - new Date(s.failingSince).getTime() >= 90 * 1000) {
        s.status = 'down';
        s.downSince = s.failingSince;
        store.log('error', `${site.name} is down: ${r.code ? `HTTP ${r.code}` : r.error}.`);
        notify(`${site.name} is down`, `${site.url} ${r.code ? `answered HTTP ${r.code}` : `didn't answer (${r.error})`} twice in a row. RCWriter will tell you when it's back.`, { view: 'audits', tab: 'monitoring' });
      }
    } else if (r.ok === true) {
      if (s.status === 'down') {
        const mins = Math.round((Date.now() - new Date(s.downSince).getTime()) / MIN);
        store.log('info', `${site.name} is back up after about ${mins} minute${mins === 1 ? '' : 's'}.`);
        notify(`${site.name} is back up`, `It was down for about ${mins} minute${mins === 1 ? '' : 's'}.`, { view: 'audits', tab: 'monitoring' });
      }
      s.status = 'up';
      s.failingSince = null;
      s.downSince = null;
    } else if (s.status !== 'down') s.status = 'unknown';
  }

  async function ssl(site, c, s, force) {
    const u = new URL(site.url);
    if (u.protocol !== 'https:') return;
    if (!force && s.ssl && s.ssl.checkedAt && Date.now() - new Date(s.ssl.checkedAt).getTime() < 6 * HOUR) return;
    try {
      const info = await certInfo(u.hostname);
      const daysLeft = info.validTo ? Math.floor((new Date(info.validTo) - Date.now()) / (24 * HOUR)) : null;
      s.ssl = { ...info, daysLeft, checkedAt: new Date().toISOString() };
      const bad = !info.authorized || (daysLeft !== null && daysLeft <= c.sslDays);
      if (bad && s.sslAlertedOn !== today()) {
        s.sslAlertedOn = today();
        const msg = !info.authorized ? `The certificate isn't valid (${info.error || 'unknown problem'}).` : daysLeft < 0 ? 'The certificate has expired.' : `The certificate expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${new Date(info.validTo).toLocaleDateString()}).`;
        store.log('error', `${site.name} SSL: ${msg}`);
        notify(`${site.name}: SSL certificate problem`, `${msg} Visitors will see a security warning if it isn't fixed.`, { view: 'audits', tab: 'monitoring' });
      }
    } catch (e) {
      s.ssl = { error: e.message, checkedAt: new Date().toISOString() };
    }
  }

  async function traffic(site, c, s, force) {
    const g = site.google || {};
    if (!g.gscSite || !google.configured()) return;
    const [h, m] = String(c.trafficTime || '07:30').split(':').map(Number);
    const at = new Date(); at.setHours(h || 0, m || 0, 0, 0);
    if (!force && ((s.traffic && s.traffic.checkedOn === today()) || Date.now() < at.getTime())) return;
    const t = await google.gscTotals(g.gscSite, 7);
    const change = t.clicksBefore ? Math.round(((t.clicksNow - t.clicksBefore) / t.clicksBefore) * 100) : null;
    s.traffic = { ...t, changePct: change, checkedOn: today(), checkedAt: new Date().toISOString() };
    if (change === null || t.clicksBefore < c.minClicks || -change < c.dropPct) return;
    if (s.trafficAlertedOn === today()) { s.traffic.losers = (s.lastLosers || []); return; } // once a day, even on "Check now"
    s.trafficAlertedOn = today();
    let losers = [];
    try { losers = (await google.gscCompare(g.gscSite, { dimension: 'page', days: 7, minClicks: 5, limit: 5 })).biggestLosers; } catch { /* totals are enough */ }
    s.traffic.losers = losers.map((x) => ({ page: x.key, before: x.clicksBefore, now: x.clicksNow }));
    s.lastLosers = s.traffic.losers;
    const pages = losers.slice(0, 3).map((x) => `${x.key.replace(/^https?:\/\/[^/]+/, '') || '/'} (${x.clicksBefore} → ${x.clicksNow})`).join(', ');
    const summary = `Search Console clicks fell ${-change}% in the last 7 days (${t.clicksBefore} → ${t.clicksNow}, data up to ${t.endDate}).${pages ? ` Biggest drops: ${pages}.` : ''}`;
    store.log('error', `${site.name}: ${summary}`);
    const job = c.onDropJobId ? (store.data.auditJobs || []).find((j) => j.id === c.onDropJobId) : null;
    notify(`${site.name}: traffic dropped ${-change}%`, `${summary}${job ? ` Starting "${job.name}".` : ''}`.slice(0, 300), { view: 'audits', tab: job ? 'jobs' : 'monitoring' });
    if (job) {
      runAudit(job, `${summary}\n\nPages that lost the most clicks (7 days vs the 7 days before):\n${losers.map((x) => `- ${x.key}: ${x.clicksBefore} → ${x.clicksNow} clicks`).join('\n') || '(not available)'}\n\nFind out why and fix what you can, starting with these pages.`)
        .catch((e) => { store.log('error', `"${job.name}" could not start after the traffic drop: ${e.message}`); store.save(); onChange(); });
    }
  }

  async function checkSite(site, { force = false } = {}) {
    if (busy.has(site.id)) return;
    const c = cfg(site);
    const s = state(site.id);
    busy.add(site.id);
    try {
      if (c.uptime && site.type !== 'webhook') await uptime(site, c, s, force);
      if (c.ssl && site.type !== 'webhook') await ssl(site, c, s, force);
      if (c.traffic) { try { await traffic(site, c, s, force); } catch (e) { s.traffic = { ...(s.traffic || {}), error: e.message, checkedAt: new Date().toISOString(), checkedOn: today() }; } }
    } finally {
      busy.delete(site.id);
      store.save();
      onChange();
    }
  }

  function tick() {
    if (!store.data || store.data.settings.paused) return;
    for (const site of store.data.sites || []) {
      if (site.monitor && site.monitor.enabled) checkSite(site).catch(() => {});
    }
  }

  return {
    start() { setTimeout(tick, 20000); timer = setInterval(tick, MIN); },
    stop() { clearInterval(timer); },
    checkNow: (site) => checkSite(site, { force: true }),
    status(siteId) {
      const s = (store.data.monitorState || {})[siteId];
      if (!s) return null;
      const day = (s.history || []).filter((h) => Date.now() - new Date(h.at).getTime() < 24 * HOUR && h.ok !== null);
      return { status: s.status || 'unknown', lastCheckAt: s.lastCheckAt || null, last: s.last || null, downSince: s.downSince || null,
        uptime24h: day.length ? Math.round((day.filter((h) => h.ok).length / day.length) * 1000) / 10 : null, avgMs: day.length ? Math.round(day.reduce((t, h) => t + (h.ms || 0), 0) / day.length) : null,
        ssl: s.ssl || null, traffic: s.traffic || null, busy: busy.has(siteId) };
    },
    DEFAULTS
  };
}

module.exports = { createMonitor, certInfo, DEFAULTS };
