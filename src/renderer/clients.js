/* global S, main, modalRoot, esc, cleanErr, toast, attempt, fmtRel, fmtDateTime, confirmModal, closeModal, render, VIEWS, ACTIONS, api */
// Clients group websites (and with them writers, audits, approvals and reports).
// A client picker in the sidebar filters every page to one client.
// Also: the Monitoring tab in Site audits and its settings dialog.

let clientFilter = '';
try { clientFilter = localStorage.getItem('rcw.client') || ''; } catch { /* storage unavailable */ }

const normUrl = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

function siteFor(siteId, siteUrl) {
  return S.sites.find((x) => x.id === siteId) || (siteUrl ? S.sites.find((x) => normUrl(x.url) === normUrl(siteUrl)) : null);
}

function inClient(siteId, siteUrl) {
  if (!clientFilter || !S.clients.find((c) => c.id === clientFilter)) return true;
  const site = siteFor(siteId, siteUrl);
  return !!site && site.clientId === clientFilter;
}

function setClientFilter(id) {
  clientFilter = id || '';
  try { localStorage.setItem('rcw.client', clientFilter); } catch { /* ignore */ }
  render();
}

function clientBanner() {
  const c = clientFilter && S.clients.find((x) => x.id === clientFilter);
  return c ? `<div class="client-banner">Showing <strong>${esc(c.name)}</strong> only. <a href="#" data-action="client-filter" data-id="">Show all clients</a></div>` : '';
}

window.renderClientPick = () => {
  const el = document.getElementById('client-pick');
  if (!el) return;
  if (!S.clients.length) { el.innerHTML = ''; return; }
  if (clientFilter && !S.clients.find((c) => c.id === clientFilter)) clientFilter = '';
  el.innerHTML = `<label class="sr-only" for="client-select">Client</label>
    <select id="client-select" data-change="client-filter" aria-label="Show client">
      <option value="">All clients</option>${S.clients.map((c) => `<option value="${c.id}" ${clientFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>`;
};

// ---------- health ----------
function healthDot(h) {
  const st = h ? h.status : 'off';
  return `<span class="hdot h-${st}" aria-hidden="true"></span>`;
}

function healthText(site) {
  const h = site.health;
  const m = site.monitor || {};
  if (!m.enabled) return 'Monitoring off';
  if (!h || !h.lastCheckAt) return 'Waiting for the first check';
  const bits = [];
  bits.push(h.status === 'up' ? 'Up' : h.status === 'down' ? `Down since ${fmtRel(h.downSince)}` : 'Not checked (host paused direct requests)');
  if (h.uptime24h !== null) bits.push(`${h.uptime24h}% in 24 h`);
  if (h.avgMs) bits.push(`${(h.avgMs / 1000).toFixed(1)} s response`);
  if (h.ssl && h.ssl.daysLeft !== undefined && h.ssl.daysLeft !== null) bits.push(h.ssl.authorized === false ? `SSL problem: ${h.ssl.error}` : `SSL ${h.ssl.daysLeft} days left`);
  if (h.traffic && h.traffic.changePct !== null && h.traffic.changePct !== undefined) bits.push(`clicks ${h.traffic.changePct > 0 ? '+' : ''}${h.traffic.changePct}% week on week`);
  return bits.join(' · ');
}

// ---------- Clients page ----------
function viewClients() {
  const card = (c) => {
    const sites = S.sites.filter((x) => x.clientId === c.id);
    const ids = new Set(sites.map((x) => x.id));
    const writers = S.writers.filter((w) => ids.has(w.siteId));
    const jobs = S.auditJobs.filter((j) => ids.has(j.siteId));
    const pending = S.approvals.filter((a) => a.status === 'pending' && ids.has(a.siteId)).length;
    const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
    const wIds = new Set(writers.map((w) => w.id));
    const articles = S.articles.filter((a) => wIds.has(a.writerId) && new Date(a.createdAt) >= month).length;
    const lastRun = S.auditRuns.find((r) => jobs.some((j) => j.id === r.jobId) && r.status !== 'running');
    return `
      <div class="row writer-row top">
        <div>
          <div class="title">${esc(c.name)}</div>
          ${c.contact || c.email ? `<div class="meta">${esc(c.contact)}${c.contact && c.email ? ', ' : ''}${esc(c.email)}</div>` : ''}
          <div class="client-sites">${sites.map((x) => `<div>${healthDot(x.monitor && x.monitor.enabled ? x.health : null)}<strong>${esc(x.name)}</strong> <span class="muted small">${esc(healthText(x))}</span></div>`).join('') || '<span class="muted small">No websites yet. Edit the client to add them.</span>'}</div>
          <div class="meta">${writers.length} writer${writers.length === 1 ? '' : 's'}, ${articles} article${articles === 1 ? '' : 's'} this month · ${jobs.length} audit${jobs.length === 1 ? '' : 's'}${lastRun ? `, last ${fmtRel(lastRun.finishedAt || lastRun.startedAt)}` : ''}${pending ? ` · <strong>${pending} waiting for approval</strong>` : ''}</div>
          ${c.notes ? `<div class="meta">${esc(c.notes)}</div>` : ''}
        </div>
        <div class="btn-row">
          <button class="btn" data-action="client-filter" data-id="${c.id}">Show only this client</button>
          ${S.googleUser && S.googleUser.gmail && c.email ? `<button class="btn ghost" data-action="client-weekly" data-id="${c.id}">Weekly update draft</button>` : ''}
          <button class="btn ghost" data-action="client-edit" data-id="${c.id}">Edit</button>
          <button class="btn ghost danger" data-action="client-delete" data-id="${c.id}">Delete</button>
        </div>
      </div>`;
  };
  const unassigned = S.sites.filter((x) => !x.clientId || !S.clients.find((c) => c.id === x.clientId));
  return `
    <div class="page-head">
      <div><h1>Clients</h1><p class="sub">Group websites by client. Choose a client in the sidebar to see only their writers, audits, approvals and reports.</p></div>
      <button class="btn primary" data-action="client-new">New client</button>
    </div>
    <div class="list">${S.clients.map(card).join('') || '<div class="empty"><p>No clients yet.</p><button class="btn primary" data-action="client-new">Add your first client</button></div>'}</div>
    ${unassigned.length && S.clients.length ? `<h2>Websites without a client</h2><p class="muted small">${unassigned.map((x) => esc(x.name)).join(', ')}. Edit a client to add them.</p>` : ''}`;
}

function openClientModal(c) {
  const d = c ? { ...c } : { name: '', contact: '', email: '', notes: '' };
  modal = { type: 'client', id: c ? c.id : null };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${c ? `Edit ${esc(c.name)}` : 'New client'}</h2></header>
      <div class="body">
        <div class="field"><label for="cl-name">Name</label><input type="text" id="cl-name" value="${esc(d.name)}" placeholder="Eco Pro Properties"></div>
        <div class="grid-2">
          <div class="field"><label for="cl-contact">Contact person</label><input type="text" id="cl-contact" value="${esc(d.contact)}"></div>
          <div class="field"><label for="cl-email">Email addresses</label><input type="text" id="cl-email" value="${esc(d.email)}" placeholder="dan@ecopro.co.uk, office@ecopro.co.uk"></div>
        </div>
        <div class="field"><span class="label">Websites</span>
          <div class="checks col">${S.sites.map((x) => `<label class="check"><input type="checkbox" name="cl-site" value="${x.id}" ${c && x.clientId === c.id ? 'checked' : ''}><span>${esc(x.name)} <span class="muted small">${esc(x.url)}${x.clientId && (!c || x.clientId !== c.id) && S.clients.find((k) => k.id === x.clientId) ? `, now with ${esc(S.clients.find((k) => k.id === x.clientId).name)}` : ''}</span></span></label>`).join('') || '<span class="muted small">Add websites first.</span>'}</div></div>
        <div class="field"><label for="cl-notes">Notes</label><textarea id="cl-notes" placeholder="Reporting day, goals, things never to change…">${esc(d.notes)}</textarea><span class="hint">The AI reads these when it writes reports and emails for this client.</span></div>
        <fieldset><legend>Automations</legend>
          <label class="check"><input type="checkbox" id="cl-mr" ${d.monthlyReport && d.monthlyReport.enabled ? 'checked' : ''}><span><strong>Monthly SEO report</strong> (Word and PDF, saved on this computer)</span></label>
          <div class="grid-2" style="margin-left:26px"><div class="field"><label for="cl-mr-day">On day of the month</label><input type="number" id="cl-mr-day" min="1" max="28" value="${esc((d.monthlyReport && d.monthlyReport.day) || 1)}"></div>
            <div class="field"><label for="cl-mr-time">At</label><input type="time" id="cl-mr-time" value="${esc((d.monthlyReport && d.monthlyReport.time) || '09:00')}"></div></div>
          <label class="check"><input type="checkbox" id="cl-wu" ${d.weeklyUpdate && d.weeklyUpdate.enabled ? 'checked' : ''}><span><strong>Weekly update email</strong> (saved as a Gmail draft for you to send)</span></label>
          <div class="grid-2" style="margin-left:26px"><div class="field"><label for="cl-wu-day">Day</label><select id="cl-wu-day">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<option value="${i}" ${Number((d.weeklyUpdate && d.weeklyUpdate.day) ?? 5) === i ? 'selected' : ''}>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}</option>`).join('')}</select></div>
            <div class="field"><label for="cl-wu-time">At</label><input type="time" id="cl-wu-time" value="${esc((d.weeklyUpdate && d.weeklyUpdate.time) || '16:00')}"></div></div>
          <label class="check"><input type="checkbox" id="cl-et" ${d.emailTasks !== false ? 'checked' : ''}><span><strong>Turn this client's emails into tasks</strong> (from the email addresses above)</span></label>
          ${S.googleUser && S.googleUser.gmail ? '' : '<p class="hint">Emails need Gmail connected in Settings.</p>'}
        </fieldset>
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="client-save">${c ? 'Save' : 'Add client'}</button></div></footer>
    </div></div>`;
  modalRoot.querySelector('#cl-name').focus();
}

// ---------- Monitoring tab ----------
window.monitoringTab = () => {
  const sites = S.sites.filter((x) => x.type !== 'webhook' && inClient(x.id));
  if (!sites.length) return '<div class="list"><div class="empty"><p>Add a website first.</p></div></div>';
  const rows = sites.map((x) => {
    const m = x.monitor || {};
    const h = x.health || {};
    const t = h.traffic;
    return `
      <div class="row writer-row top">
        <div>
          <div class="title">${healthDot(m.enabled ? h : null)}${esc(x.name)} <span class="muted small" style="font-weight:400">${esc(x.url)}</span></div>
          <div class="meta">${esc(healthText(x))}${h.lastCheckAt ? ` · checked ${fmtRel(h.lastCheckAt)}` : ''}</div>
          ${m.enabled ? `<div class="meta">${[m.uptime && `uptime every ${m.intervalMin} min`, m.ssl && `SSL warning ${m.sslDays} days ahead`, m.traffic && (x.google && x.google.gscSite ? `traffic alert at ${m.dropPct}% drop` : 'traffic alerts need Search Console linked'), m.onDropJobId && `then runs "${esc((S.auditJobs.find((j) => j.id === m.onDropJobId) || {}).name || 'a removed audit')}"`].filter(Boolean).join(' · ')}</div>` : ''}
          ${t && t.losers && t.losers.length && t.changePct < 0 ? `<div class="meta">Biggest drops: ${t.losers.slice(0, 3).map((l) => `${esc(l.page.replace(/^https?:\/\/[^/]+/, '') || '/')} (${l.before} → ${l.now})`).join(', ')}</div>` : ''}
          ${t && t.error ? `<div class="meta err">Search Console: ${esc(t.error)}</div>` : ''}
        </div>
        <div class="btn-row">
          ${m.enabled ? `<button class="btn" data-action="monitor-check" data-id="${x.id}" ${h.busy ? 'disabled' : ''}>${h.busy ? 'Checking…' : 'Check now'}</button>` : ''}
          <button class="btn ${m.enabled ? 'ghost' : 'primary'}" data-action="monitor-edit" data-id="${x.id}">${m.enabled ? 'Settings' : 'Turn on'}</button>
        </div>
      </div>`;
  }).join('');
  return `<p class="muted small" style="margin-top:0;max-width:80ch">RCWriter checks each monitored site from this computer while it's on: one gentle request per check, through the same pacing that keeps hosts from flagging it. SSL is checked with a quick secure handshake that doesn't load any page. Traffic alerts compare Search Console clicks for the last 7 days with the 7 before, and can start an audit by themselves.</p>
    <div class="list">${rows}</div>`;
};

function openMonitorModal(siteId) {
  const site = S.sites.find((x) => x.id === siteId);
  const m = { ...site.monitor };
  const gsc = site.google && site.google.gscSite;
  modal = { type: 'monitor', siteId };
  const jobs = S.auditJobs.filter((j) => j.siteId === siteId || !j.siteId);
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">Monitoring for ${esc(site.name)}</h2></header>
      <div class="body">
        <label class="check"><input type="checkbox" id="mo-on" ${m.enabled ? 'checked' : ''}><span><strong>Monitor this website</strong></span></label>
        <fieldset><legend>Is it up?</legend>
          <label class="check"><input type="checkbox" id="mo-up" ${m.uptime ? 'checked' : ''}><span>Tell me when the site goes down and when it's back</span></label>
          <div class="field" style="max-width:260px"><label for="mo-int">Check every</label><select id="mo-int">${[15, 30, 60, 120, 360].map((n) => `<option value="${n}" ${Number(m.intervalMin) === n ? 'selected' : ''}>${n < 60 ? `${n} minutes` : `${n / 60} hour${n > 60 ? 's' : ''}`}</option>`).join('')}</select>
            <span class="hint">A failed check is repeated after 2 minutes before you're told, to avoid false alarms.</span></div>
        </fieldset>
        <fieldset><legend>SSL certificate</legend>
          <label class="check"><input type="checkbox" id="mo-ssl" ${m.ssl ? 'checked' : ''}><span>Warn me before the certificate expires or if it's invalid</span></label>
          <div class="field" style="max-width:260px"><label for="mo-days">Warn this many days ahead</label><input type="number" id="mo-days" min="1" max="60" value="${esc(m.sslDays)}"></div>
        </fieldset>
        <fieldset><legend>Traffic drops</legend>
          ${gsc ? '' : '<p class="warn small">Link this site\'s Search Console in Websites, Google data, to use traffic alerts.</p>'}
          <label class="check"><input type="checkbox" id="mo-tr" ${m.traffic ? 'checked' : ''}><span>Alert me when Search Console clicks fall week on week</span></label>
          <div class="grid-3">
            <div class="field"><label for="mo-drop">Drop of at least (%)</label><input type="number" id="mo-drop" min="5" max="95" value="${esc(m.dropPct)}"></div>
            <div class="field"><label for="mo-min">If the week before had at least (clicks)</label><input type="number" id="mo-min" min="0" value="${esc(m.minClicks)}"></div>
            <div class="field"><label for="mo-time">Check daily at</label><input type="time" id="mo-time" value="${esc(m.trafficTime)}"></div>
          </div>
          <div class="field"><label for="mo-job">When traffic drops, also run</label><select id="mo-job"><option value="">Just alert me</option>${jobs.map((j) => `<option value="${j.id}" ${m.onDropJobId === j.id ? 'selected' : ''}>${esc(j.name)}</option>`).join('')}</select>
            <span class="hint">The audit starts with the drop and the pages that lost the most clicks, so it can investigate and, depending on its autonomy, refresh those posts. ${jobs.length ? '' : 'Create an audit for this site first, for example "Refresh posts that are losing traffic".'}</span></div>
        </fieldset>
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="monitor-save">Save</button></div></footer>
    </div></div>`;
}

VIEWS.clients = viewClients;

Object.assign(ACTIONS, {
  'client-new': () => openClientModal(null),
  'client-edit': (el) => openClientModal(S.clients.find((c) => c.id === el.dataset.id)),
  'client-save': async () => {
    const v = (id) => modalRoot.querySelector(id).value;
    const siteIds = [...modalRoot.querySelectorAll('[name=cl-site]:checked')].map((x) => x.value);
    try {
      const q = (id) => modalRoot.querySelector(id);
      await api.saveClient({ id: modal.id, name: v('#cl-name'), contact: v('#cl-contact'), email: v('#cl-email'), notes: v('#cl-notes'), siteIds,
        monthlyReport: { enabled: q('#cl-mr').checked, day: Number(v('#cl-mr-day')) || 1, time: v('#cl-mr-time') || '09:00' },
        weeklyUpdate: { enabled: q('#cl-wu').checked, day: Number(v('#cl-wu-day')), time: v('#cl-wu-time') || '16:00' }, emailTasks: q('#cl-et').checked });
      toast(modal.id ? 'Client saved' : 'Client added');
      closeModal();
    } catch (e) { toast(cleanErr(e), 'error'); }
  },
  'client-delete': async (el) => {
    const c = S.clients.find((x) => x.id === el.dataset.id);
    if (await confirmModal({ title: `Delete ${c.name}?`, body: 'Their websites, writers, audits and reports are kept; the websites just won\'t belong to a client.', confirm: 'Delete client' })) {
      closeModal();
      await attempt(() => api.deleteClient(c.id), 'Client deleted');
    }
  },
  'client-filter': (el, e) => { if (e) e.preventDefault(); setClientFilter(el.dataset.id); },
  'monitor-edit': (el) => openMonitorModal(el.dataset.id),
  'monitor-check': async (el) => {
    el.disabled = true; el.textContent = 'Checking…';
    try { await api.checkSiteNow(el.dataset.id); toast('Checked'); } catch (e) { toast(cleanErr(e), 'error'); }
  },
  'monitor-save': async () => {
    const q = (id) => modalRoot.querySelector(id);
    const cfg = { enabled: q('#mo-on').checked, uptime: q('#mo-up').checked, intervalMin: Number(q('#mo-int').value), ssl: q('#mo-ssl').checked, sslDays: Number(q('#mo-days').value),
      traffic: q('#mo-tr').checked, dropPct: Number(q('#mo-drop').value), minClicks: Number(q('#mo-min').value), trafficTime: q('#mo-time').value || '07:30', onDropJobId: q('#mo-job').value };
    try { await api.setSiteMonitor(modal.siteId, cfg); toast(cfg.enabled ? 'Monitoring on' : 'Monitoring off'); closeModal(); } catch (e) { toast(cleanErr(e), 'error'); }
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change === 'client-filter') setClientFilter(el.value);
  if (el.dataset.change === 'site-client') attempt(() => api.setSiteClient(el.dataset.id, el.value), 'Client saved');
});
