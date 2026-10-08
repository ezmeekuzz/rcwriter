# RCWriter

A desktop app that writes articles for you on a schedule, using Claude, ChatGPT, Gemini, or any OpenAI-compatible provider. It runs quietly in the system tray for as long as your computer is on.

## What it does

- **Writers** are reusable instruction sets: a persona ("You are…"), a voice and attitude, knowledge (typed in or loaded from files), standing instructions, and a list of topics. Make as many as you need, one per topic, site, or client.
- **Use your ChatGPT subscription or API keys.** Sign in with your ChatGPT Plus, Pro or Business account (through OpenAI's official Codex app), or use API keys for Claude, OpenAI, Gemini, or any OpenAI-compatible provider.
- **Connect your websites.** Connect WordPress sites with one click (you approve RCWriter on your own WordPress login page), or add a webhook for Ghost, Webflow, Wix, Shopify and others through Zapier, Make or n8n. Each writer can save new articles as drafts, submit them for review, or publish immediately, with categories and tags.
- **All models from every provider.** Model lists are pulled live from each provider's API, so anything your key can use appears automatically, including models released after you install the app. You can also type any model ID by hand.
- **Schedules**: once, daily, specific weekdays, or every N hours. Each run can write 1 to 10 articles and can override the topic.
- **Notifications you can schedule**: every schedule has its own list of reminders (default: 20 minutes before). Add as many as you want, such as 1 day, 1 hour, and 5 minutes before. You also get a desktop notification when each article is finished or if it fails. Clicking a "finished" notification opens the article.
- **Runs in the background**: closing the window keeps it in the tray, it can start when you sign in, and it prevents the OS from suspending it. If the computer was asleep when an article was due, it catches up when it wakes (within a window you choose).
- **Articles** are saved as Markdown files (with a small metadata header) in `Documents/RCWriter/<writer name>/`, and you can read, copy, or open them in the app.

## Websites (shared by writers and audits)

**General → Websites** holds every site you work on. Both modules use it.

- **WordPress:** connect once (you approve RCWriter on your own WordPress login page). Writers publish there, and audits can read and edit it.
- **Webhook:** publish to Ghost, Webflow, Wix, Shopify and others through Zapier, Make or n8n.
- **Website (audits only):** any site you want to audit without publishing to it.
- **Google data:** connect Google once, then link each site to its Search Console property, GA4 property and Tag Manager container. Access is read-only.
  - *Service account (recommended for schedules):* create one in Google Cloud, enable the Search Console, Analytics Data, Analytics Admin and Tag Manager APIs, download its JSON key, and add its email as a user on each client's properties. It never signs out.
  - *Your Google account:* create a "Desktop app" OAuth client in Google Cloud and sign in with it. Publish the consent screen so sign-ins don't expire after 7 days.
- **PageSpeed Insights key (optional):** raises Google's limit on speed tests.

## Smarter writing (1.6)

Each writer can now do more around every article, under **Before publishing** and **Where to publish**:

- **Keyword research first:** set the topic order to "Research a keyword first". Before each article, the AI uses Ahrefs or Semrush (and Search Console, if linked) to find a keyword around your topics with real searches and low difficulty, skips anything the site already covers or ranks for (no cannibalisation), and writes for it. Used keywords are remembered. If research fails, the writer falls back to its topics.
- **AI editor check:** a second pass checks facts against the writer's knowledge, the instructions, voice and length, and scores the article out of 10. It can rewrite once to fix what it found. Articles below your minimum score are saved as drafts instead of going live.
- **Featured image with alt text:** a free Pexels stock photo (add a free key in Settings, Images) or an image generated with your OpenAI API key. It's uploaded to WordPress as the featured image with alt text and credit, and saved next to the article file.
- **Schema markup:** Article, FAQ (from the article's FAQ section) and Local business JSON-LD, added to the post. WordPress keeps it when the connected user is an Administrator; RCWriter tells you if WordPress removed it. A `.schema.json` copy is saved next to the article.
- **Links from older posts:** when an article goes live, the AI picks up to 3 related older posts and links a natural phrase in each to the new one, either for you to approve or automatically. Every link is in the Change log with **Undo**. Articles also have a **Link from older posts** button.

## Clients and monitoring (1.6)

- **Clients:** group websites by client under **General → Clients**. The client picker at the top of the sidebar filters writers, schedules, articles, websites, audits, approvals, the change log and reports to one client.
- **Monitoring** (Site audits → Monitoring, or **Monitoring** on a website): uptime checks every 15 minutes to 6 hours (paced like everything else, and repeated once before alerting), SSL certificate expiry and validity (a TLS handshake that loads no page), and a daily Search Console check that alerts you when clicks fall week on week. A traffic drop can **start an audit by itself**, which receives the drop and the pages that lost the most clicks.
- **Chained audits:** "When it finishes, run" starts another audit with the first one's report, for example a technical audit followed by a content refresh.
- **New audit starting points:** refresh posts that are losing traffic, competitor watch, AI search visibility (Ahrefs Brand Radar), and lost backlinks with ready-to-send reclaim emails. Every audit now sees its previous report, so it can say what changed.
- **New built-in tools:** `gsc_compare_periods` (Search Console losers and gainers between two periods) and `wp_add_internal_link` (adds one link around an existing phrase, with undo).

## Reports, tasks and email (1.7)

- **Monthly client SEO reports in Word and PDF** (Workspace → Client reports, or automatically on a day you choose for each client): an executive summary, key results against the previous month (Search Console clicks, impressions, CTR, average position; GA4 sessions, users, engagement and key events, with % change), achievements, work completed (articles, fixes, audits, tasks), search highlights, things to watch and next month's plan. Saved in `Documents\RCWriter\Reports\<client>`.
- **Audit reports in Word and PDF:** any audit report can be saved as Word/PDF, or automatically after every run. A new **Priority findings & dev report** format gives a priority table (Priority, Finding, Evidence, Action, Status) and DONE / IN PROGRESS / TO DO lists.
- **Tasks** (Workspace → Tasks): to-do items from audit reports, requests found in client emails, and your own tasks, with priorities, due dates and one-click **Draft reply** for email tasks.
- **Daily digest:** every morning, a summary of what was written, audited, fixed and broken, approvals waiting and tasks due. Shown on Today, and optionally emailed to you.
- **Gmail** (Settings → Gmail and Google Business Profile, signed in with your own Google Cloud OAuth client): new emails from each client's addresses become tasks; reply drafts and weekly client update drafts are saved in Gmail for you to review and send. RCWriter never sends email to clients by itself.
- **Google Business Profile:** link a location to a website to draft replies to new reviews (good reviews can be answered automatically, the rest wait for approval) and to draft a Google post whenever a new article goes live. Google gives these APIs no quota until it approves your project's access request.
- **Assistant AI** (Settings): the model that writes reports, emails, review replies and posts.

**Writers use site data:** with a WordPress site selected, a writer reads the site's published posts so it doesn't repeat them and links to related ones. With Search Console linked, it aims articles at searches the site already appears for but isn't in the top 3 for yet.

## Site audits

A separate module (sidebar: **Site audits → Audits**) that checks your websites on a schedule using tools you connect, and fixes problems as far as you allow.

- **Built-in tools (no extra connector needed):**
  - *Website checker:* single-page SEO check, crawl of up to 30 pages, broken links, URL status checks, sitemap, robots.txt, and PageSpeed (score, LCP, CLS, page weight, unused CSS/JS, real-user Core Web Vitals).
  - *WordPress:* reads posts, pages, media and plugins. It can edit titles, excerpts, content and image alt text (marked safe), and change post status or activate and deactivate plugins (marked needs approval). It never deletes. Edits save the old value, so **Undo** restores it directly.
  - *Google data:* Search Console performance, URL Inspection and sitemaps, GA4 reports, and the live Tag Manager container.
- **Connections:** add Ahrefs, Semrush or WPVibe with one click, or any other MCP connector by URL. You sign in once in your browser (or paste an API key). RCWriter holds these sign-ins itself; connectors added inside ChatGPT or Claude are not shared with other apps.
- **Tool permissions:** every tool is marked Read-only, Safe to auto-fix, Needs approval or Never use. RCWriter sets this automatically and you can change any of them.
- **Audits:** for each website, choose the tools, what to check (technical SEO, content, rankings, WordPress maintenance, or your own instructions), the AI, and a schedule with reminders.
- **Four autonomy levels**, enforced by RCWriter on every tool call, not just requested of the AI:
  1. **Report only:** reads and reports. Nothing on the site changes.
  2. **Prepare changes for approval:** every change waits in **Approvals** until you approve it.
  3. **Auto-fix safe items:** safe changes apply immediately; the rest wait for approval.
  4. **Full autonomy:** every change applies immediately with no approval. Needs an explicit confirmation when you choose it.
- **Change log:** every change, by the AI or by your approval, with the value before it. **Undo** asks the AI to restore the earlier value, limited to that one change.
- **Reports:** a written report after every run, saved in Documents\RCWriter\Site audits.
- **Safety limits per run:** maximum tool calls, maximum changes (extra changes wait for approval), and a time limit. The AI is told to treat website content as data and ignore instructions found in it.

Audits work with your ChatGPT subscription (through the same Codex sign-in as articles) or with API keys for Claude, OpenAI, Gemini or OpenAI-compatible models that support tool use. Audits use far more AI usage than articles, and each tool's own plan limits apply.

### Staying off hosts' bot lists

Hosts such as SiteGround, Cloudflare and Wordfence challenge or block tools that send many quick requests. Every request RCWriter makes directly to a website (audits, WordPress connections, publishing) goes through one gatekeeper:

- **One request at a time per site, with a pause between requests.** Choose the pace per website on the Websites page: Normal (every 0.8s), Gentle (every 2s, the default) or Very gentle (every 5s). A longer `Crawl-delay` in the site's robots.txt is respected.
- **No repeats:** the same page checked again within 30 minutes is answered from memory.
- **Daily limit** on audit requests per site (600, 250 or 100 depending on the pace).
- **Automatic back-off:** if a host challenges RCWriter or says "too many requests", RCWriter stops contacting that site directly for 6 hours (12, then 24 if it happens again), instead of retrying and making the block longer. Audits keep running with Search Console, PageSpeed, Ahrefs, Semrush and WPVibe data, which don't load the site from your computer. **Resume now** on the Websites page lifts the pause, for example after your host whitelists you.
- **Audits prefer off-site data** and keep direct page checks to about 30 per run.
- **An honest, plain identity:** RCWriter introduces itself as `RCWriter/x.y.z (+https://github.com/ezmeekuzz/rcwriter)`. Some firewalls (SiteGround's among them) refuse the `Mozilla/5.0 (compatible; …)` format that scraper bots use, so RCWriter doesn't use it, and it never pretends to be a browser.

No tool can promise a host will never flag it. The only guarantee is the host exempting your IP address: on SiteGround, ask support to exempt your IP from the Anti-Bot AI for the site.

## Install (Windows)

1. Double-click **RCWriter-Setup-1.5.2.exe**.
2. Windows may show "Windows protected your PC" because the installer isn't code-signed yet. Click **More info**, then **Run anyway**.
3. Choose who to install for and where, then **set your password** on the "Set a password" page (or leave it empty to skip).
4. Click **Install**, then **Finish**. RCWriter opens and asks for your password.

No Node.js, npm or command line is needed. The ChatGPT subscription option downloads OpenAI's Codex for you with one click inside the app.

To uninstall, use Windows Settings, Apps. Your articles and settings are kept in case you reinstall.

Then in the app:

1. **AI providers**: choose how RCWriter talks to the AI.
   - **ChatGPT subscription**: click **Install Codex** (a one-time, roughly 100 MB download from OpenAI's official releases), then **Sign in with ChatGPT** and approve in your browser. Articles use your plan's usage allowance instead of per-token billing.
   - **API key**: paste a key and click Save. The app checks the key and loads that provider's models.
   - Claude: https://console.anthropic.com/settings/keys
   - ChatGPT: https://platform.openai.com/api-keys
   - Gemini: https://aistudio.google.com/apikey
   - OpenAI-compatible: enter a base URL, e.g. `https://openrouter.ai/api/v1`, `https://api.deepseek.com/v1`, `https://api.groq.com/openai/v1`, or `http://localhost:11434/v1` for Ollama.
2. **Websites** (optional): click **Connect a WordPress site**, enter its address, and approve the connection in your browser. If your browser can't hand the approval back to RCWriter, use **Enter details manually** with an application password from your WordPress profile.
3. **Writers → New writer**: fill in who's writing, what it knows, and what to write, pick a provider and model, and choose where to publish.
4. **Schedules → New schedule**: choose the writer, when it runs, and your reminders.

## Why only ChatGPT supports subscription sign-in

| Provider | Subscription sign-in in RCWriter | Why |
|---|---|---|
| ChatGPT (Plus, Pro, Business) | Yes, through OpenAI's Codex app | OpenAI supports using ChatGPT plans in tools outside ChatGPT. |
| Claude (Pro, Max) | No, API key only | Anthropic's terms limit Pro/Max sign-ins to Claude.ai and Claude Code and block other apps. Using them elsewhere can get your account restricted. |
| Gemini (Google AI Pro) | No, API key only | Google ended personal Google AI Pro sign-in for outside tools in June 2026. AI Studio API keys have offered a free tier. |

None of the providers offer an email-based login for other apps. Policies change, so check each provider's current terms.

## Password

- Set it in the installer, on first launch, or later in **Settings, Password**.
- RCWriter locks when you close or minimize the window, when the computer locks or sleeps, and after the idle time you choose. Schedules keep running while it's locked.
- Only a salted scrypt hash of the password is stored. After 5 wrong tries, unlocking pauses briefly.
- **Forgot it?** Click "Forgot password?" on the lock screen. This removes the password and erases saved API keys, website logins and the ChatGPT sign-in, so nobody can use your accounts. Writers, schedules and articles are kept.
- The password stops other people using this computer from opening RCWriter. It doesn't encrypt your article files, which are normal Markdown files in your Documents folder.

## For developers

```bash
npm install
npm start            # run from source
npm run dist:win     # Windows .exe installer (dist/); on Linux/macOS this needs Wine
npm run dist:mac     # macOS .dmg (run on a Mac)
npm run dist:linux   # Linux AppImage
```

"Start when I sign in" only takes effect in the installed app, not when running with `npm start`.

## Good to know

- **The computer must be on and awake** for articles to be written on time. "Keep the app awake" stops the OS from suspending RCWriter, but it can't stop you or your power settings from putting the computer to sleep. Catch-up handles the rest.
- **API usage is billed by each provider** to your own account. Long articles and "thinking" models use more tokens; raise "Max output tokens" if articles get cut off (the app warns you when this happens).
- **ChatGPT plan limits** apply when using your subscription. If you hit them, RCWriter tells you and the article is skipped; it doesn't fall back to paid API usage.
- **WordPress access** uses an application password that you can revoke anytime from your WordPress profile (Users, Profile, Application passwords). Your normal WordPress password is never stored. Application passwords need WordPress 5.6+ and HTTPS.
- **Webhook payloads** contain `title`, `html`, `markdown`, `excerpt`, `categories`, `tags`, `writer`, `topic`, `model`, `words` and `createdAt`. If you set a secret, an `X-RCWriter-Signature: sha256=…` header carries an HMAC of the body.
- **API keys** are encrypted with your operating system's keychain (Windows DPAPI, macOS Keychain, Linux libsecret) and never leave your computer except to call the provider.
- **Your data** is stored in one file: `rcwriter-data.json` in the app's user-data folder (`%APPDATA%/RCWriter` on Windows, `~/Library/Application Support/RCWriter` on macOS, `~/.config/RCWriter` on Linux).
- On Windows, if notifications don't appear, check Settings → System → Notifications and make sure RCWriter (or Electron, in dev mode) is allowed.

## Project layout

```
src/main.js        App window, tray, notifications, background runner
src/scheduler.js   When to run, reminders, catch-up after sleep
src/generator.js   Builds the prompt from a writer and saves the article
src/providers.js   Claude, OpenAI, Gemini and OpenAI-compatible adapters
src/codex.js       ChatGPT subscription through the official Codex app
src/sites.js       WordPress and webhook publishing
src/connectors.js  MCP connections, sign-in and tool permissions
src/audit.js       Site audit runner and autonomy levels
src/gateway.js     Local tool bridge used with the ChatGPT subscription
src/builtin.js     Built-in audit tools: website checker, WordPress, Google data
src/google.js      Search Console, GA4, Tag Manager and PageSpeed
src/hostguard.js   Paces, caches and pauses all direct requests to websites
src/pipeline.js    Keyword research, quality check, images, schema and links around each article
src/enhance.js     Editor check, image, schema and internal-link helpers
src/monitor.js     Uptime, SSL and traffic-drop monitoring
src/reports.js     Word and PDF reports
src/automation.js  Tasks, daily digest, Gmail and Business Profile automations
src/googleuser.js  Your Google account: Gmail and Business Profile
src/lock.js        App password
src/codex-install.js  One-click Codex download
build/installer.nsh   Installer password page
src/store.js       Local settings and encrypted keys
src/preload.js     Safe bridge between the window and the app
src/renderer/      The interface (HTML, CSS, JS)
```

## Ideas for next steps

- Social posts through Buffer and webhooks, and a monthly newsletter draft.
