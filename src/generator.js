// Turns a writer profile (instructions + knowledge + attitude) into an article on disk.
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_LIMIT = 80000; // characters across all knowledge files
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml']);

function slugify(s, max = 60) {
  return String(s || 'article')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'article';
}

function pad(n) { return String(n).padStart(2, '0'); }

function pickTopic(writer, override) {
  if (override && override.trim()) return { topic: override.trim(), mode: 'fixed' };
  const topics = String(writer.topics || '').split('\n').map((t) => t.trim()).filter(Boolean);
  if (!topics.length) return { topic: null, mode: 'open' };
  if (writer.topicMode === 'random') return { topic: topics[Math.floor(Math.random() * topics.length)], mode: 'fixed' };
  if (writer.topicMode === 'rotate') {
    const i = (writer.topicIndex || 0) % topics.length;
    writer.topicIndex = i + 1;
    return { topic: topics[i], mode: 'fixed' };
  }
  return { topic: topics, mode: 'themes' }; // let the AI choose a fresh angle within these themes
}

function readKnowledgeFiles(files = []) {
  let total = 0;
  const parts = [];
  for (const f of files) {
    try {
      if (!TEXT_EXT.has(path.extname(f).toLowerCase())) continue;
      let txt = fs.readFileSync(f, 'utf8');
      const room = KNOWLEDGE_LIMIT - total;
      if (room <= 0) break;
      if (txt.length > room) txt = txt.slice(0, room) + '\n[…truncated]';
      total += txt.length;
      parts.push(`### ${path.basename(f)}\n${txt}`);
    } catch { /* missing file: skip */ }
  }
  return parts.join('\n\n');
}

function buildPrompts(writer, picked, recentTitles) {
  const words = Number(writer.targetWords) || 1000;
  const knowledge = [String(writer.knowledge || '').trim(), readKnowledgeFiles(writer.knowledgeFiles)].filter(Boolean).join('\n\n');

  const system = [
    `You are ${writer.persona?.trim() || 'an experienced professional writer'}.`,
    writer.attitude?.trim() && `## Voice and attitude\n${writer.attitude.trim()}`,
    knowledge && `## Your knowledge\nTreat the following as your source of truth. Prefer it over general knowledge and never contradict it.\n\n${knowledge}`,
    writer.instructions?.trim() && `## Standing instructions\n${writer.instructions.trim()}`,
    writer.siteContext && `## Your website\n${writer.siteContext}`,
    [
      '## Output format',
      `- Write in ${writer.language?.trim() || 'English'}.`,
      `- Aim for roughly ${words} words.`,
      '- Return only the finished article in Markdown.',
      "- The first line must be the title as a single H1 ('# Title').",
      '- Do not add any preamble, notes to the user, or commentary about the task.',
      writer.includeMeta ? '- After the article, add a line containing only "---", then "Meta description: " followed by a description under 155 characters.' : null
    ].filter(Boolean).join('\n')
  ].filter(Boolean).join('\n\n');

  let task;
  if (picked.mode === 'fixed') task = `Write a new article on this topic:\n${picked.topic}`;
  else if (picked.mode === 'themes') task = `Choose a specific, useful subject within these themes and write a new article on it:\n- ${picked.topic.join('\n- ')}`;
  else task = 'Choose a specific, useful subject that fits your knowledge and instructions, and write a new article on it.';

  const avoid = recentTitles.length
    ? `\n\nYou have already published these titles. Do not repeat them or cover the same angle:\n- ${recentTitles.join('\n- ')}`
    : '';

  return { system, prompt: task + avoid };
}

function extractTitle(text) {
  const m = text.match(/^\s*#\s+(.+)$/m);
  if (m) return m[1].replace(/[*_`#]/g, '').trim();
  return text.split('\n').find((l) => l.trim())?.replace(/[*_`#]/g, '').trim().slice(0, 100) || 'Untitled article';
}

function countWords(text) {
  return (text.replace(/[#>*_`\-]/g, ' ').match(/\S+/g) || []).length;
}

function yamlStr(s) { return JSON.stringify(String(s ?? '')); }

async function run({ writer, topicOverride, schedule, settings, providerCfg, generate, recentTitles = [], uid }) {
  const picked = pickTopic(writer, topicOverride);
  const { system, prompt } = buildPrompts(writer, picked, writer.avoidRepeats === false ? [] : recentTitles.slice(0, 40));

  const started = Date.now();
  const result = await generate(writer.provider, {
    ...providerCfg,
    model: writer.model,
    system,
    prompt,
    maxTokens: Number(writer.maxTokens) || 8000,
    temperature: writer.temperature
  });
  if (!result.text) throw new Error('The model returned an empty response.');

  const title = extractTitle(result.text);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = path.join(settings.outputDir, slugify(writer.name, 40));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${stamp}_${slugify(title)}.md`);

  const topicLabel = picked.mode === 'fixed' ? picked.topic : picked.mode === 'themes' ? 'AI-chosen within themes' : 'AI-chosen';
  const front = [
    '---',
    `title: ${yamlStr(title)}`,
    `writer: ${yamlStr(writer.name)}`,
    `topic: ${yamlStr(topicLabel)}`,
    `provider: ${yamlStr(writer.provider)}`,
    `model: ${yamlStr(writer.model)}`,
    `created: ${now.toISOString()}`,
    schedule ? `schedule: ${yamlStr(schedule.name)}` : null,
    '---',
    ''
  ].filter((l) => l !== null).join('\n');
  fs.writeFileSync(filePath, front + result.text + '\n', 'utf8');

  return {
    id: uid(),
    title,
    writerId: writer.id,
    writerName: writer.name,
    scheduleId: schedule ? schedule.id : null,
    scheduleName: schedule ? schedule.name : null,
    topic: topicLabel,
    provider: writer.provider,
    model: writer.model,
    path: filePath,
    words: countWords(result.text),
    truncated: !!result.truncated,
    seconds: Math.round((Date.now() - started) / 1000),
    createdAt: now.toISOString()
  };
}

module.exports = { run, buildPrompts, pickTopic, extractTitle, slugify };
