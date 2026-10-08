/* global S, main, modalRoot, esc, cleanErr, toast, attempt, fmtRel, fmtDateTime, confirmModal, closeModal, render, VIEWS, ACTIONS, api, renderMarkdown, DAY_NAMES */
// Leads (pipeline and campaigns), Ask RCWriter, playbooks, Telegram and client health.

const STAGE_LABEL = { new: 'New', contacted: 'Contacted', replied: 'Replied', call: 'Call booked', proposal: 'Proposal sent', won: 'Won', lost: 'Lost' };
let leadCampaign = '';
let leadStageView = 'board';
let askBusy = false;

// ---------- Leads ----------
let leadSearch = '';
let leadHas = '';
const leadsFiltered = () => {
  const q = leadSearch.toLowerCase();
  return S.leads.filter((l) => (!leadCampaign || l.campaignId === leadCampaign)
    && (!leadHas || (leadHas === 'email' ? l.email : leadHas === 'phone' ? l.phone : leadHas === 'contact' ? l.contactPerson : leadHas === 'pending' ? (l.pendingEmail || l.pendingSms) : true))
    && (!q || [l.name, l.contactPerson, l.email, l.phone, l.website, l.address, l.category].join(' ').toLowerCase().includes(q)));
};

function pendingBlocks(l) {
  return `${l.pendingEmail ? `<div class="pending-email"><div class="small"><strong>Email: ${esc(l.pendingEmail.subject)}</strong></div><pre class="small">${esc(l.pendingEmail.body)}</pre>
      <div class="btn-row"><button class="btn small primary" data-action="lead-approve" data-id="${l.id}">Send</button><button class="btn small ghost" data-action="lead-edit-email" data-id="${l.id}">Edit</button><button class="btn small ghost" data-action="lead-discard" data-id="${l.id}">Discard</button></div></div>` : ''}
    ${l.pendingSms ? `<div class="pending-email"><div class="small"><strong>Text message</strong></div><pre class="small">${esc(l.pendingSms.text)}</pre>
      <div class="btn-row"><button class="btn small primary" data-action="lead-sms-send" data-id="${l.id}">Send text</button><button class="btn small ghost" data-action="lead-sms-discard" data-id="${l.id}">Discard</button></div></div>` : ''}`;
}

function leadActions(l, small = true) {
  const sm = small ? ' small' : '';
  return `${!l.enrichedAt ? `<button class="btn${sm}" data-action="lead-enrich" data-id="${l.id}">Read website</button>` : ''}
      ${l.email && !l.pendingEmail && ['new', 'contacted'].includes(l.stage) && !l.optedOut ? `<button class="btn${sm}" data-action="lead-email" data-id="${l.id}">${l.stage === 'new' ? 'Write email' : 'Write follow-up'}</button>` : ''}
      ${l.phone ? `<button class="btn${sm} ghost" data-action="lead-wa" data-id="${l.id}">WhatsApp${l.whatsapp && (l.whatsapp.openedAt || l.whatsapp.sentAt) ? ' ✓' : ''}</button>` : ''}
      ${l.threadId ? `<button class="btn${sm} ghost" data-action="link" data-url="https://mail.google.com/mail/u/0/#all/${esc(l.threadId)}">Email thread</button>` : ''}
      <button class="btn${sm} ghost" data-action="lead-proposal" data-id="${l.id}">Proposal</button>`;
}

function leadCard(l) {
  const f = l.findings;
  return `<div class="lead-card" data-stage="${l.stage}">
    <div class="lc-head"><a href="#" data-action="lead-open" data-id="${l.id}"><strong>${esc(l.name)}</strong></a>${l.score ? `<span class="chip" title="Lead score">${l.score}</span>` : ''}</div>
    ${l.contactPerson ? `<div class="meta">${esc(l.contactPerson)}${l.contactRole ? `, ${esc(l.contactRole)}` : ''}</div>` : ''}
    <div class="meta">${esc(l.category || '')}${l.rating ? ` · ★ ${l.rating} (${l.reviews})` : ''}</div>
    <div class="meta">${l.email ? esc(l.email) : '<span class="muted">no email</span>'}${l.phone ? ` · ${esc(l.phone)}` : ''}</div>
    ${f ? `<div class="meta">${f.issues.length} thing${f.issues.length === 1 ? '' : 's'} noticed${f.speedScore !== undefined && f.speedScore !== null ? ` · speed ${f.speedScore}` : ''}</div>` : ''}
    ${pendingBlocks(l)}
    ${l.error ? `<div class="meta err">${esc(l.error)}</div>` : ''}
    <div class="btn-row lc-actions">${leadActions(l)}
      <select class="small" data-change="lead-stage" data-id="${l.id}" aria-label="Stage">${Object.entries(STAGE_LABEL).map(([k, v]) => `<option value="${k}" ${l.stage === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div>
  </div>`;
}

function leadTable(list) {
  return `<div class="table-wrap"><table class="data leads-table"><thead><tr><th>Business</th><th>Contact person</th><th>Email</th><th>Phone</th><th>Website</th><th>Address</th><th class="num">Score</th><th>Stage</th></tr></thead><tbody>
    ${list.slice(0, 500).map((l) => `<tr data-action="lead-open" data-id="${l.id}" class="clickable">
      <td><strong>${esc(l.name)}</strong><div class="muted small">${esc(l.category || '')}</div></td>
      <td>${esc(l.contactPerson || '')}${l.contactRole ? `<div class="muted small">${esc(l.contactRole)}</div>` : ''}</td>
      <td>${esc(l.email || '')}${(l.emails || []).length > 1 ? `<div class="muted small">+${l.emails.length - 1} more</div>` : ''}</td>
      <td>${esc(l.phone || '')}</td>
      <td>${l.website ? esc(l.domain || l.website) : '<span class="muted">none</span>'}</td>
      <td class="small">${esc(l.address || '')}</td>
      <td class="num">${l.score ?? ''}</td>
      <td>${esc(STAGE_LABEL[l.stage] || l.stage)}${l.pendingEmail || l.pendingSms ? ' <span class="chip">to approve</span>' : ''}</td></tr>`).join('')}
    </tbody></table>${list.length > 500 ? `<p class="muted small">Showing 500 of ${list.length}. Use search or Export to see all.</p>` : ''}</div>`;
}

function viewLeads() {
  const list = leadsFiltered();
  const waiting = S.leads.filter((l) => l.pendingEmail || l.pendingSms).length;
  const info = S.leadsInfo || {};
  const u = info.usage || {};
  const board = Object.keys(STAGE_LABEL).map((st) => {
    const items = list.filter((l) => l.stage === st);
    return `<div class="lead-col"><h4>${STAGE_LABEL[st]} <span class="muted">${items.length}</span></h4>${items.slice(0, 50).map(leadCard).join('') || '<p class="muted small">None</p>'}${items.length > 50 ? `<p class="muted small">and ${items.length - 50} more (use the table)</p>` : ''}</div>`;
  }).join('');
  return `
    <div class="page-head"><div><h1>Leads</h1><p class="sub">Everything your crawlers found and everything you added: business, contact person, emails, phones, website, address and what the AI read on their site. Today: ${u.email || 0}/${info.dailyLimit || 20} emails, ${u.sms || 0}/${info.smsDailyLimit || 10} texts, ${u.whatsapp || 0}/${info.waDailyLimit || 10} WhatsApp.</p></div>
      <div class="btn-row"><button class="btn" data-action="lead-export">Export CSV</button><button class="btn" data-action="lead-replies">Check replies</button><button class="btn primary" data-action="lead-add">Add a lead</button></div></div>
    <div class="toolbar">
      <input type="text" class="search" placeholder="Search name, contact, email, phone, address" value="${esc(leadSearch)}" data-input="lead-search" aria-label="Search leads" style="max-width:320px">
      <label class="small">Crawler <select data-change="lead-campaign"><option value="">All</option>${S.campaigns.map((c) => `<option value="${c.id}" ${leadCampaign === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="small">Show <select data-change="lead-has"><option value="">All leads</option><option value="email" ${leadHas === 'email' ? 'selected' : ''}>With email</option><option value="phone" ${leadHas === 'phone' ? 'selected' : ''}>With phone</option><option value="contact" ${leadHas === 'contact' ? 'selected' : ''}>With a contact name</option><option value="pending" ${leadHas === 'pending' ? 'selected' : ''}>Waiting for my approval${waiting ? ` (${waiting})` : ''}</option></select></label>
      <div class="seg" role="group"><button class="${leadStageView === 'table' ? 'on' : ''}" data-action="lead-view" data-v="table">Table</button><button class="${leadStageView === 'board' ? 'on' : ''}" data-action="lead-view" data-v="board">Pipeline</button></div>
      <span class="muted small">${list.length} lead${list.length === 1 ? '' : 's'}</span>
    </div>
    ${S.leads.length ? (leadStageView === 'table' ? leadTable(list) : `<div class="lead-board">${board}</div>`) : '<div class="list"><div class="empty"><p>No leads yet. Create a crawler to find businesses, or add one yourself.</p><button class="btn primary" data-action="nav" data-view="campaigns">Go to Crawlers</button></div></div>'}`;
}

function openLeadModal(id) {
  const l = S.leads.find((x) => x.id === id);
  if (!l) return;
  const camp = S.campaigns.find((c) => c.id === l.campaignId);
  const row = (k, v) => (v ? `<tr><th>${k}</th><td>${v}</td></tr>` : '');
  const link = (u) => `<a href="#" data-action="link" data-url="${esc(u)}">${esc(u.replace(/^https?:\/\//, ''))}</a>`;
  modal = { type: 'lead', id };
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">${esc(l.name)}</h2></header>
    <div class="body">
      <table class="kvtable">
        ${row('Contact person', l.contactPerson ? `${esc(l.contactPerson)}${l.contactRole ? `, ${esc(l.contactRole)}` : ''}` : '')}
        ${row('Email', (l.emails && l.emails.length ? l.emails : l.email ? [l.email] : []).map((e) => `${esc(e)}${e === l.email ? ' <span class="chip">main</span>' : ''}`).join('<br>'))}
        ${row('Phone', (l.phones && l.phones.length ? l.phones : l.phone ? [l.phone] : []).map(esc).join('<br>'))}
        ${row('Website', l.website ? link(l.website) : '')}
        ${row('Address', esc(l.address || ''))}
        ${row('Category', esc(l.category || ''))}
        ${row('Google rating', l.rating ? `★ ${l.rating} from ${l.reviews} reviews${l.mapsUrl ? ` · ${link(l.mapsUrl)}` : ''}` : '')}
        ${row('About', esc(l.description || l.siteDescription || ''))}
        ${row('Services', esc((l.services || []).join(', ')))}
        ${row('Opening hours', esc(l.openingHours || ''))}
        ${row('Founded', esc(l.founded || ''))}
        ${row('Team size', esc(l.teamSize || ''))}
        ${row('Social', Object.entries(l.socials || {}).map(([k, u]) => `<a href="#" data-action="link" data-url="${esc(u)}">${esc(k)}</a>`).join(' · '))}
        ${row('Notes for the pitch', esc(l.notes || ''))}
        ${row('Found by', `${esc(camp ? camp.name : l.source === 'manual' ? 'Added by you' : '')}${l.source ? ` (${esc({ osm: 'OpenStreetMap', places: 'Google Places', ai: 'AI web search', manual: 'manual' }[l.source] || l.source)})` : ''}, ${fmtRel(l.createdAt)}`)}
        ${row('Pages read', (l.pagesCrawled || []).map((u) => link(u)).join('<br>'))}
      </table>
      ${(l.people || []).length ? `<h4>People</h4><table class="data"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th></tr></thead><tbody>${l.people.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.role || '')}</td><td>${esc(p.email || '')}</td><td>${esc(p.phone || '')}</td></tr>`).join('')}</tbody></table>` : ''}
      ${l.findings ? `<h4>What we noticed on their website</h4><ul class="plain small">${l.findings.issues.map((i) => `<li>${esc(i)}</li>`).join('') || '<li>Nothing obvious.</li>'}</ul>` : ''}
      ${pendingBlocks(l)}
      ${(l.history || []).length ? `<h4>Contact history</h4><ul class="plain small">${l.history.map((h) => `<li>${fmtDateTime(h.at)}: ${esc(h.type)}${h.subject ? `, "${esc(h.subject)}"` : ''}</li>`).join('')}</ul>` : ''}
      <div class="grid-2" style="margin-top:12px">
        <div class="field"><label for="ld-stage">Stage</label><select id="ld-stage">${Object.entries(STAGE_LABEL).map(([k, v]) => `<option value="${k}" ${l.stage === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="ld-next">Next action date</label><input type="date" id="ld-next" value="${esc(l.nextAction || '')}"></div>
      </div>
      <div class="grid-2"><div class="field"><label for="ld-email">Main email</label><input type="text" id="ld-email" value="${esc(l.email || '')}"></div><div class="field"><label for="ld-phone">Main phone</label><input type="text" id="ld-phone" value="${esc(l.phone || '')}"></div></div>
      <div class="field"><label for="ld-notes">Your notes</label><textarea id="ld-notes">${esc(l.myNotes || '')}</textarea></div>
    </div>
    <footer><div class="btn-row">${leadActions(l, false)}<button class="btn ghost" data-action="lead-recrawl" data-id="${l.id}">Read website again</button><button class="btn ghost danger" data-action="lead-delete" data-id="${l.id}">Delete</button></div>
      <div class="btn-row"><button class="btn ghost" data-action="close-modal">Close</button><button class="btn primary" data-action="lead-save">Save</button></div></footer>
  </div></div>`;
}

// ---------- Crawlers ----------
const SRC_LABEL = { osm: 'OpenStreetMap (free)', places: 'Google Places', ai: 'AI web search' };
function scheduleText(s) {
  s = s || {};
  if (!s.type || s.type === 'manual') return 'runs when you click Run';
  if (s.type === 'daily') return `every day at ${s.time}`;
  if (s.type === 'weekly') return `${(s.days || []).map((x) => DAY_NAMES[x]).join(', ')} at ${s.time}`;
  return `every ${s.intervalHours} hours`;
}

function viewCampaigns() {
  const running = (S.leadsInfo && S.leadsInfo.running) || [];
  const rows = S.campaigns.map((c) => {
    const L = S.leads.filter((l) => l.campaignId === c.id);
    const n = (st) => L.filter((l) => l.stage === st).length;
    const last = (c.runs || [])[0];
    const isRun = running.includes(c.id);
    const ch = [c.emailOn !== false && `email (${c.mode === 'auto' ? 'automatic' : 'approve first'})`, c.sms && c.sms.enabled && `texts (${c.sms.mode === 'auto' && c.sms.ack ? 'automatic' : 'approve first'})`, c.whatsapp && c.whatsapp.enabled && `WhatsApp (${c.whatsapp.mode === 'auto' && c.whatsapp.ack ? 'automatic' : 'one-click'})`].filter(Boolean);
    return `<div class="row writer-row top">
      <div><div class="title">${esc(c.name)} <span class="chip ${c.status === 'active' ? 'st-applied' : ''}">${c.status === 'active' ? 'On' : 'Off'}</span>${isRun ? ' <span class="chip">crawling</span>' : ''}</div>
        <div class="meta">${esc(c.niche)} in ${esc(c.location)} · ${esc((c.sources || ['osm']).map((s) => SRC_LABEL[s]).join(', '))} · ${esc(scheduleText(c.schedule))}</div>
        <div class="meta">Up to ${c.maxPerRun || 25} leads a run${c.maxTotal ? `, ${c.maxTotal} in total` : ''}, ${c.pagesPerSite || 3} page${(c.pagesPerSite || 3) > 1 ? 's' : ''} per website${c.require && c.require !== 'any' ? `, only leads with ${c.require === 'either' ? 'an email or phone' : `a${c.require === 'email' ? 'n email' : ' phone'}`}` : ''}</div>
        <div class="meta">Outreach: ${ch.length ? esc(ch.join(', ')) : 'off'}</div>
        <div class="meta">${L.length} leads: ${L.filter((l) => l.email).length} with email, ${L.filter((l) => l.phone).length} with phone, ${L.filter((l) => l.contactPerson).length} with a contact name · ${n('contacted')} contacted, ${n('replied') + n('call') + n('proposal')} replied or further, ${n('won')} won</div>
        ${isRun && c.progress ? `<div class="meta"><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>${esc(c.progress.phase)}${c.progress.total ? ` ${c.progress.done}/${c.progress.total}` : ''}</div>` : last ? `<div class="meta">Last run ${fmtRel(last.at)}: ${last.added} added from ${last.found} found${last.skipped ? `, ${last.skipped} skipped` : ''}${last.errors.length ? ` · <span class="err">${esc(last.errors.join(' '))}</span>` : ''}</div>` : ''}
      </div>
      <div class="btn-row">
        ${isRun ? `<button class="btn" data-action="camp-stop" data-id="${c.id}">Stop</button>` : `<button class="btn" data-action="camp-find" data-id="${c.id}">Run now</button>`}
        <button class="btn ${c.status === 'active' ? 'ghost' : 'primary'}" data-action="camp-status" data-id="${c.id}" data-status="${c.status === 'active' ? 'paused' : 'active'}">${c.status === 'active' ? 'Turn off' : 'Turn on'}</button>
        <button class="btn ghost" data-action="camp-edit" data-id="${c.id}">Edit</button>
        <button class="btn ghost danger" data-action="camp-delete" data-id="${c.id}">Delete</button>
      </div></div>`;
  }).join('');
  return `
    <div class="page-head"><div><h1>Lead crawlers</h1><p class="sub">Each crawler finds businesses of one category in one location, reads their websites, and uses your AI provider to pick out the contact person, emails, phones and other details. Turned on, it runs on its schedule and handles outreach within your daily limits.</p></div>
      <button class="btn primary" data-action="camp-new">New crawler</button></div>
    <div class="list">${rows || '<div class="empty"><p>No crawlers yet.</p><button class="btn primary" data-action="camp-new">Create a crawler</button></div>'}</div>
    <p class="muted small" style="max-width:80ch">Websites are read politely, one page at a time with pauses, like everything RCWriter does. OpenStreetMap data is free; Google Places needs an API key; AI web search uses your Claude, OpenAI or Gemini API key. Cold outreach rules: identify yourself, keep it relevant, include an easy opt-out (RCWriter adds one and stops for anyone who says no), and follow the rules where you're sending (PECR and UK GDPR, CAN-SPAM and TCPA, and so on). Texts and WhatsApp messages to people who haven't agreed to hear from you are restricted in many countries.</p>`;
}

function openCampaignModal(c) {
  const d = c || { name: '', niche: '', location: '', countryCode: '', offer: '', sources: ['osm'], maxPerRun: 25, maxTotal: 0, pagesPerSite: 3, require: 'any', schedule: { type: 'weekly', days: [1], time: '07:00' },
    emailOn: true, steps: [{ day: 0 }, { day: 3 }, { day: 7 }], mode: 'approve', sms: { enabled: false, mode: 'approve', afterDay: 2 }, whatsapp: { enabled: false, mode: 'manual', afterDay: 2 } };
  const sch = d.schedule || { type: 'manual' };
  const sms = d.sms || {};
  const wa = d.whatsapp || {};
  const info = S.leadsInfo || {};
  modal = { type: 'camp', id: c ? c.id : null };
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">${c ? 'Edit crawler' : 'New lead crawler'}</h2></header>
    <div class="body">
      <div class="field"><label for="cp-name">Name</label><input type="text" id="cp-name" value="${esc(d.name)}" placeholder="Leeds estate agents"></div>
      <fieldset><legend>What to find</legend>
        <div class="grid-3"><div class="field"><label for="cp-niche">Business category</label><input type="text" id="cp-niche" value="${esc(d.niche)}" placeholder="estate agents, dentists, plumbers…"></div>
          <div class="field"><label for="cp-loc">Location</label><input type="text" id="cp-loc" value="${esc(d.location)}" placeholder="Leeds, UK"></div>
          <div class="field"><label for="cp-cc">Country calling code</label><input type="text" id="cp-cc" value="${esc(d.countryCode || '')}" placeholder="+44"><span class="hint">For texts and WhatsApp to local numbers.</span></div></div>
        <span class="label">Where to look</span>
        <div class="checks">${Object.entries(SRC_LABEL).map(([k, l]) => `<label class="check"><input type="checkbox" name="cp-src" value="${k}" ${(d.sources || []).includes(k) ? 'checked' : ''}><span>${l}${k === 'places' && !info.hasPlacesKey ? ' <span class="muted small">(add a key in Settings)</span>' : ''}</span></label>`).join('')}</div>
      </fieldset>
      <fieldset><legend>How much to collect</legend>
        <div class="grid-3"><div class="field"><label for="cp-max">Leads per run</label><input type="number" id="cp-max" min="1" max="500" value="${esc(d.maxPerRun || 25)}"></div>
          <div class="field"><label for="cp-total">Total limit (0 = no limit)</label><input type="number" id="cp-total" min="0" value="${esc(d.maxTotal || 0)}"></div>
          <div class="field"><label for="cp-pages">Pages to read per website</label><input type="number" id="cp-pages" min="1" max="8" value="${esc(d.pagesPerSite || 3)}"><span class="hint">Home, contact, about, team…</span></div></div>
        <div class="grid-2"><div class="field"><label for="cp-req">Keep only leads with</label><select id="cp-req">${[['any', 'Anything (keep all)'], ['email', 'An email address'], ['phone', 'A phone number'], ['either', 'An email or a phone']].map(([k, l]) => `<option value="${k}" ${d.require === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><span class="label">&nbsp;</span><label class="check"><input type="checkbox" id="cp-speed" ${d.speedCheck !== false ? 'checked' : ''}><span>Also run Google's speed test on each site</span></label></div></div>
      </fieldset>
      <fieldset><legend>When to crawl</legend>
        <div class="grid-3"><div class="field"><label for="cp-st">Runs</label><select id="cp-st"><option value="manual" ${sch.type === 'manual' ? 'selected' : ''}>When I click Run</option><option value="daily" ${sch.type === 'daily' ? 'selected' : ''}>Every day</option><option value="weekly" ${sch.type === 'weekly' ? 'selected' : ''}>Every week</option><option value="interval" ${sch.type === 'interval' ? 'selected' : ''}>Every few hours</option></select></div>
          <div class="field"><label for="cp-time">At</label><input type="time" id="cp-time" value="${esc(sch.time || '07:00')}"></div>
          <div class="field"><label for="cp-int">Hours (every few hours)</label><input type="number" id="cp-int" min="1" value="${esc(sch.intervalHours || 12)}"></div></div>
        <div class="field"><span class="label">Days (weekly)</span><div class="days">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="cp-day" value="${i}" ${(sch.days || [1]).map(Number).includes(i) ? 'checked' : ''}><span>${DAY_NAMES[i]}</span></label>`).join('')}</div></div>
        <span class="hint">Scheduled runs happen while the crawler is turned on.</span>
      </fieldset>
      <fieldset><legend>Outreach</legend>
        <div class="field"><label for="cp-offer">What you offer them</label><textarea id="cp-offer" placeholder="Website speed and SEO fixes so more local customers find them on Google. Free 10-minute review call.">${esc(d.offer || '')}</textarea></div>
        <label class="check"><input type="checkbox" id="cp-email" ${d.emailOn !== false ? 'checked' : ''}><span><strong>Email</strong> through your Gmail</span></label>
        <div class="grid-2" style="margin-left:26px"><div class="field"><label for="cp-steps">Email on days</label><input type="text" id="cp-steps" value="${esc((d.steps || []).map((s) => s.day).join(', '))}" placeholder="0, 3, 7"><span class="hint">First email, then follow-ups. Stops when they reply.</span></div>
          <div class="field"><label for="cp-mode">Sending</label><select id="cp-mode"><option value="approve" ${d.mode !== 'auto' ? 'selected' : ''}>I approve each email</option><option value="auto" ${d.mode === 'auto' ? 'selected' : ''}>Send automatically</option></select></div></div>
        <label class="check"><input type="checkbox" id="cp-sms" ${sms.enabled ? 'checked' : ''}><span><strong>Text message</strong> through Twilio${info.twilio && info.twilio.hasToken ? '' : ' <span class="muted small">(set up Twilio in Settings)</span>'}</span></label>
        <div class="grid-2" style="margin-left:26px"><div class="field"><label for="cp-sms-mode">Sending</label><select id="cp-sms-mode"><option value="approve" ${sms.mode !== 'auto' ? 'selected' : ''}>I approve each text</option><option value="auto" ${sms.mode === 'auto' ? 'selected' : ''}>Send automatically</option></select></div>
          <div class="field"><label for="cp-sms-day">Days after the first email (no email: straight away)</label><input type="number" id="cp-sms-day" min="0" value="${esc(sms.afterDay ?? 2)}"></div></div>
        <label class="check" style="margin-left:26px"><input type="checkbox" id="cp-sms-ack" ${sms.ack ? 'checked' : ''}><span class="small">I have the right to text these businesses where I'm sending (consent or a legal exemption), and I'll honour STOP replies.</span></label>
        <label class="check"><input type="checkbox" id="cp-wa" ${wa.enabled ? 'checked' : ''}><span><strong>WhatsApp</strong></span></label>
        <div class="grid-2" style="margin-left:26px"><div class="field"><label for="cp-wa-mode">Sending</label><select id="cp-wa-mode"><option value="manual" ${wa.mode !== 'auto' ? 'selected' : ''}>Prepare it; I send with one click</option><option value="auto" ${wa.mode === 'auto' ? 'selected' : ''}>Send automatically (WhatsApp Cloud API template)</option></select></div>
          <div class="field"><label for="cp-wa-day">Days after the first email (no email: straight away)</label><input type="number" id="cp-wa-day" min="0" value="${esc(wa.afterDay ?? 2)}"></div></div>
        <label class="check" style="margin-left:26px"><input type="checkbox" id="cp-wa-ack" ${wa.ack ? 'checked' : ''}><span class="small">For automatic WhatsApp: I'm using a Meta-approved template and I'm allowed to message these numbers.</span></label>
      </fieldset>
    </div>
    <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="camp-save">Save</button></div></footer>
  </div></div>`;
  modalRoot.querySelector('#cp-name').focus();
}

// ---------- Ask RCWriter (on Today) ----------
function askPanel() {
  const chats = S.assistantChats.slice(0, 3);
  return `<section class="panel ask" style="max-width:none">
    <form class="ask-form" data-submit="ask"><label for="ask-in" class="sr-only">Ask RCWriter</label>
      <input type="text" id="ask-in" placeholder="Ask RCWriter anything, e.g. audit Eco Pro and draft Dan's weekly update, or how are my rankings this week?" ${askBusy ? 'disabled' : ''} autocomplete="off">
      <button class="btn primary" type="submit" ${askBusy ? 'disabled' : ''}>${askBusy ? 'Working…' : 'Ask'}</button></form>
    ${chats.map((c) => `<div class="ask-item"><div class="ask-q">${esc(c.q)} <span class="muted small">${fmtRel(c.at)}</span></div><div class="ask-a">${renderMarkdown(c.a)}</div></div>`).join('')}
    ${chats.length ? '<button class="btn ghost small" data-action="ask-clear">Clear</button>' : ''}
  </section>`;
}

// ---------- Playbooks ----------
function viewPlaybooks() {
  const rows = S.playbooks.map((p) => {
    const sch = p.schedule || {};
    const when = !sch.type || sch.type === 'manual' ? 'Runs when you click Run' : sch.type === 'daily' ? `Every day at ${sch.time}` : sch.type === 'weekly' ? `${(sch.days || []).map((x) => DAY_NAMES[x]).join(', ')} at ${sch.time}` : `Every ${sch.intervalHours} hours`;
    const s = S.schedules.find((x) => x.id === `playbook-${p.id}`);
    return `<div class="row schedule-row">
      <label class="switch"><input type="checkbox" data-change="pb-toggle" data-id="${p.id}" ${p.enabled !== false ? 'checked' : ''} aria-label="Playbook on"><span></span></label>
      <div><div class="title">${esc(p.name)}</div><div class="meta">${esc(when)}${p.lastRunAt ? ` · last run ${fmtRel(p.lastRunAt)}` : ''}</div>
        <details class="detail"><summary>Steps${p.lastResult ? ' and last result' : ''}</summary><pre class="small">${esc(p.steps)}</pre>${p.lastResult ? `<div class="ask-a">${renderMarkdown(p.lastResult)}</div>` : ''}</details></div>
      <div class="meta" style="text-align:right">${s && s.enabled && s.nextRunAt ? `Next: ${fmtDateTime(s.nextRunAt)}` : ''}</div>
      <div class="btn-row"><button class="btn" data-action="pb-run" data-id="${p.id}">Run now</button><button class="btn ghost" data-action="pb-edit" data-id="${p.id}">Edit</button><button class="btn ghost danger" data-action="pb-delete" data-id="${p.id}">Delete</button></div>
    </div>`;
  }).join('');
  return `<div class="page-head"><div><h1>Playbooks</h1><p class="sub">Your routines, written in plain words and run on a schedule by Ask RCWriter. For example: "Every Monday: run the Weekly SEO audit for every client, check rankings, and add a task for anything that dropped."</p></div>
    <button class="btn primary" data-action="pb-new">New playbook</button></div>
    <div class="list">${rows || '<div class="empty"><p>No playbooks yet.</p><button class="btn primary" data-action="pb-new">Create a playbook</button></div>'}</div>`;
}

function openPlaybookModal(p) {
  const d = p || { name: '', steps: '', schedule: { type: 'weekly', days: [1], time: '08:00' } };
  const sch = d.schedule || { type: 'manual' };
  modal = { type: 'pb', id: p ? p.id : null, sch: { ...sch } };
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">${p ? 'Edit playbook' : 'New playbook'}</h2></header>
    <div class="body">
      <div class="field"><label for="pb-name">Name</label><input type="text" id="pb-name" value="${esc(d.name)}" placeholder="Monday client check"></div>
      <div class="field"><label for="pb-steps">Steps, in plain words</label><textarea id="pb-steps" style="min-height:150px" placeholder="1. Check rankings for every website and add a high-priority task for any keyword that left page 1.&#10;2. Run the 'Weekly SEO audit' for Eco Pro.&#10;3. Draft the weekly update for every client.">${esc(d.steps)}</textarea>
        <span class="hint">Playbooks can start audits and writers, check rankings and site health, read Google data, make reports and Gmail drafts, add tasks and find leads. Website changes only happen through your saved audits and their approval settings.</span></div>
      <div class="grid-3"><div class="field"><label for="pb-type">Runs</label><select id="pb-type"><option value="manual" ${sch.type === 'manual' ? 'selected' : ''}>When I click Run</option><option value="daily" ${sch.type === 'daily' ? 'selected' : ''}>Every day</option><option value="weekly" ${sch.type === 'weekly' ? 'selected' : ''}>Every week</option><option value="interval" ${sch.type === 'interval' ? 'selected' : ''}>Every few hours</option></select></div>
        <div class="field"><label for="pb-time">At</label><input type="time" id="pb-time" value="${esc(sch.time || '08:00')}"></div>
        <div class="field"><label for="pb-int">Hours (every few hours)</label><input type="number" id="pb-int" min="1" value="${esc(sch.intervalHours || 6)}"></div></div>
      <div class="field"><span class="label">Days (weekly)</span><div class="days">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="pb-day" value="${i}" ${(sch.days || [1]).map(Number).includes(i) ? 'checked' : ''}><span>${DAY_NAMES[i]}</span></label>`).join('')}</div></div>
    </div>
    <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="pb-save">Save</button></div></footer>
  </div></div>`;
}

// ---------- Settings: Leads and Telegram ----------
function leadsSettings() {
  const c = S.leadsInfo || {};
  const t = S.telegram || {};
  const f = (k, label, ph, type = 'text') => `<div class="field"><label for="ls-${k}">${label}</label><input type="${type}" id="ls-${k}" data-setting-obj="leads.${k}" value="${esc(c[k] ?? '')}" placeholder="${esc(ph)}"></div>`;
  return `
    <section class="panel">
      <h3>Leads</h3>
      <p class="muted small">Campaigns find businesses with the Google Places API (enable "Places API (New)" in your Google Cloud project and create an API key). Emails are sent from your connected Gmail.</p>
      <div class="field"><label for="pl-key">Google Places API key</label><div class="inline"><input type="password" id="pl-key" placeholder="${c.hasPlacesKey ? 'Saved. Paste a new key to replace it.' : 'AIza…'}" autocomplete="off"><button class="btn" data-action="places-save">Save</button>${c.hasPlacesKey ? '<button class="btn ghost" data-action="places-clear">Remove</button>' : ''}</div></div>
      <div class="grid-2">${f('senderName', 'Your name', 'Ray')}${f('website', 'Your website', 'https://…')}</div>
      <div class="field"><label for="ls-signature">Email signature</label><textarea id="ls-signature" data-setting-obj="leads.signature" placeholder="Ray Co · SEO and web development · +44 …">${esc(c.signature || '')}</textarea></div>
      <div class="field"><label for="ls-services">Your services and prices (used in emails and proposals)</label><textarea id="ls-services" data-setting-obj="leads.services" placeholder="SEO audit: £350 one-off&#10;Monthly SEO: from £450/month&#10;Website speed fix: £250">${esc(c.services || '')}</textarea></div>
      <div class="grid-3">${f('dailyLimit', 'Emails per day (all campaigns)', '20', 'number')}${f('sendFrom', 'Send from (hour)', '9', 'number')}${f('sendTo', 'Until (hour)', '17', 'number')}</div>
      <label class="check"><input type="checkbox" data-setting-obj="leads.weekdaysOnly" ${c.weekdaysOnly !== false ? 'checked' : ''}><span>Only send on weekdays</span></label>
      ${f('optOut', 'Opt-out line added to every email', '')}
      <div class="grid-3">${f('countryCode', 'Default country calling code', '+44')}${f('smsDailyLimit', 'Texts per day', '10', 'number')}${f('waDailyLimit', 'WhatsApp messages per day', '10', 'number')}</div>
      <details class="detail"><summary>Texts with Twilio</summary>
        <p class="muted small">Create a Twilio account, buy or verify a number that can send SMS, then copy the Account SID and Auth Token from the Twilio Console.</p>
        <div class="grid-3"><div class="field"><label for="tw-sid">Account SID</label><input type="text" id="tw-sid" value="${esc((c.twilio && c.twilio.sid) || '')}" placeholder="AC…"></div>
          <div class="field"><label for="tw-token">Auth token</label><input type="password" id="tw-token" placeholder="${c.twilio && c.twilio.hasToken ? 'Saved' : ''}" autocomplete="off"></div>
          <div class="field"><label for="tw-from">Send from</label><input type="text" id="tw-from" value="${esc((c.twilio && c.twilio.from) || '')}" placeholder="+447…"></div></div>
        <div class="btn-row"><button class="btn" data-action="tw-save">Save</button>${c.twilio && c.twilio.hasToken ? '<button class="btn ghost" data-action="tw-clear">Remove</button>' : ''}</div>
      </details>
      <details class="detail"><summary>Automatic WhatsApp (WhatsApp Business Cloud API)</summary>
        <p class="muted small">In Meta for Developers, add WhatsApp to an app, register your business number, create a message template and wait for Meta to approve it (business-initiated messages must use an approved template). Then paste a permanent access token, the phone number ID and the template name. Without this, RCWriter prepares each WhatsApp message for you to send with one click.</p>
        <div class="grid-2"><div class="field"><label for="wa-token">Access token</label><input type="password" id="wa-token" placeholder="${c.whatsapp && c.whatsapp.hasToken ? 'Saved' : ''}" autocomplete="off"></div>
          <div class="field"><label for="wa-pid">Phone number ID</label><input type="text" id="wa-pid" value="${esc((c.whatsapp && c.whatsapp.phoneId) || '')}"></div></div>
        <div class="grid-3"><div class="field"><label for="wa-tpl">Template name</label><input type="text" id="wa-tpl" value="${esc((c.whatsapp && c.whatsapp.template) || '')}" placeholder="intro_offer"></div>
          <div class="field"><label for="wa-lang">Template language</label><input type="text" id="wa-lang" value="${esc((c.whatsapp && c.whatsapp.lang) || 'en')}" placeholder="en_GB"></div>
          <div class="field"><label for="wa-params">Template variables</label><select id="wa-params">${[[0, 'None'], [1, '{{1}} = contact first name'], [2, '{{1}} name, {{2}} your name']].map(([k, l]) => `<option value="${k}" ${Number((c.whatsapp && c.whatsapp.params) ?? 1) === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <div class="btn-row"><button class="btn" data-action="wa-save">Save</button>${c.whatsapp && c.whatsapp.hasToken ? '<button class="btn ghost" data-action="wa-clear">Remove</button>' : ''}</div>
      </details>
      <div class="field"><label for="ls-enq">Instant replies to enquiries: Gmail search for enquiry emails</label><input type="text" id="ls-enq" data-setting-obj="leads.enquiryQuery" value="${esc(c.enquiryQuery || '')}" placeholder='subject:("new enquiry" OR "contact form")'>
        <span class="hint">Every 15 minutes, new emails matching this search get a reply draft in Gmail and a task, so you can answer within minutes. Leave empty to turn off.</span></div>
    </section>
    <section class="panel">
      <h3>Phone alerts (Telegram)</h3>
      <p class="muted small">Get RCWriter's alerts on your phone. In Telegram, message <strong>@BotFather</strong>, send /newbot, and paste the token it gives you here. Then send any message to your new bot and click Find my chat.</p>
      <div class="field"><label for="tg-token">Bot token</label><div class="inline"><input type="password" id="tg-token" placeholder="${t.hasToken ? `Saved (@${esc(t.bot)})` : '123456:ABC…'}" autocomplete="off"><button class="btn" data-action="tg-save">Save</button>${t.hasToken ? '<button class="btn" data-action="tg-find">Find my chat</button>' : ''}</div>
        ${t.chatName ? `<span class="hint">Sending to ${esc(t.chatName)}.</span>` : ''}</div>
      <label class="check"><input type="checkbox" data-change="tg-enabled" ${t.enabled ? 'checked' : ''} ${t.connected ? '' : 'disabled'}><span>Send alerts to Telegram</span></label>
      <div class="field" style="max-width:320px"><label for="tg-level">Which alerts</label><select id="tg-level" data-change="tg-level"><option value="important" ${t.level !== 'all' ? 'selected' : ''}>Important ones (failures, outages, drops, replies, approvals)</option><option value="all" ${t.level === 'all' ? 'selected' : ''}>Everything</option></select></div>
      ${t.connected ? '<button class="btn ghost" data-action="tg-test">Send a test</button>' : ''}
    </section>`;
}

// ---------- wiring ----------
VIEWS.leads = viewLeads;
VIEWS.campaigns = viewCampaigns;
VIEWS.playbooks = viewPlaybooks;
const baseSettings3 = VIEWS.settings;
VIEWS.settings = () => {
  const html = baseSettings3();
  const at = html.indexOf('<section class="panel">\n      <h3>Images</h3>');
  return at >= 0 ? html.slice(0, at) + leadsSettings() + html.slice(at) : html + leadsSettings();
};
const baseToday2 = VIEWS.today;
VIEWS.today = () => {
  const html = baseToday2();
  const at = html.indexOf('</div>\n    </div>');
  const head = html.indexOf('<div class="page-head">');
  const end = head >= 0 ? html.indexOf('</div>\n    </div>', head) : -1;
  if (end < 0) return askPanel() + html;
  const cut = end + '</div>\n    </div>'.length;
  return html.slice(0, cut) + askPanel() + html.slice(cut);
};

Object.assign(ACTIONS, {
  'lead-add': () => {
    modal = { type: 'lead-add' };
    modalRoot.innerHTML = `<div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt"><header><h2 id="mt">Add a lead</h2></header><div class="body">
      <div class="field"><label for="la-name">Business name</label><input type="text" id="la-name"></div>
      <div class="field"><label for="la-web">Website</label><input type="url" id="la-web" placeholder="https://…"></div>
      <div class="grid-2"><div class="field"><label for="la-email">Email</label><input type="text" id="la-email"></div><div class="field"><label for="la-phone">Phone (with country code for WhatsApp)</label><input type="text" id="la-phone" placeholder="+44 …"></div></div>
      <div class="field"><label for="la-camp">Campaign</label><select id="la-camp"><option value="">None</option>${S.campaigns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div></div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="lead-add-save">Add</button></div></footer></div></div>`;
    modalRoot.querySelector('#la-name').focus();
  },
  'lead-add-save': () => { const v = (id) => modalRoot.querySelector(id).value; return attempt(() => api.addLead({ name: v('#la-name'), website: v('#la-web'), email: v('#la-email'), phone: v('#la-phone'), campaignId: v('#la-camp') }), 'Lead added. Checking their website…').then(() => closeModal()).catch(() => {}); },
  'lead-replies': (el) => { el.disabled = true; return attempt(() => api.checkLeadReplies()).then((n) => toast(n ? `${n} new repl${n > 1 ? 'ies' : 'y'}.` : 'No new replies.')).catch(() => {}).finally(() => { el.disabled = false; }); },
  'lead-enrich': (el) => { el.disabled = true; el.textContent = 'Checking…'; return attempt(() => api.enrichLead(el.dataset.id), 'Website checked').catch(() => {}); },
  'lead-email': (el) => { el.disabled = true; el.textContent = 'Writing…'; return attempt(() => api.writeLeadEmail(el.dataset.id), 'Email written. Review it on the card.').catch(() => { el.disabled = false; }); },
  'lead-approve': (el) => { el.disabled = true; return attempt(() => api.approveLeadEmail(el.dataset.id), 'Sent from your Gmail').catch(() => { el.disabled = false; }); },
  'lead-discard': (el) => attempt(() => api.discardLeadEmail(el.dataset.id)),
  'lead-edit-email': (el) => {
    const l = S.leads.find((x) => x.id === el.dataset.id);
    modal = { type: 'lead-email', id: l.id };
    modalRoot.innerHTML = `<div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt"><header><h2 id="mt">Email to ${esc(l.name)}</h2></header><div class="body">
      <div class="field"><label for="le-sub">Subject</label><input type="text" id="le-sub" value="${esc(l.pendingEmail.subject)}"></div>
      <div class="field"><label for="le-body">Message</label><textarea id="le-body" style="min-height:220px">${esc(l.pendingEmail.body)}</textarea></div></div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="lead-send-edited">Send</button></div></footer></div></div>`;
  },
  'lead-send-edited': () => attempt(() => api.approveLeadEmail(modal.id, { subject: modalRoot.querySelector('#le-sub').value, body: modalRoot.querySelector('#le-body').value }), 'Sent from your Gmail').then(() => closeModal()).catch(() => {}),
  'lead-wa': (el) => { el.disabled = true; return attempt(() => api.leadWhatsapp(el.dataset.id), 'Opening WhatsApp…').catch(() => {}).finally(() => { el.disabled = false; }); },
  'lead-proposal': (el) => { el.disabled = true; el.textContent = 'Writing…'; return attempt(() => api.makeProposal({ leadId: el.dataset.id }), 'Proposal saved as Word and PDF').catch(() => {}).finally(() => { el.disabled = false; el.textContent = 'Proposal'; }); },
  'camp-new': () => openCampaignModal(null),
  'camp-edit': (el) => openCampaignModal(S.campaigns.find((c) => c.id === el.dataset.id)),
  'camp-save': () => {
    const q = (id) => modalRoot.querySelector(id);
    const v = (id) => q(id).value;
    const steps = v('#cp-steps').split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n)).map((day) => ({ day }));
    const sources = [...modalRoot.querySelectorAll('[name=cp-src]:checked')].map((x) => x.value);
    if (!sources.length) { toast('Choose at least one place to look.', 'error'); return; }
    if (q('#cp-sms').checked && v('#cp-sms-mode') === 'auto' && !q('#cp-sms-ack').checked) { toast('Tick the box about texting consent, or choose "I approve each text".', 'error'); return; }
    if (q('#cp-wa').checked && v('#cp-wa-mode') === 'auto' && !q('#cp-wa-ack').checked) { toast('Tick the box about the approved WhatsApp template, or choose one-click sending.', 'error'); return; }
    const c = { id: modal.id, name: v('#cp-name'), niche: v('#cp-niche'), location: v('#cp-loc'), countryCode: v('#cp-cc'), offer: v('#cp-offer'), sources,
      maxPerRun: Number(v('#cp-max')), maxTotal: Number(v('#cp-total')), pagesPerSite: Number(v('#cp-pages')), require: v('#cp-req'), speedCheck: q('#cp-speed').checked,
      schedule: { type: v('#cp-st'), time: v('#cp-time') || '07:00', intervalHours: Number(v('#cp-int')) || 12, days: [...modalRoot.querySelectorAll('[name=cp-day]:checked')].map((x) => Number(x.value)) },
      emailOn: q('#cp-email').checked, steps: steps.length ? steps : [{ day: 0 }, { day: 3 }, { day: 7 }], mode: v('#cp-mode'),
      sms: { enabled: q('#cp-sms').checked, mode: v('#cp-sms-mode'), afterDay: Number(v('#cp-sms-day')) || 0, ack: q('#cp-sms-ack').checked },
      whatsapp: { enabled: q('#cp-wa').checked, mode: v('#cp-wa-mode'), afterDay: Number(v('#cp-wa-day')) || 0, ack: q('#cp-wa-ack').checked } };
    return attempt(() => api.saveCampaign(c), 'Crawler saved').then(() => closeModal()).catch(() => {});
  },
  'camp-delete': async (el) => { const c = S.campaigns.find((x) => x.id === el.dataset.id); if (await confirmModal({ title: `Delete "${c.name}"?`, body: 'Its leads stay in Leads. Businesses already contacted are remembered, so they are never emailed twice.', confirm: 'Delete' })) { closeModal(); await attempt(() => api.deleteCampaign(c.id), 'Deleted'); } },
  'camp-status': (el) => attempt(() => api.setCampaignStatus(el.dataset.id, el.dataset.status), el.dataset.status === 'active' ? 'Campaign running' : 'Campaign paused'),
  'camp-find': (el) => { el.disabled = true; return attempt(() => api.findLeads(el.dataset.id), 'Crawling started. New leads appear in Leads as each website is read.').catch(() => { el.disabled = false; }); },
  'camp-stop': (el) => attempt(() => api.stopCrawler(el.dataset.id), 'Stopping after the current website…'),
  'lead-open': (el, e) => { if (e && e.target.closest('select,button,a[data-action=link]') && e.target.closest('[data-action]') !== el) return; openLeadModal(el.dataset.id); },
  'lead-view': (el) => { leadStageView = el.dataset.v; render(); },
  'lead-export': () => attempt(() => api.exportLeads(leadCampaign)).then((f) => { if (f) toast('Leads exported'); }).catch(() => {}),
  'lead-save': () => { const v = (id) => modalRoot.querySelector(id).value; return attempt(() => api.updateLead(modal.id, { stage: v('#ld-stage'), nextAction: v('#ld-next'), email: v('#ld-email').trim().toLowerCase(), phone: v('#ld-phone').trim(), myNotes: v('#ld-notes') }), 'Saved').then(() => closeModal()).catch(() => {}); },
  'lead-delete': async (el) => { const id = el.dataset.id; if (await confirmModal({ title: 'Delete this lead?', body: 'It will not be found again by your crawlers.', confirm: 'Delete' })) { closeModal(); await attempt(() => api.deleteLeads(id), 'Lead deleted'); } },
  'lead-recrawl': (el) => { el.disabled = true; el.textContent = 'Reading…'; return attempt(() => api.enrichLead(el.dataset.id), 'Website read again').then(() => openLeadModal(el.dataset.id)).catch(() => {}); },
  'lead-sms-send': (el) => { el.disabled = true; return attempt(() => api.approveLeadSms(el.dataset.id), 'Text sent').catch(() => { el.disabled = false; }); },
  'lead-sms-discard': (el) => attempt(() => api.discardLeadSms(el.dataset.id)),
  'ask-clear': () => attempt(() => api.clearAsk()),
  'pb-new': () => openPlaybookModal(null),
  'pb-edit': (el) => openPlaybookModal(S.playbooks.find((p) => p.id === el.dataset.id)),
  'pb-save': () => {
    const v = (id) => modalRoot.querySelector(id).value;
    const schedule = { type: v('#pb-type'), time: v('#pb-time') || '08:00', intervalHours: Number(v('#pb-int')) || 6, days: [...modalRoot.querySelectorAll('[name=pb-day]:checked')].map((x) => Number(x.value)) };
    return attempt(() => api.savePlaybook({ id: modal.id, name: v('#pb-name'), steps: v('#pb-steps'), schedule }), 'Playbook saved').then(() => closeModal()).catch(() => {});
  },
  'pb-run': (el) => attempt(() => api.runPlaybook(el.dataset.id), 'Playbook started. You\'ll get a notification when it finishes.'),
  'pb-delete': async (el) => { const p = S.playbooks.find((x) => x.id === el.dataset.id); if (await confirmModal({ title: `Delete "${p.name}"?`, body: 'Its schedule stops.', confirm: 'Delete' })) { closeModal(); await attempt(() => api.deletePlaybook(p.id), 'Deleted'); } },
  'places-save': () => { const v = main.querySelector('#pl-key').value.trim(); if (!v) { toast('Paste the key first.', 'error'); return; } return attempt(() => api.setPlacesKey(v), 'Places key saved'); },
  'places-clear': () => attempt(() => api.setPlacesKey(''), 'Places key removed'),
  'tg-save': () => { const v = main.querySelector('#tg-token').value.trim(); if (!v) { toast('Paste the bot token first.', 'error'); return; } return attempt(() => api.tgSetToken(v)).then((bot) => toast(`Connected to @${bot}. Now send it a message and click Find my chat.`)).catch(() => {}); },
  'tg-find': () => attempt(() => api.tgFindChat()).then((n) => toast(`Connected to ${n}. A test message was sent.`)).catch(() => {}),
  'tg-test': () => attempt(() => api.tgTest(), 'Sent'),
  'tw-save': () => { const v = (id) => main.querySelector(id).value.trim(); return attempt(() => api.setLeadKeys({ twilioSid: v('#tw-sid'), twilioToken: v('#tw-token'), twilioFrom: v('#tw-from') }), 'Twilio saved'); },
  'tw-clear': () => attempt(() => api.setLeadKeys({ clearTwilio: true }), 'Twilio removed'),
  'wa-save': () => { const v = (id) => main.querySelector(id).value.trim(); return attempt(() => api.setLeadKeys({ waToken: v('#wa-token'), waPhoneId: v('#wa-pid'), waTemplate: v('#wa-tpl'), waLang: v('#wa-lang') || 'en', waParams: Number(v('#wa-params')) }), 'WhatsApp saved'); },
  'wa-clear': () => attempt(() => api.setLeadKeys({ clearWa: true }), 'WhatsApp removed')
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const ch = el.dataset.change;
  if (ch === 'lead-stage') attempt(() => api.updateLead(el.dataset.id, { stage: el.value }));
  else if (ch === 'lead-campaign') { leadCampaign = el.value; render(); }
  else if (ch === 'lead-has') { leadHas = el.value; render(); }
  else if (ch === 'pb-toggle') attempt(() => api.togglePlaybook(el.dataset.id, el.checked));
  else if (ch === 'tg-enabled') attempt(() => api.tgSet({ enabled: el.checked }), el.checked ? 'Telegram alerts on' : 'Telegram alerts off');
  else if (ch === 'tg-level') attempt(() => api.tgSet({ level: el.value }), 'Saved');
});

document.addEventListener('input', (e) => {
  if (e.target.dataset.input !== 'lead-search') return;
  leadSearch = e.target.value;
  const pos = e.target.selectionStart;
  main.innerHTML = viewLeads();
  const s2 = main.querySelector('[data-input=lead-search]');
  s2.focus(); s2.setSelectionRange(pos, pos);
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-submit="ask"]');
  if (!form) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const text = form.querySelector('#ask-in').value.trim();
  if (!text) return;
  askBusy = true; render();
  try { await api.ask(text); } catch (err) { toast(cleanErr(err), 'error'); }
  finally { askBusy = false; render(); }
}, true);

window.healthChip = (clientId) => {
  const h = S.clientHealth && S.clientHealth[clientId];
  if (!h) return '';
  const cls = h.score >= 80 ? 'good' : h.score >= 60 ? 'mid' : 'bad';
  return `<span class="health ${cls}" title="${esc(h.parts.map((p) => `${p.name}: ${p.got}/${p.max} (${p.note})`).join('\n'))}">${h.score}</span>`;
};
