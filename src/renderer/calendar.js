/* global S, esc, render, toast, fmtRel, VIEWS, ACTIONS, api, modal, modalRoot, closeModal, confirmModal, cleanErr */

// A scheduling calendar: month grid + agenda, events with a meeting link, and
// reminders (handled in the main process). Local to RCWriter.
const REMIND_OPTS = [[0, 'At start'], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour'], [1440, '1 day']];
let calMonth = null; // 'YYYY-MM' of the month being viewed

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function monthKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function eventsByDate() {
  const map = {};
  for (const e of S.events || []) { (map[e.date] = map[e.date] || []).push(e); }
  for (const k of Object.keys(map)) map[k].sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
  return map;
}

function viewCalendar() {
  if (!calMonth) calMonth = monthKey(new Date());
  const [yy, mm] = calMonth.split('-').map(Number);
  const first = new Date(yy, mm - 1, 1);
  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const startDow = first.getDay(); // 0 Sun
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const today = ymd(new Date());
  const byDate = eventsByDate();

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${yy}-${pad2(mm)}-${pad2(day)}`;
    const evs = byDate[date] || [];
    const chips = evs.slice(0, 4).map((e) => `<button class="cal-event${e.link ? ' has-link' : ''}" data-action="event-edit" data-id="${esc(e.id)}" title="${esc(e.title)}">${e.start ? `<span class="t">${esc(e.start)}</span> ` : ''}${esc(e.title)}</button>`).join('');
    const more = evs.length > 4 ? `<span class="muted small">+${evs.length - 4} more</span>` : '';
    cells.push(`<div class="cal-cell${date === today ? ' today' : ''}" data-action="event-new-on" data-date="${date}">
      <div class="cal-day"><span>${day}</span></div>
      <div class="cal-events">${chips}${more}</div></div>`);
  }

  const agenda = (calUpcoming()).map((e) => `
    <div class="row"><div>
      <div class="title">${esc(e.title)}</div>
      <div class="meta">${esc(prettyWhen(e))}${e.location ? ` · ${esc(e.location)}` : ''}${e.clientId ? ` · ${esc(clientNameFor(e.clientId))}` : ''}</div>
    </div><div class="btn-row">
      ${e.link ? `<button class="btn primary" data-action="event-join" data-url="${esc(e.link)}">Join</button>` : ''}
      <button class="btn ghost" data-action="event-edit" data-id="${esc(e.id)}">Edit</button>
    </div></div>`).join('');

  return `
    <div class="page-head"><div><h1>Calendar</h1><p class="sub">Your meetings and schedules, with reminders. Add a Google Meet or any link and RCWriter tells you before it starts.</p></div>
      <div class="btn-row"><button class="btn primary" data-action="event-new">New event</button></div></div>
    <div class="cal-bar">
      <button class="btn ghost" data-action="cal-prev" aria-label="Previous month">‹</button>
      <strong>${esc(monthName)}</strong>
      <button class="btn ghost" data-action="cal-next" aria-label="Next month">›</button>
      <button class="btn ghost small" data-action="cal-today">Today</button>
    </div>
    <div class="cal-grid cal-head">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>
    <section class="panel" style="margin-top:20px"><h3>Coming up</h3>
      <div class="list">${agenda || '<div class="empty"><p>Nothing scheduled yet. Click a day or “New event”.</p></div>'}</div>
    </section>`;
}

function calUpcoming() {
  const now = Date.now();
  return (S.events || [])
    .map((e) => ({ e, s: new Date(`${e.date}T${e.start || '00:00'}:00`).getTime() }))
    .filter((x) => !isNaN(x.s) && x.s >= now - 60 * 60000)
    .sort((a, b) => a.s - b.s).slice(0, 8).map((x) => x.e);
}
function clientNameFor(id) { return (S.clients.find((c) => c.id === id) || {}).name || ''; }
function prettyWhen(e) {
  try {
    const d = new Date(`${e.date}T${e.start || '00:00'}:00`);
    return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${e.start || ''}${e.end ? `–${e.end}` : ''}`;
  } catch { return `${e.date} ${e.start || ''}`; }
}

function openEventModal(ev) {
  const e = ev ? { ...ev } : { title: '', date: ymd(new Date()), start: '09:00', end: '', link: '', location: '', notes: '', clientId: '', remind: [10] };
  const remind = new Set((e.remind || []).map(Number));
  modal = { type: 'event', id: ev ? ev.id : null };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${ev ? 'Edit event' : 'New event'}</h2></header>
      <div class="body">
        <div class="field"><label for="ev-title">Title</label><input type="text" id="ev-title" value="${esc(e.title)}" placeholder="Client call — Acme"></div>
        <div class="grid-3">
          <div class="field"><label for="ev-date">Date</label><input type="date" id="ev-date" value="${esc(e.date)}"></div>
          <div class="field"><label for="ev-start">Start</label><input type="time" id="ev-start" value="${esc(e.start)}"></div>
          <div class="field"><label for="ev-end">End</label><input type="time" id="ev-end" value="${esc(e.end || '')}"></div>
        </div>
        <div class="field"><label for="ev-link">Meeting link</label><input type="url" id="ev-link" value="${esc(e.link || '')}" placeholder="https://meet.google.com/abc-defg-hij"></div>
        <div class="field"><label for="ev-loc">Location (optional)</label><input type="text" id="ev-loc" value="${esc(e.location || '')}" placeholder="Office, phone, Zoom…"></div>
        <div class="field"><label for="ev-client">Client (optional)</label><select id="ev-client"><option value="">None</option>${(S.clients || []).map((c) => `<option value="${c.id}" ${e.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><span class="label">Remind me</span><div class="chips">${REMIND_OPTS.map(([m, l]) => `<label class="check inline-check"><input type="checkbox" name="ev-remind" value="${m}" ${remind.has(m) ? 'checked' : ''}><span>${l}${m === 0 ? '' : ' before'}</span></label>`).join('')}</div></div>
        <div class="field"><label for="ev-notes">Notes</label><textarea id="ev-notes" rows="3">${esc(e.notes || '')}</textarea></div>
      </div>
      <footer>${ev ? '<button class="btn ghost danger" data-action="event-delete" data-id="' + esc(ev.id) + '">Delete</button>' : '<span></span>'}
        <div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="event-save">${ev ? 'Save' : 'Add event'}</button></div></footer>
    </div></div>`;
}

VIEWS.calendar = viewCalendar;

function shiftMonth(delta) {
  const [yy, mm] = (calMonth || '').split('-').map(Number);
  const d = new Date(yy, mm - 1 + delta, 1);
  calMonth = monthKey(d);
  render();
}

Object.assign(ACTIONS, {
  'cal-prev': () => shiftMonth(-1),
  'cal-next': () => shiftMonth(1),
  'cal-today': () => { calMonth = monthKey(new Date()); render(); },
  'event-new': () => openEventModal(null),
  'event-new-on': (el, e) => { if (e && e.target.closest('.cal-event')) return; const ev = { date: el.dataset.date }; openEventModal(ev); },
  'event-edit': (el, e) => { if (e) e.stopPropagation(); openEventModal((S.events || []).find((x) => x.id === el.dataset.id)); },
  'event-join': (el) => api.openLink(el.dataset.url),
  'event-save': async () => {
    const v = (id) => modalRoot.querySelector(id).value;
    const remind = [...modalRoot.querySelectorAll('[name=ev-remind]:checked')].map((x) => Number(x.value));
    try {
      await api.saveEvent({ id: modal.id || undefined, title: v('#ev-title'), date: v('#ev-date'), start: v('#ev-start'), end: v('#ev-end'), link: v('#ev-link'), location: v('#ev-loc'), clientId: v('#ev-client'), notes: v('#ev-notes'), remind });
      toast(modal.id ? 'Event saved' : 'Event added');
      closeModal();
    } catch (err) { toast(cleanErr(err), 'error'); }
  },
  'event-delete': async (el) => {
    if (await confirmModal({ title: 'Delete this event?', body: 'It will be removed from the calendar.', confirm: 'Delete' })) { closeModal(); await api.deleteEvent(el.dataset.id).catch(() => {}); toast('Deleted'); }
  }
});
