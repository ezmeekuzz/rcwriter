/* global S, esc, render, toast, fmtRel, VIEWS, ACTIONS, api, setView */

// "Revise from a brief": give the AI typed requirements and/or an uploaded
// Word/Excel/PDF document, and it analyses the brief and makes the revisions on
// the chosen connected website, using the same engine and autonomy levels as
// site audits.
let reviseFiles = [];      // array of file paths
let reviseText = '';
let reviseSiteId = '';
let reviseMode = 'approve';
let reviseBusy = false;

function reviseCapture() {
  const t = document.getElementById('revise-text'); if (t) reviseText = t.value;
  const s = document.getElementById('revise-site'); if (s) reviseSiteId = s.value;
  const m = document.getElementById('revise-mode'); if (m) reviseMode = m.value;
}

function viewRevise() {
  const sites = S.sites || [];
  if (!reviseSiteId && sites[0]) reviseSiteId = sites[0].id;
  const ai = S.assistantAi || {};
  const aiLabel = ai.provider === 'chatgpt' ? 'your ChatGPT sign-in' : `${ai.provider || 'your AI'}${ai.model ? ` (${ai.model})` : ''}`;
  const modes = S.auditModes || { report: 'Report only', approve: 'Prepare changes for approval', safe: 'Auto-fix safe items', full: 'Full autonomy' };
  const runs = (S.auditRuns || []).filter((r) => String(r.jobId || '').startsWith('brief-')).slice(0, 8);

  const sitesField = sites.length
    ? `<select id="revise-site">${sites.map((s) => `<option value="${esc(s.id)}" ${s.id === reviseSiteId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
    : `<p class="muted small">No websites connected yet. <a data-action="nav" data-view="sites">Connect a website</a> first.</p>`;

  const fileList = reviseFiles.length
    ? `<div class="chips">${reviseFiles.map((f, i) => `<span class="chip">${esc(f.split(/[\\/]/).pop())}<button data-action="revise-remove-file" data-i="${i}" aria-label="Remove">×</button></span>`).join('')}</div>`
    : '<p class="muted small">No files attached. You can type requirements, attach documents, or both.</p>';

  const runRows = runs.map((r) => {
    const when = fmtRel(r.startedAt);
    const status = r.status === 'running' ? '<span class="badge">working…</span>'
      : r.status === 'failed' ? '<span class="badge danger">failed</span>'
      : r.queued ? `<span class="badge">${r.queued} to approve</span>` : '<span class="badge ok">done</span>';
    const act = r.reportPath || r.status === 'failed'
      ? `<button class="btn ghost small" data-action="open-audit-report" data-id="${esc(r.id)}">Open report</button>` : '';
    return `<div class="revise-run"><div><strong>${esc(r.jobName || 'Brief')}</strong><div class="muted small">${when} · ${esc(r.summary || r.error || '')}</div></div><div class="revise-run-actions">${status} ${act}</div></div>`;
  }).join('');

  return `
    <div class="page-head"><div><h1>Revise from a brief</h1><p class="muted">Upload a Word, Excel or PDF document — or just type what you need — and RCWriter reads it, works out what to do, and makes the revisions on your website. Changes follow the autonomy level you choose, and you can review anything it prepares.</p></div></div>
    <section class="panel">
      <div class="field"><label for="revise-site">Website to revise</label>${sitesField}</div>
      <div class="field"><label for="revise-text">What do you need done?</label>
        <textarea id="revise-text" rows="6" placeholder="e.g. Rewrite the homepage hero to focus on speed, update the pricing page (Starter is now $19/mo), and add an FAQ to the contact page.">${esc(reviseText)}</textarea></div>
      <div class="field"><label>Attach requirements (optional)</label>
        ${fileList}
        <div class="btn-row"><button class="btn" data-action="revise-pick-files">Attach document…</button><span class="muted small">Word, Excel, PDF, or text.</span></div>
      </div>
      <div class="field" style="max-width:360px"><label for="revise-mode">How much can RCWriter do on its own?</label>
        <select id="revise-mode" class="w">${Object.entries(modes).map(([k, v]) => `<option value="${esc(k)}" ${k === reviseMode ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <span class="hint">“Prepare changes for approval” is safest: nothing goes live until you approve it.</span></div>
      <div class="btn-row">
        <button class="btn primary" data-action="revise-run" ${reviseBusy || !sites.length ? 'disabled' : ''}>${reviseBusy ? 'Starting…' : 'Analyze & revise'}</button>
        <span class="muted small">Runs with ${esc(aiLabel)}. Review results below and in Audits.</span>
      </div>
    </section>
    ${runs.length ? `<section class="panel"><h3>Recent brief revisions</h3><div class="list">${runRows}</div></section>` : ''}`;
}

VIEWS.revise = viewRevise;

ACTIONS['revise-pick-files'] = async () => {
  reviseCapture();
  const picked = await api.pickBriefFiles();
  if (picked && picked.length) {
    for (const p of picked) if (!reviseFiles.includes(p)) reviseFiles.push(p);
    render();
  }
};
ACTIONS['revise-remove-file'] = (el) => { reviseCapture(); reviseFiles.splice(Number(el.dataset.i), 1); render(); };
ACTIONS['revise-run'] = async () => {
  reviseCapture();
  if (reviseBusy) return;
  if (!reviseSiteId) { toast('Choose a website to work on.', 'error'); return; }
  if (!reviseText.trim() && !reviseFiles.length) { toast('Type your requirements or attach a document first.', 'error'); return; }
  reviseBusy = true; render();
  try {
    const r = await api.runBrief({ siteId: reviseSiteId, text: reviseText, files: reviseFiles, mode: reviseMode });
    if (r && r.warnings && r.warnings.length) toast(`Started. Some files were skipped: ${r.warnings.join('; ')}`, 'info');
    else toast('RCWriter is reading your brief and starting the revisions.');
    reviseFiles = [];
  } catch (e) {
    toast((e && e.message) ? e.message.replace(/^Error:\s*/, '') : 'Could not start.', 'error');
  } finally {
    reviseBusy = false;
    render();
  }
};
