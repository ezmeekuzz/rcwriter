// "Use my ChatGPT subscription": runs OpenAI's official Codex CLI, which the
// user signs in to with their ChatGPT account. RCWriter never sees or stores
// the ChatGPT credentials; Codex keeps them in its own config folder.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const NOT_INSTALLED = 'Codex is not installed yet. Click Install Codex under AI providers.';

// GUI apps (especially on macOS) don't inherit the terminal PATH, so add the usual install folders.
function extendedPath() {
  const home = os.homedir();
  const extra = isWin
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(process.env.LOCALAPPDATA || '', 'pnpm')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(home, '.npm-global', 'bin'),
       path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin')];
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvm)) extra.push(path.join(nvm, v, 'bin'));
  } catch { /* no nvm */ }
  return [process.env.PATH || '', ...extra].filter(Boolean).join(path.delimiter);
}

function quoteWin(a) {
  return /[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a;
}

function run(cmd, args, { input = null, timeoutMs = 20 * 60 * 1000, cwd, onOutput, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    const useShell = isWin && !/\.exe$/i.test(cmd); // npm installs codex as a .cmd shim that needs the shell
    try {
      child = spawn(useShell ? quoteWin(cmd) : cmd, useShell ? args.map(quoteWin) : args, {
        cwd: cwd || os.homedir(),
        env: { ...process.env, PATH: extendedPath(), NO_COLOR: '1' },
        shell: useShell,
        windowsHide: true
      });
    } catch (e) {
      reject(new Error(NOT_INSTALLED));
      return;
    }
    if (onSpawn) onSpawn(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex took too long and was stopped.')); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; if (onOutput) onOutput(String(d)); });
    child.stderr.on('data', (d) => { stderr += d; if (onOutput) onOutput(String(d)); });
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(NOT_INSTALLED) : e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (/is not recognized as an internal or external command|command not found/i.test(stderr)) reject(new Error(NOT_INSTALLED));
      else resolve({ code, stdout, stderr });
    });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

async function status(cmd = 'codex') {
  try {
    const v = await run(cmd || 'codex', ['--version'], { timeoutMs: 30000 });
    if (v.code !== 0) return { installed: false, loggedIn: false, detail: NOT_INSTALLED };
    const s = await run(cmd || 'codex', ['login', 'status'], { timeoutMs: 30000 });
    const out = `${s.stdout}\n${s.stderr}`.trim();
    const loggedIn = s.code === 0 && !/not logged in/i.test(out);
    return {
      installed: true,
      version: v.stdout.trim(),
      loggedIn,
      method: loggedIn ? (/chatgpt/i.test(out) ? 'ChatGPT account' : 'API key') : null,
      detail: out.split('\n').filter(Boolean).pop() || '',
      checkedAt: new Date().toISOString()
    };
  } catch (e) {
    return { installed: false, loggedIn: false, detail: e.message, checkedAt: new Date().toISOString() };
  }
}

// Starts "codex login", which opens the ChatGPT approval page in the browser.
async function login(cmd = 'codex', onUrl) {
  let sent = false;
  const r = await run(cmd || 'codex', ['login'], {
    timeoutMs: 10 * 60 * 1000,
    onOutput: (chunk) => {
      const m = chunk.match(/https:\/\/\S+/);
      if (m && !sent && onUrl) { sent = true; onUrl(m[0]); }
    }
  });
  if (r.code !== 0) throw new Error(`Sign-in didn't finish: ${(r.stderr || r.stdout).trim().split('\n').pop() || 'cancelled'}`);
  return status(cmd);
}

async function logout(cmd = 'codex') {
  await run(cmd || 'codex', ['logout'], { timeoutMs: 30000 });
  return status(cmd);
}

function explain(r) {
  const all = `${r.stderr}\n${r.stdout}`;
  if (/not logged in|codex login|401 unauthorized|refresh token|token (has )?expired/i.test(all)) {
    return "RCWriter isn't signed in to ChatGPT, or the sign-in expired. Go to AI providers and click Sign in with ChatGPT.";
  }
  if (/usage limit|429 too many|rate limit reached/i.test(all)) {
    return "You've reached your ChatGPT plan's usage limit for now. It resets on OpenAI's schedule, or switch this writer to an API key.";
  }
  if (/model .* (not found|not supported|does not exist)|unknown model/i.test(all)) {
    return 'Your ChatGPT plan can\'t use that model in Codex. Leave the model blank to use your plan\'s default.';
  }
  const tail = all.trim().split('\n').filter(Boolean).slice(-3).join(' ');
  return `Codex stopped with an error: ${tail.slice(0, 300) || `exit code ${r.code}`}`;
}

async function generate({ cmd = 'codex', model, system, prompt }) {
  if (model && !/^[\w.:\-/]+$/.test(model)) throw new Error('That model name has characters Codex won\'t accept.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcwriter-'));
  const out = path.join(dir, 'article.md');
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dir, '-o', out];
  if (model) args.push('-m', model);
  args.push('-'); // prompt comes from stdin, so long knowledge bases are fine
  const input = [
    system,
    '# Task',
    prompt,
    'This is a writing task only. Do not run commands, read files, or browse. Reply with the finished article and nothing else.'
  ].join('\n\n');
  try {
    const r = await run(cmd || 'codex', args, { input, cwd: dir });
    let text = '';
    try { text = fs.readFileSync(out, 'utf8').trim(); } catch { /* no output file */ }
    if (r.code !== 0 || !text) throw new Error(explain(r));
    return { text, truncated: false, usage: null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { status, login, logout, generate, run, NOT_INSTALLED };
