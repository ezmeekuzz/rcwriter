// Publishing targets.
// WordPress: uses the built-in REST API with an Application Password. The user
//   approves RCWriter on their own wp-admin page (no plugin needed, WP 5.6+).
// Webhook: POSTs the article as JSON to any URL (Zapier, Make, n8n, Ghost
//   automations, a custom endpoint), optionally signed with HMAC-SHA256.
const crypto = require('crypto');
const { renderMarkdown, stripFrontMatter } = require('./renderer/markdown.js');

const APP_ID = 'fe89e50f-5c34-4cb1-98b5-b1b442ae206c';

function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) throw new Error('Enter your website address.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const url = new URL(s);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function fetchJson(url, opts = {}) {
  let res, text;
  try {
    res = await fetch(url, { ...opts, redirect: 'follow', signal: AbortSignal.timeout(60000) });
    text = await res.text();
  } catch (e) {
    throw new Error(`Could not reach the website (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
}

// ---------- WordPress ----------

function wpUrl(base, route, query = {}, mode = 'pretty') {
  const qs = new URLSearchParams(query).toString();
  if (mode === 'pretty') return `${base}/wp-json${route}${qs ? `?${qs}` : ''}`;
  return `${base}/?rest_route=${encodeURIComponent(route)}${qs ? `&${qs}` : ''}`;
}

async function wpRequest(site, auth, route, { method = 'GET', query = {}, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
  if (body) headers['Content-Type'] = 'application/json';
  const modes = site.restMode ? [site.restMode] : ['pretty', 'plain'];
  let last;
  for (const mode of modes) {
    const { res, json, text } = await fetchJson(wpUrl(site.url, route, query, mode), { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.ok && json !== null) { site.restMode = mode; return json; }
    last = { res, json, text };
    if (res.status !== 404 || (json && json.code && json.code !== 'rest_no_route')) break;
  }
  const { res, json } = last;
  if (res.status === 401 || res.status === 403) {
    const code = json && json.code;
    if (code === 'rest_cannot_create') throw new Error('This WordPress user isn\'t allowed to publish posts. Connect with an Editor or Administrator account.');
    throw new Error('WordPress rejected the login. Reconnect the site. If it keeps happening, your host or a security plugin may be blocking the "Authorization" header.');
  }
  const msg = (json && (json.message || json.code)) || `HTTP ${res.status}`;
  throw new Error(`WordPress said: ${String(msg).replace(/<[^>]+>/g, '')}`);
}

async function wpDiscover(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const site = { url };
  let root;
  try { root = await wpRequest(site, null, '/'); }
  catch { throw new Error('That doesn\'t look like a WordPress site, or its REST API is turned off. Check the address.'); }
  const ap = root.authentication && root.authentication['application-passwords'];
  return {
    url: (root.home || url).replace(/\/+$/, '') || url,
    name: root.name || new URL(url).host,
    restMode: site.restMode,
    authUrl: (ap && ap.endpoints && ap.endpoints.authorization) || `${url}/wp-admin/authorize-application.php`,
    appPasswordsAvailable: !!ap
  };
}

function wpAuthorizeUrl(authUrl, state) {
  const success = `rcwriter://wp-auth?state=${state}`;
  const reject = `rcwriter://wp-auth?state=${state}&rejected=1`;
  const u = new URL(authUrl);
  u.searchParams.set('app_name', 'RCWriter');
  u.searchParams.set('app_id', APP_ID);
  u.searchParams.set('success_url', success);
  u.searchParams.set('reject_url', reject);
  return u.toString();
}

async function wpVerify(site, auth) {
  const me = await wpRequest(site, auth, '/wp/v2/users/me', { query: { context: 'edit' } });
  const caps = me.capabilities || {};
  return { userName: me.name || me.slug || auth.user, canPublish: caps.publish_posts !== false };
}

async function wpTermIds(site, auth, taxonomy, names) {
  const ids = [];
  for (const name of names) {
    try {
      const found = await wpRequest(site, auth, `/wp/v2/${taxonomy}`, { query: { search: name, per_page: 50 } });
      const hit = (found || []).find((t) => String(t.name).toLowerCase() === name.toLowerCase());
      if (hit) { ids.push(hit.id); continue; }
      const created = await wpRequest(site, auth, `/wp/v2/${taxonomy}`, { method: 'POST', body: { name } });
      ids.push(created.id);
    } catch { /* skip terms we can't read or create */ }
  }
  return ids;
}

// ---------- shared ----------

function splitArticle(fileText) {
  let body = stripFrontMatter(fileText).trim();
  let excerpt = '';
  const meta = body.match(/\n-{3,}\s*\n+\s*\**meta description:?\**\s*(.+?)\s*$/i);
  if (meta) { excerpt = meta[1].trim(); body = body.slice(0, meta.index).trim(); }
  let title = '';
  const h1 = body.match(/^\s*#\s+(.+)\n?/);
  if (h1) { title = h1[1].replace(/[*_`]/g, '').trim(); body = body.slice(h1[0].length).trim(); }
  const html = renderMarkdown(body).replace(/ data-external/g, '');
  return { title, markdown: body, html, excerpt };
}

function splitList(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

async function publish(site, secret, article, fileText, { status = 'draft', categories = '', tags = '' } = {}) {
  const parts = splitArticle(fileText);
  const title = parts.title || article.title;

  if (site.type === 'wordpress') {
    const auth = { user: site.username, pass: secret };
    const body = { title, content: parts.html, status: ['draft', 'pending', 'publish', 'private'].includes(status) ? status : 'draft' };
    if (parts.excerpt) body.excerpt = parts.excerpt;
    const cats = await wpTermIds(site, auth, 'categories', splitList(categories));
    const tgs = await wpTermIds(site, auth, 'tags', splitList(tags));
    if (cats.length) body.categories = cats;
    if (tgs.length) body.tags = tgs;
    const post = await wpRequest(site, auth, '/wp/v2/posts', { method: 'POST', body });
    return { remoteId: post.id, url: post.link, editUrl: `${site.url}/wp-admin/post.php?post=${post.id}&action=edit`, status: post.status };
  }

  if (site.type === 'webhook') {
    const payload = JSON.stringify({
      event: 'article.created',
      status,
      title,
      excerpt: parts.excerpt,
      markdown: parts.markdown,
      html: parts.html,
      writer: article.writerName,
      topic: article.topic,
      model: article.model,
      words: article.words,
      createdAt: article.createdAt,
      categories: splitList(categories),
      tags: splitList(tags)
    });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'RCWriter' };
    if (secret) headers['X-RCWriter-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    const { res, json, text } = await fetchJson(site.url, { method: 'POST', headers, body: payload });
    if (!res.ok) throw new Error(`The webhook answered ${res.status}: ${(text || '').slice(0, 200)}`);
    return { remoteId: (json && json.id) || null, url: (json && (json.url || json.link)) || null, status: 'sent' };
  }

  throw new Error('Unknown website type.');
}

async function test(site, secret) {
  if (site.type === 'url') {
    const { res } = await fetchJson(site.url, { method: 'GET' });
    if (res.status >= 400) throw new Error(`The website answered ${res.status}.`);
    return { userName: null, canPublish: false };
  }
  if (site.type === 'wordpress') return wpVerify(site, { user: site.username, pass: secret });
  if (site.type === 'webhook') {
    const payload = JSON.stringify({ event: 'test', message: 'RCWriter connection test' });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'RCWriter' };
    if (secret) headers['X-RCWriter-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    const { res } = await fetchJson(site.url, { method: 'POST', headers, body: payload });
    if (!res.ok) throw new Error(`The webhook answered ${res.status}.`);
    return { userName: null, canPublish: true };
  }
  throw new Error('Unknown website type.');
}

module.exports = { normalizeUrl, wpDiscover, wpAuthorizeUrl, wpVerify, wpRequest, publish, test, splitArticle };
