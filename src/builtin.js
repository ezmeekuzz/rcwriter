// Built-in audit tools that need no extra connector:
//  web:<siteId|url>  Website checker  - pages, crawl, links, sitemap, robots.txt, PageSpeed
//  wp:<siteId>       WordPress        - uses the site's saved application password
//  google:<siteId>   Google data      - Search Console, GA4, Tag Manager for the site
const sitesLib = require('./sites');
const guard = require('./hostguard');

// All requests to websites go through the host guard: one at a time per site,
// paced, cached for 30 minutes, with a daily limit and an automatic pause if
// the host's bot protection pushes back.
const get = (url, init = {}) => guard.guardedFetch(url, init, { purpose: 'audit', cacheable: true });
const stopErr = (e) => e && (e.blocked || e.paused || e.budget);
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…[truncated]` : s; };
const strip = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const json = (o) => JSON.stringify(o, null, 1);

function attrs(tag) {
  const o = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) o[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return o;
}

async function fetchTraced(url, { method = 'GET', max = 10, timeoutMs = 30000 } = {}) {
  const chain = [];
  let current = url;
  const started = Date.now();
  for (let i = 0; i <= max; i++) {
    const res = await get(current, { method, redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      chain.push({ url: current, status: res.status });
      current = new URL(res.headers.get('location'), current).toString();
      try { await res.body?.cancel(); } catch { /* ignore */ }
      continue;
    }
    return { res, finalUrl: current, chain, ms: Date.now() - started };
  }
  throw new Error(`Too many redirects starting at ${url}`);
}

function analyzeHtml(html, pageUrl) {
  const host = new URL(pageUrl).host;
  const metas = [...html.matchAll(/<meta\s[^>]*>/gi)].map((m) => attrs(m[0]));
  const meta = (n) => (metas.find((x) => (x.name || x.property || '').toLowerCase() === n) || {}).content;
  const linksTags = [...html.matchAll(/<link\s[^>]*>/gi)].map((m) => attrs(m[0]));
  const canonical = (linksTags.find((l) => (l.rel || '').toLowerCase() === 'canonical') || {}).href;
  const hreflang = linksTags.filter((l) => l.hreflang).map((l) => `${l.hreflang}: ${l.href}`).slice(0, 15);
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1])).filter(Boolean);
  const h2 = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].length;
  const imgs = [...html.matchAll(/<img\s[^>]*>/gi)].map((m) => attrs(m[0]));
  const noAlt = imgs.filter((i) => !('alt' in i) || !String(i.alt).trim()).map((i) => i.src || i['data-src'] || '').filter(Boolean);
  const anchors = [...html.matchAll(/<a\s[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)].map((m) => m[2] ?? m[3] ?? m[4] ?? '');
  const links = { internal: new Set(), external: new Set() };
  for (const href of anchors) {
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      const u = new URL(href, pageUrl);
      u.hash = '';
      if (!/^https?:$/.test(u.protocol)) continue;
      (u.host === host ? links.internal : links.external).add(u.toString());
    } catch { /* bad href */ }
  }
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) => {
    try { const j = JSON.parse(m[1]); const arr = Array.isArray(j) ? j : j['@graph'] || [j]; return arr.map((x) => x['@type']).flat(); } catch { return ['(invalid JSON-LD)']; }
  }).filter(Boolean);
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const desc = meta('description') || '';
  const text = strip(html);
  return {
    title, titleLength: title.length, metaDescription: desc, metaDescriptionLength: desc.length,
    metaRobots: meta('robots') || '', canonical: canonical || '', lang: (html.match(/<html[^>]*\blang=["']?([\w-]+)/i) || [])[1] || '',
    h1, h2Count: h2, wordCount: text ? text.split(' ').length : 0,
    images: imgs.length, imagesMissingAlt: noAlt.length, imagesMissingAltSample: noAlt.slice(0, 10),
    internalLinks: links.internal.size, externalLinks: links.external.size,
    openGraph: { title: !!meta('og:title'), description: !!meta('og:description'), image: !!meta('og:image') },
    structuredData: [...new Set(ld)].slice(0, 15), hreflang,
    _internal: [...links.internal], _external: [...links.external]
  };
}

async function checkUrl(url) {
  try {
    let t = await fetchTraced(url, { method: 'HEAD', timeoutMs: 20000 });
    if ([403, 405, 501].includes(t.res.status)) t = await fetchTraced(url, { timeoutMs: 20000 });
    try { await t.res.body?.cancel(); } catch { /* ignore */ }
    return { url, status: t.res.status, finalUrl: t.finalUrl !== url ? t.finalUrl : undefined, redirects: t.chain.length || undefined };
  } catch (e) {
    if (e.blocked) return { url, status: 'not checked', error: `${e.blocked.provider} bot protection; RCWriter paused direct requests to this site` };
    if (e.paused || e.budget) return { url, status: 'not checked', error: e.paused ? 'direct requests to this site are paused' : 'daily request limit for this site reached' };
    return { url, status: 0, error: e.name === 'TimeoutError' ? 'timed out' : String(e.cause?.code || e.message) };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function createBuiltins({ store, google }) {
  const site = (id) => store.data.sites.find((s) => s.id === id);
  const wpAuth = (s) => ({ user: s.username, pass: store.decrypt(s.secret) });
  const wp = (s, route, opts = {}) => sitesLib.wpRequest(s, wpAuth(s), route, { ...opts, purpose: 'audit' });
  const T = (name, description, properties, required, risk, run, extra = {}) =>
    ({ name, description, inputSchema: { type: 'object', properties, required }, risk, run, ...extra });
  const typeProp = { type: 'string', enum: ['posts', 'pages'], description: 'posts or pages' };

  // ---------- website checker ----------
  function webTools(base) {
    const root = base.replace(/\/+$/, '');
    async function checkPage({ url }) {
      const t = await fetchTraced(url || root);
      const ct = t.res.headers.get('content-type') || '';
      const html = ct.includes('html') ? await t.res.text() : '';
      const a = html ? analyzeHtml(html, t.finalUrl) : {};
      delete a._internal; delete a._external;
      return json({ url: url || root, status: t.res.status, finalUrl: t.finalUrl, redirectChain: t.chain, responseMs: t.ms,
        htmlKB: Math.round(html.length / 1024), xRobotsTag: t.res.headers.get('x-robots-tag') || '', contentType: ct, ...a });
    }
    return [
      T('check_page', `Fetch one page of ${root} and report status code, redirects, response time, title, meta description, robots/noindex, canonical, H1s, word count, images without alt text, link counts, Open Graph and structured data.`,
        { url: { type: 'string', description: 'Full URL. Defaults to the homepage.' } }, [], 'read', checkPage),
      T('crawl_site', `Crawl up to 30 internal pages of ${root}, starting from a URL (default homepage), and summarise SEO issues per page: errors, missing or duplicate titles and meta descriptions, missing H1, noindex, canonical pointing elsewhere, images without alt text. Pages are fetched slowly, one at a time, so the host doesn't flag RCWriter as a bot: prefer Search Console, Ahrefs or Semrush crawl data when available and crawl only what they don't cover.`,
        { startUrl: { type: 'string' }, maxPages: { type: 'number', description: '1-30, default 15' } }, [], 'read', async ({ startUrl, maxPages }) => {
          const limit = Math.max(1, Math.min(30, Number(maxPages) || 15));
          const start = startUrl || `${root}/`;
          const seen = new Set([start]);
          const queue = [start];
          const pages = [];
          let blocked = null;
          while (queue.length && pages.length < limit && !blocked) {
            const batch = queue.splice(0, 1);
            const results = await pool(batch, 1, async (u) => {
              try {
                const t = await fetchTraced(u, { timeoutMs: 25000 });
                const ct = t.res.headers.get('content-type') || '';
                if (!ct.includes('html')) { try { await t.res.body?.cancel(); } catch { /* ignore */ } return { url: u, status: t.res.status, note: ct }; }
                const a = analyzeHtml(await t.res.text(), t.finalUrl);
                for (const l of a._internal) {
                  const clean = l.split('?')[0];
                  if (!seen.has(clean) && !/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|css|js)$/i.test(clean) && !/\/(wp-admin|wp-login|feed|wp-json)\b/.test(clean)) { seen.add(clean); queue.push(clean); }
                }
                const issues = [];
                if (t.res.status >= 400) issues.push(`HTTP ${t.res.status}`);
                if (t.chain.length) issues.push(`redirects ${t.chain.length}x to ${t.finalUrl}`);
                if (!a.title) issues.push('no title'); else if (a.titleLength > 60) issues.push(`title ${a.titleLength} chars`);
                if (!a.metaDescription) issues.push('no meta description'); else if (a.metaDescriptionLength > 160) issues.push(`meta description ${a.metaDescriptionLength} chars`);
                if (!a.h1.length) issues.push('no H1'); else if (a.h1.length > 1) issues.push(`${a.h1.length} H1s`);
                if (/noindex/i.test(a.metaRobots + (t.res.headers.get('x-robots-tag') || ''))) issues.push('noindex');
                if (a.canonical && a.canonical.replace(/\/$/, '') !== t.finalUrl.replace(/\/$/, '')) issues.push(`canonical -> ${a.canonical}`);
                if (a.imagesMissingAlt) issues.push(`${a.imagesMissingAlt} images without alt`);
                if (a.wordCount < 250) issues.push(`thin (${a.wordCount} words)`);
                return { url: u, status: t.res.status, title: a.title, metaDescription: a.metaDescription ? `${a.metaDescription.slice(0, 80)}${a.metaDescription.length > 80 ? '…' : ''}` : '', issues };
              } catch (e) {
                if (stopErr(e)) { blocked = { message: e.message }; return { url: u, status: 'not checked', issues: [e.blocked ? `${e.blocked.provider} bot protection challenged the request` : 'direct requests paused'] }; }
                return { url: u, status: 0, issues: [`could not load: ${e.cause?.code || e.message}`] };
              }
            });
            pages.push(...results);
          }
          const dupes = (k) => Object.entries(pages.reduce((m, p) => { if (p[k]) (m[p[k]] = m[p[k]] || []).push(p.url); return m; }, {})).filter(([, v]) => v.length > 1).map(([t, v]) => ({ [k]: t, pages: v }));
          return json({ ...(blocked ? { stoppedEarly: `Crawl stopped: ${blocked.message}` } : {}), crawled: pages.length, notVisited: queue.length, duplicateTitles: dupes('title'), duplicateMetaDescriptions: dupes('metaDescription'), pages });
        }),
      T('find_broken_links', 'Load a page, collect every link on it (internal and external) and report the ones that are broken (4xx/5xx, unreachable) or redirect.',
        { url: { type: 'string' }, maxLinks: { type: 'number', description: 'default 80, max 200' } }, ['url'], 'read', async ({ url, maxLinks }) => {
          const t = await fetchTraced(url);
          const a = analyzeHtml(await t.res.text(), t.finalUrl);
          const all = [...a._internal, ...a._external].slice(0, Math.min(200, Number(maxLinks) || 80));
          const results = await pool(all, 4, checkUrl); // the guard keeps each site to one request at a time
          return json({ page: url, checked: results.length, broken: results.filter((r) => r.status === 0 || r.status >= 400), redirected: results.filter((r) => r.redirects).slice(0, 30) });
        }),
      T('check_urls', 'Check the HTTP status of up to 100 URLs (for example old URLs, URLs from Search Console or a sitemap).',
        { urls: { type: 'array', items: { type: 'string' } } }, ['urls'], 'read', async ({ urls }) => json(await pool((urls || []).slice(0, 100), 4, checkUrl))),
      T('get_sitemap', `Read the XML sitemap of ${root} (from robots.txt or the usual locations) and list its URLs.`,
        { url: { type: 'string', description: 'Sitemap URL, optional' } }, [], 'read', async ({ url }) => {
          const candidates = url ? [url] : [];
          if (!url) {
            try {
              const r = await get(`${root}/robots.txt`, { signal: AbortSignal.timeout(15000) });
              if (r.ok) candidates.push(...[...(await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]));
            } catch (e) { if (stopErr(e)) throw e; }
            candidates.push(`${root}/sitemap.xml`, `${root}/sitemap_index.xml`, `${root}/wp-sitemap.xml`);
          }
          for (const c of [...new Set(candidates)]) {
            try {
              const r = await get(c, { signal: AbortSignal.timeout(20000) });
              if (!r.ok) continue;
              const xml = await r.text();
              const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
              if (/<sitemapindex/i.test(xml)) {
                const urls = [];
                for (const child of locs.slice(0, 8)) {
                  try { const cx = await (await get(child, { signal: AbortSignal.timeout(20000) })).text(); urls.push(...[...cx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])); } catch (e) { if (stopErr(e)) throw e; }
                }
                return json({ sitemap: c, type: 'index', childSitemaps: locs, urlCount: urls.length, urls: urls.slice(0, 500) });
              }
              return json({ sitemap: c, type: 'urlset', urlCount: locs.length, urls: locs.slice(0, 500) });
            } catch (e) { if (stopErr(e)) throw e; }
          }
          return 'No sitemap found in robots.txt, /sitemap.xml, /sitemap_index.xml or /wp-sitemap.xml.';
        }),
      T('get_robots_txt', `Read ${root}/robots.txt.`, {}, [], 'read', async () => {
        const r = await get(`${root}/robots.txt`, { signal: AbortSignal.timeout(15000) });
        return r.ok ? clip(await r.text(), 8000) : `robots.txt returned HTTP ${r.status}`;
      }),
      T('pagespeed', 'Run Google PageSpeed Insights (Lighthouse) for a URL: performance score, LCP, CLS, TBT, page weight, real-user Core Web Vitals and the biggest opportunities such as unused CSS/JS.',
        { url: { type: 'string' }, strategy: { type: 'string', enum: ['mobile', 'desktop'] } }, ['url'], 'read', async ({ url, strategy }) => json(await google.pagespeed(url, strategy)))
    ];
  }

  // ---------- WordPress ----------
  function wpTools(s) {
    const get = async (type, id) => wp(s, `/wp/v2/${type}/${Number(id)}`, { query: { context: 'edit' } });
    return [
      T('wp_site_overview', `Basic facts about the WordPress site ${s.url}: name, tagline, SEO plugin in use and what the connected user may do.`, {}, [], 'read', async () => {
        const root = await sitesLib.wpRequest(s, null, '/', { purpose: 'audit' });
        let me = {};
        try { me = await wp(s, '/wp/v2/users/me', { query: { context: 'edit' } }); } catch { /* ignore */ }
        const ns = root.namespaces || [];
        return json({ name: root.name, tagline: root.description, url: root.home, timezone: root.timezone_string,
          seoPlugin: ns.find((n) => /yoast/.test(n)) ? 'Yoast SEO' : ns.find((n) => /rankmath/.test(n)) ? 'Rank Math' : ns.find((n) => /aioseo/.test(n)) ? 'All in One SEO' : 'none detected',
          connectedAs: me.name, roles: me.roles, canEditOthersPosts: !!(me.capabilities && me.capabilities.edit_others_posts), canManagePlugins: !!(me.capabilities && me.capabilities.activate_plugins) });
      }),
      T('wp_list_content', 'List posts or pages with id, title, link, status, last modified date and excerpt.',
        { type: typeProp, status: { type: 'string', description: 'publish, draft, pending, private or any (default publish)' }, search: { type: 'string' }, page: { type: 'number' }, perPage: { type: 'number', description: 'max 100' } },
        ['type'], 'read', async ({ type, status, search, page, perPage }) => {
          const q = { per_page: Math.min(100, Number(perPage) || 50), page: Number(page) || 1, status: status === 'any' ? 'publish,draft,pending,private,future' : status || 'publish', context: 'edit', _fields: 'id,title,link,status,modified,excerpt,slug,featured_media' };
          if (search) q.search = search;
          const rows = await wp(s, `/wp/v2/${type === 'pages' ? 'pages' : 'posts'}`, { query: q });
          return json(rows.map((r) => ({ id: r.id, title: r.title && (r.title.raw ?? r.title.rendered), link: r.link, status: r.status, modified: r.modified, slug: r.slug, hasFeaturedImage: !!r.featured_media, excerpt: clip(strip(r.excerpt && (r.excerpt.raw || r.excerpt.rendered)), 200) })));
        }),
      T('wp_get_content', 'Get one post or page in full: title, content (HTML), excerpt, slug, status, link and the SEO meta description if the SEO plugin exposes it.',
        { type: typeProp, id: { type: 'number' } }, ['type', 'id'], 'read', async ({ type, id }) => {
          const r = await get(type === 'pages' ? 'pages' : 'posts', id);
          return json({ id: r.id, title: r.title && r.title.raw, slug: r.slug, status: r.status, link: r.link, excerpt: r.excerpt && r.excerpt.raw,
            seoDescription: r.yoast_head_json ? r.yoast_head_json.description : undefined, content: clip(r.content && r.content.raw, 30000) });
        }),
      T('wp_list_media_missing_alt', 'List images in the media library that have no alt text.', { page: { type: 'number' } }, [], 'read', async ({ page }) => {
        const rows = await wp(s, '/wp/v2/media', { query: { per_page: 100, page: Number(page) || 1, media_type: 'image', context: 'edit', _fields: 'id,source_url,alt_text,title,post' } });
        return json(rows.filter((m) => !String(m.alt_text || '').trim()).map((m) => ({ id: m.id, url: m.source_url, title: m.title && (m.title.raw || m.title.rendered), attachedToPost: m.post || null })));
      }),
      T('wp_list_plugins', 'List installed plugins with their status and version (needs an Administrator connection).', {}, [], 'read', async () => {
        const rows = await wp(s, '/wp/v2/plugins');
        return json(rows.map((p) => ({ plugin: p.plugin, name: p.name, status: p.status, version: p.version })));
      }),
      T('wp_update_title_excerpt', 'Change the title and/or excerpt of a post or page. Many themes and SEO plugins use the excerpt as the meta description when none is set.',
        { type: typeProp, id: { type: 'number' }, title: { type: 'string' }, excerpt: { type: 'string' } }, ['type', 'id'], 'safe', async ({ type, id, title, excerpt }) => {
          const t = type === 'pages' ? 'pages' : 'posts';
          const cur = await get(t, id);
          const body = {};
          if (title !== undefined) body.title = title;
          if (excerpt !== undefined) body.excerpt = excerpt;
          if (!Object.keys(body).length) throw new Error('Give a new title or excerpt.');
          const r = await wp(s, `/wp/v2/${t}/${Number(id)}`, { method: 'POST', body });
          return { text: `Updated ${t} ${id}: ${r.link}`, before: JSON.stringify({ title: cur.title.raw, excerpt: cur.excerpt.raw }) };
        }, { undo: async ({ type, id }, before) => { const b = JSON.parse(before); const t = type === 'pages' ? 'pages' : 'posts'; await wp(s, `/wp/v2/${t}/${Number(id)}`, { method: 'POST', body: b }); return `Restored title and excerpt of ${t} ${id}.`; } }),
      T('wp_update_content', 'Replace the full HTML content of a post or page (for example to add internal links or fix broken ones). Read it first with wp_get_content and keep everything you are not deliberately changing.',
        { type: typeProp, id: { type: 'number' }, content: { type: 'string' } }, ['type', 'id', 'content'], 'safe', async ({ type, id, content }) => {
          const t = type === 'pages' ? 'pages' : 'posts';
          const cur = await get(t, id);
          if (String(content || '').length < String(cur.content.raw || '').length * 0.5) throw new Error('Refused: the new content is less than half the length of the current content. Change only what is needed.');
          const r = await wp(s, `/wp/v2/${t}/${Number(id)}`, { method: 'POST', body: { content } });
          return { text: `Updated content of ${t} ${id}: ${r.link}`, before: cur.content.raw };
        }, { undo: async ({ type, id }, before) => { const t = type === 'pages' ? 'pages' : 'posts'; await wp(s, `/wp/v2/${t}/${Number(id)}`, { method: 'POST', body: { content: before } }); return `Restored content of ${t} ${id}.`; } }),
      T('wp_set_image_alt', 'Set the alt text of an image in the media library.', { id: { type: 'number' }, alt: { type: 'string' } }, ['id', 'alt'], 'safe', async ({ id, alt }) => {
        const cur = await wp(s, `/wp/v2/media/${Number(id)}`, { query: { context: 'edit' } });
        await wp(s, `/wp/v2/media/${Number(id)}`, { method: 'POST', body: { alt_text: alt } });
        return { text: `Alt text set on image ${id}.`, before: cur.alt_text || '' };
      }, { undo: async ({ id }, before) => { await wp(s, `/wp/v2/media/${Number(id)}`, { method: 'POST', body: { alt_text: before } }); return `Restored alt text of image ${id}.`; } }),
      T('wp_set_status', 'Change the status of a post or page: publish, draft, private or pending. (Deleting is not available.)',
        { type: typeProp, id: { type: 'number' }, status: { type: 'string', enum: ['publish', 'draft', 'private', 'pending'] } }, ['type', 'id', 'status'], 'approval', async ({ type, id, status }) => {
          const t = type === 'pages' ? 'pages' : 'posts';
          const cur = await get(t, id);
          await wp(s, `/wp/v2/${t}/${Number(id)}`, { method: 'POST', body: { status } });
          return { text: `Status of ${t} ${id} changed from ${cur.status} to ${status}.`, before: cur.status };
        }, { undo: async ({ type, id }, before) => { const t = type === 'pages' ? 'pages' : 'posts'; await wp(s, `/wp/v2/${t}/${Number(id)}`, { method: 'POST', body: { status: before } }); return `Restored status of ${t} ${id} to ${before}.`; } }),
      T('wp_set_plugin_status', 'Activate or deactivate an installed plugin (needs an Administrator connection).',
        { plugin: { type: 'string', description: 'Plugin file as listed by wp_list_plugins, e.g. akismet/akismet' }, status: { type: 'string', enum: ['active', 'inactive'] } }, ['plugin', 'status'], 'approval', async ({ plugin, status }) => {
          const cur = (await wp(s, '/wp/v2/plugins')).find((p) => p.plugin === plugin);
          if (!cur) throw new Error(`Plugin ${plugin} not found.`);
          await wp(s, `/wp/v2/plugins/${plugin}`, { method: 'POST', body: { status } });
          return { text: `${cur.name} is now ${status}.`, before: cur.status };
        }, { undo: async ({ plugin }, before) => { await wp(s, `/wp/v2/plugins/${plugin}`, { method: 'POST', body: { status: before } }); return `Restored ${plugin} to ${before}.`; } })
    ];
  }

  // ---------- Google ----------
  function googleTools(s) {
    const g = s.google || {};
    const out = [];
    const dates = { startDate: { type: 'string', description: 'YYYY-MM-DD, default 28 days ago' }, endDate: { type: 'string', description: 'YYYY-MM-DD, default 2 days ago' } };
    if (g.gscSite) {
      out.push(
        T('gsc_search_performance', `Google Search Console clicks, impressions, CTR and average position for ${g.gscSite}, grouped by query, page, device, country or date.`,
          { ...dates, dimensions: { type: 'array', items: { type: 'string', enum: ['query', 'page', 'device', 'country', 'date'] } }, rowLimit: { type: 'number' }, pageContains: { type: 'string' }, queryContains: { type: 'string' } },
          [], 'read', async (a) => json(await google.gscPerformance(g.gscSite, a))),
        T('gsc_inspect_url', 'Google Search Console URL Inspection: whether a URL is indexed, why not, Google-selected canonical and last crawl.', { url: { type: 'string' } }, ['url'], 'read', async ({ url }) => json(await google.gscInspect(g.gscSite, url))),
        T('gsc_sitemaps', 'Sitemaps submitted in Google Search Console with submitted and indexed counts, errors and warnings.', {}, [], 'read', async () => json(await google.gscSitemaps(g.gscSite)))
      );
    }
    if (g.ga4Property) {
      out.push(T('ga4_report', 'Google Analytics 4 report. Common dimensions: pagePath, landingPage, sessionDefaultChannelGroup, sessionSource, deviceCategory, country, date. Common metrics: screenPageViews, sessions, activeUsers, engagementRate, averageSessionDuration, bounceRate, conversions, keyEvents.',
        { ...dates, dimensions: { type: 'array', items: { type: 'string' } }, metrics: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, orderByMetric: { type: 'string' } },
        [], 'read', async (a) => json(await google.ga4Report(g.ga4Property, a))));
    }
    if (g.gtmContainer) {
      out.push(T('gtm_live_container', 'The live Google Tag Manager container: tags (with GA4 measurement IDs), triggers and whether tags are paused.', {}, [], 'read', async () => json(await google.gtmLive(g.gtmContainer))));
    }
    return out;
  }

  // ---------- public ----------
  function sources(job) {
    const s = job.siteId ? site(job.siteId) : null;
    const base = s ? s.url : job.siteUrl ? (/^https?:\/\//.test(job.siteUrl) ? job.siteUrl : `https://${job.siteUrl}`) : null;
    const out = [];
    if (base) out.push({ id: `web:${s ? s.id : base}`, kind: 'web', name: 'Website checker', tools: () => webTools(base) });
    if (s && s.type === 'wordpress' && s.secret) out.push({ id: `wp:${s.id}`, kind: 'wp', name: `WordPress (${s.name})`, tools: () => wpTools(s) });
    if (s && s.google && (s.google.gscSite || s.google.ga4Property || s.google.gtmContainer) && google.configured()) out.push({ id: `google:${s.id}`, kind: 'google', name: 'Google data', tools: () => googleTools(s) });
    return out;
  }

  function available(siteId) {
    return sources({ siteId }).map((x) => ({ kind: x.kind, name: x.name, tools: x.tools().map((t) => ({ name: t.name, risk: t.risk, description: t.description })) }));
  }

  function resolve(sourceId, toolName) {
    const [kind, ...rest] = String(sourceId).split(':');
    const key = rest.join(':');
    const s = site(key);
    let tools = [];
    if (kind === 'web') tools = webTools(s ? s.url : key);
    else if (kind === 'wp' && s) tools = wpTools(s);
    else if (kind === 'google' && s) tools = googleTools(s);
    return tools.find((t) => t.name === toolName) || null;
  }

  return { sources, available, resolve, analyzeHtml };
}

module.exports = { createBuiltins, analyzeHtml };
