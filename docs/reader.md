# Text reader internals (`src/content/reader.js`)

> Deep reference, loaded on demand. `AGENTS.md` holds the always-on architecture map,
> conventions and cross-cutting gotchas; this file holds the detail you only need while
> actually working on this area.

Everything specific to the two-page text mode: how a page is rendered and paginated, how a
turn is animated, how print/PDF is built, how position survives re-pagination, how the user
overrides a bad extraction, and the layout traps that produced blank pages.

## Rendering and pagination

The base model — Readability into an open Shadow DOM, styling via `adoptedStyleSheets`, pagination
as CSS multi-column where a "spread" is N columns-per-view — lives in `AGENTS.md` under
Architecture, because you need it to orient in the codebase at all. **That is the single source;
don't copy it back here.** Everything below builds on it.

## Input model — three tap zones, and one rule about mouse-compatibility events

Paging is keyboard (`ArrowRight`/`Down`/`PageDown`/space and their reverses) **and** pointer. The
click handler in `build()` splits the viewport by width: below `EDGE_FRAC` (0.28) turns back,
above `1 - EDGE_FRAC` turns forward, and the middle band toggles the auto-hidden chrome **on touch
only**. A tap needs no touch listener to page — Chromium synthesizes a `click` carrying `clientX`,
which is all the handler reads.

The handler listens on the content rather than a blocking overlay, so text stays selectable; a
non-collapsed `root.getSelection()` suppresses the turn. It is `root.getSelection()`, not
`window.getSelection()`, because the content is in a shadow root.

**Every mouse listener in the reader is gated on `!touchMode`, and that gate is load-bearing.**
Chromium's tap sequence is `pointerdown` … `mousemove`, `mousedown`, `mouseup`, `click`, so a tap
fires the mouse listeners too. Un-gated, the synthesized `mousemove` reveals the chrome *before*
the click arrives, so the centre band's toggle can only ever find it visible and hide it — the
centre tap then looks as dead as the band it replaced. The `mouseenter`/`mouseleave` pair is gated
for the mirror-image reason: `mouseleave` does not fire reliably on touch, so `overControls` would
latch `true` and the chrome would never hide again. That is also why `setTouchMode()` clears
`overControls` on the way into touch — on a hybrid device you can hover the toolbar with a mouse
and *then* tap, and the `mouseleave` that would have cleared it is by then gated off.

`touchMode` is latched from `pointerdown`'s `pointerType` (capture phase, so toolbar taps count)
and **starts `false`** — it is deliberately not seeded from `(pointer: coarse)`, because it gates
real behaviour and a coarse-*primary* device driven by a Bluetooth mouse (Android tablet, ChromeOS
in tablet mode) would then lose hover-reveal and silently swallow the first click spent recovering.
The latch loses nothing: `pointerdown` fires at touch-start, before the compatibility mouse events,
so a session's first tap is already in touch mode by click time. `coarsePrimary` is a separate
constant used for the footer hint's *wording* only, so a phone does not open showing keyboard
shortcuts. `pen` is deliberately not touch — a stylus hovers, so it wants the mouse behaviour.

`tests/reader-touch.spec.js` pins all of it, and is the only spec that runs below
`singlePageBelow` (720) — i.e. the only coverage of the one-column layout a phone gets.

**A turn past either end is answered, never dropped** (`bumpEdge`, reached from `flip()` for keys,
edge clicks and taps alike). The book nudges about 10px the way the turn would have gone, and the
footer comes up with the indicator reading "End of article" / "Start of article" ahead of the page
count. The label lasts until the next `applySpread()` rewrites the indicator. A full last spread
gets no colophon (it only fills a blank page), so without this it looks like any other spread and a
next-key press reads as broken. Reduced motion, or a turn still in flight, skips the nudge but
keeps the label.

## The toolbar — Aa, ⋯, and a width fit instead of breakpoints

The topbar is the mode switch, the title, and then **Aa · ◐ · [Pick] [Print] [Markdown] · ⋯ · ✕**. Aa
is a popover with text size, theme and columns (the `+` `−` `T` keys reach the same settings); ◐
cycles the theme in one tap, as `T` does; ⋯ is a menu with everything else. The Aa and ⋯ popovers
are hand-rolled (`togglePop` / `closePop`) because the `popover` attribute needs Chrome 114 and the
manifest's floor is 102. They live inside `.obr-topbar`, so the
page-flip click handler already ignores clicks in them; a click anywhere else while one is open only
closes it (no page turn), Escape closes it before it closes the reader, and `scheduleHideChrome`
never hides the bar while one is open.

**Pick, Print and Markdown are `FLEX_ACTS`**: inline while the bar has room, in ⋯ when it does not —
each has a twin menu item, and exactly one of the pair is shown. `fitControls` decides by MEASURING,
not by breakpoints, because labels differ by locale (a fixed width either strands room in English or
overflows in Russian). It shows everything, then drops the least-needed piece until the one row fits:
the inline actions from the right, then the reading-time meta, then the mode switch's text labels
(`.obr-compact`). Stopping at the first fit keeps the inline set a priority prefix. ◐ is never a
step: it always shows, because on a phone (no `T` key) it is the only one-tap theme switch. The
price is the title on the narrowest bars, which can fall below `TITLE_MIN` — about 60px at 360px
wide, less when the images badge shows. `fitControls` runs when the host is first shown, after
every render (title and meta change width), on resize, and when the picker ends — a resize during a pick is skipped while the host is hidden, and a cancelled pick re-renders
nothing, so without that call a narrowed window leaves ✕ off-screen. **The bar is
never allowed to wrap**: a second row sits in the bar's transparent gradient tail with the article
showing through the buttons. `syncTypePop` keeps the Aa readout and marked segments true on every path
that changes them, including an Options-page change and the OS flipping an 'auto' theme.

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
🖨 Print action (inline in the topbar or in its ⋯ menu, and the `P` key) reuse the article Readability already parsed (`lastArticle`, captured
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
`printReader` passes it a `brand` object (name + a display domain + pre-rendered `qrSvg`). The
display domain is the landing site's host (`OBR.SITE_URL`), not the store's: it is the line a
reader types off paper, and the store item URL is an opaque 32-letter id.

## Save as Markdown

**⤓ Markdown** (`reader.js`: `saveMarkdown` + the pure, testable `OBR._buildMarkdown` and
`OBR._mdFilename`) saves the same `lastArticle` Print uses as a local `.md` file. It is **Beta and off
by default**: the action exists only while the `markdownExport` setting (an Options checkbox) is on —
`FLEX_ACTS` marks it with `setting`, and `fitControls` hides both the inline button and its ⋯ twin
otherwise. The body is
converted by the **vendored** `turndown.js` (Turndown, MIT — injected before `reader.js`, notice in
`TURNDOWN-LICENSE.md`); output is YAML front matter (`title`, `author` when there is a byline,
`source`), the title as an H1, then the body. Three choices hold it together:

- **Front-matter values are `JSON.stringify`'d.** A JSON string is a valid YAML double-quoted
  scalar, so a title holding `:` or `"` needs no YAML escaper.
- **Tables are kept as HTML** (`keep(['table'])`). Core Turndown has no table rule and flattens a
  table into run-on text; GitHub and Obsidian render an inline HTML table. That avoids a second
  vendored file (the GFM plugin).
- **The download is `OBR.saveBlob`** (`settings.js`), the same detached-anchor click as the
  gallery's ZIP, so there is no `downloads` permission. The source URL is always written:
  `printSourceUrl` is scoped to print, and attribution is what a saved note is for.

Images stay remote links, so the file is small and the images load from their origin when a
Markdown viewer renders them. **Every URL in `lastArticle.content` must be absolute**, or the
saved file carries dead links: Readability's path already absolutizes (`_fixRelativeUris`), and
`rawFallback` (picks / selections Readability rejects) does the same through `absolutizeUrls`,
leaving a `#frag` link relative by Readability's own rule. Inside the reader the difference is
invisible (same base), which is why the regression test asserts on the exported file.

## Reading progress is a fraction, never a spread index

**Reading progress is a FRACTION, never a spread index** (`reader.js` + `settings.js`). Re-pagination
(font / columns / width) changes how many columns an article splits into, so position is stored as
`(currentSpread * pagesPerSpread) / totalColumns` and `layout()` re-anchors it: font/column changes
pass an explicit `anchorFraction`; **resume** loads the saved fraction into `restoreAnchor` and
re-applies it through the late-image settle window until the first user nav clears it. Per-article
positions persist to `chrome.storage.LOCAL` (NOT sync — per-device, can be many, mustn't burn the 8KB
sync quota) as one bounded, LRU-pruned map `obr_positions` keyed by `origin+pathname`. No new
permission — `storage` already covers `storage.local`.

## The page's scroll and the reader's position follow each other

**Open, first rule that applies wins:**

1. A text selection starts at its beginning.
2. If the page has not moved since the reader last left it, the reader resumes the saved position.
3. Otherwise it opens on the spread holding the page's top line (`pageSpot` + `screenStart` +
   `anchorSpread`), so a paragraph broken across spreads opens where the screen was, not where the
   paragraph starts. If the page shows the article's opening on a fresh visit and a saved
   position exists, it resumes the saved position instead.
4. Otherwise the saved position.
5. Otherwise page 1.

The "top paragraph" is the first paired paragraph in the viewport. When none is in view (a picture,
a code listing, a table, short paragraphs, the comments below), it is the last paired paragraph
scrolled PAST, and the open lands on its start.

**The spotlight.** On an open that rule 3 placed, the text the page had scrolled past dims for
about a second, then fades back (`spotlight`). The screen's lines and everything after them stay
as they are, so the edge of the dim is where the screen began. The spread holds more text than
the screen did, and this says where the reading had got to. It is skipped when the screen began
at the article's opening, since nothing was scrolled past. The gallery's open cue follows the
same rule (`docs/gallery.md`).

**Close:** the page moves only after a page turn (`navigated`: `flip`, which touch taps route
through, plus Home/End). It then scrolls to the paragraph at the top of the current spread
(`readingKeys` + `syncPage`). With no page turned, it goes back to `savedScrollY` as before.

Measure a change here with the real-site sweep through `npm run test:manual`: scroll each page in
`tests/fixtures/sweep-sites.json` to 25%, 50% and 75% of its height. A sweep that scrolls to a
known paragraph cannot fail this way, which is how the scrolled-past gap first went unseen.

- **"Has not moved" is a fingerprint, `p`, saved with the position.** It is an FNV-1a hash of the
  top paragraph's key, so the map never stores article text. It is written at open and again
  after a close scrolls the page. Two cases need it:
  - **Close then reopen must be exact.** The paragraph close scrolls to usually STARTS a spread
    earlier than the one being read, so treating it as a fresh scroll would reopen one spread
    early and save that.
  - **A reader left without close must not lose its place.** After a reload, Back, a discarded
    tab or a session restore, Chrome puts the page back where it stood when the reader opened. A
    fresh-scroll reading would then overwrite the deep saved position with that older one.

  The match also accepts the top paragraph's paired neighbours (`near`). The top block is often a
  sliver, so a few pixels of drift after a reload hand the top to the next paragraph.
- **Only a page at its opening defers to the saved position, and only on a fresh visit.** A page
  showing the article's opening, with nothing scrolled past (a fresh visit, a scroll past the
  header), says only "the start", and losing a deep saved position to that is worse than a Home
  press. A page scrolled past its opening says where the user is, even on the first spread. So
  does any page once this page has closed the reader on the article (`lastClose`): the page then
  shows where the user chose to go, and scrolling back up to the top means the top. The call is
  made at open from the page alone, so the open resumes the saved fraction outright and no late
  reflow of the reader can undo it. The debug line records which way it went (`opening: saved` /
  `opening: closed here`).
- **Pairing** is the split-body merge's own: leaf p/blockquote/li of 20+ words, keyed by their
  first 80 chars (`proseBlocks` / `blockKey`). A key two blocks share on EITHER side is dropped
  (`uniqueByKey`), or a teaser repeating a paragraph would send the close to the teaser.
- **Live blocks must actually be visible.** They need a box (`height > 0`), so a hidden duplicate
  cannot void the visible one, and they must not be `OBR._clipped` by an `overflow: hidden` ancestor
  (a collapsed "Read more", a carousel). The walk stops at the first ancestor that SCROLLS and
  asks whether that box is clipped instead. In an app shell (a hidden body around a scrolling
  article), every paragraph scrolled out of the article box would otherwise read as clipped.
- **The top of a spread is the first block to REACH its first column**, not the last to start at
  or before it: several paragraphs start in one column. Something unpaired may sit above that
  block on the spread (a short paragraph, a heading, pictures). Then the block before it stands
  in, so no unread line ends up above the viewport.
- **`OBR._revealOnPage`, not `scrollIntoView`.** It and `OBR._clipped` live in `settings.js`,
  shared with the gallery's page sync (`docs/gallery.md`). It moves the window and boxes that
  scroll, so an article in its own scroll box still follows. It never moves a box that clips: scrollIntoView
  scrolls `overflow: hidden` too, which slides a collapsed teaser to mid-article with no way back.
  It scrolls instantly, so a site's smooth scrolling can't leave the fingerprint measured
  mid-animation. It subtracts the site's `scroll-padding-top`, which is how a site declares its
  sticky header's height.
- **An open placed by the page's scroll is not a finish.** It opens on a spread, and opening
  records that spread as the position. But landing on the last spread that way does not mark the
  article finished. Only reading or resuming to it does, so the colophon's lifetime count and the
  auto-open ask guard stay honest. A press past the end (`bumpEdge`) counts as reading to it,
  exactly as End does.
- **Where the screen began is measured with the caret under its top edge** (`caretRangeFromPoint`
  on the live page), never with the block's rect. Where something else covers the edge (a sticky
  header), the hidden share of the block's height stands in, which is coarser by a line or two.
  The offset carries over in proportion to the two copies' text lengths, which absorbs inline
  bits the extraction dropped. A top block that begins on screen also takes in what lies between
  it and its paired neighbour above (a heading, a short paragraph, a picture), so those stay lit. The open
  anchors on the first visible character, and `colOfEl` floors its column: rounding is exact only
  for a block's box, and a character past mid-column would open the next column, sometimes the
  next spread.
- **The spotlight dims through a CSS highlight, not by restyling elements.** A highlight over the
  stretch before the screen changes no layout, so pagination cannot move. Its range is DOM
  positions, so it follows a late re-layout by itself. Two traps:
  - Inside `::highlight()`, `currentColor` is not the text's colour. The theme ink therefore
    comes in as `--obr-ink`.
  - `--obr-dim` is registered at injection (`CSS.registerProperty`), because an unregistered
    custom property animates by jumping at the midpoint.

  Pictures in that stretch dim by opacity. Reduced motion holds the dim and then drops it without a fade. The
  timing and keyframes are shared with the gallery's open cue (`OBR._spotFade`, `OBR.SPOT_MS`
  in `settings.js`). The spotlight ends at the first page turn, at close and on any content switch. The highlight API
  needs Chrome 105 and `color-mix` needs Chrome 111; on older versions the open is simply
  unlit.
- **`navigated` resets with the content** (open, a pick, "Use full page"). Close also skips the
  sync when the host is detached: every block then measures at column 0, which reads as "at the
  end".
- **Unpaired falls back, never worse.** Two cases cannot pair: body copy in `<div>`s (the
  `_proseStats` blind spot) and a paragraph Readability rewrote within its first 80 chars.
  - Incognito writes no position or fingerprint. A close then reopen on the same page still
    resumes exactly, from the page's own record of the close (`lastClose`). After a reload there
    the open has only the page's scroll and whatever was saved outside incognito.
  - A sticky header with no `scroll-padding-top` covers the synced paragraph's first lines. Those
    lines usually began on the spread before, so they were already read. Measuring the header
    instead would have to be mirrored in `pageSpot`'s viewport test, or the paragraph peeking out
    under the header would become the top paragraph.

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

## Heading chrome is stripped before Readability sees the page

Headings on real pages carry chrome that is not their text: a permalink glyph or icon link inside
the heading (Sphinx's ¶, an SVG anchor on React docs), a self-link wrapping the whole heading (MDN,
mdBook, many blogs), and a short link beside the heading in its own wrapper (Wikipedia's `[edit]`,
GitHub's anchor icon). Readability scores a heading wrapper that holds an `[edit]` link as
link-heavy boilerplate and drops the HEADING with it — nearly every section heading of a Wikipedia
article, in every language edition (upstream Readability 0.6.0 does the same). Whatever survives
shows the glyph as stray text in the reader and as `[¶](#…)` in Markdown.

`stripHeadingChrome` (`reader.js`) runs on the clone before parsing, in `parseBaseDoc` and in
`rawFallback`, so every content path sees clean headings. It is deliberately narrow, because it runs
ahead of Readability and can change what Readability picks:

- inside a heading, only in-page (`#…`) links are touched — removed when their text is empty or a
  permalink glyph, unwrapped (text kept) when they wrap the heading's whole text;
- a sibling is removed only when it is the heading's ONE companion in its wrapper, comes right AFTER
  it (a short link row BEFORE a title is a breadcrumb, not chrome), is short (≤ 24 chars), link-only
  and media-free, AND carries a chrome signal: bracketed text like MediaWiki's `[edit]`, or nothing
  but text-less in-page anchors. Short link-only content shares every other trait — a byline beside
  the title, a lone "Download (PDF)" link, a one-item "See also" — so the signal is what keeps it.

Judge any change to it on real pages, A/B on the SAME frozen DOM (two live loads differ by
themselves — ads, consent walls, A/B tests): where it touches nothing the parse is identical by
construction, so only pages where it removes or unwraps something need comparing.

Readability also renames every in-article `<h1>` to `<h2>` (`readability.js:720`), so a page using
`h1` sections over `h2` subsections loses a level. That one is left alone: vendored code, and no
page in the sweep showed it. The Markdown export closes the other kind of hole — a page that jumps
`h1` → `h3` — by renumbering body headings to start at `##` with no gap (`renumberHeadings`); the
reader keeps the source's sizes.

## Content override — when extraction picks the wrong block

**Content override — when extraction picks the WRONG block** (`reader.js`, plus pick storage in
`settings.js`). Readability is a guesser; the manual override has three escalating layers, all
zero-new-permission. (1) **Selection** — if text is selected when the reader opens (and the
`readSelection` setting is on, default), read EXACTLY that selection: `extractFromSelection` wraps
`range.cloneContents()` and runs it through the scoped path. (2) **Element picker** — the ⌖ Pick
toolbar action (and the "Wrong content?" hint banner) starts `startPicker()`: a uBlock-style hover-to-
highlight over the REAL page in a SEPARATE shadow host (`#obr-pick-host`), with the reader hidden and
page scroll unlocked (the same toggles `open()`/`close()` and the gallery's `hydratePage` use); a
click re-renders in place via `endPicker(node)` → `extractFromNode`. The reader keydown handler gates
on `pickerActive` so the picker owns Escape/arrows while it's up. The "Wrong content?" banner does NOT
auto-pop on every whole-page open — only when the extraction looks **suspect** (`wholeExtractionSuspect`:
it failed/returned the placeholder, OR — on a page with **≥200 prose words** (`proseWordCount`) — the
extracted text totals **< half** that prose, the "grabbed a sidebar / teaser / truncated" cases). A
confident or same-size-wrong parse stays quiet; the ⌖ Pick toolbar action (inline, or in ⋯ on a
narrow window) is the always-available affordance, and an explicit "Use full page" (`reExtractWholePage`) clears the suspect
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

**Lazy pictures** (`hydrateLazyImages`, on every clone before Readability parses). A picture the
page has not loaded yet carries a placeholder src (`DECOY_URL`: any `data:` URI, spacer/blank/1x1
names) and its real URL elsewhere; the pass takes, in order, the picture's srcset, a `<picture>`
source, any attribute whose value ends in an image file extension, then the `LAZY_ATTRS` /
`LAZY_SRCSET_ATTRS` names whatever their URL looks like — a CDN URL such as `/img/123?w=800` has no
extension. A placeholder candidate never counts as a rescue (it would stop the later steps), and a
srcset of placeholders alone does not save a picture from the render drop, which removes any
picture nothing rescued. The other half guards Readability's own lazy pass, which rewrites the src
of any picture whose class contains `lazy` from its other image-URL attributes, last one winning: a
picture already LOADED — its src is a `LAZY_ATTRS` value or a lazy srcset candidate, what a loader
copies in — has its lazy class tokens removed on the clone so it keeps the src the page shows (and
gets the lazy srcset that pass would have copied). Any other `data-*` match proves nothing: a
picture not yet loaded often mirrors its low-quality src in `data-lowsrc`, and it must keep the
tokens so Readability still upgrades it from `data-src`. Pinned by "hydrates a lazy picture whose
real URL has no file extension…" and "a loaded lazy picture keeps the URL the page shows…" in
`reader.spec.js`.

**Why a picked picture is missing** — debug mode (`OBR.debugTiming(true)`) logs one line per pick,
selection or saved pick: `pick images: kept K/N via <path>` (`readability`, or which raw-block
fallback fired). `K` is every picture the reader shows, each output picture claimed once, so two
pictures sharing a URL stay two. Every picture in the block lands in one bucket: kept as-is,
`swapped=` (kept but showing another URL, normally Readability upgrading a not-yet-loaded lazy
picture, naming the attribute it came from), `lost=[{src, size, why}]`, or `notCollected=` (a CSS
or `data-bg` background, or an iframe — the reader collects `<img>` only). On a raw-block path
Readability never ran, so a loss there is put down to the sanitizer only. Readability removes nodes without a trace, so
`logPickImages` re-derives each `why` from the rules it applies, read off the vendored prototype
(`REGEXPS`, `UNLIKELY_ROLES`, `_isProbablyVisible`) on the picture's ancestors up to the picked
block: hidden, page-chrome class or role, byline, share block, `<aside>`/`<footer>`/`<form>`/`<iframe>`,
a placeholder src, or else "scoring or cleanup" with the nearest classed ancestor. A rule match is
the probable cause, not a trace — Readability re-parses without its class-name strip when the first
pass comes out short. The render pass that drops placeholder-src pictures logs its own
`render dropped N image(s)` line, for every content path.

## Split article bodies — one story in several same-class containers

Some layouts cut one article into several containers that share a class list: Ars Technica sets
each story as two `div.post-content` blocks, each in its own grid row. Readability's sibling merge
only looks inside the chosen node's own parent, so it keeps ONE block and the reader silently
drops the other — measured at ~45% of the article on both Ars pages in the sweep, and on one of
them the dropped block is the opening, so the reader started mid-story.

`extractArticle` (whole-page reads only) runs `mergeSplitBody` after the parse; a throw inside it
keeps the unmerged read. `splitBodyParts` maps the kept prose blocks back to the live page and takes
the NEAREST classed box holding all of them (walking up through classless boxes only, at most
`SPLIT_CLIMB`), then looks for PEERS. Each peer's own Readability extraction is added before or
after the original, in page order — the original stays whole, so a merge can only add text. The
flip side: a piece added before the read lands above everything the read kept, including a figure
that sat above that piece on the page. Each
rule names the fixture whose test goes red without it; the ARIA-role, `<footer>` and nested-peer
checks have no fixture of their own (the last is also covered by the duplicate-piece check):

- **One `<article>`.** The box must sit in an `<article>` and every peer in that same one — not in
  a nested `<article>` either. This is the story boundary, and it closes a whole class at once:
  forum replies (phpBB carries no `<article>`; Discourse gives each post its own), Q&A answers, the
  next story of an infinite-scroll page (`split-body-false-{thread,stream}.html`; the nested case
  is `NESTED-MARKER` in `split-body-article.html`). Both Ars halves share one `<article>`. Cost: a
  split story on a site that uses no `<article>` stays unfixed.
- **The nearest classed box, never a wrapper above it.** Identical layout wrappers
  (`div.container.mx-auto`) would find a comments wrapper as a "peer" (`split-body-false-wrappers.html`,
  which asserts the verdict `no peer container`). A block whose opening another live block
  repeats does not place the box: a pull quote quoting the lead would otherwise lift it to the
  wrapper around both (`split-body-false-pullquote.html`).
- **Exact class set, not a superset** — `querySelectorAll` alone would match a
  `.post-content.newsletter-cta` promo (`NEWSLETTER-MARKER`); the order classes are written in does
  not count (the two halves of `split-body-article.html` list theirs in opposite orders) — and **a
  parent of the same signature** — a teaser box reusing the class (`TEASER-MARKER`).
- **Nothing Readability would have dropped anyway** (`splitRejected`, on every ancestor below the
  one shared with the box): a class/id among its `unlikelyCandidates` (a related-posts wrapper,
  `split-body-false-related.html`), an `<aside>`/`<footer>` tag (`ASIDE-MARKER`), an unlikely ARIA
  role, or a `hidden` attribute / inline hiding (`HIDDEN-MARKER`, an inactive tab panel). **And
  nothing the page does not show** — this goes past Readability, which reads inline styles only:
  `checkVisibility` with `visibilityProperty` reads the rendered page, so a pane the stylesheet
  hides with `visibility:hidden` stays out (`VEILED-MARKER`; plain `checkVisibility()` misses it).
  Opacity is not checked, since content that fades in on scroll starts at opacity 0; a reveal that
  starts at `visibility:hidden` is rejected, so such a half is not merged.
- **Readability output only, never the raw fallback.** `extractFromNode` falls back to a block's raw
  markup — right for a user's pick, wrong for a block nobody picked: it carries share buttons,
  inputs and embeds into the default read (`split-body-raw-peer.html`). An empty piece is dropped.
- **No piece the read (or an earlier piece) already has.** "Missing" is decided on LIVE text, and
  Readability strips some of it (a timestamp `<button>`), so a kept block can look missing; a piece
  sharing any prose block with what is already merged — compared extraction to extraction — is
  dropped (`split-body-transcript.html`). Peers nested in another peer are dropped too. A block is
  identified by its first 80 characters; with the box rule above, every collision errs toward
  merging less. Known limit: a piece holding one duplicated block and some genuinely missing text
  is dropped whole.
- **At most `SPLIT_MAX_PEERS` peers** — more is repeated cards (`split-body-false-cards.html`).

A pick or a selection is never merged — it is exactly what the user pointed at. Debug mode
(`OBR.debugTiming(true)`) logs each decision as `split body: merged N part(s)` or `none`, with the
kept/missing block counts, the signature, dropped duplicate/empty pieces and the verdict. The
full-open tests first assert what bare Readability kept and missed, so they cannot pass
vacuously; the wrappers, stream, cards and pull-quote fixtures call `OBR._splitBodyParts` with a read that kept
exactly the story, because Readability's own sibling rules already climb to the shared wrapper on
those synthetic pages.

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

## GOTCHA — a picture in a RUN owns its page, by construction

- **A run of pictures is paginated as PLATES, and that is a declarative rule, not a measured
  one.** `classifyPlates()` in `reader.js` marks each qualifying image `obr-plate` (and its
  `<figure>` / single-picture wrapper `obr-plate-box`); the stylesheet gives that box a height
  of exactly one column. An unbreakable box that tall cannot share a column, so the question
  "is this picture alone on its page?" is never asked. Runs before `fitTallFigures()`, which
  skips plates — a plate never shares a column, so it has no slack to be shrunk into.
  - **Qualifying is three conditions, all cheap and all DOM-level.** (1) The picture is in a
    RUN: several pictures inside one wordless wrapper, or a picture container adjacent to its
    own — which is what keeps a lone screenshot on the same page as the paragraph explaining
    it. (2) At its
    natural size, bounded by the column width, it would already reach the `--obr-imgcap`
    ceiling. (3) Its box holds it ALONE — a `<figure>` carrying two images is one box for both,
    and plating it puts two half-height pictures on one page. Natural size falls back to the
    `width`/`height` attributes so a plate is decided at the FIRST layout instead of waiting
    for the settle window.
  - **"How many pictures are here" is asked in four places and must have ONE answer —
    `pictures()`.** Decoration is an image too, and answering it inconsistently broke plating in
    both directions at once: a 48x48 badge counted as a second picture, so a lone chart seized a
    page from the paragraph explaining it; and a 20x20 zoom glyph counted against the
    one-picture-per-box rule, so a genuine run of figures carrying that glyph stopped plating
    altogether — measured at 0 of 12, silently, every picture back at the 0.72 cap.
    - `isFurniture()` judges the **short** edge, because a 760x8 divider rule clears any
      long-edge threshold; and the **intrinsic** size, because that is the only input here the
      plate feature does not itself move. Two inputs it must never read, each of which has
      already shipped a silent total outage:
      - The `width`/`height` **attributes**. They are equally legal as a layout instruction and
        `parseFloat` cannot tell the two apart — it reads `width="100%"` as the number 100, so
        a whole run of photographs falls under the floor. Real articles only; every fixture here
        was hand-authored with honest integers. `real-world-attrs.html` reproduces it (the same
        420x880 file nine times under `width="100%"`, a lazy loader's leftover `width="1"`, and
        no attributes). `attrPx()` is the guarded form — bare integers only, reached just for an
        image with no intrinsic size yet, so the first layout still decides.
      - The **rendered box**. The un-plated cap `max-height: --obr-colh * --obr-imgcap` binds on
        height, so the taller the aspect the narrower the box: past roughly 3:1 a photograph
        measures under the floor and a webtoon or manga run gets nothing (`webtoon-run.html`,
        300x1200, measured 0 of 30 plated at three viewports). Worse, `.obr-plate` replaces that
        cap, so the same picture measures wider plated than unplated — the class feeding the
        measurement that picks the class, with two stable fixed points. A reader who maximised
        the window once saw plates; the same article at the same size did not, for someone who
        had not. `the same viewport renders the same document whatever the resize history` pins
        it, and the convergence test varies **height** for the same reason — a width-only wobble
        leaves `--obr-colh` fixed and never drives the loop.
    - **`intrinsic()` returns a THIRD answer — `known: false` — and that is the feature's
      scope, not an edge case.** Chrome cannot report "this resource has no size of its own":
      an SVG declaring only a `viewBox` gets the CSS **default object size** (300x150 fitted to
      its ratio), so `naturalWidth`/`naturalHeight` come back concrete, small and fictional.
      Since `w = min(300, 150a)` and `h = min(150, 300/a)`, one axis always lands exactly on
      the bound — reliable as a tell, and **not** reliable in reverse: a genuine 760x150 or
      300x80 SVG trips it too, one pixel either way. So the size is never guessed at.
      **Both guesses have shipped a defect**, which is why standing aside is the answer:
      - read as decoration → every responsive SVG is an icon. That is the standard
        Figma / Illustrator / D3 export and what `![](diagram.svg)` emits: a 100% failure for a
        whole content type (`responsive-svg-run.html`, measured 0 of 6).
      - read as content → a `viewBox`-only 16x16 glyph took a whole page at **686x686** and
        handed the chart beside it a run it should not have, seizing that page from the
        paragraph explaining it (`plate-furniture.html`, SIZELESS and BANNER bands).
      An unknown size is therefore neutral everywhere: `pictures()` excludes it, so it neither
      CREATES a run nor DESTROYS one, and the plate gate rejects it outright. The cost is
      stated plainly — **a run of responsive SVG diagrams gets no full pages** — and is pinned
      as a deliberate limit rather than left to rot as a silent outage.
    - Intrinsic size is not a *constant*, only uncontaminated: `srcset` makes it
      viewport-dependent (300x1200 at a wide window, 110x440 at a narrow one). It round-trips
      and matches what the reader draws, so it is not the feedback loop above.
    - **The standing risk.** This predicate has now had four separate "the number I read is not
      the number I think it is" defects — `parseFloat` on a percentage, a rect clamped by the
      feature's own cap, that rect forming a feedback loop, and the default object size — and
      each passed a full green suite before review found it. The root cause is that every
      number available here is *derived*; none is *observed*. The one observed size is the box
      the author gave the image on their own page, which `.obr-pages img { width: auto }`
      deliberately discards. If a fifth instance turns up, **do not add a fifth guard**: measure
      that box during extraction, where `parseBaseDoc` still holds the live laid-out document
      beside its clone, stamp it on the clone, and delete `intrinsic()` and this whole section.
    - **Consequence, accepted: a @2x icon counts as a picture when its FILE clears the floor.**
      Page CSS does not cross the shadow boundary and inline `style` is stripped, so a 192x192
      file authored at 64x64 renders at 192 here. Exposure is small — a 2x asset needs a ≥160px
      file, i.e. a ≥80px displayed icon, which is picture-sized anyway.
    - It is deliberately NOT the plate gate. The gate asks "does this need a page of its own",
      the floor asks "is it a picture at all", and they are different thresholds. Merging them
      is tempting — the gate is computed one line away — but it costs a real picture its page
      whenever its NEIGHBOUR is merely too small for a page: on `consecutive-figures.html`,
      Bare 12 sits beside a 600x450 that fails the gate and would lose its own page to the
      merge. Keep two thresholds.
    - Size cannot separate every case and is not meant to. A 300x250 ad slot and a 300x250
      photograph are the same DOM; an author portrait above the floor beside a lone
      illustration will still read as a run. The floor removes icons, badges, rules and
      spacers, which is the overwhelming majority, and nothing DOM-visible distinguishes the
      rest.
  - **It owns a page; it does not necessarily FILL one.** The box is always exactly one column
    tall, which is what makes it own the page, but the picture inside uses `object-fit:
    scale-down` and so is never drawn larger than its own pixels. A landscape picture is
    centred with bands above and below; a picture that only just clears the 0.72 gate is
    centred at its own size. `contain` would stretch both, and since the gate admits anything
    from 0.72 upward that is an upscale of up to 1/0.72 — visible blur, measured at 1.383x.
  - **The BOX is the figure when there is a caption**, so the caption rides on the picture's
    page and the picture takes the height the caption leaves (`flex` + `min-height: 0`, which
    is what lets a replaced element shrink inside a fixed-height box). It is the wrapper only
    when that wrapper holds this one picture: an article with its whole gallery in a single
    `<p>` would otherwise squeeze every picture onto one page.
  - **The picture is usually NOT the box's own child, and every height rule here binds to the
    child.** WordPress wraps it in an `<a>`, Blogger in a `<div class="separator">`, a
    responsive image in a `<picture>`. `flex` and `min-height` apply to the FLEX ITEM, so with
    a wrapper in the way they bind to the wrapper and silently stop constraining the picture —
    measured at 1271px inside a 688px page, cropped top and bottom, caption a page late, and
    green against every test in the suite. Two independent guards: `classifyPlates` marks each
    element between picture and box `obr-plate-pass`, which hands the height down; and the
    picture's own `max-height` repeats the box height, so a shape the marking ever misses is
    bounded to one page instead of unbounded. Do not replace that `max-height` with `none`.
  - **Do NOT reimplement this as a pass that measures a page, writes a size, and verifies it.**
    That is the obvious-looking design and it cannot be made to work: each DOM shape a real
    article produces breaks a different assumption in it. An adjustment budget runs out
    mid-book. A column index shifts under one overflow and the verify reverts the whole tail.
    A bare `<img>` is its own block, so anything derived from "the block's width" is the
    image's own width and every unwrapped picture reads as width-bound. Centring padding eats
    the picture it frames, because `max-height` caps the BORDER box. A wrapper's trailing line
    box makes one picture's growth reach the next page, so every second one is handed back. A
    page-count backstop reverts everything on any honest length change. A gallery in one `<p>`
    collapses 23 pictures into 3 fragmented blocks whose union rects mean nothing. Seven
    distinct failures, every one of them shipped and found by a reader; none can happen to a
    class. The cheap version of this argument: a measuring pass has to ask whether a picture
    is alone on its page, and a one-column-tall unbreakable box makes that unaskable.
  - The fixtures are one per shape from that list, so none is redundant: `figure-run.html`
    (captioned, back to back), `p-wrapped-plates.html` (one wordless `<p>` each),
    `contagious-plates.html` (a wrapper that also carries a line box), `gallery-in-one-p.html`
    (everything in a single `<p>`), `consecutive-figures.html` (mixed, including a picture too
    small to qualify), `plate-edge-shapes.html` (the picture wrapped in a link / a div / a
    `<picture>`, a picture inside the upscale band, a `<figure>` captioned with a `<p>`, and one
    `<figure>` holding two pictures), `icon-beside-chart.html` (a decorative badge beside a lone
    illustration). The specs assert what a reader sees — the height the picture PAINTS, and
    what else is on that page — never the class, so the next implementation of the same promise
    still passes.
  - **Measure the PAINT, and bound it on BOTH sides.** `object-fit: scale-down` means the
    element box is not what the reader sees: paint is
    `min(rect.height, rect.width * naturalH/naturalW, naturalHeight)`. A box measurement
    reports a full page for a letterboxed sliver, and dropping the natural-size term reports a
    full page for a picture merely centred in it. A lower bound alone is just as blind: `frac >
    0.9` is satisfied by a picture 1.85x its page, cropped top and bottom, which is how the
    wrapped-picture defect above stayed green. Assert `over <= 2` as well.

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

