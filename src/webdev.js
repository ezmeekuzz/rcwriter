// Web developer maintenance: plugin/theme/core update checks and safe updates
// with screenshot comparison, a security watch, contact form tests, domain and
// email (SPF, DKIM, DMARC) checks, and weekly speed trends.
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const sitesLib = require('./sites');
const guard = require('./hostguard');

const DAY = 864e5;
const today = () => new Date().toLocaleDateString('en-CA');
const dueAt = (t) => { const [h, m] = String(t).split(':').map(Number); const x = new Date(); x.setHours(h || 0, m || 0, 0, 0); return x; };
const cmpVer = (a, b) => { const x = String(a || '0').split(/[.-]/).map((n) => parseInt(n, 10) || 0); const y = String(b || '0').split(/[.-]/).map((n) => parseInt(n, 10) || 0); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const SPAM = /\b(viagra|cialis|casino|porn|payday loan|replica (watches|handbags)|escort|betting|slot ?gacor|togel|judi online|essay writing service)\b/i;
const JAPANESE_HACK = /[぀-ヿ]{20,}/;
const DKIM_SELECTORS = ['google', 'default', 'selector1', 'selector2', 'k1', 's1', 's2', 'mail', 'dkim', 'smtp', 'mandrill', 'mxvault', 'zoho', 'protonmail'];

function createWebdev({ store, google, notify, onChange, addTask, capture, connectors, auditor }) {
  const d = () => store.data;
  const st = () => d().autoState || (d().autoState = {});
  const state = (id) => { const all = d().webdevState || (d().webdevState = {}); return all[id] || (all[id] = {}); };
  const cfg = (site) => ({ updates: true, security: true, domain: true, speed: true, formTest: { enabled: false, formId: '', day: 1 }, ...(site.webdev || {}) });
  const busy = new Set();
  const wpAuth = (s) => ({ user: s.username, pass: store.decrypt(s.secret) });
  const wp = (s, route, opts = {}) => sitesLib.wpRequest(s, wpAuth(s), route, { purpose: 'audit', ...opts });
  const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '');

  // ---------- updates ----------
  async function wporgPlugin(slug) {
    const r = await fetch(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && j.version ? { version: j.version, tested: j.tested || '', updated: j.last_updated || '' } : null;
  }

  async function checkUpdates(site) {
    if (site.type !== 'wordpress' || !site.secret) return null;
    const out = { checkedAt: new Date().toISOString(), plugins: [], themes: [], core: null, errors: [] };
    try {
      const plugins = await wp(site, '/wp/v2/plugins');
      for (const p of plugins) {
        const slug = String(p.plugin).split('/')[0];
        const info = await wporgPlugin(slug).catch(() => null);
        const row = { plugin: p.plugin, slug, name: p.name, status: p.status, version: p.version, latest: info ? info.version : null };
        row.outdated = !!(info && cmpVer(info.version, p.version) > 0);
        out.plugins.push(row);
      }
    } catch (e) { out.errors.push(`Plugins: ${e.message}${/rest_cannot|forbidden|401|403/i.test(e.message) ? ' (needs an Administrator connection)' : ''}`); if (e.blocked || e.paused) throw e; }
    try {
      const themes = await wp(site, '/wp/v2/themes');
      out.themes = themes.map((t) => ({ slug: t.stylesheet, name: (t.name && (t.name.raw || t.name.rendered)) || t.stylesheet, version: t.version, status: t.status }));
    } catch (e) { out.errors.push(`Themes: ${e.message}`); }
    try {
      const res = await guard.guardedFetch(`${site.url}/feed/`, { signal: AbortSignal.timeout(20000) }, { purpose: 'audit', cacheable: true });
      const txt = await res.text();
      const v = (txt.match(/wordpress\.org\/\?v=([\d.]+)/) || [])[1];
      const latest = await (await fetch('https://api.wordpress.org/core/version-check/1.7/', { signal: AbortSignal.timeout(20000) })).json();
      const newest = latest.offers && latest.offers[0] && latest.offers[0].current;
      out.core = { version: v || null, latest: newest || null, outdated: !!(v && newest && cmpVer(newest, v) > 0) };
    } catch (e) { out.errors.push(`Core: ${e.message}`); }
    const s = state(site.id);
    const prevCount = s.updates ? s.updates.plugins.filter((p) => p.outdated).length : 0;
    s.updates = out;
    const n = out.plugins.filter((p) => p.outdated).length + (out.core && out.core.outdated ? 1 : 0);
    if (n && n > prevCount) notify(`Updates available: ${site.name}`, `${n} update${n > 1 ? 's' : ''} waiting (${out.plugins.filter((p) => p.outdated).slice(0, 3).map((p) => p.name).join(', ')}${out.core && out.core.outdated ? `${out.plugins.some((p) => p.outdated) ? ', ' : ''}WordPress ${out.core.latest}` : ''}).`, { view: 'audits', tab: 'maintenance' });
    st()[`updates:${site.id}`] = today();
    store.save();
    onChange();
    return out;
  }

  // Runs plugin updates through WPVibe (WP-CLI), one at a time, checking key
  // pages with screenshots before and after each one.
  async function runUpdates(site, slugs) {
    const vibe = d().connectors.find((c) => /wpvibe/i.test(`${c.preset || ''} ${c.name} ${c.url}`));
    if (!vibe) throw new Error('Safe updates need WPVibe (it runs WP-CLI on the site). Add it under Site audits, Connections.');
    const u = state(site.id).updates;
    const list = (u ? u.plugins.filter((p) => p.outdated && (!slugs || slugs.includes(p.slug))) : []).map((p) => `- ${p.name} (${p.slug}): ${p.version} → ${p.latest}`);
    if (!list.length) throw new Error('No plugin updates to run. Check for updates first.');
    const pages = [site.url, ...(site.webdev && site.webdev.keyPages ? site.webdev.keyPages : [])].slice(0, 4);
    const job = {
      id: `updates-${site.id}`, name: `Safe updates: ${site.name}`, siteId: site.id, siteUrl: site.url.replace(/^https?:\/\//, ''), connectorIds: [vibe.id], builtins: ['wp', 'web', 'visual'],
      mode: 'full', provider: (d().settings.assistant && d().settings.assistant.provider) || 'chatgpt', model: (d().settings.assistant && d().settings.assistant.model) || '', maxToolCalls: 40 + list.length * 8, maxChanges: list.length * 2 + 4, maxMinutes: 40,
      instructions: `Update these WordPress plugins safely, one at a time, using WPVibe's WP-CLI tool on this site only:\n${list.join('\n')}\n\nProcedure:\n1. Before any update, call visual__visual_snapshot for each of these pages: ${pages.join(', ')}.\n2. For each plugin in turn: run "wp plugin update <slug>". Then call visual__visual_compare for every page. If a page now fails to load, shows an error, or visual_compare reports a large change (over 15% of the page) that isn't explained by normal content like a slider, roll that plugin back with "wp plugin install <slug> --version=<old version> --force", compare again, and stop updating further plugins.\n3. Never update WordPress core or themes, never delete anything, and never change settings.\nReport a table: Plugin | From | To | Result (updated, rolled back, failed) | Notes.`
    };
    return auditor.runJob(job, { kind: 'audit' });
  }

  // ---------- screenshots ----------
  const shotDir = (siteId) => path.join(d().settings.outputDir, 'Monitoring', 'screenshots', siteId);
  async function snapshot(site, url, label = 'baseline') {
    const shot = await capture(url);
    const dir = shotDir(site.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-${Buffer.from(url).toString('base64url').slice(0, 60)}.png`);
    fs.writeFileSync(file, shot.png);
    return { file, width: shot.width, height: shot.height, status: shot.status, title: shot.title };
  }

  async function compare(site, url) {
    const base = path.join(shotDir(site.id), `baseline-${Buffer.from(url).toString('base64url').slice(0, 60)}.png`);
    if (!fs.existsSync(base)) throw new Error('No baseline screenshot for this page. Call visual_snapshot first.');
    const now = await capture(url);
    const prev = await capture.load(base);
    const diff = capture.diff(prev, now);
    const file = path.join(shotDir(site.id), `after-${Buffer.from(url).toString('base64url').slice(0, 60)}.png`);
    fs.writeFileSync(file, now.png);
    return { url, status: now.status, title: now.title, changedPercent: diff.percent, sizeChanged: diff.sizeChanged, errorText: now.errorText || null, before: base, after: file };
  }

  function visualTools(site) {
    const T = (name, description, properties, required, run) => ({ name, description, inputSchema: { type: 'object', properties, required }, risk: 'read', run });
    return [
      T('visual_snapshot', 'Take a screenshot of a page as the baseline before changing anything.', { url: { type: 'string' } }, ['url'], async ({ url }) => JSON.stringify(await snapshot(site, url, 'baseline'))),
      T('visual_compare', 'Screenshot a page again and compare it with its baseline: how much of the page changed (%), the HTTP status, the title and any PHP or WordPress error text on the page.', { url: { type: 'string' } }, ['url'], async ({ url }) => JSON.stringify(await compare(site, url)))
    ];
  }

  // ---------- security watch ----------
  async function security(site) {
    const s = state(site.id);
    const found = [];
    if (site.type === 'wordpress' && site.secret) {
      try {
        const admins = await wp(site, '/wp/v2/users', { query: { roles: 'administrator', context: 'edit', per_page: 100, _fields: 'id,username,name,email,registered_date' } });
        const ids = admins.map((a) => `${a.id}:${a.username}`);
        if (s.admins) {
          const fresh = admins.filter((a) => !s.admins.includes(`${a.id}:${a.username}`));
          for (const a of fresh) found.push(`New administrator account: ${a.username} (${a.email || 'no email'}), registered ${a.registered_date || 'recently'}.`);
        }
        s.admins = ids;
      } catch (e) { if (e.blocked || e.paused) return null; s.adminError = e.message; }
    }
    try {
      const res = await guard.guardedFetch(site.url, { signal: AbortSignal.timeout(30000), headers: { accept: 'text/html' } }, { purpose: 'monitor' });
      const html = await res.text();
      const hidden = [...html.matchAll(/<(div|span|p)[^>]*style=["'][^"']*(display:\s*none|visibility:\s*hidden|left:\s*-\d{3,}px|font-size:\s*0)[^"']*["'][^>]*>([\s\S]{0,600}?)<\/\1>/gi)].filter((m) => /<a\s/i.test(m[3]) && SPAM.test(m[3]));
      if (hidden.length) found.push(`Hidden spam links on the homepage (${hidden.length}), a common sign of a hacked site.`);
      else if (SPAM.test(html.replace(/<script[\s\S]*?<\/script>/gi, ''))) found.push('Spam words (casino, pills, loans…) appear in the homepage HTML.');
      if (JAPANESE_HACK.test(html) && !/lang=["']?ja/i.test(html)) found.push('Long Japanese text on a non-Japanese homepage, a sign of the "Japanese keyword hack".');
      const scripts = [...new Set([...html.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map((m) => { try { return new URL(m[1], site.url).hostname; } catch { return ''; } }).filter(Boolean))];
      if (s.scriptHosts) {
        const added = scripts.filter((h) => !s.scriptHosts.includes(h) && h !== hostOf(site.url));
        if (added.length) found.push(`New third-party scripts loaded on the homepage: ${added.join(', ')}. Check they were added on purpose.`);
      }
      s.scriptHosts = scripts;
    } catch (e) { if (!(e.blocked || e.paused)) s.securityError = e.message; }
    s.security = { checkedAt: new Date().toISOString(), findings: found };
    if (found.length) {
      store.log('error', `${site.name} security: ${found.join(' ')}`);
      notify(`Security warning: ${site.name}`, found[0], { view: 'audits', tab: 'maintenance' });
      for (const f of found) addTask({ title: `Security: ${f.slice(0, 120)}`, siteId: site.id, priority: 'high', source: 'monitor', notes: f });
    }
    st()[`security:${site.id}`] = today();
    store.save();
    onChange();
    return s.security;
  }

  // ---------- contact form test (Contact Form 7) ----------
  async function formTest(site) {
    const c = cfg(site).formTest;
    if (!c.enabled || !c.formId) return null;
    const s = state(site.id);
    const fd = new FormData();
    const fields = { 'your-name': 'RCWriter form test', 'your-email': c.email || (d().googleUser && d().googleUser.email) || 'test@example.com', 'your-subject': 'Weekly form test (please ignore)', 'your-message': `Automatic weekly test from RCWriter at ${new Date().toISOString()}. No action needed.`, ...(c.extraFields || {}) };
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set('_wpcf7', String(c.formId));
    fd.set('_wpcf7_unit_tag', `wpcf7-f${c.formId}-o1`);
    let result;
    try {
      const res = await guard.guardedFetch(`${site.url}/wp-json/contact-form-7/v1/contact-forms/${encodeURIComponent(c.formId)}/feedback`, { method: 'POST', body: fd, signal: AbortSignal.timeout(45000) }, { purpose: 'monitor' });
      const j = await res.json().catch(() => ({}));
      result = { ok: j.status === 'mail_sent', status: j.status || `HTTP ${res.status}`, message: j.message || '' };
    } catch (e) { result = { ok: false, status: 'error', message: e.message }; }
    s.formTest = { ...result, at: new Date().toISOString() };
    if (!result.ok) {
      notify(`Contact form problem: ${site.name}`, `The weekly test said "${result.status}": ${result.message}`.slice(0, 250), { view: 'audits', tab: 'maintenance' });
      addTask({ title: `Fix the contact form on ${site.name} (${result.status})`, siteId: site.id, priority: 'high', source: 'monitor', notes: result.message });
    }
    st()[`form:${site.id}`] = today();
    store.save();
    onChange();
    return s.formTest;
  }

  // ---------- domain and email ----------
  async function domainEmail(site) {
    const host = hostOf(site.url);
    const parts = host.split('.');
    const root = parts.length > 2 && !/^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]) ? parts.slice(-2).join('.') : parts.length > 2 ? parts.slice(-3).join('.') : host;
    const out = { domain: root, checkedAt: new Date().toISOString(), problems: [] };
    try {
      const r = await fetch(`https://rdap.org/domain/${root}`, { headers: { accept: 'application/rdap+json' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const exp = (j.events || []).find((e) => e.eventAction === 'expiration');
      if (exp) { out.expires = exp.eventDate; out.daysLeft = Math.floor((new Date(exp.eventDate) - Date.now()) / DAY); }
      out.registrar = ((j.entities || []).find((e) => (e.roles || []).includes('registrar')) || {}).vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] || '';
    } catch (e) { out.rdapError = e.message; }
    const txt = async (name) => { try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; } };
    try { out.mx = (await dns.resolveMx(root)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange); } catch { out.mx = []; }
    out.spf = (await txt(root)).find((t) => /^v=spf1/i.test(t)) || null;
    out.dmarc = (await txt(`_dmarc.${root}`)).find((t) => /^v=DMARC1/i.test(t)) || null;
    out.dkim = [];
    for (const sel of DKIM_SELECTORS) { const t = (await txt(`${sel}._domainkey.${root}`)).find((x) => /v=DKIM1|k=rsa|p=/i.test(x)); if (t) out.dkim.push(sel); }
    if (out.daysLeft !== undefined && out.daysLeft <= 30) out.problems.push(`The domain ${root} expires in ${out.daysLeft} days (${new Date(out.expires).toLocaleDateString()}).`);
    if (out.mx.length && !out.spf) out.problems.push(`${root} has no SPF record, so its emails are more likely to land in spam.`);
    if (out.mx.length && !out.dmarc) out.problems.push(`${root} has no DMARC record. Google and Yahoo require one for bulk senders.`);
    if (out.dmarc && /p=none/i.test(out.dmarc)) out.notes = 'DMARC is in monitoring mode (p=none).';
    if (out.mx.length && !out.dkim.length) out.notes = `${out.notes ? `${out.notes} ` : ''}No DKIM key found on common selectors (it may use a custom one).`;
    const s = state(site.id);
    const before = (s.domain && s.domain.problems) || [];
    s.domain = out;
    const fresh = out.problems.filter((p) => !before.includes(p));
    if (fresh.length) {
      notify(`Domain or email issue: ${site.name}`, fresh[0], { view: 'audits', tab: 'maintenance' });
      for (const p of fresh) addTask({ title: p.slice(0, 140), siteId: site.id, priority: /expires/.test(p) ? 'high' : 'medium', source: 'monitor' });
    }
    st()[`domain:${site.id}`] = today();
    store.save();
    onChange();
    return out;
  }

  // ---------- speed trends ----------
  async function speed(site) {
    const urls = [site.url];
    if (site.google && site.google.gscSite && google.configured()) {
      try { const r = await google.gscPerformance(site.google.gscSite, { dimensions: ['page'], rowLimit: 5 }); urls.push(...r.rows.map((x) => x.keys[0]).filter((u) => u.replace(/\/$/, '') !== site.url.replace(/\/$/, '')).slice(0, 2)); } catch { /* homepage only */ }
    }
    const all = d().speed || (d().speed = {});
    const hist = all[site.id] || (all[site.id] = []);
    const alerts = [];
    for (const url of urls) {
      try {
        const p = await google.pagespeed(url, 'mobile');
        const lcp = parseFloat(String(p.lab.LCP || '').replace(/[^\d.]/g, '')) || null;
        const prev = [...hist].reverse().find((h) => h.url === url);
        hist.push({ date: today(), url, score: p.score, lcp, cls: p.lab.CLS, weight: p.lab.pageWeight });
        if (prev && prev.score !== null && p.score !== null && prev.score - p.score >= 10) alerts.push(`${url.replace(/^https?:\/\/[^/]+/, '') || '/'}: score ${prev.score} → ${p.score}`);
        else if (prev && prev.lcp && lcp && lcp > prev.lcp * 1.25 && lcp > 2.5) alerts.push(`${url.replace(/^https?:\/\/[^/]+/, '') || '/'}: LCP ${prev.lcp}s → ${lcp}s`);
      } catch (e) { state(site.id).speedError = e.message; }
    }
    if (hist.length > 300) hist.splice(0, hist.length - 300);
    if (alerts.length) {
      notify(`Slower pages: ${site.name}`, alerts.join('; ').slice(0, 250), { view: 'audits', tab: 'maintenance' });
      addTask({ title: `Speed dropped on ${site.name}: ${alerts[0]}`, siteId: site.id, priority: 'medium', source: 'monitor', notes: alerts.join('\n') });
    }
    st()[`speed:${site.id}`] = today();
    store.save();
    onChange();
    return hist.slice(-urls.length);
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
      if (s.type === 'webhook' || !(s.webdev && s.webdev.enabled)) continue;
      const c = cfg(s);
      if (c.updates && s.type === 'wordpress' && st()[`updates:${s.id}`] !== today() && now >= dueAt('06:30')) { st()[`updates:${s.id}`] = today(); once(`Update check:${s.id}`, () => checkUpdates(s)); }
      if (c.security && st()[`security:${s.id}`] !== today() && now >= dueAt('06:45')) { st()[`security:${s.id}`] = today(); once(`Security watch:${s.id}`, () => security(s)); }
      if (c.domain && st()[`domain:${s.id}`] !== today() && now >= dueAt('07:15')) { st()[`domain:${s.id}`] = today(); once(`Domain check:${s.id}`, () => domainEmail(s)); }
      if (c.speed && now.getDay() === 2 && st()[`speed:${s.id}`] !== today() && now >= dueAt('05:30')) { st()[`speed:${s.id}`] = today(); once(`Speed trend:${s.id}`, () => speed(s)); }
      if (c.formTest.enabled && now.getDay() === Number(c.formTest.day ?? 1) && st()[`form:${s.id}`] !== today() && now >= dueAt('10:30')) { st()[`form:${s.id}`] = today(); once(`Form test:${s.id}`, () => formTest(s)); }
    }
  }

  function status(siteId) {
    const s = (d().webdevState || {})[siteId] || {};
    const hist = ((d().speed || {})[siteId] || []);
    return { updates: s.updates || null, security: s.security || null, formTest: s.formTest || null, domain: s.domain || null, speed: hist.slice(-12) };
  }

  return { tick, checkUpdates, runUpdates, visualTools, snapshot, compare, security, formTest, domainEmail, speed, status, cmpVer };
}

module.exports = { createWebdev, cmpVer };
