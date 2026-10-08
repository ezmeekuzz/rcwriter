// Your own Google account, signed in with your Google Cloud OAuth client, for
// Gmail (read client emails, create drafts, send the digest to yourself) and
// Google Business Profile (reviews and posts). Separate from the Search Console
// connection, which may use a service account.
const crypto = require('crypto');
const http = require('http');

const FEATURE_SCOPES = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  gbp: ['https://www.googleapis.com/auth/business.manage']
};
const TOKEN = 'https://oauth2.googleapis.com/token';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function htmlToText(h) {
  return String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// Removes quoted earlier messages so the AI reads only what the client just wrote.
function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^On .{5,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From: .+/.test(l) && out.length > 3) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

function createGoogleUser({ store, openExternal }) {
  let cached = null;
  const cfg = () => store.data.googleUser || (store.data.googleUser = {});

  async function postForm(params) {
    const res = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}`);
    return j;
  }

  const connected = () => !!cfg().tokens;
  const has = (feature) => connected() && (FEATURE_SCOPES[feature] || []).every((s) => (cfg().scopes || []).includes(s));

  async function token() {
    if (cached && cached.exp > Date.now() + 60000) return cached.token;
    const g = cfg();
    if (!g.tokens) throw new Error('Sign in with Google in Settings, Gmail and Business Profile.');
    const tok = JSON.parse(store.decrypt(g.tokens) || '{}');
    const j = await postForm({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: g.clientId, client_secret: store.decrypt(g.clientSecret) });
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return cached.token;
  }

  async function api(url, { method = 'GET', body } = {}) {
    const t = await token();
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) {
      const msg = (j && j.error && (j.error.message || j.error.status)) || text.slice(0, 200);
      if (res.status === 429 || /quota/i.test(msg)) throw new Error(`Google limit reached: ${msg}${/mybusiness/.test(url) ? ' Business Profile APIs start with no quota until Google approves your project (Business Profile API access request).' : ''}`);
      throw new Error(`Google ${res.status}: ${msg}`);
    }
    return j || {};
  }

  function waitForCode(port, state) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        if (u.searchParams.get('state') !== state) { res.writeHead(400); res.end(); return; }
        const code = u.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:48px;text-align:center;color:#1C2340"><h2>${code ? 'Your Google account is connected to RCWriter' : 'Google sign-in was not completed'}</h2><p>You can close this tab.</p>`);
        clearTimeout(timer); server.close();
        if (code) resolve(code); else reject(new Error(`Google sign-in cancelled: ${u.searchParams.get('error') || ''}`));
      });
      const timer = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out.')); }, 5 * 60000);
      server.on('error', reject);
      server.listen(port, '127.0.0.1');
    });
  }

  async function signIn(clientId, clientSecret, features = ['gmail']) {
    clientId = String(clientId || '').trim() || cfg().clientId;
    clientSecret = String(clientSecret || '').trim() || (cfg().clientSecret ? store.decrypt(cfg().clientSecret) : '');
    if (!clientId || !clientSecret) throw new Error('Enter your Google OAuth client ID and secret.');
    const scopes = ['openid', 'email', ...features.flatMap((f) => FEATURE_SCOPES[f] || [])];
    const port = 43000 + Math.floor(Math.random() * 900);
    const redirect = `http://127.0.0.1:${port}`;
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(12));
    const u = new URL(AUTH);
    Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent',
      include_granted_scopes: 'true', code_challenge: challenge, code_challenge_method: 'S256', state }).forEach(([k, v]) => u.searchParams.set(k, v));
    const waiting = waitForCode(port, state);
    await openExternal(u.toString());
    const code = await waiting;
    const tok = await postForm({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: clientSecret, code_verifier: verifier });
    if (!tok.refresh_token) throw new Error('Google did not return a long-term sign-in. Remove RCWriter from your Google account permissions and try again.');
    let email = '';
    try { email = JSON.parse(Buffer.from(String(tok.id_token || '').split('.')[1] || '', 'base64').toString()).email || ''; } catch { /* none */ }
    Object.assign(cfg(), { clientId, clientSecret: store.encrypt(clientSecret), tokens: store.encrypt(JSON.stringify({ refresh_token: tok.refresh_token })), email,
      scopes: String(tok.scope || scopes.join(' ')).split(' ').filter(Boolean), at: new Date().toISOString() });
    cached = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 };
    store.save();
    return status();
  }

  function disconnect() {
    const g = cfg();
    store.data.googleUser = { clientId: g.clientId || '' };
    cached = null;
    store.save();
  }

  function status() {
    const g = cfg();
    return { connected: connected(), email: g.email || '', gmail: has('gmail'), gbp: has('gbp'), clientId: g.clientId || '', gbpLocations: g.gbpLocations || null };
  }

  // ---------- Gmail ----------
  function parseMessage(m) {
    const headers = Object.fromEntries(((m.payload && m.payload.headers) || []).map((h) => [h.name.toLowerCase(), h.value]));
    let plain = '';
    let html = '';
    const walk = (p) => {
      if (!p) return;
      if (p.mimeType === 'text/plain' && p.body && p.body.data && !plain) plain = fromB64url(p.body.data).toString('utf8');
      else if (p.mimeType === 'text/html' && p.body && p.body.data && !html) html = fromB64url(p.body.data).toString('utf8');
      (p.parts || []).forEach(walk);
    };
    walk(m.payload);
    const text = stripQuoted(plain || htmlToText(html) || m.snippet || '');
    return { id: m.id, threadId: m.threadId, from: headers.from || '', to: headers.to || '', subject: headers.subject || '(no subject)', date: headers.date || '',
      messageId: headers['message-id'] || '', references: headers.references || '', snippet: m.snippet || '', text: text.slice(0, 12000), labels: m.labelIds || [] };
  }

  async function searchMessages(q, max = 20) {
    const j = await api(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(Math.min(100, max)) })}`);
    const out = [];
    for (const m of j.messages || []) out.push(parseMessage(await api(`${GMAIL}/messages/${m.id}?format=full`)));
    return out;
  }

  async function getMessage(id) { return parseMessage(await api(`${GMAIL}/messages/${id}?format=full`)); }

  function mime({ to, subject, text, html, inReplyTo, references, from }) {
    const boundary = `rcw${crypto.randomBytes(8).toString('hex')}`;
    const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
    const head = [from ? `From: ${from}` : null, `To: ${to}`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0',
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null, inReplyTo ? `References: ${[references, inReplyTo].filter(Boolean).join(' ')}` : null].filter(Boolean);
    if (!html) return `${head.join('\r\n')}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString('base64')}`;
    return `${head.join('\r\n')}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString('base64')}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString('base64')}\r\n--${boundary}--`;
  }

  async function createDraft(msg) {
    const raw = b64url(mime(msg));
    const j = await api(`${GMAIL}/drafts`, { method: 'POST', body: { message: { raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) } } });
    return { id: j.id, messageId: j.message && j.message.id, url: 'https://mail.google.com/mail/u/0/#drafts' };
  }

  async function send(msg) {
    const j = await api(`${GMAIL}/messages/send`, { method: 'POST', body: { raw: b64url(mime(msg)), ...(msg.threadId ? { threadId: msg.threadId } : {}) } });
    return { id: j.id, threadId: j.threadId };
  }

  async function threadReplies(threadId) {
    const j = await api(`${GMAIL}/threads/${threadId}?format=metadata&metadataHeaders=From`);
    return (j.messages || []).map((m) => ({ id: m.id, from: ((m.payload && m.payload.headers) || []).find((h) => h.name === 'From')?.value || '', labels: m.labelIds || [] }));
  }

  // ---------- Business Profile ----------
  async function gbpLocations() {
    const accounts = (await api('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')).accounts || [];
    const out = [];
    for (const a of accounts) {
      let pageToken = '';
      do {
        const j = await api(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,storefrontAddress,websiteUri&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const l of j.locations || []) out.push({ id: `${a.name}/${l.name}`, name: `${l.title}${l.storefrontAddress && l.storefrontAddress.locality ? `, ${l.storefrontAddress.locality}` : ''}`, website: l.websiteUri || '' });
        pageToken = j.nextPageToken || '';
      } while (pageToken);
    }
    cfg().gbpLocations = { list: out, at: new Date().toISOString() };
    store.save();
    return out;
  }

  async function gbpReviews(location) {
    const j = await api(`https://mybusiness.googleapis.com/v4/${location}/reviews?pageSize=50&orderBy=updateTime desc`);
    const stars = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    return (j.reviews || []).map((r) => ({ name: r.name, id: r.reviewId, author: (r.reviewer && r.reviewer.displayName) || 'A customer', rating: stars[r.starRating] || null,
      comment: r.comment || '', created: r.createTime, replied: !!(r.reviewReply && r.reviewReply.comment), reply: r.reviewReply ? r.reviewReply.comment : '' }));
  }

  const gbpReply = (reviewName, comment) => api(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, { method: 'PUT', body: { comment } });
  const gbpDeleteReply = (reviewName) => api(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, { method: 'DELETE' });

  async function gbpPost(location, { summary, url, imageUrl }) {
    const body = { languageCode: 'en', summary: String(summary).slice(0, 1500), topicType: 'STANDARD' };
    if (url) body.callToAction = { actionType: 'LEARN_MORE', url };
    if (imageUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }];
    return api(`https://mybusiness.googleapis.com/v4/${location}/localPosts`, { method: 'POST', body });
  }
  const gbpDeletePost = (postName) => api(`https://mybusiness.googleapis.com/v4/${postName}`, { method: 'DELETE' });

  return { FEATURE_SCOPES, connected, has, status, signIn, disconnect, api, searchMessages, getMessage, createDraft, send, threadReplies,
    gbpLocations, gbpReviews, gbpReply, gbpDeleteReply, gbpPost, gbpDeletePost, _reset: () => { cached = null; } };
}

module.exports = { createGoogleUser, htmlToText, stripQuoted, FEATURE_SCOPES };
