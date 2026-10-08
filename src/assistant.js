// "Ask RCWriter": a chat box that can use the whole app (start audits and
// writers, make reports and drafts, add tasks, look up rankings and site
// health, read Google and website data). Playbooks are saved instructions it
// runs on a schedule.

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };

function createAssistant({ store, auditor, builtins, actions, assistantChoice, onChange, notify }) {
  const d = () => store.data;
  const find = (list, ref) => {
    const r = String(ref || '').trim().toLowerCase();
    if (!r) return null;
    return list.find((x) => x.id === ref) || list.find((x) => String(x.name || '').toLowerCase() === r) || list.find((x) => String(x.name || '').toLowerCase().includes(r))
      || list.find((x) => x.url && x.url.toLowerCase().includes(r));
  };
  const need = (x, what) => { if (!x) throw new Error(`I couldn't find that ${what}. Call overview to see the exact names.`); return x; };
  const T = (name, description, properties, required, run) => ({ name, description, inputSchema: { type: 'object', properties, required }, run: async (a) => { const r = await run(a || {}); return typeof r === 'string' ? r : JSON.stringify(r, null, 1); } });

  function tools() {
    const D = d();
    return [
      T('overview', 'Everything RCWriter manages: clients, websites, writers, audits, playbooks and lead campaigns (with names and ids), plus counts of pending approvals and open tasks. Call this first.', {}, [], () => ({
        clients: (D.clients || []).map((c) => ({ id: c.id, name: c.name })),
        websites: D.sites.map((s) => ({ id: s.id, name: s.name, url: s.url, type: s.type, client: ((D.clients || []).find((c) => c.id === s.clientId) || {}).name })),
        writers: D.writers.map((w) => ({ id: w.id, name: w.name, website: (D.sites.find((s) => s.id === w.siteId) || {}).name })),
        audits: D.auditJobs.map((j) => ({ id: j.id, name: j.name, website: j.siteUrl, mode: j.mode })),
        campaigns: (D.campaigns || []).map((c) => ({ id: c.id, name: c.name, status: c.status })),
        pendingApprovals: D.approvals.filter((a) => a.status === 'pending').length,
        openTasks: (D.tasks || []).filter((t) => t.status !== 'done').length,
        today: new Date().toString()
      })),
      T('run_audit', 'Start a saved site audit now. It runs in the background with its own autonomy level and notifies when done.', { audit: { type: 'string', description: 'Audit name or id' }, note: { type: 'string', description: 'Optional extra context for this run' } }, ['audit'], async ({ audit, note }) => {
        const j = need(find(D.auditJobs, audit), 'audit');
        actions.runAudit(j, note || '');
        return `Started "${j.name}".`;
      }),
      T('write_article', 'Have a writer write (and, per its settings, publish) an article now, optionally on a given topic.', { writer: { type: 'string' }, topic: { type: 'string' } }, ['writer'], async ({ writer, topic }) => {
        const w = need(find(D.writers, writer), 'writer');
        actions.runWriter(w.id, topic || '');
        return `${w.name} started writing${topic ? ` about "${topic}"` : ''}.`;
      }),
      T('create_task', 'Add a task to the Tasks list.', { title: { type: 'string' }, client: { type: 'string' }, website: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] }, due: { type: 'string', description: 'YYYY-MM-DD' }, notes: { type: 'string' } }, ['title'], async (a) => {
        const c = a.client ? find(D.clients || [], a.client) : null;
        const s = a.website ? find(D.sites, a.website) : null;
        const t = actions.addTask({ title: a.title, clientId: c ? c.id : '', siteId: s ? s.id : '', priority: a.priority || 'medium', due: a.due || '', notes: a.notes || '', source: 'manual' });
        return t ? `Task added: ${t.title}` : 'An open task with that title already exists.';
      }),
      T('list_tasks', 'Open tasks, optionally for one client.', { client: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'all'] } }, [], async ({ client, status = 'open' }) => {
        const c = client ? find(D.clients || [], client) : null;
        return (D.tasks || []).filter((t) => (!c || t.clientId === c.id) && (status === 'all' || (status === 'done' ? t.status === 'done' : t.status !== 'done'))).slice(0, 60)
          .map((t) => ({ title: t.title, priority: t.priority, due: t.due || null, status: t.status, client: ((D.clients || []).find((x) => x.id === t.clientId) || {}).name, source: t.source }));
      }),
      T('monthly_report', 'Create a client\'s SEO report as Word and PDF.', { client: { type: 'string' }, month: { type: 'string', enum: ['last', 'this'] } }, ['client'], async ({ client, month }) => {
        const c = need(find(D.clients || [], client), 'client');
        const r = await actions.monthlyReport(c.id, month === 'this' ? 0 : -1);
        return `Saved the ${r.period} report for ${c.name}: ${Object.values(r.files).join(', ')}`;
      }),
      T('weekly_update_draft', 'Write this week\'s client update email as a Gmail draft.', { client: { type: 'string' } }, ['client'], async ({ client }) => {
        const c = need(find(D.clients || [], client), 'client');
        await actions.weeklyUpdate(c.id);
        return `The weekly update for ${c.name} is in Gmail drafts.`;
      }),
      T('rankings', 'Tracked keyword positions for a website, with the change over 7 days.', { website: { type: 'string' } }, ['website'], async ({ website }) => actions.rankings(need(find(D.sites, website), 'website').id)),
      T('site_health', 'Uptime, SSL, traffic trend, updates, security, domain and speed status for a website.', { website: { type: 'string' } }, ['website'], async ({ website }) => actions.siteHealth(need(find(D.sites, website), 'website').id)),
      T('site_data', 'Use one read-only data tool for a website: Search Console (gsc_search_performance, gsc_compare_periods, gsc_inspect_url), GA4 (ga4_report), PageSpeed (pagespeed), page checks (check_page), WordPress lists (wp_list_content, wp_get_content) and more. Call with tool "list" to see what this website has.', { website: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' } }, ['website', 'tool'], async ({ website, tool, args }) => {
        const s = need(find(D.sites, website), 'website');
        const avail = builtins.available(s.id);
        if (tool === 'list') return avail.map((b) => ({ source: b.name, tools: b.tools.filter((t) => t.risk === 'read').map((t) => `${t.name}: ${clip(t.description, 120)}`) }));
        const src = avail.find((b) => b.tools.some((t) => t.name === tool && t.risk === 'read'));
        if (!src) throw new Error(`${tool} isn't a read-only tool for ${s.name}. Call with tool "list".`);
        const t = builtins.resolve(`${src.kind}:${s.id}`, tool);
        const r = await t.run(args || {});
        return clip(typeof r === 'string' ? r : r.text, 15000);
      }),
      T('find_leads', 'Search Google for new businesses for a lead campaign and add them to Leads.', { campaign: { type: 'string' } }, ['campaign'], async ({ campaign }) => {
        const c = need(find(D.campaigns || [], campaign), 'campaign');
        const r = await actions.findLeads(c.id);
        return `Found ${r.found}; ${r.added} new leads added to "${c.name}".`;
      }),
      T('pipeline', 'Lead pipeline: counts by stage and the leads that replied or need action.', {}, [], async () => {
        const L = D.leads || [];
        const by = {};
        for (const l of L) by[l.stage] = (by[l.stage] || 0) + 1;
        return { byStage: by, replied: L.filter((l) => l.stage === 'replied').slice(0, 20).map((l) => ({ name: l.name, website: l.website, repliedAt: l.repliedAt })), waitingForApproval: L.filter((l) => l.pendingEmail).length };
      }),
      T('recent_activity', 'The recent activity log (articles, audits, publishing, errors).', { contains: { type: 'string' } }, [], async ({ contains }) => D.activity.filter((a) => !contains || a.msg.toLowerCase().includes(contains.toLowerCase())).slice(0, 40).map((a) => `${a.at.slice(0, 16)} ${a.type}: ${a.msg}`)),
      T('run_digest', 'Build the daily digest now.', {}, [], async () => (await actions.runDigest()).markdown)
    ];
  }

  async function ask(text, { history = true, name = 'Ask RCWriter' } = {}) {
    const c = assistantChoice();
    const prev = history ? (d().assistantChats || []).slice(0, 3).reverse().map((x) => `User: ${x.q}\nYou: ${clip(x.a, 800)}`).join('\n\n') : '';
    const system = `You are RCWriter's assistant for ${d().settings.senderName || 'the owner'}, a freelance SEO specialist, web developer and lead generation specialist. You act through RCWriter's tools: start audits and writers, create reports, drafts and tasks, look up rankings, site health and Google data, and manage leads. Use real data from the tools; never guess numbers. Changes to websites only happen through saved audits, which follow their own approval settings. When something can't be done with the tools, say so plainly. Today is ${new Date().toDateString()}.`;
    const task = `${prev ? `Earlier in this conversation:\n${prev}\n\n` : ''}Request: ${text}\n\nDo it now with the tools, then reply briefly in Markdown: what you did or found, with the key numbers.`;
    const started = Date.now();
    const r = await auditor.research({ name, siteId: '', siteUrl: '', connectorIds: [], builtinKinds: [], provider: c.provider, model: c.model, system, task, maxToolCalls: 25, maxMinutes: 15, extraTools: tools(), requireTools: false });
    const rec = { id: store.uid(), at: new Date().toISOString(), q: text, a: r.text || '(no answer)', toolCalls: r.toolCalls, seconds: Math.round((Date.now() - started) / 1000) };
    if (history) d().assistantChats = [rec, ...(d().assistantChats || [])].slice(0, 50);
    store.save();
    onChange();
    return rec;
  }

  async function runPlaybook(pb) {
    const rec = await ask(`Carry out this playbook, step by step, in order:\n${pb.steps}`, { history: false, name: `Playbook: ${pb.name}` });
    pb.lastRunAt = rec.at;
    pb.lastResult = rec.a;
    d().playbookRuns = [{ id: rec.id, playbookId: pb.id, name: pb.name, at: rec.at, result: rec.a }, ...(d().playbookRuns || [])].slice(0, 100);
    store.log('info', `Playbook "${pb.name}" ran.`);
    notify(`Playbook finished: ${pb.name}`, clip(rec.a.replace(/[#*_`]/g, ''), 220), { view: 'playbooks' });
    store.save();
    onChange();
    return rec;
  }

  return { ask, runPlaybook, tools };
}

module.exports = { createAssistant };
