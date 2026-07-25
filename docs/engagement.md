# Activation, engagement and feedback

> Deep reference, loaded on demand. `CLAUDE.md` holds the always-on architecture map,
> conventions and cross-cutting gotchas; this file holds the detail you only need while
> actually working on this area.

The surfaces that talk TO the user rather than render a page: first-run welcome, the
back-cover colophon and the one-time rating ask, the bundled report page, and where a
submitted report actually goes. All zero-telemetry by design — read the retirement and
capping rules before adding any new ask.

## First-run activation

**First-run activation** (`src/welcome.html`, `background.js` `onInstalled`): on first install the SW opens
a one-screen WELCOME page (pin the icon, the two shortcuts, a "try it" sample article) — NOT the options
page it used to. A settings form is a poor first impression for a tool the user hasn't used yet; welcome
is activation, not configuration.

## Report a problem

**Report a problem** (`settings.js`: `OBR.reportBroken` + `OBR._buildReportMeta` / the pure, testable
`OBR._buildReportMailto`): the ⚠ Report button no longer opens a raw `mailto:` — it relays to the SW
(`obr-open-report`), which opens the **bundled report page** (`src/report.html`; first-party + offline,
diagnostics ride the URL `#fragment` so they never touch a third-party page). There the user writes a
description (+ an OPTIONAL reply email) and sends it two ways: **email** (their mail client) or a **web
form** — the latter is the fix for users with no mail client, where a `mailto:` silently fails. Both build
the SAME `[feedback-meta v1]` body (`pageUrl` = `origin+pathname` only; no telemetry — it would flip the
Web Store data disclosure off "none"). `reportBroken` falls back to a direct `mailto:` when messaging is
unavailable (e.g. the test harness). The extension only OPENS the page; nothing is sent until the user submits.

## Rate/share engagement — the colophon + the one-time chip

**Rate/share engagement — the colophon + the one-time chip** (`reader.js` colophon section,
`settings.js` engagement stores + `_showEngageChip`/`_maybeEngageAsk`/`_shouldAskEngage`). Two
ask surfaces, designed reward-first and capped hard. (1) **Back-cover colophon**: when the reader
reaches the end of a substantial article (≥300 extracted words, ≥2 content spreads), a back-cover
page renders — "The End" + words + accumulated reading time, an optional per-device lifetime line
(from the 3rd finished article; carries its own inline "hide" link → `colophonLifetime:false`),
and a QUIET footer ask ("Enjoying…? ★ Rate · Send feedback ✕" — equal siblings, deliberately NO
"enjoying it? yes/no" pre-screen, that's soft review-gating). `layout()` appends it INTO the
column flow (`break-before: column`, sized to one page) AFTER measuring the content alone, so it
fills the final spread's ALREADY-blank page. It is appended ONLY when it fits that spare page —
the pure `OBR._colophonFitsLastSpread(contentColumns, pagesPerSpread)` gate: content must NOT
divide evenly into spreads (an even column count at 2-up would push the colophon onto a fresh
spread with a blank facing page — the "546 words → blank page" report — re-introducing the very
blanks pagination fights; single-page mode has no facing page, so it always fits). When it's
skipped, the engagement chip on close still carries the ask (one channel at a time). It never
covers text, never auto-navigates, fades in once (reduced-motion: instant). (2) **Engagement chip** (reuses the auto-chip shell CSS): shown
only by `_maybeEngageAsk` on a USER-initiated close (reader or gallery; `suppress:false` paths
never ask), gated by the pure `_shouldAskEngage`: ≥5 opens across ≥2 distinct days, max 2 asks
lifetime ≥90 days apart, skipped entirely once the colophon ask has reached the user (one channel
at a time). **Retirement**: ANY interaction with the colophon ask (Rate/Feedback/✕) sets
`done:true` in SYNCED `obr_engage` — no surface ever asks again, on any device; 10 unacted
impressions retire the colophon ask by itself; the stats page keeps appearing (reward, not ask).
**Reading time** is active-time only: the clock pauses while the tab is hidden, each silent gap
caps at 4 min (`READ_GAP_CAP`), flushed on close/pagehide/visibility-hidden into the article's
`obr_positions` entry (`ms`, `fin` — merge-`update`, never replace-write) and the per-device
`obr_lifetime` local totals. Storage: `obr_lifetime`/`obr_usage` LOCAL (chatty, per-device is
honest), `obr_engage` SYNC (outcomes must follow the user). Zero telemetry — everything stays in
extension storage, consistent with the "collects nothing" disclosure. Rate links point at
`OBR.STORE_REVIEWS_URL` (canonical store URL now lives in settings.js beside the print-QR's).
Passive rate/star links also sit in the welcome + options footers.

## Feedback pipeline

**Feedback pipeline** (`site/uninstall.html`, `src/report.html`, `tools/feedback-form/`): the report page and
the **uninstall survey** (opened by `chrome.runtime.setUninstallURL` on uninstall — a static GitHub Pages
page, param-free so the extension appends nothing) each build a `[feedback-meta v1]` body and POST it to ONE
shared "feedback collector" Google Form (single field). An `onFeedbackSubmit` Apps Script bridge
(`tools/feedback-form/feedback-form.gs`) emails each submission verbatim to the developer's feedback inbox
(address in `.meta/feedback.json`), so form feedback lands in the same inbox as a `mailto:` report. Reporter
identity travels IN the marker (`reporterEmail`: `null` = anonymous/no-reply for the uninstall survey; the
user's optional email for a repliable report; absent on a mailto → a reply goes to the envelope From).
**GOTCHA** — Apps Script strings must be ASCII or `\uXXXX`-escaped; a raw em dash/curly quote/CJK mangles to
`â??` mojibake when pasted into the Apps Script editor.

