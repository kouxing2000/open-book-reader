# Image gallery internals (`src/content/gallery.js`)

> Deep reference, loaded on demand. `AGENTS.md` holds the always-on architecture map,
> conventions and cross-cutting gotchas; this file holds the detail you only need while
> actually working on this area.

Everything specific to image mode: how images are collected from a lazy page, the two
layouts and why each exists, the lightbox, plain-source videos, the avatar/noise filter, and
the ZIP download path (one of the extension's two network features; the other is the Report
page's web form).

## Lazy / progressive images

**Lazy / progressive images** (`gallery.js`): collection is placeholder-aware — an `<img>` showing
only a placeholder with a `data-*` lazy URL contributes the lazy URL and skips the size filter
(`eachGalleryImg`, shared by `collect()` / `imageCount()`). The named lazy attributes come first
(`lazyAttrUrl`, the gallery's own priority); past them it takes the reader's attribute scan,
`OBR.attrImageUrl` (`settings.js`): any other attribute holding an image-file URL (`data-echo`,
`data-actualsrc`, a forum's `file=`), read only while the picture has no srcset or `<picture>`
source and its src has shown itself a stand-in: none, inline data, or loaded under the size
filter. A src still loading may be the real picture even when its name reads like a placeholder
(`gray-hoodie.jpg`), and would land as a second tile once it loads. That is what recovers a picture the page's own loader never swaps in, the
same set the reader recovers. A `MutationObserver` + delayed re-collects
live-merge later images (`mergeNewImages`): added nodes, and a `src`/`srcset` swap on an existing
`<img>`, since a site's loader often swaps the URL in after a sweep step's merge has run. Since the gallery scroll-locks the page, its lazy loaders
won't fire, so `hydratePage()` scrolls the *real* page in small dwelling steps to trigger native
`loading=lazy` / IntersectionObserver / virtualized rows — on demand (progressive near the grid end,
gated by `galleryAutoLoad`; `fillAhead` re-checks after every chunk or merge that grew the grid, not only on scroll, because a grid
shorter than the 1.5-screen buffer has nothing to scroll and would stop after its first chunk. Once the grid's
end is on screen the user has seen every tile, so an empty chunk no longer pauses loading there: it sweeps on through
a stretch of the page with no pictures until the page ends, at most `END_SWEEP_MAX` empty chunks per arrival) or fully via **⟳ Load all** (`OBR._galleryRescan`;
asked for while a chunk runs, it stops that chunk at its next step and takes over, since that
chain can keep chunks running for seconds; asked for after "All images loaded", it pages through
the whole page again from the top). Each step dwells `DWELL` (200ms). A loader debounced past
that fires only once scrolling pauses and loads what is on screen then, so a step that found
nothing while a stand-in is on screen waits again in place, to `SLOW_DWELL` (600ms). A stand-in
(`standInOnScreen`) is a picture's slot nothing has given a real URL yet: picture-sized, on
screen both ways, no lazy attribute naming its URL, and showing no src, an inline placeholder,
or a placeholder file loaded under the size filter. A real src still downloading, a broken
image, an icon, a slide parked off to the side, a stretch with no pictures and pictures already
loaded never wait twice. A stand-in that never turns into a picture (a blur-up layer) stops the
second waits after `DRY_REWAITS` fruitless ones in a row, for the rest of the open; fruitless
means the gallery's image count did not grow, not that the step's own merge found nothing,
since the page observer's merge often collects a swapped src first. A loader debounced past
`SLOW_DWELL` still ends part-loaded. Bounded against
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
preserved, no crop; the height is never clamped, so a full row spans the width, except that no tile
is drawn wider than its picture's own pixels (a small one sits at its real size, centered: an
enlarged picture goes soft, and the reader and the lightbox's normal view never enlarge either; SVGs
and video tiles are not capped, and Wall still enlarges);
unknown-size lazy images use `ORD_FALLBACK_ASPECT` and re-justify their row on
decode); at **1 column** it's a full-width reading **strip** (the same formula, one tile per row) — auto-scroll
turns it into a hands-free webtoon reader. **Next row** (a toolbar button shown only in Ordered) and
↓/↑ step one row (`rowStepTop`): the row lands where the first row sits, and a row taller than the
window is shown a window at a time down to its bottom first, so a step never passes over part of a
row; Wall's arrows keep their 80px nudge. **The Size slider picks a column COUNT, not a px width**
(`columnCount`/`maxCols`/`syncSizeSlider`, layout-aware: Wall spans 2..max via `galleryColumns`, Ordered
1..max via `galleryOrderedCols`): inverted (fuller bar = larger = fewer columns), clamped to `maxCols`
(what fits at `MIN_TILE` px, never more than `MAX_COLS`, the options sliders' `max`, so a wide monitor is not offered 16 columns). **Layout + column count are remembered per-site** (`obr_gallery` map in
`storage.sync`, mirrors `obr_picks` — bounded/LRU; `OBR.loadGalleryPref`/`saveGalleryPref`); Wall is the
default, a host opens Ordered only if it was left that way. Reworking the justify math is layout-heavy —
**verify with a real-Chromium screenshot and MEASURE tile rects** (`getBoundingClientRect`).

## Reading position on the grid

The grid's counterpart to the reader's page indicator + progress hairline (`updateProgress`): a
bottom-right `N / total` pill (`.pos`, the lightbox counter's string) and a 2px accent hairline along
the bottom (`.prog`). **N counts the images reached**: every entry but the tiles still wholly below
the grid's bottom edge, so an entry whose tile is gone (a broken picture removes its own) counts as
passed and the grid's bottom reads N / N. In Wall a whole row arrives at once, so on a short set N
runs ahead of the bar. **The total is the running count, not the page's**:
hydration grows it. **A total that can still grow is marked, and only then** (`more`): once the page
has added images since the open (`pageGrew`, set by `mergeNewImages`) and the sweep has not reached
the page's end (`sweptToEnd()`, the same test `fillAhead` stops on) or Load all has not confirmed it,
the pill reads `N / M+` and the hairline HIDES, since a scroll fraction of the loaded grid reads full
at the end of what is loaded. Do not key the mark on the unswept bottom alone: every page taller than
the window starts unswept, so plain pages (every picture collected at open) would wear a false `+`
for their whole first pass, and a 15k-px page with three pictures keeps it for seconds after its end.
A dot pulses in the pill while a sweep runs (`.pos.busy`). Refreshes come from four places and each
is needed: the scroll listener; a `ResizeObserver` on the grid and the scroller (tiles decoding to
their real height, relayouts, a window resize); `updateSelUI`, the funnel every image-set change
already goes through, since a tile appended to a short Wall column changes no observed box; and the
start and end of each sweep in `hydratePage` (the dot, and the end that drops the `+`).

## Lightbox = paged reader

**Lightbox = paged reader** (already sequential): click any tile → prev/next, an `N / total` counter, a
thumbnail filmstrip, a timed slideshow. The **⟷ Fit width** toggle (`F` key, `galleryFitWidth`, persisted
+ options checkbox) fills a tall page to the WIDTH and scrolls it — for reading a single manga/comic/scan
page — instead of shrinking the whole page to fit; the `.lb.lb-fit` class switches the chrome to
`position:fixed` so it stays pinned while the image scrolls under it.

## Videos — plain-source only

A `<video>` whose source is a plain http(s) file (`videoSrc`: currentSrc, src, or a playable
`<source src>`) becomes a tile. It is collected in the same document-order walk as the pictures
(`eachGalleryMedia`), so the Ordered layout keeps it in sequence. A `blob:` source is a
MediaSource stream that only the page's own element can attach (YouTube, X, Instagram), and a
`data:` one would put the whole file into the hide patterns; both are skipped, as are iframe
embeds, which the overlays keep out.

- **Nothing autoplays in the grid.** A video tile is a still with a play badge: its poster
  (`preload=none`, so nothing of the file loads), else its first frame (`preload=metadata`).
  Clicking the tile elsewhere opens the big view.
- **The badge plays it in place** (`playInTile`): the tile becomes a player with the browser's
  own controls and sound. From then on its clicks belong to the controls, so the tile drops its
  `href` (an `<a>`'s activation would otherwise navigate to the file, and a `preventDefault`
  would cancel the controls too), and an "open large" button (`.tile-open`) reaches the big view.
  Starting it focuses the player, and a focused tile player takes Space (play/pause) instead of
  the grid scrolling it away. Its fullscreen resizes the viewport, so the resize re-layout is
  skipped while the gallery's shadow root reports a fullscreen element; a rebuild would destroy
  the player mid-fullscreen. The shadow root's, never the document's: the toolbar's full-screen
  button makes `<html>` the document's fullscreen element, and the grid must follow that resize.
  Starting, resuming or unmuting a tile claims it (`claimTile`, `tileVideo`), and the
  `galleryOtherVideos` setting (Options, Image gallery card) says what that does to the tiles
  already playing: `mute` (the default) mutes them and they keep playing, so one is heard;
  `pause` pauses them, one plays at a time; `play` leaves them alone, sound and all. In mute
  mode a tile muted for another (`autoMuted`) gets its sound back when it is claimed again, a
  tile the user muted stays silent when resumed and leaves the heard one alone, and a paused
  tile is never muted. The `play` event a tile's own start queues is skipped
  (`ownPlay`): it can run after a later tile took over, and claiming then would take the sound
  back from the tile just started. The big view, close and a re-layout stop every tile: the
  first two pause them all explicitly (`pauseTiles`), since the overlay is only covered or
  hidden, and the browser pauses a tile that a re-layout removes. The big view starts where the
  tile stopped (`tileTime`).
- **Big view:** `.lb-video`, with native controls, replaces `.lb-img` (`showLbMedia`) and starts
  from the beginning with sound; a refused play (no user gesture, as on a slideshow advance)
  retries muted (`lbAutoMuted` unmutes the next video; a mute the user chose stays). It sits above
  the prev/next click bands and stops short of the filmstrip, both of which would otherwise cover
  its controls; Fit width does not apply to it, since filling the width would push its control bar
  under the strip or off screen. The controls report the `<video>` as the click
  target, so the outside-click close excludes it. Every exit (another slide, closing the big
  view, closing the gallery, which only hides the overlay) pauses and unloads it (`stopLbVideo`).
- **Space** plays/pauses on a video slide and is "next" on a picture; arrows stay prev/next.
- **Slideshow:** a non-looping video holds its slide until `ended` (`waitsForEnd`), and
  `applySlideSecsLive` skips such a slide, or a +/- press would fire an overdue dwell mid-video. A
  looping video never ends, so it gets the dwell; so does one that fails to load.
- **Not counted** by `imageCount()`: the toolbar's auto-pick and the reader's "Images · N" badge
  see pictures only, so no page changes mode because of its videos. The gallery's total (the N in
  "0 / N selected") includes video tiles.
- **Downloads:** a single video goes through `chrome.downloads` like a picture (no bytes through
  the worker; a URL without an extension saves as `.mp4`). A ZIP leaves selected videos out and
  says so (`galleryZipVideosSkipped`): the worker returns every file as base64 in one message,
  and a video's megabytes would ride in it.
- **Picture-only paths:** the hide menu offers a video only the URL scopes (`findImgFor` finds no
  `<img>` for it, so "in this spot" is absent), and page-scroll sync on open/close ignores videos
  (a close with a video tile on top restores the saved page spot).

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
matched on the element's avatar/gravatar/emoji **class/id/alt/src/lazy-URL token** OR a **profile-link wrapper
around a small near-square image** — deliberately NOT size-based (album art / product shots are small
squares too). The lazy URL matters because a forum's below-the-fold avatars and emoticons are lazy
`<img>`s with only `data-src`, and a rescued lazy image skips the size filter; two URL shapes cover
them: an avatar CDN host (`//avatar2.site/…`) and an emoticon folder (`/emotion/`, `/smilies/`).
Pinned by `tests/fixtures/forum-lazy-noise.html`. It runs inside `eachGalleryImg`, so `collect()` AND the badge `imageCount()` exclude the
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
`collect()` drops matches (tagging them `hidden` while peeking), and `imageCount()` — the toolbar
auto-pick and the reader's badge — drops the same ones through the shared `urlHidden`/`imgTagged`.
The patterns live in storage and the gallery loads them on open, so each count caller runs
`loadImageFilter()` first; a count taken without it ignores the site's Hide rules and Unhide allows. A **"N hidden · Show"** toolbar
toggle (kept fresh by `mergeNewImages` too, for lazy-hydrating pages) reveals them dimmed with an
Unhide button (manual hides: drops the matching pattern, re-testing `css:` entries against the live
element; auto-hides: stores the `+` allow), plus a one-tap **Undo** on the last hide. The Options page lists + removes
hidden patterns per site (scoped like saved picks) and carries the avatar-toggle checkbox. Only the
gallery is filtered; the reader is untouched.

## Gallery downloads

**Gallery downloads** (one of two network features; the other is the Report page's web form): content scripts can't call `chrome.downloads` or
fetch cross-origin, so `gallery.js` messages `background.js` — `obr-download-one` →
`chrome.downloads.download` (no host perm needed); `obr-fetch-bytes` → SW `fetch` (needs
`host_permissions`, sent with `credentials:'omit'` so no logged-in content is captured; an image
behind a login fails into the per-image "failed" count and can still be single-downloaded) returns base64,
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

