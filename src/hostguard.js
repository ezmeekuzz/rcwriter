// Every request RCWriter makes directly to a website goes through here, so hosts
// see a slow, steady, honest visitor instead of a burst that their bot
// protection (SiteGround Anti-Bot, Cloudflare, Wordfence…) would flag.
//
// Per website:
//  - one request at a time, with a pause between requests (the site's pace)
//  - robots.txt Crawl-delay is respected when it asks for a longer pause
//  - repeated page checks within 30 minutes are served from memory
//  - a daily limit on audit requests
//  - if the host challenges RCWriter or says "too many requests", RCWriter stops
//    contacting it directly for a while (6h, then 12h, then 24h) instead of
//    retrying, which is what turns a short block into a long one
const { botBlock, BlockedError } = require('./botblock');

// A plain, honest product token. Some host firewalls (SiteGround among them)
// refuse the "Mozilla/5.0 (compatible; Bot/1.0)" format that scrapers use, so
// RCWriter names itself without pretending to be, or resembling, a browser.
let VERSION = '1.5';
try { VERSION = require('../package.json').version; } catch { /* keep default */ }
const UA = `RCWriter/${VERSION} (+https://github.com/ezmeekuzz/rcwriter)`;
const PACES = {
  normal: { label: 'Normal', gapMs: 800, auditPerDay: 600 },
  gentle: { label: 'Gentle', gapMs: 2000, auditPerDay: 250 },
  very: { label: 'Very gentle', gapMs: 5000, auditPerDay: 100 }
};
const CACHE_MS = 30 * 60 * 1000;
const COOLDOWNS_H = [6, 12, 24];
const HOUR = 36e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PausedError extends Error {
  constructor(host, st) {
    const until = new Date(st.pausedUntil);
    super(`RCWriter has paused direct requests to ${host} until ${until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}, because ${st.provider || 'the host'} ${st.provider === 'rate limit' ? 'asked it to slow down' : 'challenged it as a possible bot'}. This lets the block lift instead of getting longer. Use Search Console, PageSpeed, Ahrefs, Semrush or WPVibe data meanwhile, or click Resume on the Websites page if the host has whitelisted you.`);
    this.paused = { host, ...st };
  }
}

class BudgetError extends Error {
  constructor(host, limit) {
    super(`RCWriter has already made ${limit} audit requests to ${host} in the last 24 hours, its daily limit for this site's pace, so it won't contact the site directly again today. Use Search Console, PageSpeed, Ahrefs, Semrush or WPVibe data instead.`);
    this.budget = { host, limit };
  }
}

let store = null;
const mem = { hosts: {} };
const queues = new Map(); // host -> promise chain
const lastAt = new Map(); // host -> timestamp of last request
const robots = new Map(); // host -> { at, delayMs }
const cache = new Map(); // url -> { at, status, headers, body, finalUrl }

function init(s) { store = s; if (store && !store.data.hostState) store.data.hostState = {}; }
function state() { return store ? store.data.hostState || (store.data.hostState = {}) : mem.hosts; }
function save() { if (store) store.save(); }
const hostOf = (url) => { try { return new URL(url).host.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

function paceFor(host) {
  const site = store && (store.data.sites || []).find((s) => hostOf(s.url) === host);
  return PACES[(site && site.pace) || 'gentle'] || PACES.gentle;
}

function hostStatus(host) {
  const st = state()[host];
  if (!st) return null;
  const now = Date.now();
  const dayCount = (st.requests || []).filter((t) => now - t < 24 * HOUR).length;
  return { pausedUntil: st.pausedUntil && st.pausedUntil > now ? st.pausedUntil : null, provider: st.provider || null, reason: st.reason || null, auditRequests24h: dayCount };
}

function resume(host) {
  const st = state()[host];
  // Strike history stays: if the host challenges again straight away, the next
  // pause is longer. A successful request clears it.
  if (st) { delete st.pausedUntil; save(); }
}

function pause(host, provider, retryAfterSec) {
  const st = state()[host] || (state()[host] = {});
  const recent = st.lastStrikeAt && Date.now() - st.lastStrikeAt < 24 * HOUR;
  st.strikes = recent ? Math.min((st.strikes || 0) + 1, COOLDOWNS_H.length) : 1;
  st.lastStrikeAt = Date.now();
  const hours = COOLDOWNS_H[st.strikes - 1];
  const ms = Math.max(hours * HOUR, (Number(retryAfterSec) || 0) * 1000);
  st.pausedUntil = Date.now() + ms;
  st.provider = provider;
  st.reason = provider === 'rate limit' ? 'too many requests' : 'bot protection challenge';
  save();
  return st;
}

function countAudit(host) {
  const st = state()[host] || (state()[host] = {});
  const now = Date.now();
  st.requests = (st.requests || []).filter((t) => now - t < 24 * HOUR);
  st.requests.push(now);
  if (st.requests.length % 10 === 0) save();
}

function auditCount(host) {
  const st = state()[host];
  const now = Date.now();
  return st ? (st.requests || []).filter((t) => now - t < 24 * HOUR).length : 0;
}

// Reads robots.txt once a day per host for a Crawl-delay aimed at all bots or RCWriter.
async function crawlDelay(host, origin) {
  const r = robots.get(host);
  if (r && Date.now() - r.at < 24 * HOUR) return r.delayMs;
  robots.set(host, { at: Date.now(), delayMs: 0 });
  try {
    await wait(host);
    lastAt.set(host, Date.now());
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    const text = res.ok ? await res.text() : '';
    let applies = false;
    let delay = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (k === 'user-agent') applies = m[2] === '*' || /rcwriter/i.test(m[2]);
      else if (k === 'crawl-delay' && applies) delay = Math.max(delay, Math.min(60, Number(m[2]) || 0));
    }
    robots.set(host, { at: Date.now(), delayMs: delay * 1000 });
    return delay * 1000;
  } catch { return 0; }
}

async function wait(host) {
  const gap = paceFor(host).gapMs;
  const last = lastAt.get(host) || 0;
  const delta = Date.now() - last;
  if (delta < gap) await sleep(gap - delta);
}

// Runs fn(fetchFn) for one request to the host, in the host's queue.
function inQueue(host, fn) {
  const prev = queues.get(host) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(host, next.catch(() => {}));
  return next;
}

/**
 * fetch() with the guard. opts.purpose:
 *  'audit'   - site audits: pace, cache, daily limit, refuses while paused
 *  'connect' - the user clicked connect/test: pace only, always tries
 *  'publish' - writers publishing or reading posts: pace, refuses while paused
 */
async function guardedFetch(url, init = {}, { purpose = 'audit', cacheable = false } = {}) {
  const host = hostOf(url);
  if (!host) return fetch(url, init);
  const st = state()[host];
  if (purpose !== 'connect' && st && st.pausedUntil && st.pausedUntil > Date.now()) throw new PausedError(host, st);

  const method = (init.method || 'GET').toUpperCase();
  const key = `${method} ${url}`;
  if (cacheable && purpose === 'audit' && (method === 'GET' || method === 'HEAD')) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < CACHE_MS) return new Response(c.body, { status: c.status, headers: c.headers });
  }

  return inQueue(host, async () => {
    const st2 = state()[host];
    if (purpose !== 'connect' && st2 && st2.pausedUntil && st2.pausedUntil > Date.now()) throw new PausedError(host, st2);
    if (purpose === 'audit') {
      const limit = paceFor(host).auditPerDay;
      if (auditCount(host) >= limit) throw new BudgetError(host, limit);
    }
    const origin = new URL(url).origin;
    const extra = purpose === 'audit' ? await crawlDelay(host, origin) : 0;
    await wait(host);
    if (extra) {
      const since = Date.now() - (lastAt.get(host) || 0);
      if (since < extra) await sleep(extra - since);
    }
    lastAt.set(host, Date.now());
    if (purpose === 'audit') countAudit(host);

    const headers = new Headers(init.headers || {});
    headers.set('user-agent', UA); // set once, whatever the caller passed
    if (!headers.has('accept-language')) headers.set('accept-language', 'en');
    const res = await fetch(url, { ...init, headers });
    const suspicious = [202, 403, 429, 503].includes(res.status) || res.headers.get('sg-captcha') || res.headers.get('cf-mitigated');
    const calm = () => { const cur = state()[host]; if (cur && cur.strikes) { cur.strikes = 0; save(); } };
    if (!suspicious && !(cacheable && purpose === 'audit')) { calm(); return res; }
    const body = await res.text();
    const block = suspicious ? botBlock(res, body) : null;
    if (block) {
      const p = pause(host, block.provider, res.headers.get('retry-after'));
      const err = new BlockedError({ ...block, message: `${block.message} RCWriter has stopped contacting ${host} directly until ${new Date(p.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} so the block can lift.` });
      err.paused = { host, ...p };
      throw err;
    }
    if (!block) calm();
    const copy = { at: Date.now(), status: res.status, headers: [...res.headers.entries()], body };
    if (cacheable && purpose === 'audit' && res.status < 500) cache.set(key, copy);
    return new Response(body, { status: res.status, headers: copy.headers });
  });
}

function clearCache() { cache.clear(); }

// Pauses recorded under an older RCWriter identity were caused by that identity.
// Give each host a fresh start once with the current one.
function migrateIdentity() {
  if (!store || store.data.hostGuardUa === UA) return false;
  const had = Object.values(state()).some((st) => st.pausedUntil && st.pausedUntil > Date.now());
  for (const st of Object.values(state())) { delete st.pausedUntil; st.strikes = 0; }
  store.data.hostGuardUa = UA;
  save();
  return had;
}

module.exports = { init, migrateIdentity, guardedFetch, hostOf, hostStatus, resume, PACES, UA, PausedError, BudgetError, clearCache, _pause: pause };
