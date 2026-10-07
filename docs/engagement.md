# Activation, engagement and feedback

> Deep reference, loaded on demand. `AGENTS.md` holds the always-on architecture map,
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
and a QUIET footer ask ("Enjoying…? ★ Rate · Share · Send feedback ✕" — equal siblings, deliberately NO
"enjoying it? yes/no" pre-screen, that's soft review-gating). `layout()` appends it INTO the
column flow (`break-before: column`, sized to one page) AFTER measuring the content alone, so it
fills the final spread's ALREADY-blank page. It is appended ONLY when it fits that spare page —
the pure `OBR._colophonFitsLastSpread(contentColumns, pagesPerSpread)` gate: content must NOT
divide evenly into spreads (an even column count at 2-up would push the colophon onto a fresh
spread with a blank facing page — the "546 words → blank page" report — re-introducing the very
blanks pagination fights; single-page mode has no facing page, so it always fits). When it's
skipped, the engagement chip on close still carries the ask (one channel at a time). Every
article still ends visibly. A free last page ALWAYS gets the back cover: the full one for a
substantial article, a **light** one (`colophonLight`, `.obr-colo-light`: The End and Share — no
stats, no lifetime line, no rating ask, so no ask impression is counted) for a short or one-spread
piece (under 300 words, or one spread), whose ask would come too soon. A piece that fits one spread
measures as a full spread by scrollWidth (the strip is never narrower than the view), so its free
right page is found by `reachedColumns` — the columns its text actually reaches. With no free page,
an inline **end mark** (`ensureEndMarkEl`, `.obr-endmark`) follows the text: "The End" plus Share this
article on a substantial article, the Share link alone on a short one. The link opens the ⋯ menu's
share options (`openShareInPop`), so nothing in the column grows; its click stops at the link, or
the overlay's outside-a-popover click would close the menu it just opened. The mark is removed again
whenever it would spill into a column of its own (that would be the blank page again), and the
`colophon` setting turns both off with the back cover. Single-page mode never has a free page, so
there only a substantial article gets the back cover as a page of its own and a short piece gets
the mark; the reader's "no article here" empty state gets neither. The back cover never
covers text, never auto-navigates, fades in once (reduced-motion: instant). (2) **Engagement chip** (reuses the auto-chip shell CSS): shown
only by `_maybeEngageAsk` on a USER-initiated close (reader or gallery; `suppress:false` paths
never ask), gated by the pure `_shouldAskEngage`: ≥5 opens across ≥2 distinct days, max 2 asks
lifetime ≥90 days apart, skipped entirely once the colophon ask has reached the user (one channel
at a time). **Retirement**: ANY interaction with the colophon ask (Rate/Share/Feedback/✕) sets
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

**Share** (colophon ask, engagement chip, and a permanent "Share with a friend" in the welcome +
options footers) copies ONE ready-to-paste invite, built by `OBR.shareInvite(surface)` in
`settings.js`: a localized line plus `OBR.SITE_URL?ref=share-<surface>` (`end` / `chip` /
`welcome` / `options`). It links to the landing page, not the store, because the landing page
unfurls as a 1200x630 picture in chat apps (`site/index.html` Open Graph tags, `site/img/og.jpg`)
and its Add to Chrome button turns the `ref` into `utm_source=share&utm_medium=<surface>` —
readable in the Web Store dashboard (Analytics > Impressions), the ONLY place a share is counted.
The extension sends nothing; the invite carries only which button made it, never the page being
read (that is what "Share this article" below is for). The in-page surfaces confirm in place for 3s; when the page refuses the async clipboard
(plain http, a site's permissions policy) they show the invite in a selected read-only field
(`OBR._shareFallback`) instead — `clipboardWrite` is deliberately not requested, as a new
permission would hit the Web Store's permission gate for a corner case. The extension pages
always have the clipboard (`OBR.bindShareLink`, `prompt()` as the fallback).

**Share this article** (a permanent button on the colophon, under the stats — a tool, not an ask:
it survives the ask's retirement and retires nothing — and the same item in the toolbar's ⋯ menu,
whose options unfold inside the popover, because the colophon is skipped whenever an article fills
its last spread exactly) shares THE ARTICLE, through our site. Both fill their menu from ONE
builder (`fillShareMenu(menu, done)`), so the two can never offer different options.
`OBR.sharedArticleLink(OBR.shareableArticleUrl(location.href), title)` builds
`openbook.peach-studio.com/read#u=<address>&t=<title>`: tracking tags (`utm_*`, `fbclid`, `gclid`…)
and the page's own fragment are dropped, the title is capped at 200 characters, and both ride after
`#`, which a browser never sends to a server — the site host learns nothing of what is shared. The
button opens a menu — a disclosure IN the colophon's flow, not a positioned popover, so it covers
nothing; it is rebuilt on each open and closed by its button, any choice, Escape (before the
reader's own Escape), turning away from the colophon spread, and every re-render. Its rows:
**Share via…** (`navigator.share`, the OS sheet: Windows, ChromeOS, macOS from Chrome 128 — shown
only where it exists), **Copy link** (else the selected fallback field), **Email** (a `mailto:`),
then one link per `OBR.SHARE_TARGETS` network (`settings.js`): each platform's own public share URL,
taking only the fields that platform honours (Facebook and LinkedIn take the URL alone), the title
wherever one is accepted because every read link unfurls as the same generic card. Regional networks
join by UI language through `OBR.shareTargetsFor` (LINE for ja / zh-TW, Weibo for zh-CN, VK for ru).
Icons are Simple Icons paths (CC0), drawn in `currentColor`. No share-button library: they all look
for their buttons in the main document, which cannot see into the reader's shadow root, and editing
one would break the vendored-code rule; the URL table is the part worth having. Closing the sheet
rejects with `AbortError`, which is an answer, not a failure: it must NOT fall through to copying.
The colophon is a fixed-height page in the column strip, so it carries `overflow: clip` and
`justify-content: safe center`: content taller than the page (the open menu on a narrow, short
window) would otherwise spill into a column the spread count never sees and push The End off the top.
`site/read.html` is the landing page: it shows the title as text under the destination's real domain
(anyone can craft one of these links, so the page must never vouch for the destination), refuses
anything but http(s), and talks to the extension — `externally_connectable` admits only
`https://openbook.peach-studio.com/*`, and `onMessageExternal` in `background.js` answers three
messages from that origin: `obr-ping` → `{ok, autoRead}` (autoRead = the all-sites grant is held,
which IS the opt-in below — read from permission state, never stored), `obr-allow-shared-links` →
the permission page asks for all sites (`reason=shared-links`; no answer is sent back, the worker
dies across the prompt, so the page re-pings), and `obr-open-shared` → only with a grant covering the
article, the worker arms a one-shot listener on the SENDER's tab and the page then replaces itself
with the article (so Back skips the share page); when that tab finishes a load that is not on the
share site, the worker opens the reader as a `'shared'` open (not `'auto'`: the auto chip's Stop has
no rule to stop). All three answer TOP-LEVEL pages only (`sender.frameId === 0`), and read.html does
not talk to the extension from inside a frame: framed by another site, it could otherwise steer the
host tab through the worker. The load listener is one shot: the first non-share-site page the tab
finishes is opened only if it IS the shared article (`sameArticle`: host without `www.`, path without
a trailing slash), and anything else — Back, a typed address, a redirect to another host — disarms
it. It lives only from the hand-off to that load or 60s — a permanent `tabs.onUpdated` would wake the
worker on every navigation in every tab — and because a listener still armed when Chrome evicts the
worker stays registered with Chrome, the worker adds and removes a no-op one at startup, which clears
it. A worker evicted before a very slow page loads leaves the friend pressing Alt+B. Not installed → step 1 Add Open Book (new tab,
store link tagged `utm_medium=article`), step 2 Read it as a book greyed until Open Book is detected,
Just open the article, and "Already have Open Book? Open the article and press Alt+B" (catches
versions that predate the check); installed and opted in → a 3-second countdown straight into
reading mode; installed, not opted in → the page ASKS FIRST (no countdown: it would hurry people past
the one choice that makes every later link seamless): Turn on & read (opt in, then straight into
reading mode once the grant shows up) inside the opt-in card; OUTSIDE it, Just open the article (with
the Alt+B hint — kept out of the card so it cannot read as "reading mode, just this once"), and
Don't ask again, remembered in this origin's localStorage (`obr-shared-optin-declined`), after which the page just
counts down to the article with the Alt+B hint and a small opt-in link. Every exit is
`location.replace`, so Back does not land on the page again. The page reaches an unpacked build through
a developer switch, `localStorage['obr-ext-id']` (only an Open Book build answers this origin, so it
can reach nothing else); a phone, tablet or non-Chromium browser (no `window.chrome`) → the article plus "Open
Book runs in Chrome on a computer", since a store button there is a dead end. The page declares NO
`og:url`: Facebook and LinkedIn point a post at og:url, which would drop the `#…` and with it the
article (pinned in `landing.spec.js`). `site/404.html` is the fallback when the read page itself is
missing (undeployed, renamed): GitHub Pages serves it for `/read` with the fragment intact, and it
goes straight on to the article — only on that path and only to http(s), so every other missing
path stays a 404 and the site never forwards wherever a link says. There is deliberately no
auto-open of the reader: Chrome grants a page to an extension only on the user's own gesture
(icon, shortcut, context menu, omnibox), and a message from a website is not one. A page loaded
before the install cannot reach the new extension, so after "not installed" the page reloads when the
tab becomes visible again — the way back from the store tab is what turns it into the guide.

## Feedback pipeline

**Feedback pipeline** (`site/uninstall.html`, `src/report.html`, `tools/feedback-form/`): the report page and
the **uninstall survey** (opened by `chrome.runtime.setUninstallURL` on uninstall — a static GitHub Pages
page) each build a `[feedback-meta v1]` body and POST it to ONE
shared "feedback collector" Google Form (single field). An `onFeedbackSubmit` Apps Script bridge
(`tools/feedback-form/feedback-form.gs`) emails each submission verbatim to the developer's feedback inbox
(address in `.meta/feedback.json`), so form feedback lands in the same inbox as a `mailto:` report. Reporter
identity travels IN the marker (`reporterEmail`: `null` = anonymous/no-reply for the uninstall survey; the
user's optional email for a repliable report; absent on a mailto → a reply goes to the envelope From).
**The survey's site field.** The extension appends exactly one thing to the survey URL: `#url=<page>`, the
last page the reader was opened on (`background.js`: `uninstallSurveyUrl`, re-stamped by `invokeReader` on
every trigger). The page is cut by `OBR._reportPageUrl` — the SAME origin+pathname rule ⚠ Report uses, so
there is one definition of what an address may carry off the device. It rides the fragment, which never
reaches the server; the survey shows it only for the two site-specific reasons, as a checked, editable
"Report the problem site" box, and sends it as `pageUrl` only on submit with the box on. Incognito and
non-web pages keep the previous stamp, and so does a trigger that passes no `incognito` flag — the
stamp fails closed, firing only on an explicit `incognito: false`. `onInstalled` resets to the bare URL on install and extension update only (a browser update fires
it too, as `chrome_update`, and must not wipe the stamp), so an extension update clears the stamp
until the next read. Disclosed in `site/privacy.html` (Uninstall survey + the on-device list) — keep the
two in step.
**GOTCHA** — Apps Script strings must be ASCII or `\uXXXX`-escaped; a raw em dash/curly quote/CJK mangles to
`â??` mojibake when pasted into the Apps Script editor.

