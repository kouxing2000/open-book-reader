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

