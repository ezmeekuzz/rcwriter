// Obfuscates RCWriter's JavaScript in place before the installer is built.
// This runs in CI only (see .github/workflows/build-windows.yml), so the
// readable source stays in the repository while the shipped app is harder to
// copy or alter. It is a deterrent, not a guarantee — the real protection is
// the copyright and the LICENSE.
//
// Settings are deliberately conservative so the app keeps working:
//   - renameGlobals OFF  → window.api, contextBridge names and Node globals stay
//   - no selfDefending / no controlFlowFlattening → avoids breaking Electron
//   - stringArray ON     → string literals (incl. the owner mark) are encoded
//
// Usage:
//   node build/obfuscate.js            # obfuscate ./src in place
//   node build/obfuscate.js <dir>      # obfuscate <dir> in place (for testing)

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src'));

// gateway.js is unpacked from the asar and spawned as its own Node process;
// leave it untouched so the spawn path and its runtime stay predictable.
const SKIP = new Set(['gateway.js']);

const options = {
  compact: true,
  renameGlobals: false,
  identifierNamesGenerator: 'mangled',
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  splitStrings: false,
  selfDefending: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  disableConsoleOutput: false,
  numbersToExpressions: false,
  simplify: true,
  target: 'node'
};

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js') && !SKIP.has(name)) out.push(full);
  }
  return out;
}

function main() {
  const files = walk(root);
  let done = 0;
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
    fs.writeFileSync(file, result);
    done += 1;
  }
  console.log(`Obfuscated ${done} file(s) under ${root}`);
}

main();
