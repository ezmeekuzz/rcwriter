// A simple scheduling calendar: the owner puts events (meetings, calls,
// deadlines) on the calendar with a meeting link, and RCWriter fires a desktop
// (and Telegram) notification as each event nears. Everything is stored locally.
function createCalendar({ store, notify, onChange }) {
  const d = () => store.data;
  const uid = store.uid;

  function startMs(ev) {
    if (!ev.date) return NaN;
    return new Date(`${ev.date}T${ev.start || '00:00'}:00`).getTime();
  }

  function save(ev) {
    if (!ev || !ev.title || !ev.title.trim()) throw new Error('Give the event a title.');
    if (!ev.date) throw new Error('Pick a date.');
    const remind = [...new Set((ev.remind || [10]).map(Number).filter((n) => n >= 0))].sort((a, b) => b - a);
    const clean = {
      title: ev.title.trim().slice(0, 200),
      date: ev.date,
      start: ev.start || '09:00',
      end: ev.end || '',
      link: String(ev.link || '').trim().slice(0, 1000),
      location: String(ev.location || '').trim().slice(0, 200),
      notes: String(ev.notes || '').slice(0, 4000),
      clientId: ev.clientId || '',
      remind: remind.length ? remind : [10]
    };
    d().events = d().events || [];
    if (ev.id) {
      const i = d().events.findIndex((x) => x.id === ev.id);
      if (i < 0) throw new Error('Event not found.');
      // Changing the time resets which reminders have fired.
      const prev = d().events[i];
      const timeChanged = prev.date !== clean.date || prev.start !== clean.start;
      d().events[i] = { ...prev, ...clean, reminded: timeChanged ? {} : (prev.reminded || {}) };
    } else {
      d().events.push({ id: uid(), ...clean, reminded: {}, createdAt: new Date().toISOString() });
    }
    store.save();
    if (onChange) onChange();
  }

  function remove(id) {
    d().events = (d().events || []).filter((x) => x.id !== id);
    store.save();
    if (onChange) onChange();
  }

  // Fires reminders that have come due. Called every minute.
  function tick() {
    const now = Date.now();
    let changed = false;
    for (const ev of d().events || []) {
      const s = startMs(ev);
      if (isNaN(s)) continue;
      ev.reminded = ev.reminded || {};
      for (const m of ev.remind || [10]) {
        const key = String(m);
        const fireAt = s - m * 60000;
        // Fire once, only within a sensible window (don't nag about events that already passed).
        if (!ev.reminded[key] && now >= fireAt && now < s + 60000) {
          ev.reminded[key] = true;
          changed = true;
          const mins = Math.round((s - now) / 60000);
          const lead = mins <= 0 ? 'starting now' : mins >= 1440 ? `in ${Math.round(mins / 1440)} day(s)` : mins >= 60 ? `in about ${Math.round(mins / 60)} hour(s)` : `in ${mins} min`;
          const body = `${ev.start}${ev.end ? `–${ev.end}` : ''} ${lead}${ev.link ? '\nClick to open the meeting link.' : ev.location ? `\n${ev.location}` : ''}`;
          try { notify(`📅 ${ev.title}`, body, ev.link || null); } catch { /* ignore */ }
        }
      }
    }
    if (changed) store.save();
  }

  function upcoming(limit = 10) {
    const now = Date.now();
    return (d().events || [])
      .map((e) => ({ e, s: startMs(e) }))
      .filter((x) => !isNaN(x.s) && x.s >= now - 60 * 60000)
      .sort((a, b) => a.s - b.s)
      .slice(0, limit)
      .map((x) => x.e);
  }

  return { save, remove, tick, upcoming };
}

module.exports = { createCalendar };
