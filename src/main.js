const {
  app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell,
  nativeImage, powerMonitor, powerSaveBlocker
} = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const providers = require('./providers');
const generator = require('./generator');
const { createScheduler, occurrences } = require('./scheduler');
const codex = require('./codex');
const codexInstall = require('./codex-install');
const lock = require('./lock');
const { PRESETS, createConnectors } = require('./connectors');
const { createAuditor, MODES, TEMPLATES } = require('./audit');
const { createGoogle } = require('./google');
const { createBuiltins } = require('./builtin');
const hostGuard = require('./hostguard');
const sites = require('./sites');
const crypto = require('crypto');

const PROTOCOL = 'rcwriter';

const ASSETS = path.join(__dirname, '..', 'assets');
const ICON = path.join(ASSETS, 'icon.png');

let win = null;
let tray = null;
let quitting = false;
let blockerId = null;
let scheduler = null;
let connectorMgr = null;
let auditor = null;
let google = null;
let builtins = null;
const siteCache = new Map(); // siteId -> { at, posts }
let toldAboutTray = false;
let locked = false;
let codexInstalling = null; // { pct }
const jobs = new Map();          // jobId -> { id, writerName, scheduleName, startedAt }
const liveNotifications = new Set(); // keep references so click handlers survive GC

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

if (process.platform === 'win32') app.setAppUserModelId('com.rcwriter.app');

// rcwriter:// links bring the WordPress approval back into the app.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}
let pendingDeepLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)) || null;
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (store.data && scheduler) handleDeepLink(url); else pendingDeepLink = url;
});

const startHidden =
  process.argv.includes('--hidden') ||
  (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);

// ---------------- window & tray ----------------

function createWindow(show) {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show,
    title: 'RCWriter',
    icon: ICON,
    backgroundColor: '#EEF1F4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); });

  win.on('hide', () => { if (store.data.settings.lockOnHide) lockNow(); });
  win.on('minimize', () => { if (store.data.settings.lockOnHide) lockNow(); });
  win.on('close', (e) => {
    if (!quitting && store.data.settings.closeToTray) {
      e.preventDefault();
      win.hide();
      if (!toldAboutTray) {
        toldAboutTray = true;
        notify('RCWriter is still running', 'Your schedules keep running in the background. Open RCWriter from the tray icon.');
      }
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  let img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  if (process.platform === 'darwin') img = img.resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('RCWriter');
  tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const d = store.data;
  const running = jobs.size;
  const writers = locked ? [] : d.writers.map((w) => ({ label: w.name, click: () => runWriter(w.id).catch(() => {}) }));
  tray.setToolTip(running ? `RCWriter: writing ${running} article${running > 1 ? 's' : ''}` : 'RCWriter');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open RCWriter', click: showWindow },
    { type: 'separator' },
    { label: 'Write an article now', submenu: writers.length ? writers : [{ label: 'No writers yet', enabled: false }] },
    { label: 'Lock RCWriter', enabled: lock.isSet() && !locked, click: lockNow },
    { label: 'Pause all schedules', type: 'checkbox', checked: !!d.settings.paused, click: (item) => { applySettings({ paused: item.checked }); } },
    { type: 'separator' },
    { label: 'Quit RCWriter', click: () => { quitting = true; app.quit(); } }
  ]));
}

// ---------------- notifications ----------------

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  liveNotifications.add(n);
  n.on('click', () => { showWindow(); if (onClick) onClick(); });
  n.on('close', () => liveNotifications.delete(n));
  setTimeout(() => liveNotifications.delete(n), 10 * 60 * 1000);
  n.show();
}

// ---------------- state ----------------

function publicState() {
  const d = store.data;
  if (locked) {
    return { locked: true, settings: { theme: d.settings.theme }, writing: jobs.size, version: app.getVersion(), platform: process.platform };
  }
  const provs = {};
  for (const id of Object.keys(providers.DEFS)) {
    const p = d.providers[id] || {};
    const sub = id === 'chatgpt' ? (d.subscription.chatgpt || null) : null;
    provs[id] = {
      id,
      kind: providers.DEFS[id].kind || 'apikey',
      subscription: sub,
      label: providers.DEFS[id].label,
      keyHint: providers.DEFS[id].keyHint,
      keyUrl: providers.DEFS[id].keyUrl,
      hasKey: id === 'chatgpt' ? !!(sub && sub.loggedIn) : !!store.getKey(id),
      baseUrl: p.baseUrl || '',
      customLabel: p.label || '',
      models: (d.modelCache[id] && d.modelCache[id].models) || [],
      modelsUpdated: (d.modelCache[id] && d.modelCache[id].at) || null
    };
  }
  return {
    settings: d.settings,
    providers: provs,
    writers: d.writers,
    sites: d.sites.map(({ secret, ...rest }) => ({ ...rest, hasSecret: !!secret, pace: rest.pace || 'gentle', access: hostGuard.hostStatus(hostGuard.hostOf(rest.url)) })),
    paces: Object.fromEntries(Object.entries(hostGuard.PACES).map(([k, v]) => [k, { label: v.label, gapMs: v.gapMs, auditPerDay: v.auditPerDay }])),
    connectors: d.connectors.map(({ secret, oauthTokens, oauthClient, codeVerifier, oauthState, ...rest }) => ({ ...rest, hasSecret: !!secret, signedIn: rest.auth === 'oauth' ? !!oauthTokens : rest.auth === 'apikey' ? !!secret : true })),
    connectorPresets: PRESETS,
    google: google ? google.status() : { connected: false },
    builtinBySite: builtins ? Object.fromEntries(d.sites.map((x) => [x.id, builtins.available(x.id).map((b) => ({ kind: b.kind, name: b.name, count: b.tools.length }))])) : {},
    auditJobs: d.auditJobs,
    auditRuns: d.auditRuns.slice(0, 200),
    auditRunning: auditor ? auditor.running() : [],
    approvals: d.approvals.slice(0, 500),
    changes: d.changes.slice(0, 500),
    auditModes: MODES,
    auditTemplates: TEMPLATES,
    schedules: d.schedules,
    articles: d.articles.slice(0, 1000),
    activity: d.activity.slice(0, 80),
    upcoming: scheduler ? scheduler.upcoming(48) : [],
    jobs: [...jobs.values()],
    locked: false,
    security: { hasPassword: lock.isSet() },
    codexInstall: { installing: codexInstalling, bundledPath: codexInstall.installedPath(app.getPath('userData')) },
    now: new Date().toISOString(),
    version: app.getVersion(),
    platform: process.platform
  };
}

function broadcast() {
  updateTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
}

function applySettings(patch) {
  const s = store.data.settings;
  Object.assign(s, patch);
  if ('launchAtLogin' in patch && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin, openAsHidden: true, args: ['--hidden'] });
  }
  if ('keepAwake' in patch || patch.__init) {
    if (s.keepAwake && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
    if (!s.keepAwake && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  }
  if ('catchUpWindowHours' in patch) s.catchUpWindowHours = Math.max(0, Number(s.catchUpWindowHours) || 0);
  delete s.__init;
  store.save();
  broadcast();
}

// ---------------- running writers ----------------

function providerConfig(id) {
  const p = store.data.providers[id] || {};
  return { key: id === 'chatgpt' ? '' : store.getKey(id), baseUrl: p.baseUrl || '', cliPath: codexCmd() };
}

async function runWriter(writerId, { topic = '', schedule = null, silent = false } = {}) {
  const d = store.data;
  const writer = d.writers.find((w) => w.id === writerId);
  if (!writer) throw new Error('That writer no longer exists.');
  const cfg = providerConfig(writer.provider);
  if (!['custom', 'chatgpt'].includes(writer.provider) && !cfg.key) {
    const msg = `${writer.name} can't write: add an API key for ${providers.DEFS[writer.provider]?.label || writer.provider}.`;
    store.log('error', msg);
    store.save();
    if (d.settings.notifyOnFailure) notify('Article not written', msg, () => win?.webContents.send('navigate', 'providers'));
    broadcast();
    throw new Error(msg);
  }

  const jobId = store.uid();
  jobs.set(jobId, { id: jobId, writerName: writer.name, scheduleName: schedule ? schedule.name : null, startedAt: new Date().toISOString() });
  broadcast();

  try {
    const recentTitles = d.articles.filter((a) => a.writerId === writer.id).map((a) => a.title);
    const siteContext = await buildSiteContext(writer);
    const article = await generator.run({
      writer: { ...writer, siteContext }, topicOverride: topic, schedule, settings: d.settings,
      providerCfg: cfg, generate: providers.generate, recentTitles, uid: store.uid
    });
    d.articles.unshift(article);
    store.log('article', `${writer.name} wrote "${article.title}" (${article.words} words).`, { articleId: article.id });
    if (article.truncated) store.log('info', `"${article.title}" hit the max output length and may be cut off. Raise "Max output tokens" for ${writer.name}.`);
    store.save();

    let publishNote = '';
    if (writer.siteId && writer.publishStatus && writer.publishStatus !== 'none') {
      try {
        const pub = await publishArticle(article.id, writer.siteId, { status: writer.publishStatus, categories: writer.wpCategories, tags: writer.wpTags });
        publishNote = `\n${pub.status === 'publish' ? 'Published' : pub.status === 'sent' ? 'Sent' : `Saved as ${pub.status}`} on ${pub.siteName}`;
      } catch (e) {
        publishNote = `\nNot published: ${e.message}`.slice(0, 120);
      }
    }

    if (d.settings.notifyOnComplete && (!schedule || schedule.notifyOnComplete !== false) && !silent) {
      notify('New article written', `${article.title}\n${writer.name}, ${article.words} words${publishNote}`, () => win?.webContents.send('open-article', article.id));
    }
    return article;
  } catch (e) {
    store.log('error', `${writer.name} could not write an article: ${e.message}`);
    store.save();
    if (d.settings.notifyOnFailure) notify('Article not written', `${writer.name}: ${e.message}`.slice(0, 250));
    throw e;
  } finally {
    jobs.delete(jobId);
    broadcast();
  }
}

// Facts about the writer's website: existing posts (to avoid repeats and add internal
// links) and Search Console queries the site almost ranks for (topic and keyword ideas).
async function buildSiteContext(writer) {
  const site = store.data.sites.find((x) => x.id === writer.siteId);
  if (!site) return '';
  const parts = [];
  if (writer.useSitePosts !== false && site.type === 'wordpress' && site.secret) {
    try {
      let c = siteCache.get(site.id);
      if (!c || Date.now() - c.at > 6 * 36e5) {
        const rows = await sites.wpRequest(site, { user: site.username, pass: store.decrypt(site.secret) }, '/wp/v2/posts', { query: { per_page: 100, status: 'publish', _fields: 'title,link' } });
        c = { at: Date.now(), posts: rows.map((r) => ({ title: String(r.title && (r.title.rendered || r.title.raw) || '').replace(/<[^>]+>/g, '').replace(/&#8217;/g, "'").replace(/&amp;/g, '&'), link: r.link })) };
        siteCache.set(site.id, c);
      }
      if (c.posts.length) {
        parts.push(`Articles already published on ${site.name} (title | URL):\n${c.posts.slice(0, 80).map((p) => `- ${p.title} | ${p.link}`).join('\n')}\n\nDo not write about the same subject as any of these. Where it genuinely helps the reader, link to 2 to 4 of them with descriptive anchor text, as Markdown links, using these exact URLs.`);
      }
    } catch (e) { store.log('info', `${writer.name}: couldn't read existing posts from ${site.name} (${e.message}). Writing without them.`); }
  }
  if (writer.useSearchConsole !== false && site.google && site.google.gscSite && google.configured()) {
    try {
      const q = await google.opportunityQueries(site.google.gscSite, 30);
      if (q.length) {
        parts.push(`Google searches where ${site.name} already appears but is not yet in the top 3 (query | monthly impressions | average position):\n${q.map((x) => `- ${x.query} | ${x.impressions} | ${x.position}`).join('\n')}\n\nWhen it fits your instructions and topic, target one of these searches: use the exact phrase naturally in the title and first paragraph, and answer what that searcher wants.`);
      }
    } catch (e) { store.log('info', `${writer.name}: couldn't read Search Console data (${e.message}). Writing without it.`); }
  }
  return parts.join('\n\n');
}

async function runSchedule(s) {
  if (s.kind === 'audit') {
    const job = store.data.auditJobs.find((j) => j.id === s.jobId);
    if (!job) { store.log('error', `Schedule "${s.name}" points to an audit that no longer exists.`); store.save(); return; }
    try { await auditor.runJob(job, { schedule: s }); } catch (e) { store.log('error', `Audit "${job.name}" could not start: ${e.message}`); store.save(); }
    return;
  }
  const count = Math.min(10, Math.max(1, Number(s.count) || 1));
  for (let i = 0; i < count; i++) {
    try { await runWriter(s.writerId, { topic: s.topicOverride || '', schedule: s }); }
    catch { if (i === 0) break; }
  }
}

async function installCodex() {
  if (codexInstalling) throw new Error('Codex is already being installed.');
  codexInstalling = { pct: 0 };
  broadcast();
  try {
    await codexInstall.install(app.getPath('userData'), ({ pct }) => {
      codexInstalling = { pct };
      win?.webContents.send('codex-progress', pct);
    });
    store.data.settings.codexPath = '';
    codexInstalling = null;
    return await codex.status(codexCmd());
  } finally {
    codexInstalling = null;
    broadcast();
  }
}

// Earlier versions installed only codex.exe, which can't run connected tools on
// Windows. Reinstall the complete package automatically. The ChatGPT sign-in is
// kept, because Codex stores it separately.
function repairCodexIfNeeded() {
  if (store.data.settings.codexPath || !codexInstall.needsRepair(app.getPath('userData'))) return;
  store.log('info', 'Updating Codex so site audits can use connected tools…');
  store.save();
  broadcast();
  installCodex()
    .then((st) => {
      store.data.subscription.chatgpt = st;
      store.log('info', 'Codex was updated. Site audits can use connected tools again.');
      store.save();
      notify('Codex updated', 'Site audits with your ChatGPT subscription can use connected tools again.');
    })
    .catch((e) => {
      store.log('error', `Codex couldn't be updated automatically: ${e.message} Open AI providers and click Install Codex.`);
      store.save();
    })
    .finally(broadcast);
}

function codexProblem() {
  if (store.data.settings.codexPath) return null;
  const ud = app.getPath('userData');
  if (codexInstalling) return 'Codex is being updated right now. Try again in a few minutes.';
  if (codexInstall.needsRepair(ud)) return 'Codex needs to be reinstalled before audits can use tools. Open AI providers and click Install Codex.';
  return null;
}

function codexCmd() {
  return store.data.settings.codexPath || codexInstall.installedPath(app.getPath('userData')) || 'codex';
}

// ---------------- app lock ----------------

function lockNow() {
  if (!lock.isSet() || locked) return;
  locked = true;
  broadcast();
}

// ---------------- websites ----------------

function siteSecret(site) {
  return store.decrypt(site.secret);
}

async function publishArticle(articleId, siteId, opts = {}) {
  const d = store.data;
  const article = d.articles.find((a) => a.id === articleId);
  if (!article) throw new Error('Article not found.');
  const site = d.sites.find((x) => x.id === siteId);
  if (!site) throw new Error('That website is no longer connected.');
  try {
    const text = fs.readFileSync(article.path, 'utf8');
    const res = await sites.publish(site, siteSecret(site), article, text, opts);
    article.published = { ...res, siteId: site.id, siteName: site.name, at: new Date().toISOString() };
    delete article.publishError;
    store.log('publish', `"${article.title}" ${res.status === 'publish' ? 'was published' : res.status === 'sent' ? 'was sent' : `was saved as ${res.status}`} on ${site.name}.`, { articleId: article.id });
    return { ...res, siteName: site.name };
  } catch (e) {
    article.publishError = e.message;
    store.log('error', `Could not publish "${article.title}" to ${site.name}: ${e.message}`, { articleId: article.id });
    throw e;
  } finally {
    store.save();
    broadcast();
  }
}

async function handleDeepLink(raw) {
  let u;
  try { u = new URL(raw); } catch { return; }
  if (u.hostname !== 'wp-auth') return;
  showWindow();
  const d = store.data;
  d.pendingAuth = d.pendingAuth || {};
  const state = u.searchParams.get('state');
  const pending = d.pendingAuth[state];
  if (!pending || Date.now() - new Date(pending.at).getTime() > 60 * 60 * 1000) {
    notify('Connection link expired', 'Start connecting the website again from the Websites page.');
    return;
  }
  delete d.pendingAuth[state];
  store.save();
  if (u.searchParams.get('rejected')) {
    notify('WordPress connection cancelled', `${pending.name} was not connected.`);
    win?.webContents.send('toast', { msg: `${pending.name} was not connected.`, kind: 'error' });
    return;
  }
  const user = u.searchParams.get('user_login');
  const pass = u.searchParams.get('password');
  try {
    const existing = pending.siteId && d.sites.find((x) => x.id === pending.siteId);
    const site = {
      ...(existing || {}),
      id: existing ? existing.id : store.uid(),
      type: 'wordpress',
      name: existing ? existing.name : pending.name,
      url: pending.url,
      restMode: pending.restMode,
      username: user,
      secret: store.encrypt(pass),
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    };
    const info = await sites.wpVerify(site, { user, pass });
    Object.assign(site, { connectedAs: info.userName, canPublish: info.canPublish, checkedAt: new Date().toISOString(), lastError: null });
    if (existing) Object.assign(existing, site); else d.sites.push(site);
    store.log('info', `Connected ${site.name} as ${info.userName}.`);
    store.save();
    notify('Website connected', `${site.name} is connected as ${info.userName}.`);
    win?.webContents.send('toast', { msg: `${site.name} is connected.` });
  } catch (e) {
    store.log('error', `Could not connect ${pending.name}: ${e.message}`);
    store.save();
    notify('Website not connected', e.message);
  }
  broadcast();
}

// ---------------- IPC ----------------

const OPEN_WHEN_LOCKED = new Set(['state:get', 'lock:unlock', 'lock:reset', 'link:open']);
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    if (locked && !OPEN_WHEN_LOCKED.has(channel)) throw new Error('RCWriter is locked. Enter your password first.');
    return fn(...args);
  });
}

function registerIpc() {
  handle('state:get', () => publicState());

  // App password
  handle('lock:unlock', (password) => {
    if (!lock.verify(password)) throw new Error('That password is not correct.');
    locked = false;
    broadcast();
    return true;
  });
  handle('lock:set', (current, next) => {
    if (lock.isSet() && !lock.verify(current)) throw new Error('Your current password is not correct.');
    lock.set(next);
    store.data.settings.passwordPrompted = true;
    store.save();
    broadcast();
    return true;
  });
  handle('lock:remove', (current) => {
    if (!lock.verify(current)) throw new Error('That password is not correct.');
    lock.clear();
    broadcast();
    return true;
  });
  handle('lock:skipSetup', () => { store.data.settings.passwordPrompted = true; store.save(); broadcast(); });
  handle('lock:now', () => lockNow());
  handle('lock:reset', async () => {
    // Forgot password: remove it, and erase every saved credential so nothing is exposed.
    const d = store.data;
    for (const id of Object.keys(d.providers)) d.providers[id].key = null;
    d.modelCache = {};
    d.google = { psiKey: null };
    for (const c of d.connectors) {
      delete c.oauthTokens; delete c.oauthClient; delete c.codeVerifier; c.secret = null;
      c.lastError = 'Sign in again. Saved sign-ins were erased when the password was reset.';
    }
    for (const site of d.sites) {
      site.secret = null;
      site.lastError = 'Reconnect this website. Its saved login was erased when the password was reset.';
    }
    try { await codex.logout(codexCmd()); } catch { /* not installed */ }
    d.subscription = {};
    lock.clear();
    locked = false;
    store.log('info', 'The app password was reset. Saved API keys, website logins and the ChatGPT sign-in were erased.');
    store.save();
    broadcast();
    return true;
  });

  handle('settings:save', (patch) => applySettings(patch || {}));
  handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: store.data.settings.outputDir });
    if (r.canceled || !r.filePaths[0]) return null;
    applySettings({ outputDir: r.filePaths[0] });
    return r.filePaths[0];
  });
  handle('app:openOutputDir', () => {
    fs.mkdirSync(store.data.settings.outputDir, { recursive: true });
    return shell.openPath(store.data.settings.outputDir);
  });
  handle('notify:test', () => notify('Notifications are working', 'This is how RCWriter will tell you about upcoming and finished articles.'));

  handle('provider:set', (id, cfg = {}) => {
    if (!store.data.providers[id]) throw new Error('Unknown provider.');
    if ('key' in cfg) store.setKey(id, cfg.key);
    if ('baseUrl' in cfg) store.data.providers[id].baseUrl = String(cfg.baseUrl || '').trim();
    if ('label' in cfg) store.data.providers[id].label = String(cfg.label || '').trim();
    delete store.data.modelCache[id];
    store.save();
    broadcast();
    return true;
  });
  handle('provider:models', async (id, refresh) => {
    const cache = store.data.modelCache[id];
    if (!refresh && cache && Date.now() - new Date(cache.at).getTime() < 24 * 36e5) return cache.models;
    const models = await providers.listModels(id, providerConfig(id));
    store.data.modelCache[id] = { at: new Date().toISOString(), models };
    store.save();
    broadcast();
    return models;
  });

  handle('writer:save', (w) => {
    const d = store.data;
    if (!w.name || !w.name.trim()) throw new Error('Give the writer a name.');
    if (!w.id) { w.id = store.uid(); w.createdAt = new Date().toISOString(); d.writers.push(w); }
    else {
      const i = d.writers.findIndex((x) => x.id === w.id);
      if (i < 0) d.writers.push(w); else d.writers[i] = { ...d.writers[i], ...w };
    }
    store.save();
    broadcast();
    return w.id;
  });
  handle('writer:delete', (id) => {
    const d = store.data;
    d.writers = d.writers.filter((w) => w.id !== id);
    d.schedules = d.schedules.filter((s) => s.writerId !== id);
    store.save();
    broadcast();
  });
  handle('writer:run', (id, topic) => {
    runWriter(id, { topic }).catch(() => {});
    return true;
  });
  handle('writer:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Text files', extensions: ['txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml'] }]
    });
    return r.canceled ? [] : r.filePaths;
  });

  handle('schedule:save', (s) => {
    const d = store.data;
    if (!s.name || !s.name.trim()) throw new Error('Give the schedule a name.');
    if (!d.writers.find((w) => w.id === s.writerId)) throw new Error('Choose a writer for this schedule.');
    if (s.type === 'once' && !(new Date(s.at) > new Date())) throw new Error('Pick a date and time in the future.');
    if (s.type === 'weekly' && !(s.days && s.days.length)) throw new Error('Pick at least one day of the week.');
    s.reminders = [...new Set((s.reminders || []).map(Number).filter((n) => n > 0))].sort((a, b) => b - a);
    if (!s.id) { s.id = store.uid(); s.createdAt = new Date().toISOString(); d.schedules.push(s); }
    else {
      const i = d.schedules.findIndex((x) => x.id === s.id);
      if (i < 0) d.schedules.push(s); else d.schedules[i] = { ...d.schedules[i], ...s, lastRunAt: s.type === 'once' ? null : d.schedules[i].lastRunAt };
    }
    const saved = d.schedules.find((x) => x.id === s.id);
    scheduler.reset(saved);
    scheduler.tick();
    store.save();
    broadcast();
    return s.id;
  });
  handle('schedule:delete', (id) => {
    store.data.schedules = store.data.schedules.filter((s) => s.id !== id);
    store.save();
    broadcast();
  });
  handle('schedule:toggle', (id, enabled) => {
    const s = store.data.schedules.find((x) => x.id === id);
    if (!s) return;
    if (enabled && s.type === 'once' && !(new Date(s.at) > new Date())) throw new Error('This one-time schedule has already passed. Edit it to pick a new time.');
    s.enabled = !!enabled;
    if (enabled && s.type === 'once') s.lastRunAt = null;
    scheduler.reset(s);
    scheduler.tick();
    store.save();
    broadcast();
  });
  handle('schedule:preview', (s) => occurrences({ ...s, createdAt: s.createdAt || new Date().toISOString() }, 4).map((t) => t.toISOString()));

  handle('article:read', (id) => {
    const a = store.data.articles.find((x) => x.id === id);
    if (!a) throw new Error('Article not found.');
    try { return fs.readFileSync(a.path, 'utf8'); }
    catch { throw new Error(`The file was moved or deleted: ${a.path}`); }
  });
  handle('article:delete', (id, removeFile) => {
    const d = store.data;
    const a = d.articles.find((x) => x.id === id);
    if (a && removeFile) { try { fs.unlinkSync(a.path); } catch { /* already gone */ } }
    d.articles = d.articles.filter((x) => x.id !== id);
    store.save();
    broadcast();
  });
  handle('article:reveal', (id) => {
    const a = store.data.articles.find((x) => x.id === id);
    if (a) shell.showItemInFolder(a.path);
  });
  handle('article:openFile', (id) => {
    const a = store.data.articles.find((x) => x.id === id);
    if (a) return shell.openPath(a.path);
  });
  handle('link:open', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

  // ChatGPT subscription (via the official Codex CLI)
  const saveSub = (st) => { store.data.subscription.chatgpt = st; store.save(); broadcast(); return st; };
  handle('sub:status', async () => saveSub(await codex.status(codexCmd())));
  handle('sub:login', async () => {
    const st = await codex.login(codexCmd(), (url) => win?.webContents.send('login-url', url));
    return saveSub(st);
  });
  handle('sub:install', async () => saveSub(await installCodex()));
  handle('sub:logout', async () => saveSub(await codex.logout(codexCmd())));

  // Websites
  handle('site:wpConnect', async (rawUrl, siteId) => {
    const info = await sites.wpDiscover(rawUrl);
    if (!info.appPasswordsAvailable) {
      throw new Error('This site has application passwords turned off. They need WordPress 5.6 or newer and HTTPS, and some security plugins disable them. Use "Enter details manually" after enabling them, or ask your host.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    store.data.pendingAuth = store.data.pendingAuth || {};
    store.data.pendingAuth[state] = { url: info.url, name: info.name, restMode: info.restMode, siteId: siteId || null, at: new Date().toISOString() };
    store.save();
    const authorizeUrl = sites.wpAuthorizeUrl(info.authUrl, state);
    shell.openExternal(authorizeUrl);
    return { name: info.name, authorizeUrl };
  });
  handle('site:saveManual', async (input) => {
    const d = store.data;
    const existing = input.id && d.sites.find((x) => x.id === input.id);
    let site;
    if (input.type === 'wordpress') {
      const info = await sites.wpDiscover(input.url);
      const pass = String(input.password || '').replace(/\s+/g, ' ').trim() || (existing ? siteSecret(existing) : '');
      if (!input.username || !pass) throw new Error('Enter the WordPress username and application password.');
      site = { ...(existing || {}), type: 'wordpress', name: input.name || info.name, url: info.url, restMode: info.restMode, username: input.username.trim(), secret: store.encrypt(pass) };
      const v = await sites.wpVerify(site, { user: site.username, pass });
      Object.assign(site, { connectedAs: v.userName, canPublish: v.canPublish });
    } else if (input.type === 'webhook') {
      const url = sites.normalizeUrl(input.url);
      const secret = input.password === undefined || input.password === null ? (existing ? siteSecret(existing) : '') : String(input.password);
      site = { ...(existing || {}), type: 'webhook', name: input.name || new URL(url).host, url, secret: secret ? store.encrypt(secret) : null };
    } else throw new Error('Unknown website type.');
    Object.assign(site, { id: existing ? existing.id : store.uid(), createdAt: existing ? existing.createdAt : new Date().toISOString(), checkedAt: new Date().toISOString(), lastError: null });
    if (existing) Object.assign(existing, site); else d.sites.push(site);
    store.save();
    broadcast();
    return site.id;
  });
  handle('site:rename', (id, name) => {
    const site = store.data.sites.find((x) => x.id === id);
    if (site && name && name.trim()) { site.name = name.trim(); store.save(); broadcast(); }
  });
  handle('site:test', async (id) => {
    const site = store.data.sites.find((x) => x.id === id);
    if (!site) throw new Error('Website not found.');
    try {
      const r = await sites.test(site, siteSecret(site));
      Object.assign(site, { connectedAs: r.userName || site.connectedAs, canPublish: r.canPublish, checkedAt: new Date().toISOString(), lastError: null });
      return r;
    } catch (e) {
      site.lastError = e.message;
      throw e;
    } finally { store.save(); broadcast(); }
  });
  handle('google:serviceAccount', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the service account key (JSON)', properties: ['openFile'], filters: [{ name: 'JSON key', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    try { return await google.useServiceAccount(fs.readFileSync(r.filePaths[0], 'utf8')); } finally { broadcast(); }
  });
  handle('google:oauth', async (clientId, clientSecret) => { try { return await google.signInOAuth(clientId, clientSecret); } finally { broadcast(); } });
  handle('google:refresh', async () => { try { return await google.refreshLists(); } finally { broadcast(); } });
  handle('google:disconnect', () => { google.disconnect(); broadcast(); });
  handle('google:psiKey', (key) => { google.setPsiKey(key); broadcast(); });
  handle('site:setGoogle', (id, g) => {
    const site = store.data.sites.find((x) => x.id === id);
    if (!site) throw new Error('Website not found.');
    site.google = { gscSite: g.gscSite || '', ga4Property: String(g.ga4Property || '').replace(/^properties\//, ''), gtmContainer: g.gtmContainer || '' };
    siteCache.delete(id);
    store.save();
    broadcast();
  });
  handle('site:addUrl', (input) => {
    const url = sites.normalizeUrl(input.url);
    const d = store.data;
    const existing = input.id && d.sites.find((x) => x.id === input.id);
    const site = existing || { id: store.uid(), type: 'url', createdAt: new Date().toISOString() };
    Object.assign(site, { name: String(input.name || new URL(url).host).trim(), url });
    if (!existing) d.sites.push(site);
    store.save();
    broadcast();
    return site.id;
  });
  handle('site:resume', (id) => {
    const site = store.data.sites.find((x) => x.id === id);
    if (site) { hostGuard.resume(hostGuard.hostOf(site.url)); hostGuard.clearCache(); }
    broadcast();
  });
  handle('site:setPace', (id, pace) => {
    const site = store.data.sites.find((x) => x.id === id);
    if (!site || !hostGuard.PACES[pace]) throw new Error('Unknown website or pace.');
    site.pace = pace;
    store.save();
    broadcast();
  });
  handle('site:delete', (id) => {
    const d = store.data;
    d.sites = d.sites.filter((x) => x.id !== id);
    for (const w of d.writers) if (w.siteId === id) { w.siteId = ''; w.publishStatus = 'none'; }
    store.save();
    broadcast();
  });
  // ---------- Site audits ----------
  const conn = (id) => { const c = store.data.connectors.find((x) => x.id === id); if (!c) throw new Error('Connection not found.'); return c; };
  handle('connector:save', async (input) => {
    const d = store.data;
    let url;
    try { url = new URL(String(input.url || '').trim()); } catch { throw new Error('Enter the connector URL, starting with https://'); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('The connector URL must start with https://');
    const existing = input.id && d.connectors.find((x) => x.id === input.id);
    const c = existing || { id: store.uid(), createdAt: new Date().toISOString(), tools: [] };
    const urlChanged = existing && existing.url !== url.toString();
    Object.assign(c, { name: String(input.name || url.host).trim(), url: url.toString(), preset: input.preset || c.preset || null,
      auth: ['oauth', 'apikey', 'none'].includes(input.auth) ? input.auth : 'oauth', keyHeader: input.keyHeader || c.keyHeader || 'Authorization',
      keyPrefix: input.keyPrefix ?? c.keyPrefix ?? 'Bearer ' });
    if (urlChanged) { delete c.oauthTokens; delete c.oauthClient; c.tools = []; delete c.transport; }
    if (input.key) c.secret = store.encrypt(String(input.key).trim());
    if (!existing) d.connectors.push(c);
    store.save();
    broadcast();
    return c.id;
  });
  handle('connector:connect', async (id) => {
    const c = conn(id);
    try {
      await connectorMgr.close(id);
      const tools = await connectorMgr.listTools(c, { interactive: true });
      store.log('info', `Connected ${c.name}: ${tools.length} tools available.`);
      return { tools: tools.length };
    } catch (e) {
      c.lastError = e.message;
      throw e;
    } finally {
      await connectorMgr.close(id);
      store.save();
      broadcast();
    }
  });
  handle('connector:signOut', async (id) => { await connectorMgr.signOut(conn(id)); broadcast(); });
  handle('connector:delete', async (id) => {
    const d = store.data;
    await connectorMgr.close(id);
    d.connectors = d.connectors.filter((x) => x.id !== id);
    for (const j of d.auditJobs) j.connectorIds = (j.connectorIds || []).filter((x) => x !== id);
    store.save();
    broadcast();
  });
  handle('connector:setRisk', (id, toolName, risk) => {
    const t = (conn(id).tools || []).find((x) => x.name === toolName);
    if (!t || !['read', 'safe', 'approval', 'off'].includes(risk)) throw new Error('Unknown tool or setting.');
    t.risk = risk;
    t.userSet = risk !== t.auto;
    store.save();
    broadcast();
  });

  function syncAuditSchedule(job) {
    const d = store.data;
    const id = `audit-${job.id}`;
    let s = d.schedules.find((x) => x.id === id);
    const sch = job.schedule || {};
    if (!sch.type || sch.type === 'manual') { d.schedules = d.schedules.filter((x) => x.id !== id); return; }
    if (!s) { s = { id, kind: 'audit', createdAt: new Date().toISOString() }; d.schedules.push(s); }
    Object.assign(s, { kind: 'audit', jobId: job.id, name: job.name, enabled: job.enabled !== false, type: sch.type, time: sch.time || '09:00',
      days: sch.days || [1], at: sch.at, intervalHours: Number(sch.intervalHours) || 24, startAt: sch.startAt,
      reminders: [...new Set((sch.reminders || []).map(Number).filter((n) => n > 0))].sort((a, b) => b - a), lastRunAt: sch.type === 'once' ? null : s.lastRunAt });
    scheduler.reset(s);
  }
  handle('audit:saveJob', (job) => {
    const d = store.data;
    if (!job.name || !job.name.trim()) throw new Error('Give this audit a name.');
    job.connectorIds = job.connectorIds || [];
    if (job.siteId) { const st = d.sites.find((x) => x.id === job.siteId); if (st) job.siteUrl = st.url.replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
    if (!job.connectorIds.length && !builtins.sources(job).length) throw new Error('Choose a website or at least one connection.');
    if (!MODES[job.mode]) job.mode = 'report';
    if (job.provider !== 'chatgpt' && !job.model) throw new Error('Choose a model for this audit.');
    if (job.schedule && job.schedule.type === 'once' && !(new Date(job.schedule.at) > new Date())) throw new Error('Pick a date and time in the future.');
    if (job.schedule && job.schedule.type === 'weekly' && !(job.schedule.days || []).length) throw new Error('Pick at least one day of the week.');
    for (const k of ['maxToolCalls', 'maxChanges', 'maxMinutes']) job[k] = Math.max(1, Number(job[k]) || { maxToolCalls: 60, maxChanges: 25, maxMinutes: 30 }[k]);
    if (!job.id) { job.id = store.uid(); job.createdAt = new Date().toISOString(); d.auditJobs.push(job); }
    else { const i = d.auditJobs.findIndex((x) => x.id === job.id); if (i < 0) d.auditJobs.push(job); else d.auditJobs[i] = { ...d.auditJobs[i], ...job }; }
    syncAuditSchedule(d.auditJobs.find((x) => x.id === job.id));
    scheduler.tick();
    store.save();
    broadcast();
    return job.id;
  });
  handle('audit:toggleJob', (id, enabled) => {
    const j = store.data.auditJobs.find((x) => x.id === id);
    if (!j) return;
    j.enabled = !!enabled;
    syncAuditSchedule(j);
    scheduler.tick();
    store.save();
    broadcast();
  });
  handle('audit:deleteJob', (id) => {
    const d = store.data;
    d.auditJobs = d.auditJobs.filter((x) => x.id !== id);
    d.schedules = d.schedules.filter((x) => x.id !== `audit-${id}`);
    store.save();
    broadcast();
  });
  handle('audit:run', (id) => {
    const j = store.data.auditJobs.find((x) => x.id === id);
    if (!j) throw new Error('Audit not found.');
    auditor.runJob(j).catch((e) => win?.webContents.send('toast', { msg: e.message, kind: 'error' }));
    return true;
  });
  handle('audit:stop', (runId) => auditor.stop(runId));
  handle('audit:decide', (id, approve) => auditor.decide(id, approve));
  handle('audit:decideAll', async (ids, approve) => {
    let ok = 0; const errors = [];
    for (const id of ids) { try { await auditor.decide(id, approve); ok += 1; } catch (e) { errors.push(e.message); } }
    return { ok, errors };
  });
  handle('audit:revert', (changeId) => auditor.revert(changeId));
  handle('audit:readReport', (runId) => {
    const r = store.data.auditRuns.find((x) => x.id === runId);
    if (!r || !r.reportPath) throw new Error('This run has no report.');
    try { return fs.readFileSync(r.reportPath, 'utf8'); } catch { throw new Error(`The report file was moved or deleted: ${r.reportPath}`); }
  });
  handle('audit:revealReport', (runId) => {
    const r = store.data.auditRuns.find((x) => x.id === runId);
    if (r && r.reportPath) shell.showItemInFolder(r.reportPath);
  });

  handle('article:publish', (id, siteId, opts) => publishArticle(id, siteId, opts || {}));
}

// ---------------- app lifecycle ----------------

if (gotLock) {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link); else showWindow();
  });

  app.whenReady().then(() => {
    store.load();
    hostGuard.init(store);
    if (hostGuard.migrateIdentity()) store.log('info', 'RCWriter now identifies itself in a way hosts like SiteGround accept, so paused websites were resumed.');
    if (lock.consumeInstallerPassword()) { store.data.settings.passwordPrompted = true; store.save(); }
    if (store.data.settings.lockOnHide === undefined) store.data.settings.lockOnHide = true;
    if (store.data.settings.lockAfterMinutes === undefined) store.data.settings.lockAfterMinutes = 15;
    locked = lock.isSet();

    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
      if (startHidden) app.dock.hide();
    } else {
      Menu.setApplicationMenu(null);
    }

    connectorMgr = createConnectors(store);
    google = createGoogle({ store, openExternal: (u) => shell.openExternal(u) });
    builtins = createBuiltins({ store, google });
    auditor = createAuditor({
      store, connectors: connectorMgr, builtins, providers, codex, codexCmd, codexProblem, onChange: broadcast,
      notify: (title, body, target) => notify(title, body, target ? () => win?.webContents.send('navigate-to', target) : undefined),
      paths: {
        execPath: () => process.execPath,
        gateway: () => path.join(__dirname, 'gateway.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
      }
    });
    scheduler = createScheduler({ store, runSchedule, notify, onChange: broadcast });
    registerIpc();
    createWindow(!startHidden);
    createTray();
    applySettings({ __init: true, launchAtLogin: store.data.settings.launchAtLogin });
    scheduler.start();
    if (pendingDeepLink) { handleDeepLink(pendingDeepLink); pendingDeepLink = null; }
    repairCodexIfNeeded();
    // Check ChatGPT sign-in in the background if it has been used before
    if (store.data.subscription.chatgpt || store.data.writers.some((w) => w.provider === 'chatgpt')) {
      codex.status(codexCmd()).then((st) => { store.data.subscription.chatgpt = st; store.save(); broadcast(); });
    }

    powerMonitor.on('resume', () => setTimeout(() => scheduler.tick(), 5000));
    powerMonitor.on('unlock-screen', () => scheduler.tick());
    powerMonitor.on('lock-screen', lockNow);
    powerMonitor.on('suspend', lockNow);
    setInterval(() => {
      const mins = Number(store.data.settings.lockAfterMinutes) || 0;
      if (mins > 0 && powerMonitor.getSystemIdleTime() >= mins * 60) lockNow();
    }, 30 * 1000);

    // Refresh the "upcoming" timeline in the UI every minute
    setInterval(broadcast, 60 * 1000);

    app.on('activate', () => { if (process.platform === 'darwin') app.dock.show(); showWindow(); });
  });

  app.on('before-quit', () => { quitting = true; });
  // Keep running in the tray when all windows are closed.
  app.on('window-all-closed', () => { /* stay alive */ });
}
