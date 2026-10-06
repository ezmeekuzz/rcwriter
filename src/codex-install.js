// Installs OpenAI's official Codex into RCWriter's own folder, so the ChatGPT
// subscription option works without Node.js or npm.
//
// Codex is published on npm as one package per platform. On Windows, codex.exe
// needs helper programs that sit next to it in that package (for example
// bin/codex-code-mode-host.exe, which runs connected tools, and
// codex-resources/codex-command-runner.exe), so the package's folder layout is
// kept exactly: <userData>/codex/vendor/<target>/...
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REGISTRY = 'https://registry.npmjs.org';
const SKIP = /\/codex-resources\/voice\//; // voice support isn't used by RCWriter

function target() {
  const a = process.arch;
  if (process.platform === 'win32') {
    if (a === 'x64') return { triple: 'x86_64-pc-windows-msvc', pkg: 'win32-x64' };
    if (a === 'arm64') return { triple: 'aarch64-pc-windows-msvc', pkg: 'win32-arm64' };
  }
  if (process.platform === 'darwin') {
    if (a === 'arm64') return { triple: 'aarch64-apple-darwin', pkg: 'darwin-arm64' };
    if (a === 'x64') return { triple: 'x86_64-apple-darwin', pkg: 'darwin-x64' };
  }
  if (process.platform === 'linux') {
    if (a === 'x64') return { triple: 'x86_64-unknown-linux-musl', pkg: 'linux-x64' };
    if (a === 'arm64') return { triple: 'aarch64-unknown-linux-musl', pkg: 'linux-arm64' };
  }
  throw new Error(`Codex isn't available for ${process.platform} on ${a}.`);
}

const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
const root = (userData) => path.join(userData, 'codex');
const tripleDir = (userData) => path.join(root(userData), 'vendor', target().triple);
const exePath = (userData) => path.join(tripleDir(userData), 'bin', exeName);

// Helpers that must exist next to codex for tools to work.
function missingHelpers(userData) {
  if (process.platform !== 'win32') return [];
  const dir = tripleDir(userData);
  return ['bin/codex-code-mode-host.exe', 'codex-resources/codex-command-runner.exe']
    .filter((rel) => !fs.existsSync(path.join(dir, rel)));
}

function installedPath(userData) {
  const p = exePath(userData);
  return fs.existsSync(p) && !missingHelpers(userData).length ? p : null;
}

// An older RCWriter installed only codex.exe, which can't run tools on Windows.
function needsRepair(userData) {
  const legacy = path.join(root(userData), exeName);
  return (fs.existsSync(legacy) || fs.existsSync(exePath(userData))) && !installedPath(userData);
}

// Streams a .tgz into destDir. Only entries under package/<keepPrefix> are written,
// with that prefix removed. Handles ustar prefixes, PAX and GNU long names.
function extractTgz(source, destDir, keepPrefix, onChunk = () => {}) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let buf = Buffer.alloc(0);
    let state = 'header';
    let remaining = 0;
    let pad = 0;
    let out = null;
    let longName = null;
    let paxPath = null;
    let collecting = null; // { kind: 'L'|'x', chunks: [] }
    let finished = false;
    let files = 0;
    const pending = [];

    const fail = (e) => { if (!finished) { finished = true; gunzip.destroy(); if (out) out.destroy(); reject(e); } };
    const resolveDest = (name) => {
      const clean = name.replace(/^\.?\//, '');
      if (!clean.startsWith(keepPrefix)) return null;
      const rel = clean.slice(keepPrefix.length);
      if (!rel || SKIP.test(`/${clean}`)) return null;
      const full = path.resolve(destDir, rel);
      if (!full.startsWith(path.resolve(destDir) + path.sep)) return null; // path traversal guard
      return full;
    };

    function pump() {
      while (!finished) {
        if (state === 'header') {
          if (buf.length < 512) return;
          const h = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (h.every((b) => b === 0)) { state = 'end'; continue; }
          const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
          const size = parseInt(str(124, 136).trim() || '0', 8);
          const type = String.fromCharCode(h[156] || 48);
          const prefix = str(345, 500);
          let name = longName || paxPath || (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
          longName = null; paxPath = null;
          const mode = parseInt(str(100, 108).trim() || '644', 8);
          remaining = size;
          pad = (512 - (size % 512)) % 512;
          if (type === 'L' || type === 'x') { collecting = { kind: type, chunks: [] }; state = 'data'; out = null; continue; }
          collecting = null;
          const dest = (type === '0' || type === '7') ? resolveDest(name) : null;
          if (dest) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            out = fs.createWriteStream(dest, { mode: (mode & 0o111) ? 0o755 : 0o644 });
            out.on('error', fail);
            pending.push(new Promise((r) => out.on('close', r)));
            files += 1;
          } else out = null;
          state = remaining > 0 ? 'data' : (pad ? 'pad' : 'header');
          if (remaining === 0 && out) { out.end(); out = null; }
        } else if (state === 'data') {
          if (!buf.length) return;
          const n = Math.min(remaining, buf.length);
          const chunk = buf.subarray(0, n);
          buf = buf.subarray(n);
          remaining -= n;
          if (collecting) collecting.chunks.push(Buffer.from(chunk));
          else if (out && !out.write(chunk)) { gunzip.pause(); out.once('drain', () => gunzip.resume()); }
          if (remaining === 0) {
            if (collecting) {
              const text = Buffer.concat(collecting.chunks).toString('utf8');
              if (collecting.kind === 'L') longName = text.replace(/\0.*$/s, '');
              else { const m = text.match(/\d+ path=([^\n]*)\n/); if (m) paxPath = m[1]; }
              collecting = null;
            } else if (out) { out.end(); out = null; }
            state = pad ? 'pad' : 'header';
          }
        } else if (state === 'pad') {
          if (buf.length < pad) return;
          buf = buf.subarray(pad);
          pad = 0;
          state = 'header';
        } else {
          buf = Buffer.alloc(0);
          return;
        }
      }
    }

    gunzip.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : Buffer.from(d); pump(); });
    gunzip.on('error', fail);
    gunzip.on('end', () => {
      if (finished) return;
      if (state === 'data' && remaining > 0) { fail(new Error('The download ended early. Try again.')); return; }
      finished = true;
      Promise.all(pending).then(() => resolve(files), reject);
    });

    (async () => {
      try {
        for await (const chunk of source) {
          if (finished) break;
          const copy = Buffer.from(chunk); // Electron's fetch may reuse chunk memory
          onChunk(copy.length);
          if (!gunzip.write(copy)) {
            await new Promise((r) => {
              const done = () => { gunzip.off('drain', done); gunzip.off('close', done); r(); };
              gunzip.on('drain', done);
              gunzip.on('close', done);
            });
          }
        }
        if (!finished) gunzip.end();
      } catch (e) { fail(e); }
    })();
  });
}

async function getJson(url) {
  let res;
  try { res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw new Error(`Couldn't reach the npm registry to download Codex: ${e.message}. Check your internet connection.`); }
  if (!res.ok) throw new Error(`Couldn't look up Codex (npm registry answered ${res.status}).`);
  return res.json();
}

async function install(userData, onProgress = () => {}) {
  const t = target();
  const latest = await getJson(`${REGISTRY}/@openai/codex/latest`);
  const meta = await getJson(`${REGISTRY}/@openai/codex/${encodeURIComponent(`${latest.version}-${t.pkg}`)}`);
  const url = meta.dist && meta.dist.tarball;
  if (!url) throw new Error(`OpenAI hasn't published Codex ${latest.version} for ${t.pkg}.`);

  const staging = path.join(userData, 'codex.new');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(45 * 60 * 1000) }); }
  catch (e) { throw new Error(`Couldn't download Codex: ${e.message}. Check your internet connection.`); }
  if (!res.ok || !res.body) throw new Error(`Couldn't download Codex (registry answered ${res.status}).`);
  const size = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPct = -1;
  try {
    await extractTgz(res.body, staging, 'package/', (n) => {
      received += n;
      const pct = size ? Math.floor((received / size) * 100) : null;
      if (pct !== lastPct) { lastPct = pct; onProgress({ received, total: size, pct }); }
    });
    const exe = path.join(staging, 'vendor', t.triple, 'bin', exeName);
    if (!fs.existsSync(exe)) throw new Error('The Codex download did not contain the program. Try again.');
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    fs.writeFileSync(path.join(staging, 'version.txt'), latest.version);
    fs.rmSync(root(userData), { recursive: true, force: true });
    fs.renameSync(staging, root(userData));
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const missing = missingHelpers(userData);
  if (missing.length) throw new Error(`Codex installed, but these helper files are missing: ${missing.join(', ')}. Try again, and check that antivirus software didn't remove them.`);
  return exePath(userData);
}

function uninstall(userData) {
  fs.rmSync(root(userData), { recursive: true, force: true });
}

module.exports = { install, uninstall, installedPath, needsRepair, missingHelpers, extractTgz, target, exePath };
