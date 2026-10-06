// App password. Only a salted scrypt hash is stored (lock.json in the user-data
// folder). The Windows installer can pass a password chosen during setup via a
// one-time file, which is hashed and deleted on first launch.
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
let failures = 0;
let blockedUntil = 0;

const lockFile = () => path.join(app.getPath('userData'), 'lock.json');
const setupFile = () => path.join(app.getPath('userData'), 'setup-password.txt');

function derive(password, salt, p = PARAMS) {
  return crypto.scryptSync(String(password).normalize('NFC'), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 128 * p.N * p.r * 2 });
}

function read() {
  try { return JSON.parse(fs.readFileSync(lockFile(), 'utf8')); } catch { return null; }
}

function isSet() {
  const d = read();
  return !!(d && d.hash && d.salt);
}

function validateNew(password) {
  if (typeof password !== 'string' || password.length < 6) throw new Error('Use at least 6 characters.');
  if (password.length > 200) throw new Error('That password is too long.');
}

function set(password) {
  validateNew(password);
  const salt = crypto.randomBytes(16);
  const hash = derive(password, salt);
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), JSON.stringify({ v: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), params: PARAMS, setAt: new Date().toISOString() }));
}

function verify(password) {
  const now = Date.now();
  if (now < blockedUntil) {
    const s = Math.ceil((blockedUntil - now) / 1000);
    throw new Error(`Too many wrong attempts. Try again in ${s} second${s === 1 ? '' : 's'}.`);
  }
  const d = read();
  if (!d) return true;
  const expected = Buffer.from(d.hash, 'base64');
  const actual = derive(password || '', Buffer.from(d.salt, 'base64'), d.params || PARAMS);
  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (ok) { failures = 0; return true; }
  failures += 1;
  if (failures >= 5) blockedUntil = now + Math.min(300, 15 * 2 ** (failures - 5)) * 1000;
  return false;
}

function clear() {
  try { fs.unlinkSync(lockFile()); } catch { /* not set */ }
  failures = 0;
  blockedUntil = 0;
}

// Password typed into the Windows installer. Returns true if one was applied.
function consumeInstallerPassword() {
  let raw;
  try { raw = fs.readFileSync(setupFile()); } catch { return false; }
  try { fs.unlinkSync(setupFile()); } catch { /* ignore */ }
  let text;
  if (raw[0] === 0xff && raw[1] === 0xfe) text = raw.slice(2).toString('utf16le');
  else if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) text = raw.slice(3).toString('utf8');
  else text = raw.toString('utf8');
  text = text.replace(/[\r\n\0]+$/g, '');
  if (!text) return false;
  try { set(text); return true; } catch { return false; }
}

module.exports = { isSet, set, verify, clear, consumeInstallerPassword, validateNew };
