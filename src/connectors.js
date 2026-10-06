// Connectors: RCWriter talks to MCP servers (Ahrefs, Semrush, WPVibe, any
// other) itself, so it can hold the sign-ins and decide which tool calls the
// AI is allowed to make. Tokens are encrypted with the OS keychain via store.
const http = require('http');
const { shell } = require('electron');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');

const PRESETS = [
  { id: 'ahrefs', name: 'Ahrefs', url: 'https://api.ahrefs.com/mcp/mcp', auth: 'oauth',
    apiKey: { header: 'Authorization', prefix: 'Bearer ' },
    note: 'SEO data: backlinks, keywords, rankings, site audit. Needs an Ahrefs paid plan (Lite or higher).' },
  { id: 'semrush', name: 'Semrush', url: 'https://mcp.semrush.com/v2/mcp', auth: 'oauth',
    apiKey: { header: 'Authorization', prefix: 'Apikey ' },
    note: 'SEO and traffic data. Needs a Semrush plan with API units.' },
  { id: 'wpvibe', name: 'WPVibe', url: 'https://mcp.wpvibe.ai/mcp', auth: 'oauth',
    note: 'Reads and edits your WordPress sites: posts, pages, SEO fields, media, themes, plugins.' }
];

const CALLBACK_PORT = 43117;
const CALLBACK_PATH = '/oauth/callback';
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

// ---------- risk classification ----------
// read      : only looks at data; always allowed
// safe      : small, reversible changes; auto-run in "Auto-fix safe items"
// approval  : bigger or hard-to-undo changes; auto-run only in "Full autonomy"
// off       : never offered to the AI

const WRITE = new Set(['create', 'update', 'edit', 'write', 'delete', 'remove', 'trash', 'publish', 'schedule', 'set', 'add',
  'upload', 'install', 'activate', 'deactivate', 'replace', 'patch', 'moderate', 'assign', 'send', 'import', 'move', 'rename',
  'save', 'apply', 'reset', 'purge', 'clear', 'disconnect', 'connect', 'buy', 'post', 'put', 'modify', 'change', 'insert',
  'approve', 'reject', 'mark', 'label', 'unlabel', 'forward', 'reply', 'sync', 'generate', 'run', 'execute', 'manage',
  'untrash', 'unmark', 'share', 'copy', 'restore', 'enable', 'disable', 'start', 'stop', 'use']);
const DANGER = new Set(['delete', 'remove', 'trash', 'purge', 'install', 'activate', 'deactivate', 'plugin', 'plugins',
  'theme', 'themes', 'publish', 'cli', 'sql', 'db', 'code', 'snippet', 'file', 'buy', 'purchase', 'disconnect', 'connect',
  'reset', 'css', 'menu', 'settings', 'ability', 'fleet', 'run', 'execute', 'rest', 'write_file', 'user', 'users',
  'author', 'send', 'forward', 'share', 'manage', 'campaign', 'restore', 'disable', 'enable', 'schedule']);
const REPORTY = new Set(['report', 'reports', 'schema', 'query', 'search', 'research']);

function tokens(name) {
  return String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function classify(tool) {
  const a = tool.annotations || {};
  const t = tokens(tool.name);
  const isWriteVerb = t.some((w) => WRITE.has(w)) && !(t.some((w) => w === 'execute' || w === 'run') && t.some((w) => REPORTY.has(w)) && !t.some((w) => WRITE.has(w) && w !== 'execute' && w !== 'run'));
  const readVerb = t.some((w) => ['get', 'list', 'read', 'search', 'fetch', 'find', 'view', 'show', 'check'].includes(w));
  const powerful = t.some((w) => ['code', 'snippet', 'sql', 'cli', 'db', 'shell', 'exec', 'eval', 'rest', 'graphql', 'query_db'].includes(w));
  if (powerful && !readVerb) return 'approval'; // generic "do anything" tools
  if (a.readOnlyHint === true && !isWriteVerb) return 'read';
  if (a.destructiveHint === true) return 'approval';
  if (!isWriteVerb && a.readOnlyHint !== false) return 'read';
  if (t.some((w) => DANGER.has(w))) return 'approval';
  if (/rest_api|wp_cli|write_file|edit_file|delete_file/.test(tool.name)) return 'approval';
  return 'safe';
}

// ---------- OAuth ----------

class Provider {
  constructor(store, conn) { this.store = store; this.conn = conn; this.pendingUrl = null; }
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() {
    return { client_name: 'RCWriter', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() { return this.conn.oauthState || (this.conn.oauthState = Math.random().toString(36).slice(2)); }
  async clientInformation() { return this.read('client'); }
  async saveClientInformation(info) { this.write('client', info); }
  async tokens() { return this.read('tokens'); }
  async saveTokens(tok) { this.write('tokens', tok); this.conn.signedInAt = new Date().toISOString(); }
  async redirectToAuthorization(url) { this.pendingUrl = url.toString(); }
  async saveCodeVerifier(v) { this.conn.codeVerifier = v; }
  async codeVerifier() { if (!this.conn.codeVerifier) throw new Error('Sign-in expired. Try again.'); return this.conn.codeVerifier; }
  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'client') delete this.conn.oauthClient;
    if (scope === 'all' || scope === 'tokens') delete this.conn.oauthTokens;
    if (scope === 'all' || scope === 'verifier') delete this.conn.codeVerifier;
    this.store.save();
  }
  read(kind) {
    const v = this.conn[kind === 'client' ? 'oauthClient' : 'oauthTokens'];
    if (!v) return undefined;
    try { return JSON.parse(this.store.decrypt(v)); } catch { return undefined; }
  }
  write(kind, obj) {
    this.conn[kind === 'client' ? 'oauthClient' : 'oauthTokens'] = this.store.encrypt(JSON.stringify(obj));
    this.store.save();
  }
}

function waitForCallback(timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>RCWriter</title><body style="font:16px system-ui;padding:48px;text-align:center;color:#1C2340">
        <h2>${code ? 'Connected to RCWriter' : 'Sign-in was not completed'}</h2><p>You can close this tab and go back to RCWriter.</p></body>`);
      clearTimeout(timer);
      server.close();
      if (code) resolve(code); else reject(new Error(err ? `Sign-in failed: ${err}` : 'Sign-in was cancelled.'));
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out. Try again.')); }, timeoutMs);
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'EADDRINUSE' ? `Another sign-in is in progress (port ${CALLBACK_PORT} is busy). Finish or close it and try again.` : e.message));
    });
    server.listen(CALLBACK_PORT, '127.0.0.1');
  });
}

// ---------- manager ----------

function createConnectors(store) {
  const live = new Map(); // connectorId -> { client, transport }

  function headersFor(conn) {
    const h = { ...(conn.headers || {}) };
    if (conn.auth === 'apikey' && conn.secret) {
      const key = store.decrypt(conn.secret);
      if (key) h[conn.keyHeader || 'Authorization'] = `${conn.keyPrefix ?? 'Bearer '}${key}`;
    }
    return h;
  }

  function makeTransport(conn, kind, provider) {
    const url = new URL(conn.url);
    const opts = { requestInit: { headers: headersFor(conn) } };
    if (conn.auth === 'oauth') opts.authProvider = provider;
    return kind === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
  }

  async function open(conn, { interactive = false } = {}) {
    const existing = live.get(conn.id);
    if (existing) return existing.client;
    const provider = new Provider(store, conn);
    let lastErr;
    for (const kind of conn.transport === 'sse' ? ['sse'] : ['http', 'sse']) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = new Client({ name: 'RCWriter', version: '1.3.0' }, { capabilities: {} });
        const transport = makeTransport(conn, kind, provider);
        try {
          await client.connect(transport);
          live.set(conn.id, { client, transport });
          if (kind === 'sse') conn.transport = 'sse';
          return client;
        } catch (e) {
          lastErr = e;
          try { await client.close(); } catch { /* ignore */ }
          const unauthorized = e instanceof UnauthorizedError || /unauthori[sz]ed|401/i.test(String(e && e.message));
          if (unauthorized && conn.auth === 'oauth') {
            if (!interactive || !provider.pendingUrl) {
              throw new Error(`${conn.name} needs you to sign in again. Open Site Audits, Connections, and click Sign in.`);
            }
            const waiting = waitForCallback();
            await shell.openExternal(provider.pendingUrl);
            const code = await waiting;
            await transport.finishAuth(code);
            provider.pendingUrl = null;
            continue; // reconnect with the new tokens
          }
          if (unauthorized) throw new Error(`${conn.name} rejected the API key. Check it and save it again.`);
          break; // try the next transport
        }
      }
    }
    throw new Error(`Couldn't connect to ${conn.name}: ${String(lastErr && lastErr.message || lastErr).slice(0, 200)}`);
  }

  async function close(id) {
    const c = live.get(id);
    live.delete(id);
    if (c) { try { await c.client.close(); } catch { /* ignore */ } }
  }

  async function closeAll() { await Promise.all([...live.keys()].map(close)); }

  async function listTools(conn, { interactive = false } = {}) {
    const client = await open(conn, { interactive });
    const out = [];
    let cursor;
    do {
      const r = await client.listTools(cursor ? { cursor } : {});
      out.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor);
    const prev = new Map((conn.tools || []).map((t) => [t.name, t]));
    conn.tools = out.map((t) => {
      const auto = classify(t);
      const old = prev.get(t.name);
      return {
        name: t.name,
        title: t.title || (t.annotations && t.annotations.title) || '',
        description: String(t.description || '').slice(0, 1500),
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        annotations: t.annotations || null,
        auto,
        risk: old && old.userSet ? old.risk : auto,
        userSet: !!(old && old.userSet)
      };
    });
    conn.toolsAt = new Date().toISOString();
    conn.lastError = null;
    store.save();
    return conn.tools;
  }

  async function callTool(conn, name, args) {
    const client = await open(conn);
    const r = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 5 * 60 * 1000 });
    const parts = [];
    for (const c of r.content || []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'resource' && c.resource && c.resource.text) parts.push(c.resource.text);
      else if (c.type === 'image') parts.push('[image]');
      else parts.push(JSON.stringify(c).slice(0, 2000));
    }
    if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join('\n'), isError: !!r.isError };
  }

  async function signOut(conn) {
    await close(conn.id);
    delete conn.oauthTokens;
    delete conn.oauthClient;
    delete conn.codeVerifier;
    delete conn.signedInAt;
    store.save();
  }

  return { open, close, closeAll, listTools, callTool, signOut };
}

module.exports = { PRESETS, classify, createConnectors, REDIRECT };
