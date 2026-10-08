// Local persistence: one JSON file in the app's user-data folder.
// API keys are encrypted with the OS keychain (safeStorage) when available.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let data = null;

function file() {
  return path.join(app.getPath('userData'), 'rcwriter-data.json');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function defaults() {
  return {
    version: 1,
    settings: {
      launchAtLogin: true,
      closeToTray: true,
      keepAwake: true,
      paused: false,
      catchUpMissed: true,
      catchUpWindowHours: 6,
      outputDir: path.join(app.getPath('documents'), 'RCWriter'),
      defaultReminders: [20],
      notifyOnComplete: true,
      notifyOnFailure: true,
      theme: 'system',
      codexPath: ''
    },
    providers: {
      anthropic: { key: null },
      openai: { key: null },
      gemini: { key: null },
      custom: { key: null, baseUrl: '', label: '' }
    },
    modelCache: {},
    subscription: {},
    sites: [],
    clients: [],
    monitorState: {},
    images: {},
    tasks: [],
    digests: [],
    reports: [],
    autoState: {},
    googleUser: {},
    connectors: [],
    google: {},
    auditJobs: [],
    auditRuns: [],
    approvals: [],
    changes: [],
    writers: [],
    schedules: [],
    articles: [],
    activity: [],
    fired: {}
  };
}

function load() {
  const d = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    data = {
      ...d,
      ...raw,
      settings: { ...d.settings, ...(raw.settings || {}) },
      providers: { ...d.providers, ...(raw.providers || {}) },
      fired: raw.fired || {}
    };
  } catch {
    data = d;
  }
  return data;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file());
}

function encrypt(s) {
  if (!s) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: safeStorage.encryptString(s).toString('base64') };
  }
  return { plain: Buffer.from(s, 'utf8').toString('base64') };
}

function decrypt(o) {
  if (!o) return '';
  try {
    if (o.enc) return safeStorage.decryptString(Buffer.from(o.enc, 'base64'));
    if (o.plain) return Buffer.from(o.plain, 'base64').toString('utf8');
  } catch { /* key unreadable on this machine */ }
  return '';
}

function setKey(id, key) {
  data.providers[id].key = key ? encrypt(key.trim()) : null;
}

function getKey(id) {
  return decrypt(data.providers[id] && data.providers[id].key);
}

function log(type, msg, extra = {}) {
  data.activity.unshift({ id: uid(), at: new Date().toISOString(), type, msg, ...extra });
  data.activity = data.activity.slice(0, 300);
}

module.exports = {
  load, save, setKey, getKey, log, uid, encrypt, decrypt,
  get data() { return data; }
};
