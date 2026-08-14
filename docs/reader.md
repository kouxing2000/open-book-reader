# Text reader internals (`src/content/reader.js`)

> Deep reference, loaded on demand. `CLAUDE.md` holds the always-on architecture map,
> conventions and cross-cutting gotchas; this file holds the detail you only need while
> actually working on this area.

Everything specific to the two-page text mode: how a page is rendered and paginated, how a
turn is animated, how print/PDF is built, how position survives re-pagination, how the user
overrides a bad extraction, and the layout traps that produced blank pages.

## Rendering and pagination

The base model — Readability into an open Shadow DOM, styling via `adoptedStyleSheets`, pagination
as CSS multi-column where a "spread" is N columns-per-view — lives in `CLAUDE.md` under
Architecture, because you need it to orient in the codebase at all. **That is the single source;
don't copy it back here.** Everything below builds on it.

## Page-turn animation

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

### The turn must draw the page it claims to (the "wrong image" class)

Every panel is positioned by index math — column *k* sits at `k * stride` — which is only true
while **(1)** the cached pagination still describes the live strip and **(2)** the clones paginate
exactly like it. Both stop being true on their own, and when they do the turn animates content from
somewhere else in the article: the long-running "the flip sometimes takes the wrong image" report.

- **(1) Stale pagination.** The browser re-flows the multicol strip whenever content changes size,
  and only some of those reflows announce themselves. `watchMedia()` hears `img` load/error and
  `document.fonts.ready` — but `ready` resolves ONCE, for the faces pending at that moment, so a
  bold/italic cut first requested when its glyph run is laid out swaps in later and re-breaks every
  column silently (hence the `loadingdone` listener beside it). `flip()` therefore does not trust
  `mediaTimer`: it compares `liveColumnCount()` (measured off `scrollWidth`) against `totalColumns`
  and re-runs `layout(true)` on any disagreement — one cheap read, and `pageGeom()` forces layout a
  moment later anyway. `endActiveFlip()` runs before that `layout(true)` on purpose: the old
  `!activeFlip` guard skipped the re-measure whenever a turn was in flight, which made the SECOND
  tap of a fast double-flip the one that went wrong.
- **(2) A clone that re-paginates.** A cloned `<img>` does **not** inherit the original's loaded
  state — it re-runs source selection, and with nothing to size it from it lays out at 0 until the
  bytes arrive. With `.obr-pages img { height: auto }` and `column-fill: auto`, one collapsed image
  shortens its column and re-breaks every column after it, so panel *N* stops being page *N*. So
  `buildFlipSnapshot()` takes one snapshot per turn and **pins every `img`/`video` to an inline px
  box measured off the live strip**, making the clone's layout independent of load state. Read every
  box first, then write, so it costs one layout flush; `box-sizing` is border-box, so the rect *is*
  the box. A zero box (an image still loading in the LIVE strip) is pinned as zero deliberately —
  the clone must match what the reader is looking at. Pinning the throwaway snapshot rather than the
  live strip is what keeps the reader's own rendering untouched, and the snapshot is also the
  measure-once point: cloning `pagesEl` per panel would be equally coherent (a turn is one
  synchronous task, so the tree cannot change mid-turn) but would re-measure for all 19.

  > **The pin MUST be an inline style — `width`/`height` attributes do nothing here.** It is tempting
  > to "fix it at the source" by stamping attributes from `naturalWidth`/`naturalHeight`, so any
  > future clone sizes itself. That does not work in this codebase: `reader.style.js` sets
  > `width: auto` (`:183`, deliberately, to release legacy `<img width>`) and `height: auto` (`:173`)
  > as AUTHOR rules, which outrank the attributes' presentational hint. Only `aspect-ratio` survives,
  > and a ratio cannot size a replaced element when neither side is definite. Measured in real
  > Chromium under exactly those rules, an un-loaded `<img>`: **`0x0` with the attributes, `0x0`
  > without them**, `40x1400` once `width: auto` is dropped. An attribute-based version looks like a
  > root-cause fix, tests green on "the attributes were written", and leaves the bug fully in place.

Both are then **verified rather than assumed**. `flipOverlayValid()` asks the narrow question — do
the columns this turn ANIMATES carry the same content in both flows? — because a divergence past the
last animated column cannot be put on screen, and treating it as a wrong page costs the animation for
nothing (observed in the field: one correctly-sized image, nothing failed, and the curl silently
stopped happening on that site). `flowMatchesThrough()` answers it by comparing, for each leaf block
up to that column, **where it actually sits on both sides** — same column index, same offset down the
page, each measured relative to its own strip's rect so both transforms cancel. That is the property
the panels depend on, tested directly. When the answer is no, `abortFlipOverlay()` drops the overlay
and lets the (already-correct) instant jump stand — a missing animation is a far smaller bug than a
wrong page, but it is not free either. This one guard is the whole safety net for anything still
carrying a load-dependent box that the pin does not cover, which is cheaper than growing per-element
machinery — and `mediaCensus().unpinned` counts exactly those: `object`, `embed`, `canvas`, `audio`.
(Not `iframe` or `form` — `sanitizeContentHTML` strips both, so they can never be in the flow.)

> **Two ways to write this guard that LOOK right and detect nothing. Both were written, and both
> passed review, before either was found inert.**
> - *Equal `scrollWidth` as a fast path.* It is quantised to whole columns, so a divergence smaller
>   than the slack in the final column shifts every subsequent column while the column *count* stays
>   identical — measured, ~1 layout in 6 lands in that hole with 30-40 blocks displaced.
> - *Comparing `.obr-content > *` heights.* Readability wraps the whole article in one
>   `<div id="readability-page-1">`, so that list is `[h1, byline, wrapper, colophon]` — and a block
>   fragmented across columns has an `offsetHeight` that **saturates at the fragmentainer height**.
>   Measured on `/tall-figures.html`: live and a clone with *half* the column count both report
>   `[36, 26, 748]` against a `clientHeight` of 748. The walk compared three constants and returned
>   "fine" for every animated range.
>
> The lesson is not "avoid those two". It is that a guard nothing can reach looks identical to a guard
> that works. **`OBR._pinPass = false`** (same shape as `OBR._fitPass`) exists for exactly this: it
> pins the snapshot's media to ZERO — the real failure — so the suite drives `flipOverlayValid` for
> real. It pins to zero rather than skipping because a merely un-pinned clone re-fetches from cache
> and sizes itself perfectly well, detecting nothing. The test is red against an inert guard; verify
> that, not just that it passes.

Every detection increments `flipDesyncs` / `lastFlipDesync`, surfaced through `OBR._diagReader()`
and warned to the console under `OBR.debugTiming(true)` — so the next field report is a number
instead of a maybe. Purely local, nothing is sent anywhere.

## Print / Save as PDF

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

## Reading progress is a fraction, never a spread index

**Reading progress is a FRACTION, never a spread index** (`reader.js` + `settings.js`). Re-pagination
(font / columns / width) changes how many columns an article splits into, so position is stored as
`(currentSpread * pagesPerSpread) / totalColumns` and `layout()` re-anchors it: font/column changes
pass an explicit `anchorFraction`; **resume** loads the saved fraction into `restoreFraction` and
re-applies it through the late-image settle window until the first user nav clears it. Per-article
positions persist to `chrome.storage.LOCAL` (NOT sync — per-device, can be many, mustn't burn the 8KB
sync quota) as one bounded, LRU-pruned map `obr_positions` keyed by `origin+pathname`. No new
permission — `storage` already covers `storage.local`.

## Did the reader actually APPEAR? (the paint check)

`active` is a claim about our own state, not about the screen — and two page behaviours make it a
lie, both indistinguishable from a dead trigger and neither fixable by reloading. `paintCheck()`
(reader.js) tests the claim against what is PAINTED: `elementFromPoint` at the middle of the
viewport, which returns the shadow HOST for anything inside our root. It runs ~400ms after opening
(late enough for layout and for a lazy widget to insert itself) and again whenever the host is
removed. The verdict lands on `OBR._paintCheck` and rides into a report as `meta.failure`, so "it
doesn't work on this site" arrives naming the cause.

- **Covered.** The overlay takes the CSS-maximum z-index (`reader.style.js`) so it beats any site
  layer already on the page — at an equal z-index our host wins, being appended later. What it
  CANNOT beat is a layer inserted *after* we open, or the top layer (an open `<dialog>`, a
  fullscreen element), which outranks every z-index. Those get `{state:'covered', by:'<el> z=…'}`
  and the `notice.js` banner, which is itself appended last and so is visible even then.
- **Host removed.** A framework that rebuilds the children of `<html>` deletes our host. The
  retained reference still owns the shadow root, the paginated content and the position, so the
  watcher re-appends it — a recovery, not a re-open. **Once**: a page that wipes on a schedule
  would otherwise become an endless duel, so a second removal reports instead.

The watcher is `childList` on `documentElement` only, never `subtree` — our host is a direct child,
so that one mutation list is the whole surface, and it stays blind to everything the page does
inside `<body>`. `tests/silent-failure.spec.js` drives both against `tests/fixtures/hostile-page.html`,
a normal article that takes one hostile trait per `?mode=` — the file to extend when a new "it
doesn't work on this site" report arrives.

## Content override — when extraction picks the wrong block

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

## GOTCHA — tall images force blank pages

- **Tall images force blank pages — fixed per-FIGURE, not by the CSS cap alone.** A portrait image
  (a phone screenshot, a scan) taller than the space left in its column can't share that column under
  `break-inside: avoid` (`reader.style.js`), so it bumps to the next one and strands the remainder blank
  — the "left page ends after two paragraphs, right page is just the image" report. The CSS
  `max-height: calc(--obr-colh * var(--obr-imgcap))` ceiling is only the coarse BACKSTOP: it is a global
  penalty for a LOCAL collision (it shrinks images that never collide) and can't fit a figure to the
  exact slack. The real fix is `reader.js`'s **`fitTallFigures()`**, run inside `layout()` right before
  the `totalColumns` measure so pagination, the colophon fit (`docs/engagement.md`) and the anchor
  restore all see corrected geometry. It measurably cuts BOTH column count and stranded blank tails on
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

## GOTCHA — an `<img width>` attribute survives extraction and pins images small

- **An `<img width>`/`height` ATTRIBUTE survives extraction and pins images small.** Readability
  strips `style` everywhere and strips `width`/`height` only on `TABLE/TH/TD/HR/PRE`
  (`DEPRECATED_SIZE_ATTRIBUTE_ELEMS`) — an `IMG`'s own size attributes pass through untouched. A
  forum/BBS post shipping `<img width="220">` therefore rendered a 1200px-wide photo at 220px, 40%
  of the column, with the rest of the line wasted at any reader width (measured; a `<td width>`
  wrapper does not help since only the TD is cleaned). Fixed in `reader.style.js` with
  `.obr-pages img { width: auto }` — an author rule outranks an HTML presentational hint, while
  `max-width: 100%` still bounds it to the column and `auto` resolves to the NATURAL width, so a
  genuinely small image is never upscaled (verified: 90x60 source with `width="200"` stays 90x60).

## GOTCHA — no text-wrap-around-image

- **No text-wrap-around-image in the reader — CSS `float` and multi-column don't cooperate.** The reader
  paginates with CSS multi-column, and a float in multicol rises to the TOP of a column and DETACHES from
  its source paragraph: on a "numbered items each with a screenshot" page every image clusters away from
  its story (measured: all text piled into one column, all images into another), and a tall near-full-width
  image additionally hits multicol fragmentation (its figure rect SPANS both columns — measured 1021px
  across a 544px column). Float-wrap works only in single-column flow, which this reader is not — so the
  blank-page fix is the height cap above, NOT wrapping.

