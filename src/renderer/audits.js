/* global S, view, main, modalRoot, esc, cleanErr, toast, attempt, fmtDateTime, fmtRel, fmtMinutes, describeSchedule,
   toLocalInput, nextHour, DAY_NAMES, PROVIDER_SHORT, confirmModal, closeModal, render, renderMarkdown, VIEWS, ACTIONS, api */
// Site audits module: its own sidebar section and sub-tabs, separate from article writing.

let auditTab = 'jobs';
let selectedRunId = null;
let openToolsFor = null;
const approvalPick = new Set();

const MODE_HELP = {
  report: 'Audits and tells you what to fix. Never changes the site.',
  approve: 'Prepares exact changes. Nothing is applied until you approve it here.',
  safe: 'Applies low-risk fixes itself (like meta descriptions and alt text). Riskier changes wait for your approval.',
  full: 'Applies every change it decides on, immediately, with no approval. Every change is still logged.'
};
const RISK_LABEL = { read: 'Read-only', safe: 'Safe to auto-fix', approval: 'Needs approval', off: 'Never use' };
const BUILTIN_HELP = { web: 'Checks pages, crawls the site, finds broken links, reads the sitemap and robots.txt, runs PageSpeed tests.', wp: 'Reads posts, pages, media and plugins, and can edit titles, excerpts, content, image alt text and post status.', google: 'Search Console, GA4 and Tag Manager data for this site.' };
const TEMPLATE_LABEL = { agency: 'Full SEO audit (your team\'s report format)', technical: 'Technical SEO health check', content: 'Content and on-page SEO', rankings: 'Rankings, traffic and backlinks', maintenance: 'WordPress maintenance',
  refresh: 'Refresh posts that are losing traffic', competitors: 'Competitor watch', aiVisibility: 'AI search visibility (Ahrefs Brand Radar)', backlinks: 'Lost backlinks and reclaim emails',
  redirects: '404 to redirect fixer', local: 'Local SEO check', accessibility: 'Accessibility (WCAG) audit', custom: 'Write my own instructions' };
const NEED_LABEL = { gbp: 'Google Business Profile linked to this website', google: 'Search Console linked to this website', wp: 'the website connected as WordPress', ahrefs: 'Ahrefs', semrush: 'Semrush', 'ahrefs|semrush': 'Ahrefs or Semrush' };

function missingNeeds(d) {
  const needs = (S.templateNeeds || {})[d.template] || [];
  const kinds = (d.siteId ? (S.builtinBySite[d.siteId] || []) : []).map((b) => b.kind);
  const chosen = S.connectors.filter((c) => (d.connectorIds || []).includes(c.id)).map((c) => `${c.preset || ''} ${c.name}`.toLowerCase());
  return needs.filter((n) => {
    if (n === 'google' || n === 'wp' || n === 'gbp') return !kinds.includes(n);
    return !n.split('|').some((x) => chosen.some((c) => c.includes(x)));
  }).map((n) => NEED_LABEL[n] || n);
}

function auditSchedule(job) { return S.schedules.find((s) => s.id === `audit-${job.id}`); }
function connName(id) { return S.connectors.find((c) => c.id === id)?.name || 'removed connection'; }
function modeChip(mode) { return `<span class="chip mode-${mode}">${esc(S.auditModes[mode] || mode)}</span>`; }
function jobToolNames(j) {
  const b = (S.builtinBySite[j.siteId] || []).filter((x) => !Array.isArray(j.builtins) || j.builtins.includes(x.kind)).map((x) => x.name);
  if (!j.siteId && j.siteUrl && (!Array.isArray(j.builtins) || j.builtins.includes('web'))) b.push('Website checker');
  return [...b, ...(j.connectorIds || []).map(connName)];
}
function pendingApprovals() { return S.approvals.filter((a) => a.status === 'pending' && inClient(a.siteId, a.siteUrl)); }
function runningRun(jobId) { return S.auditRunning.find((r) => r.jobId === jobId); }

// ---------- page ----------
function viewAudits() {
  const pending = pendingApprovals().length;
  const down = S.sites.filter((x) => x.health && x.health.status === 'down').length;
  const tabs = [['jobs', 'Audits'], ['approvals', `Approvals${pending ? ` (${pending})` : ''}`], ['changes', 'Change log'], ['reports', 'Reports'], ['rankings', 'Rankings'], ['monitoring', `Monitoring${down ? ` (${down} down)` : ''}`], ['maintenance', 'Maintenance'], ['connections', 'Connections']];
  const body = { jobs: auditJobsTab, approvals: approvalsTab, changes: changesTab, reports: reportsTab, monitoring: window.monitoringTab, rankings: window.rankingsTab, maintenance: window.maintenanceTab, connections: connectionsTab }[auditTab]();
  const running = S.auditRunning.map((r) => `
    <div class="writing-now"><div class="spinner"></div><div style="flex:1"><strong>${esc(r.jobName)}</strong> is ${r.kind === 'revert' ? 'undoing a change' : 'auditing'}${r.siteUrl ? ` ${esc(r.siteUrl)}` : ''}. ${r.toolCalls} tool calls so far, ${r.applied} changes made, ${r.queued} waiting for approval.</div>
    <button class="btn" data-action="audit-stop" data-id="${r.id}">Stop</button></div>`).join('');
  return `
    <div class="page-head">
      <div><h1>Site audits</h1><p class="sub">Scheduled checks of your websites using tools you connect, like Ahrefs, Semrush and WPVibe. You choose how much each audit may change on its own.</p></div>
      <button class="btn primary" data-action="audit-new">New audit</button>
    </div>
    ${clientBanner()}
    ${running}
    <div class="seg tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="${auditTab === k ? 'on' : ''}" aria-selected="${auditTab === k}" data-action="audit-tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="tab-body">${body}</div>`;
}

function auditJobsTab() {
  if (!S.connectors.length && !S.sites.length) {
    return `<div class="list"><div class="empty"><p>Add a website first. Audits check and fix the websites you add in Websites, optionally with extra tools like Ahrefs or Semrush.</p><button class="btn primary" data-action="nav" data-view="sites">Go to Websites</button></div></div>`;
  }
  const rows = S.auditJobs.filter((j) => inClient(j.siteId, j.siteUrl)).map((j) => {
    const s = auditSchedule(j);
    const last = S.auditRuns.find((r) => r.jobId === j.id);
    const run = runningRun(j.id);
    return `
      <div class="row schedule-row">
        <label class="switch" title="${j.enabled !== false ? 'Turn off' : 'Turn on'}"><input type="checkbox" data-change="audit-toggle" data-id="${j.id}" ${j.enabled !== false ? 'checked' : ''} aria-label="Audit ${esc(j.name)} on"><span></span></label>
        <div>
          <div class="title">${esc(j.name)} ${modeChip(j.mode)}</div>
          <div class="meta">${esc(j.siteUrl || '')}${j.siteUrl ? '. ' : ''}${s ? esc(describeSchedule(s)) : 'Runs only when you click Run now'}. Uses ${esc(jobToolNames(j).join(', ') || 'no tools')} with ${esc(PROVIDER_SHORT[j.provider] || j.provider)}.</div>
          ${j.thenJobId ? `<div class="meta">Then runs "${esc((S.auditJobs.find((x) => x.id === j.thenJobId) || {}).name || 'a removed audit')}"</div>` : ''}
          <div class="meta">${last ? `Last run ${fmtRel(last.finishedAt || last.startedAt)}: ${last.status === 'failed' ? `<span class="err">failed, ${esc(last.error || '')}</span>` : `${last.applied} changed, ${last.queued} for approval`}` : 'Not run yet'}</div>
        </div>
        <div class="meta" style="text-align:right">${run ? 'Running now' : s && s.enabled && s.nextRunAt ? `Next: ${fmtDateTime(s.nextRunAt)}<br>${fmtRel(s.nextRunAt)}` : j.enabled === false ? 'Off' : ''}</div>
        <div class="btn-row">
          ${run ? `<button class="btn" data-action="audit-stop" data-id="${run.id}">Stop</button>` : `<button class="btn" data-action="audit-run" data-id="${j.id}">Run now</button>`}
          <button class="btn ghost" data-action="audit-edit" data-id="${j.id}">Edit</button>
          <button class="btn ghost danger" data-action="audit-delete" data-id="${j.id}">Delete</button>
        </div>
      </div>`;
  }).join('');
  return `<div class="list">${rows || '<div class="empty"><p>No audits yet.</p><button class="btn primary" data-action="audit-new">Create your first audit</button></div>'}</div>`;
}

function argsBlock(o) {
  return `<details class="detail"><summary>Details</summary>
    ${o.before ? `<div class="kv"><span>Before</span><pre>${esc(o.before)}</pre></div>` : ''}
    <div class="kv"><span>Change</span><pre>${esc(JSON.stringify(o.args, null, 2))}</pre></div>
    ${o.result ? `<div class="kv"><span>Result</span><pre>${esc(o.result)}</pre></div>` : ''}
  </details>`;
}

function approvalsTab() {
  const pending = pendingApprovals();
  for (const id of [...approvalPick]) if (!pending.find((a) => a.id === id)) approvalPick.delete(id);
  const rows = pending.map((a) => `
    <div class="row approval-row">
      <input type="checkbox" data-change="approval-pick" data-id="${a.id}" ${approvalPick.has(a.id) ? 'checked' : ''} aria-label="Select">
      <div>
        <div class="title">${esc(a.reason || a.tool)}</div>
        <div class="meta">${esc(a.connectorName)}: ${esc(a.tool)} <span class="chip risk-${a.risk}">${esc(RISK_LABEL[a.risk] || a.risk)}</span> · ${esc(a.jobName)}${a.siteUrl ? `, ${esc(a.siteUrl)}` : ''} · ${fmtRel(a.createdAt)}</div>
        ${a.preview ? `<div class="preview-line">${esc(a.preview).replace(/\[([^\]]+)\]/, '<mark>$1</mark>')}</div>` : ''}
        ${a.note ? `<div class="meta">${esc(a.note)}</div>` : ''}
        ${argsBlock(a)}
      </div>
      <div class="btn-row">
        <button class="btn primary" data-action="approval-yes" data-id="${a.id}">Approve</button>
        <button class="btn ghost" data-action="approval-no" data-id="${a.id}">Reject</button>
      </div>
    </div>`).join('');
  const history = S.approvals.filter((a) => a.status !== 'pending' && inClient(a.siteId, a.siteUrl)).slice(0, 30).map((a) => `
    <li><time>${fmtRel(a.decidedAt || a.createdAt)}</time><div><span class="chip st-${a.status}">${esc(a.status)}</span> ${esc(a.reason || a.tool)} <span class="muted small">${esc(a.connectorName)}: ${esc(a.tool)}</span></div></li>`).join('');
  return `
    ${pending.length ? `<div class="btn-row bulk"><span class="muted small">${approvalPick.size} selected</span>
      <button class="btn" data-action="approval-pick-all">Select all</button>
      <button class="btn primary" data-action="approval-bulk" data-approve="1" ${approvalPick.size ? '' : 'disabled'}>Approve selected</button>
      <button class="btn ghost" data-action="approval-bulk" data-approve="0" ${approvalPick.size ? '' : 'disabled'}>Reject selected</button></div>` : ''}
    <div class="list">${rows || '<div class="empty"><p>Nothing waiting for approval.</p></div>'}</div>
    ${history ? `<h2>Recently decided</h2><ul class="events">${history}</ul>` : ''}`;
}

function changesTab() {
  const rows = S.changes.filter((c) => inClient(c.siteId, c.siteUrl)).slice(0, 200).map((c) => `
    <div class="row writer-row top">
      <div>
        <div class="title"><span class="chip st-${c.status}">${esc(c.status)}</span> ${esc(c.reason || c.tool)}</div>
        <div class="meta">${esc(c.connectorName)}: ${esc(c.tool)} · ${esc(c.jobName)}${c.siteUrl ? `, ${esc(c.siteUrl)}` : ''} · ${c.via === 'approval' ? 'approved by you' : c.via === 'undo' ? 'undo' : c.via === 'auto-link' ? 'added by a writer' : 'made by the AI'} · ${fmtDateTime(c.at)}</div>
        ${argsBlock(c)}
      </div>
      <div class="btn-row">${c.status === 'applied' ? `<button class="btn" data-action="change-undo" data-id="${c.id}">Undo</button>` : ''}</div>
    </div>`).join('');
  return `<p class="muted small" style="margin-top:0">Every change made to your sites, by the AI or by your approval, with the value before it.</p>
    <div class="list">${rows || '<div class="empty"><p>No changes yet.</p></div>'}</div>`;
}

function reportsTab() {
  const runs = S.auditRuns.filter((r) => r.status !== 'running' && inClient((S.auditJobs.find((j) => j.id === r.jobId) || {}).siteId, r.siteUrl));
  if (!runs.length) return '<div class="list"><div class="empty"><p>Reports appear here after each audit.</p></div></div>';
  if (!selectedRunId || !runs.find((r) => r.id === selectedRunId)) selectedRunId = runs[0].id;
  const list = runs.map((r) => `
    <button class="article-item ${r.id === selectedRunId ? 'active' : ''}" data-action="audit-select-run" data-id="${r.id}">
      <div class="t">${esc(r.jobName)}</div>
      <div class="m">${fmtDateTime(r.startedAt)} · ${r.status === 'failed' ? 'failed' : r.status === 'stopped' ? 'stopped' : `${r.applied} changed, ${r.queued} for approval`}</div>
    </button>`).join('');
  setTimeout(loadAuditReport, 0);
  return `<div class="articles reports"><div class="article-list">${list}</div><div class="reader-wrap" id="report-wrap"></div></div>`;
}

async function loadAuditReport() {
  const wrap = document.getElementById('report-wrap');
  if (!wrap || !selectedRunId) return;
  const r = S.auditRuns.find((x) => x.id === selectedRunId);
  if (!r) return;
  const bar = `<div class="reader-bar"><div class="muted small">${modeChip(r.mode)} ${esc(PROVIDER_SHORT[r.provider] || r.provider)}${r.model ? `: ${esc(r.model)}` : ''} · ${r.toolCalls} tool calls · ${r.applied} changed · ${r.queued} for approval${r.failed ? ` · ${r.failed} failed` : ''}</div>
    <div class="btn-row">${r.queued ? '<button class="btn primary" data-action="audit-tab" data-tab="approvals">Review approvals</button>' : ''}<button class="btn" data-action="audit-export" data-id="${r.id}">Save as Word/PDF</button><button class="btn ghost" data-action="audit-reveal" data-id="${r.id}">Show in folder</button></div></div>`;
  try {
    const text = await api.readAuditReport(r.id);
    if (selectedRunId !== r.id) return;
    wrap.innerHTML = `${bar}<article class="reader">${r.error ? `<p class="warn">${esc(r.error)}</p>` : ''}${renderMarkdown(text)}</article>`;
  } catch (e) {
    wrap.innerHTML = `${bar}<div class="reader"><p class="warn">${esc(r.error || cleanErr(e))}</p></div>`;
  }
}

function connectionsTab() {
  const added = new Set(S.connectors.map((c) => c.preset).filter(Boolean));
  const presets = S.connectorPresets.filter((p) => !added.has(p.id));
  const rows = S.connectors.map((c) => {
    const tools = c.tools || [];
    const counts = ['read', 'safe', 'approval', 'off'].map((k) => [k, tools.filter((t) => t.risk === k).length]).filter(([, n]) => n);
    const state = c.lastError ? `<span class="err">${esc(c.lastError)}</span>`
      : !c.signedIn ? (c.auth === 'oauth' ? 'Not signed in yet.' : 'Add the API key to connect.')
      : tools.length ? `Connected. ${tools.length} tools: ${counts.map(([k, n]) => `${n} ${RISK_LABEL[k].toLowerCase()}`).join(', ')}.` : 'Signed in. Click Connect to load its tools.';
    return `
      <div class="row writer-row top">
        <div>
          <div class="title">${esc(c.name)} <span class="muted small" style="font-weight:400">${c.auth === 'oauth' ? 'browser sign-in' : c.auth === 'apikey' ? 'API key' : 'no sign-in'}</span></div>
          <div class="meta">${esc(c.url)}</div>
          <div class="meta">${state}</div>
          ${tools.length ? `<details class="detail" ${openToolsFor === c.id ? 'open' : ''} data-tools-for="${c.id}"><summary>Tools and what each may do</summary>
            <p class="muted small">RCWriter sets these automatically from each tool's name and description. Change any that look wrong. "Safe to auto-fix" runs by itself in Auto-fix safe items; "Needs approval" runs by itself only in Full autonomy.</p>
            <div class="tools">${tools.map((t) => `
              <div class="tool"><div><code>${esc(t.name)}</code>${t.userSet ? ' <span class="muted small">(changed)</span>' : ''}<div class="muted small">${esc(String(t.description || '').slice(0, 160))}</div></div>
              <select data-change="tool-risk" data-id="${c.id}" data-tool="${esc(t.name)}" aria-label="Permission for ${esc(t.name)}">${Object.entries(RISK_LABEL).map(([k, l]) => `<option value="${k}" ${t.risk === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}</div>
          </details>` : ''}
        </div>
        <div class="btn-row">
          <button class="btn ${c.signedIn && tools.length ? '' : 'primary'}" data-action="conn-connect" data-id="${c.id}">${c.auth === 'oauth' && !c.signedIn ? 'Sign in' : tools.length ? 'Refresh tools' : 'Connect'}</button>
          <button class="btn ghost" data-action="conn-edit" data-id="${c.id}">Edit</button>
          ${c.auth === 'oauth' && c.signedIn ? `<button class="btn ghost" data-action="conn-signout" data-id="${c.id}">Sign out</button>` : ''}
          <button class="btn ghost danger" data-action="conn-delete" data-id="${c.id}">Remove</button>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="btn-row" style="margin-bottom:14px">${presets.map((p) => `<button class="btn" data-action="conn-preset" data-preset="${p.id}">Add ${esc(p.name)}</button>`).join('')}
      <button class="btn" data-action="conn-new">Add another connector</button></div>
    <div class="list">${rows || '<div class="empty"><p>No connections yet. Add Ahrefs, Semrush or WPVibe above, or any other MCP connector.</p></div>'}</div>
    <p class="muted small" style="max-width:72ch;margin-top:14px">Connections are made by RCWriter itself, so it can enforce each audit's permissions. Connectors you added inside ChatGPT or Claude aren't shared with other apps, so you sign in to each tool once here. Each tool's own plan limits apply.</p>`;
}

// ---------- connector modal ----------
function openConnectorModal(c, preset) {
  const p = preset ? S.connectorPresets.find((x) => x.id === preset) : null;
  const d = c ? { ...c } : { name: p ? p.name : '', url: p ? p.url : '', auth: p ? p.auth : 'oauth', preset: p ? p.id : null,
    keyHeader: p && p.apiKey ? p.apiKey.header : 'Authorization', keyPrefix: p && p.apiKey ? p.apiKey.prefix : 'Bearer ' };
  modal = { type: 'connector', draft: d };
  renderConnectorModal();
}

function renderConnectorModal() {
  const d = modal.draft;
  const p = d.preset ? S.connectorPresets.find((x) => x.id === d.preset) : null;
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${d.id ? `Edit ${esc(d.name)}` : p ? `Add ${esc(p.name)}` : 'Add a connector'}</h2></header>
      <div class="body">
        ${p ? `<p class="muted small">${esc(p.note)}</p>` : '<p class="muted small">Any MCP connector that works over HTTPS. The tool\'s documentation lists its MCP URL.</p>'}
        <div class="field"><label for="cn-name">Name</label><input type="text" id="cn-name" value="${esc(d.name)}"></div>
        <div class="field"><label for="cn-url">Connector URL</label><input type="url" id="cn-url" value="${esc(d.url)}" placeholder="https://…/mcp"></div>
        <div class="field"><label for="cn-auth">How to sign in</label><select id="cn-auth" data-change="cn-auth">
          <option value="oauth" ${d.auth === 'oauth' ? 'selected' : ''}>Sign in with my browser</option>
          ${!p || p.apiKey || d.auth === 'apikey' ? `<option value="apikey" ${d.auth === 'apikey' ? 'selected' : ''}>API key</option>` : ''}
          <option value="none" ${d.auth === 'none' ? 'selected' : ''}>No sign-in needed</option></select>
          ${d.auth === 'oauth' ? '<span class="hint">After saving, click Sign in. Your browser opens the tool\'s own approval page.</span>' : ''}</div>
        ${d.auth === 'apikey' ? `
          <div class="field"><label for="cn-key">API key</label><input type="password" id="cn-key" autocomplete="off" placeholder="${d.hasSecret ? 'Saved. Paste a new key to replace it.' : ''}"></div>
          <details class="detail"><summary>Header format</summary><div class="grid-2">
            <div class="field"><label for="cn-h">Header</label><input type="text" id="cn-h" value="${esc(d.keyHeader || 'Authorization')}"></div>
            <div class="field"><label for="cn-pf">Prefix</label><input type="text" id="cn-pf" value="${esc(d.keyPrefix ?? 'Bearer ')}"></div></div></details>` : ''}
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="conn-save">${d.id ? 'Save' : d.auth === 'oauth' ? 'Save and sign in' : 'Save and connect'}</button></div></footer>
    </div></div>`;
}

function readConnectorForm() {
  const d = modal.draft;
  const v = (id) => modalRoot.querySelector(id)?.value;
  d.name = v('#cn-name') ?? d.name;
  d.url = v('#cn-url') ?? d.url;
  d.auth = v('#cn-auth') ?? d.auth;
  if (modalRoot.querySelector('#cn-key')) d.key = v('#cn-key');
  if (modalRoot.querySelector('#cn-h')) { d.keyHeader = v('#cn-h'); d.keyPrefix = v('#cn-pf'); }
  return d;
}

// ---------- audit job modal ----------
function openAuditModal(job) {
  if (!S.connectors.length && !S.sites.length) { window.setView('sites'); render(); toast('Add a website first.', 'error'); return; }
  const s = job ? auditSchedule(job) : null;
  const firstProvider = S.providers.chatgpt.hasKey ? 'chatgpt' : Object.values(S.providers).find((p) => p.hasKey)?.id || 'chatgpt';
  const d = job ? JSON.parse(JSON.stringify(job)) : {
    name: '', siteId: S.sites[0] ? S.sites[0].id : '', siteUrl: '', builtins: null, connectorIds: [], template: 'agency',
    instructions: S.auditTemplates.agency, mode: 'report', provider: firstProvider, model: '', maxToolCalls: 60, maxChanges: 25, maxMinutes: 30,
    notifyOnComplete: true, enabled: true
  };
  d.schedule = d.schedule || (s ? { type: s.type, time: s.time, days: s.days, at: s.at, intervalHours: s.intervalHours, startAt: s.startAt, reminders: s.reminders } : null)
    || { type: 'weekly', time: '08:00', days: [1], at: toLocalInput(nextHour()), intervalHours: 24, startAt: toLocalInput(nextHour()), reminders: [...(S.settings.defaultReminders || [20])] };
  d.fullAck = d.mode === 'full';
  modal = { type: 'audit', draft: d };
  renderAuditModal();
}

function renderAuditModal() {
  const d = modal.draft;
  const sch = d.schedule;
  const scroll = modalRoot.querySelector('.body')?.scrollTop || 0;
  const types = [['manual', 'Only when I click Run'], ['once', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['interval', 'Every few hours']];
  let when = '';
  if (sch.type === 'once') when = `<div class="field" style="max-width:300px"><label for="a-at">Date and time</label><input type="datetime-local" id="a-at" name="s.at" value="${esc(sch.at)}"></div>`;
  if (sch.type === 'daily') when = `<div class="field" style="max-width:200px"><label for="a-time">Time</label><input type="time" id="a-time" name="s.time" value="${esc(sch.time)}"></div>`;
  if (sch.type === 'weekly') when = `<div class="field"><span class="label">Days</span><div class="days">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="s.day" value="${i}" ${(sch.days || []).map(Number).includes(i) ? 'checked' : ''}><span>${DAY_NAMES[i]}</span></label>`).join('')}</div></div>
    <div class="field" style="max-width:200px"><label for="a-time">Time</label><input type="time" id="a-time" name="s.time" value="${esc(sch.time)}"></div>`;
  if (sch.type === 'interval') when = `<div class="grid-2"><div class="field"><label for="a-int">Every</label><div class="inline"><input type="number" id="a-int" name="s.intervalHours" min="1" step="1" value="${esc(sch.intervalHours)}"><span>hours</span></div></div>
    <div class="field"><label for="a-start">Starting</label><input type="datetime-local" id="a-start" name="s.startAt" value="${esc(sch.startAt)}"></div></div>`;

  const provOpts = Object.values(S.providers).map((p) => `<option value="${p.id}" ${d.provider === p.id ? 'selected' : ''}>${esc(p.id === 'custom' && p.customLabel ? p.customLabel : p.label)}${p.hasKey || p.id === 'custom' ? '' : p.kind === 'subscription' ? ' (not signed in)' : ' (no key)'}</option>`).join('');
  modalRoot.innerHTML = `<div class="backdrop">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${d.id ? 'Edit audit' : 'New site audit'}</h2></header>
      <div class="body">
        <div class="grid-2">
          <div class="field"><label for="a-name">Name</label><input type="text" id="a-name" name="name" value="${esc(d.name)}" placeholder="Weekly SEO check"></div>
          <div class="field"><label for="a-siteid">Website</label><select id="a-siteid" name="siteId" data-change="audit-site">
            ${S.sites.map((x) => `<option value="${x.id}" ${d.siteId === x.id ? 'selected' : ''}>${esc(x.name)} (${esc(x.url.replace(/^https?:\/\//, ''))})</option>`).join('')}
            <option value="" ${!d.siteId ? 'selected' : ''}>Another address…</option></select>
            ${!d.siteId ? `<input type="text" name="siteUrl" value="${esc(d.siteUrl)}" placeholder="example.com" style="margin-top:6px" aria-label="Website address">` : ''}
            <span class="hint">The audit only works on this site.</span></div>
        </div>
        <fieldset><legend>Tools it can use</legend>
          ${(() => {
            const avail = d.siteId ? (S.builtinBySite[d.siteId] || []) : (d.siteUrl ? [{ kind: 'web', name: 'Website checker', count: 7 }] : []);
            const site = S.sites.find((x) => x.id === d.siteId);
            const hints = [];
            if (site && site.type !== 'wordpress') hints.push('Connect this site as WordPress in Websites to let audits read and edit its posts.');
            if (site && !avail.find((b) => b.kind === 'google')) hints.push(S.google.connected ? 'Link Search Console, GA4 or Tag Manager to this site in Websites to add Google data.' : 'Connect Google in Websites to add Search Console, GA4 and Tag Manager data.');
            return `<span class="label">Built in</span>
              <div class="checks col">${avail.map((b) => `<label class="check"><input type="checkbox" name="builtin" value="${b.kind}" ${!Array.isArray(d.builtins) || d.builtins.includes(b.kind) ? 'checked' : ''}><span><strong>${esc(b.name)}</strong> <span class="muted small">${BUILTIN_HELP[b.kind]}</span></span></label>`).join('') || '<span class="muted small">Choose a website above.</span>'}</div>
              ${hints.map((h) => `<p class="hint">${esc(h)}</p>`).join('')}
              ${S.connectors.length ? `<span class="label" style="margin-top:10px;display:block">Extra connections</span>
              <div class="checks">${S.connectors.map((c) => `<label class="check"><input type="checkbox" name="conn" value="${c.id}" ${(d.connectorIds || []).includes(c.id) ? 'checked' : ''}><span><strong>${esc(c.name)}</strong> <span class="muted small">${c.signedIn ? `${(c.tools || []).length} tools` : 'not signed in yet'}</span></span></label>`).join('')}</div>` : '<p class="hint">Add Ahrefs, Semrush or WPVibe under Site audits, Connections for more data.</p>'}`;
          })()}
        </fieldset>
        <fieldset><legend>What to check</legend>
          <div class="field"><label for="a-tpl">Starting point</label><select id="a-tpl" name="template" data-change="audit-template">${Object.entries(TEMPLATE_LABEL).map(([k, l]) => `<option value="${k}" ${d.template === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${(() => { const miss = missingNeeds(d); return miss.length ? `<p class="warn small">This starting point works best with ${esc(miss.join(' and '))}. ${miss.some((m) => /Ahrefs|Semrush/.test(m)) ? 'Add it under Connections and tick it above.' : 'Set it up in Websites.'}</p>` : ''; })()}
          <div class="field"><label for="a-instr">Instructions</label><textarea id="a-instr" name="instructions" style="min-height:120px">${esc(d.instructions)}</textarea>
            <span class="hint">Edit freely. Be specific about anything it must never touch.</span></div>
        </fieldset>
        <fieldset><legend>How much it may change by itself</legend>
          <div class="modes">${Object.entries(S.auditModes).map(([k, l]) => `
            <label class="mode-card ${d.mode === k ? 'on' : ''} ${k === 'full' ? 'full' : ''}"><input type="radio" name="mode" value="${k}" ${d.mode === k ? 'checked' : ''} data-change="audit-mode">
              <span><strong>${l}</strong><span class="muted small">${MODE_HELP[k]}</span></span></label>`).join('')}</div>
          ${d.mode === 'full' ? `<label class="check full-ack"><input type="checkbox" name="fullAck" ${d.fullAck ? 'checked' : ''}><span><strong>I understand RCWriter will change my live website without asking me.</strong><br><span class="small">The AI can make mistakes. Keep a recent backup of your site, and check the Change log after each run.</span></span></label>` : ''}
        </fieldset>
        <fieldset><legend>AI</legend>
          <div class="grid-2">
            <div class="field"><label for="a-prov">Provider</label><select id="a-prov" name="provider" data-change="audit-provider">${provOpts}</select></div>
            <div class="field"><label for="a-model">Model</label><input type="text" id="a-model" name="model" list="a-models" value="${esc(d.model)}" placeholder="${d.provider === 'chatgpt' ? "Your plan's default model" : 'Choose or type a model ID'}"><datalist id="a-models"></datalist>
              <span class="hint">${d.provider === 'chatgpt' ? 'Audits use much more of your plan than articles do.' : 'Pick a model that supports tool use.'}</span></div>
          </div>
          <details class="detail"><summary>Limits per run</summary><div class="grid-3">
            <div class="field"><label for="a-calls">Max tool calls</label><input type="number" id="a-calls" name="maxToolCalls" min="5" value="${esc(d.maxToolCalls)}"></div>
            <div class="field"><label for="a-chg">Max changes</label><input type="number" id="a-chg" name="maxChanges" min="1" value="${esc(d.maxChanges)}"><span class="hint">Extra changes wait for approval.</span></div>
            <div class="field"><label for="a-min">Time limit (minutes)</label><input type="number" id="a-min" name="maxMinutes" min="5" value="${esc(d.maxMinutes)}"></div>
          </div></details>
        </fieldset>
        <fieldset><legend>When</legend>
          <div class="field"><div class="seg" role="group" aria-label="Repeat">${types.map(([v, l]) => `<button type="button" class="${sch.type === v ? 'on' : ''}" data-action="audit-sched-type" data-type="${v}" aria-pressed="${sch.type === v}">${l}</button>`).join('')}</div></div>
          ${when}
          ${sch.type !== 'manual' ? `<p class="preview" id="a-preview"></p>
          <div class="field"><span class="label">Remind me before it runs</span>
            <div class="chips">${(sch.reminders || []).map((r) => `<span class="chip">${esc(fmtMinutes(r))}<button data-action="audit-rem-remove" data-min="${r}" aria-label="Remove reminder">×</button></span>`).join('') || '<span class="muted small">No reminders</span>'}
            <span class="inline" style="width:auto"><input type="number" min="1" value="20" style="width:76px" id="a-rem-amt" aria-label="Reminder amount"><select style="width:auto" id="a-rem-unit" aria-label="Reminder unit"><option value="1">minutes</option><option value="60">hours</option><option value="1440">days</option></select><button class="btn" data-action="audit-rem-add">Add reminder</button></span></div>
          </div>` : ''}
          <label class="check"><input type="checkbox" name="notifyOnComplete" ${d.notifyOnComplete !== false ? 'checked' : ''}><span>Notify me when each audit finishes</span></label>
          <div class="grid-2" style="margin-top:10px">
            <div class="field"><label for="a-style">Report format</label><select id="a-style" name="reportStyle">
              <option value="standard" ${d.reportStyle !== 'priority' ? 'selected' : ''}>Standard</option>
              <option value="priority" ${d.reportStyle === 'priority' ? 'selected' : ''}>Priority findings &amp; dev report</option></select></div>
            <div class="field"><span class="label">Also save the report as</span><div class="checks">
              <label class="check"><input type="checkbox" name="exportFmt" value="docx" ${(d.exportFormats || []).includes('docx') ? 'checked' : ''}><span>Word</span></label>
              <label class="check"><input type="checkbox" name="exportFmt" value="pdf" ${(d.exportFormats || []).includes('pdf') ? 'checked' : ''}><span>PDF</span></label></div></div>
          </div>
          <label class="check"><input type="checkbox" name="createTasks" ${d.createTasks !== false ? 'checked' : ''}><span>Add the report's to-do items to Tasks</span></label>
          <div class="field" style="margin-top:10px"><label for="a-then">When it finishes, run</label><select id="a-then" name="thenJobId">
            <option value="">Nothing else</option>${S.auditJobs.filter((j) => j.id !== d.id).map((j) => `<option value="${j.id}" ${d.thenJobId === j.id ? 'selected' : ''}>${esc(j.name)}</option>`).join('')}</select>
            <span class="hint">Chains audits into a workflow: the next audit starts with this one's report, for example a technical audit followed by a content refresh.</span></div>
        </fieldset>
      </div>
      <footer><button class="btn ghost" data-action="close-modal">Cancel</button>
        <div class="btn-row">${d.id ? '' : '<button class="btn" data-action="audit-save" data-run="1">Create and run now</button>'}<button class="btn primary" data-action="audit-save">${d.id ? 'Save audit' : 'Create audit'}</button></div></footer>
    </div></div>`;
  modalRoot.querySelector('.body').scrollTop = scroll;
  if (!scroll) modalRoot.querySelector('#a-name').focus();
  loadAuditModels();
  updateAuditPreview();
}

function readAuditForm() {
  const d = modal.draft;
  const q = (sel) => modalRoot.querySelector(sel);
  const sid = q('[name="siteId"]'); if (sid) d.siteId = sid.value;
  if (modalRoot.querySelector('[name=builtin]')) d.builtins = [...modalRoot.querySelectorAll('[name=builtin]:checked')].map((el) => el.value);
  if (q('[name=reportStyle]')) { d.exportFormats = [...modalRoot.querySelectorAll('[name=exportFmt]:checked')].map((el) => el.value); d.createTasks = q('[name=createTasks]').checked; }
  for (const n of ['name', 'siteUrl', 'instructions', 'provider', 'model', 'template', 'maxToolCalls', 'maxChanges', 'maxMinutes', 'thenJobId', 'reportStyle']) { const el = q(`[name="${n}"]`); if (el) d[n] = el.value; }
  d.connectorIds = [...modalRoot.querySelectorAll('[name=conn]:checked')].map((el) => el.value);
  const mode = q('[name=mode]:checked'); if (mode) d.mode = mode.value;
  const ack = q('[name=fullAck]'); d.fullAck = ack ? ack.checked : d.fullAck;
  const noc = q('[name=notifyOnComplete]'); if (noc) d.notifyOnComplete = noc.checked;
  const sch = d.schedule;
  for (const k of ['at', 'time', 'intervalHours', 'startAt']) { const el = q(`[name="s.${k}"]`); if (el) sch[k] = el.value; }
  if (sch.type === 'weekly') sch.days = [...modalRoot.querySelectorAll('[name="s.day"]:checked')].map((el) => Number(el.value));
  d.siteUrl = String(d.siteUrl || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return d;
}

async function loadAuditModels() {
  if (!modal || modal.type !== 'audit') return;
  const prov = modal.draft.provider;
  const dl = modalRoot.querySelector('#a-models');
  if (!dl || prov === 'chatgpt' || !S.providers[prov] || (!S.providers[prov].hasKey && prov !== 'custom')) return;
  try {
    const models = await api.listModels(prov, false);
    if (modal && modal.type === 'audit' && modal.draft.provider === prov) dl.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name !== m.id ? m.name : '')}</option>`).join('');
  } catch { /* hint stays */ }
}

let auditPreviewTimer = null;
function updateAuditPreview() {
  clearTimeout(auditPreviewTimer);
  auditPreviewTimer = setTimeout(async () => {
    const el = modalRoot.querySelector('#a-preview');
    if (!el || !modal || modal.type !== 'audit') return;
    const sch = readAuditForm().schedule;
    try {
      const times = await api.previewSchedule({ ...sch });
      el.innerHTML = times.length ? `Next: ${times.map((t, i) => (i === 0 ? `<strong>${fmtDateTime(t)}</strong>` : fmtDateTime(t))).join(', ')}` : 'That time has already passed.';
    } catch { el.textContent = ''; }
  }, 150);
}

// ---------- actions ----------
Object.assign(ACTIONS, {
  'audit-tab': (el) => { if (modal) closeModal(); auditTab = el.dataset.tab; render(); },
  'audit-new': () => openAuditModal(),
  'audit-edit': (el) => openAuditModal(S.auditJobs.find((j) => j.id === el.dataset.id)),
  'audit-delete': async (el) => {
    const j = S.auditJobs.find((x) => x.id === el.dataset.id);
    if (await confirmModal({ title: `Delete "${j.name}"?`, body: 'Its schedule stops. Reports, the change log and pending approvals are kept.', confirm: 'Delete audit' })) {
      closeModal();
      await attempt(() => api.deleteAuditJob(j.id), 'Audit deleted');
    }
  },
  'audit-run': (el) => attempt(() => api.runAudit(el.dataset.id), 'Audit started. You\'ll get a notification when it finishes.'),
  'audit-stop': (el) => attempt(() => api.stopAudit(el.dataset.id), 'Stopping the audit…'),
  'audit-select-run': (el) => { selectedRunId = el.dataset.id; render(); },
  'audit-reveal': (el) => api.revealAuditReport(el.dataset.id),
  'audit-sched-type': (el) => { readAuditForm(); modal.draft.schedule.type = el.dataset.type; renderAuditModal(); },
  'audit-rem-add': () => {
    readAuditForm();
    const amt = Number(modalRoot.querySelector('#a-rem-amt').value);
    const unit = Number(modalRoot.querySelector('#a-rem-unit').value);
    if (!(amt > 0)) { toast('Enter how long before the audit you want the reminder.', 'error'); return; }
    const s = modal.draft.schedule;
    s.reminders = [...new Set([...(s.reminders || []), Math.round(amt * unit)])].sort((a, b) => b - a);
    renderAuditModal();
  },
  'audit-rem-remove': (el) => { readAuditForm(); const s = modal.draft.schedule; s.reminders = s.reminders.filter((r) => Number(r) !== Number(el.dataset.min)); renderAuditModal(); },
  'audit-save': async (el) => {
    const d = readAuditForm();
    if (d.mode === 'full' && !d.fullAck) { toast('Tick the box to confirm Full autonomy, or choose another level.', 'error'); return; }
    if (!d.siteId && !d.siteUrl) { toast('Choose the website this audit is for.', 'error'); return; }
    if (!d.connectorIds.length && !(d.builtins || []).length) { toast('Choose at least one tool for this audit.', 'error'); return; }
    const job = { ...d };
    delete job.fullAck;
    el.disabled = true;
    try {
      const id = await api.saveAuditJob(job);
      closeModal();
      auditTab = 'jobs';
      if (el.dataset.run) { await api.runAudit(id); toast('Audit created and started.'); } else toast(d.id ? 'Audit saved' : 'Audit created');
    } catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; }
  },

  'approval-yes': async (el) => { el.disabled = true; try { await api.decideApproval(el.dataset.id, true); toast('Approved and applied'); } catch (e) { toast(`Not applied: ${cleanErr(e)}`, 'error'); el.disabled = false; } },
  'approval-no': (el) => attempt(() => api.decideApproval(el.dataset.id, false), 'Rejected'),
  'approval-pick-all': () => { pendingApprovals().forEach((a) => approvalPick.add(a.id)); render(); },
  'approval-bulk': async (el) => {
    const approve = el.dataset.approve === '1';
    const ids = [...approvalPick];
    if (approve && !(await confirmModal({ title: `Apply ${ids.length} change${ids.length > 1 ? 's' : ''}?`, body: 'They are applied to your live site now, one after another.', confirm: 'Approve and apply' }))) return;
    closeModal();
    el.disabled = true;
    const r = await api.decideApprovals(ids, approve);
    approvalPick.clear();
    toast(`${r.ok} ${approve ? 'applied' : 'rejected'}${r.errors.length ? `, ${r.errors.length} failed` : ''}.`, r.errors.length ? 'error' : 'info');
  },
  'change-undo': async (el) => {
    const c = S.changes.find((x) => x.id === el.dataset.id);
    if (await confirmModal({ title: 'Undo this change?', body: String(c.connectorId).includes(':') && c.before !== undefined ? `RCWriter will put back the value saved before this change (${c.tool} on ${c.siteUrl || c.connectorName}).` : `RCWriter will ask the AI to restore the value from before this change (${c.tool} on ${c.siteUrl || c.connectorName}), using the same tools. It is allowed to change only that one thing, and the result appears in Reports and the Change log.`, confirm: 'Undo change' })) {
      closeModal();
      try {
        const r = await api.revertChange(c.id);
        toast(r && r.direct ? r.text : 'Undoing the change. You\'ll get a notification when it finishes.');
      } catch (e) { toast(cleanErr(e), 'error'); }
    }
  },

  'conn-preset': (el) => openConnectorModal(null, el.dataset.preset),
  'conn-new': () => openConnectorModal(null, null),
  'conn-edit': (el) => openConnectorModal(S.connectors.find((c) => c.id === el.dataset.id)),
  'conn-save': async (el) => {
    const d = readConnectorForm();
    if (d.auth === 'apikey' && !d.key && !d.hasSecret) { toast('Paste the API key.', 'error'); return; }
    el.disabled = true;
    try {
      const id = await api.saveConnector(d);
      closeModal();
      auditTab = 'connections';
      render();
      toast(d.auth === 'oauth' ? 'Opening the sign-in page in your browser…' : 'Connecting…');
      const r = await api.connectConnector(id);
      toast(`Connected. ${r.tools} tools available.`);
    } catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; }
  },
  'conn-connect': async (el) => {
    el.disabled = true;
    const c = S.connectors.find((x) => x.id === el.dataset.id);
    if (c.auth === 'oauth' && !c.signedIn) toast('Opening the sign-in page in your browser…');
    try { const r = await api.connectConnector(el.dataset.id); toast(`Connected. ${r.tools} tools available.`); }
    catch (e) { toast(cleanErr(e), 'error'); }
  },
  'conn-signout': (el) => attempt(() => api.signOutConnector(el.dataset.id), 'Signed out'),
  'conn-delete': async (el) => {
    const c = S.connectors.find((x) => x.id === el.dataset.id);
    if (await confirmModal({ title: `Remove ${c.name}?`, body: 'Audits that use it will stop using it. To fully revoke access, also remove RCWriter from the tool\'s own account settings.', confirm: 'Remove connection' })) {
      closeModal();
      await attempt(() => api.deleteConnector(c.id), 'Connection removed');
    }
  }
});

VIEWS.audits = viewAudits;

document.addEventListener('change', (e) => {
  const el = e.target;
  const ch = el.dataset.change;
  if (ch === 'audit-toggle') attempt(() => api.toggleAuditJob(el.dataset.id, el.checked), el.checked ? 'Audit on' : 'Audit off');
  else if (ch === 'tool-risk') { openToolsFor = el.dataset.id; attempt(() => api.setToolRisk(el.dataset.id, el.dataset.tool, el.value)); }
  else if (ch === 'approval-pick') { if (el.checked) approvalPick.add(el.dataset.id); else approvalPick.delete(el.dataset.id); render(); }
  else if (ch === 'cn-auth') { readConnectorForm(); renderConnectorModal(); }
  else if (ch === 'audit-template') {
    const instr = modalRoot.querySelector('[name=instructions]');
    const tpl = el.value;
    const known = Object.values(S.auditTemplates);
    if (tpl !== 'custom' && (!instr.value.trim() || known.includes(instr.value.trim()))) instr.value = S.auditTemplates[tpl];
    if (tpl === 'custom' && known.includes(instr.value.trim())) instr.value = '';
    readAuditForm();
    renderAuditModal();
  } else if (ch === 'audit-site') {
    readAuditForm();
    modal.draft.builtins = null;
    if (modal.draft.siteId) modal.draft.siteUrl = '';
    renderAuditModal();
  } else if (modal && modal.type === 'audit' && el.name === 'conn') {
    readAuditForm();
    renderAuditModal();
  } else if (ch === 'audit-mode' || ch === 'audit-provider') {
    readAuditForm();
    if (ch === 'audit-provider') modal.draft.model = '';
    renderAuditModal();
  } else if (modal && modal.type === 'audit') updateAuditPreview();
});
document.addEventListener('input', () => { if (modal && modal.type === 'audit') updateAuditPreview(); });
document.addEventListener('toggle', (e) => { const t = e.target; if (t.dataset && t.dataset.toolsFor) openToolsFor = t.open ? t.dataset.toolsFor : null; }, true);

api.onNavigateTo((t) => {
  if (!t) return;
  closeModal();
  window.setView(t.view || 'audits');
  if (t.tab) auditTab = t.tab;
  if (t.runId) selectedRunId = t.runId;
  render();
});
window.auditGoto = (tab) => { auditTab = tab; };
window.openAuditReport = (runId) => { window.setView('audits'); auditTab = 'reports'; selectedRunId = runId; render(); };
