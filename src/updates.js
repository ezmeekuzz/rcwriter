// In-app update & announcement check.
//
// The app periodically reads a small JSON manifest hosted by the owner and, if
// a newer version is published, shows a banner with a download link. The same
// manifest can carry a one-off announcement message (e.g. "free limits are
// changing"), which is how the owner reaches everyone who has the app installed.
//
// Nothing is installed automatically — the banner just links to the download.
// If the manifest can't be reached (offline, or not hosted yet), the check does
// nothing and the app behaves normally.
//
// Manifest format (host this one file at MANIFEST_URL):
//   {
//     "version": "2.1.0",                         // latest available version
//     "url": "https://tomdigitalspace.com/rcwriter",  // where to download it
//     "notes": "What's new in this version",      // optional, shown in the banner
//     "message": "Any announcement to show",       // optional, shown as its own banner
//     "messageId": "2026-10-limits"                // optional id so a message shows once
//   }
const MANIFEST_URL = 'https://tomdigitalspace.com/rcwriter/latest.json';

// Compare simple x.y.z versions. >0 means a is newer than b.
function cmp(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function createUpdates({ store, currentVersion, onChange }) {
  let latest = null;    // { version, url, notes }
  let announce = null;  // { id, message, url }

  async function check() {
    try {
      const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const m = await res.json();
      latest = (m && m.version && cmp(m.version, currentVersion) > 0)
        ? { version: String(m.version), url: String(m.url || ''), notes: String(m.notes || '') }
        : null;
      announce = (m && m.message)
        ? { id: String(m.messageId || m.message).slice(0, 80), message: String(m.message), url: String(m.url || '') }
        : null;
      if (onChange) onChange();
    } catch { /* offline, timed out, or not hosted yet — ignore */ }
  }

  // What the UI should show, after removing anything the user has dismissed.
  function status() {
    const s = store.data.settings || {};
    return {
      update: latest && latest.version !== s.dismissedUpdate ? latest : null,
      announce: announce && announce.id !== s.dismissedAnnounce ? announce : null
    };
  }

  function dismissUpdate() { if (latest) { store.data.settings.dismissedUpdate = latest.version; store.save(); } if (onChange) onChange(); }
  function dismissAnnounce() { if (announce) { store.data.settings.dismissedAnnounce = announce.id; store.save(); } if (onChange) onChange(); }

  return { check, status, dismissUpdate, dismissAnnounce };
}

module.exports = { createUpdates, MANIFEST_URL, cmp };
