// Screenshots for the update manager's visual checks.
const { BrowserWindow, nativeImage } = require('electron');

// Loads a page in a hidden browser window and takes a screenshot.
// Closing (rather than destroying) lets Chromium release the page cleanly, so
// the next window can load the same address.
function closeWindow(w) {
  if (!w || w.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => { const t = setTimeout(() => { if (!w.isDestroyed()) w.destroy(); resolve(); }, 5000); w.once('closed', () => { clearTimeout(t); resolve(); }); w.close(); });
}

async function capture(url, attempt = 0) {
  try { return await captureOnce(url); } catch (e) {
    if (attempt < 1 && /ERR_FAILED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(e.message)) { await new Promise((r) => setTimeout(r, 1500)); return capture(url, attempt + 1); }
    throw e;
  }
}

async function captureOnce(url) {
  const w = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { sandbox: true, offscreen: false, backgroundThrottling: false } });
  let status = null;
  w.webContents.on('did-navigate', (_e, _u, code) => { status = code; });
  try {
    const loading = w.loadURL(url, { extraHeaders: 'pragma: no-cache\ncache-control: no-cache\n' });
    loading.catch(() => {}); // handled below
    let timer;
    await Promise.race([loading, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('The page took longer than 45 seconds to load.')), 45000); })])
      .catch((e) => { if (!/ERR_ABORTED/.test(e.message)) throw e; })
      .finally(() => clearTimeout(timer));
    await new Promise((r) => setTimeout(r, 2500));
    const img = await w.webContents.capturePage();
    const title = w.webContents.getTitle();
    const text = await w.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 6000) : ""').catch(() => '');
    const err = (text.match(/(Fatal error|Parse error|There has been a critical error[^.]*|Error establishing a database connection|Warning: [^\n]{0,120}|404 Not Found)/i) || [])[0] || null;
    return { img, png: img.toPNG(), width: img.getSize().width, height: img.getSize().height, status, title, errorText: err };
  } finally { await closeWindow(w); }
}
capture.load = async (file) => { const img = nativeImage.createFromPath(file); return { img }; };
capture.diff = (a, b) => {
  const sa = a.img.getSize();
  const bi = b.img.getSize().width === sa.width && b.img.getSize().height === sa.height ? b.img : b.img.resize({ width: sa.width, height: sa.height });
  const x = a.img.toBitmap();
  const y = bi.toBitmap();
  let changed = 0;
  const total = Math.floor(x.length / 4);
  for (let i = 0; i < x.length; i += 16) { // every 4th pixel is plenty
    if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 60) changed += 4;
  }
  return { percent: Math.round((changed / total) * 1000) / 10, sizeChanged: bi !== b.img };
};

module.exports = { capture, closeWindow };
