# Open Book Reader — project guide

> ## ⚠️ RULE #1 — this is a PUBLIC open-source repo. Never commit anything personal or publishing-sensitive to tracked files.
> That means: real/personal emails, the owning Google account, OAuth client IDs/secrets, refresh
> tokens, Web Store API credentials, publisher/developer IDs, signing keys, or analytics/metrics
> dumps. It ALSO covers the maintainer's **private ops / tooling** — names of personal `~/.claude`
> skills or slash commands (e.g. a feedback-triage command), your internal issue-triage workflow, or
> how you personally process reports. These are not secrets, but they don't belong in a public repo.
> Such things live ONLY in gitignored paths (`.env.chrome-webstore`, `.meta`, `metrics/`) or your
> private `~/.claude/` config — never in `CLAUDE.md`, `README.md`, `SECURITY.md`, `store/`, `src/`,
> tests, or commit messages. (`.meta` here is a **gitignored symlink** to off-repo private storage —
> that's what gives its contents a backup without exposing them; never commit the link, name its
> target in a tracked file, or `git add` it.) In tracked files describe features **generically** ("emails feedback to
> the developer's inbox", "a machine-readable marker") — never reference private tooling by name. The
> sole deliberate public contact is the in-app feedback address
> `studio.peach.go+open-book-reader@gmail.com` (a project alias, by design). **Scan every diff for
> personal/credential leaks AND private-ops references before committing.**

Chrome MV3 extension, two reading modes: a two-page open-book **text** reader (keyboard
page-flipping) and an **image-gallery** mode (a **Wall** masonry grid or an **Ordered** row-major
layout for sequential images, + lightbox). Reading is fully local —
no data collected, nothing sent to the developer. The one network case: when the user explicitly
downloads gallery images (needs the OPTIONAL `downloads` permission plus host access to the sites
those images live on — requested on first use, not held at install — so the service worker can fetch
image bytes cross-origin to build a ZIP).

Zero-dependency, zero-build: Chrome loads `manifest.json` + `src/` + `icons/` directly. Edit files,
reload the unpacked extension. (`package.json`/`scripts/` are release tooling only — never bundled.)

## Architecture

On-demand injection — nothing runs on a page until the user invokes it (toolbar click / `Alt+B`
text / `Alt+Shift+B` images). The one deliberate exception: sites where the user explicitly
enabled per-site **auto-open** (its registered sentinel is the only pre-gesture code; see below).

```
manifest.json        MV3: action + 2 commands + minimal perms (activeTab, scripting, storage, contextMenus)
src/background.js    service worker — the only always-loaded script; injects the engine on gesture
src/content/
  settings.js        shared globalThis.OBR namespace + DEFAULTS + load/saveSettings (storage.sync)
  readability.js     VENDORED Mozilla Readability (Apache-2.0) — do not edit; see READABILITY-LICENSE.md
  reader.style.js    reader stylesheet as a JS string (OBR._readerCSS) — injected before reader.js
  qrcode.js          VENDORED qrcode-generator (MIT) — do not edit; the print-branding QR; see QRCODE-LICENSE.md
  reader.js          TEXT mode: extract → render (Shadow DOM) → paginate (CSS columns) → navigate → print/PDF
  zip.js             minimal ZIP writer (OBR._buildZip) — used by the gallery's "Download as ZIP"
  gallery.js         IMAGE mode: collect images → Wall masonry / Ordered rows + lightbox (Shadow DOM)
  sentinel.js        AUTO-OPEN sentinel — the ONLY pre-gesture code, and only on sites the user
                     enabled auto-open for (registered by the SW; see the Auto-open section)
src/options/         options page (reuses settings.js)
src/welcome.html     first-run activation page — onInstalled opens it (pin icon, shortcuts, sample article)
src/report.html      ⚠ Report page (bundled, offline) — email OR a web form; opened via the SW relay
src/permission.html  optional-permission request page (paired permission.js) — SW opens it on first
                     download so the user's click can call chrome.permissions.request
icons/               16/32/48/128
site/                landing + privacy + uninstall survey (GitHub Pages; NOT shipped in the extension)
tools/feedback-form/ Google Apps Script backend: the shared feedback collector form + bridge (NOT shipped)
```

**Injection flow** (`background.js`): on click/command, `executeScript` probes `OBR._engineLoaded`;
if absent, injects the files in order (settings, readability, reader.style, reader, zip, gallery —
settings defines the namespace, reader.style supplies `OBR._readerCSS`, reader needs
`DEFAULTS`+`Readability`, zip supplies `OBR._buildZip` for the gallery's ZIP download). Then dispatches: keyboard commands call the
explicit toggle (`OBR.toggle` / `OBR.toggleGallery`); the **toolbar icon** calls `OBR._autoToggle`,
which closes any open mode or auto-picks — gallery only when image-heavy (`_imageCount() >=
autoGalleryMin`, default 10) AND not a real article (`_articleWordCount() < autoTextMinWords`,
default 200), so a substantial article always wins. Only the icon auto-picks; shortcuts honor their
named mode. The prose stats are NOT Readability — `OBR._proseStats()` (in `settings.js`, shared with
the sentinel; `OBR._articleWordCount` is its long-standing alias) counts words in prose leaf blocks
(`<p>`/`<blockquote>`/`<li>`, ≥20 words each, CJK-aware) off the live DOM, so it's cheap and robust.

**Two modes, one namespace**: `reader.js` → `OBR.open/close/toggle` (`#obr-host`); `gallery.js` →
`OBR.openGallery/closeGallery/toggleGallery` (`#obr-gallery-host`). Each is a separate open Shadow
DOM; opening one closes the other; in-overlay buttons switch (🖼 in reader, 📖 in gallery).

**Auto-open — per-site, opt-in, strict** (`sentinel.js` + `background.js`; full spec:
`docs/auto-open-spec.md`). A `siteRules` entry may carry `auto: true`: the SW then keeps ONE
registered content script (`syncSentinelRegistration()`, id `obr-sentinel`, `js:
[settings.js, sentinel.js]`, `persistAcrossSessions`, matches = union of `originsForRule()` over
auto rules filtered by `permissions.contains`) so content pages on that site (forum topics, manga
chapters) open with zero clicks while list/search pages stay untouched. The sentinel runs a
**strict-bias ladder** on every probe of a settle window (document_idle + ~1s/2.5s/5s, re-armed on
SPA URL change via popstate/hashchange + a MutationObserver href compare): (0) suppression set +
visibility + no-live-overlay check → (1) `matchSiteRuleEx` must return a rule with `auto:true` →
(2) JSON-LD **list-type veto** (`CollectionPage`/`ItemList`/`SearchResultsPage`/`ProfilePage`,
TOP-LEVEL nodes only — types nested under `itemListElement`/`item` never count, or Google's
carousel markup on category pages would neuter the veto; exact `@type` equality only, else
`BreadcrumbList` — schema.org's ItemList subtype on every news article — vetoes the web; an
article-ish top-level type alongside suspends the veto but NEVER lowers thresholds; `og:type` has
no role) → (3) content gate (text: `_proseStats().words >= autoTextMinWords` AND one block `>=
autoAnchorWords` — the anchor is what rejects an index of long topic titles; images: ≥
`autoGalleryMin` `<img>`s with decoded size OR lazy-evidence + layout box ≥ 120px — lazy manga
pages have decoded nothing at probe time). Pass → `obr-auto-open` message → the SW **re-validates
against fresh settings** (never trusts page state) → `invokeReader(…, {auto:true})` →
`OBR.open({trigger:'auto'})` + the "Auto-opened" chip (`OBR._showAutoChip`, its own shadow host;
Stop clears only the `auto` flag via `OBR.setRuleAuto`). A **user-initiated** `close()` (Esc/✕/
toolbar) records `origin+pathname+search` (query matters: phpBB routes every topic through one
pathname) into the shared in-page `OBR._autoSuppressed` set; internal closes (mode switch, cross-
close) pass `{suppress:false}`. **Permissions: zero manifest delta** — per-origin
`permissions.request` subsets of the already-optional `<all_urls>`; `originsForRule` → `[]` means
"can't auto-open" (load-bearing: one invalid pattern rejects the whole registration; valid-but-
ungranted patterns register fine and silently never inject). The enable flow (context-menu
`obr-rule-auto` → permission popup with `reason=auto-open`, or the options checkbox) also
`executeScript`s the sentinel into the CURRENT tab — registration only affects future document
loads, the SPA gap — and re-arms with a one-shot flag: a qualifying page opens immediately, a
non-qualifying one (enabled from a list page) shows an "Auto-open is on" confirmation chip instead
of wrongly opening.

**Rendering** (`reader.js`): Readability parses a `document.cloneNode(true)`; output renders into an
open Shadow DOM styled via Constructable Stylesheets (`adoptedStyleSheets`) so strict-CSP sites can't
block layout. Pagination = CSS multi-column: `.obr-pages` is transformed horizontally, "pages" are
columns, a "spread" is N columns-per-view (`columns`: 2/3/4, or 1 below `singlePageBelow`); the
center spine shows only for even N. The ⊞ topbar button cycles 2→3→4.

**Page-turn animation** (`reader.js`: `flip` → `bookFlip` / `curlFlip` / `endActiveFlip`, setting
`pageTurn`: `curl`(default) | `book` | `slide` | `off`): the 3D turns are **additive overlays**, never a
3D path for the real strip. On flip, the real `.obr-pages` is **snapped straight to the destination**
(`applySpread()`), so `currentSpread`/`translateX`/`indicator`/progress/persist end up identical to the
plain slide *synchronously* (this is what keeps the sync-read tests green) — then a transient
`.obr-flip-layer` of **cloned column slices** animates on top. `book` = a rigid leaf rotating about the
spine; `curl` = the leaf sliced into a nested chain of vertical strips that each rotate a little more
(a soft paper bend). `endActiveFlip()` removes the overlay on finish AND is called at the top of
`layout()` and in Home/End/`close()`, so any relayout/close aborts an in-flight turn and snaps to the
(already-correct) end — re-entrancy is fast-forward, guarded by `activeFlip.layer === layer` on the WAAPI
`finished` callback. Only runs for **even** columns-per-spread (needs a center spine); odd/single-page/
reduced-motion/`slide`/`off` take the plain translateX path. **GOTCHA — the turning leaf must be sized to
the full PAPER PAGE (text column + the paper's white margins), not the viewport text area**, or it renders
visibly smaller than the laid page from the first frame; `pageGeom()` computes the page-relative spine /
page width / margins and every panel (`makePagesClone(tx, ty)` with the `padY` margin offset) is built
from it. **GOTCHA (curl) — the bow must relax to FLAT by edge-on, keep its net free-edge rotation
(leaf angle + cumulative bow) under ~90°, and live only in the half where the strips face the reader**
(forward turn: offsets 0–0.5; backward: 0.5–1, since it rotates -180->0). Otherwise heavily-bent
free-edge strips swing past edge-on while the page still faces you, get back-culled, and the source page
bleeds over the destination back face — a "two pages in the middle" double-image. The leaf uses
`ease-in-out` so edge-on lands predictably at offset 0.5. Tunable curl look: `CURL_STRIPS` / `CURL_BEND` / `CURL_PEAK` / `CURL_DURATION` / `CURL_OVERLAP`
(the last widens each strip 1px so neighbours overlap and hide sub-pixel seams). Reworking this is
**transform-heavy and easy to get subtly wrong — verify with a real-Chromium screenshot capture, and
MEASURE element rects (`offsetWidth`/`getBoundingClientRect`) before blaming a transform**.

**Print / Save as PDF** (`reader.js`: `OBR.printReader` + the pure, testable `OBR._buildPrintDoc`): the
🖨 topbar button (and the `P` key) reuse the article Readability already parsed (`lastArticle`, captured
in `open()`) to build a clean, flat, **vertically-flowing** document and hand it to the browser's print
dialog — which is also where "Save as PDF" lives, so print and PDF are one feature, no library. The
print doc is always a white paper theme (honors font family + line-height, but NOT the screen px size or
dark/sepia theme — paper wants white) and deliberately drops ALL `column-*`/`translateX`/`overflow`
machinery so the browser paginates onto paper instead of printing one clipped spread. It renders into an
**off-screen** iframe written via `about:blank` + `document.write` — NOT `srcdoc`, because `about:srcdoc`
is `frame-src`-blocked on strict-CSP sites (GitHub, many news sites) → blank print; the CSS is also
applied via `adoptedStyleSheets` to dodge strict `style-src`. Fully local, **no new permission**; the
`<title>` becomes the default PDF filename; a footer shows the full source URL unless the
`printSourceUrl` setting is turned off (Options page). A second, optional **branding footer**
(`printBranding`, default on) appends a small "Open Book Reader" line + a **QR code to the Chrome
Web Store listing** (`STORE_URL` — the same public URL as the README / landing "Add to Chrome"
button, so no new exposure) so a shared PDF sends readers to install — a growth hook, still fully
local (no new permission). The QR is rendered by `OBR._qrSvg(text)` (pure → an inline SVG of dark
modules, no canvas/data-URL, prints crisp) using the **vendored** `qrcode.js` (qrcode-generator,
MIT — injected before `reader.js`; pure array math, CSP-safe). `_buildPrintDoc` stays pure:
`printReader` passes it a `brand` object (name + a display domain + pre-rendered `qrSvg`).

**Reading progress is a FRACTION, never a spread index** (`reader.js` + `settings.js`). Re-pagination
(font / columns / width) changes how many columns an article splits into, so position is stored as
`(currentSpread * pagesPerSpread) / totalColumns` and `layout()` re-anchors it: font/column changes
pass an explicit `anchorFraction`; **resume** loads the saved fraction into `restoreFraction` and
re-applies it through the late-image settle window until the first user nav clears it. Per-article
positions persist to `chrome.storage.LOCAL` (NOT sync — per-device, can be many, mustn't burn the 8KB
sync quota) as one bounded, LRU-pruned map `obr_positions` keyed by `origin+pathname`. No new
permission — `storage` already covers `storage.local`.

**Content override — when extraction picks the WRONG block** (`reader.js`, plus pick storage in
`settings.js`). Readability is a guesser; the manual override has three escalating layers, all
zero-new-permission. (1) **Selection** — if text is selected when the reader opens (and the
`readSelection` setting is on, default), read EXACTLY that selection: `extractFromSelection` wraps
`range.cloneContents()` and runs it through the scoped path. (2) **Element picker** — the ⌖ Pick
toolbar button (and the "Wrong content?" hint banner) starts `startPicker()`: a uBlock-style hover-to-
highlight over the REAL page in a SEPARATE shadow host (`#obr-pick-host`), with the reader hidden and
page scroll unlocked (the same toggles `open()`/`close()` and the gallery's `hydratePage` use); a
click re-renders in place via `endPicker(node)` → `extractFromNode`. The reader keydown handler gates
on `pickerActive` so the picker owns Escape/arrows while it's up. The "Wrong content?" banner does NOT
auto-pop on every whole-page open — only when the extraction looks **suspect** (`wholeExtractionSuspect`:
it failed/returned the placeholder, OR — on a page with **≥200 prose words** (`proseWordCount`) — the
extracted text totals **< half** that prose, the "grabbed a sidebar / teaser / truncated" cases). A
confident or same-size-wrong parse stays quiet; the permanent ⌖ Pick toolbar button is the
always-available affordance, and an explicit "Use full page" (`reExtractWholePage`) clears the suspect
flag so it won't second-guess the user's choice. It's a heuristic — a short post on a comment-heavy page
can false-positive (acceptable: non-blocking hint, ⌖ Pick always there). (3) **Saved pick** — "Save for this
site" stores a CSS selector per host in `chrome.storage.SYNC` (`obr_picks`, bounded/LRU to `PICKS_MAX`,
follows the user across devices like the site mode-rules). `OBR._cssPathFor` builds the selector
preferring the SHORTEST readable+robust anchor (unique id → lone `<main>`/`<article>` → `[role]` →
semantic/stable class, by `rankClasses`) and only falls back to a brittle `nth-of-type` `structuralPath`
when nothing readable is unique — so a saved pick tends to survive markup changes and keep matching the
site's other pages. `open()` resolves it (when there's no live selection) via `extractFromSelector`,
which uses `querySelectorAll`: 0 matches → fall through to whole page (stale selector), 1 → that block,
N>1 → all matches MERGED — so a multi-block selector like `.intro, .post-body` reads every region as
one document (this is what makes editing flexible without a multi-select picker). "Use full page" /
"Clear pick" escape. The Options page lists saved picks (`#picks`, via `OBR.loadPicks`/`OBR.clearPick`)
with an **editable CSS-selector field** (auto-save like every other setting: live ✓/✗ syntax check,
valid edits re-save via `OBR.savePick`; **Esc** cancels an in-progress edit, and a per-row **↶ Revert**
— shown only when changed — restores the selector from when the page opened) and per-row remove;
"Reset to defaults" clears them too. The reader/gallery **⚙ pass the current host** to
`OBR.openOptions(host)`; the SW **stashes the host in `chrome.storage.session` then calls
`openOptionsPage()`** (so an already-open options tab is FOCUSED, not duplicated — we can't dedupe via
`tabs.query` without the forbidden `tabs` perm) and `options.js` consumes the stash on load + re-scopes
live via `storage.onChanged`, which **scopes the site-rules + saved-picks lists to that one site** (a
"Show all" chip clears it; global settings stay visible) — a context deep-link, not a search box. (A
direct `options.html?site=<host>` URL still scopes too, for tests / hand-built links.) Precedence: **selection ▶ saved pick ▶ whole
page**. The shared core
is `parseBaseDoc(documentClone)` (whole page) and `scopedBaseDoc(el)` (full-doc clone whose body is a
CLONE of `el`, so baseURI/relative-URL resolution survives and the live page is never mutated), with
`rawFallback(el)` (the node's own script-stripped HTML) when Readability rejects a small root. Tests:
`tests/fixtures/wrong-content.html` (a genuine `#real-article` vs a larger `#decoy`) drives the
selection / picker / saved-pick specs in `reader.spec.js`.

**Lazy / progressive images** (`gallery.js`): collection is placeholder-aware — an `<img>` showing
only a placeholder with a `data-*` lazy URL contributes the lazy URL and skips the size filter
(`eachGalleryImg`, shared by `collect()` / `imageCount()`). A `MutationObserver` + delayed re-collects
live-merge later images (`mergeNewImages`). Since the gallery scroll-locks the page, its lazy loaders
won't fire, so `hydratePage()` scrolls the *real* page in small dwelling steps to trigger native
`loading=lazy` / IntersectionObserver / virtualized rows — on demand (progressive near the grid end,
gated by `galleryAutoLoad`) or fully via **⟳ Load all** (`OBR._galleryRescan`). Bounded against
infinite scroll; restores the user's scroll on `close()`. Demo: `tests/fixtures/lazy-demo.html`.

**Two gallery layouts — Wall (masonry) + Ordered (row-major), toggled in the toolbar** (runtime
`ordered` flag; `relayoutActive` dispatches; `setLayout` switches + anchors the reading spot).
**Wall** is JS masonry, NOT CSS multi-column (`buildColumns`/`placeTile`/`layoutAll`): a flex row of
`.col` divs, each tile appended to the currently-shortest column (estimated by aspect ratio) — so
incrementally-merged images never re-flow already-placed tiles (CSS `column-*` rebalances on every
append, scrambling reading order). Great for an unordered pile, but shortest-column packing SCRAMBLES
sequence. **Ordered** fixes that for manga/comics/webtoons/step-by-step shots
(`layoutOrdered`/`justifyRow`/`appendOrderedTiles`): stacked `.rows` filled left→right / top→bottom, so
image `i` is always in row `floor(i/N)` at position `i%N` — reading order == visual order, and appending
only re-justifies the last touched row (**same no-reflow property, for free** — row-major append never
moves an earlier tile). Rows are **justified** (tiles scaled to a shared per-row height, aspect
preserved, no crop; unknown-size lazy images use `ORD_FALLBACK_ASPECT` and re-justify their row on
decode); at **1 column** it's a centered, width-capped (`STRIP_MAX`) reading **strip** — auto-scroll
turns it into a hands-free webtoon reader. **The Size slider picks a column COUNT, not a px width**
(`columnCount`/`maxCols`/`syncSizeSlider`, layout-aware: Wall spans 2..max via `galleryColumns`, Ordered
1..max via `galleryOrderedCols`): inverted (fuller bar = larger = fewer columns), clamped to `maxCols`
(what fits at `MIN_TILE` px). **Layout + column count are remembered per-site** (`obr_gallery` map in
`storage.sync`, mirrors `obr_picks` — bounded/LRU; `OBR.loadGalleryPref`/`saveGalleryPref`); Wall is the
default, a host opens Ordered only if it was left that way. Reworking the justify math is layout-heavy —
**verify with a real-Chromium screenshot and MEASURE tile rects** (`getBoundingClientRect`).

**Lightbox = paged reader** (already sequential): click any tile → prev/next, an `N / total` counter, a
thumbnail filmstrip, a timed slideshow. The **⟷ Fit width** toggle (`F` key, `galleryFitWidth`, persisted
+ options checkbox) fills a tall page to the WIDTH and scrolls it — for reading a single manga/comic/scan
page — instead of shrinking the whole page to fit; the `.lb.lb-fit` class switches the chrome to
`position:fixed` so it stays pinned while the image scrolls under it.

**Image filter — hide avatars / repeated noise** (`gallery.js` + `settings.js` `obr_hidden`). Forums
flood the gallery with profile pics — a DIFFERENT URL per user, so dedup can't merge them and they
clear the 80px min-size filter. Two zero-new-permission layers: (1) a **high-precision avatar
auto-filter** (`isAvatarish`, `settings.galleryHideAvatars`, default on) drops avatars/emoji/badges,
matched on the element's avatar/gravatar/emoji **class/id/alt/src token** OR a **profile-link wrapper
around a small near-square image** — deliberately NOT size-based (album art / product shots are small
squares too). It runs inside `eachGalleryImg`, so `collect()` AND the badge `imageCount()` exclude the
same set — auto-filtered images are TAGGED, never silently vanished: they ride the same "N hidden"
count/reveal, and Unhide on one stores a per-image **`+<target>` allow entry** that overrides the
auto-filter from then on (the false-positive recovery path). (2) a manual **⊘ Hide** control on each
tile → a scope popover. The ELEMENT scope **"Images in this spot"** LEADS and carries the
recommendation — it's what discriminates when URLs can't (content and avatars on the same CDN path):
a CSS selector stored as a `css:`-prefixed entry (`selectorScopeFor`: the image's own semantic class →
a stable ancestor class + ` img` → `OBR._cssPathFor` unique-path fallback, which needs `reader.js` —
always loaded before `gallery.js` in the real injection order, guarded for the gallery-only harness),
matched element-level via `img.matches()` in `eachGalleryImg` (`<img>` only; background/`<source>`
entries stay URL-filtered). Below it, three URL scopes (`OBR.hidePatternsFor`: this image / its
folder — snapped to a known avatar path token when present / its whole host) — **absent for
data:/blob: images** (their "pathname" is the whole base64 payload, a sync-quota poison; the element
scope is their tool). **Hovering a popover option live-marks the tiles that scope would hide**
(`previewHide`, `.hide-preview`), and the element option shows its live match count — blast radius
visible before choosing. Everything is stored **per-site** in the `obr_hidden` sync map, bounded by
host count AND serialized bytes (`HIDDEN_MAX_BYTES`, mirrors `obr_picks`; plus a per-pattern length
cap); entry prefixes: none = URL glob (matched by the shared `globToRegExp` over `host+pathname`),
`css:` = element selector, `+` = per-image allow — `urlMatchesHidden` skips the prefixed kinds.
`collect()` drops matches (tagging them `hidden` while peeking); a **"N hidden · Show"** toolbar
toggle (kept fresh by `mergeNewImages` too, for lazy-hydrating pages) reveals them dimmed with an
Unhide button (manual hides: drops the matching pattern, re-testing `css:` entries against the live
element; auto-hides: stores the `+` allow), plus a one-tap **Undo** on the last hide. The Options page lists + removes
hidden patterns per site (scoped like saved picks) and carries the avatar-toggle checkbox. Only the
gallery is filtered; the reader is untouched.

**Gallery downloads** (the only network feature): content scripts can't call `chrome.downloads` or
fetch cross-origin, so `gallery.js` messages `background.js` — `obr-download-one` →
`chrome.downloads.download` (no host perm needed); `obr-fetch-bytes` → SW `fetch` (needs
`host_permissions`, sent with `credentials:'include'` so login-gated images resolve) returns base64,
and the gallery builds the ZIP in-page (`OBR._buildZip`) and saves it via a blob `<a download>`. Hence
`downloads` + `<all_urls>` as **optional** permissions (`optional_permissions` / `optional_host_permissions`),
requested on first use — not held at install. **What a ZIP actually REQUESTS is per-origin, not
`<all_urls>`**: `permsFor(msg)` derives `*://<hostname>/*` per image URL from `msg.urls`, so downloading an album
grants only the CDNs it came from. NOT scheme-pinned (an http image 301s to https and the SW fetch
follows the redirect out of its own grant) and port-stripped (port-less matches any port, and it
keeps the shape identical to `originsForRule`) — note `permissions.contains` does NOT reject a
ported pattern, so the strip is about consistency, not API validity. `<all_urls>` stays in the manifest as the declared maximum (images can live anywhere)
and remains reachable as a deliberate "Allow all sites instead" opt-out in `permission.html` — never
the default. This is what keeps the options **Site access** card meaningful: a broad grant subsumes
every per-site row, so silently escalating to it made the card useless.

**First-run activation** (`src/welcome.html`, `background.js` `onInstalled`): on first install the SW opens
a one-screen WELCOME page (pin the icon, the two shortcuts, a "try it" sample article) — NOT the options
page it used to. A settings form is a poor first impression for a tool the user hasn't used yet; welcome
is activation, not configuration.

**Report a problem** (`settings.js`: `OBR.reportBroken` + `OBR._buildReportMeta` / the pure, testable
`OBR._buildReportMailto`): the ⚠ Report button no longer opens a raw `mailto:` — it relays to the SW
(`obr-open-report`), which opens the **bundled report page** (`src/report.html`; first-party + offline,
diagnostics ride the URL `#fragment` so they never touch a third-party page). There the user writes a
description (+ an OPTIONAL reply email) and sends it two ways: **email** (their mail client) or a **web
form** — the latter is the fix for users with no mail client, where a `mailto:` silently fails. Both build
the SAME `[feedback-meta v1]` body (`pageUrl` = `origin+pathname` only; no telemetry — it would flip the
Web Store data disclosure off "none"). `reportBroken` falls back to a direct `mailto:` when messaging is
unavailable (e.g. the test harness). The extension only OPENS the page; nothing is sent until the user submits.

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

## Conventions

- Plain ES (IIFE modules), no build, no deps, no bundler.
- All shared state hangs off `globalThis.OBR` so injected files and the options page share one namespace.
- Settings live in `chrome.storage.sync` under `obr_settings`, merged over `OBR.DEFAULTS` (`settings.js`).
  New setting → add to `DEFAULTS`, and (if user-tunable) to `options.html`/`options.js`.
- Double-injection guards: `reader.js` via `OBR._engineLoaded`, `gallery.js` via
  `OBR._galleryLoaded`, `sentinel.js` via `OBR._sentinelLoaded` (its re-arm entry point for the
  enable flow is `OBR._sentinelArm` — the IIFE won't re-run on a re-enable).

## Dev workflow

1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. On any article, click the toolbar icon or press `Alt+B`.
3. After editing: reload the extension card, **then also reload the web page**. `background.js`
   changes need the extension reload; content-script changes (`settings.js`/`reader.js`/`gallery.js`)
   need a page reload — reloading the extension does NOT re-inject into open tabs, and the
   `_engineLoaded` guard skips re-injection. Stale content scripts are the usual "my change didn't
   apply" cause.

No lint config. Final visual verification is manual in the browser.

**Debug timing — "why is opening slow?"** (`settings.js`: `OBR.debugTiming` / `OBR._timer` / the
`OBR._debug` flag). A LOCAL-ONLY, off-by-default diagnostic: the flag lives in
`chrome.storage.local` (`obr_debug` — never synced, never in Options), and when on the SW +
reader + gallery log per-phase `performance.now()` deltas to the console. It STREAMS each phase as
it completes (a `… start` line, then one line per phase, then a `… done  …  total=Nms` summary) —
NOT a single end-of-run line — specifically so a mid-load HANG is localizable: the last streamed
line is the last phase that finished, so the stall is in whatever runs next (order: reader =
settings→build→extract→render→resume→layout; gallery = settings→build→render→watch; sw =
probe→inject→dispatch). A summary-only design would print nothing at all on a hang. A MISSING
`… start` line means the stall is before the timer ran (e.g. the SW never woke — the cold-start /
orphan cases). Enable from a console where `OBR` exists (`OBR.debugTiming(true)`; `(false)` off) — persisted in
storage, so it's then on everywhere. EASIEST path: the **Options page** (it loads settings.js into
its own window, so `OBR` is in that page's main world — F12 → Console → run it, no context switch).
`OBR` is NOT in a normal article page's default console (content scripts run in an ISOLATED world —
use the Console context dropdown, or just enable from Options). Where the lines show: `[OBR reader]`/
`[OBR gallery]` log to the ARTICLE page's console; `[OBR sw]` logs to the service-worker console
(chrome://extensions → service worker → Inspect). **Purely local — nothing is ever
sent anywhere; keep it that way** (shipping numbers off-device would flip the "collects nothing"
Web Store disclosure, the same reason the report page carries no telemetry). The SW reads the
in-memory `OBR._debug` (hydrated at `importScripts` + kept fresh by the `storage.onChanged`
`local`/`obr_debug` branch) so the normal path adds NO per-invoke storage read, and it hands the
resolved flag into the `open()`/`openGallery()` dispatch so a cold first invoke still times itself.
`OBR._timer` snapshots the flag at creation and no-ops every `mark`/`flush` when off, so
instrumented call sites cost ~nothing in the normal path. The SW additionally traces every TRIGGER
entry point via `swLog()` (toolbar icon / keyboard command / context menu, plus the reasons a
trigger silently does nothing: no tab, restricted page, hidden `tab.url`, injection failure) — the
answer to "did my click even reach the worker?". Each line carries **`swAge`** = `performance.now()`
in the worker, i.e. ms since IT started: `swAge` under ~200ms means that trigger COLD-STARTED the
worker (MV3 evicts it after ~30s idle), which is the usual reason a first press feels dead and the
next is instant; a large `swAge` rules cold start out. Independent of debug mode, `invokeReader`
shows a **"working" badge** on the toolbar icon (`showWorking`/`clearWorking`, `chrome.action`, no
permission needed) — the only feedback surface available while the slow part is the worker boot +
injecting ~430KB, i.e. before any content script exists to draw an in-page toast. It is DELAYED by
`BADGE_DELAY_MS` so a normal fast open never flashes it, and cleared in a `finally` so it can never
stick.

## Tests

Playwright loads the unpacked extension into real Chromium (`tests/fixtures.js`) and drives it against
fixtures served by `tests/server.js`.

```
npm test                                       # all integration + packaging tests (headless)
npm run test:headed                            # visible browser
npx playwright test reader.spec.js -g "flips"  # subset
npx playwright install chromium                # first run only
```

- `extension-load.spec.js` — loads, SW registers, shipped manifest correct; plus a real-SW test that
  `chrome.downloads` works and the SW fetches cross-origin via `host_permissions`.
- `reader.spec.js` — text engine: extraction, Shadow render, pagination, flipping, Home/End, theme,
  font size, progress/resume, close/toggle, settings persistence.
- `gallery.spec.js` — image engine: collection + tiny-image filter, masonry, lightbox, download/ZIP
  (stubbed SW), mode switching.
- `auto-open.spec.js` — the sentinel's decision ladder end-to-end (content gates, metadata veto,
  suppression + SPA re-arm, enable-time chip, engine chip/suppress integration) plus the pure rule
  helpers; the SW-side registration sync is covered in `extension-load.spec.js` with a stubbed
  grant check, and the remaining SW slices (permission prompt, `obr-auto-open` handler) are
  manual-verified per `docs/auto-open-spec.md` §10.
- `options.spec.js` — options page (real extension context): the how-to-use guide, trigger + shortcut
  docs, native `<details>` collapse, first-run open.
- `packaging.spec.js` — `npm run package` zips only the allowlist, leaks no dev files.
- **Harness caveat**: headless Playwright can't click the real toolbar icon (no `activeTab`), so tests
  inject the content scripts the same way/order as `background.js` and exercise the unmodified engine;
  only the ~2 lines of gesture→inject wiring are uncovered. `chrome.storage.sync` is shimmed in-page.

`npm run test:manual` (`tests/manual-site-proxy.mjs`) runs the real engine against real-site DOM: it
fetches a page server-side, strips CSP + its `<script>` tags (freezing the SSR DOM), injects
`<base href>`, and appends the content scripts. Visit `http://127.0.0.1:8347/read?u=<encoded URL>` and
call `OBR.toggle()` / `OBR.toggleGallery()` from the console. (Doesn't drive live lazy-hydration; a
no-SSR / paywalled page returns an empty snapshot — not a bug.)

## Publishing

```
npm run package          # zip the allowlist (manifest.json + icons/ + src/) → dist.zip
npm run deploy           # upload via Web Store API (publishes unless AUTO_PUBLISH=false)
npm run bump -- minor    # bump manifest+package version in lock-step, commit + tag vX.Y.Z
npm run screenshots      # render store images → store-assets/ (gitignored)
```

- **Tag-driven CI release** (`.github/workflows/release.yml`): `npm run bump -- minor` (or
  `patch`/`major`/`X.Y.Z`), then `git push --follow-tags`. Pushing a `v*` tag runs the suite, packages,
  uploads, and submits for review (`AUTO_PUBLISH='true'`) — the pushed tag is the release gesture; the
  version goes live once Google's review passes. The store rejects any non-incremented version, so the
  bump is mandatory; `bump-version.mjs` is its single source (don't hand-edit the two version fields).
  CI re-verifies the tag matches `manifest.json`. Repo secrets:
  `CHROME_EXTENSION_ID`/`CLIENT_ID`/`CLIENT_SECRET`/`REFRESH_TOKEN` (account-scoped — only the
  extension ID differs per extension).
- **Local deploy** uses `.env.chrome-webstore` (gitignored; copy from `.env.chrome-webstore.example`,
  then `npm run get-token`). Local keeps `AUTO_PUBLISH=false`; only CI publishes.
- **Publisher + release account** (the source of a long 1.1.0 release outage): this extension is published
  under a Chrome Web Store **group publisher**, so the `CHROME_REFRESH_TOKEN` secret must be minted
  (`npm run get-token`, which now forces the account chooser) signed in as the specific **group-member
  account that owns the publisher** — a token from any other account *authenticates fine but the Web Store
  upload 403s* (the OAuth client's GCP project is irrelevant; only the consenting account decides access).
  The exact publisher + owning account are in `.meta/portfolio.json` (gitignored — deliberately kept out
  of this public repo, per RULE #1). A bare `Bad Request`/`Forbidden` with a swallowed body on deploy is
  usually this or an expired token; `deploy-to-store.js` probes the token and prints the real reason.
  Confirm ownership with `GET /chromewebstore/v1.1/items/<id>?projection=DRAFT` (200 = owns it). The
  full publish runbook is kept in the maintainer's private `~/.claude` config, not this repo.
- **Packaging is allowlist-based** (`SHIP_FILES`/`SHIP_DIRS` in `package-extension.js`): only
  `manifest.json`, `icons/`, `src/` ship — dev files can't leak. `READABILITY-LICENSE.md` and
  `QRCODE-LICENSE.md` ship too (both live under `src/content/`, and the licenses require the notice
  beside the vendored code).
- **Privacy-practices gate**: adding a new permission blocks `publish` until you write its
  justification in the Developer Dashboard (the API can't set it) — the API fails with
  `400 "publish condition not met ... Privacy practices tab"`. Fill it BEFORE pushing a tag that adds
  a permission.
- **Listing copy + IDs**: `.meta/LISTING.md` (gitignored — kept out of this public repo per RULE #1;
  source of truth to paste from), with the localized detailed descriptions in `.meta/listings/<lang>.txt`. Public site (landing +
  privacy): `site/`, auto-deployed to GitHub Pages on push to `master` via `.github/workflows/pages.yml`
  → https://kouxing2000.github.io/open-book-reader/. Host the privacy policy publicly; note that rendered
  article media still fetch from the origin even though the extension makes no requests.

## Gotchas

- **Host grants: everything is per-origin, and NEVER trust `permissions.remove`.** Auto-open
  requests a per-site PAIR (`originsForRule` → `*://host/*` + `*://www.host/*`); a ZIP download
  requests the origins its images actually live on (`permsFor(msg)` off `msg.urls`). `<all_urls>`
  is reachable ONLY through the popup's explicit "Allow all sites instead" — it used to be what
  every ZIP silently asked for, which is the bug this design replaced. It still matters because a
  broad grant COVERS every pair: once held, `permissions.contains(anyPair)` is true for every site,
  which is why the options **Site access** card is driven by `permissions.getAll()` (ground truth,
  one honest broad row) rather than by testing each rule (N falsely-granted rows), why per-site rows
  then read "Redundant", and why the Auto-open checkbox skips requesting at all (`broadGrantHeld`) —
  asking anyway made Chrome record a redundant per-site entry beside "All sites". Two
  consequences that have already bitten: (1) `remove()` resolves `true` even for origins that were
  NEVER granted, and cannot carve a per-site hole out of `<all_urls>` — so **always re-check
  `contains()` afterwards** and report only that (`options.js: revokeOrigins`; the SW's similar
  "contains is authoritative here" note is about the request-WAITER path, not `remove`); (2) origins are HOST-scoped, so `host/blog/*` and `host/forum/*` share ONE grant —
  releasing on behalf of one silently pauses the other while its checkbox still reads "on".
  Two shared definitions in `settings.js` settle both, and every caller MUST use them:
  `OBR.autoRuleOrigins(rules)` (the union the sentinel registration reads) and
  `OBR.releasableOrigins(rule, remaining)` (`[]` = keep the grant). The deliberate turn-off paths
  all release: options checkbox, rule delete, Reset to defaults, the context menu's "Stop
  auto-opening", and the in-overlay chip's Stop (which RELAYS via `obr-stop-auto` — a content
  script cannot call `permissions.remove`, so clearing in-page would keep the grant). Known
  exception: editing a rule's pattern to a new host (`patCommit`) drops `auto` and ORPHANS the
  old host's grant — it surfaces later as a "Not used by any auto-open rule" row. `permissions.remove` needs no user gesture, so the worker releases directly (it skips
  the verify step only because it reports nothing).
  A revoked auto rule KEEPS its `auto` flag on purpose — the sentinel re-arms if the grant returns,
  so the UI shows a paused line and never silently unchecks the box.
- **Never tell users to uninstall + reinstall to clear the chrome://extensions site list.** It's the
  only thing that clears it, and it is not worth it: uninstalling wipes `chrome.storage.local` (every
  saved reading position, `obr_positions` — sync data may return, progress does not) and fires
  `setUninstallURL`, dropping the user into the uninstall survey and polluting the feedback pipeline
  with fake churn. The listed row grants no access — a toggle-off entry is Chrome's history, not a
  permission. The Site access hint says exactly that so nobody reaches for the nuke; keep it. (Fine
  to explain the mechanic to someone who explicitly asks in a support reply — never ship it as UI advice.)
- **Incognito is SPANNING — one worker, one storage — so never write a reading trace there.**
  The manifest declares no `incognito` key, so Chrome's default `"spanning"` applies: a SINGLE
  service worker and a SINGLE `chrome.storage` serve normal and incognito windows alike (`"split"`
  would give incognito its own worker + ephemeral storage, but it is opt-in and we don't take it).
  Consequences: `swAge`/`boot` readings pool across both window types; and a content script CANNOT
  tell which kind of tab it is in — only the SW can, via `tab.incognito`, which it passes into the
  dispatch to set `OBR._incognito`. That flag gates `skipPassiveWrite()` in `settings.js`, which
  makes `savePosition` / `addReadingTime` / `markPositionFinished` / `bumpLifetime` / `bumpUsage`
  no-ops. Without it, reading in incognito persisted `obr_positions` — which stores
  **origin+pathname, i.e. browsing history** — plus lifetime/usage totals into `storage.local`,
  which OUTLIVES the incognito session: a durable on-disk trace of private browsing, against the
  whole point. Reads still work (resuming a position saved earlier creates no new trace) and
  DELIBERATE writes (theme, font, saved picks, dismissing the rating ask) still persist — only the
  automatic "what you were reading" bookkeeping is suppressed. Keep any NEW passive per-page write
  behind `skipPassiveWrite()`. Note the extension must also be explicitly enabled in incognito by
  the user; when it isn't, no trigger reaches the worker at all (the trace shows NO `trigger:` line).
- **Do NOT add the `tabs` permission.** The restricted-page guard reads `tab.url` and works without it:
  executing a keyboard shortcut grants `activeTab`, which makes `tab.url` available via
  `chrome.tabs.query`. Adding `tabs` broadens permissions for nothing and is a Web Store review flag.
- **Context-menu builds must stay SERIALIZED** (`background.js`: `createMenus` + the `menuBuild` chain).
  `onInstalled` and `onStartup` BOTH fire in one worker activation when Chrome applies an update while
  the browser was closed, so `createMenus()` can run twice back-to-back. The obvious fire-and-forget
  shape (`removeAll(cb)` → 8 un-awaited `create()`s) is broken: two overlapping calls queue BOTH
  `removeAll`s before EITHER batch creates anything, so the second batch collides with the first's live
  items → 8 `Cannot create item with duplicate id obr-*` unchecked-lastError entries and a red **Errors**
  badge on the extension card. Don't "simplify" it back. Failures log via `console.warn`, never
  `console.error` — chrome://extensions collects the worker's `console.error` into that same Errors list.
  The menu is **state-aware**: `createMenus()` reads `siteRules` and scopes the "Stop auto-opening" and
  "Clear rule" rows with `documentUrlPatterns` so they appear only on the matching site (auto rules /
  whole-site rules respectively), and it re-runs on the `storage.onChanged` `siteRules` delta (alongside
  `syncSentinelRegistration`), plus `onInstalled`/`onStartup`. Chrome has no `onShown` event and we hold
  no `tabs` permission, so this declarative per-site scoping is the ONLY way to reflect state — and
  patterns can only ADD a row, never HIDE the always-present generic one (no negative match patterns),
  so "Stop" sits BESIDE "Auto-open on this site" (a pair), it doesn't replace it. The same scoped-add
  trick shows the disabled "Current selection: …" line inside the **Configure Default** submenu (the
  per-site default view — Smart pick / Reader / Gallery — which SETS the rule and does NOT open;
  Band 1's "Open now:" items are the immediate triggers). Click dispatch is a thin switch over the
  pure, unit-tested `OBR._menuAction(id)` → descriptor (plus `OBR._configureDefaultAction` for the
  Smart-pick clear-vs-keep decision) — keep the id→action mapping there, not inlined in the listener.
- **`syncSentinelRegistration()` must stay SERIALIZED on its promise chain** — the exact
  `onInstalled`+`onStartup` double-fire that broke the context menu applies, and two overlapping
  syncs would race the register/update/unregister diff. Registration mechanics that are easy to
  get wrong: zero auto rules must UNREGISTER (an empty `matches` array is invalid); one INVALID
  pattern rejects a whole `registerContentScripts` call (hence `originsForRule`'s `[]` guard);
  a valid-but-ungranted pattern registers fine and silently never injects. Gate the
  `storage.onChanged` trigger on an actual `siteRules` delta — every font nudge and debounced
  gallery persist writes `obr_settings` and would otherwise wake a pointless re-diff.
- Prose counting (`OBR._proseStats`/`_countWords`) lives in **settings.js**, shared by the reader,
  the gallery's `_autoToggle`, AND the sentinel — one implementation so the verdicts agree. It
  touches the DOM at call time only: settings.js is `importScripts`'d into the SW, where a
  top-level DOM access would kill worker registration.
- `readability.js` and `qrcode.js` are third-party vendored code — keep them pristine; fixes go upstream.
- `reader.js` injects `article.content` via `innerHTML` into the Shadow DOM (and the print iframe).
  Vendored Readability is NOT a sanitizer (it keeps e.g. `<img onerror>`), so EVERY content path —
  the Readability pass in `parseBaseDoc` and the `rawFallback` for picked/selected subtrees — runs its
  HTML through `sanitizeContentHTML` (drops `<script>`/`<style>`/`<noscript>`/`<iframe>`/`<form>`
  wholesale — `<iframe>`/`<form>` guard against clickjacking/phishing inside the trusted reader
  overlay — plus all inline `on*` handlers, `srcdoc`, and `javascript:` URLs on
  `href`/`src`/`xlink:href`/`action`/`formaction`) before it becomes `article.content`.
  `escapeHTML` covers title/byline only.
- Listeners (`keydown` capture, `resize`) attach once at injection and persist for the tab's lifetime;
  `close()` only hides the host (inert when `!active`). Don't add re-attach logic without also handling
  the double-injection guard.
- **Tall images force blank pages — fixed per-FIGURE, not by the CSS cap alone.** A portrait image
  (a phone screenshot, a scan) taller than the space left in its column can't share that column under
  `break-inside: avoid` (`reader.style.js`), so it bumps to the next one and strands the remainder blank
  — the "left page ends after two paragraphs, right page is just the image" report. The CSS
  `max-height: calc(--obr-colh * var(--obr-imgcap))` ceiling is only the coarse BACKSTOP: it is a global
  penalty for a LOCAL collision (it shrinks images that never collide) and can't fit a figure to the
  exact slack. The real fix is `reader.js`'s **`fitTallFigures()`**, run inside `layout()` right before
  the `totalColumns` measure so pagination, the colophon fit and the anchor restore all see corrected
  geometry. It measurably cuts BOTH column count and stranded blank tails on
  `tests/fixtures/tall-figures.html` — re-measure there rather than trusting any number quoted here,
  since the values move with font metrics, viewport height and Chromium version.
  Load-bearing details, each probe-verified — change none of them casually:
  - The multicol fragmenter can't be asked "space remaining before element X", so slack is measured
    POST-layout. A block fragmented across a column break has a USELESS union `getBoundingClientRect`
    (measured 1168px across a 544px column) — find the flow end with a **Range's per-fragment
    `getClientRects()`**, whose last rect is the true end. Range start is the PREVIOUS figure, keeping
    the sweep O(content) instead of O(content x figures).
  - Measure everything RELATIVE to `pagesEl`'s rect; that cancels the horizontal `translateX`
    (verified identical at `translateX(0)` and `translateX(-3744px)`).
  - Reserve the figure's **margins** explicitly: `getBoundingClientRect` is the BORDER box, so
    `block - image` covers `<figcaption>` but NOT `margin: 1em 0`. Missing them under-reserves ~2em, the
    figure still bumps, and you've shrunk the image for nothing — the measured result was total waste
    going UP while images got smaller, a pure loss. Then **verify-or-revert**: after each shrink, confirm the figure actually moved up a
    column, else restore it. That is what makes the pass never a net loss.
  - A readability **FLOOR, not a ceiling** (`FIT_MIN_PX` / `FIT_MIN_FRAC`): when the slack is too small
    to leave a usable image, keep the blank — a postage-stamp screenshot is worse. So it stays partial
    by nature, but on a principled floor. Gate the floor on the RESULTING IMAGE HEIGHT (`target`),
    NEVER on `slack`: `target` is always smaller (it pays figcaption + margins), so gating `slack`
    lets the fractional floor be violated on any ordinary tall desktop window.
  - **Do NOT raise `--obr-imgcap` expecting the pass to compensate** — tried and measured as wrong. A
    higher ceiling leaves images too tall to fit ANY realistic slack, so the pass declines them (its
    floor) and goes inert exactly when it is needed, leaving MORE blanks than the lower cap. Sweep the
    variable and re-measure if you revisit it; don't reason about it from the armchair.
  - `OBR._fitPass = false` is the test seam that A/Bs the pass; `reader.spec.js` asserts the blank-tail
    SIGNAL (and idempotence across relayouts), never the inline styles.
- **NEVER put a backtick in `reader.style.js` — the whole stylesheet is one JS template literal.**
  `OBR._readerCSS()` returns the entire reader CSS as a backticked string, so a stray backtick
  inside a *CSS comment* (writing a property or attribute name in prose) closes the string early
  and the file dies with `SyntaxError: Invalid or unexpected token`. The symptom is remote from the
  cause: the file simply never defines `_readerCSS`, and the reader throws
  `OBR._readerCSS is not a function` from `applyStylesheet()`. This has bitten three times — write
  such names as plain words (`the style attribute`, `minus-3em`), never quoted with backticks.
  Guarded by the `every shipped script parses` test in `packaging.spec.js` (`node --check` over
  `git ls-files src/**/*.js`), which is the fast-fail nothing else in the suite provided.
- **An `<img width>`/`height` ATTRIBUTE survives extraction and pins images small.** Readability
  strips `style` everywhere and strips `width`/`height` only on `TABLE/TH/TD/HR/PRE`
  (`DEPRECATED_SIZE_ATTRIBUTE_ELEMS`) — an `IMG`'s own size attributes pass through untouched. A
  forum/BBS post shipping `<img width="220">` therefore rendered a 1200px-wide photo at 220px, 40%
  of the column, with the rest of the line wasted at any reader width (measured; a `<td width>`
  wrapper does not help since only the TD is cleaned). Fixed in `reader.style.js` with
  `.obr-pages img { width: auto }` — an author rule outranks an HTML presentational hint, while
  `max-width: 100%` still bounds it to the column and `auto` resolves to the NATURAL width, so a
  genuinely small image is never upscaled (verified: 90x60 source with `width="200"` stays 90x60).
- **No text-wrap-around-image in the reader — CSS `float` and multi-column don't cooperate.** The reader
  paginates with CSS multi-column, and a float in multicol rises to the TOP of a column and DETACHES from
  its source paragraph: on a "numbered items each with a screenshot" page every image clusters away from
  its story (measured: all text piled into one column, all images into another), and a tall near-full-width
  image additionally hits multicol fragmentation (its figure rect SPANS both columns — measured 1021px
  across a 544px column). Float-wrap works only in single-column flow, which this reader is not — so the
  blank-page fix is the height cap above, NOT wrapping.
