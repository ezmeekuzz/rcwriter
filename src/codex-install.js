// Downloads OpenAI's official Codex release for this computer and unpacks it
// into RCWriter's own folder, so the ChatGPT subscription option works
// without Node.js or npm.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const BASE = 'https://github.com/openai/codex/releases/latest/download/';

function assetName() {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`Codex isn't available for this processor (${process.arch}).`);
  if (process.platform === 'win32') return `codex-${arch}-pc-windows-msvc.exe.tar.gz`;
  if (process.platform === 'darwin') return `codex-${arch}-apple-darwin.tar.gz`;
  if (process.platform === 'linux') return `codex-${arch}-unknown-linux-musl.tar.gz`;
  throw new Error(`Codex isn't available for ${process.platform}.`);
}

function targetPath(userData) {
  return path.join(userData, 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex');
}

function installedPath(userData) {
  const p = targetPath(userData);
  return fs.existsSync(p) ? p : null;
}

// Reads a .tar.gz from an async iterable of chunks and writes out the first
// regular file it contains. Each chunk is copied, because Electron's fetch can
// reuse chunk memory before zlib has finished with it.
function extractFirstFile(source, outPath, onChunk = () => {}) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let buf = Buffer.alloc(0);
    let state = 'header';
    let remaining = 0;
    let skip = 0;
    let out = null;
    let finished = false;

    const fail = (e) => { if (!finished) { finished = true; gunzip.destroy(); if (out) out.destroy(); reject(e); } };

    function pump() {
      while (!finished) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length);
          buf = buf.subarray(n); skip -= n;
          if (skip > 0) return;
        }
        if (state === 'header') {
          if (buf.length < 512) return;
          const h = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (h.every((b) => b === 0)) { fail(new Error('The download was empty.')); return; }
          const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
          const type = String.fromCharCode(h[156]);
          const padded = Math.ceil(size / 512) * 512;
          if (type === '0' || h[156] === 0) {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            out = fs.createWriteStream(outPath, { mode: 0o755 });
            out.on('error', fail);
            remaining = size;
            state = 'data';
          } else {
            skip = padded; // PAX headers, directories, long names
          }
        } else if (state === 'data') {
          if (!buf.length) return;
          const n = Math.min(remaining, buf.length);
          const chunk = buf.subarray(0, n);
          buf = buf.subarray(n);
          remaining -= n;
          if (!out.write(chunk)) { gunzip.pause(); out.once('drain', () => gunzip.resume()); }
          if (remaining === 0) {
            finished = true;
            gunzip.destroy();
            out.end(() => resolve());
            return;
          }
        }
      }
    }

    gunzip.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : Buffer.from(d); pump(); });
    gunzip.on('error', fail);
    gunzip.on('end', () => { if (!finished) fail(new Error('The download ended early. Try again.')); });

    (async () => {
      try {
        for await (const chunk of source) {
          if (finished) break;
          const copy = Buffer.from(chunk); // copies the bytes
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

async function install(userData, onProgress = () => {}) {
  const asset = assetName();
  const dest = targetPath(userData);
  const tmp = `${dest}.download`;
  let res;
  try {
    res = await fetch(BASE + asset, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
  } catch (e) {
    throw new Error(`Couldn't download Codex: ${e.message}. Check your internet connection.`);
  }
  if (!res.ok || !res.body) throw new Error(`Couldn't download Codex (GitHub answered ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastPct = -1;
  const onChunk = (n) => {
    received += n;
    const pct = total ? Math.floor((received / total) * 100) : null;
    if (pct !== lastPct) { lastPct = pct; onProgress({ received, total, pct }); }
  };
  try {
    await extractFirstFile(res.body, tmp, onChunk);
    fs.renameSync(tmp, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return dest;
}

function uninstall(userData) {
  fs.rmSync(path.join(userData, 'codex'), { recursive: true, force: true });
}

module.exports = { install, uninstall, installedPath, assetName, extractFirstFile, tmpdir: os.tmpdir };
