/* global S, esc, render, toast, fmtRel, VIEWS, ACTIONS, api, confirmModal, cleanErr */

// The "AI memory" panel: browse, search, edit, delete and export what RCWriter's
// AI brain has recorded about past actions, decisions and suggestions, and pause
// or clear it. Entries are fetched on demand (they are not part of app state).
let brainCache = null;     // null = not loaded yet; otherwise array of entries
let brainQuery = '';
let brainType = '';
let brainLoading = false;

const TYPE_LABELS = { action: 'Action', decision: 'Decision', suggestion: 'Suggestion', user_feedback: 'Your feedback', fact: 'Lesson' };
const OUTCOME_LABELS = { pending: '', accepted: 'accepted', rejected: 'rejected', succeeded: 'succeeded', failed: 'failed' };

async function brainLoad() {
  if (brainLoading) return;
  brainLoading = true;
  try {
    brainCache = await api.brainList({ q: brainQuery, type: brainType, limit: 300 });
  } catch (e) {
    brainCache = [];
    toast(cleanErr(e), 'error');
  } finally {
    brainLoading = false;
    if (view === 'aibrain') render();
  }
}

function brainRow(e) {
  const typeLabel = TYPE_LABELS[e.type] || e.type;
  const outcome = OUTCOME_LABELS[e.outcome] ? `<span class="badge ${e.outcome === 'rejected' || e.outcome === 'failed' ? 'danger' : 'ok'}">${esc(OUTCOME_LABELS[e.outcome])}</span>` : '';
  const stars = '★'.repeat(e.importance || 3) + '☆'.repeat(5 - (e.importance || 3));
  const tags = (e.tags || []).slice(0, 6).map((t) => `<span class="chip small">${esc(t)}</span>`).join('');
  return `<div class="mem-row">
      <div class="mem-main">
        <div class="mem-head"><span class="badge">${esc(typeLabel)}</span>${outcome}<span class="muted small">${esc(fmtRel(e.ts))}</span><span class="mem-imp" title="Importance">${stars}</span></div>
        <div class="mem-summary">${esc(e.summary)}</div>
        ${e.reasoning ? `<div class="muted small">${esc(e.reasoning)}</div>` : ''}
        ${tags ? `<div class="chips" style="margin-top:6px">${tags}</div>` : ''}
      </div>
      <div class="mem-actions">
        <button class="btn ghost small" data-action="brain-imp" data-id="${esc(e.id)}" data-imp="${(e.importance || 3) >= 5 ? 1 : (e.importance || 3) + 1}" title="Change importance">Importance</button>
        <button class="btn ghost small danger" data-action="brain-del" data-id="${esc(e.id)}">Delete</button>
      </div>
    </div>`;
}

function viewAibrain() {
  const st = S.brain || { count: 0, archived: 0, paused: false, lastConsolidated: null };
  if (brainCache === null && !brainLoading) brainLoad();
  const rows = (brainCache || []).map(brainRow).join('');
  const body = brainLoading && brainCache === null
    ? '<div class="empty"><p>Loading memory…</p></div>'
    : (brainCache && brainCache.length)
      ? `<div class="mem-list">${rows}</div>`
      : `<div class="empty"><p>${brainQuery || brainType ? 'No memories match your search.' : 'Nothing recorded yet. As RCWriter works, it will remember what it did, decided and suggested here.'}</p></div>`;

  return `
    <div class="page-head"><div><h1>AI memory</h1><p class="muted">What RCWriter's AI remembers across sessions — what it did, decided and suggested, and how it turned out. It uses this to stay consistent and learn from what worked. Secrets are stripped before anything is stored.</p></div>
      <div class="btn-row">
        <button class="btn ${st.paused ? 'primary' : 'ghost'}" data-action="brain-pause">${st.paused ? 'Resume recording' : 'Pause recording'}</button>
        <button class="btn ghost" data-action="brain-export">Export…</button>
        <button class="btn ghost danger" data-action="brain-forget">Forget all</button>
      </div></div>
    ${st.paused ? '<div class="app-banner announce"><div class="app-banner-text">Recording is paused. New AI actions are not being remembered.</div></div>' : ''}
    <section class="panel">
      <div class="mem-bar">
        <input type="search" id="brain-q" placeholder="Search memory…" value="${esc(brainQuery)}" class="w">
        <select id="brain-type">
          <option value="">All types</option>
          ${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${brainType === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
        <button class="btn" data-action="brain-search">Search</button>
        <span class="muted small">${st.count} in memory${st.archived ? ` · ${st.archived} archived` : ''}${st.lastConsolidated ? ` · lessons updated ${esc(fmtRel(st.lastConsolidated))}` : ''}</span>
        <button class="btn ghost small" data-action="brain-consolidate" title="Distil older memories into durable lessons now">Make lessons</button>
      </div>
      ${body}
    </section>`;
}

VIEWS.aibrain = viewAibrain;

function brainCaptureSearch() {
  const q = document.getElementById('brain-q'); if (q) brainQuery = q.value;
  const t = document.getElementById('brain-type'); if (t) brainType = t.value;
}

Object.assign(ACTIONS, {
  'brain-search': () => { brainCaptureSearch(); brainLoad(); },
  'brain-imp': async (el) => {
    await api.brainEdit(el.dataset.id, { importance: Number(el.dataset.imp) }).catch(() => {});
    brainLoad();
  },
  'brain-del': async (el) => {
    await api.brainDelete(el.dataset.id).catch(() => {});
    brainCache = (brainCache || []).filter((e) => e.id !== el.dataset.id);
    render();
  },
  'brain-pause': async () => {
    const paused = !!(S.brain && S.brain.paused);
    await api.brainPause(!paused).catch(() => {});
    toast(paused ? 'Recording resumed' : 'Recording paused');
  },
  'brain-export': async () => {
    try { const r = await api.brainExport(); if (r && r.saved) toast('Memory exported'); }
    catch (e) { toast(cleanErr(e), 'error'); }
  },
  'brain-consolidate': async () => {
    toast('Distilling lessons…');
    try { const r = await api.brainConsolidate(); toast(r && r.made ? `Added ${r.made} lesson${r.made === 1 ? '' : 's'}.` : 'Nothing new to distil yet.'); brainLoad(); }
    catch (e) { toast(cleanErr(e), 'error'); }
  },
  'brain-forget': async () => {
    if (await confirmModal({ title: 'Forget everything?', body: 'This permanently erases all AI memories and archived entries. This cannot be undone.', confirm: 'Forget all', danger: true })) {
      await api.brainForget({ all: true }).catch(() => {});
      brainCache = [];
      toast('Memory cleared');
      render();
    }
  }
});
