// Background scheduler. Checks every 15 seconds; also re-checks right after
// the computer wakes from sleep (main.js calls tick() on resume).

const HOUR = 36e5;
const MIN = 6e4;

function parseTime(t) {
  const [h, m] = String(t || '09:00').split(':').map(Number);
  return [h || 0, m || 0];
}

// Next occurrence strictly after `from`. For "once" schedules, returns the set time.
function computeNext(s, from) {
  const f = new Date(from);
  switch (s.type) {
    case 'once': {
      const t = new Date(s.at);
      return isNaN(t) ? null : t;
    }
    case 'daily': {
      const [h, m] = parseTime(s.time);
      const t = new Date(f);
      t.setHours(h, m, 0, 0);
      if (t <= f) t.setDate(t.getDate() + 1);
      return t;
    }
    case 'weekly': {
      const [h, m] = parseTime(s.time);
      const days = Array.isArray(s.days) && s.days.length ? s.days.map(Number) : [1];
      for (let i = 0; i <= 7; i++) {
        const t = new Date(f);
        t.setDate(f.getDate() + i);
        t.setHours(h, m, 0, 0);
        if (days.includes(t.getDay()) && t > f) return t;
      }
      return null;
    }
    case 'interval': {
      const ms = Math.max(0.25, Number(s.intervalHours) || 24) * HOUR;
      const base = new Date(s.startAt || s.createdAt || Date.now()).getTime();
      if (base > f.getTime()) return new Date(base);
      const n = Math.floor((f.getTime() - base) / ms) + 1;
      return new Date(base + n * ms);
    }
    default:
      return null;
  }
}

function occurrences(s, count = 5, from = new Date()) {
  if (s.type === 'once') {
    const t = computeNext(s, from);
    return t && t > from ? [t] : [];
  }
  const out = [];
  let cur = new Date(from);
  for (let i = 0; i < count; i++) {
    const n = computeNext(s, cur);
    if (!n) break;
    out.push(n);
    cur = n;
  }
  return out;
}

function createScheduler({ store, runSchedule, notify, onChange }) {
  const running = new Set();
  let timer = null;

  function reset(s) {
    s.nextRunAt = null;
  }

  function ensureNext(s, now) {
    if (s.nextRunAt) return false;
    let n;
    if (s.type === 'once') n = s.lastRunAt ? null : computeNext(s, now);
    else n = computeNext(s, now);
    s.nextRunAt = n ? n.toISOString() : null;
    return true;
  }

  function tick() {
    const d = store.data;
    if (!d) return;
    const now = new Date();
    let changed = false;

    for (const s of d.schedules) {
      if (!s.enabled) continue;
      if (ensureNext(s, now)) changed = true;
      if (!s.nextRunAt) continue;
      const due = new Date(s.nextRunAt);
      const isAudit = s.kind === 'audit';
      const writer = isAudit ? (d.auditJobs || []).find((j) => j.id === s.jobId) : d.writers.find((w) => w.id === s.writerId);

      // Reminders before the run
      if (!d.settings.paused) {
        for (const r of s.reminders || []) {
          const fireAt = due.getTime() - Number(r) * MIN;
          const key = `${s.id}|${s.nextRunAt}|${r}`;
          if (now.getTime() >= fireAt && now < due && !d.fired[key]) {
            d.fired[key] = now.toISOString();
            changed = true;
            const mins = Math.max(1, Math.round((due - now) / MIN));
            const at = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            if (isAudit) {
              notify(`Site audit coming up in ${formatMinutes(mins)}`,
                `"${s.name}" will check ${writer && writer.siteUrl ? writer.siteUrl : 'your site'} at ${at}${writer && writer.mode === 'full' ? ' and apply changes automatically' : ''}.`);
            } else {
              notify(`Article coming up in ${formatMinutes(mins)}`, `"${s.name}" will write with ${writer ? writer.name : 'its writer'} at ${at}.`);
            }
          }
        }
      }

      // The run itself
      if (now >= due && !running.has(s.id)) {
        const lateMs = now - due;
        const windowMs = (Number(d.settings.catchUpWindowHours) || 6) * HOUR;
        const onTime = lateMs < 5 * MIN;
        const shouldRun = !d.settings.paused && (onTime || (d.settings.catchUpMissed && lateMs <= windowMs));

        s.lastRunAt = now.toISOString();
        if (s.type === 'once') {
          s.enabled = false;
          s.nextRunAt = null;
        } else {
          const n = computeNext(s, now);
          s.nextRunAt = n ? n.toISOString() : null;
        }
        changed = true;

        if (shouldRun) {
          if (!onTime) store.log('info', `Catching up "${s.name}", which was due at ${due.toLocaleString()} while the computer was off or asleep.`);
          running.add(s.id);
          Promise.resolve(runSchedule(s))
            .catch(() => {})
            .finally(() => { running.delete(s.id); onChange(); });
        } else if (d.settings.paused) {
          store.log('missed', `Skipped "${s.name}" because schedules are paused.`);
        } else {
          store.log('missed', `Skipped "${s.name}". It was due at ${due.toLocaleString()} and the computer was off or asleep longer than the catch-up window.`);
        }
      }
    }

    // Forget reminder records older than 3 days
    const cutoff = Date.now() - 3 * 24 * HOUR;
    for (const [k, v] of Object.entries(d.fired)) {
      if (new Date(v).getTime() < cutoff) { delete d.fired[k]; changed = true; }
    }

    if (changed) { store.save(); onChange(); }
  }

  function upcoming(hours = 48) {
    const d = store.data;
    const now = new Date();
    const horizon = now.getTime() + hours * HOUR;
    const items = [];
    for (const s of d.schedules) {
      if (!s.enabled) continue;
      const isAudit = s.kind === 'audit';
      const writer = isAudit ? (d.auditJobs || []).find((j) => j.id === s.jobId) : d.writers.find((w) => w.id === s.writerId);
      let occ = [];
      if (s.nextRunAt) {
        const first = new Date(s.nextRunAt);
        occ = [first, ...occurrences(s, 200, first)].filter((t, i, a) => a.findIndex((x) => +x === +t) === i);
      } else {
        occ = occurrences(s, 200, now);
      }
      for (const t of occ) {
        if (t.getTime() > horizon) break;
        items.push({ kind: 'run', type: isAudit ? 'audit' : 'article', at: t.toISOString(), scheduleId: s.id, scheduleName: s.name, writerName: writer ? (isAudit ? writer.siteUrl || writer.name : writer.name) : 'Missing', mode: isAudit && writer ? writer.mode : null, count: s.count || 1 });
        for (const r of s.reminders || []) {
          const ra = t.getTime() - Number(r) * MIN;
          if (ra >= now.getTime() && ra <= horizon) {
            items.push({ kind: 'reminder', type: isAudit ? 'audit' : 'article', at: new Date(ra).toISOString(), minutes: Number(r), scheduleId: s.id, scheduleName: s.name, writerName: writer ? writer.name : '' });
          }
        }
      }
    }
    return items.sort((a, b) => new Date(a.at) - new Date(b.at));
  }

  return {
    start() { tick(); timer = setInterval(tick, 15000); },
    stop() { clearInterval(timer); },
    tick,
    reset,
    upcoming,
    isRunning: (id) => running.has(id)
  };
}

function formatMinutes(m) {
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} hour${h === 1 ? '' : 's'}`;
}

module.exports = { createScheduler, computeNext, occurrences };
