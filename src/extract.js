// Reads text out of an uploaded requirements file so the AI can analyse it.
// Supports Word (.docx), Excel (.xlsx/.xls/.xlsm), PDF, and plain text formats.
// Everything runs locally — nothing is uploaded anywhere.
const fs = require('fs');
const path = require('path');

const PER_FILE = 40000;   // characters kept per file
const TOTAL = 120000;     // characters kept across all files in one brief

const SUPPORTED = ['.docx', '.xlsx', '.xls', '.xlsm', '.pdf', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.rtf', '.sql', '.xml', '.yaml', '.yml'];
const PLAIN = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.rtf', '.sql', '.xml', '.yaml', '.yml'];

async function extractOne(file) {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  let text = '';
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    text = (await mammoth.extractRawText({ path: file })).value || '';
  } else if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(file);
    text = wb.SheetNames.map((n) => `# ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
  } else if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(file) });
    try {
      const r = await parser.getText();
      text = String(r.text || '').replace(/^-- \d+ of \d+ --$/gm, '');
    } finally { try { await parser.destroy(); } catch { /* ignore */ } }
  } else if (PLAIN.includes(ext)) {
    text = fs.readFileSync(file, 'utf8');
  } else {
    throw new Error(`unsupported type ${ext || '(none)'}`);
  }
  text = String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > PER_FILE) text = `${text.slice(0, PER_FILE)}\n[…truncated]`;
  return { name, text };
}

// Extract and concatenate several files into one labelled block, capped overall.
async function extractFiles(files = []) {
  const parts = [];
  const errors = [];
  let total = 0;
  for (const f of files) {
    try {
      const { name, text } = await extractOne(f);
      if (!text) { errors.push(`${path.basename(f)}: no readable text found`); continue; }
      const room = TOTAL - total;
      if (room <= 0) break;
      const t = text.length > room ? `${text.slice(0, room)}\n[…truncated]` : text;
      total += t.length;
      parts.push(`### ${name}\n${t}`);
    } catch (e) { errors.push(`${path.basename(f)}: ${e.message}`); }
  }
  return { text: parts.join('\n\n'), errors };
}

module.exports = { extractOne, extractFiles, SUPPORTED, PLAIN };
