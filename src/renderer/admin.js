/* global S, main, modalRoot, esc, cleanErr, toast, attempt, fmtRel, fmtDateTime, confirmModal, closeModal, render, VIEWS, ACTIONS, api,
   inClient, clientBanner, renderMarkdown, PROVIDER_SHORT, DAY_NAMES */
// Tasks, client reports, the daily digest, Gmail and Google Business Profile.

let taskFilter = 'open';
const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const SOURCE_LABEL = { audit: 'From an audit', email: 'From an email', manual: 'Added by you', monitor: 'From monitoring' };
const todayIso = () => new Date().toLocaleDateString('en-CA');
const clientName = (id) => (S.clients.find((c) => c.id === id) || {}).name || '';
/* global clientFilter */
const inClientId = (id) => !clientFilter || !S.clients.find((c) => c.id === clientFilter) || clientFilter === id;
const taskVisible = (t) => !clientFilter || !S.clients.find((c) => c.id === clientFilter) || t.clientId === clientFilter || (t.siteId && inClient(t.siteId));

// ---------- Tasks ----------
function viewTasks() {
  const all = S.tasks.filter((t) => {
    if (!taskVisible(t)) return false;
    if (taskFilter === 'open') return t.status !== 'done';
    if (taskFilter === 'done') return t.status === 'done';
    if (taskFilter === 'due') return t.status !== 'done' && t.due && t.due <= todayIso();
    return true;
  });
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = taskFilter === 'done' ? all : [...all].sort((a, b) => (a.status === 'doing' ? -1 : 0) - (b.status === 'doing' ? -1 : 0) || (order[a.priority] ?? 1) - (order[b.priority] ?? 1) || String(a.due || '9999').localeCompare(String(b.due || '9999')));
  const rows = sorted.map((t) => {
    const overdue = t.status !== 'done' && t.due && t.due < todayIso();
    const site = S.sites.find((x) => x.id === t.siteId);
    return `
      <div class="row task-row ${t.status === 'done' ? 'done' : ''}">
        <input type="checkbox" data-change="task-done" data-id="${t.id}" ${t.status === 'done' ? 'checked' : ''} aria-label="Done: ${esc(t.title)}">
        <div>
          <div class="title">${esc(t.title)} <span class="chip pr-${t.priority}">${PRIORITY_LABEL[t.priority] || t.priority}</span>${t.status === 'doing' ? ' <span class="chip">In progress</span>' : ''}</div>
          <div class="meta">${[clientName(t.clientId), site && site.name, SOURCE_LABEL[t.source], t.emailFromName && `from ${t.emailFromName}`, t.due && `${overdue ? '<span class="err">overdue, ' : 'due '}${esc(t.due)}${overdue ? '</span>' : ''}`, `added ${fmtRel(t.createdAt)}`].filter(Boolean).map((x) => (String(x).startsWith('<') || /^(due|<span)/.test(x) ? x : esc(x))).join(' · ')}</div>
          ${t.notes ? `<details class="detail"><summary>Notes</summary><p class="small" style="white-space:pre-wrap">${esc(t.notes)}</p></details>` : ''}
        </div>
        <div class="btn-row">
          ${t.emailThreadId ? `<button class="btn" data-action="task-reply" data-id="${t.id}">${t.replyDraftAt ? 'Draft again' : 'Draft reply'}</button><button class="btn ghost" data-action="link" data-url="${esc(t.link)}">Open email</button>` : ''}
          ${t.status === 'todo' ? `<button class="btn ghost" data-action="task-doing" data-id="${t.id}">Start</button>` : ''}
          <button class="btn ghost" data-action="task-edit" data-id="${t.id}">Edit</button>
          <button class="btn ghost danger" data-action="task-delete" data-id="${t.id}" aria-label="Delete task">Delete</button>
        </div>
      </div>`;
  }).join('');
  const open = S.tasks.filter((t) => t.status !== 'done').length;
  const due = S.tasks.filter((t) => t.status !== 'done' && t.due && t.due <= todayIso()).length;
  const done = S.tasks.filter((t) => t.status === 'done').length;
  return `
    <div class="page-head">
      <div><h1>Tasks</h1><p class="sub">Everything to do in one place: fixes from audits, requests from client emails, and your own tasks.</p></div>
      <div class="btn-row">${S.googleUser.gmail ? '<button class="btn" data-action="gmail-scan">Check client emails</button>' : ''}<button class="btn primary" data-action="task-new">New task</button></div>
    </div>
    ${clientBanner()}
    <div class="seg tabs" role="tablist">${[['open', `Open (${open})`], ['due', `Due (${due})`], ['done', `Done (${done})`], ['all', 'All']].map(([k, l]) => `<button role="tab" class="${taskFilter === k ? 'on' : ''}" data-action="task-filter" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="list">${rows || `<div class="empty"><p>${taskFilter === 'done' ? 'Nothing done yet.' : 'No tasks here.'}</p>${S.googleUser.gmail ? '' : '<p class="muted small">Connect Gmail in Settings and add client email addresses to turn their requests into tasks automatically.</p>'}</div>`}</div>
    ${taskFilter === 'done' && done ? '<div class="btn-row" style="margin-top:12px"><button class="btn ghost danger" data-action="task-clear-done">Clear done tasks</button></div>' : ''}`;
}

function openTaskModal(t) {
  const d = t ? { ...t } : { title: '', notes: '', priority: 'medium', due: '', clientId: '', siteId: '' };
  modal = { type: 'task', id: t ? t.id : null };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${t ? 'Edit task' : 'New task'}</h2></header>
      <div class="body">
        <div class="field"><label for="tk-title">Task</label><input type="text" id="tk-title" value="${esc(d.title)}" placeholder="Fix the contact form on the homepage"></div>
        <div class="grid-2">
          <div class="field"><label for="tk-pr">Priority</label><select id="tk-pr">${Object.entries(PRIORITY_LABEL).map(([k, l]) => `<option value="${k}" ${d.priority === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label for="tk-due">Due</label><input type="date" id="tk-due" value="${esc(d.due || '')}"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="tk-client">Client</label><select id="tk-client"><option value="">None</option>${S.clients.map((c) => `<option value="${c.id}" ${d.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="tk-site">Website</label><select id="tk-site"><option value="">None</option>${S.sites.map((x) => `<option value="${x.id}" ${d.siteId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label for="tk-notes">Notes</label><textarea id="tk-notes">${esc(d.notes || '')}</textarea></div>
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="task-save">${t ? 'Save' : 'Add task'}</button></div></footer>
    </div></div>`;
  modalRoot.querySelector('#tk-title').focus();
}

// ---------- Reports ----------
function viewReports() {
  const list = S.reports.filter((r) => !r.clientId || inClientId(r.clientId)).map((r) => `
    <div class="row writer-row">
      <div><div class="title">${esc(r.clientName)}: ${esc(r.period)} ${r.kind === 'newsletter' ? `newsletter, "${esc(r.subject || '')}"` : 'SEO report'}</div>
        <div class="meta">Created ${fmtRel(r.createdAt)}${r.summary ? ` · ${esc(String(r.summary).slice(0, 160))}${r.summary.length > 160 ? '…' : ''}` : ''}</div></div>
      <div class="btn-row">
        ${r.files.pdf ? `<button class="btn" data-action="report-open" data-id="${r.id}" data-fmt="pdf">Open PDF</button>` : ''}
        ${r.files.docx ? `<button class="btn" data-action="report-open" data-id="${r.id}" data-fmt="docx">Open Word</button>` : ''}
        ${r.files.html ? `<button class="btn" data-action="report-open" data-id="${r.id}" data-fmt="html">Open</button>` : ''}
        ${r.mailchimp && r.mailchimp.url ? `<button class="btn" data-action="link" data-url="${esc(r.mailchimp.url)}">Edit in Mailchimp</button>` : ''}
        <button class="btn ghost" data-action="report-reveal" data-id="${r.id}">Show in folder</button>
      </div>
    </div>`).join('');
  const clients = S.clients.filter((c) => inClientId(c.id));
  return `
    <div class="page-head"><div><h1>Client reports</h1><p class="sub">Monthly SEO reports in Word and PDF (an executive summary, key results against the month before, achievements, work completed and next month's plan) and monthly newsletters. Turn on automatic reports and newsletters for each client in Clients.</p></div></div>
    ${clientBanner()}
    ${clients.length ? `<section class="panel" style="max-width:none"><h3>Create a report now</h3>
      <div class="report-make">${clients.map((c) => `<div><strong>${esc(c.name)}</strong>${c.monthlyReport && c.monthlyReport.enabled ? ` <span class="muted small">automatic on day ${esc(c.monthlyReport.day || 1)}</span>` : ''}
        <span class="btn-row"><button class="btn" data-action="report-make" data-id="${c.id}" data-offset="-1">Last month</button><button class="btn ghost" data-action="report-make" data-id="${c.id}" data-offset="0">This month so far</button><button class="btn ghost" data-action="newsletter-make" data-id="${c.id}">Newsletter</button></span></div>`).join('')}</div>
      <p class="muted small">Uses Search Console and GA4 linked to each client's websites, plus the articles, fixes, audits and tasks RCWriter recorded. The written parts use your Assistant AI (Settings).</p></section>`
      : '<div class="list"><div class="empty"><p>Add a client first. Reports are made per client.</p><button class="btn primary" data-action="nav" data-view="clients">Go to Clients</button></div></div>'}
    <h2>Saved reports</h2>
    <div class="list">${list || '<div class="empty"><p>No reports yet.</p></div>'}</div>`;
}

// ---------- digest on Today ----------
function digestPanel() {
  const dg = S.digests[0];
  if (!dg && !(S.settings.digest && S.settings.digest.enabled)) return '';
  return `<section class="panel digest" style="max-width:none">
    <details ${dg && Date.now() - new Date(dg.at) < 12 * 36e5 ? 'open' : ''}><summary><strong>Daily digest</strong> <span class="muted small">${dg ? fmtRel(dg.at) : 'not run yet'}</span></summary>
    ${dg ? `<div class="digest-body">${renderMarkdown(dg.markdown.replace(/^# .*\n/, ''))}</div>` : ''}</details>
    <button class="btn ghost small" data-action="digest-run">Run digest now</button></section>`;
}

// ---------- Settings additions ----------
function adminSettings() {
  const g = S.googleUser || {};
  const dg = S.settings.digest || {};
  const gm = S.settings.gmail || {};
  const a = S.assistantAi || {};
  return `
    <section class="panel">
      <h3>Gmail and Google Business Profile</h3>
      <p class="muted small">Sign in with your own Google account through your Google Cloud OAuth client (the same "Desktop app" client you can use for Search Console). In Google Cloud, enable the <strong>Gmail API</strong>, and for reviews and posts the <strong>My Business</strong> APIs. Google gives Business Profile APIs no quota until you request access for your project.</p>
      ${g.connected ? `<p class="provider-state ok">Signed in as ${esc(g.email)}. ${g.gmail ? 'Gmail: on.' : 'Gmail: off.'} ${g.gbp ? 'Business Profile: on.' : 'Business Profile: off.'}</p>` : '<p class="provider-state muted">Not signed in.</p>'}
      <div class="grid-2">
        <div class="field"><label for="gu-id">OAuth client ID</label><input type="text" id="gu-id" value="${esc(g.clientId || (S.google && S.google.clientId) || '')}" placeholder="…apps.googleusercontent.com"></div>
        <div class="field"><label for="gu-secret">Client secret</label><input type="password" id="gu-secret" placeholder="${g.connected ? 'Saved' : ''}" autocomplete="off"></div>
      </div>
      <div class="checks"><label class="check"><input type="checkbox" id="gu-gmail" ${g.connected ? (g.gmail ? 'checked' : '') : 'checked'}><span>Gmail (read client emails, create drafts, send the digest to me)</span></label>
        <label class="check"><input type="checkbox" id="gu-gbp" ${g.gbp ? 'checked' : ''}><span>Google Business Profile (review replies and posts)</span></label></div>
      <div class="btn-row"><button class="btn primary" data-action="gu-signin">${g.connected ? 'Sign in again' : 'Sign in with Google'}</button>${g.connected ? '<button class="btn ghost danger" data-action="gu-disconnect">Disconnect</button>' : ''}</div>
    </section>
    <section class="panel">
      <h3>Daily digest</h3>
      <label class="check"><input type="checkbox" data-setting-obj="digest.enabled" ${dg.enabled ? 'checked' : ''}><span><strong>Send me a digest every morning</strong><br><span class="muted small">What was written, audited, fixed and broken since yesterday, what's waiting for approval, and tasks that are due.</span></span></label>
      <div class="grid-2"><div class="field"><label for="dg-time">Time</label><input type="time" id="dg-time" data-setting-obj="digest.time" value="${esc(dg.time || '08:00')}"></div>
      <div class="field"><span class="label">&nbsp;</span><label class="check"><input type="checkbox" data-setting-obj="digest.email" ${dg.email ? 'checked' : ''} ${g.gmail ? '' : 'disabled'}><span>Also email it to me${g.gmail ? '' : ' (connect Gmail first)'}</span></label></div></div>
    </section>
    <section class="panel">
      <h3>Client emails</h3>
      <label class="check"><input type="checkbox" data-setting-obj="gmail.scanClientEmails" ${gm.scanClientEmails !== false ? 'checked' : ''} ${g.gmail ? '' : 'disabled'}><span><strong>Turn client emails into tasks</strong><br><span class="muted small">Every so often RCWriter reads new emails from the addresses saved on each client, and the AI lists what they're asking for as tasks. Nothing is sent.</span></span></label>
      <div class="field" style="max-width:260px"><label for="gm-min">Check every</label><select id="gm-min" data-setting-obj="gmail.scanMinutes">${[15, 30, 60, 120].map((n) => `<option value="${n}" ${Number(gm.scanMinutes || 30) === n ? 'selected' : ''}>${n} minutes</option>`).join('')}</select></div>
      <div class="field" style="max-width:320px"><label for="snd-name">Your name for email drafts</label><input type="text" id="snd-name" data-setting-obj="senderName" value="${esc(S.settings.senderName || '')}" placeholder="Ray"></div>
    </section>
    <section class="panel">
      <h3>Assistant AI</h3>
      <p class="muted small">Writes report summaries, email drafts, review replies and Google posts.</p>
      <div class="grid-2">
        <div class="field"><label for="as-prov">Provider</label><select id="as-prov" data-setting-obj="assistant.provider">${Object.values(S.providers).map((p) => `<option value="${p.id}" ${a.provider === p.id ? 'selected' : ''}>${esc(PROVIDER_SHORT[p.id] || p.label)}${p.hasKey || p.id === 'custom' ? '' : ' (not set up)'}</option>`).join('')}</select></div>
        <div class="field"><label for="as-model">Model</label><input type="text" id="as-model" data-setting-obj="assistant.model" value="${esc(a.model || '')}" placeholder="${a.provider === 'chatgpt' ? "Your plan's default" : 'Model ID'}"></div>
      </div>
      <div class="field" style="max-width:320px"><label for="rp-brand">Name at the top of reports</label><input type="text" id="rp-brand" data-setting-obj="reportBrand" value="${esc(S.settings.reportBrand || '')}" placeholder="Your agency name"></div>
    </section>`;
}

// ---------- GBP modal ----------
function openGbpModal(siteId) {
  const site = S.sites.find((x) => x.id === siteId);
  const g = site.gbp || {};
  const locs = (S.googleUser.gbpLocations && S.googleUser.gbpLocations.list) || [];
  modal = { type: 'gbp', siteId };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">Google Business Profile for ${esc(site.name)}</h2></header>
      <div class="body">
        ${S.googleUser.gbp ? '' : '<p class="warn small">Sign in with Google in Settings and tick Google Business Profile first.</p>'}
        <div class="field"><label for="gb-loc">Business location</label><div class="inline"><select id="gb-loc"><option value="">Not linked</option>${locs.map((l) => `<option value="${esc(l.id)}" ${g.location === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}${g.location && !locs.find((l) => l.id === g.location) ? `<option value="${esc(g.location)}" selected>${esc(g.title || g.location)}</option>` : ''}</select>
          <button class="btn" data-action="gbp-load" ${S.googleUser.gbp ? '' : 'disabled'}>Load my locations</button></div></div>
        <div class="field"><label for="gb-rev">Review replies</label><select id="gb-rev">
          <option value="off" ${!g.reviewReplies || g.reviewReplies === 'off' ? 'selected' : ''}>Off</option>
          <option value="approve" ${g.reviewReplies === 'approve' ? 'selected' : ''}>Draft replies for me to approve</option>
          <option value="auto" ${g.reviewReplies === 'auto' ? 'selected' : ''}>Post good-review replies automatically</option></select>
          <span class="hint">Checked once a day. With automatic replies, only reviews rated at or above the number below are answered by themselves; the rest wait in Approvals.</span></div>
        <div class="grid-2">
          <div class="field"><label for="gb-min">Auto-reply from (stars)</label><input type="number" id="gb-min" min="1" max="5" value="${esc(g.autoMinRating || 4)}"></div>
          <div class="field"><label for="gb-time">Check reviews at</label><input type="time" id="gb-time" value="${esc(g.reviewTime || '10:00')}"></div>
        </div>
        <div class="field"><label for="gb-post">Posts from new articles</label><select id="gb-post">
          <option value="off" ${!g.postFromArticles || g.postFromArticles === 'off' ? 'selected' : ''}>Off</option>
          <option value="approve" ${g.postFromArticles === 'approve' ? 'selected' : ''}>Draft a post for me to approve</option>
          <option value="auto" ${g.postFromArticles === 'auto' ? 'selected' : ''}>Post automatically</option></select>
          <span class="hint">When a writer publishes an article on this site, the AI writes a short Google post linking to it.</span></div>
        <div class="field"><label for="gb-notes">Notes for replies</label><textarea id="gb-notes" placeholder="Sign off as 'The Eco Pro team'. Mention the free survey for unhappy customers.">${esc(g.notes || '')}</textarea></div>
      </div>
      <footer>${g.location && S.googleUser.gbp ? '<button class="btn ghost" data-action="gbp-check">Check reviews now</button>' : '<span></span>'}<div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="gbp-save">Save</button></div></footer>
    </div></div>`;
}

// ---------- wiring ----------
VIEWS.tasks = viewTasks;
VIEWS.reports = viewReports;
const baseSettings = VIEWS.settings;
VIEWS.settings = () => {
  const html = baseSettings();
  const at = html.indexOf('<section class="panel">\n      <h3>Images</h3>');
  return at >= 0 ? html.slice(0, at) + adminSettings() + html.slice(at) : html + adminSettings();
};
const baseToday = VIEWS.today;
VIEWS.today = () => {
  const html = baseToday();
  const at = html.indexOf('<section class="clock"');
  return at >= 0 ? html.slice(0, at) + digestPanel() + html.slice(at) : html;
};

Object.assign(ACTIONS, {
  'task-filter': (el) => { taskFilter = el.dataset.f; render(); },
  'task-new': () => openTaskModal(null),
  'task-edit': (el) => openTaskModal(S.tasks.find((t) => t.id === el.dataset.id)),
  'task-save': async () => {
    const v = (id) => modalRoot.querySelector(id).value;
    try { await api.saveTask({ id: modal.id || undefined, title: v('#tk-title'), priority: v('#tk-pr'), due: v('#tk-due'), clientId: v('#tk-client'), siteId: v('#tk-site'), notes: v('#tk-notes') }); toast(modal.id ? 'Task saved' : 'Task added'); closeModal(); }
    catch (e) { toast(cleanErr(e), 'error'); }
  },
  'task-doing': (el) => attempt(() => api.setTaskStatus(el.dataset.id, 'doing')),
  'task-delete': (el) => attempt(() => api.deleteTasks(el.dataset.id), 'Task deleted'),
  'task-clear-done': async () => {
    const ids = S.tasks.filter((t) => t.status === 'done').map((t) => t.id);
    if (await confirmModal({ title: `Clear ${ids.length} done task${ids.length > 1 ? 's' : ''}?`, body: 'They are removed from the list. Monthly reports only count tasks that still exist, so clear them after the month\'s report.', confirm: 'Clear' })) { closeModal(); await attempt(() => api.deleteTasks(ids), 'Cleared'); }
  },
  'task-reply': async (el) => {
    el.disabled = true; el.textContent = 'Writing…';
    try { await api.draftTaskReply(el.dataset.id); toast('Draft saved in Gmail. It opened in your browser.'); } catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Draft again'; }
  },
  'gmail-scan': async (el) => {
    el.disabled = true; el.textContent = 'Checking…';
    try { const r = await api.scanGmailNow(); toast(r.tasks ? `${r.tasks} new task${r.tasks > 1 ? 's' : ''} from client emails.` : 'No new requests from clients.'); } catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Check client emails'; }
  },
  'report-make': async (el) => {
    el.disabled = true; const label = el.textContent; el.textContent = 'Creating…';
    try { const r = await api.clientReportNow(el.dataset.id, Number(el.dataset.offset)); toast(`${r.period} report saved.`); await api.openReport(r.id, r.files.pdf ? 'pdf' : 'docx'); }
    catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = label; }
  },
  'report-open': (el) => attempt(() => api.openReport(el.dataset.id, el.dataset.fmt)),
  'report-reveal': (el) => api.revealReport(el.dataset.id),
  'digest-run': (el) => { el.disabled = true; return attempt(() => api.runDigest(), 'Digest updated').finally(() => { el.disabled = false; }); },
  'gu-signin': async (el) => {
    const features = [modalOrMain('#gu-gmail').checked && 'gmail', modalOrMain('#gu-gbp').checked && 'gbp'].filter(Boolean);
    if (!features.length) { toast('Tick Gmail, Business Profile or both.', 'error'); return; }
    el.disabled = true; el.textContent = 'Waiting for Google…';
    try { await api.googleUserSignIn(main.querySelector('#gu-id').value, main.querySelector('#gu-secret').value, features); toast('Google account connected.'); }
    catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; el.textContent = 'Sign in with Google'; }
  },
  'gu-disconnect': async () => {
    if (await confirmModal({ title: 'Disconnect your Google account?', body: 'Client emails, drafts, the emailed digest and Business Profile replies stop until you sign in again.', confirm: 'Disconnect' })) { closeModal(); await attempt(() => api.googleUserDisconnect(), 'Disconnected'); }
  },
  'site-gbp': (el) => openGbpModal(el.dataset.id),
  'gbp-load': async (el) => {
    el.disabled = true; el.textContent = 'Loading…';
    try { const l = await api.gbpLocations(); const id = modal.siteId; openGbpModal(id); toast(`${l.length} location${l.length === 1 ? '' : 's'} found.`); }
    catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; el.textContent = 'Load my locations'; }
  },
  'gbp-save': async () => {
    const q = (id) => modalRoot.querySelector(id);
    const loc = q('#gb-loc');
    const cfg = { location: loc.value, title: loc.value ? loc.options[loc.selectedIndex].text : '', reviewReplies: q('#gb-rev').value, autoMinRating: Number(q('#gb-min').value) || 4, reviewTime: q('#gb-time').value || '10:00', postFromArticles: q('#gb-post').value, notes: q('#gb-notes').value };
    try { await api.setSiteGbp(modal.siteId, cfg); toast('Saved'); closeModal(); } catch (e) { toast(cleanErr(e), 'error'); }
  },
  'gbp-check': async (el) => {
    el.disabled = true; el.textContent = 'Checking…';
    try { const r = await api.gbpCheckNow(modal.siteId); toast(r.replies ? `${r.replies} repl${r.replies > 1 ? 'ies' : 'y'} drafted.` : 'No new reviews without a reply.'); } catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Check reviews now'; }
  },
  'client-weekly': async (el) => {
    el.disabled = true; el.textContent = 'Writing…';
    try { await api.weeklyUpdateNow(el.dataset.id); toast('Weekly update saved in your Gmail drafts.'); } catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Weekly update draft'; }
  },
  'audit-export': async (el) => {
    el.disabled = true; el.textContent = 'Saving…';
    try { await api.exportAuditReport(el.dataset.id); toast('Saved as Word and PDF.'); } catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Save as Word/PDF'; }
  }
});

function modalOrMain(sel) { return modalRoot.querySelector(sel) || main.querySelector(sel); }

// Nested settings like digest.time are saved as a whole object.
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change === 'task-done') { attempt(() => api.setTaskStatus(el.dataset.id, el.checked ? 'done' : 'todo')); return; }
  const key = el.dataset.settingObj;
  if (!key) return;
  const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || key === 'gmail.scanMinutes' ? Number(el.value) : el.value;
  const [top, sub] = key.split('.');
  attempt(() => api.saveSettings(sub ? { [top]: { ...(S.settings[top] || {}), [sub]: v } } : { [top]: v }), 'Saved');
});
