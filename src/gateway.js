// Minimal MCP server (stdio, newline-delimited JSON-RPC) that Codex launches
// during a ChatGPT-subscription audit. It has no tools of its own: every list
// and call is forwarded to RCWriter, which applies the job's autonomy level.
// Runs with ELECTRON_RUN_AS_NODE=1 and needs no packages.
const http = require('http');
const readline = require('readline');

const BRIDGE = process.env.RCW_BRIDGE;
const TOKEN = process.env.RCW_TOKEN;

function bridge(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const u = new URL(path, BRIDGE);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error(`Bad reply from RCWriter: ${buf.slice(0, 200)}`)); } });
    });
    req.on('error', reject);
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('RCWriter did not answer in time.')));
    req.end(data);
  });
}

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rcwriter', version: '1.3.0' },
        instructions: 'Tools for auditing and maintaining the website in this job. RCWriter decides which actions are allowed.'
      } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      const r = await bridge('/list');
      send({ jsonrpc: '2.0', id, result: { tools: r.tools || [] } });
    } else if (method === 'tools/call') {
      const r = await bridge('/call', { name: params && params.name, arguments: (params && params.arguments) || {} });
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(r.text || '') }], isError: !!r.isError } });
    } else if (method === 'resources/list' || method === 'prompts/list' || method === 'resources/templates/list') {
      const key = method.split('/')[0] === 'resources' ? (method.includes('templates') ? 'resourceTemplates' : 'resources') : 'prompts';
      send({ jsonrpc: '2.0', id, result: { [key]: [] } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e && e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
});
rl.on('close', () => process.exit(0));
