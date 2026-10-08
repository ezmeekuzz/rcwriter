// Google Search Console, Analytics 4 and Tag Manager (read-only), plus PageSpeed Insights.
// Two ways to sign in:
//  - Service account (recommended for schedules): a JSON key; add its email as a user in
//    Search Console, GA4 and Tag Manager. Never expires.
//  - OAuth client: your own Google Cloud "Desktop app" client ID and secret; you sign in
//    with your Google account in the browser.
const crypto = require('crypto');
const http = require('http');

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/tagmanager.readonly'
];

const EP = {
  token: 'https://oauth2.googleapis.com/token',
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  gsc: 'https://www.googleapis.com/webmasters/v3',
  inspect: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
  gaAdmin: 'https://analyticsadmin.googleapis.com/v1beta',
  gaData: 'https://analyticsdata.googleapis.com/v1beta',
  gtm: 'https://tagmanager.googleapis.com/tagmanager/v2',
  psi: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
};

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const iso = (d) => d.toISOString().slice(0, 10);

function createGoogle({ store, openExternal }) {
  let cached = null; // { token, exp }

  const cfg = () => store.data.google || (store.data.google = {});
  const configured = () => {
    const g = cfg();
    return (g.mode === 'service' && !!g.serviceAccount) || (g.mode === 'oauth' && !!g.tokens);
  };

  async function postForm(url, params) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
    return j;
  }

  async function token() {
    if (cached && cached.exp > Date.now() + 60000) return cached.token;
    const g = cfg();
    if (g.mode === 'service') {
      const sa = JSON.parse(store.decrypt(g.serviceAccount));
      const now = Math.floor(Date.now() / 1000);
      const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPES.join(' '), aud: EP.token, iat: now, exp: now + 3600 }));
      const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key));
      const j = await postForm(EP.token, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` });
      cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
      return cached.token;
    }
    if (g.mode === 'oauth') {
      const tok = g.tokens ? JSON.parse(store.decrypt(g.tokens)) : null;
      if (!tok || !tok.refresh_token) throw new Error('Google is not signed in. Open Websites and click Sign in with Google.');
      const j = await postForm(EP.token, { grant_type: 'refresh_token', refresh_token: tok.refresh_token,
        client_id: g.clientId, client_secret: store.decrypt(g.clientSecret) });
      cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
      return cached.token;
    }
    throw new Error('Connect Google first (Websites, Google data).');
  }

  async function api(url, { method = 'GET', body } = {}) {
    const t = await token();
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) {
      const msg = (j && j.error && (j.error.message || j.error.status)) || text.slice(0, 200);
      if (res.status === 403) throw new Error(`Google refused access (${msg}). Make sure ${cfg().email || 'the connected account'} has been added to this property, and that the API is enabled in your Google Cloud project.`);
      throw new Error(`Google API error ${res.status}: ${msg}`);
    }
    return j || {};
  }

  // ---------- connect ----------
  async function useServiceAccount(jsonText) {
    let sa;
    try { sa = JSON.parse(jsonText); } catch { throw new Error('That file is not a valid service account key (JSON).'); }
    if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key) throw new Error('That JSON is not a service account key. In Google Cloud, open the service account, Keys, Add key, JSON.');
    const g = cfg();
    Object.assign(g, { mode: 'service', serviceAccount: store.encrypt(JSON.stringify(sa)), email: sa.client_email, project: sa.project_id });
    delete g.tokens;
    cached = null;
    store.save();
    return refreshLists();
  }

  function waitForCode(port, state) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        if (u.searchParams.get('state') !== state) { res.writeHead(400); res.end(); return; }
        const code = u.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:48px;text-align:center;color:#1C2340"><h2>${code ? 'Google is connected to RCWriter' : 'Google sign-in was not completed'}</h2><p>You can close this tab.</p>`);
        clearTimeout(timer); server.close();
        if (code) resolve(code); else reject(new Error(`Google sign-in cancelled: ${u.searchParams.get('error') || ''}`));
      });
      const timer = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out.')); }, 5 * 60000);
      server.on('error', reject);
      server.listen(port, '127.0.0.1');
    });
  }

  async function signInOAuth(clientId, clientSecret) {
    if (!clientId || !clientSecret) throw new Error('Enter the OAuth client ID and client secret.');
    const port = 43000 + Math.floor(Math.random() * 900);
    const redirect = `http://127.0.0.1:${port}`;
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(12));
    const u = new URL(EP.auth);
    Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline',
      prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state }).forEach(([k, v]) => u.searchParams.set(k, v));
    const waiting = waitForCode(port, state);
    await openExternal(u.toString());
    const code = await waiting;
    const tok = await postForm(EP.token, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: clientSecret, code_verifier: verifier });
    if (!tok.refresh_token) throw new Error('Google did not return a long-term sign-in. Remove RCWriter from your Google account permissions and try again.');
    let email = '';
    try { email = JSON.parse(Buffer.from(String(tok.id_token || '').split('.')[1] || '', 'base64').toString()).email || ''; } catch { /* no id token */ }
    const g = cfg();
    Object.assign(g, { mode: 'oauth', clientId: clientId.trim(), clientSecret: store.encrypt(clientSecret.trim()), tokens: store.encrypt(JSON.stringify({ refresh_token: tok.refresh_token })), email });
    delete g.serviceAccount;
    cached = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 };
    store.save();
    return refreshLists();
  }

  function disconnect() {
    store.data.google = { psiKey: cfg().psiKey || null };
    cached = null;
    store.save();
  }

  // ---------- listings for the property pickers ----------
  async function refreshLists() {
    const g = cfg();
    const out = { gsc: [], ga4: [], gtm: [], errors: [] };
    try { out.gsc = ((await api(`${EP.gsc}/sites`)).siteEntry || []).map((s) => ({ id: s.siteUrl, name: s.siteUrl, level: s.permissionLevel })); }
    catch (e) { out.errors.push(`Search Console: ${e.message}`); }
    try {
      let pageToken = '';
      do {
        const j = await api(`${EP.gaAdmin}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const a of j.accountSummaries || []) for (const p of a.propertySummaries || []) out.ga4.push({ id: p.property.replace('properties/', ''), name: `${p.displayName} (${a.displayName})` });
        pageToken = j.nextPageToken || '';
      } while (pageToken);
    } catch (e) { out.errors.push(`Analytics: ${e.message}`); }
    try {
      for (const a of (await api(`${EP.gtm}/accounts`)).account || []) {
        for (const c of (await api(`${EP.gtm}/${a.path}/containers`)).container || []) out.gtm.push({ id: c.path, name: `${c.name} ${c.publicId} (${a.name})` });
      }
    } catch (e) { out.errors.push(`Tag Manager: ${e.message}`); }
    g.lists = { ...out, at: new Date().toISOString() };
    g.lastError = out.errors.length === 3 ? out.errors.join(' ') : null;
    store.save();
    return g.lists;
  }

  // ---------- data ----------
  function range(args, days = 28) {
    const end = args.endDate || iso(new Date(Date.now() - 2 * 864e5));
    const start = args.startDate || iso(new Date(new Date(end).getTime() - (days - 1) * 864e5));
    return { start, end };
  }

  async function gscPerformance(siteUrl, args = {}) {
    const { start, end } = range(args);
    const body = { startDate: start, endDate: end, dimensions: args.dimensions && args.dimensions.length ? args.dimensions : ['query'],
      rowLimit: Math.min(Number(args.rowLimit) || 100, 1000), type: args.searchType || 'web' };
    const filters = [];
    if (args.pageContains) filters.push({ dimension: 'page', operator: 'contains', expression: args.pageContains });
    if (args.queryContains) filters.push({ dimension: 'query', operator: 'contains', expression: args.queryContains });
    if (filters.length) body.dimensionFilterGroups = [{ filters }];
    const j = await api(`${EP.gsc}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { method: 'POST', body });
    return { startDate: start, endDate: end, rows: (j.rows || []).map((r) => ({ keys: r.keys, clicks: r.clicks, impressions: r.impressions, ctr: Math.round(r.ctr * 1000) / 10, position: Math.round(r.position * 10) / 10 })) };
  }

  async function gscInspect(siteUrl, url) {
    const j = await api(EP.inspect, { method: 'POST', body: { inspectionUrl: url, siteUrl } });
    const r = (j.inspectionResult || {});
    const ix = r.indexStatusResult || {};
    return { verdict: ix.verdict, coverage: ix.coverageState, robotsTxt: ix.robotsTxtState, indexing: ix.indexingState, pageFetch: ix.pageFetchState,
      lastCrawl: ix.lastCrawlTime, googleCanonical: ix.googleCanonical, userCanonical: ix.userCanonical, referringUrls: (ix.referringUrls || []).slice(0, 5),
      mobile: r.mobileUsabilityResult && r.mobileUsabilityResult.verdict, richResults: r.richResultsResult && r.richResultsResult.verdict };
  }

  async function gscSitemaps(siteUrl) {
    const j = await api(`${EP.gsc}/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
    return (j.sitemap || []).map((s) => ({ path: s.path, lastSubmitted: s.lastSubmitted, lastDownloaded: s.lastDownloaded, isPending: s.isPending,
      errors: s.errors, warnings: s.warnings, contents: (s.contents || []).map((c) => ({ type: c.type, submitted: c.submitted, indexed: c.indexed })) }));
  }

  async function ga4Report(property, args = {}) {
    const { start, end } = range(args);
    const body = {
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: (args.dimensions && args.dimensions.length ? args.dimensions : ['pagePath']).map((name) => ({ name })),
      metrics: (args.metrics && args.metrics.length ? args.metrics : ['screenPageViews', 'sessions', 'engagementRate']).map((name) => ({ name })),
      limit: Math.min(Number(args.limit) || 50, 1000)
    };
    if (args.orderByMetric) body.orderBys = [{ metric: { metricName: args.orderByMetric }, desc: args.ascending !== true }];
    else body.orderBys = [{ metric: { metricName: body.metrics[0].name }, desc: true }];
    const j = await api(`${EP.gaData}/properties/${encodeURIComponent(property)}:runReport`, { method: 'POST', body });
    const dh = (j.dimensionHeaders || []).map((h) => h.name);
    const mh = (j.metricHeaders || []).map((h) => h.name);
    return { startDate: start, endDate: end, rows: (j.rows || []).map((r) => {
      const o = {};
      (r.dimensionValues || []).forEach((v, i) => { o[dh[i]] = v.value; });
      (r.metricValues || []).forEach((v, i) => { o[mh[i]] = Number(v.value); });
      return o;
    }), rowCount: j.rowCount || 0 };
  }

  async function gtmLive(containerPath) {
    const j = await api(`${EP.gtm}/${containerPath}/versions:live`);
    const param = (t, key) => ((t.parameter || []).find((p) => p.key === key) || {}).value;
    return {
      version: j.containerVersionId, name: j.name,
      tags: (j.tag || []).map((t) => ({ name: t.name, type: t.type, paused: !!t.paused, measurementId: param(t, 'measurementId') || param(t, 'tagId') || undefined, firingTriggers: (t.firingTriggerId || []).length })),
      triggers: (j.trigger || []).map((t) => ({ name: t.name, type: t.type })),
      variables: (j.variable || []).length
    };
  }

  async function pagespeed(url, strategy = 'mobile', category = 'performance') {
    const u = new URL(EP.psi);
    u.searchParams.set('url', url);
    u.searchParams.set('strategy', strategy === 'desktop' ? 'desktop' : 'mobile');
    u.searchParams.set('category', category);
    const key = cfg().psiKey ? store.decrypt(cfg().psiKey) : '';
    if (key) u.searchParams.set('key', key);
    const res = await fetch(u, { signal: AbortSignal.timeout(120000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PageSpeed Insights: ${(j.error && j.error.message) || res.status}${res.status === 429 ? ' (add a free PageSpeed API key in Websites to raise the limit)' : ''}`);
    const lh = j.lighthouseResult || {};
    const a = lh.audits || {};
    if (category === 'accessibility') {
      const cat = (lh.categories || {}).accessibility || {};
      const failing = (cat.auditRefs || []).map((r) => a[r.id]).filter((x) => x && x.score !== null && x.score < 1 && x.scoreDisplayMode !== 'notApplicable')
        .map((x) => ({ title: x.title, items: ((x.details && x.details.items) || []).length }));
      return { strategy, score: cat.score !== undefined ? Math.round(cat.score * 100) : null, failing };
    }
    const v = (k) => a[k] && a[k].displayValue;
    const opps = Object.values(a).filter((x) => x.details && x.details.type === 'opportunity' && x.score !== null && x.score < 0.9)
      .sort((x, y) => ((y.details.overallSavingsMs || 0) - (x.details.overallSavingsMs || 0))).slice(0, 8)
      .map((x) => ({ title: x.title, savings: x.displayValue || '' }));
    const field = (j.loadingExperience && j.loadingExperience.metrics) || {};
    return {
      strategy, score: lh.categories && lh.categories.performance ? Math.round(lh.categories.performance.score * 100) : null,
      lab: { LCP: v('largest-contentful-paint'), CLS: v('cumulative-layout-shift'), TBT: v('total-blocking-time'), FCP: v('first-contentful-paint'), speedIndex: v('speed-index'), pageWeight: v('total-byte-weight') },
      realUsers: Object.fromEntries(Object.entries(field).map(([k, m]) => [k, { p75: m.percentile, rating: m.category }])),
      opportunities: opps,
      indexable: a['is-crawlable'] ? a['is-crawlable'].score === 1 : undefined
    };
  }

  // Two equal periods back to back (data lags about 2 days), per page or query.
  async function gscCompare(siteUrl, { dimension = 'page', days = 28, minClicks = 10, limit = 20, ranges = null } = {}) {
    const n = Math.max(3, Math.min(90, Number(days) || 28));
    const end = new Date(Date.now() - 2 * 864e5);
    const midEnd = new Date(end.getTime() - n * 864e5);
    const d = dimension === 'query' ? 'query' : 'page';
    const r = ranges || { now: { start: iso(new Date(end.getTime() - (n - 1) * 864e5)), end: iso(end) }, before: { start: iso(new Date(midEnd.getTime() - (n - 1) * 864e5)), end: iso(midEnd) } };
    const [now, before] = await Promise.all([
      gscPerformance(siteUrl, { dimensions: [d], rowLimit: 1000, startDate: r.now.start, endDate: r.now.end }),
      gscPerformance(siteUrl, { dimensions: [d], rowLimit: 1000, startDate: r.before.start, endDate: r.before.end })
    ]);
    const map = new Map();
    for (const r of before.rows) map.set(r.keys[0], { key: r.keys[0], clicksBefore: r.clicks, clicksNow: 0, impressionsBefore: r.impressions, impressionsNow: 0, positionBefore: r.position, positionNow: null });
    for (const r of now.rows) {
      const o = map.get(r.keys[0]) || { key: r.keys[0], clicksBefore: 0, impressionsBefore: 0, positionBefore: null };
      Object.assign(o, { clicksNow: r.clicks, impressionsNow: r.impressions, positionNow: r.position });
      map.set(r.keys[0], o);
    }
    const rows = [...map.values()].map((o) => ({ ...o, clicksChange: o.clicksNow - o.clicksBefore, clicksChangePct: o.clicksBefore ? Math.round(((o.clicksNow - o.clicksBefore) / o.clicksBefore) * 100) : null }));
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const min = Number(minClicks) >= 0 ? Number(minClicks) : 10;
    const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
    return {
      dimension: d,
      periodNow: { start: now.startDate, end: now.endDate }, periodBefore: { start: before.startDate, end: before.endDate },
      totals: { clicksNow: sum('clicksNow'), clicksBefore: sum('clicksBefore'), impressionsNow: sum('impressionsNow'), impressionsBefore: sum('impressionsBefore') },
      biggestLosers: rows.filter((r) => r.clicksBefore >= min && r.clicksChange < 0).sort((a, b) => a.clicksChange - b.clicksChange).slice(0, lim),
      biggestGainers: rows.filter((r) => r.clicksChange > 0).sort((a, b) => b.clicksChange - a.clicksChange).slice(0, lim)
    };
  }

  // Daily clicks for the last 2 x N days, summed per period (for traffic-drop alerts).
  async function gscTotals(siteUrl, days = 7) {
    const n = Math.max(1, Number(days) || 7);
    const end = new Date(Date.now() - 2 * 864e5);
    const r = await gscPerformance(siteUrl, { dimensions: ['date'], rowLimit: 1000, startDate: iso(new Date(end.getTime() - (2 * n - 1) * 864e5)), endDate: iso(end) });
    const split = iso(new Date(end.getTime() - (n - 1) * 864e5));
    let now = 0, before = 0;
    for (const row of r.rows) { if (row.keys[0] >= split) now += row.clicks; else before += row.clicks; }
    return { clicksNow: now, clicksBefore: before, days: n, endDate: r.endDate };
  }

  // Totals for one date range: clicks, impressions, CTR (%) and average position.
  async function gscSummary(siteUrl, start, end) {
    const r = await gscPerformance(siteUrl, { dimensions: ['date'], rowLimit: 1000, startDate: start, endDate: end });
    const clicks = r.rows.reduce((t, x) => t + x.clicks, 0);
    const impressions = r.rows.reduce((t, x) => t + x.impressions, 0);
    const position = impressions ? r.rows.reduce((t, x) => t + x.position * x.impressions, 0) / impressions : null;
    return { clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 1000) / 10 : 0, position: position === null ? null : Math.round(position * 10) / 10 };
  }

  async function ga4Totals(property, start, end, metrics = ['sessions', 'activeUsers', 'engagementRate', 'keyEvents']) {
    const body = { dateRanges: [{ startDate: start, endDate: end }], metrics: metrics.map((name) => ({ name })) };
    const j = await api(`${EP.gaData}/properties/${encodeURIComponent(property)}:runReport`, { method: 'POST', body });
    const row = (j.rows || [])[0];
    const out = {};
    (j.metricHeaders || []).forEach((h, i) => { out[h.name] = row ? Number(row.metricValues[i].value) : 0; });
    return out;
  }

  // Search queries the site already shows up for, ranked as article ideas.
  async function opportunityQueries(siteUrl, limit = 40) {
    const r = await gscPerformance(siteUrl, { dimensions: ['query'], rowLimit: 1000 });
    return r.rows.filter((x) => x.position >= 4 && x.position <= 30 && x.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions).slice(0, limit)
      .map((x) => ({ query: x.keys[0], impressions: x.impressions, position: x.position, clicks: x.clicks }));
  }

  function status() {
    const g = cfg();
    return { connected: configured(), mode: g.mode || null, email: g.email || '', project: g.project || '', lists: g.lists || null,
      lastError: g.lastError || null, hasPsiKey: !!g.psiKey, clientId: g.clientId || '' };
  }

  function setPsiKey(key) { cfg().psiKey = key ? store.encrypt(String(key).trim()) : null; store.save(); }

  return { EP, SCOPES, configured, status, useServiceAccount, signInOAuth, disconnect, refreshLists, setPsiKey,
    gscPerformance, gscCompare, gscTotals, gscSummary, ga4Totals, gscInspect, gscSitemaps, ga4Report, gtmLive, pagespeed, opportunityQueries, _resetCache: () => { cached = null; } };
}

module.exports = { createGoogle, SCOPES };
