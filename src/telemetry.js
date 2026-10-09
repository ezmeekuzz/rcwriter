// Anonymous usage statistics for RCWriter.
//
// Privacy by design:
//   - No names, emails, API keys, website data or article content are ever sent.
//   - Aptabase identifies users with a daily-rotating anonymous hash (no stored
//     personal ID), so this counts how many installs are out there and how many
//     are active, without tracking individuals.
//   - It is opt-out: when the user turns off "usage statistics" in Settings,
//     nothing is sent.
//
// Numbers show up in the owner's Aptabase dashboard (total users, plus daily /
// weekly / monthly active users). It only counts from the version that ships
// with a real APTABASE_KEY, forward.
//
// APTABASE_KEY is the owner's app key (format A-US-xxxx / A-EU-xxxx), baked in
// at build time and the same in every copy. Empty string = telemetry is inert
// (the app runs normally and sends nothing).
const APTABASE_KEY = process.env.RCWRITER_APTABASE_KEY || 'A-EU-4305208630';

const DAY = 24 * 60 * 60 * 1000;

function createTelemetry({ store }) {
  let sdk = null;
  let initialised = false;
  let startedThisRun = false;
  let dayTimer = null;

  const configured = () => !!APTABASE_KEY;
  const allowed = () => configured() && store.data && store.data.settings && store.data.settings.telemetry !== false;

  function load() {
    if (sdk) return sdk;
    try { sdk = require('@aptabase/electron/main'); } catch { sdk = null; }
    return sdk;
  }

  function track(name, props) {
    if (!allowed()) return;
    const a = load();
    if (!a) return;
    try { a.trackEvent(name, props); } catch { /* non-blocking, ignore */ }
  }

  function scheduleHeartbeat() {
    if (dayTimer) return;
    // Long-running tray installs stay open for days; a daily "active" ping keeps
    // the active-user count accurate for them.
    dayTimer = setInterval(() => track('active'), DAY);
    if (dayTimer.unref) dayTimer.unref();
  }

  // Called at startup and whenever the setting changes.
  function start() {
    if (!allowed()) return;
    const a = load();
    if (!a) return;
    if (!initialised) { try { a.initialize(APTABASE_KEY); initialised = true; } catch { return; } }
    if (!startedThisRun) { track('app_started'); startedThisRun = true; }
    scheduleHeartbeat();
  }

  // Re-evaluate after the user toggles the setting.
  function refresh() {
    if (allowed()) start();
    else if (dayTimer) { clearInterval(dayTimer); dayTimer = null; }
  }

  function status() {
    return { configured: configured(), enabled: store.data.settings.telemetry !== false };
  }

  return { start, refresh, track, status };
}

module.exports = { createTelemetry, APTABASE_KEY };
