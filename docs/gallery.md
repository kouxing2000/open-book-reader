# Image gallery internals (`src/content/gallery.js`)

> Deep reference, loaded on demand. `CLAUDE.md` holds the always-on architecture map,
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
infinite scroll; restores the user's scroll on `close()`. Demo: `tests/fixtures/lazy-demo.html`.

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

