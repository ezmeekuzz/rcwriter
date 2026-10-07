/* global S, main, modalRoot, esc, cleanErr, toast, attempt, fmtRel, confirmModal, closeModal, render, VIEWS, ACTIONS, api */
// Websites: shared by the article writer (publishing, site context) and site audits
// (built-in tools, Google data). Lives under "General" in the sidebar.

const TYPE_LABEL = { wordpress: 'WordPress', webhook: 'Webhook', url: 'Website' };

function googlePanel() {
  const g = S.google || {};
  const l = g.lists;
  const body = g.connected ? `
      <p class="provider-state ok">Connected as ${esc(g.email || 'your Google account')}${g.mode === 'service' ? ' (service account)' : ''}.${l ? ` Can see ${l.gsc.length} Search Console ${l.gsc.length === 1 ? 'property' : 'properties'}, ${l.ga4.length} GA4 ${l.ga4.length === 1 ? 'property' : 'properties'} and ${l.gtm.length} Tag Manager ${l.gtm.length === 1 ? 'container' : 'containers'}.` : ''}</p>
      ${l && l.errors && l.errors.length ? `<p class="warn small">${l.errors.map(esc).join('<br>')}</p>` : ''}
      ${g.mode === 'service' ? `<p class="muted small">To give RCWriter access to a client's data, add <code>${esc(g.email)}</code> as a user in their Search Console property, GA4 property (Viewer) and Tag Manager container (Read), then click Refresh.</p>` : ''}
      <div class="btn-row"><button class="btn" data-action="google-refresh">Refresh</button><button class="btn ghost danger" data-action="google-disconnect">Disconnect</button></div>`
    : `<p class="muted small">Read-only access to Search Console, Google Analytics 4 and Tag Manager. Audits use it to find pages losing traffic, indexing problems and missing tags; writers use Search Console to pick topics people already search for.</p>
      <div class="btn-row"><button class="btn primary" data-action="google-connect">Connect Google</button></div>`;
  return `
    <section class="panel" style="max-width:none">
      <h3>Google Search Console, Analytics and Tag Manager</h3>
      ${body}
      <details class="detail"><summary>PageSpeed Insights API key (optional)</summary>
        <p class="muted small">Audits can run PageSpeed tests without a key, but Google limits how many. A free key from Google Cloud (PageSpeed Insights API) raises the limit.</p>
        <div class="inline"><input type="password" id="psi-key" placeholder="${g.hasPsiKey ? 'Saved. Paste a new key to replace it.' : 'AIza…'}" autocomplete="off"><button class="btn" data-action="psi-save">Save</button>${g.hasPsiKey ? '<button class="btn ghost" data-action="psi-clear">Remove</button>' : ''}</div>
      </details>
    </section>`;
}

function viewSitesShared() {
  const rows = S.sites.map((site) => {
    const writers = S.writers.filter((w) => w.siteId === site.id).map((w) => w.name);
    const audits = S.auditJobs.filter((j) => j.siteId === site.id).map((j) => j.name);
    const g = site.google || {};
    const gBits = [g.gscSite && 'Search Console', g.ga4Property && 'GA4', g.gtmContainer && 'Tag Manager'].filter(Boolean);
    const builtins = (S.builtinBySite[site.id] || []).map((b) => b.name);
    const state = site.lastError ? `<span class="err">${esc(site.lastError)}</span>`
      : site.type === 'wordpress' ? `Connected as ${esc(site.connectedAs || site.username)}${site.canPublish === false ? ". This user can't publish; posts will fail." : ''}`
      : site.type === 'webhook' ? `Webhook${site.hasSecret ? ', signed' : ''}` : 'For audits and Google data. No publishing.';
    return `
      <div class="row writer-row top">
        <div>
          <div class="title">${esc(site.name)} <span class="muted small" style="font-weight:400">${TYPE_LABEL[site.type] || site.type}</span></div>
          <div class="meta">${esc(site.url)} · ${state}</div>
          <div class="meta">Google: ${gBits.length ? esc(gBits.join(', ')) : S.google.connected ? 'not linked yet' : 'connect Google above to link data'}</div>
          <div class="meta">Audit tools: ${builtins.length ? esc(builtins.join(', ')) : 'none'}</div>
          <div class="meta">${writers.length ? `Writers: ${esc(writers.join(', '))}` : 'No writers publish here'}${audits.length ? ` · Audits: ${esc(audits.join(', '))}` : ''}</div>
          ${site.type !== 'webhook' ? `<div class="meta inline-pace">Request pace
            <select data-change="site-pace" data-id="${site.id}" aria-label="Request pace for ${esc(site.name)}">${Object.entries(S.paces).map(([k, p]) => `<option value="${k}" ${site.pace === k ? 'selected' : ''}>${esc(p.label)}: 1 request every ${p.gapMs / 1000}s, up to ${p.auditPerDay} audit requests a day</option>`).join('')}</select></div>` : ''}
          ${site.access && site.access.pausedUntil ? `<div class="paused-note"><strong>Direct requests paused until ${esc(new Date(site.access.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}.</strong> ${esc(site.access.provider || 'The host')} challenged RCWriter as a possible bot, so RCWriter is giving the block time to lift. Audits use Google, Ahrefs, Semrush and WPVibe data meanwhile. If the host has whitelisted your IP address, resume now.
            <button class="btn small" data-action="site-resume" data-id="${site.id}">Resume now</button></div>` : ''}
        </div>
        <div class="btn-row">
          ${S.google.connected ? `<button class="btn" data-action="site-google" data-id="${site.id}">Google data</button>` : ''}
          <button class="btn ghost" data-action="test-site" data-id="${site.id}">Test</button>
          ${site.type === 'wordpress' ? `<button class="btn ghost" data-action="reconnect-site" data-id="${site.id}">Reconnect</button>` : site.type === 'webhook' ? `<button class="btn ghost" data-action="edit-webhook" data-id="${site.id}">Edit</button>` : `<button class="btn ghost" data-action="url-site-edit" data-id="${site.id}">Edit</button>`}
          <button class="btn ghost danger" data-action="delete-site" data-id="${site.id}">Remove</button>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="page-head">
      <div><h1>Websites</h1><p class="sub">Your websites, shared by the article writer and site audits. Connect WordPress to publish articles and let audits read and fix pages; link Google data for search and traffic insights.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="url-site-new">Add a website (audits only)</button>
        <button class="btn" data-action="new-webhook">Add a webhook</button>
        <button class="btn primary" data-action="new-wordpress">Connect a WordPress site</button>
      </div>
    </div>
    ${googlePanel()}
    <div class="list">${rows || '<div class="empty"><p>No websites yet.</p><button class="btn primary" data-action="new-wordpress">Connect a WordPress site</button></div>'}</div>
    <p class="muted small" style="max-width:72ch;margin-top:16px">Using Ghost, Webflow, Wix, Shopify or another platform? Add a webhook to publish through Zapier, Make or n8n, and add the site as a website to audit it.</p>`;
}

function openGoogleModal() {
  modal = { type: 'google', tab: 'service' };
  renderGoogleModal();
}

function renderGoogleModal() {
  const tab = modal.tab;
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">Connect Google</h2></header>
      <div class="body">
        <div class="seg" role="tablist" style="margin-bottom:14px">
          <button class="${tab === 'service' ? 'on' : ''}" data-action="google-tab" data-tab="service">Service account (recommended)</button>
          <button class="${tab === 'oauth' ? 'on' : ''}" data-action="google-tab" data-tab="oauth">Sign in with my Google account</button>
        </div>
        ${tab === 'service' ? `
          <p class="small">Best for scheduled audits: it never signs out. You create it once in Google Cloud, then add its email address to each client's properties.</p>
          <ol class="small steps">
            <li>Open <a href="#" data-action="link" data-url="https://console.cloud.google.com/projectcreate">Google Cloud</a> and create a project (any name).</li>
            <li>Enable these APIs in that project: <a href="#" data-action="link" data-url="https://console.cloud.google.com/apis/library/searchconsole.googleapis.com">Search Console API</a>, <a href="#" data-action="link" data-url="https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com">Analytics Data API</a>, <a href="#" data-action="link" data-url="https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com">Analytics Admin API</a> and <a href="#" data-action="link" data-url="https://console.cloud.google.com/apis/library/tagmanager.googleapis.com">Tag Manager API</a>.</li>
            <li>Go to <a href="#" data-action="link" data-url="https://console.cloud.google.com/iam-admin/serviceaccounts">Service accounts</a>, create one, then open it, choose Keys, Add key, JSON. A key file downloads.</li>
            <li>Add the service account's email as a user in Search Console (Settings, Users and permissions), GA4 (Admin, Property access management, Viewer) and Tag Manager (Admin, User management, Read).</li>
            <li>Click below and choose the key file.</li>
          </ol>
          <p class="muted small">The key is encrypted with your system keychain and stays on this computer.</p>` : `
          <p class="small">Uses your own Google login. You need a free OAuth client from Google Cloud, because Google requires every app that reads this data to be registered.</p>
          <ol class="small steps">
            <li>In <a href="#" data-action="link" data-url="https://console.cloud.google.com/apis/credentials">Google Cloud, Credentials</a>, create an OAuth client ID of type <strong>Desktop app</strong>. (Set up the consent screen first if asked, and publish it so sign-ins don't expire after 7 days.)</li>
            <li>Enable the Search Console, Analytics Data, Analytics Admin and Tag Manager APIs in the same project.</li>
            <li>Paste the client ID and secret below and sign in.</li>
          </ol>
          <div class="field"><label for="go-id">Client ID</label><input type="text" id="go-id" value="${esc(S.google.clientId || '')}" placeholder="…apps.googleusercontent.com"></div>
          <div class="field"><label for="go-secret">Client secret</label><input type="password" id="go-secret" autocomplete="off"></div>`}
      </div>
      <footer><button class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="${tab === 'service' ? 'google-sa' : 'google-oauth'}">${tab === 'service' ? 'Choose key file' : 'Sign in with Google'}</button></footer>
    </div></div>`;
}

function openSiteGoogleModal(siteId) {
  const site = S.sites.find((x) => x.id === siteId);
  const l = S.google.lists || { gsc: [], ga4: [], gtm: [] };
  const g = site.google || {};
  const opt = (list, val) => `<option value="">Not linked</option>${list.map((x) => `<option value="${esc(x.id)}" ${val === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}${val && !list.find((x) => x.id === val) ? `<option value="${esc(val)}" selected>${esc(val)}</option>` : ''}`;
  modal = { type: 'site-google', siteId };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">Google data for ${esc(site.name)}</h2></header>
      <div class="body">
        <div class="field"><label for="sg-gsc">Search Console property</label><select id="sg-gsc">${opt(l.gsc, g.gscSite)}</select></div>
        <div class="field"><label for="sg-ga4">GA4 property</label><select id="sg-ga4">${opt(l.ga4, g.ga4Property)}</select></div>
        <div class="field"><label for="sg-gtm">Tag Manager container</label><select id="sg-gtm">${opt(l.gtm, g.gtmContainer)}</select></div>
        <p class="muted small">Missing one? Give ${esc(S.google.email || 'the connected account')} access to it in Google, then click Refresh list.</p>
      </div>
      <footer><button class="btn ghost" data-action="google-refresh-in-modal">Refresh list</button>
        <div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="site-google-save">Save</button></div></footer>
    </div></div>`;
}

function openUrlSiteModal(site) {
  modal = { type: 'url-site', site: site || null };
  modalRoot.innerHTML = `
    <div class="backdrop"><div class="modal small" role="dialog" aria-modal="true" aria-labelledby="mt">
      <header><h2 id="mt">${site ? 'Edit website' : 'Add a website for audits'}</h2></header>
      <div class="body">
        <p class="muted small">For sites that aren't WordPress, or that you only want to audit. Audits can check pages, links, sitemap and speed, and use Google data once linked. To let audits edit a WordPress site, connect it as WordPress instead.</p>
        <div class="field"><label for="us-name">Name</label><input type="text" id="us-name" value="${esc(site ? site.name : '')}" placeholder="The Alumina Company"></div>
        <div class="field"><label for="us-url">Address</label><input type="url" id="us-url" value="${esc(site ? site.url : '')}" placeholder="https://thealuminacompany.com"></div>
      </div>
      <footer><span></span><div class="btn-row"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="url-site-save">${site ? 'Save' : 'Add website'}</button></div></footer>
    </div></div>`;
  modalRoot.querySelector('#us-name').focus();
}

VIEWS.sites = viewSitesShared;

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change === 'site-pace') attempt(() => api.setSitePace(el.dataset.id, el.value), 'Request pace saved');
});

Object.assign(ACTIONS, {
  'google-connect': () => openGoogleModal(),
  'google-tab': (el) => { modal.tab = el.dataset.tab; renderGoogleModal(); },
  'google-sa': async (el) => {
    el.disabled = true;
    try {
      const lists = await api.googleServiceAccount();
      if (!lists) { el.disabled = false; return; }
      closeModal();
      toast(lists.errors.length ? `Connected, with problems: ${lists.errors[0]}` : 'Google connected.', lists.errors.length ? 'error' : 'info');
    } catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; }
  },
  'google-oauth': async (el) => {
    const id = modalRoot.querySelector('#go-id').value.trim();
    const secret = modalRoot.querySelector('#go-secret').value.trim();
    el.disabled = true; el.textContent = 'Waiting for Google…';
    try { await api.googleOAuth(id, secret); closeModal(); toast('Google connected.'); }
    catch (e) { toast(cleanErr(e), 'error'); el.disabled = false; el.textContent = 'Sign in with Google'; }
  },
  'google-refresh': (el) => { el.disabled = true; return attempt(() => api.googleRefresh(), 'Google lists refreshed').finally(() => { el.disabled = false; }); },
  'google-refresh-in-modal': async () => { const id = modal.siteId; await attempt(() => api.googleRefresh()); openSiteGoogleModal(id); },
  'google-disconnect': async () => {
    if (await confirmModal({ title: 'Disconnect Google?', body: 'Audits and writers stop using Search Console, GA4 and Tag Manager data. Your site links are kept for when you reconnect.', confirm: 'Disconnect' })) {
      closeModal();
      await attempt(() => api.googleDisconnect(), 'Google disconnected');
    }
  },
  'psi-save': () => { const v = main.querySelector('#psi-key').value.trim(); if (!v) { toast('Paste the key first.', 'error'); return; } return attempt(() => api.googlePsiKey(v), 'PageSpeed key saved'); },
  'psi-clear': () => attempt(() => api.googlePsiKey(''), 'PageSpeed key removed'),
  'site-google': (el) => openSiteGoogleModal(el.dataset.id),
  'site-google-save': async () => {
    const v = (id) => modalRoot.querySelector(id).value;
    await attempt(() => api.setSiteGoogle(modal.siteId, { gscSite: v('#sg-gsc'), ga4Property: v('#sg-ga4'), gtmContainer: v('#sg-gtm') }), 'Google data linked');
    closeModal();
  },
  'site-resume': (el) => attempt(() => api.resumeSite(el.dataset.id), 'Direct requests resumed'),
  'url-site-new': () => openUrlSiteModal(),
  'url-site-edit': (el) => openUrlSiteModal(S.sites.find((x) => x.id === el.dataset.id)),
  'url-site-save': async () => {
    const name = modalRoot.querySelector('#us-name').value;
    const url = modalRoot.querySelector('#us-url').value;
    await attempt(() => api.addUrlSite({ id: modal.site && modal.site.id, name, url }), modal.site ? 'Website saved' : 'Website added');
    closeModal();
  }
});
