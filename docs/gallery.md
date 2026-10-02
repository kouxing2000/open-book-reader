# Image gallery internals (`src/content/gallery.js`)

> Deep reference, loaded on demand. `AGENTS.md` holds the always-on architecture map,
> conventions and cross-cutting gotchas; this file holds the detail you only need while
> actually working on this area.

Everything specific to image mode: how images are collected from a lazy page, the two
layouts and why each exists, the lightbox, the avatar/noise filter, and the ZIP download
path (the only network feature in the extension).

## Lazy / progressive images

**Lazy / progressive images** (`gallery.js`): collection is placeholder-aware — an `<img>` showing
only a placeholder with a `data-*` lazy URL contributes the lazy URL and skips the size filter
(`eachGalleryImg`, shared by `collect()` / `imageCount()`). A `MutationObserver` + delayed re-collects
live-merge later images (`mergeNewImages`). Since the gallery scroll-locks the page, its lazy loaders
won't fire, so `hydratePage()` scrolls the *real* page in small dwelling steps to trigger native
`loading=lazy` / IntersectionObserver / virtualized rows — on demand (progressive near the grid end,
gated by `galleryAutoLoad`) or fully via **⟳ Load all** (`OBR._galleryRescan`). Bounded against
infinite scroll; `close()` puts the page back where the user had it, or at the grid's spot (next
section), never where the sweep left it. The cursor (`sweepY`) starts each open where the page
stands, not at its top: the grid can open mid-way, and a first chunk swept from the top finds
nothing new and pauses loading (`softDone`). Demo: `tests/fixtures/lazy-demo.html`.

## Two layouts — Wall (masonry) + Ordered (row-major)

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

## Lightbox = paged reader

**Lightbox = paged reader** (already sequential): click any tile → prev/next, an `N / total` counter, a
thumbnail filmstrip, a timed slideshow. The **⟷ Fit width** toggle (`F` key, `galleryFitWidth`, persisted
+ options checkbox) fills a tall page to the WIDTH and scrolls it — for reading a single manga/comic/scan
page — instead of shrinking the whole page to fit; the `.lb.lb-fit` class switches the chrome to
`position:fixed` so it stays pinned while the image scrolls under it.

## The page's scroll and the grid follow each other

The reader's rule (`docs/reader.md`), for pictures, so an accidental quit and a reopen land on the
same tiles, and a switch between the two modes keeps the place. CSS background images have no
element and never take part.

- **Pairing:** a tile matches a live `<img>` that answers to its URL, by any URL the image carries
  (`liveUrls`: currentSrc, src, every srcset candidate by the shared `OBR.srcsetUrls` tokenizer,
  the lazy attribute). A tile keeps the URL
  `collect()` saw, and an image changes its own as it loads: an unloaded srcset image is collected
  as its largest candidate, then loads the one its `sizes` pick (WordPress emits this markup on
  every content image). Visibility is the reader's: a box, not `OBR._clipped` (a carousel, a
  collapsed box), and not `pinned` under a sticky or fixed ancestor, which is always on screen and
  says nothing about where the page is. A box that scrolls the image vertically ends that walk,
  so a fixed app shell or a scrolling modal still counts as page content, and the body never
  pins (pinning it is how a site locks its own scroll). The hide menu's image lookup
  (`findImgFor`) and its "Images in this spot" preview pair the same way.
- **Merges and URL hides pair by what an image loads as** (`loadedAs`: its srcset candidates,
  else its src). A merge folds an `<img>` that is already a tile under another such URL into
  that tile (or every such image comes back as a second tile once it loads), handing it the
  larger variant and the size it now has. A URL hide matches any of them, so "Hide this image"
  on a tile collected before its photo loaded still hides the photo, and Unhide finds the
  pattern again. This is narrower than `liveUrls` on purpose: a lazy attribute a carousel left
  stale, or a placeholder src that a lazy loader gives every image, would merge different
  pictures.
- **Open:** the grid starts on the tile of the page's first on-screen image (`pageImages`, read
  before the scroll lock, which drops the scrollbar and can reflow the page). It stays at the grid's
  top when that tile already starts in the top half of the grid's first screen: a page at its top,
  or a short window where no tile fits whole. An image the filter hides has no tile; the next
  on-screen image stands in.
- **The cue:** on an open the page placed, the tiles on the grid's screen whose pictures the page
  had scrolled past dim, hold, then fade back (`cueOpen`), so the edge of the gray is where the
  page stood. The pictures on the page's screen and everything after stay as they are. A URL
  counts as scrolled past only when no copy of it is on the screen or below (`pageImages`), since
  a thumbnail strip at the top reuses every photo's URL. It runs on the reader's spotlight timing
  (`OBR._spotFade`, `OBR.SPOT_MS` in `settings.js`). A page at its first picture has nothing to
  gray. An exact reopen, on the spot a page-syncing close left, gets no cue, since its screen
  is the one the user left; a reopen after an unmoved close is placed by the page again and
  plays it again. Reduced motion holds the dim, then drops it. Close cancels it.
- **Close:** only a grid that moved moves the page. Moved means the big view is open, or the top
  tile or its offset is not what open placed (`openTopUrl`/`openTopOffset`; the offset counts, or
  scrolling within one tall comic page would read as unmoved). Tiles are compared by URL, since
  hiding an image renumbers them, and a re-collect can give the same picture a new URL, so a
  live copy that answers to the open's URL is the same picture. The page then scrolls to the live copy of the grid's top tile, or of the picture in
  the big view, via the shared `OBR._revealOnPage`. The live copy is the LARGEST visible one
  (`liveCopyOf`), so a thumbnail strip reusing the URL, earlier in the page, does not win. With no
  visible live copy, or an unmoved grid, it goes back to `savedPageX`/`savedPageY`.
- **Exact reopen:** a close that synced the page remembers the tile, how far it was scrolled past,
  and where on screen it left that image's live copy (`closeSpot`, in memory only). A reopen with
  that copy still at the same spot restores exactly that, offset and all; anything else measures
  the page again. It compares the image, not `scrollY`: an article in its own scroll box (an app
  shell) never moves the window. An unmoved close keeps the spot its open restored, since it puts
  the page back where that open found it.
- **Tiles reserve their box** from the collected size before they decode. The open places the grid
  synchronously after `render()`, and a tile without height (say, a page image fetched in CORS
  mode that the tile's plain fetch cannot reuse) would leave every tile at the top.
- **"Load all" still means all.** Chunks sweep from where the page stands, but a grid opened
  mid-page owes the page above, since a feed that unmounts what scrolled past never mounted it
  while the grid was open. "Load all" pages through that from the very top on its own cursor
  (`topY`), then carries on from the chunks' frontier, so neither leaves the other a stretch
  already swept (a chunk that finds nothing new pauses loading). The cursor survives a step budget
  that runs out.
- Which way each open and close went lands on the debug-timing line (`at=`) and in
  `OBR._diagGallery()` (`openAt`, `closeAt`), a thrown scan or reveal with its own reason.
  `openAt` ends with the cue's decision (`cue: 3 scrolled past dimmed`, or why there was none).

## Image filter — hide avatars / repeated noise

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

## Gallery downloads

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

