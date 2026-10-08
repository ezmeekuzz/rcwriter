/* global S, main, modalRoot, esc, cleanErr, toast, attempt, fmtRel, confirmModal, closeModal, render, VIEWS, ACTIONS, api */
// Social posts (Buffer and a webhook for Zapier, Make or n8n) and the monthly
// Mailchimp newsletter.

const PLATFORM_LABEL = { linkedin: 'LinkedIn', facebook: 'Facebook', x: 'X', instagram: 'Instagram', threads: 'Threads', pinterest: 'Pinterest', googlebusiness: 'Google Business' };

window.socialBox = (d) => {
  const s = d.social || {};
  const dist = S.distribution || {};
  const profiles = dist.bufferProfiles || [];
  const ready = profiles.length || dist.webhookUrl;
  return `<fieldset><legend>Share on social</legend>
    <label class="check"><input type="checkbox" name="soc.enabled" data-change="writer-rerender" ${s.enabled ? 'checked' : ''}><span><strong>Write social posts when an article goes live</strong><br><span class="muted small">A native post for each network, linking to the article, with its featured image.</span></span></label>
    ${s.enabled ? `<div class="subpanel">
      ${ready ? '' : '<p class="warn small">Connect Buffer or add a social webhook in Settings, Social and newsletter, first.</p>'}
      <div class="field"><label for="soc-mode">How</label><select id="soc-mode" name="soc.mode">
        <option value="approve" ${s.mode !== 'auto' ? 'selected' : ''}>Let me approve each post first</option>
        <option value="auto" ${s.mode === 'auto' ? 'selected' : ''}>Send them automatically</option></select></div>
      ${profiles.length ? `<span class="label">Buffer channels</span><div class="checks">${profiles.map((p) => `<label class="check"><input type="checkbox" name="soc.buffer" value="${esc(p.id)}" ${(s.bufferProfileIds || []).includes(p.id) ? 'checked' : ''}><span>${esc(p.name)}</span></label>`).join('')}</div>` : ''}
      ${dist.webhookUrl ? `<label class="check"><input type="checkbox" name="soc.webhook" ${s.webhook ? 'checked' : ''}><span>Send to my social webhook (Zapier, Make or n8n) with posts for:</span></label>
        <div class="checks" style="margin-left:26px">${Object.entries(PLATFORM_LABEL).map(([k, l]) => `<label class="check"><input type="checkbox" name="soc.plat" value="${k}" ${(s.webhookPlatforms && s.webhookPlatforms.length ? s.webhookPlatforms : ['linkedin', 'facebook', 'x', 'instagram']).includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>` : ''}
      <div class="field"><label for="soc-notes">Notes for posts (optional)</label><input type="text" id="soc-notes" name="socialNotes" value="${esc(d.socialNotes || '')}" placeholder="Always mention we cover Leeds and Bradford. No emojis on LinkedIn."></div>
    </div>` : ''}
  </fieldset>`;
};

function distributionSettings() {
  const dist = S.distribution || {};
  return `
    <section class="panel">
      <h3>Social and newsletter</h3>
      <p class="muted small"><strong>Buffer:</strong> paste an access token from your Buffer account to queue posts on your connected channels. <strong>Webhook:</strong> any Zapier, Make or n8n webhook receives each article's posts as JSON (one field per network, plus the link and image), so you can post anywhere. <strong>Mailchimp:</strong> an API key (Account, Extras, API keys) lets RCWriter create monthly newsletter drafts. Nothing is sent to your subscribers without you.</p>
      <div class="field"><label for="bf-token">Buffer access token</label><div class="inline"><input type="password" id="bf-token" placeholder="${dist.hasBuffer ? 'Saved. Paste a new token to replace it.' : ''}" autocomplete="off"><button class="btn" data-action="bf-save">Save</button>${dist.hasBuffer ? '<button class="btn" data-action="bf-load">Load channels</button><button class="btn ghost" data-action="bf-clear">Remove</button>' : ''}</div>
        ${dist.bufferProfiles && dist.bufferProfiles.length ? `<span class="hint">Channels: ${dist.bufferProfiles.map((p) => esc(p.name)).join(', ')}</span>` : ''}</div>
      <div class="grid-2">
        <div class="field"><label for="sw-url">Social webhook URL</label><input type="url" id="sw-url" value="${esc(dist.webhookUrl || '')}" placeholder="https://hooks.zapier.com/…"></div>
        <div class="field"><label for="sw-secret">Signing secret (optional)</label><input type="password" id="sw-secret" placeholder="${dist.hasWebhookSecret ? 'Saved' : 'Adds an X-RCWriter-Signature header'}" autocomplete="off"></div>
      </div>
      <div class="btn-row" style="margin-bottom:14px"><button class="btn" data-action="sw-save">Save webhook</button></div>
      <div class="field"><label for="mc-key">Mailchimp API key</label><div class="inline"><input type="password" id="mc-key" placeholder="${dist.hasMailchimp ? 'Saved. Paste a new key to replace it.' : 'xxxxxxxx-us21'}" autocomplete="off"><button class="btn" data-action="mc-save">Save</button>${dist.hasMailchimp ? '<button class="btn" data-action="mc-load">Load audiences</button><button class="btn ghost" data-action="mc-clear">Remove</button>' : ''}</div>
        ${dist.mailchimpLists && dist.mailchimpLists.length ? `<span class="hint">Audiences: ${dist.mailchimpLists.map((l) => esc(l.name)).join(', ')}. Choose one for each client in Clients.</span>` : ''}</div>
    </section>`;
}

window.newsletterBox = (c) => {
  const n = c.newsletter || {};
  const lists = (S.distribution && S.distribution.mailchimpLists) || [];
  return `<label class="check"><input type="checkbox" id="cl-nl" ${n.enabled ? 'checked' : ''}><span><strong>Monthly newsletter</strong> from last month's articles (a Mailchimp draft, or an HTML file)</span></label>
    <div class="grid-2" style="margin-left:26px">
      <div class="field"><label for="cl-nl-day">On day of the month</label><input type="number" id="cl-nl-day" min="1" max="28" value="${esc(n.day || 2)}"></div>
      <div class="field"><label for="cl-nl-time">At</label><input type="time" id="cl-nl-time" value="${esc(n.time || '10:00')}"></div>
      <div class="field"><label for="cl-nl-list">Mailchimp audience</label><select id="cl-nl-list"><option value="">None (save as a file)</option>${lists.map((l) => `<option value="${esc(l.id)}" ${n.listId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="cl-nl-from">From name</label><input type="text" id="cl-nl-from" value="${esc(n.fromName || '')}" placeholder="${esc(c.name || '')}"></div>
      <div class="field"><label for="cl-nl-reply">Reply-to email</label><input type="email" id="cl-nl-reply" value="${esc(n.replyTo || '')}"></div>
    </div>`;
};

window.readNewsletterBox = () => {
  const q = (id) => modalRoot.querySelector(id);
  if (!q('#cl-nl')) return undefined;
  return { enabled: q('#cl-nl').checked, day: Number(q('#cl-nl-day').value) || 2, time: q('#cl-nl-time').value || '10:00', listId: q('#cl-nl-list').value, fromName: q('#cl-nl-from').value.trim(), replyTo: q('#cl-nl-reply').value.trim() };
};

const baseSettings2 = VIEWS.settings;
VIEWS.settings = () => {
  const html = baseSettings2();
  const at = html.indexOf('<section class="panel">\n      <h3>Images</h3>');
  return at >= 0 ? html.slice(0, at) + distributionSettings() + html.slice(at) : html + distributionSettings();
};

const keyField = (id) => main.querySelector(id).value.trim();
Object.assign(ACTIONS, {
  'bf-save': () => { const v = keyField('#bf-token'); if (!v) { toast('Paste the token first.', 'error'); return; } return attempt(async () => { await api.configureDistribution({ bufferToken: v }); const p = await api.bufferProfiles(); return p; }).then((p) => toast(`Buffer connected: ${p.length} channel${p.length === 1 ? '' : 's'}.`)).catch(() => {}); },
  'bf-load': () => attempt(() => api.bufferProfiles()).then((p) => toast(`${p.length} Buffer channel${p.length === 1 ? '' : 's'}.`)).catch(() => {}),
  'bf-clear': () => attempt(() => api.configureDistribution({ bufferToken: '' }), 'Buffer removed'),
  'sw-save': () => { const p = { webhookUrl: keyField('#sw-url') }; const sec = keyField('#sw-secret'); if (sec) p.webhookSecret = sec; return attempt(() => api.configureDistribution(p), 'Webhook saved'); },
  'mc-save': () => { const v = keyField('#mc-key'); if (!v) { toast('Paste the key first.', 'error'); return; } return attempt(async () => { await api.configureDistribution({ mailchimpKey: v }); return api.mailchimpLists(); }).then((l) => toast(`Mailchimp connected: ${l.length} audience${l.length === 1 ? '' : 's'}.`)).catch(() => {}); },
  'mc-load': () => attempt(() => api.mailchimpLists()).then((l) => toast(`${l.length} audience${l.length === 1 ? '' : 's'}.`)).catch(() => {}),
  'mc-clear': () => attempt(() => api.configureDistribution({ mailchimpKey: '' }), 'Mailchimp removed'),
  'share-article': async (el) => {
    el.disabled = true; el.textContent = 'Writing posts…';
    try { const r = await api.shareArticle(el.dataset.id); toast(!r ? 'Choose Buffer channels or the webhook in the writer\'s Share on social settings.' : r.applied ? `Shared: ${r.applied} post${r.applied > 1 ? 's' : ''} sent.` : `${r.queued} post${r.queued > 1 ? 's' : ''} waiting in Site audits, Approvals.`); }
    catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = 'Share on social'; }
  },
  'newsletter-make': async (el) => {
    el.disabled = true; const label = el.textContent; el.textContent = 'Writing…';
    try { const r = await api.newsletterNow(el.dataset.id); toast(r.mailchimp ? 'Newsletter draft created in Mailchimp.' : 'Newsletter saved as an HTML file.'); }
    catch (e) { toast(cleanErr(e), 'error'); }
    finally { el.disabled = false; el.textContent = label; }
  }
});
