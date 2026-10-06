// Provider adapters. Model lists are fetched live from each provider's API,
// so every model your key has access to shows up (including new releases).

const codex = require('./codex');

const DEFS = {
  chatgpt: { label: 'ChatGPT subscription (Plus, Pro, Business)', kind: 'subscription', keyHint: '', keyUrl: '' },
  anthropic: { label: 'Claude (Anthropic)', keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI API (pay per use)', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Gemini (Google)', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
  custom: { label: 'OpenAI-compatible (OpenRouter, DeepSeek, Groq, Ollama…)', keyHint: 'API key (blank for local servers)', keyUrl: '' }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts = {}, { retries = 2, timeoutMs = 10 * 60 * 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, text;
    try {
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`Could not reach the provider (${e.name === 'TimeoutError' ? 'timed out' : e.message}). Check your internet connection.`);
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (res.ok) return json;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    const msg =
      (json && json.error && (json.error.message || (typeof json.error === 'string' ? json.error : null))) ||
      (json && json.message) ||
      text.slice(0, 300);
    const err = new Error(`${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
}

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

// ---------- model lists ----------

async function listModels(id, { key, baseUrl }) {
  if (id === 'chatgpt') return []; // Codex picks from what your plan allows; type a model name or leave blank
  if (id !== 'custom' && !key) throw new Error('Add an API key for this provider first.');

  if (id === 'anthropic') {
    const out = [];
    let after = null;
    do {
      const u = new URL('https://api.anthropic.com/v1/models');
      u.searchParams.set('limit', '1000');
      if (after) u.searchParams.set('after_id', after);
      const j = await request(u, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      for (const m of j.data || []) out.push({ id: m.id, name: m.display_name || m.id, created: m.created_at || null });
      after = j.has_more ? j.last_id : null;
    } while (after);
    return out;
  }

  if (id === 'openai') {
    const j = await request('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    const skip = /(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|davinci|babbage|search|computer-use|sora)/i;
    return (j.data || [])
      .filter((m) => /^(gpt|o\d|chatgpt|codex)/i.test(m.id) && !skip.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((m) => ({ id: m.id, name: m.id, created: m.created ? new Date(m.created * 1000).toISOString() : null }));
  }

  if (id === 'gemini') {
    const out = [];
    let token = null;
    do {
      const u = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      u.searchParams.set('pageSize', '1000');
      if (token) u.searchParams.set('pageToken', token);
      const j = await request(u, { headers: { 'x-goog-api-key': key } });
      for (const m of j.models || []) {
        const methods = m.supportedGenerationMethods || [];
        const mid = String(m.name || '').replace(/^models\//, '');
        if (!methods.includes('generateContent')) continue;
        if (/(embedding|tts|imagen|veo|aqa|image-generation)/i.test(mid)) continue;
        out.push({ id: mid, name: m.displayName || mid, created: null });
      }
      token = j.nextPageToken || null;
    } while (token);
    return out;
  }

  if (id === 'custom') {
    if (!baseUrl) throw new Error('Add the base URL for your OpenAI-compatible provider first.');
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const j = await request(`${trimSlash(baseUrl)}/models`, { headers });
    const list = j.data || j.models || [];
    return list.map((m) => ({ id: m.id || m.name, name: m.name || m.id, created: null }));
  }

  throw new Error(`Unknown provider: ${id}`);
}

// ---------- generation ----------

// Some models reject certain parameters (e.g. temperature on reasoning models).
// If the provider complains about a parameter, retry once without it.
async function withParamFallback(build, send) {
  let opts = { temperature: true, completionTokens: true };
  for (let i = 0; i < 3; i++) {
    try {
      return await send(build(opts));
    } catch (e) {
      const m = String(e.message).toLowerCase();
      if (e.status === 400 && opts.temperature && m.includes('temperature')) { opts = { ...opts, temperature: false }; continue; }
      if (e.status === 400 && opts.completionTokens && m.includes('max_completion_tokens')) { opts = { ...opts, completionTokens: false }; continue; }
      throw e;
    }
  }
  throw new Error('The provider rejected the request parameters.');
}

async function generate(id, { key, baseUrl, cliPath, model, system, prompt, maxTokens = 8000, temperature = null }) {
  if (id === 'chatgpt') return codex.generate({ cmd: cliPath || 'codex', model, system, prompt });
  if (!model) throw new Error('Choose a model for this writer.');
  const hasTemp = temperature !== null && temperature !== '' && !Number.isNaN(Number(temperature));

  if (id === 'anthropic') {
    const j = await withParamFallback(
      (o) => {
        const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] };
        if (hasTemp && o.temperature) body.temperature = Number(temperature);
        return body;
      },
      (body) => request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      })
    );
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, truncated: j.stop_reason === 'max_tokens', usage: j.usage || null };
  }

  if (id === 'openai' || id === 'custom') {
    const url = id === 'openai' ? 'https://api.openai.com/v1/chat/completions' : `${trimSlash(baseUrl)}/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const j = await withParamFallback(
      (o) => {
        const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
        if (id === 'openai' && o.completionTokens) body.max_completion_tokens = maxTokens;
        else body.max_tokens = maxTokens;
        if (hasTemp && o.temperature) body.temperature = Number(temperature);
        return body;
      },
      (body) => request(url, { method: 'POST', headers, body: JSON.stringify(body) })
    );
    const choice = (j.choices || [])[0] || {};
    const content = choice.message && choice.message.content;
    const text = (Array.isArray(content) ? content.map((c) => c.text || '').join('') : content || '').trim();
    return { text, truncated: choice.finish_reason === 'length', usage: j.usage || null };
  }

  if (id === 'gemini') {
    const j = await withParamFallback(
      (o) => {
        const generationConfig = { maxOutputTokens: maxTokens };
        if (hasTemp && o.temperature) generationConfig.temperature = Number(temperature);
        return {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig
        };
      },
      (body) => request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      })
    );
    const cand = (j.candidates || [])[0];
    if (!cand) {
      const reason = j.promptFeedback && j.promptFeedback.blockReason;
      throw new Error(reason ? `Gemini blocked the request (${reason}).` : 'Gemini returned no text.');
    }
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
    return { text, truncated: cand.finishReason === 'MAX_TOKENS', usage: j.usageMetadata || null };
  }

  throw new Error(`Unknown provider: ${id}`);
}

module.exports = { DEFS, listModels, generate, request };
