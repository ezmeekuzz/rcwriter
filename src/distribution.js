// Getting articles in front of people: social posts through Buffer or a webhook
// (Zapier, Make, n8n), and a monthly newsletter draft in Mailchimp.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const enhance = require('./enhance');
const { renderMarkdown } = require('./renderer/markdown.js');

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PLATFORMS = ['linkedin', 'facebook', 'x', 'instagram', 'threads', 'pinterest', 'googlebusiness'];
const SERVICE_TO_PLATFORM = { twitter: 'x', linkedin: 'linkedin', facebook: 'facebook', instagram: 'instagram', threads: 'threads', pinterest: 'pinterest', googlebusiness: 'googlebusiness', mastodon: 'x', bluesky: 'x' };

function createDistribution({ store, ai, notify, onChange }) {
  const d = () => store.data;
  const cfg = () => d().distribution || (d().distribution = {});
  const secret = (k) => store.decrypt(cfg()[k]);

  // ---------- Buffer ----------
  async function buffer(pathname, { method = 'GET', form } = {}) {
    const token = secret('bufferToken');
    if (!token) throw new Error('Add your Buffer access token in Settings, Social and newsletter.');
    const u = new URL(`https://api.bufferapp.com/1/${pathname}`);
    u.searchParams.set('access_token', token);
    const res = await fetch(u, { method, headers: form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}, body: form ? form.toString() : undefined, signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(`Buffer: ${j.message || j.error || res.status}`);
    return j;
  }

  async function bufferProfiles() {
    const list = await buffer('profiles.json');
    const out = (Array.isArray(list) ? list : []).map((p) => ({ id: p.id, service: p.service, name: `${p.formatted_service || p.service}: ${p.formatted_username || p.service_username || ''}`.trim() }));
    cfg().bufferProfiles = { list: out, at: new Date().toISOString() };
    store.save();
    return out;
  }

  async function bufferPost({ profileIds, text, link, imageUrl, now = false }) {
    const form = new URLSearchParams();
    for (const id of profileIds) form.append('profile_ids[]', id);
    form.set('text', text);
    if (link) form.set('media[link]', link);
    if (imageUrl) { form.set('media[photo]', imageUrl); form.set('media[thumbnail]', imageUrl); }
    if (now) form.set('now', 'true');
    const j = await buffer('updates/create.json', { method: 'POST', form });
    return (j.updates || []).map((u) => u.id);
  }

  // ---------- webhook ----------
  async function webhookPost(url, payload) {
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'user-agent': 'RCWriter' };
    const s = secret('webhookSecret');
    if (s) headers['x-rcwriter-signature'] = `sha256=${crypto.createHmac('sha256', s).update(body).digest('hex')}`;
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`The webhook answered ${res.status}.`);
    return true;
  }

  // ---------- writing the posts ----------
  async function writePosts(article, writer, platforms) {
    let body = '';
    try { body = enhance.splitFront(fs.readFileSync(article.path, 'utf8')).body; } catch { /* title only */ }
    const r = await ai({
      system: 'You turn blog articles into native social posts. Each post stands on its own, hooks in the first line, gives one useful takeaway from the article and invites people to read it. No clickbait, no invented facts, emojis only where natural.',
      prompt: `Article: ${article.title}\nURL: ${article.published.url}\n${writer && writer.attitude ? `Brand voice: ${clip(writer.attitude, 600)}\n` : ''}${writer && writer.socialNotes ? `Notes: ${clip(writer.socialNotes, 600)}\n` : ''}\n${clip(enhance.plain(body), 5000)}\n\nWrite one post for each of: ${platforms.join(', ')}.\nRules: linkedin 600 to 1200 characters, short paragraphs, 3 hashtags at the end. facebook 300 to 600 characters, conversational. x under 260 characters including the URL, 1 or 2 hashtags. instagram 400 to 900 characters, no URL (say "link in bio"), 5 to 10 hashtags at the end. threads under 450 characters. pinterest a 100-character title then a 300-character description. googlebusiness 2 to 4 sentences, no hashtags or URL.\nInclude the article URL in linkedin, facebook, x and threads posts.\nReturn only JSON with those platform names as keys and the post text as values.`,
      maxTokens: 3000
    });
    const j = enhance.parseJson(r.text);
    const out = {};
    for (const p of platforms) if (j[p]) out[p] = String(j[p]).trim();
    return out;
  }

  // Called after an article goes live. Writer settings: social = { enabled, mode: 'approve'|'auto', bufferProfileIds: [], webhook: true }
  async function shareArticle(article, writer, { queue }) {
    const s = writer.social || {};
    if (!s.enabled || !article.published || article.published.status !== 'publish' || !article.published.url) return null;
    const profiles = (cfg().bufferProfiles && cfg().bufferProfiles.list) || [];
    const chosen = profiles.filter((p) => (s.bufferProfileIds || []).includes(p.id));
    const useHook = s.webhook && cfg().webhookUrl;
    if (!chosen.length && !useHook) return null;
    const platforms = [...new Set([...chosen.map((p) => SERVICE_TO_PLATFORM[p.service] || 'facebook'), ...(useHook ? (s.webhookPlatforms && s.webhookPlatforms.length ? s.webhookPlatforms : ['linkedin', 'facebook', 'x', 'instagram']) : [])])];
    const posts = await writePosts(article, writer, platforms);
    const imageUrl = article.published.imageUrl || '';
    const actions = [];
    for (const p of chosen) {
      const text = posts[SERVICE_TO_PLATFORM[p.service] || 'facebook'];
      if (text) actions.push({ tool: 'social_buffer_post', args: { profileIds: [p.id], text, link: article.published.url, imageUrl }, reason: `${p.name}: share "${article.title}"`, preview: clip(text, 280) });
    }
    if (useHook) {
      actions.push({ tool: 'social_webhook_post', args: { payload: { event: 'social.posts', title: article.title, url: article.published.url, imageUrl, imageAlt: article.image ? article.image.alt : '', excerpt: '', posts, writer: writer.name, createdAt: new Date().toISOString() } },
        reason: `Send social posts for "${article.title}" to your webhook`, preview: clip(Object.entries(posts).map(([k, v]) => `${k}: ${v}`).join(' | '), 280) });
    }
    let applied = 0, queued = 0;
    for (const a of actions) {
      const r = await queue(a, s.mode === 'auto' ? 'auto' : 'approve');
      if (r === 'applied') applied += 1; else queued += 1;
    }
    article.social = { posts, applied, queued, at: new Date().toISOString() };
    store.save();
    onChange();
    return { applied, queued };
  }

  // Tools used by the approval queue (builtin source "social:all").
  function tools() {
    return [
      { name: 'social_buffer_post', risk: 'approval', description: 'Queue a post in Buffer.', inputSchema: { type: 'object', properties: {} },
        run: async (a) => { const ids = await bufferPost(a); return { text: `Added to your Buffer queue (${ids.length} update${ids.length === 1 ? '' : 's'}).`, before: JSON.stringify(ids) }; },
        undo: async (_a, before) => { const ids = JSON.parse(before || '[]'); for (const id of ids) await buffer(`updates/${id}/destroy.json`, { method: 'POST', form: new URLSearchParams() }); return `Removed ${ids.length} update${ids.length === 1 ? '' : 's'} from Buffer (if not already sent).`; } },
      { name: 'social_webhook_post', risk: 'approval', description: 'Send posts to the social webhook.', inputSchema: { type: 'object', properties: {} },
        run: async (a) => { if (!cfg().webhookUrl) throw new Error('Add the social webhook URL in Settings.'); await webhookPost(cfg().webhookUrl, a.payload); return { text: 'Sent to your social webhook.' }; } }
    ];
  }

  // ---------- Mailchimp newsletter ----------
  async function mailchimp(pathname, { method = 'GET', body } = {}) {
    const key = secret('mailchimpKey');
    if (!key) throw new Error('Add your Mailchimp API key in Settings, Social and newsletter.');
    const dc = (key.split('-')[1] || '').trim();
    if (!dc) throw new Error('That Mailchimp key looks incomplete. It ends with the data centre, for example -us21.');
    const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/${pathname}`, { method, headers: { authorization: `Basic ${Buffer.from(`rcwriter:${key}`).toString('base64')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Mailchimp: ${j.detail || j.title || res.status}`);
    return j;
  }

  async function mailchimpLists() {
    const j = await mailchimp('lists?count=100&fields=lists.id,lists.name,lists.stats.member_count');
    const out = (j.lists || []).map((l) => ({ id: l.id, name: `${l.name} (${(l.stats && l.stats.member_count) || 0} contacts)` }));
    cfg().mailchimpLists = { list: out, at: new Date().toISOString() };
    store.save();
    return out;
  }

  function newsletterHtml(n, brand) {
    const items = n.items.map((i) => `
      <tr><td style="padding:18px 0;border-bottom:1px solid #E2E6EC">
        ${i.imageUrl ? `<a href="${escHtml(i.url)}"><img src="${escHtml(i.imageUrl)}" alt="${escHtml(i.alt || i.title)}" width="560" style="width:100%;max-width:560px;border-radius:8px;display:block;margin-bottom:12px"></a>` : ''}
        <h2 style="font:600 20px/1.3 Georgia,serif;margin:0 0 6px;color:#1C2340"><a href="${escHtml(i.url)}" style="color:#1C2340;text-decoration:none">${escHtml(i.title)}</a></h2>
        <p style="margin:0 0 10px;font:15px/1.6 Arial,sans-serif;color:#33394F">${escHtml(i.blurb)}</p>
        <a href="${escHtml(i.url)}" style="font:600 14px Arial,sans-serif;color:#2F3C9E">Read more →</a></td></tr>`).join('');
    return `<!doctype html><html><body style="margin:0;background:#EEF1F4"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F4"><tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;padding:28px">
      <tr><td style="font:12px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#5A6178">${escHtml(brand)}</td></tr>
      <tr><td><h1 style="font:600 26px/1.25 Georgia,serif;color:#1C2340;margin:8px 0 12px">${escHtml(n.heading)}</h1>
        <div style="font:15px/1.6 Arial,sans-serif;color:#33394F">${renderMarkdown(n.intro || '')}</div></td></tr>
      ${items}
      ${n.cta ? `<tr><td style="padding:22px 0 4px;font:15px/1.6 Arial,sans-serif;color:#33394F">${renderMarkdown(n.cta)}</td></tr>` : ''}
      <tr><td style="padding-top:22px;font:12px/1.5 Arial,sans-serif;color:#8A90A6">You're receiving this because you subscribed. *|UNSUB|*</td></tr>
      </table></td></tr></table></body></html>`;
  }

  // client.newsletter = { enabled, day, time, listId, fromName, replyTo }
  async function monthlyNewsletter(client, { offset = -1 } = {}) {
    const nl = client.newsletter || {};
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59);
    const month = start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const siteIds = new Set(d().sites.filter((x) => x.clientId === client.id).map((x) => x.id));
    const arts = d().articles.filter((a) => a.published && siteIds.has(a.published.siteId) && a.published.status === 'publish' && a.published.url
      && new Date(a.published.at) >= start && new Date(a.published.at) <= end).slice(0, 8);
    if (!arts.length) throw new Error(`No articles were published for ${client.name} in ${month}, so there's nothing for a newsletter.`);
    const src = arts.map((a) => {
      let body = '';
      try { body = enhance.plain(enhance.splitFront(fs.readFileSync(a.path, 'utf8')).body).slice(0, 1500); } catch { /* title only */ }
      return { title: a.title, url: a.published.url, imageUrl: a.published.imageUrl || '', alt: a.image ? a.image.alt : '', text: body };
    });
    const r = await ai({
      system: 'You write friendly, useful email newsletters for small businesses. Plain language, no hype, no invented facts or offers.',
      prompt: `Business: ${client.name}${client.notes ? `\nAbout them: ${clip(client.notes, 800)}` : ''}\nMonth: ${month}\nArticles published this month:\n${JSON.stringify(src, null, 1)}\n\nReturn only JSON: {"subject": "under 60 characters", "preview": "under 100 characters", "heading": "...", "intro": "2 to 3 short sentences in Markdown", "blurbs": ["one 2-sentence teaser per article, in the same order"], "cta": "one closing sentence inviting replies or a visit, Markdown"}`,
      maxTokens: 2000
    });
    const j = enhance.parseJson(r.text);
    const n = { heading: j.heading || `${month} at ${client.name}`, intro: j.intro || '', cta: j.cta || '', items: src.map((s, i) => ({ ...s, blurb: (j.blurbs || [])[i] || clip(s.text, 200) })) };
    const html = newsletterHtml(n, client.name);
    const dir = path.join(d().settings.outputDir, 'Reports', client.name.replace(/[<>:"/\\|?*]+/g, ' ').trim(), 'Newsletters');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')} newsletter.html`);
    fs.writeFileSync(file, html, 'utf8');
    const rec = { id: store.uid(), kind: 'newsletter', clientId: client.id, clientName: client.name, period: month, subject: j.subject || n.heading, files: { html: file }, createdAt: new Date().toISOString() };
    if (secret('mailchimpKey') && nl.listId) {
      const c = await mailchimp('campaigns', { method: 'POST', body: { type: 'regular', recipients: { list_id: nl.listId },
        settings: { subject_line: rec.subject, preview_text: j.preview || '', title: `${client.name} ${month} (RCWriter)`, from_name: nl.fromName || client.name, reply_to: nl.replyTo || (client.email || '').split(/[,;\s]+/)[0] || '' } } });
      await mailchimp(`campaigns/${c.id}/content`, { method: 'PUT', body: { html } });
      rec.mailchimp = { id: c.id, webId: c.web_id, url: c.web_id ? `https://${secret('mailchimpKey').split('-')[1]}.admin.mailchimp.com/campaigns/edit?id=${c.web_id}` : '' };
    }
    d().reports = [rec, ...(d().reports || [])].slice(0, 300);
    store.log('info', `${month} newsletter for ${client.name} ${rec.mailchimp ? 'is a draft in Mailchimp' : 'was saved as an HTML file'}.`);
    store.save();
    onChange();
    return rec;
  }

  function status() {
    const c = cfg();
    return { hasBuffer: !!c.bufferToken, bufferProfiles: (c.bufferProfiles && c.bufferProfiles.list) || [], webhookUrl: c.webhookUrl || '', hasWebhookSecret: !!c.webhookSecret,
      hasMailchimp: !!c.mailchimpKey, mailchimpLists: (c.mailchimpLists && c.mailchimpLists.list) || [] };
  }

  function configure(patch = {}) {
    const c = cfg();
    for (const k of ['bufferToken', 'webhookSecret', 'mailchimpKey']) if (k in patch) c[k] = patch[k] ? store.encrypt(String(patch[k]).trim()) : null;
    if ('webhookUrl' in patch) {
      const u = String(patch.webhookUrl || '').trim();
      if (u && !/^https:\/\//.test(u)) throw new Error('The webhook URL must start with https://');
      c.webhookUrl = u;
    }
    if ('bufferToken' in patch && !patch.bufferToken) delete c.bufferProfiles;
    if ('mailchimpKey' in patch && !patch.mailchimpKey) delete c.mailchimpLists;
    store.save();
  }

  return { status, configure, bufferProfiles, mailchimpLists, shareArticle, tools, monthlyNewsletter, writePosts, newsletterHtml, PLATFORMS };
}

module.exports = { createDistribution, PLATFORMS };
