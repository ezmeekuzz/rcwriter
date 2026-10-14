// RCWriter's "AI brain": a persistent memory of what the AI did, decided and
// suggested, and how it turned out. It is recorded automatically at the app's
// high-signal AI events, searched and injected back into later AI calls so the
// AI stays consistent and learns from what worked. Stored in the normal data
// file (no native database), secrets redacted before writing.

const TYPES = ['action', 'decision', 'suggestion', 'user_feedback', 'fact'];

// The paragraph added to the AI's system prompt (verbatim from the spec).
const SYSTEM_INSTRUCTION = [
  "You have a memory of your past actions, decisions and suggestions, shown in the 'Relevant memory' block.",
  'Use it to stay consistent, avoid repeating suggestions the user rejected, build on what worked, and mention past context when useful ("Last time you chose X…").',
  "If memory conflicts with the user's current request, follow the user and note the change. Never invent memories that aren't in the block."
].join(' ');

// ---------- redaction ----------
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{12,}/g,         // Anthropic
  /sk-[A-Za-z0-9_-]{20,}/g,             // OpenAI and similar
  /AIza[0-9A-Za-z_-]{20,}/g,            // Google
  /\b(?:ghp|gho|ghs|ghr|pat)-[A-Za-z0-9_]{10,}/g, // GitHub
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,     // bearer tokens
  /\b[A-Fa-f0-9]{40,}\b/g,              // long hex (tokens/hashes)
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g       // long base64 (tokens)
];
const SECRET_KEYS = /^(pass(word)?|secret|token|api[_-]?key|key|authorization|auth|client[_-]?secret|refresh[_-]?token|access[_-]?token)$/i;

function redactString(s) {
  let out = String(s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return value;
}

const CAP = 4000;             // max live entries before oldest low-value ones are archived
const CONSOLIDATE_EVERY = 7 * 864e5;
const approxTokens = (s) => Math.ceil(String(s).length / 4);

function createBrain({ store, ai = null, sessionId, onChange = () => {} }) {
  const d = () => store.data;
  const uid = store.uid;
  function state() { return (d().aibrain = d().aibrain || { entries: [], archived: [], paused: false, lastConsolidated: null }); }

  function log(entry = {}) {
    const b = state();
    if (b.paused) return null;
    const type = TYPES.includes(entry.type) ? entry.type : 'action';
    const e = {
      id: uid(),
      ts: new Date().toISOString(),
      type,
      summary: redactString(String(entry.summary || '').slice(0, 300)),
      details: redact(entry.details || {}),
      reasoning: redactString(String(entry.reasoning || '').slice(0, 2000)),
      outcome: ['pending', 'accepted', 'rejected', 'succeeded', 'failed'].includes(entry.outcome) ? entry.outcome : 'pending',
      relatedIds: Array.isArray(entry.relatedIds) ? entry.relatedIds.slice(0, 20) : [],
      tags: (entry.tags || []).map((t) => redactString(String(t)).toLowerCase().slice(0, 40)).slice(0, 12),
      importance: Math.max(1, Math.min(5, Number(entry.importance) || 3)),
      sessionId: entry.sessionId || sessionId
    };
    b.entries.unshift(e);
    if (b.entries.length > CAP) autoArchive();
    store.save();
    onChange();
    return e.id;
  }

  function updateOutcome(id, outcome, feedback) {
    const b = state();
    const e = b.entries.find((x) => x.id === id);
    if (!e) return;
    if (['pending', 'accepted', 'rejected', 'succeeded', 'failed'].includes(outcome)) e.outcome = outcome;
    if (feedback && String(feedback).trim()) {
      log({ type: 'user_feedback', summary: String(feedback).slice(0, 300), reasoning: `User ${outcome} a previous ${e.type}: "${e.summary}".`, relatedIds: [id], importance: Math.max(e.importance, outcome === 'rejected' ? 4 : 3), tags: e.tags });
    } else { store.save(); onChange(); }
    return e;
  }

  // ---------- recall ----------
  function tokenize(s) { return String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []; }
  function scoreFor(e, terms) {
    const hay = `${e.summary} ${e.reasoning} ${(e.tags || []).join(' ')}`.toLowerCase();
    let match = 0;
    for (const t of terms) if (hay.includes(t)) match += 1;
    const ageDays = (Date.now() - new Date(e.ts).getTime()) / 864e5;
    const recency = Math.max(0, 30 - ageDays) / 30; // 0..1 over last 30 days
    const outcomeBoost = e.outcome === 'rejected' || e.outcome === 'failed' ? 1.5 : 0; // remember what to avoid
    return match * 3 + (e.importance || 3) * 1.2 + recency * 2 + outcomeBoost;
  }

  function recall({ task = '', sid = sessionId, maxSession = 10, maxPast = 15, tokenBudget = 1500 } = {}) {
    const b = state();
    const terms = [...new Set(tokenize(task))];
    const sessionRecent = b.entries.filter((e) => e.sessionId === sid).slice(0, maxSession);
    const seen = new Set(sessionRecent.map((e) => e.id));
    const past = b.entries.filter((e) => !seen.has(e.id))
      .map((e) => ({ e, s: scoreFor(e, terms) }))
      .sort((a, b2) => b2.s - a.s)
      .slice(0, maxPast)
      .map((x) => x.e);
    const chosen = [...sessionRecent, ...past];
    if (!chosen.length) return { text: '', used: [] };
    const line = (e) => `- [${e.type}${e.outcome !== 'pending' ? `/${e.outcome}` : ''}] ${e.summary}${e.reasoning ? ` — ${e.reasoning}` : ''}`;
    const used = [];
    const lines = [];
    let budget = tokenBudget;
    for (const e of chosen) {
      const l = line(e);
      const t = approxTokens(l);
      if (budget - t < 0 && lines.length) break;
      lines.push(l); used.push(e.id); budget -= t;
    }
    return { text: `## Relevant memory from past sessions\n${lines.join('\n')}`, used };
  }

  // ---------- consolidation ----------
  function autoArchive() {
    const b = state();
    // Move the oldest low-importance entries to the archive to keep the live set small.
    const keep = [];
    const toArchive = [];
    const byOld = [...b.entries].reverse();
    let archived = 0;
    const need = b.entries.length - Math.floor(CAP * 0.8);
    for (const e of byOld) {
      if (archived < need && e.importance <= 2 && e.outcome !== 'pending') { toArchive.push(e); archived += 1; }
      else keep.push(e);
    }
    if (toArchive.length) { b.entries = keep.reverse(); b.archived = [...toArchive, ...(b.archived || [])].slice(0, 20000); }
  }

  async function consolidate({ force = false } = {}) {
    const b = state();
    const due = force || b.entries.length > CAP * 0.9 || !b.lastConsolidated || (Date.now() - new Date(b.lastConsolidated).getTime()) > CONSOLIDATE_EVERY;
    if (!due) return { made: 0 };
    b.lastConsolidated = new Date().toISOString();
    const old = b.entries.filter((e) => e.importance <= 2 && (Date.now() - new Date(e.ts).getTime()) > 14 * 864e5 && e.type !== 'fact');
    if (old.length < 20) { store.save(); return { made: 0 }; }
    let lessons = [];
    if (ai) {
      try {
        const sample = old.slice(0, 200).map((e) => `- [${e.type}/${e.outcome}] ${e.summary}`).join('\n');
        const r = await ai({ system: 'You distil a log of an assistant\'s past actions into a few durable lessons. Answer only with JSON.', prompt: `From these past entries, write up to 6 short durable lessons (user preferences, what worked, what to avoid). Return only JSON: {"lessons":["User prefers X over Y","Approach Z failed repeatedly", …]}\n\n${sample}`, maxTokens: 800 });
        const j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
        lessons = (j.lessons || []).filter(Boolean).slice(0, 6);
      } catch { /* fall back to none */ }
    }
    for (const l of lessons) log({ type: 'fact', summary: String(l).slice(0, 300), reasoning: 'Consolidated lesson from older memories.', importance: 4, tags: ['lesson'] });
    const ids = new Set(old.map((e) => e.id));
    b.entries = b.entries.filter((e) => !ids.has(e.id));
    b.archived = [...old, ...(b.archived || [])].slice(0, 20000);
    store.save();
    onChange();
    return { made: lessons.length, archived: old.length };
  }

  // ---------- queries & control ----------
  function search({ q = '', type = '', limit = 200 } = {}) {
    const terms = tokenize(q);
    let list = state().entries;
    if (type) list = list.filter((e) => e.type === type);
    if (terms.length) list = list.map((e) => ({ e, s: scoreFor(e, terms) })).filter((x) => x.s > 3).sort((a, b2) => b2.s - a.s).map((x) => x.e);
    return list.slice(0, limit);
  }
  function edit(id, patch) {
    const e = state().entries.find((x) => x.id === id);
    if (!e) return;
    if (patch.summary != null) e.summary = redactString(String(patch.summary).slice(0, 300));
    if (patch.importance != null) e.importance = Math.max(1, Math.min(5, Number(patch.importance) || 3));
    if (patch.outcome != null && ['pending', 'accepted', 'rejected', 'succeeded', 'failed'].includes(patch.outcome)) e.outcome = patch.outcome;
    store.save(); onChange();
  }
  function remove(ids) { const set = new Set(Array.isArray(ids) ? ids : [ids]); const b = state(); b.entries = b.entries.filter((e) => !set.has(e.id)); store.save(); onChange(); }
  function forget({ all = false, ids = null } = {}) { const b = state(); if (all) { b.entries = []; b.archived = []; } else if (ids) remove(ids); store.save(); onChange(); }
  function setPaused(on) { state().paused = !!on; store.save(); onChange(); }
  function exportAll() { const b = state(); return JSON.stringify({ exportedAt: new Date().toISOString(), entries: b.entries, archived: b.archived }, null, 2); }
  function status() { const b = state(); return { count: b.entries.length, archived: (b.archived || []).length, paused: !!b.paused, lastConsolidated: b.lastConsolidated }; }

  return { log, updateOutcome, recall, consolidate, search, edit, remove, forget, setPaused, exportAll, status, redact, SYSTEM_INSTRUCTION };
}

module.exports = { createBrain, SYSTEM_INSTRUCTION, TYPES, redact: (v) => createBrainRedact(v) };
// standalone redact for tests
function createBrainRedact(v) {
  if (v == null) return v;
  if (typeof v === 'string') { let o = v; for (const re of SECRET_PATTERNS) o = o.replace(re, '[redacted]'); return o; }
  if (Array.isArray(v)) return v.map(createBrainRedact);
  if (typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? '[redacted]' : createBrainRedact(val); return o; }
  return v;
}
