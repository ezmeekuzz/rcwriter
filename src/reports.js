// Word (.docx) and PDF reports: monthly client SEO reports and exported audit
// reports. Both are built from one simple document model, so they look alike:
//   { title, subtitle, meta: [[label, value]], sections: [{ heading, blocks }] }
//   blocks: { p }, { ul: [] }, { table: { head: [], rows: [[]] } }, { kpis: [{ label, now, before, lowerIsBetter, format }] }
const fs = require('fs');
const path = require('path');
const docx = require('docx');
const enhance = require('./enhance');

const INK = '1C2340';
const SOFT = '5A6178';
const GOOD = '2E7D5B';
const BAD = 'B3261E';
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const safeName = (s) => String(s || 'report').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'report';
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- periods ----------
function monthPeriod(offset = -1, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  const pStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
  const pEnd = new Date(start.getFullYear(), start.getMonth(), 0);
  return { start: isoDay(start), end: isoDay(end), label: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}`,
    prev: { start: isoDay(pStart), end: isoDay(pEnd), label: pStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) } };
}

// ---------- KPI helpers ----------
function fmtNum(v, format) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  if (format === 'pct') return `${Math.round(v * 10) / 10}%`;
  if (format === 'rate') return `${Math.round(v * 1000) / 10}%`;
  if (format === 'pos') return String(Math.round(v * 10) / 10);
  return Math.round(v).toLocaleString('en-GB');
}

function change(k) {
  if (k.now === null || k.now === undefined || !k.before) return { text: k.before === 0 && k.now ? 'new' : '–', good: null };
  const pct = ((k.now - k.before) / Math.abs(k.before)) * 100;
  const better = k.lowerIsBetter ? pct < 0 : pct > 0;
  if (Math.abs(pct) < 0.5) return { text: '0%', good: null };
  return { text: `${pct > 0 ? '+' : ''}${Math.round(pct * 10) / 10}%`, good: better };
}

// ---------- Markdown to model (audit reports) ----------
function inlinePlain(s) { return String(s || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/`([^`]+)`/g, '$1').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2').trim(); }

function markdownToModel(md, fallbackTitle) {
  const body = enhance.splitFront(String(md || '')).body;
  const lines = body.split(/\r?\n/);
  const model = { title: '', subtitle: '', meta: [], sections: [] };
  let sec = null;
  let para = [];
  let list = null;
  let table = null;
  const ensure = () => { if (!sec) { sec = { heading: '', blocks: [] }; model.sections.push(sec); } return sec; };
  const flushPara = () => { if (para.length) { ensure().blocks.push({ p: inlinePlain(para.join(' ')) }); para = []; } };
  const flushList = () => { if (list) { ensure().blocks.push({ ul: list }); list = null; } };
  const flushTable = () => { if (table) { ensure().blocks.push({ table }); table = null; } };
  const flush = () => { flushPara(); flushList(); flushTable(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flush();
      const text = inlinePlain(h[2].replace(/#+$/, ''));
      if (h[1].length === 1 && !model.title) { model.title = text; continue; }
      sec = { heading: text, level: Math.min(3, h[1].length), blocks: [] };
      model.sections.push(sec);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inlinePlain(c));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))) continue;
      if (!table) table = { head: cells, rows: [] }; else table.rows.push(cells);
      continue;
    }
    flushTable();
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) { flushPara(); (list || (list = [])).push(inlinePlain(li[1])); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^-{3,}$/.test(line.trim())) { flush(); continue; }
    if (list && /^\s{2,}/.test(raw)) { list[list.length - 1] += ` ${inlinePlain(line)}`; continue; }
    flushList();
    para.push(line.trim());
  }
  flush();
  if (!model.title) model.title = fallbackTitle || 'Report';
  model.sections = model.sections.filter((x) => x.heading || x.blocks.length);
  return model;
}

// ---------- HTML (for PDF) ----------
function richHtml(text) {
  return escHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function modelToHtml(model, { brand = 'RCWriter' } = {}) {
  const block = (b) => {
    if (b.p !== undefined) return `<p>${richHtml(b.p)}</p>`;
    if (b.ul) return `<ul>${b.ul.map((i) => `<li>${richHtml(i)}</li>`).join('')}</ul>`;
    if (b.table) return `<table><thead><tr>${b.table.head.map((c) => `<th>${richHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${richHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (b.kpis) {
      return `${b.caption ? `<p class="cap">${escHtml(b.caption)}</p>` : ''}<table class="kpi"><thead><tr><th>Metric</th><th>${escHtml(b.nowLabel || 'This period')}</th><th>${escHtml(b.beforeLabel || 'Previous')}</th><th>Change</th></tr></thead><tbody>${b.kpis.map((k) => {
        const c = change(k);
        return `<tr><td>${escHtml(k.label)}</td><td>${fmtNum(k.now, k.format)}</td><td>${fmtNum(k.before, k.format)}</td><td class="${c.good === null ? '' : c.good ? 'up' : 'down'}">${c.text}</td></tr>`;
      }).join('')}</tbody></table>`;
    }
    return '';
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(model.title)}</title><style>
    @page { size: A4; margin: 18mm 16mm; }
    body { font: 10.5pt/1.5 "Segoe UI", Calibri, Arial, sans-serif; color: #${INK}; margin: 0; }
    header { border-bottom: 3px solid #${INK}; padding-bottom: 10px; margin-bottom: 18px; }
    header .brand { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #${SOFT}; }
    h1 { font: 600 20pt/1.2 Georgia, "Times New Roman", serif; margin: 4px 0; }
    .sub { color: #${SOFT}; margin: 0; }
    .meta { margin-top: 8px; font-size: 9pt; color: #${SOFT}; }
    h2 { font: 600 13.5pt/1.3 Georgia, serif; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #D5DAE3; break-after: avoid; }
    h3 { font-size: 11pt; margin: 14px 0 6px; break-after: avoid; }
    p { margin: 0 0 8px; } ul { margin: 0 0 10px; padding-left: 18px; } li { margin-bottom: 3px; }
    table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 9.5pt; break-inside: auto; }
    tr { break-inside: avoid; }
    th { background: #${INK}; color: #fff; text-align: left; padding: 6px 8px; font-weight: 600; }
    td { border-bottom: 1px solid #E2E6EC; padding: 6px 8px; vertical-align: top; }
    table.kpi td:not(:first-child), table.kpi th:not(:first-child) { text-align: right; }
    td.up { color: #${GOOD}; font-weight: 600; } td.down { color: #${BAD}; font-weight: 600; }
    .cap { font-weight: 600; margin: 10px 0 2px; }
    footer { margin-top: 26px; font-size: 8.5pt; color: #${SOFT}; }
  </style></head><body>
    <header><div class="brand">${escHtml(brand)}</div><h1>${escHtml(model.title)}</h1>${model.subtitle ? `<p class="sub">${escHtml(model.subtitle)}</p>` : ''}
      ${model.meta.length ? `<div class="meta">${model.meta.map(([k, v]) => `${escHtml(k)}: ${escHtml(v)}`).join(' &nbsp;·&nbsp; ')}</div>` : ''}</header>
    ${model.sections.map((s) => `${s.heading ? `<h${s.level === 3 ? 3 : 2}>${escHtml(s.heading)}</h${s.level === 3 ? 3 : 2}>` : ''}${s.blocks.map(block).join('')}`).join('')}
    <footer>Prepared ${escHtml(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}.</footer>
  </body></html>`;
}

// ---------- Word ----------
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, LevelFormat } = docx;
const CONTENT_W = 11906 - 2 * 1000;

function runs(text, extra = {}) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter((x) => x !== '');
  return parts.map((p) => (p.startsWith('**') && p.endsWith('**') ? new TextRun({ text: p.slice(2, -2), bold: true, ...extra }) : new TextRun({ text: p, ...extra })));
}

function docxTable(head, rows, { align = [], colors = [] } = {}) {
  const n = head.length;
  const first = n > 2 ? Math.round(CONTENT_W * 0.34) : Math.round(CONTENT_W / n);
  const rest = n > 1 ? Math.floor((CONTENT_W - first) / (n - 1)) : 0;
  const widths = head.map((_, i) => (i === 0 ? (n > 1 ? first : CONTENT_W) : rest));
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D5DAE3' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text, i, isHead, color) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA }, borders, margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: isHead ? { fill: INK, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    children: [new Paragraph({ alignment: align[i] === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT, children: runs(text, isHead ? { bold: true, color: 'FFFFFF', size: 19 } : { size: 19, ...(color ? { color, bold: true } : {}) }) })]
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r, ri) => new TableRow({ children: head.map((_, i) => cell(r[i] ?? '', i, false, colors[ri] && colors[ri][i])) }))]
  });
}

async function modelToDocx(model, { brand = 'RCWriter' } = {}) {
  const children = [
    new Paragraph({ children: [new TextRun({ text: brand.toUpperCase(), size: 17, color: SOFT, characterSpacing: 40 })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: model.title })] })
  ];
  if (model.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: model.subtitle, color: SOFT })] }));
  if (model.meta.length) children.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: model.meta.map(([k, v]) => `${k}: ${v}`).join('   ·   '), size: 18, color: SOFT })] }));
  for (const s of model.sections) {
    if (s.heading) children.push(new Paragraph({ heading: s.level === 3 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1, children: [new TextRun({ text: s.heading })] }));
    for (const b of s.blocks) {
      if (b.p !== undefined) children.push(new Paragraph({ spacing: { after: 120 }, children: runs(b.p) }));
      else if (b.ul) b.ul.forEach((i) => children.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: runs(i) })));
      else if (b.table) { children.push(docxTable(b.table.head, b.table.rows)); children.push(new Paragraph({ children: [] })); }
      else if (b.kpis) {
        if (b.caption) children.push(new Paragraph({ spacing: { before: 120 }, children: [new TextRun({ text: b.caption, bold: true })] }));
        const rows = b.kpis.map((k) => { const c = change(k); return { r: [k.label, fmtNum(k.now, k.format), fmtNum(k.before, k.format), c.text], color: c.good === null ? null : c.good ? GOOD : BAD }; });
        children.push(docxTable(['Metric', b.nowLabel || 'This period', b.beforeLabel || 'Previous', 'Change'], rows.map((x) => x.r), { align: ['left', 'right', 'right', 'right'], colors: rows.map((x) => [null, null, null, x.color]) }));
        children.push(new Paragraph({ children: [] }));
      }
    }
  }
  const doc = new Document({
    creator: 'RCWriter', title: model.title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 21, color: INK } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', run: { font: 'Georgia', size: 40, bold: true, color: INK }, paragraph: { spacing: { after: 80 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Georgia', size: 28, bold: true, color: INK }, paragraph: { spacing: { before: 320, after: 120 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 23, bold: true, color: INK }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 1 } }
      ]
    },
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }]
  });
  return Packer.toBuffer(doc);
}

// Writes the model as .docx and/or .pdf. htmlToPdf(html) -> Buffer comes from the main process.
async function saveModel(model, baseFile, { formats = ['docx', 'pdf'], brand, htmlToPdf }) {
  fs.mkdirSync(path.dirname(baseFile), { recursive: true });
  const files = {};
  if (formats.includes('docx')) { files.docx = `${baseFile}.docx`; fs.writeFileSync(files.docx, await modelToDocx(model, { brand })); }
  if (formats.includes('pdf') && htmlToPdf) { files.pdf = `${baseFile}.pdf`; fs.writeFileSync(files.pdf, await htmlToPdf(modelToHtml(model, { brand }))); }
  return files;
}

// ---------- monthly client report ----------
function createReports({ store, google, ai, htmlToPdf, monitorStatus }) {
  const d = () => store.data;
  const brand = () => d().settings.reportBrand || 'RCWriter';
  const inRange = (iso, p) => { const t = String(iso || '').slice(0, 10); return t >= p.start && t <= p.end; };

  async function siteData(site, p) {
    const out = { site, errors: [] };
    const g = site.google || {};
    if (g.gscSite && google.configured()) {
      try {
        [out.gsc, out.gscPrev] = await Promise.all([google.gscSummary(g.gscSite, p.start, p.end), google.gscSummary(g.gscSite, p.prev.start, p.prev.end)]);
        const q = await google.gscCompare(g.gscSite, { dimension: 'query', minClicks: 5, limit: 8, ranges: { now: p, before: p.prev } });
        out.queryGainers = q.biggestGainers; out.queryLosers = q.biggestLosers;
        const pg = await google.gscCompare(g.gscSite, { dimension: 'page', minClicks: 5, limit: 6, ranges: { now: p, before: p.prev } });
        out.pageGainers = pg.biggestGainers; out.pageLosers = pg.biggestLosers;
      } catch (e) { out.errors.push(`Search Console: ${e.message}`); }
    }
    if (g.ga4Property && google.configured()) {
      try { [out.ga4, out.ga4Prev] = await Promise.all([google.ga4Totals(g.ga4Property, p.start, p.end), google.ga4Totals(g.ga4Property, p.prev.start, p.prev.end)]); }
      catch (e) { out.errors.push(`Analytics: ${e.message}`); }
    }
    const writerIds = new Set(d().writers.filter((w) => w.siteId === site.id).map((w) => w.id));
    out.articles = d().articles.filter((a) => (a.published ? a.published.siteId === site.id : writerIds.has(a.writerId)) && inRange(a.published ? a.published.at : a.createdAt, p))
      .map((a) => ({ title: a.title, url: a.published && a.published.status === 'publish' ? a.published.url : '', status: a.published ? a.published.status : 'saved', keyword: a.keyword && a.keyword.keyword }));
    out.changes = d().changes.filter((c) => c.siteId === site.id && c.status === 'applied' && inRange(c.at, p)).map((c) => c.reason || c.tool);
    out.audits = d().auditRuns.filter((r) => inRange(r.startedAt, p) && d().auditJobs.some((j) => j.id === r.jobId && j.siteId === site.id) && r.status === 'done').length;
    out.tasksDone = (d().tasks || []).filter((t) => t.siteId === site.id && t.status === 'done' && inRange(t.doneAt, p)).map((t) => t.title);
    const h = monitorStatus ? monitorStatus(site.id) : null;
    if (h && h.uptime24h !== null) out.uptime = h.uptime24h;
    return out;
  }

  async function monthly(client, { offset = -1, formats } = {}) {
    const p = monthPeriod(offset);
    const sites = d().sites.filter((x) => x.clientId === client.id && x.type !== 'webhook');
    if (!sites.length) throw new Error(`${client.name} has no websites yet.`);
    const data = [];
    for (const s of sites) data.push(await siteData(s, p));

    const facts = data.map((x) => ({
      site: x.site.name, url: x.site.url,
      searchConsole: x.gsc ? { thisMonth: x.gsc, lastMonth: x.gscPrev } : 'not linked',
      analytics: x.ga4 ? { thisMonth: x.ga4, lastMonth: x.ga4Prev } : 'not linked',
      risingQueries: (x.queryGainers || []).slice(0, 5).map((q) => `${q.key}: ${q.clicksBefore} → ${q.clicksNow} clicks`),
      fallingQueries: (x.queryLosers || []).slice(0, 5).map((q) => `${q.key}: ${q.clicksBefore} → ${q.clicksNow} clicks`),
      articlesPublished: x.articles.map((a) => a.title), siteFixes: x.changes.slice(0, 40), auditsRun: x.audits, tasksCompleted: x.tasksDone.slice(0, 40), uptime24h: x.uptime
    }));
    let w = { summary: '', achievements: [], watch: [], next: [] };
    try {
      const r = await ai({
        system: 'You write monthly SEO reports for agency clients: clear, honest, specific, no jargon, no hype. You answer only with JSON.',
        prompt: `Client: ${client.name}\nMonth: ${p.label} (compared with ${p.prev.label})\n${client.notes ? `Notes about this client: ${client.notes}\n` : ''}\nFacts (the only data you may use; never invent numbers):\n${JSON.stringify(facts, null, 1)}\n\nReturn only JSON: {"summary": "3 to 5 sentences for a busy business owner: what happened, the key numbers with % change, and what it means", "achievements": ["specific things achieved this month, with numbers"], "watch": ["things that dropped or need attention, with the likely reason if the facts show it"], "next": ["3 to 6 concrete actions planned for next month"]}`,
        maxTokens: 3000
      });
      w = { ...w, ...enhance.parseJson(r.text) };
    } catch (e) { w.summary = `Written summary unavailable (${e.message}). The figures below are complete.`; }

    const model = { title: `SEO report: ${client.name}`, subtitle: p.label, meta: [['Period', `${p.start} to ${p.end}`], ['Compared with', p.prev.label], ['Websites', sites.map((s) => s.name).join(', ')]], sections: [] };
    model.sections.push({ heading: 'Executive summary', blocks: [{ p: w.summary || 'No summary.' }] });
    const kpiSec = { heading: 'Key results', blocks: [] };
    for (const x of data) {
      const kpis = [];
      if (x.gsc) kpis.push({ label: 'Clicks from Google', now: x.gsc.clicks, before: x.gscPrev.clicks }, { label: 'Impressions', now: x.gsc.impressions, before: x.gscPrev.impressions },
        { label: 'Click-through rate', now: x.gsc.ctr, before: x.gscPrev.ctr, format: 'pct' }, { label: 'Average position', now: x.gsc.position, before: x.gscPrev.position, format: 'pos', lowerIsBetter: true });
      if (x.ga4) kpis.push({ label: 'Sessions', now: x.ga4.sessions, before: x.ga4Prev.sessions }, { label: 'Users', now: x.ga4.activeUsers, before: x.ga4Prev.activeUsers },
        { label: 'Engagement rate', now: x.ga4.engagementRate, before: x.ga4Prev.engagementRate, format: 'rate' }, { label: 'Key events (conversions)', now: x.ga4.keyEvents, before: x.ga4Prev.keyEvents });
      if (kpis.length) kpiSec.blocks.push({ kpis, caption: data.length > 1 ? x.site.name : '', nowLabel: p.label, beforeLabel: p.prev.label });
      else kpiSec.blocks.push({ p: `${x.site.name}: link Search Console and GA4 in RCWriter to include traffic figures.` });
      if (x.errors.length) kpiSec.blocks.push({ p: `Note: ${x.errors.join(' ')}` });
    }
    model.sections.push(kpiSec);
    if ((w.achievements || []).length) model.sections.push({ heading: 'Achievements', blocks: [{ ul: w.achievements }] });
    const work = { heading: 'Work completed', blocks: [] };
    for (const x of data) {
      const items = [];
      if (x.articles.length) items.push(`${x.articles.length} article${x.articles.length > 1 ? 's' : ''} written: ${x.articles.map((a) => a.title).join('; ')}`);
      if (x.changes.length) items.push(`${x.changes.length} on-site improvement${x.changes.length > 1 ? 's' : ''}, including: ${x.changes.slice(0, 6).join('; ')}`);
      if (x.audits) items.push(`${x.audits} site audit${x.audits > 1 ? 's' : ''} run`);
      if (x.tasksDone.length) items.push(`${x.tasksDone.length} task${x.tasksDone.length > 1 ? 's' : ''} completed: ${x.tasksDone.slice(0, 6).join('; ')}`);
      if (x.uptime !== undefined) items.push(`Uptime over the last 24 hours: ${x.uptime}%`);
      if (items.length) work.blocks.push(...(data.length > 1 ? [{ p: `**${x.site.name}**` }] : []), { ul: items });
    }
    if (work.blocks.length) model.sections.push(work);
    for (const x of data) {
      if ((x.queryGainers || []).length || (x.queryLosers || []).length) {
        const rows = [...(x.queryGainers || []).slice(0, 6), ...(x.queryLosers || []).slice(0, 4)].map((q) => [q.key, fmtNum(q.clicksNow), fmtNum(q.clicksBefore), q.positionNow ? fmtNum(q.positionNow, 'pos') : '–']);
        model.sections.push({ heading: `Search highlights${data.length > 1 ? `: ${x.site.name}` : ''}`, blocks: [{ table: { head: ['Search', `Clicks ${p.label}`, `Clicks ${p.prev.label}`, 'Position'], rows } }] });
      }
    }
    if ((w.watch || []).length) model.sections.push({ heading: 'To keep an eye on', blocks: [{ ul: w.watch }] });
    if ((w.next || []).length) model.sections.push({ heading: 'Plan for next month', blocks: [{ ul: w.next }] });

    const base = path.join(d().settings.outputDir, 'Reports', safeName(client.name), `${p.key} SEO report - ${safeName(client.name)}`);
    const files = await saveModel(model, base, { formats: formats || client.reportFormats || ['docx', 'pdf'], brand: brand(), htmlToPdf });
    const rec = { id: store.uid(), kind: 'monthly', clientId: client.id, clientName: client.name, period: p.label, periodKey: p.key, files, summary: w.summary, createdAt: new Date().toISOString() };
    d().reports = [rec, ...(d().reports || [])].slice(0, 300);
    store.save();
    return rec;
  }

  async function exportMarkdown(mdText, baseFile, { title, formats = ['docx', 'pdf'], meta = [] } = {}) {
    const model = markdownToModel(mdText, title);
    model.meta = meta;
    return saveModel(model, baseFile, { formats, brand: brand(), htmlToPdf });
  }

  return { monthly, exportMarkdown, monthPeriod };
}

module.exports = { createReports, markdownToModel, modelToHtml, modelToDocx, saveModel, monthPeriod, change, fmtNum, safeName };
