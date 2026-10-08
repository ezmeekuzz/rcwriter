/* global renderMarkdown */

let S = null;
let view = 'today';
let selectedArticleId = null;
let articleQuery = '';
let pendingRender = false;
let modal = null; // { type, draft }
window.setView = (v) => { view = v; };

const main = document.getElementById('main');
const modalRoot = document.getElementById('modal-root');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PROVIDER_SHORT = { chatgpt: 'ChatGPT subscription', anthropic: 'Claude', openai: 'OpenAI API', gemini: 'Gemini', custom: 'Custom' };
const STATUS_LABEL = { none: "Don't publish", draft: 'Save as draft', pending: 'Submit for review', publish: 'Publish immediately', private: 'Publish privately' };
let loginUrl = null;
let codexPct = null;
let subBusy = false;

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

async function attempt(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(cleanErr(e), 'error'); throw e; }
}

function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDay(iso) {
  const d = new Date(iso), now = new Date();
  const tom = new Date(now); tom.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === tom.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) { return `${fmtDay(iso)}, ${fmtTime(iso)}`; }
function fmtRel(iso) {
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff), m = Math.round(abs / 6e4);
  let s;
  if (m < 1) s = 'less than a minute';
  else if (m < 60) s = `${m} min`;
  else if (m < 60 * 24) { const h = Math.floor(m / 60), r = m % 60; s = r ? `${h} h ${r} min` : `${h} h`; }
  else { const d = Math.round(m / 1440); s = `${d} day${d > 1 ? 's' : ''}`; }
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}
function fmtMinutes(n) {
  n = Number(n);
  if (n % 1440 === 0) return `${n / 1440} day${n === 1440 ? '' : 's'} before`;
  if (n % 60 === 0) return `${n / 60} h before`;
  return `${n} min before`;
}
function describeSchedule(s) {
  if (s.type === 'once') return s.at ? `Once, ${fmtDateTime(new Date(s.at).toISOString())}` : 'Once';
  if (s.type === 'daily') return `Every day at ${s.time}`;
  if (s.type === 'weekly') {
    const days = (s.days || []).map(Number).sort();
    const label = days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map((d) => DAY_NAMES[d]).join(', ');
    return `${label} at ${s.time}`;
  }
  if (s.type === 'interval') return `Every ${s.intervalHours} hour${Number(s.intervalHours) === 1 ? '' : 's'}`;
  return '';
}
function fileUrl(p) { return `file:///${String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`; }
function writerName(id) { return S.writers.find((w) => w.id === id)?.name || 'Missing writer'; }
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function nextHour() { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d; }

// ---------- rendering ----------
let shownGate = null;
const OWNER_LINE = '<a class="owner-mark gate-owner" href="#" data-action="link" data-url="https://tomdigitalspace.com/">RCWriter by <strong>Rustom Codilan</strong> · tomdigitalspace.com</a>';

function gateKind() {
  if (S.tampered) return 'tampered';
  if (S.locked) return 'lock';
  if (!S.security.hasPassword && !S.settings.passwordPrompted) return 'setup';
  return null;
}

function render() {
  if (!S) return;
  const ae = document.activeElement;
  const gateChanged = gateKind() !== shownGate;
  if (!gateChanged && ae && main.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox') {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  document.documentElement.dataset.theme = S.settings.theme === 'system' ? '' : S.settings.theme;
  shownGate = gateKind();
  const gate = shownGate === 'tampered' ? tamperedScreen() : shownGate === 'lock' ? lockScreen() : shownGate === 'setup' ? setupScreen() : null;
  document.body.classList.toggle('gated', !!gate);
  if (gate) {
    if (modal) closeModal();
    main.innerHTML = gate;
    main.querySelector('input')?.focus();
    return;
  }
  renderSidebar();
  const scroll = main.scrollTop;
  main.innerHTML = VIEWS[view]();
  main.scrollTop = scroll;
  if (view === 'articles') loadReader();
}

function renderSidebar() {
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    if (b.dataset.view === 'today') {
      b.innerHTML = `Today${S.jobs.length ? `<span class="badge">${S.jobs.length} writing</span>` : ''}`;
    }
    if (b.dataset.view === 'leads') {
      const n = (S.leads || []).filter((l) => l.pendingEmail || l.pendingSms).length;
      const r = (S.leads || []).filter((l) => l.stage === 'replied').length;
      b.innerHTML = `Leads${n ? `<span class="badge">${n} to approve</span>` : r ? `<span class="badge">${r} replied</span>` : ''}`;
    }
    if (b.dataset.view === 'campaigns') {
      const n = ((S.leadsInfo || {}).running || []).length;
      b.innerHTML = `Crawlers${n ? '<span class="badge">running</span>' : ''}`;
    }
    if (b.dataset.view === 'tasks') {
      const today = new Date().toLocaleDateString('en-CA');
      const due = (S.tasks || []).filter((t) => t.status !== 'done' && t.due && t.due <= today).length;
      const fresh = (S.tasks || []).filter((t) => t.status === 'todo' && Date.now() - new Date(t.createdAt) < 24 * 36e5).length;
      b.innerHTML = `Tasks${due ? `<span class="badge">${due} due</span>` : fresh ? `<span class="badge">${fresh} new</span>` : ''}`;
    }
    if (b.dataset.view === 'audits') {
      const n = S.approvals.filter((a) => a.status === 'pending').length;
      b.innerHTML = `Audits${S.auditRunning.length ? '<span class="badge">running</span>' : n ? `<span class="badge">${n} to approve</span>` : ''}`;
    }
  });
  if (window.renderClientPick) window.renderClientPick();
  const active = S.schedules.filter((s) => s.enabled && !s.kind).length + S.schedules.filter((s) => s.enabled && s.kind === 'playbook').length + S.auditJobs.filter((j) => j.enabled !== false && S.schedules.some((s) => s.id === `audit-${j.id}`)).length;
  const paused = S.settings.paused;
  document.getElementById('status').innerHTML = `
    <div><span class="dot ${paused ? 'paused' : ''}"></span>${paused ? 'Schedules paused' : `${active} schedule${active === 1 ? '' : 's'} on`}</div>
    <button class="btn" data-action="toggle-pause">${paused ? 'Resume schedules' : 'Pause schedules'}</button>`;
}

main.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) render(); }, 0));

const VIEWS = { today: viewToday, writers: viewWriters, schedules: viewSchedules, articles: viewArticles, sites: viewSites, providers: viewProviders, settings: viewSettings };

// ---------- Websites ----------
function siteName(id) { return S.sites.find((x) => x.id === id)?.name || 'a removed website'; }

function viewSites() {
  const rows = S.sites.map((site) => {
    const writers = S.writers.filter((w) => w.siteId === site.id).map((w) => w.name);
    const state = site.lastError
      ? `<span style="color:var(--danger)">${esc(site.lastError)}</span>`
      : site.type === 'wordpress'
        ? `Connected as ${esc(site.connectedAs || site.username)}${site.canPublish === false ? '. This user can\'t publish; posts will fail.' : ''}`
        : `Webhook${site.hasSecret ? ', signed' : ''}`;
    return `
      <div class="row writer-row">
        <div>
          <div class="title">${esc(site.name)} <span class="muted small" style="font-weight:400">${site.type === 'wordpress' ? 'WordPress' : 'Webhook'}</span></div>
          <div class="meta">${esc(site.url)}</div>
          <div class="meta">${state}</div>
          <div class="meta">${writers.length ? `Used by ${esc(writers.join(', '))}` : 'Not used by any writer yet. Choose it in a writer\'s "Where to publish" section.'}</div>
        </div>
        <div class="btn-row">
          <button class="btn" data-action="test-site" data-id="${site.id}">Test connection</button>
          ${site.type === 'wordpress' ? `<button class="btn ghost" data-action="reconnect-site" data-id="${site.id}">Reconnect</button>` : `<button class="btn ghost" data-action="edit-webhook" data-id="${site.id}">Edit</button>`}
          <button class="btn ghost danger" data-action="delete-site" data-id="${site.id}">Remove</button>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="page-head">
      <div><h1>Websites</h1><p class="sub">Connect the sites your writers publish to. New articles can be saved as drafts for you to review, or published right away.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="new-webhook">Add a webhook</button>
        <button class="btn primary" data-action="new-wordpress">Connect a WordPress site</button>
      </div>
    </div>
    <div class="list">${rows || '<div class="empty"><p>No websites connected yet.</p><button class="btn primary" data-action="new-wordpress">Connect a WordPress site</button></div>'}</div>
    <p class="muted small" style="max-width:70ch;margin-top:16px">Using Ghost, Webflow, Wix, Shopify, Blogger or something else? Add a webhook and connect it through Zapier, Make or n8n. RCWriter sends each article's title, HTML, Markdown, excerpt, categories and tags.</p>`;
}

function openWordPressModal(site) {
  modal = { type: 'wp', site: site || null, manual: false };
  renderWpModal();
}

function renderWpModal() {
  const site = modal.site;
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${site ? `Reconnect ${esc(site.name)}` : 'Connect a WordPress site'}</h2></header>
      <div class="body">
        <div class="field"><label for="wp-url">Website address</label><input type="url" id="wp-url" value="${esc(site?.url || '')}" placeholder="https://yourblog.com"></div>
        ${modal.manual ? `
          <div class="field"><label for="wp-user">WordPress username</label><input type="text" id="wp-user" value="${esc(site?.username || '')}" autocomplete="off"></div>
          <div class="field"><label for="wp-pass">Application password</label><input type="password" id="wp-pass" autocomplete="off" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx">
            <span class="hint">Create one in WordPress under Users, Profile, Application passwords. It's not your normal login password, and you can revoke it there at any time.</span></div>
        ` : `
          <p class="muted small">Your browser will open your site's WordPress approval page. Log in if asked, then click <strong>Yes, I approve of this connection</strong>. You'll come straight back here. RCWriter never sees your WordPress password, and you can revoke access any time from your WordPress profile.</p>
          <p class="small" id="wp-wait" hidden><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>Waiting for you to approve in the browser…</p>
        `}
      </div>
      <footer>
        <button class="btn ghost" data-action="wp-toggle-manual">${modal.manual ? 'Use browser approval instead' : 'Enter details manually'}</button>
        <div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="${modal.manual ? 'wp-save-manual' : 'wp-approve'}">${modal.manual ? 'Connect' : 'Approve in browser'}</button></div>
      </footer>
    </div></div>`;
  modalRoot.querySelector('#wp-url').focus();
}

function openWebhookModal(site) {
  modal = { type: 'webhook', site: site || null };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${site ? 'Edit webhook' : 'Add a webhook'}</h2></header>
      <div class="body">
        <div class="field"><label for="wh-name">Name</label><input type="text" id="wh-name" value="${esc(site?.name || '')}" placeholder="Ghost blog via Zapier"></div>
        <div class="field"><label for="wh-url">Webhook URL</label><input type="url" id="wh-url" value="${esc(site?.url || '')}" placeholder="https://hooks.zapier.com/…"></div>
        <div class="field"><label for="wh-secret">Signing secret (optional)</label><input type="password" id="wh-secret" placeholder="${site?.hasSecret ? 'Saved. Type a new one to replace it.' : 'Leave blank for none'}" autocomplete="off">
          <span class="hint">If set, each request includes an X-RCWriter-Signature header (HMAC-SHA256 of the body) so your endpoint can check it came from you.</span></div>
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="save-webhook">${site ? 'Save webhook' : 'Add webhook'}</button></div></footer>
    </div></div>`;
  modalRoot.querySelector('#wh-name').focus();
}

function openPublishModal(articleId) {
  if (!S.sites.length) { toast('Connect a website first.', 'error'); view = 'sites'; render(); return; }
  const a = S.articles.find((x) => x.id === articleId);
  const w = S.writers.find((x) => x.id === a.writerId);
  modal = { type: 'publish', articleId };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">Publish article</h2></header>
      <div class="body">
        <p class="muted small">${esc(a.title)}</p>
        <div class="field"><label for="pb-site">Website</label><select id="pb-site">${S.sites.map((x) => `<option value="${x.id}" ${w?.siteId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="pb-status">How to publish</label><select id="pb-status">${['draft', 'pending', 'publish', 'private'].map((k) => `<option value="${k}" ${(w?.publishStatus || 'draft') === k ? 'selected' : ''}>${STATUS_LABEL[k]}</option>`).join('')}</select></div>
        <div class="grid-2">
          <div class="field"><label for="pb-cats">Categories</label><input type="text" id="pb-cats" value="${esc(w?.wpCategories || '')}" placeholder="Travel, Guides"></div>
          <div class="field"><label for="pb-tags">Tags</label><input type="text" id="pb-tags" value="${esc(w?.wpTags || '')}" placeholder="mindanao, budget"></div>
        </div>
        ${a.published ? `<p class="warn">This article was already sent to ${esc(a.published.siteName)}. Publishing again creates a second copy.</p>` : ''}
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-publish">Publish</button></div></footer>
    </div></div>`;
}

// ---------- Lock ----------
function lockScreen() {
  return `
    <div class="gate">
      <img src="../../assets/icon.png" alt="" width="56" height="56">
      <h1>RCWriter is locked</h1>
      <p class="muted">${S.writing ? `Writing ${S.writing} article${S.writing > 1 ? 's' : ''} in the background. ` : ''}Your schedules keep running while it's locked.</p>
      <form class="gate-form" data-submit="unlock" autocomplete="off">
        <label for="unlock-pw" class="label">Password</label>
        <input type="password" id="unlock-pw" autocomplete="current-password">
        <button class="btn primary" type="submit">Unlock</button>
      </form>
      <button class="btn ghost small" data-action="forgot-password">Forgot password?</button>
      ${OWNER_LINE}
    </div>`;
}

function setupScreen() {
  return `
    <div class="gate">
      <img src="../../assets/icon.png" alt="" width="56" height="56">
      <h1>Protect RCWriter with a password</h1>
      <p class="muted">Anyone who opens RCWriter on this computer will need it. Schedules keep running in the background while it's locked. You can change this later in Settings.</p>
      <form class="gate-form" data-submit="setup-password" autocomplete="off">
        <label for="setup-pw" class="label">Password</label>
        <input type="password" id="setup-pw" autocomplete="new-password" minlength="6">
        <label for="setup-pw2" class="label">Confirm password</label>
        <input type="password" id="setup-pw2" autocomplete="new-password">
        <button class="btn primary" type="submit">Set password</button>
      </form>
      <button class="btn ghost small" data-action="skip-password">Skip for now</button>
      ${OWNER_LINE}
    </div>`;
}

function tamperedScreen() {
  return `
    <div class="gate">
      <img src="../../assets/icon.png" alt="" width="56" height="56">
      <h1>This copy of RCWriter has been modified</h1>
      <p class="muted">RCWriter is created and owned by <strong>Rustom Codilan</strong>. The ownership notice was removed or hidden, so this copy has stopped. Schedules, audits and outreach are paused, and your data is untouched.</p>
      <p class="muted">Install the original from the owner to keep using it.</p>
      ${OWNER_LINE}
    </div>`;
}

// ---------- Today ----------
function viewToday() {
  const now = Date.now();
  const span = 24 * 36e5;
  const events = S.upcoming;
  const runs = events.filter((e) => e.kind === 'run');
  const next = runs[0];

  const hours = [];
  const first = new Date(now); first.setMinutes(0, 0, 0); first.setHours(first.getHours() + 1);
  for (let t = first.getTime(); t < now + span; t += 36e5) {
    const d = new Date(t);
    if (d.getHours() % 3 !== 0) continue;
    const left = ((t - now) / span) * 100;
    if (left > 97) continue;
    hours.push(`<div class="hour" style="left:${left}%"><b>${d.getHours() === 0 ? fmtDay(d.toISOString()) : d.toLocaleTimeString([], { hour: 'numeric' })}</b></div>`);
  }
  const marks = events.filter((e) => new Date(e.at) - now <= span).map((e) => {
    const left = Math.max(0, Math.min(100, ((new Date(e.at) - now) / span) * 100));
    return e.kind === 'run'
      ? `<div class="run ${e.type === 'audit' ? 'audit' : ''}" style="left:${left}%" title="${esc(e.scheduleName)}: ${e.type === 'audit' ? 'audits' : ''} ${esc(e.writerName)} at ${fmtTime(e.at)}"></div>`
      : `<div class="rem" style="left:${left}%" title="Reminder for ${esc(e.scheduleName)}, ${esc(fmtMinutes(e.minutes))}"></div>`;
  }).join('');

  const writing = S.jobs.map((j) => `
    <div class="writing-now"><div class="spinner"></div><div><strong>${esc(j.writerName)}</strong> is ${j.step && j.step !== 'Writing' ? esc(j.step.toLowerCase()) : 'writing'}${j.scheduleName ? ` for "${esc(j.scheduleName)}"` : ''}. Started ${fmtRel(j.startedAt)}.</div></div>`).join('')
    + S.auditRunning.map((r) => `
    <div class="writing-now"><div class="spinner"></div><div><strong>${esc(r.jobName)}</strong> is auditing ${esc(r.siteUrl || 'your site')}. ${r.applied} changes made, ${r.queued} waiting for approval.</div></div>`).join('');
  const pendingCount = S.approvals.filter((a) => a.status === 'pending').length;
  const approvalsBanner = pendingCount ? `
    <div class="panel attention" style="max-width:none"><h3>${pendingCount} site change${pendingCount > 1 ? 's' : ''} waiting for your approval</h3><button class="btn primary" data-action="goto-approvals">Review changes</button></div>` : '';

  const list = events.slice(0, 14).map((e) => e.kind === 'run'
    ? `<li><time>${fmtDay(e.at) === 'Today' ? '' : fmtDay(e.at) + ' '}${fmtTime(e.at)}</time><div><strong>${esc(e.scheduleName)}</strong><div class="muted small">${e.type === 'playbook' ? 'Runs the playbook' : e.type === 'audit' ? `Site audit of ${esc(e.writerName)}${e.mode === 'full' ? ', applies changes automatically' : ''}` : `${esc(e.writerName)} writes ${e.count > 1 ? `${e.count} articles` : 'an article'}`}</div></div></li>`
    : `<li><time>${fmtDay(e.at) === 'Today' ? '' : fmtDay(e.at) + ' '}${fmtTime(e.at)}</time><div class="reminder-line">Reminder: "${esc(e.scheduleName)}" in ${esc(fmtMinutes(e.minutes).replace(' before', ''))}</div></li>`).join('');

  const activity = S.activity.slice(0, 14).map((a) => `
    <li><time>${fmtRel(a.at)}</time><div class="${a.type === 'error' ? 'error' : ''}">${esc(a.msg)}${a.articleId ? ` <a data-action="open-article" data-id="${a.articleId}">Read</a>` : ''}${a.auditRunId ? ` <a data-action="open-audit-report" data-id="${a.auditRunId}">Report</a>` : ''}</div></li>`).join('');

  const setupNeeded = !Object.values(S.providers).some((p) => p.hasKey) ? `
    <div class="panel" style="max-width:none"><h3>Start by connecting an AI provider</h3><p class="muted">Sign in with your ChatGPT subscription, or add an API key for Claude, OpenAI or Gemini. Then create a writer and a schedule.</p><button class="btn primary" data-action="nav" data-view="providers">Connect an AI provider</button></div>` : '';

  return `
    <div class="page-head">
      <div><h1>Today</h1><p class="sub">${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
      <div class="btn-row">
        <button class="btn" data-action="new-schedule">New schedule</button>
        <button class="btn primary" data-action="quick-run">Write an article now</button>
      </div>
    </div>
    ${setupNeeded}
    ${approvalsBanner}
    ${writing}
    <section class="clock" aria-label="Next 24 hours">
      <div class="clock-head">
        <div>
          <div class="next-big">${next ? esc(fmtRel(next.at).replace('in ', '')) : 'Nothing scheduled'}</div>
          <div class="next-label">${next ? `until "${esc(next.scheduleName)}" at ${fmtDateTime(next.at)}` : 'Create a schedule or a site audit to have work done automatically.'}</div>
        </div>
        <div class="legend"><span><i class="l-run"></i>Article</span><span><i class="l-audit"></i>Site audit</span><span><i class="l-rem"></i>Reminder</span></div>
      </div>
      <div class="track"><div class="rail"></div>${hours.join('')}<div class="now"><b>Now</b></div>${marks}</div>
    </section>
    <div class="two-col">
      <section><h2>Coming up in the next 48 hours</h2>${list ? `<ul class="events">${list}</ul>` : '<p class="muted">Nothing scheduled.</p>'}</section>
      <section><h2>Recent activity</h2>${activity ? `<ul class="events activity">${activity}</ul>` : '<p class="muted">Finished articles and errors will show here.</p>'}</section>
    </div>`;
}

// ---------- Writers ----------
function writerSite(writerId) { const w = S.writers.find((x) => x.id === writerId); return w ? w.siteId : ''; }

function viewWriters() {
  const rows = S.writers.filter((w) => inClient(w.siteId)).map((w) => {
    const count = S.articles.filter((a) => a.writerId === w.id).length;
    const topics = String(w.topics || '').split('\n').filter((t) => t.trim()).length;
    return `
      <div class="row writer-row">
        <div>
          <div class="title">${esc(w.name)}</div>
          <div class="meta">${esc(PROVIDER_SHORT[w.provider] || w.provider)}: ${esc(w.model || (w.provider === 'chatgpt' ? 'plan default' : 'no model chosen'))}. ${w.siteId && w.publishStatus && w.publishStatus !== 'none' ? `${esc(STATUS_LABEL[w.publishStatus])} on ${esc(siteName(w.siteId))}.` : 'Saves to your computer only.'} ${topics ? `${topics} topic${topics > 1 ? 's' : ''}, ${w.topicMode === 'rotate' ? 'in rotation' : w.topicMode === 'random' ? 'picked at random' : 'AI picks the angle'}.` : 'AI picks the topic.'} ${count} article${count === 1 ? '' : 's'} written.</div>
        </div>
        <div class="btn-row">
          <button class="btn" data-action="run-writer" data-id="${w.id}">Write now</button>
          <button class="btn ghost" data-action="plan-open" data-id="${w.id}">Topic plan${(w.plan || []).filter((p) => p.status === 'planned').length ? ` (${(w.plan || []).filter((p) => p.status === 'planned').length})` : ''}</button>
          <button class="btn ghost" data-action="edit-writer" data-id="${w.id}">Edit</button>
          <button class="btn ghost danger" data-action="delete-writer" data-id="${w.id}">Delete</button>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="page-head">
      <div><h1>Writers</h1><p class="sub">A writer is a set of instructions: who the AI is, what it knows, how it sounds, and what it writes about. Make one per topic or publication.</p></div>
      <button class="btn primary" data-action="new-writer">New writer</button>
    </div>
    ${clientBanner()}
    <div class="list">${rows || '<div class="empty"><p>No writers yet.</p><button class="btn primary" data-action="new-writer">Create your first writer</button></div>'}</div>`;
}

// ---------- Schedules ----------
function viewSchedules() {
  const rows = S.schedules.filter((s) => !s.kind && inClient(writerSite(s.writerId))).map((s) => `
    <div class="row schedule-row">
      <label class="switch" title="${s.enabled ? 'Turn off' : 'Turn on'}"><input type="checkbox" data-change="toggle-schedule" data-id="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="Schedule ${esc(s.name)} on"><span></span></label>
      <div>
        <div class="title">${esc(s.name)}</div>
        <div class="meta">${esc(describeSchedule(s))}. ${esc(writerName(s.writerId))}${s.count > 1 ? `, ${s.count} articles each time` : ''}.</div>
        <div class="chips" style="margin-top:6px">${(s.reminders || []).map((r) => `<span class="chip">${esc(fmtMinutes(r))}</span>`).join('') || '<span class="meta">No reminders</span>'}</div>
      </div>
      <div class="meta" style="text-align:right">${s.enabled && s.nextRunAt ? `Next: ${fmtDateTime(s.nextRunAt)}<br>${fmtRel(s.nextRunAt)}` : s.enabled ? 'Calculating…' : 'Off'}</div>
      <div class="btn-row">
        <button class="btn ghost" data-action="edit-schedule" data-id="${s.id}">Edit</button>
        <button class="btn ghost danger" data-action="delete-schedule" data-id="${s.id}">Delete</button>
      </div>
    </div>`).join('');
  return `
    <div class="page-head">
      <div><h1>Schedules</h1><p class="sub">Schedules tell a writer when to write. Each one can remind you before it runs; the default is 20 minutes, and you can add as many reminders as you like.</p></div>
      <button class="btn primary" data-action="new-schedule">New schedule</button>
    </div>
    ${clientBanner()}
    <div class="list">${rows || `<div class="empty"><p>No schedules yet.</p>${S.writers.length ? '<button class="btn primary" data-action="new-schedule">Create a schedule</button>' : '<button class="btn primary" data-action="new-writer">Create a writer first</button>'}</div>`}</div>`;
}

// ---------- Articles ----------
function viewArticles() {
  const q = articleQuery.toLowerCase();
  const items = S.articles.filter((a) => (!q || a.title.toLowerCase().includes(q) || (a.writerName || '').toLowerCase().includes(q)) && inClient(a.published ? a.published.siteId : writerSite(a.writerId)));
  if (!selectedArticleId && items[0]) selectedArticleId = items[0].id;
  const list = items.map((a) => `
    <button class="article-item ${a.id === selectedArticleId ? 'active' : ''}" data-action="select-article" data-id="${a.id}">
      <div class="t">${esc(a.title)}</div>
      <div class="m">${esc(a.writerName)}, ${fmtDateTime(a.createdAt)}, ${a.words} words${a.quality && a.quality.score ? `, quality ${a.quality.score}/10` : ''}${a.published ? `. On ${esc(a.published.siteName)}` : a.publishError ? '. Not published' : ''}</div>
    </button>`).join('');
  return `
    <div class="page-head">
      <div><h1>Articles</h1><p class="sub">Every article is saved as a Markdown file in your output folder.</p></div>
      <button class="btn" data-action="open-dir">Open folder</button>
    </div>
    ${clientBanner()}
    ${S.articles.length ? `
    <div class="articles">
      <div class="article-list">
        <input class="search" type="text" placeholder="Search titles and writers" value="${esc(articleQuery)}" data-input="article-search" aria-label="Search articles">
        ${list || '<div class="empty">No matches.</div>'}
      </div>
      <div class="reader-wrap" id="reader-wrap"></div>
    </div>` : '<div class="list"><div class="empty"><p>No articles yet. They appear here as soon as a writer finishes one.</p><button class="btn primary" data-action="quick-run">Write an article now</button></div></div>'}`;
}

async function loadReader() {
  const wrap = document.getElementById('reader-wrap');
  if (!wrap || !selectedArticleId) return;
  const a = S.articles.find((x) => x.id === selectedArticleId);
  if (!a) { wrap.innerHTML = ''; return; }
  const bar = `
    <div class="reader-bar">
      <div class="muted small" style="align-self:center">${esc(PROVIDER_SHORT[a.provider] || a.provider)}: ${esc(a.model || 'plan default')}${a.scheduleName ? `, from "${esc(a.scheduleName)}"` : ''}</div>
      <div class="btn-row">
        <button class="btn primary" data-action="publish-article" data-id="${a.id}">Publish</button>
        ${a.published && a.published.status !== 'sent' && (S.sites.find((x) => x.id === a.published.siteId) || {}).type === 'wordpress' ? `<button class="btn" data-action="link-older" data-id="${a.id}">Link from older posts</button>` : ''}
        ${a.published && a.published.status === 'publish' ? `<button class="btn" data-action="share-article" data-id="${a.id}">Share on social</button>` : ''}
        <button class="btn" data-action="copy-article" data-id="${a.id}">Copy text</button>
        <button class="btn" data-action="open-article-file" data-id="${a.id}">Open file</button>
        <button class="btn ghost" data-action="reveal-article" data-id="${a.id}">Show in folder</button>
        <button class="btn ghost danger" data-action="delete-article" data-id="${a.id}" aria-label="Delete article">Delete</button>
      </div>
    </div>`;
  try {
    const text = await api.readArticle(a.id);
    if (selectedArticleId !== a.id) return;
    const pub = a.published
      ? `<p class="published">${a.published.status === 'publish' ? 'Published' : a.published.status === 'sent' ? 'Sent' : `Saved as ${esc(a.published.status)}`} on ${esc(a.published.siteName)} ${fmtRel(a.published.at)}.${a.published.url ? ` <a href="#" data-action="link" data-url="${esc(a.published.url)}">View</a>` : ''}${a.published.editUrl ? ` <a href="#" data-action="link" data-url="${esc(a.published.editUrl)}">Edit in WordPress</a>` : ''}</p>`
      : a.publishError ? `<p class="warn">Not published: ${esc(a.publishError)}</p>` : '';
    const q = a.quality;
    const qual = q ? (q.error ? `<p class="warn">Quality check didn't run: ${esc(q.error)}</p>` : `
      <details class="quality ${q.passed ? 'ok' : 'low'}"><summary><strong>Quality ${q.score}/10</strong>${q.revised ? ` after one revision (first draft ${q.firstScore}/10)` : ''}${q.passed ? '' : `, below your minimum of ${q.min}${a.heldForQuality ? ', so it was saved as a draft' : ''}`}${q.issues && q.issues.length ? `. ${q.issues.length} note${q.issues.length > 1 ? 's' : ''}` : ''}</summary>
        ${q.issues && q.issues.length ? `<ul>${q.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="small">No problems found.</p>'}</details>`) : '';
    const kw = a.keyword ? `<p class="muted small">Target keyword: <strong>${esc(a.keyword.keyword)}</strong>${a.keyword.volume ? `, ${esc(a.keyword.volume)} searches a month` : ''}${a.keyword.difficulty !== null && a.keyword.difficulty !== undefined ? `, difficulty ${esc(a.keyword.difficulty)}` : ''}. ${esc(a.keyword.why || '')}</p>` : '';
    const img = a.image ? `<figure class="feature"><img src="${esc(fileUrl(a.image.path))}" alt="${esc(a.image.alt)}"><figcaption>Alt text: ${esc(a.image.alt)}${a.image.credit ? ` · ${esc(a.image.credit)}` : ''}</figcaption></figure>` : a.imageError ? `<p class="warn">No featured image: ${esc(a.imageError)}</p>` : '';
    const linked = a.linkedFrom ? `<p class="muted small">Links from older posts: ${a.linkedFrom.applied ? `${a.linkedFrom.applied} added` : ''}${a.linkedFrom.queued ? `${a.linkedFrom.queued} waiting for approval` : ''}${!a.linkedFrom.applied && !a.linkedFrom.queued ? 'none found' : ''}.</p>` : '';
    const soc = a.social && a.social.posts ? `<details class="detail"><summary>Social posts (${a.social.applied ? `${a.social.applied} sent` : ''}${a.social.applied && a.social.queued ? ', ' : ''}${a.social.queued ? `${a.social.queued} waiting for approval` : ''})</summary>${Object.entries(a.social.posts).map(([k, v]) => `<p class="small"><strong>${esc(k)}:</strong> ${esc(v)}</p>`).join('')}</details>` : '';
    wrap.innerHTML = `${bar}<article class="reader">${pub}${qual}${kw}${linked}${soc}${img}${a.truncated ? '<p class="warn">This article reached the writer\'s max output length and may end abruptly. Raise "Max output tokens" on the writer.</p>' : ''}${renderMarkdown(text)}</article>`;
    wrap.querySelectorAll('a[data-external]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); api.openLink(el.href); }));
  } catch (e) {
    wrap.innerHTML = `${bar}<div class="reader"><p class="warn">${esc(cleanErr(e))}</p></div>`;
  }
}

// ---------- Providers ----------
function viewProviders() {
  const sub = S.providers.chatgpt;
  const st = sub.subscription;
  const subState = subBusy
    ? '<span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>Working…'
    : !st ? 'Not checked yet.'
    : codexPct !== null || S.codexInstall.installing ? `<span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>Downloading Codex from OpenAI… ${codexPct ?? S.codexInstall.installing.pct ?? 0}%`
    : !st.installed ? 'Codex isn\'t installed yet. Click Install Codex. It downloads once (about 160 MB) from OpenAI\'s official npm package.'
    : st.loggedIn ? `Signed in with your ${esc(st.method || 'account')}. ${esc(st.version || '')}`
    : 'Codex is installed but not signed in.';
  const subPanel = `
    <section class="panel">
      <h3>ChatGPT subscription</h3>
      <p class="muted small">Use your ChatGPT Plus, Pro or Business plan instead of paying per article. RCWriter runs OpenAI's official Codex app on this computer, which you sign in to with your ChatGPT account. Articles count toward your plan's usage limits, and your ChatGPT password never passes through RCWriter.</p>
      <p class="provider-state ${st && st.loggedIn ? 'ok' : 'muted'}">${subState}</p>
      ${loginUrl && !(st && st.loggedIn) ? `<p class="small">Browser didn't open? <a href="#" data-action="link" data-url="${esc(loginUrl)}">Open the ChatGPT sign-in page</a>.</p>` : ''}
      <div class="btn-row" style="margin-bottom:14px">
        ${st && st.loggedIn
          ? `<button class="btn" data-action="sub-status" ${subBusy ? 'disabled' : ''}>Check again</button><button class="btn ghost danger" data-action="sub-logout" ${subBusy ? 'disabled' : ''}>Sign out</button>`
          : st && !st.installed
            ? `<button class="btn primary" data-action="install-codex" ${subBusy ? 'disabled' : ''}>Install Codex</button><button class="btn" data-action="sub-status" ${subBusy ? 'disabled' : ''}>Check again</button>`
            : `<button class="btn primary" data-action="sub-login" ${subBusy || !st ? 'disabled' : ''}>Sign in with ChatGPT</button><button class="btn" data-action="sub-status" ${subBusy ? 'disabled' : ''}>${st ? 'Check again' : 'Check for Codex'}</button>`}
      </div>
      <details><summary class="small" style="cursor:pointer">Advanced</summary>
        <p class="small muted">${S.codexInstall.bundledPath ? `Codex is installed in RCWriter's folder. Click Install Codex again to update it.` : 'If you already installed Codex yourself (for example with npm), RCWriter uses that one.'} ${S.codexInstall.bundledPath && !(subBusy) ? '<button class="btn ghost small" data-action="install-codex">Update Codex</button>' : ''}</p>
        <div class="field"><label for="codex-path">Use a different Codex program (optional)</label>
          <input type="text" id="codex-path" data-setting="codexPath" value="${esc(S.settings.codexPath || '')}" placeholder="codex"></div>
      </details>
    </section>`;

  const notes = {
    anthropic: "Claude Pro and Max plans can't be used here. Anthropic only allows those sign-ins in Claude.ai and Claude Code, and blocks other apps. Use an API key from the Claude Console.",
    gemini: "Google no longer allows Google AI Pro sign-in from outside tools, so Gemini needs an API key. Google AI Studio has offered a free tier for API keys; check your limits there.",
    openai: 'Pay-as-you-go API access, billed separately from a ChatGPT subscription.'
  };
  const panels = Object.values(S.providers).filter((p) => p.kind !== 'subscription').map((p) => `
    <section class="panel">
      <h3>${esc(p.id === 'custom' && p.customLabel ? p.customLabel : p.label)}</h3>
      ${notes[p.id] ? `<p class="muted small">${notes[p.id]}</p>` : ''}
      <p class="provider-state ${p.hasKey ? 'ok' : 'muted'}">${p.hasKey ? `Key saved. ${p.models.length ? `${p.models.length} models available${p.modelsUpdated ? `, checked ${fmtRel(p.modelsUpdated)}` : ''}.` : 'Check the key to load models.'}` : p.id === 'custom' ? 'Connect any service that speaks the OpenAI chat API.' : 'No key saved.'}</p>
      ${p.id === 'custom' ? `
        <div class="grid-2">
          <div class="field"><label for="label-${p.id}">Name</label><input type="text" id="label-${p.id}" value="${esc(p.customLabel)}" placeholder="OpenRouter"></div>
          <div class="field"><label for="base-${p.id}">Base URL</label><input type="url" id="base-${p.id}" value="${esc(p.baseUrl)}" placeholder="https://openrouter.ai/api/v1"></div>
        </div>` : ''}
      <div class="field">
        <label for="key-${p.id}">API key</label>
        <div class="inline">
          <input type="password" id="key-${p.id}" placeholder="${p.hasKey ? 'Saved. Paste a new key to replace it.' : esc(p.keyHint)}" autocomplete="off">
          <button class="btn primary" data-action="save-provider" data-id="${p.id}">Save</button>
          <button class="btn" data-action="test-provider" data-id="${p.id}" ${p.hasKey || p.id === 'custom' ? '' : 'disabled'}>Check key and load models</button>
        </div>
        ${p.keyUrl ? `<span class="hint">Get a key at <a href="#" data-action="link" data-url="${esc(p.keyUrl)}">${esc(new URL(p.keyUrl).host)}</a>. Keys are encrypted with your system keychain and stay on this computer.</span>` : ''}
      </div>
      ${p.hasKey ? `<button class="btn ghost danger" data-action="remove-key" data-id="${p.id}">Remove key</button>` : ''}
    </section>`).join('');
  return `
    <div class="page-head"><div><h1>AI providers</h1><p class="sub">Sign in with a ChatGPT subscription, or use API keys. With API keys, model lists come straight from each provider, so new models appear as they're released.</p></div></div>
    <h2>Use a subscription</h2>
    ${subPanel}
    <h2>Use an API key</h2>
    ${panels}`;
}

// ---------- Settings ----------
function viewSettings() {
  const s = S.settings;
  const chk = (key, label, hint) => `
    <label class="check"><input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''}><span><strong>${label}</strong>${hint ? `<br><span class="muted small">${hint}</span>` : ''}</span></label>`;
  const lockOpts = [[0, 'Never'], [5, 'After 5 minutes'], [15, 'After 15 minutes'], [30, 'After 30 minutes'], [60, 'After 1 hour']];
  return `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <section class="panel">
      <h3>Password</h3>
      ${S.security.hasPassword ? `
        <p class="muted small">RCWriter asks for your password when it opens. Schedules keep running while it's locked.</p>
        ${chk('lockOnHide', 'Lock when I close or minimize the window')}
        <div class="field" style="max-width:280px"><label for="lock-idle">Lock when the computer is idle</label>
          <select id="lock-idle" data-setting="lockAfterMinutes">${lockOpts.map(([v, l]) => `<option value="${v}" ${Number(s.lockAfterMinutes) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="btn-row"><button class="btn" data-action="change-password">Change password</button><button class="btn" data-action="lock-now">Lock now</button><button class="btn ghost danger" data-action="remove-password">Remove password</button></div>
      ` : `
        <p class="muted small">No password is set, so anyone using this computer can open RCWriter and use your connected accounts.</p>
        <button class="btn primary" data-action="change-password">Set a password</button>
      `}
    </section>
    <section class="panel">
      <h3>Running in the background</h3><p class="muted small">RCWriter writes on schedule as long as your computer is on and you're signed in.</p>
      ${chk('launchAtLogin', 'Start when I sign in', 'Opens quietly in the tray so schedules never miss a day. Works in the installed app.')}
      ${chk('closeToTray', 'Keep running when I close the window', 'Close the window and RCWriter stays in the system tray. Use Quit in the tray menu to stop it.')}
      ${chk('keepAwake', 'Keep the app awake', 'Stops the system from suspending RCWriter in the background. Your screen can still turn off.')}
      ${chk('catchUpMissed', 'Catch up on missed articles', 'If the computer was asleep or off when an article was due, write it when the computer wakes up.')}
      <div class="field" style="max-width:280px"><label for="cw">Catch up if missed by up to</label><div class="inline"><input type="number" id="cw" min="0" max="168" data-setting="catchUpWindowHours" value="${esc(s.catchUpWindowHours)}"><span>hours</span></div></div>
    </section>
    <section class="panel">
      <h3>Notifications</h3>
      ${chk('notifyOnComplete', 'Notify me when an article is finished')}
      ${chk('notifyOnFailure', 'Notify me when an article could not be written')}
      <div class="field"><span class="label">Default reminders for new schedules</span>
        <div class="chips">${(s.defaultReminders || []).map((r) => `<span class="chip">${esc(fmtMinutes(r))}<button data-action="remove-default-reminder" data-min="${r}" aria-label="Remove">×</button></span>`).join('') || '<span class="muted small">None</span>'}
          ${reminderAdder('default')}
        </div>
      </div>
      <button class="btn" data-action="test-notify">Send a test notification</button>
    </section>
    <section class="panel">
      <h3>Images</h3>
      <p class="muted small">Writers can add a featured image to each article. Pexels photos are free; get a key at <a href="#" data-action="link" data-url="https://www.pexels.com/api/new/">pexels.com/api</a>. Generated images use your OpenAI API key and are billed by OpenAI.</p>
      <div class="field"><label for="pexels-key">Pexels API key</label><div class="inline"><input type="password" id="pexels-key" placeholder="${S.images.hasPexelsKey ? 'Saved. Paste a new key to replace it.' : 'Paste your Pexels key'}" autocomplete="off"><button class="btn" data-action="pexels-save">Save</button>${S.images.hasPexelsKey ? '<button class="btn ghost" data-action="pexels-clear">Remove</button>' : ''}</div></div>
      <div class="field" style="max-width:320px"><label for="img-model">OpenAI image model</label><input type="text" id="img-model" value="${esc(S.images.model)}" data-input-images="model"><span class="hint">gpt-image-1 by default. Saved when you leave the field.</span></div>
    </section>
    <section class="panel">
      <h3>Saving articles</h3>
      <div class="field"><label>Output folder</label><div class="inline"><input type="text" value="${esc(s.outputDir)}" readonly><button class="btn" data-action="pick-dir">Change</button><button class="btn ghost" data-action="open-dir">Open</button></div>
      <span class="hint">Each writer gets its own subfolder.</span></div>
    </section>
    <section class="panel">
      <h3>Appearance</h3>
      <div class="field" style="max-width:240px"><label for="theme">Theme</label>
        <select id="theme" data-setting="theme">${['system', 'light', 'dark'].map((t) => `<option value="${t}" ${s.theme === t ? 'selected' : ''}>${t === 'system' ? 'Match system' : t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>
      </div>
      <p class="muted small">RCWriter ${esc(S.version)}</p>
    </section>
    <section class="panel">
      <h3>About</h3>
      <p><strong>RCWriter</strong> is created and owned by <strong>Rustom Codilan</strong>.</p>
      <p class="small"><a href="#" data-action="link" data-url="https://tomdigitalspace.com/">tomdigitalspace.com</a></p>
      <p class="muted small">Copyright © 2026 Rustom Codilan. All rights reserved. This software is licensed, not sold. Copying, modifying, reverse engineering, redistributing or reselling it without the owner's written permission is not allowed.</p>
    </section>`;
}

function reminderAdder(scope) {
  return `<span class="inline" style="width:auto">
    <input type="number" min="1" value="20" style="width:76px" data-reminder-amount="${scope}" aria-label="Reminder amount">
    <select style="width:auto" data-reminder-unit="${scope}" aria-label="Reminder unit"><option value="1">minutes</option><option value="60">hours</option><option value="1440">days</option></select>
    <button class="btn" data-action="add-reminder" data-scope="${scope}">Add reminder</button></span>`;
}

function readReminder(scope, root = document) {
  const amt = Number(root.querySelector(`[data-reminder-amount="${scope}"]`)?.value);
  const unit = Number(root.querySelector(`[data-reminder-unit="${scope}"]`)?.value || 1);
  if (!(amt > 0)) return null;
  return Math.round(amt * unit);
}

// ---------- Writer modal ----------
function blankWriter() {
  const firstProvider = Object.values(S.providers).find((p) => p.hasKey)?.id || 'anthropic';
  return {
    name: '', persona: '', attitude: '', knowledge: '', knowledgeFiles: [], instructions: '',
    topics: '', topicMode: 'rotate', language: 'English', targetWords: 1200,
    provider: firstProvider, model: '', temperature: '', maxTokens: 8000, avoidRepeats: true, includeMeta: false,
    siteId: '', publishStatus: 'draft', wpCategories: '', wpTags: '',
    qualityCheck: true, qualityMinScore: 7, qualityRevise: true, imageSource: 'none', schemaTypes: [], business: {}, linkOlderPosts: 'off', researchConnectorIds: []
  };
}

function openWriterModal(w) {
  modal = { type: 'writer', draft: JSON.parse(JSON.stringify(w || blankWriter())) };
  renderModal();
  loadModelsForModal(false);
}

function researchBox(d) {
  const conns = S.connectors;
  return `<div class="subpanel">
    <p class="small" style="margin-top:0">Before each article, the AI researches keywords around your topics, skips anything your site already covers, and picks one with real searches and low difficulty.</p>
    <span class="label">Use these connections</span>
    <div class="checks">${conns.map((c) => `<label class="check"><input type="checkbox" name="researchConn" value="${c.id}" ${(d.researchConnectorIds || []).includes(c.id) ? 'checked' : ''}><span>${esc(c.name)}</span></label>`).join('') || '<span class="muted small">None yet. Add Ahrefs or Semrush under Site audits, Connections.</span>'}</div>
    <div class="grid-2"><div class="field"><label for="w-country">Market (optional)</label><input type="text" id="w-country" name="researchCountry" value="${esc(d.researchCountry || '')}" placeholder="United Kingdom"></div>
    <div class="field"><label for="w-rcalls">Max research tool calls</label><input type="number" id="w-rcalls" name="researchMaxCalls" min="5" max="40" value="${esc(d.researchMaxCalls || 20)}"></div></div>
    <span class="hint">Search Console data for the chosen website is used too. If research fails, the writer falls back to its topics.</span>
  </div>`;
}

function businessBox(d) {
  const b = d.business || {};
  const f = (k, label, ph) => `<div class="field"><label for="biz-${k}">${label}</label><input type="text" id="biz-${k}" name="biz.${k}" value="${esc(b[k] || '')}" placeholder="${ph}"></div>`;
  return `<div class="subpanel"><div class="grid-2">
    ${f('name', 'Business name', 'Eco Pro Properties')}${f('type', 'Schema type', 'LocalBusiness, RealEstateAgent, Plumber…')}
    ${f('address', 'Address', '12 High Street, Leeds LS1 4AB')}${f('phone', 'Phone', '+44 113 000 0000')}
    ${f('url', 'Website', 'https://…')}${f('area', 'Area served', 'Leeds and West Yorkshire')}
  </div></div>`;
}

function writerModalHtml(d) {
  const provOpts = Object.values(S.providers).map((p) => `<option value="${p.id}" ${d.provider === p.id ? 'selected' : ''}>${esc(p.id === 'custom' && p.customLabel ? p.customLabel : p.label)}${p.hasKey || p.id === 'custom' ? '' : p.kind === 'subscription' ? ' (not signed in)' : ' (no key)'}</option>`).join('');
  const siteOpts = `<option value="">Don't publish, just save to my computer</option>` + S.sites.filter((x) => x.type !== 'url').map((x) => `<option value="${x.id}" ${d.siteId === x.id ? 'selected' : ''}>${esc(x.name)} (${x.type === 'wordpress' ? 'WordPress' : 'webhook'})</option>`).join('');
  const ctxSite = S.sites.find((x) => x.id === d.siteId);
  const ctxHtml = ctxSite ? `
          <div class="field"><span class="label">Use data from ${esc(ctxSite.name)}</span>
            ${ctxSite.type === 'wordpress' ? `<label class="check"><input type="checkbox" name="useSitePosts" ${d.useSitePosts !== false ? 'checked' : ''}><span>Read the site's published posts, so new articles don't repeat them and link to related ones</span></label>` : ''}
            ${ctxSite.google && ctxSite.google.gscSite && S.google.connected ? `<label class="check"><input type="checkbox" name="useSearchConsole" ${d.useSearchConsole !== false ? 'checked' : ''}><span>Use Search Console: aim articles at searches the site already appears for but isn't top 3 yet</span></label>` : `<span class="hint">Link this site's Search Console in Websites to let articles target searches it almost ranks for.</span>`}
          </div>` : '';
  return `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${d.id ? 'Edit writer' : 'New writer'}</h2></header>
      <div class="body">
        <div class="field"><label for="w-name">Name</label><input type="text" id="w-name" name="name" value="${esc(d.name)}" placeholder="Travel blog: Mindanao guides"></div>

        <fieldset><legend>Who is writing</legend>
          <div class="field"><label for="w-persona">Persona</label><input type="text" id="w-persona" name="persona" value="${esc(d.persona)}" placeholder="a local travel writer who has lived in Northern Mindanao for 15 years">
            <span class="hint">Finishes the sentence "You are…"</span></div>
          <div class="field"><label for="w-attitude">Voice and attitude</label><textarea id="w-attitude" name="attitude" placeholder="Warm, practical and honest. Short paragraphs. Speaks to the reader as a friend. Never overhypes.">${esc(d.attitude)}</textarea></div>
        </fieldset>

        <fieldset><legend>What it knows</legend>
          <div class="field"><label for="w-knowledge">Knowledge</label><textarea id="w-knowledge" name="knowledge" style="min-height:120px" placeholder="Facts, product details, prices, brand rules, sources: anything the writer should rely on.">${esc(d.knowledge)}</textarea></div>
          <div class="field"><span class="label">Knowledge files</span>
            <span class="hint">Text, Markdown, CSV, JSON or HTML files. They're re-read every time, so edits to the files are picked up automatically.</span>
            <ul class="files">${(d.knowledgeFiles || []).map((f, i) => `<li><span>${esc(f)}</span><button class="btn ghost" data-action="remove-file" data-i="${i}">Remove</button></li>`).join('')}</ul>
            <div><button class="btn" data-action="add-files">Add files</button></div>
          </div>
        </fieldset>

        <fieldset><legend>What to write</legend>
          <div class="field"><label for="w-instr">Instructions</label><textarea id="w-instr" name="instructions" style="min-height:110px" placeholder="Use H2 subheadings. Include a short FAQ at the end. Mention prices in PHP. End with a clear call to action.">${esc(d.instructions)}</textarea></div>
          <div class="field"><label for="w-topics">Topics, one per line</label><textarea id="w-topics" name="topics" placeholder="Best waterfalls near Cagayan de Oro&#10;White water rafting for beginners&#10;Budget weekend itinerary">${esc(d.topics)}</textarea>
            <span class="hint">Leave empty to let the AI choose based on the instructions and knowledge. Titles it has already written are avoided.</span></div>
          <div class="grid-3">
            <div class="field"><label for="w-mode">Topic order</label><select id="w-mode" name="topicMode" data-change="writer-rerender">
              <option value="rotate" ${d.topicMode === 'rotate' ? 'selected' : ''}>Go through in order</option>
              <option value="random" ${d.topicMode === 'random' ? 'selected' : ''}>Pick at random</option>
              <option value="ai" ${d.topicMode === 'ai' ? 'selected' : ''}>Treat as themes; AI picks an angle</option>
              <option value="research" ${d.topicMode === 'research' ? 'selected' : ''}>Research a keyword first</option>
              <option value="plan" ${d.topicMode === 'plan' ? 'selected' : ''}>Follow the topic plan</option></select></div>
            <div class="field"><label for="w-lang">Language</label><input type="text" id="w-lang" name="language" value="${esc(d.language)}"></div>
            <div class="field"><label for="w-words">Target length (words)</label><input type="number" id="w-words" name="targetWords" min="100" step="100" value="${esc(d.targetWords)}"></div>
          </div>
          ${d.topicMode === 'research' ? researchBox(d) : ''}
          <label class="check"><input type="checkbox" name="avoidRepeats" ${d.avoidRepeats !== false ? 'checked' : ''}><span>Avoid repeating titles this writer has already written</span></label>
          <label class="check"><input type="checkbox" name="includeMeta" ${d.includeMeta ? 'checked' : ''}><span>Add an SEO meta description at the end</span></label>
        </fieldset>

        <fieldset><legend>AI model</legend>
          <div class="grid-2">
            <div class="field"><label for="w-prov">Provider</label><select id="w-prov" name="provider" data-change="writer-provider">${provOpts}</select></div>
            <div class="field"><label for="w-model">Model</label>
              <div class="inline"><input type="text" id="w-model" name="model" list="model-list" value="${esc(d.model)}" placeholder="Choose or type a model ID"><button class="btn" data-action="refresh-models" title="Reload models from the provider">Reload</button></div>
              <datalist id="model-list"></datalist><span class="hint" id="model-hint"></span></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="w-temp">Creativity (temperature)</label><input type="number" id="w-temp" name="temperature" min="0" max="2" step="0.1" value="${esc(d.temperature)}" placeholder="Model default"><span class="hint">Leave blank for the model's default. Some reasoning models ignore this.</span></div>
            <div class="field"><label for="w-max">Max output tokens</label><input type="number" id="w-max" name="maxTokens" min="500" step="500" value="${esc(d.maxTokens)}"><span class="hint">About 1.4 tokens per word. Raise it for long articles or thinking models. Not used with a ChatGPT subscription.</span></div>
          </div>
        </fieldset>

        <fieldset><legend>Before publishing</legend>
          <label class="check"><input type="checkbox" name="qualityCheck" data-change="writer-rerender" ${d.qualityCheck ? 'checked' : ''}><span><strong>Have an AI editor check each article</strong><br><span class="muted small">Checks facts against the knowledge, the instructions, voice and length, and scores it out of 10.</span></span></label>
          ${d.qualityCheck ? `<div class="grid-2" style="margin-left:26px">
            <div class="field"><label for="w-qmin">Minimum score to publish</label><input type="number" id="w-qmin" name="qualityMinScore" min="1" max="10" value="${esc(d.qualityMinScore || 7)}"><span class="hint">Below this, the article is saved as a draft instead of going live.</span></div>
            <div class="field"><span class="label">&nbsp;</span><label class="check"><input type="checkbox" name="qualityRevise" ${d.qualityRevise !== false ? 'checked' : ''}><span>Rewrite once to fix what the editor found</span></label></div>
          </div>` : ''}
          <div class="grid-2">
            <div class="field"><label for="w-img">Featured image</label><select id="w-img" name="imageSource">
              <option value="none" ${!d.imageSource || d.imageSource === 'none' ? 'selected' : ''}>No image</option>
              <option value="pexels" ${d.imageSource === 'pexels' ? 'selected' : ''}>Free stock photo from Pexels</option>
              <option value="openai" ${d.imageSource === 'openai' ? 'selected' : ''}>Generate with OpenAI</option></select>
              <span class="hint">The AI writes the alt text. ${!S.images.hasPexelsKey && d.imageSource === 'pexels' ? 'Add a free Pexels key in Settings first.' : !S.images.hasOpenAiKey && d.imageSource === 'openai' ? 'Needs an OpenAI API key under AI providers (billed per image).' : 'Pexels needs a free key in Settings; OpenAI uses your API key.'}</span></div>
            <div class="field"><span class="label">Schema markup</span>
              <div class="checks col">
                <label class="check"><input type="checkbox" name="schemaType" value="article" ${(d.schemaTypes || []).includes('article') ? 'checked' : ''}><span>Article</span></label>
                <label class="check"><input type="checkbox" name="schemaType" value="faq" ${(d.schemaTypes || []).includes('faq') ? 'checked' : ''}><span>FAQ (when the article has an FAQ section)</span></label>
                <label class="check"><input type="checkbox" name="schemaType" value="localBusiness" data-change="writer-rerender" ${(d.schemaTypes || []).includes('localBusiness') ? 'checked' : ''}><span>Local business</span></label>
              </div></div>
          </div>
          ${(d.schemaTypes || []).includes('localBusiness') ? businessBox(d) : ''}
        </fieldset>

        <fieldset><legend>Where to publish</legend>
          ${S.sites.length ? `
          <div class="grid-2">
            <div class="field"><label for="w-site">Website</label><select id="w-site" name="siteId" data-change="writer-site">${siteOpts}</select></div>
            <div class="field"><label for="w-pstatus">How to publish</label><select id="w-pstatus" name="publishStatus">${['draft', 'pending', 'publish', 'private'].map((k) => `<option value="${k}" ${(d.publishStatus || 'draft') === k ? 'selected' : ''}>${STATUS_LABEL[k]}</option>`).join('')}</select>
              <span class="hint">Drafts let you review each article in WordPress before it goes live.</span></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="w-cats">Categories</label><input type="text" id="w-cats" name="wpCategories" value="${esc(d.wpCategories)}" placeholder="Travel, Guides"><span class="hint">Separate with commas. Missing ones are created.</span></div>
            <div class="field"><label for="w-tags">Tags</label><input type="text" id="w-tags" name="wpTags" value="${esc(d.wpTags)}" placeholder="mindanao, budget travel"></div>
          </div>
          ${ctxSite && ctxSite.type === 'wordpress' ? `<div class="field"><label for="w-link">Links from older posts</label><select id="w-link" name="linkOlderPosts">
            <option value="off" ${!d.linkOlderPosts || d.linkOlderPosts === 'off' ? 'selected' : ''}>Don't add any</option>
            <option value="approve" ${d.linkOlderPosts === 'approve' ? 'selected' : ''}>Suggest links for me to approve</option>
            <option value="auto" ${d.linkOlderPosts === 'auto' ? 'selected' : ''}>Add them automatically</option></select>
            <span class="hint">When an article goes live, the AI finds up to 3 related older posts and links a natural phrase in each to the new one. Every change is logged and can be undone.</span></div>` : ''}
          <div id="w-ctx">${ctxHtml}</div>` : `<p class="muted small">Articles are saved to your computer. To publish them automatically, <a href="#" data-action="goto-sites">connect a website</a> first.</p>`}
        </fieldset>
        ${window.socialBox ? window.socialBox(d) : ''}
      </div>
      <footer>
        <button class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="save-writer">${d.id ? 'Save writer' : 'Create writer'}</button>
      </footer>
    </div>`;
}

function readWriterForm() {
  const d = modal.draft;
  const root = modalRoot;
  root.querySelectorAll('[name]').forEach((el) => {
    if (['researchConn', 'schemaType'].includes(el.name) || el.name.startsWith('biz.') || el.name.startsWith('soc.')) return;
    d[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  if (root.querySelector('[name=researchConn]') || d.topicMode === 'research') d.researchConnectorIds = [...root.querySelectorAll('[name=researchConn]:checked')].map((el) => el.value);
  if (root.querySelector('[name=schemaType]')) d.schemaTypes = [...root.querySelectorAll('[name=schemaType]:checked')].map((el) => el.value);
  if (root.querySelector('[name^="biz."]')) { d.business = { ...(d.business || {}) }; root.querySelectorAll('[name^="biz."]').forEach((el) => { d.business[el.name.slice(4)] = el.value.trim(); }); }
  d.qualityMinScore = Math.max(1, Math.min(10, Number(d.qualityMinScore) || 7));
  if (root.querySelector('[name="soc.enabled"]')) {
    const q = (n) => root.querySelector(`[name="${n}"]`);
    d.social = { enabled: q('soc.enabled').checked, mode: q('soc.mode') ? q('soc.mode').value : 'approve',
      bufferProfileIds: [...root.querySelectorAll('[name="soc.buffer"]:checked')].map((el) => el.value),
      webhook: q('soc.webhook') ? q('soc.webhook').checked : false, webhookPlatforms: [...root.querySelectorAll('[name="soc.plat"]:checked')].map((el) => el.value) };
  }
  if (!d.siteId) d.publishStatus = 'none'; else if (d.publishStatus === 'none') d.publishStatus = 'draft';
  d.targetWords = Number(d.targetWords) || 1200;
  d.maxTokens = Number(d.maxTokens) || 8000;
  return d;
}

async function loadModelsForModal(refresh) {
  if (!modal || modal.type !== 'writer') return;
  const provider = modalRoot.querySelector('[name=provider]').value;
  const dl = modalRoot.querySelector('#model-list');
  const hint = modalRoot.querySelector('#model-hint');
  const p = S.providers[provider];
  if (provider === 'chatgpt') {
    dl.innerHTML = '';
    modalRoot.querySelector('[name=model]').placeholder = "Your plan's default model";
    hint.textContent = p.hasKey
      ? "Leave blank to use your ChatGPT plan's default model, or type a model name shown in Codex's /model menu."
      : 'Sign in with ChatGPT under AI providers before this writer can run.';
    return;
  }
  modalRoot.querySelector('[name=model]').placeholder = 'Choose or type a model ID';
  if (!p.hasKey && provider !== 'custom') { hint.textContent = 'Add an API key for this provider to see its models.'; dl.innerHTML = ''; return; }
  hint.textContent = 'Loading models…';
  try {
    const models = await api.listModels(provider, refresh);
    if (!modal || modalRoot.querySelector('[name=provider]')?.value !== provider) return;
    dl.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name !== m.id ? m.name : '')}</option>`).join('');
    hint.textContent = `${models.length} models available. Click the field to browse or type to filter.`;
    const input = modalRoot.querySelector('[name=model]');
    if (!input.value && models[0]) input.value = models[0].id;
  } catch (e) {
    hint.textContent = cleanErr(e);
  }
}

// ---------- Schedule modal ----------
function openScheduleModal(s) {
  if (!S.writers.length) { toast('Create a writer first.', 'error'); view = 'writers'; render(); return; }
  const draft = s ? JSON.parse(JSON.stringify(s)) : {
    name: '', writerId: S.writers[0].id, enabled: true, type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5],
    at: toLocalInput(nextHour()), intervalHours: 6, startAt: toLocalInput(nextHour()), count: 1, topicOverride: '',
    reminders: [...(S.settings.defaultReminders || [20])], notifyOnComplete: true
  };
  modal = { type: 'schedule', draft };
  renderModal();
  updatePreview();
}

function scheduleModalHtml(d) {
  const types = [['once', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['interval', 'Every few hours']];
  let when = '';
  if (d.type === 'once') when = `<div class="field" style="max-width:300px"><label for="s-at">Date and time</label><input type="datetime-local" id="s-at" name="at" value="${esc(d.at)}"></div>`;
  if (d.type === 'daily') when = `<div class="field" style="max-width:200px"><label for="s-time">Time</label><input type="time" id="s-time" name="time" value="${esc(d.time)}"></div>`;
  if (d.type === 'weekly') when = `
    <div class="field"><span class="label">Days</span><div class="days">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="day" value="${i}" ${(d.days || []).map(Number).includes(i) ? 'checked' : ''}><span>${DAY_NAMES[i]}</span></label>`).join('')}</div></div>
    <div class="field" style="max-width:200px"><label for="s-time">Time</label><input type="time" id="s-time" name="time" value="${esc(d.time)}"></div>`;
  if (d.type === 'interval') when = `
    <div class="grid-2">
      <div class="field"><label for="s-int">Every</label><div class="inline"><input type="number" id="s-int" name="intervalHours" min="0.25" step="0.25" value="${esc(d.intervalHours)}"><span>hours</span></div></div>
      <div class="field"><label for="s-start">Starting</label><input type="datetime-local" id="s-start" name="startAt" value="${esc(d.startAt)}"></div>
    </div>`;

  return `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${d.id ? 'Edit schedule' : 'New schedule'}</h2></header>
      <div class="body">
        <div class="grid-2">
          <div class="field"><label for="s-name">Name</label><input type="text" id="s-name" name="name" value="${esc(d.name)}" placeholder="Morning travel post"></div>
          <div class="field"><label for="s-writer">Writer</label><select id="s-writer" name="writerId">${S.writers.map((w) => `<option value="${w.id}" ${d.writerId === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
        </div>
        <fieldset><legend>When</legend>
          <div class="field"><div class="seg" role="group" aria-label="Repeat">${types.map(([v, l]) => `<button type="button" class="${d.type === v ? 'on' : ''}" data-action="schedule-type" data-type="${v}" aria-pressed="${d.type === v}">${l}</button>`).join('')}</div></div>
          ${when}
          <p class="preview" id="preview"></p>
        </fieldset>
        <fieldset><legend>What</legend>
          <div class="grid-2">
            <div class="field"><label for="s-count">Articles each time</label><input type="number" id="s-count" name="count" min="1" max="10" value="${esc(d.count || 1)}"></div>
            <div class="field"><label for="s-topic">Topic for this schedule</label><input type="text" id="s-topic" name="topicOverride" value="${esc(d.topicOverride)}" placeholder="Leave blank to use the writer's topics"></div>
          </div>
        </fieldset>
        <fieldset><legend>Notifications</legend>
          <div class="field"><span class="label">Remind me before it runs</span>
            <div class="chips">${(d.reminders || []).map((r) => `<span class="chip">${esc(fmtMinutes(r))}<button data-action="remove-reminder" data-min="${r}" aria-label="Remove reminder">×</button></span>`).join('') || '<span class="muted small">No reminders</span>'}
            ${reminderAdder('schedule')}</div>
          </div>
          <label class="check"><input type="checkbox" name="notifyOnComplete" ${d.notifyOnComplete !== false ? 'checked' : ''}><span>Notify me when the article is finished</span></label>
        </fieldset>
      </div>
      <footer>
        <button class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="save-schedule">${d.id ? 'Save schedule' : 'Create schedule'}</button>
      </footer>
    </div>`;
}

function readScheduleForm() {
  const d = modal.draft;
  const get = (n) => modalRoot.querySelector(`[name="${n}"]`);
  ['name', 'writerId', 'topicOverride', 'at', 'time', 'intervalHours', 'startAt', 'count'].forEach((n) => { if (get(n)) d[n] = get(n).value; });
  if (d.type === 'weekly') d.days = [...modalRoot.querySelectorAll('[name=day]:checked')].map((el) => Number(el.value));
  const noc = get('notifyOnComplete'); if (noc) d.notifyOnComplete = noc.checked;
  d.count = Math.max(1, Math.min(10, Number(d.count) || 1));
  d.intervalHours = Number(d.intervalHours) || 6;
  return d;
}

let previewTimer = null;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!modal || modal.type !== 'schedule') return;
    const el = modalRoot.querySelector('#preview');
    const d = readScheduleForm();
    try {
      const times = await api.previewSchedule({ ...d });
      el.innerHTML = times.length ? `Next: ${times.map((t, i) => i === 0 ? `<strong>${fmtDateTime(t)}</strong>` : fmtDateTime(t)).join(', ')}` : 'That time has already passed.';
    } catch { el.textContent = ''; }
  }, 150);
}

// ---------- Small modals ----------
function openPasswordModal(mode = 'set') {
  const has = S.security.hasPassword;
  modal = { type: 'password', mode };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${mode === 'remove' ? 'Remove password' : has ? 'Change password' : 'Set a password'}</h2></header>
      <div class="body">
        ${has ? '<div class="field"><label for="pw-current">Current password</label><input type="password" id="pw-current" autocomplete="current-password"></div>' : ''}
        ${mode === 'remove' ? '<p class="muted small">Anyone using this computer will be able to open RCWriter without a password.</p>' : `
        <div class="field"><label for="pw-new">New password</label><input type="password" id="pw-new" autocomplete="new-password"><span class="hint">At least 6 characters.</span></div>
        <div class="field"><label for="pw-new2">Confirm new password</label><input type="password" id="pw-new2" autocomplete="new-password"></div>`}
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="save-password">${mode === 'remove' ? 'Remove password' : has ? 'Change password' : 'Set password'}</button></div></footer>
    </div></div>`;
  modalRoot.querySelector('input')?.focus();
}
function confirmModal({ title, body, confirm, danger, extra = '' }) {
  return new Promise((resolve) => {
    modal = { type: 'confirm', resolve };
    modalRoot.innerHTML = `
      <div class="backdrop"><div class="modal small" role="alertdialog" aria-modal="true" aria-labelledby="mt">
        <header><h2 id="mt">${esc(title)}</h2></header>
        <div class="body"><p>${esc(body)}</p>${extra}</div>
        <footer><button class="btn ghost" data-action="confirm-no">Cancel</button><button class="btn ${danger ? 'primary' : 'primary'}" data-action="confirm-yes">${esc(confirm)}</button></footer>
      </div></div>`;
    modalRoot.querySelector('[data-action=confirm-yes]').focus();
  });
}

function chooseLinkMode() {
  return new Promise((resolve) => {
    modal = { type: 'confirm', resolve };
    modalRoot.innerHTML = `
      <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
        <header><h2 id="mt">Link from older posts</h2></header>
        <div class="body"><p class="small">The AI picks up to 3 related posts on the same site and links a natural phrase in each to this article.</p>
          <label class="check"><input type="radio" name="lm" value="approve" checked><span>Let me approve each link first</span></label>
          <label class="check"><input type="radio" name="lm" value="auto"><span>Add them now (each can be undone in the Change log)</span></label></div>
        <footer><button class="btn ghost" data-action="confirm-no">Cancel</button><button class="btn primary" data-action="link-mode-ok">Find links</button></footer>
      </div></div>`;
  });
}

function openRunModal(writerId) {
  if (!S.writers.length) { toast('Create a writer first.', 'error'); view = 'writers'; render(); return; }
  modal = { type: 'run' };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">Write an article now</h2></header>
      <div class="body">
        <div class="field"><label for="r-writer">Writer</label><select id="r-writer">${S.writers.map((w) => `<option value="${w.id}" ${w.id === writerId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="r-topic">Topic</label><input type="text" id="r-topic" placeholder="Leave blank to use the writer's topics"></div>
      </div>
      <footer><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-run">Start writing</button></footer>
    </div></div>`;
  modalRoot.querySelector('#r-topic').focus();
}

function renderModal() {
  if (!modal) { modalRoot.innerHTML = ''; return; }
  const html = modal.type === 'writer' ? writerModalHtml(modal.draft) : scheduleModalHtml(modal.draft);
  const scroll = modalRoot.querySelector('.body')?.scrollTop || 0;
  modalRoot.innerHTML = `<div class="backdrop">${html}</div>`;
  modalRoot.querySelector('.body').scrollTop = scroll;
  if (!scroll) modalRoot.querySelector('input,select,textarea')?.focus();
}

function closeModal() {
  if (modal?.resolve) modal.resolve(false);
  modal = null;
  modalRoot.innerHTML = '';
}

// ---------- Actions ----------
const ACTIONS = {
  nav: (el) => { view = el.dataset.view; main.scrollTop = 0; render(); main.focus(); },
  link: (el, e) => { e.preventDefault(); api.openLink(el.dataset.url); },
  'toggle-pause': () => attempt(() => api.saveSettings({ paused: !S.settings.paused }), S.settings.paused ? 'Schedules resumed' : 'Schedules paused'),
  'quick-run': () => openRunModal(),
  'run-writer': (el) => openRunModal(el.dataset.id),
  'confirm-run': async () => {
    const id = modalRoot.querySelector('#r-writer').value;
    const topic = modalRoot.querySelector('#r-topic').value;
    closeModal();
    await attempt(() => api.runWriter(id, topic), 'Writing started. You\'ll get a notification when it\'s done.');
  },

  'new-writer': () => openWriterModal(),
  'edit-writer': (el) => openWriterModal(S.writers.find((w) => w.id === el.dataset.id)),
  'delete-writer': async (el) => {
    const w = S.writers.find((x) => x.id === el.dataset.id);
    const n = S.schedules.filter((s) => s.writerId === w.id).length;
    if (await confirmModal({ title: `Delete ${w.name}?`, body: `${n ? `Its ${n} schedule${n > 1 ? 's' : ''} will be deleted too. ` : ''}Articles it already wrote stay in your folder.`, confirm: 'Delete writer' })) {
      closeModal();
      await attempt(() => api.deleteWriter(w.id), 'Writer deleted');
    }
  },
  'add-files': async () => {
    readWriterForm();
    const files = await api.pickKnowledgeFiles();
    modal.draft.knowledgeFiles = [...new Set([...(modal.draft.knowledgeFiles || []), ...files])];
    renderModal();
    loadModelsForModal(false);
  },
  'remove-file': (el) => {
    readWriterForm();
    modal.draft.knowledgeFiles.splice(Number(el.dataset.i), 1);
    renderModal();
    loadModelsForModal(false);
  },
  'refresh-models': () => loadModelsForModal(true),
  'save-writer': async () => {
    const d = readWriterForm();
    if (!d.model && d.provider !== 'chatgpt') { toast('Choose a model for this writer.', 'error'); return; }
    await attempt(() => api.saveWriter(d), d.id ? 'Writer saved' : 'Writer created');
    closeModal();
  },

  'new-schedule': () => openScheduleModal(),
  'edit-schedule': (el) => openScheduleModal(S.schedules.find((s) => s.id === el.dataset.id)),
  'delete-schedule': async (el) => {
    const s = S.schedules.find((x) => x.id === el.dataset.id);
    if (await confirmModal({ title: `Delete "${s.name}"?`, body: 'It will stop writing articles. Articles already written are kept.', confirm: 'Delete schedule' })) {
      closeModal();
      await attempt(() => api.deleteSchedule(s.id), 'Schedule deleted');
    }
  },
  'schedule-type': (el) => { readScheduleForm(); modal.draft.type = el.dataset.type; renderModal(); updatePreview(); },
  'add-reminder': async (el) => {
    const scope = el.dataset.scope;
    const mins = readReminder(scope, scope === 'default' ? main : modalRoot);
    if (!mins) { toast('Enter how long before the article you want the reminder.', 'error'); return; }
    if (scope === 'default') {
      const list = [...new Set([...(S.settings.defaultReminders || []), mins])].sort((a, b) => b - a);
      await attempt(() => api.saveSettings({ defaultReminders: list }));
    } else {
      readScheduleForm();
      modal.draft.reminders = [...new Set([...(modal.draft.reminders || []), mins])].sort((a, b) => b - a);
      renderModal(); updatePreview();
    }
  },
  'remove-reminder': (el) => {
    readScheduleForm();
    modal.draft.reminders = modal.draft.reminders.filter((r) => Number(r) !== Number(el.dataset.min));
    renderModal(); updatePreview();
  },
  'remove-default-reminder': (el) => attempt(() => api.saveSettings({ defaultReminders: S.settings.defaultReminders.filter((r) => Number(r) !== Number(el.dataset.min)) })),
  'save-schedule': async () => {
    const d = readScheduleForm();
    await attempt(() => api.saveSchedule({ ...d, enabled: true }), d.id ? 'Schedule saved' : 'Schedule created');
    closeModal();
  },

  'select-article': (el) => { selectedArticleId = el.dataset.id; render(); },
  'open-article': (el) => { view = 'articles'; selectedArticleId = el.dataset.id; render(); },
  'copy-article': async (el) => {
    const text = await api.readArticle(el.dataset.id);
    await navigator.clipboard.writeText(window.stripFrontMatter(text));
    toast('Article copied');
  },
  'open-article-file': (el) => api.openArticleFile(el.dataset.id),
  'reveal-article': (el) => api.revealArticle(el.dataset.id),
  'delete-article': async (el) => {
    const a = S.articles.find((x) => x.id === el.dataset.id);
    const ok = await confirmModal({ title: 'Delete this article?', body: a.title, confirm: 'Delete article', extra: '<label class="check"><input type="checkbox" id="del-file" checked><span>Also delete the file from my computer</span></label>' });
    if (ok) {
      const removeFile = modalRoot.querySelector('#del-file')?.checked;
      closeModal();
      selectedArticleId = null;
      await attempt(() => api.deleteArticle(a.id, removeFile), 'Article deleted');
    }
  },
  'open-dir': () => api.openOutputDir(),
  'pick-dir': () => attempt(() => api.pickOutputDir()),
  'test-notify': () => api.testNotification(),

  'save-provider': async (el) => {
    const id = el.dataset.id;
    const cfg = {};
    const key = main.querySelector(`#key-${id}`).value.trim();
    if (key) cfg.key = key;
    if (id === 'custom') { cfg.baseUrl = main.querySelector('#base-custom').value; cfg.label = main.querySelector('#label-custom').value; }
    if (!Object.keys(cfg).length) { toast('Paste an API key first.', 'error'); return; }
    await attempt(() => api.setProvider(id, cfg), 'Saved');
    try { const m = await api.listModels(id, true); toast(`Key works. ${m.length} models available.`); }
    catch (e) { toast(`Saved, but the check failed: ${cleanErr(e)}`, 'error'); }
  },
  'test-provider': async (el) => {
    el.disabled = true; el.textContent = 'Checking…';
    try { const m = await api.listModels(el.dataset.id, true); toast(`Key works. ${m.length} models available.`); }
    catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Check key and load models'; }
  },
  'remove-key': async (el) => {
    if (await confirmModal({ title: 'Remove this API key?', body: 'Writers using this provider will stop working until you add a key again.', confirm: 'Remove key' })) {
      closeModal();
      await attempt(() => api.setProvider(el.dataset.id, { key: '' }), 'Key removed');
    }
  },

  'goto-sites': () => { closeModal(); view = 'sites'; render(); },
  'pexels-save': () => { const v = main.querySelector('#pexels-key').value.trim(); if (!v) { toast('Paste the key first.', 'error'); return; } return attempt(() => api.setImages({ pexelsKey: v }), 'Pexels key saved'); },
  'pexels-clear': () => attempt(() => api.setImages({ pexelsKey: '' }), 'Pexels key removed'),
  'link-older': async (el) => {
    const mode = await chooseLinkMode();
    if (!mode) return;
    el.disabled = true; el.textContent = 'Finding related posts…';
    try {
      const r = await api.linkOlderPosts(el.dataset.id, mode);
      toast(r.applied ? `Added ${r.applied} link${r.applied > 1 ? 's' : ''} from older posts.` : r.queued ? `${r.queued} link${r.queued > 1 ? 's are' : ' is'} waiting in Site audits, Approvals.` : 'No older posts were a good fit for a link.');
    } catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Link from older posts'; }
  },
  'new-wordpress': () => openWordPressModal(),
  'reconnect-site': (el) => openWordPressModal(S.sites.find((x) => x.id === el.dataset.id)),
  'wp-toggle-manual': () => { const url = modalRoot.querySelector('#wp-url').value; modal.manual = !modal.manual; renderWpModal(); modalRoot.querySelector('#wp-url').value = url; },
  'wp-approve': async (el) => {
    const url = modalRoot.querySelector('#wp-url').value;
    el.disabled = true;
    try {
      const r = await api.wpConnect(url, modal.site?.id);
      modalRoot.querySelector('#wp-wait').hidden = false;
      modalRoot.querySelector('#wp-wait').insertAdjacentHTML('beforeend', ` <a href="#" data-action="link" data-url="${esc(r.authorizeUrl)}">Open the page again</a>`);
    } catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; }
  },
  'wp-save-manual': async (el) => {
    el.disabled = true;
    try {
      await api.saveSiteManual({ id: modal.site?.id, type: 'wordpress', url: modalRoot.querySelector('#wp-url').value, username: modalRoot.querySelector('#wp-user').value, password: modalRoot.querySelector('#wp-pass').value });
      toast('Website connected'); closeModal();
    } catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; }
  },
  'new-webhook': () => openWebhookModal(),
  'edit-webhook': (el) => openWebhookModal(S.sites.find((x) => x.id === el.dataset.id)),
  'save-webhook': async () => {
    const secret = modalRoot.querySelector('#wh-secret').value;
    await attempt(() => api.saveSiteManual({ id: modal.site?.id, type: 'webhook', name: modalRoot.querySelector('#wh-name').value, url: modalRoot.querySelector('#wh-url').value, password: secret || (modal.site ? null : '') }), 'Webhook saved');
    closeModal();
  },
  'test-site': async (el) => {
    el.disabled = true; el.textContent = 'Testing…';
    try { const r = await api.testSite(el.dataset.id); toast(r.userName ? `Connected as ${r.userName}.` : 'The webhook answered.'); }
    catch (e) { toast(cleanErr(e), 'error'); }
  },
  'delete-site': async (el) => {
    const site = S.sites.find((x) => x.id === el.dataset.id);
    if (await confirmModal({ title: `Remove ${site.name}?`, body: `Writers that publish here will go back to saving on your computer only.${site.type === 'wordpress' ? ' To fully revoke access, also delete the RCWriter application password in your WordPress profile.' : ''}`, confirm: 'Remove website' })) {
      closeModal();
      await attempt(() => api.deleteSite(site.id), 'Website removed');
    }
  },
  'publish-article': (el) => openPublishModal(el.dataset.id),
  'confirm-publish': async (el) => {
    const id = modal.articleId;
    const opts = { status: modalRoot.querySelector('#pb-status').value, categories: modalRoot.querySelector('#pb-cats').value, tags: modalRoot.querySelector('#pb-tags').value };
    const siteId = modalRoot.querySelector('#pb-site').value;
    el.disabled = true; el.textContent = 'Publishing…';
    try { const r = await api.publishArticle(id, siteId, opts); toast(`Done. ${r.status === 'publish' ? 'Published' : r.status === 'sent' ? 'Sent' : `Saved as ${r.status}`} on ${r.siteName}.`); closeModal(); }
    catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; el.textContent = 'Publish'; }
  },
  'sub-status': () => subTask(() => api.subscriptionStatus()),
  'sub-login': () => subTask(async () => { loginUrl = null; const st = await api.subscriptionLogin(); if (st.loggedIn) toast('Signed in with ChatGPT'); return st; }),
  'sub-logout': () => subTask(() => api.subscriptionLogout()),

  'install-codex': () => subTask(async () => {
    codexPct = 0; render();
    try { const st = await api.installCodex(); toast(st.installed ? 'Codex installed. Now sign in with ChatGPT.' : 'Codex downloaded, but it would not start.', st.installed ? 'info' : 'error'); }
    finally { codexPct = null; }
  }),
  'skip-password': () => api.skipPasswordSetup(),
  'lock-now': () => api.lockNow(),
  'forgot-password': async () => {
    if (await confirmModal({ title: 'Reset your password?', body: 'This removes the password and, to keep your accounts safe, erases saved API keys, website logins and the ChatGPT sign-in. Your writers, schedules and articles are kept. You will need to add your keys and reconnect your websites again.', confirm: 'Reset and erase logins' })) {
      closeModal();
      await attempt(() => api.resetPassword(), 'Password removed. Add your API keys and reconnect your websites.');
    }
  },
  'change-password': () => openPasswordModal(),
  'remove-password': () => openPasswordModal('remove'),
  'save-password': async (el) => {
    const v = (id) => modalRoot.querySelector(id)?.value ?? '';
    if (modal.mode === 'remove') {
      el.disabled = true;
      try { await api.removePassword(v('#pw-current')); toast('Password removed'); closeModal(); } catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; }
      return;
    }
    if (v('#pw-new').length < 6) { toast('Use at least 6 characters.', 'error'); return; }
    if (v('#pw-new') !== v('#pw-new2')) { toast("The new passwords don't match.", 'error'); return; }
    el.disabled = true;
    try { await api.setPassword(v('#pw-current'), v('#pw-new')); toast(S.security.hasPassword ? 'Password changed' : 'Password set'); closeModal(); }
    catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; }
  },

  'goto-approvals': () => { view = 'audits'; window.auditGoto && window.auditGoto('approvals'); render(); },
  'open-audit-report': (el) => window.openAuditReport(el.dataset.id),
  'close-modal': () => closeModal(),
  'link-mode-ok': () => { const v = modalRoot.querySelector('[name=lm]:checked')?.value; const r = modal?.resolve; modal.resolve = null; closeModal(); r && r(v); },
  'confirm-yes': () => { const r = modal?.resolve; modal.resolve = null; r && r(true); },
  'confirm-no': () => closeModal()
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch(() => {}); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.inputImages) { attempt(() => api.setImages({ [el.dataset.inputImages]: el.value }), 'Saved'); return; }
  if (el.dataset.setting) {
    const v = el.type === 'checkbox' ? el.checked : (el.type === 'number' || el.dataset.setting === 'lockAfterMinutes') ? Number(el.value) : el.value;
    attempt(() => api.saveSettings({ [el.dataset.setting]: v }));
    return;
  }
  if (el.dataset.change === 'toggle-schedule') {
    attempt(() => api.toggleSchedule(el.dataset.id, el.checked), el.checked ? 'Schedule on' : 'Schedule off').catch(() => { el.checked = !el.checked; });
    return;
  }
  if (el.dataset.change === 'writer-rerender') {
    readWriterForm();
    renderModal();
    loadModelsForModal(false);
    return;
  }
  if (el.dataset.change === 'writer-site') {
    readWriterForm();
    renderModal();
    loadModelsForModal(false);
    return;
  }
  if (el.dataset.change === 'writer-provider') {
    modalRoot.querySelector('[name=model]').value = '';
    loadModelsForModal(false);
  }
  if (modal?.type === 'schedule') updatePreview();
});

document.addEventListener('input', (e) => {
  if (e.target.dataset.input === 'article-search') {
    articleQuery = e.target.value;
    const pos = e.target.selectionStart;
    pendingRender = false;
    main.innerHTML = viewArticles();
    const s = main.querySelector('.search');
    s.focus(); s.setSelectionRange(pos, pos);
    loadReader();
  }
  if (modal?.type === 'schedule') updatePreview();
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-submit]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (form.dataset.submit === 'unlock') {
      await api.unlock(form.querySelector('#unlock-pw').value);
    } else if (form.dataset.submit === 'setup-password') {
      const a = form.querySelector('#setup-pw').value, b = form.querySelector('#setup-pw2').value;
      if (a.length < 6) throw new Error('Use at least 6 characters.');
      if (a !== b) throw new Error("The passwords don't match.");
      await api.setPassword('', a);
      toast('Password set');
    }
  } catch (err) {
    toast(cleanErr(err), 'error');
    btn.disabled = false;
    const input = form.querySelector('input');
    if (input) { input.select(); input.focus(); }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal) closeModal();
  if (e.key === 'Enter' && modal?.type === 'password' && e.target.tagName === 'INPUT') modalRoot.querySelector('[data-action=save-password]')?.click();
});

async function subTask(fn) {
  subBusy = true; render();
  try { await fn(); } catch (e) { toast(cleanErr(e), 'error'); }
  finally { subBusy = false; render(); }
}

// ---------- Boot ----------
api.onState((s) => { S = s; render(); });
api.onOpenArticle((id) => { closeModal(); view = 'articles'; selectedArticleId = id; render(); });
api.onNavigate((v) => { view = v; render(); });
api.onToast((t) => { if (modal && (modal.type === 'wp')) closeModal(); toast(t.msg, t.kind); });
api.onLoginUrl((url) => { loginUrl = url; render(); });
api.onCodexProgress((pct) => {
  codexPct = pct;
  const el = main.querySelector('.provider-state');
  if (el && view === 'providers') el.innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>Downloading Codex from OpenAI… ${pct ?? 0}%`;
});

(async () => {
  S = await api.getState();
  render();
})();
