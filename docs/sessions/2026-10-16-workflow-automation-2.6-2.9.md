# Session record — workflow automation wave (2.6.0 – 2.9.0)

**Date:** 2026-10-16 · **Owner:** Rustom Codilan

Four automation features for the web-developer + SEO-specialist workflow, each
shipped as its own release. Documentation only.

## 2.6.0 — Content decay auto-refresh (`src/seo.js`)
Weekly (Tuesdays) compares the last 28 days of Search Console page clicks with
the 28 before. Pages that lost clicks (drop ≥ threshold, or a clear position
slip with fewer clicks) are refreshed through the existing revise engine
(`startRevision`) with a brief that updates/expands the page and keeps the URL.
Per-page cooldown; approve or auto; 30-day recovery check (`evaluateRefreshes`).
Config + list under **Rankings → Content refresh**; `seo:checkDecay` IPC;
`contentRefreshes` in state.

## 2.7.0 — Site-wide internal linking (`src/internallinks.js`)
Weekly (Wednesdays) reads all published posts, counts incoming internal links,
finds orphans (0) and thin pages (1), and adds one contextual link to each from
a topically-related post. The anchor is a phrase that already appears verbatim
in the source (validated with `enhance.insertLink` against real content), so
nothing is rewritten; never duplicates an existing link; one incoming link per
target per run. Uses the `wp_add_internal_link` builtin via `queueAction`
(approve/auto, undoable). Config under **Rankings → Internal links**;
`illinks:setConfig` / `illinks:run` IPC; `internalLinkRuns` in state.

## 2.8.0 — Safe-deploy guard (`src/deployguard.js`)
Hooked into the auditor `afterRun`. After a run applies changes to a site, loads
the homepage, key pages and same-site URLs from the run's changes in a headless
browser (`capture`). Flags hard breakage (HTTP ≥ 400, PHP fatal / DB error /
white screen, load failure) and big visual collapse vs the last known-good
screenshot (kept per page on disk under userData/guard). Auto mode rolls the
run's changes back with their built-in undo (`auditor.revert`) and re-checks;
warn mode alerts + files a high-priority task. Skips `revert-` jobs to avoid
recursion. Config under **Maintenance → Safe-deploy guard**; `guard:setConfig`
IPC; `deployChecks` in state.

## 2.9.0 — Competitor & backlink radar (`src/radar.js`)
Weekly (Thursdays) runs a read-only, connector-backed research job
(`auditor.research` over the Ahrefs/Semrush connectors) to read referring
domains, recently lost backlinks, competitors' new top pages, and keywords
competitors outrank the site for. Pure `diffSnapshot` / `mergeSnapshot` compare
against the stored snapshot; alerts on changes and files tasks for lost
backlinks and new competitor content. First run = baseline. Config under
**Rankings → Competitors**; `radar:setConfig` / `radar:run` IPC; `radarRuns` in
state.

## Verification (all four)
Unit tests for each (detection/diff/wiring), obfuscated-require checks, and
`node --check` across changed files. Renderer left un-obfuscated by design.

## Owner follow-ups per release
1. Upload the release's `latest.json` to
   `https://tomdigitalspace.com/rcwriter/latest.json`.
2. Product page download copy stays at **6 parts**.
3. Repo still needs to be made **private** manually (Settings → Danger Zone).

## Still queued (earlier automation picks)
Approve-from-phone (Telegram actionable approvals), client autopilot profile,
gap-to-draft pipeline.
