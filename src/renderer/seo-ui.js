/* global S, main, modalRoot, esc, cleanErr, toast, attempt, fmtRel, confirmModal, closeModal, render, VIEWS, ACTIONS, api, inClient */
// Site audits → Rankings (rank tracking, indexing watch, title tests) and
// Maintenance (updates, security, forms, domain and email, speed), plus writers' topic plans.

const spark = (vals) => {
  const v = (vals || []).filter((x) => x !== null && x !== undefined);
  if (v.length < 2) return '';
  const max = Math.max(...v, 10), min = Math.min(...v, 1);
  const pts = (vals || []).map((x, i) => (x === null || x === undefined ? null : `${(i / Math.max(1, vals.length - 1)) * 80},${((x - min) / Math.max(1, max - min)) * 18 + 1}`)).filter(Boolean).join(' ');
  return `<svg class="spark" width="82" height="20" viewBox="0 0 82 20" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
};
const move = (now, before) => {
  if (now === null || before === null || now === undefined || before === undefined) return '';
  const d = Math.round((before - now) * 10) / 10;
  if (Math.abs(d) < 0.5) return '<span class="muted">0</span>';
  return d > 0 ? `<span class="up">▲ ${d}</span>` : `<span class="down">▼ ${-d}</span>`;
};
const short = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '') || '/';

window.rankingsTab = () => {
  const sites = S.sites.filter((x) => x.type !== 'webhook' && inClient(x.id));
  const blocks = sites.map((site) => {
    const s = S.seoBySite[site.id] || { keywords: [] };
    const gsc = site.google && site.google.gscSite;
    const rows = s.keywords.map((k) => `<tr><td>${esc(k.keyword)}</td><td class="num">${k.position ?? '<span class="muted">not ranking</span>'}</td><td class="num">${move(k.position, k.weekAgo)}</td><td class="num">${k.clicks ?? ''}</td><td>${spark(k.history.map((x) => (x === null ? null : -x)))}</td></tr>`).join('');
    const watch = S.indexWatch.filter((x) => x.siteId === site.id).slice(0, 12);
    const tests = S.titleTests.filter((t) => t.siteId === site.id).slice(0, 10);
    return `<section class="panel" style="max-width:none">
      <div class="panel-head"><h3>${esc(site.name)}</h3><div class="btn-row">
        ${gsc ? `<button class="btn ghost" data-action="kw-edit" data-id="${site.id}">Keywords</button><button class="btn ghost" data-action="tt-edit" data-id="${site.id}">Title tests</button>${s.keywords.length ? `<button class="btn" data-action="rank-check" data-id="${site.id}">Check now</button>` : ''}` : ''}</div></div>
      ${!gsc ? '<p class="muted small">Link Search Console to this website (Websites, Google data) to track rankings, indexing and title tests.</p>' : `
      ${s.keywords.length ? `<table class="data"><thead><tr><th>Keyword</th><th class="num">Position</th><th class="num">7 days</th><th class="num">Clicks</th><th>Trend</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted small">7-day average position from Search Console, updated every morning. You're alerted when a keyword drops off page 1 or falls 5 places.</p>` : '<p class="muted small">No keywords tracked yet. Click Keywords to add them or pick from searches the site already shows up for.</p>'}
      <h4>Indexing watch</h4>
      ${watch.length ? `<ul class="plain">${watch.map((w) => `<li><span class="chip ${w.status === 'indexed' ? 'st-applied' : w.status === 'not indexed' ? 'st-failed' : ''}">${esc(w.status)}</span> <a href="#" data-action="link" data-url="${esc(w.url)}">${esc(w.title || short(w.url))}</a> <span class="muted small">${w.coverage ? esc(w.coverage) + ' · ' : ''}added ${fmtRel(w.addedAt)}</span> <button class="btn ghost small" data-action="watch-remove" data-id="${w.id}" aria-label="Stop watching">×</button></li>`).join('')}</ul>` : '<p class="muted small">New articles published here are added automatically. If Google hasn\'t indexed one after 7 days, you get an alert and a task.</p>'}
      <div class="btn-row"><button class="btn ghost small" data-action="watch-add" data-id="${site.id}">Watch a URL</button>${watch.some((w) => w.status !== 'indexed') ? `<button class="btn ghost small" data-action="index-check" data-id="${site.id}">Check indexing now</button>` : ''}</div>
      ${s.titleTests.enabled || tests.length ? `<h4>Title tests</h4>${tests.length ? `<ul class="plain">${tests.map((t) => `<li><span class="chip">${esc(t.status)}</span> <strong>${esc(short(t.url))}</strong>: "${esc(t.oldTitle)}" → "${esc(t.newTitle)}" <span class="muted small">CTR before ${t.baseline ? t.baseline.ctr : '?'}%${t.after ? `, after ${t.after.ctr}%` : t.startedAt ? `, result ${fmtRel(new Date(new Date(t.startedAt).getTime() + 31 * 864e5).toISOString())}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted small">Every Monday, pages with many impressions but a low click-through rate get a new title and description. After 28 days the better version is kept.</p>'}` : ''}
      `}
    </section>`;
  }).join('');
  return blocks || '<div class="list"><div class="empty"><p>Add a website first.</p></div></div>';
};

window.maintenanceTab = () => {
  const sites = S.sites.filter((x) => x.type !== 'webhook' && inClient(x.id));
  const blocks = sites.map((site) => {
    const w = S.webdevBySite[site.id] || {};
    const c = site.webdev || {};
    const u = w.updates;
    const out = (u && u.plugins.filter((p) => p.outdated)) || [];
    const dm = w.domain;
    const sp = w.speed || [];
    const last = {};
    for (const r of sp) last[r.url] = r;
    return `<section class="panel" style="max-width:none">
      <div class="panel-head"><h3>${esc(site.name)} <span class="muted small" style="font-weight:400">${c.enabled ? 'daily checks on' : 'checks off'}</span></h3>
        <div class="btn-row"><button class="btn ${c.enabled ? 'ghost' : 'primary'}" data-action="wd-edit" data-id="${site.id}">${c.enabled ? 'Settings' : 'Turn on'}</button></div></div>
      <div class="maint-grid">
        ${site.type === 'wordpress' ? `<div><h4>Updates</h4>${u ? `${out.length ? `<p class="small"><strong>${out.length} plugin update${out.length > 1 ? 's' : ''}:</strong> ${out.map((p) => `${esc(p.name)} ${esc(p.version)} → ${esc(p.latest)}`).join(', ')}</p>` : '<p class="small">All wordpress.org plugins are up to date.</p>'}
          ${u.core ? `<p class="small">WordPress ${esc(u.core.version || '?')}${u.core.outdated ? `, <strong>${esc(u.core.latest)} available</strong>` : ', up to date'}</p>` : ''}${u.errors.length ? `<p class="small err">${esc(u.errors.join(' '))}</p>` : ''}
          <p class="muted small">Checked ${fmtRel(u.checkedAt)}.</p>` : '<p class="muted small">Not checked yet.</p>'}
          <div class="btn-row"><button class="btn small" data-action="wd-check" data-what="updates" data-id="${site.id}">Check</button>${out.length ? `<button class="btn small primary" data-action="wd-update" data-id="${site.id}">Update safely</button>` : ''}</div></div>` : ''}
        <div><h4>Security</h4>${w.security ? (w.security.findings.length ? `<ul class="plain small err">${w.security.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="small">No warning signs found.</p>') + `<p class="muted small">Checked ${fmtRel(w.security.checkedAt)}.</p>` : '<p class="muted small">Watches for new admin accounts, hidden spam links, hack text and new third-party scripts.</p>'}
          <button class="btn small" data-action="wd-check" data-what="security" data-id="${site.id}">Check</button></div>
        <div><h4>Domain and email</h4>${dm ? `<p class="small">${dm.daysLeft !== undefined ? `Domain renews in <strong>${dm.daysLeft} days</strong>${dm.registrar ? ` (${esc(dm.registrar)})` : ''}.` : 'Expiry date not published by the registry.'}</p>
          <p class="small">SPF ${dm.spf ? '✓' : '<span class="err">missing</span>'} · DMARC ${dm.dmarc ? (/p=none/i.test(dm.dmarc) ? 'monitoring only' : '✓') : '<span class="err">missing</span>'} · DKIM ${dm.dkim && dm.dkim.length ? `✓ (${esc(dm.dkim.join(', '))})` : 'not found'}${dm.mx && !dm.mx.length ? ' · no mail servers' : ''}</p>` : '<p class="muted small">Domain expiry and the email records that keep mail out of spam.</p>'}
          <button class="btn small" data-action="wd-check" data-what="domain" data-id="${site.id}">Check</button></div>
        <div><h4>Speed</h4>${Object.values(last).length ? Object.values(last).map((r) => `<p class="small">${esc(short(r.url))}: score <strong>${r.score ?? '?'}</strong>, LCP ${r.lcp ?? '?'} s</p>`).join('') : '<p class="muted small">Weekly PageSpeed scores for the homepage and top pages, with an alert when they get slower.</p>'}
          <button class="btn small" data-action="wd-check" data-what="speed" data-id="${site.id}">Check</button></div>
        ${site.type === 'wordpress' ? `<div><h4>Contact form test</h4>${w.formTest ? `<p class="small">${w.formTest.ok ? '✓ Last test sent' : `<span class="err">${esc(w.formTest.status)}</span>`} ${fmtRel(w.formTest.at)}</p>` : `<p class="muted small">${c.formTest && c.formTest.enabled ? 'Weekly test on.' : 'Sends a weekly test through a Contact Form 7 form and alerts you if it fails.'}</p>`}
          ${c.formTest && c.formTest.formId ? `<button class="btn small" data-action="wd-check" data-what="form" data-id="${site.id}">Test now</button>` : ''}</div>` : ''}
      </div>
    </section>`;
  }).join('');
  return `<p class="muted small" style="margin-top:0;max-width:80ch">Daily maintenance checks for each website. "Update safely" uses WPVibe to run WP-CLI one plugin at a time, takes screenshots of key pages before and after each update, and rolls a plugin back if a page breaks.</p>${blocks || '<div class="list"><div class="empty"><p>Add a website first.</p></div></div>'}`;
};

function openKeywordsModal(siteId) {
  const site = S.sites.find((x) => x.id === siteId);
  const s = S.seoBySite[siteId];
  modal = { type: 'kw', siteId };
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">Tracked keywords: ${esc(site.name)}</h2></header>
    <div class="body">
      <div class="field"><label for="kw-list">One keyword per line (up to 100)</label><textarea id="kw-list" style="min-height:180px">${esc(s.keywords.map((k) => k.keyword).join('\n'))}</textarea></div>
      <label class="check"><input type="checkbox" id="kw-alerts" ${s.rankAlerts ? 'checked' : ''}><span>Alert me when a keyword drops off page 1 or falls 5 places</span></label>
      <div id="kw-sugg"></div>
    </div>
    <footer><button class="btn ghost" data-action="kw-suggest">Suggest from Search Console</button><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="kw-save">Save</button></div></footer>
  </div></div>`;
}

function openTitleTestModal(siteId) {
  const site = S.sites.find((x) => x.id === siteId);
  const t = S.seoBySite[siteId].titleTests;
  modal = { type: 'tt', siteId };
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">Title tests: ${esc(site.name)}</h2></header>
    <div class="body">
      ${site.type !== 'wordpress' ? '<p class="warn small">Title tests need the site connected as WordPress.</p>' : ''}
      <label class="check"><input type="checkbox" id="tt-on" ${t.enabled ? 'checked' : ''}><span><strong>Run title and meta description tests</strong><br><span class="muted small">Every Monday, pages with lots of impressions but a click-through rate well below normal for their position get a new title and description (the post excerpt, which most themes and SEO plugins use when no custom description is set). After 28 days RCWriter compares clicks: the new version is kept if it did better, otherwise the original is put back.</span></span></label>
      <div class="grid-2"><div class="field"><label for="tt-mode">New titles</label><select id="tt-mode"><option value="approve" ${t.mode !== 'auto' ? 'selected' : ''}>Wait for my approval</option><option value="auto" ${t.mode === 'auto' ? 'selected' : ''}>Apply automatically</option></select></div>
        <div class="field"><label for="tt-max">Tests at a time</label><input type="number" id="tt-max" min="1" max="10" value="${esc(t.maxActive || 3)}"></div></div>
    </div>
    <footer>${t.enabled && site.type === 'wordpress' ? '<button class="btn ghost" data-action="tt-start">Find tests now</button>' : '<span></span>'}<div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="tt-save">Save</button></div></footer>
  </div></div>`;
}

function openWebdevModal(siteId) {
  const site = S.sites.find((x) => x.id === siteId);
  const c = { updates: true, security: true, domain: true, speed: true, formTest: {}, ...(site.webdev || {}) };
  modal = { type: 'wd', siteId };
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">Maintenance checks: ${esc(site.name)}</h2></header>
    <div class="body">
      <label class="check"><input type="checkbox" id="wd-on" ${c.enabled ? 'checked' : ''}><span><strong>Run maintenance checks for this website</strong></span></label>
      <div class="checks col" style="margin-left:26px">
        ${site.type === 'wordpress' ? `<label class="check"><input type="checkbox" id="wd-up" ${c.updates ? 'checked' : ''}><span>Plugin and WordPress updates (daily)</span></label>` : ''}
        <label class="check"><input type="checkbox" id="wd-sec" ${c.security ? 'checked' : ''}><span>Security watch (daily)</span></label>
        <label class="check"><input type="checkbox" id="wd-dom" ${c.domain ? 'checked' : ''}><span>Domain expiry and email records (daily)</span></label>
        <label class="check"><input type="checkbox" id="wd-spd" ${c.speed ? 'checked' : ''}><span>Speed trend (weekly, uses PageSpeed)</span></label>
      </div>
      <div class="field"><label for="wd-pages">Key pages for update screenshots (one per line, besides the homepage)</label><textarea id="wd-pages" placeholder="https://example.com/contact/">${esc((c.keyPages || []).join('\n'))}</textarea></div>
      ${site.type === 'wordpress' ? `<fieldset><legend>Weekly contact form test</legend>
        <label class="check"><input type="checkbox" id="wd-form" ${c.formTest.enabled ? 'checked' : ''}><span>Send a test enquiry every week through a Contact Form 7 form</span></label>
        <div class="grid-2"><div class="field"><label for="wd-fid">Form ID</label><input type="text" id="wd-fid" value="${esc(c.formTest.formId || '')}" placeholder="The number in the [contact-form-7 id=…] shortcode"></div>
          <div class="field"><label for="wd-fday">Day</label><select id="wd-fday">${[1, 2, 3, 4, 5].map((i) => `<option value="${i}" ${Number(c.formTest.day ?? 1) === i ? 'selected' : ''}>${['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][i]}</option>`).join('')}</select></div></div>
        <span class="hint">The site owner receives a short email titled "Weekly form test (please ignore)". You're alerted if Contact Form 7 reports the email could not be sent.</span></fieldset>` : ''}
    </div>
    <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="wd-save">Save</button></div></footer>
  </div></div>`;
}

function openPlanModal(writerId) {
  const w = S.writers.find((x) => x.id === writerId);
  const plan = w.plan || [];
  const groups = {};
  for (const p of plan) (groups[p.cluster || 'Other'] = groups[p.cluster || 'Other'] || []).push(p);
  modal = { type: 'plan', writerId };
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
    <header><h2 id="mt">Topic plan: ${esc(w.name)}</h2></header>
    <div class="body">
      <p class="muted small">A topic map in clusters, from keyword research when Ahrefs, Semrush or Search Console is available. With the topic order set to "Follow the topic plan", the writer writes these in order, one per run.</p>
      ${plan.length ? Object.entries(groups).map(([g, items]) => `<h4>${esc(g)}</h4><ul class="plain plan">${items.map((p) => `<li class="${p.status === 'written' ? 'done' : ''}"><span>${esc(p.title)}</span> <span class="muted small">${p.keyword ? esc(p.keyword) : ''}${p.volume ? ` · ${esc(p.volume)}/mo` : ''}${p.difficulty !== null && p.difficulty !== undefined ? ` · KD ${esc(p.difficulty)}` : ''}${p.status === 'written' ? ' · written' : ''}</span>${p.status !== 'written' ? ` <button class="btn ghost small" data-action="plan-remove" data-id="${p.id}" aria-label="Remove">×</button>` : ''}</li>`).join('')}</ul>`).join('') : '<p>No plan yet.</p>'}
    </div>
    <footer><span class="inline" style="width:auto"><input type="number" id="plan-n" min="4" max="40" value="12" style="width:70px" aria-label="Number of articles"><button class="btn" data-action="plan-make">${plan.length ? 'Make a new plan' : 'Make a plan'}</button></span>
      <div class="btn-row"><button class="btn ghost" data-action="close-modal">Close</button></div></footer>
  </div></div>`;
}

Object.assign(ACTIONS, {
  'kw-edit': (el) => openKeywordsModal(el.dataset.id),
  'kw-suggest': async (el) => {
    el.disabled = true;
    try {
      const list = await api.suggestKeywords(modal.siteId);
      modalRoot.querySelector('#kw-sugg').innerHTML = `<span class="label">Searches the site already shows up for</span><div class="chips">${list.map((k) => `<button class="chip" data-action="kw-add" data-kw="${esc(k.keyword)}">${esc(k.keyword)} <span class="muted">#${k.position}</span></button>`).join('')}</div>`;
    } catch (e) { toast(cleanErr(e), 'error'); }
    el.disabled = false;
  },
  'kw-add': (el) => { const t = modalRoot.querySelector('#kw-list'); if (!t.value.split('\n').includes(el.dataset.kw)) t.value = `${t.value.trim()}\n${el.dataset.kw}`.trim(); el.remove(); },
  'kw-save': async () => {
    try { await api.setSeoConfig(modal.siteId, { keywords: modalRoot.querySelector('#kw-list').value, rankAlerts: modalRoot.querySelector('#kw-alerts').checked }); const id = modal.siteId; closeModal(); toast('Keywords saved. Checking positions…'); await api.checkRanks(id); }
    catch (e) { toast(cleanErr(e), 'error'); }
  },
  'rank-check': async (el) => { el.disabled = true; try { const r = await api.checkRanks(el.dataset.id); toast(r && r.error ? r.error : 'Rankings updated'); } catch (e) { toast(cleanErr(e), 'error'); } el.disabled = false; },
  'index-check': async (el) => { el.disabled = true; try { await api.checkIndexing(el.dataset.id); toast('Indexing checked'); } catch (e) { toast(cleanErr(e), 'error'); } el.disabled = false; },
  'watch-add': (el) => {
    modal = { type: 'watch', siteId: el.dataset.id };
    modalRoot.innerHTML = `<div class="backdrop"><div class="modal small" role="dialog" aria-modal="true"><header><h2>Watch a URL</h2></header><div class="body"><div class="field"><label for="wu">Page address</label><input type="url" id="wu" placeholder="https://…"></div></div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="watch-save">Watch</button></div></footer></div></div>`;
    modalRoot.querySelector('#wu').focus();
  },
  'watch-save': () => attempt(() => api.watchUrl(modal.siteId, modalRoot.querySelector('#wu').value), 'Watching').then(() => closeModal()).catch(() => {}),
  'watch-remove': (el) => attempt(() => api.removeWatch(el.dataset.id)),
  'tt-edit': (el) => openTitleTestModal(el.dataset.id),
  'tt-save': () => attempt(() => api.setSeoConfig(modal.siteId, { titleTests: { enabled: modalRoot.querySelector('#tt-on').checked, mode: modalRoot.querySelector('#tt-mode').value, maxActive: Number(modalRoot.querySelector('#tt-max').value) || 3 } }), 'Saved').then(() => closeModal()).catch(() => {}),
  'tt-start': async (el) => { el.disabled = true; el.textContent = 'Looking…'; try { const r = await api.startTitleTests(modal.siteId); toast(r.started ? `${r.started} test${r.started > 1 ? 's' : ''} started.` : 'No pages need a title test right now.'); } catch (e) { toast(cleanErr(e), 'error'); } el.disabled = false; el.textContent = 'Find tests now'; },
  'wd-edit': (el) => openWebdevModal(el.dataset.id),
  'wd-save': () => {
    const q = (id) => modalRoot.querySelector(id);
    const cfg = { enabled: q('#wd-on').checked, security: q('#wd-sec').checked, domain: q('#wd-dom').checked, speed: q('#wd-spd').checked, keyPages: q('#wd-pages').value.split('\n').map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 3) };
    if (q('#wd-up')) cfg.updates = q('#wd-up').checked;
    if (q('#wd-form')) cfg.formTest = { enabled: q('#wd-form').checked, formId: q('#wd-fid').value.trim(), day: Number(q('#wd-fday').value) };
    return attempt(() => api.setWebdevConfig(modal.siteId, cfg), 'Saved').then(() => closeModal()).catch(() => {});
  },
  'wd-check': async (el) => { el.disabled = true; const l = el.textContent; el.textContent = 'Checking…'; try { await api.webdevCheck(el.dataset.id, el.dataset.what); toast('Checked'); } catch (e) { toast(cleanErr(e), 'error'); } el.disabled = false; el.textContent = l; },
  'wd-update': async (el) => {
    if (!(await confirmModal({ title: 'Update plugins safely?', body: 'RCWriter asks the AI to update each plugin through WPVibe, one at a time, comparing screenshots of key pages before and after, and rolling back any plugin that breaks a page. Keep a recent backup. The result appears in Reports.', confirm: 'Start updates' }))) return;
    closeModal();
    await attempt(() => api.runUpdates(el.dataset.id), 'Updates started. You\'ll get a notification when they finish.');
  },
  'plan-open': (el) => openPlanModal(el.dataset.id),
  'plan-make': async (el) => {
    el.disabled = true; el.textContent = 'Researching…';
    const id = modal.writerId;
    try { const p = await api.planTopics(id, Number(modalRoot.querySelector('#plan-n').value)); toast(`Planned ${p.length} articles.`); openPlanModal(id); }
    catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; el.textContent = 'Make a plan'; }
  },
  'plan-remove': async (el) => {
    const w = S.writers.find((x) => x.id === modal.writerId);
    await attempt(() => api.setWriterPlan(w.id, (w.plan || []).filter((p) => p.id !== el.dataset.id)));
    setTimeout(() => openPlanModal(w.id), 50);
  }
});
