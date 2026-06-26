# Open Book Reader — project guide

Chrome MV3 extension, two reading modes: a two-page open-book **text** reader (keyboard
page-flipping) and an **image-gallery** mode (masonry wall + lightbox). Reading is fully local —
no data collected, nothing sent to the developer. The one network case: when the user explicitly
downloads gallery images (needs `downloads` + `host_permissions: <all_urls>` so the service worker
can fetch image bytes cross-origin to build a ZIP).

Zero-dependency, zero-build: Chrome loads `manifest.json` + `src/` + `icons/` directly. Edit files,
reload the unpacked extension. (`package.json`/`scripts/` are release tooling only — never bundled.)

## Architecture

On-demand injection — nothing runs on a page until the user invokes it (toolbar click / `Alt+B`
text / `Alt+Shift+B` images).

```
manifest.json        MV3: action + 2 commands + minimal perms (activeTab, scripting, storage)
src/background.js    service worker — the only always-loaded script; injects the engine on gesture
src/content/
  settings.js        shared globalThis.OBR namespace + DEFAULTS + load/saveSettings (storage.sync)
  readability.js     VENDORED Mozilla Readability (Apache-2.0) — do not edit; see READABILITY-LICENSE.md
  reader.js          TEXT mode: extract → render (Shadow DOM) → paginate (CSS columns) → navigate
  gallery.js         IMAGE mode: collect images → masonry grid + lightbox (Shadow DOM)
src/options/         options page (reuses settings.js)
icons/               16/32/48/128
```

**Injection flow** (`background.js`): on click/command, `executeScript` probes `OBR._engineLoaded`;
if absent, injects the files in order (settings, readability, reader, gallery — settings defines the
namespace, reader needs `DEFAULTS`+`Readability`). Then dispatches: keyboard commands call the
explicit toggle (`OBR.toggle` / `OBR.toggleGallery`); the **toolbar icon** calls `OBR._autoToggle`,
which closes any open mode or auto-picks — gallery only when image-heavy (`_imageCount() >=
autoGalleryMin`, default 10) AND not a real article (`_articleWordCount() < autoTextMinWords`,
default 200), so a substantial article always wins. Only the icon auto-picks; shortcuts honor their
named mode. `_articleWordCount` (`reader.js`) is NOT Readability — it counts words in prose blocks
(`<p>`/`<blockquote>`/`<li>`, ≥20 words each) off the live DOM, so it's cheap and robust.

**Two modes, one namespace**: `reader.js` → `OBR.open/close/toggle` (`#obr-host`); `gallery.js` →
`OBR.openGallery/closeGallery/toggleGallery` (`#obr-gallery-host`). Each is a separate open Shadow
DOM; opening one closes the other; in-overlay buttons switch (🖼 in reader, 📖 in gallery).

**Rendering** (`reader.js`): Readability parses a `document.cloneNode(true)`; output renders into an
open Shadow DOM styled via Constructable Stylesheets (`adoptedStyleSheets`) so strict-CSP sites can't
block layout. Pagination = CSS multi-column: `.obr-pages` is transformed horizontally, "pages" are
columns, a "spread" is N columns-per-view (`columns`: 2/3/4, or 1 below `singlePageBelow`); the
center spine shows only for even N. The ⊞ topbar button cycles 2→3→4.

**Reading progress is a FRACTION, never a spread index** (`reader.js` + `settings.js`). Re-pagination
(font / columns / width) changes how many columns an article splits into, so position is stored as
`(currentSpread * pagesPerSpread) / totalColumns` and `layout()` re-anchors it: font/column changes
pass an explicit `anchorFraction`; **resume** loads the saved fraction into `restoreFraction` and
re-applies it through the late-image settle window until the first user nav clears it. Per-article
positions persist to `chrome.storage.LOCAL` (NOT sync — per-device, can be many, mustn't burn the 8KB
sync quota) as one bounded, LRU-pruned map `obr_positions` keyed by `origin+pathname`. No new
permission — `storage` already covers `storage.local`.

**Lazy / progressive images** (`gallery.js`): collection is placeholder-aware — an `<img>` showing
only a placeholder with a `data-*` lazy URL contributes the lazy URL and skips the size filter
(`eachGalleryImg`, shared by `collect()` / `imageCount()`). A `MutationObserver` + delayed re-collects
live-merge later images (`mergeNewImages`). Since the gallery scroll-locks the page, its lazy loaders
won't fire, so `hydratePage()` scrolls the *real* page in small dwelling steps to trigger native
`loading=lazy` / IntersectionObserver / virtualized rows — on demand (progressive near the grid end,
gated by `galleryAutoLoad`) or fully via **⟳ Load all** (`OBR._galleryRescan`). Bounded against
infinite scroll; restores the user's scroll on `close()`. Demo: `tests/fixtures/lazy-demo.html`.

**Masonry is JS, not CSS multi-column** (`buildColumns`/`placeTile`/`layoutAll`): a flex row of `.col`
divs, each tile appended to the currently-shortest column (estimated by aspect ratio). Required so
incrementally-merged images never re-flow already-placed tiles (CSS `column-*` rebalances all items on
every append, scrambling reading order). `layoutAll` rebuilds only on initial render, column-width
change, or a resize that changes the column count.

**Gallery downloads** (the only network feature): content scripts can't call `chrome.downloads` or
fetch cross-origin, so `gallery.js` messages `background.js` — `obr-download-one` →
`chrome.downloads.download` (no host perm needed); `obr-fetch-bytes` → SW `fetch` (needs
`host_permissions`) returns base64, and the gallery builds the ZIP in-page (`OBR._buildZip`) and saves
it via a blob `<a download>`. Hence `downloads` + `<all_urls>` in the manifest.

**Report a problem** (`settings.js`: `OBR.reportBroken` + the pure, testable `OBR._buildReportMailto`):
the ⚠ Report button opens a prefilled `mailto:` in the user's own mail client — the extension
transmits nothing (the user reviews and sends), so the privacy posture holds. The body carries a
human-readable block + a `[feedback-meta v1]` marker and one JSON line; `pageUrl` is `origin+pathname`
only (query/hash stripped, so no session tokens leak). Deliberately NO usage telemetry — it would flip
the Web Store data disclosure off "none".

## Conventions

- Plain ES (IIFE modules), no build, no deps, no bundler.
- All shared state hangs off `globalThis.OBR` so injected files and the options page share one namespace.
- Settings live in `chrome.storage.sync` under `obr_settings`, merged over `OBR.DEFAULTS` (`settings.js`).
  New setting → add to `DEFAULTS`, and (if user-tunable) to `options.html`/`options.js`.
- Double-injection guards: `reader.js` via `OBR._engineLoaded`, `gallery.js` via `OBR._galleryLoaded`.

## Dev workflow

1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. On any article, click the toolbar icon or press `Alt+B`.
3. After editing: reload the extension card, **then also reload the web page**. `background.js`
   changes need the extension reload; content-script changes (`settings.js`/`reader.js`/`gallery.js`)
   need a page reload — reloading the extension does NOT re-inject into open tabs, and the
   `_engineLoaded` guard skips re-injection. Stale content scripts are the usual "my change didn't
   apply" cause.

No lint config. Final visual verification is manual in the browser.

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
- **Packaging is allowlist-based** (`SHIP_FILES`/`SHIP_DIRS` in `package-extension.js`): only
  `manifest.json`, `icons/`, `src/` ship — dev files can't leak. `READABILITY-LICENSE.md` ships too
  (Apache-2.0 requires it beside the vendored code).
- **Privacy-practices gate**: adding a new permission blocks `publish` until you write its
  justification in the Developer Dashboard (the API can't set it) — the API fails with
  `400 "publish condition not met ... Privacy practices tab"`. Fill it BEFORE pushing a tag that adds
  a permission.
- **Listing copy + IDs**: `store/LISTING.md` (source of truth to paste from). Public site (landing +
  privacy): `site/`, auto-deployed to GitHub Pages on push to `master` via `.github/workflows/pages.yml`
  → https://kouxing2000.github.io/open-book-reader/. Host the privacy policy publicly; note that rendered
  article media still fetch from the origin even though the extension makes no requests.

## Gotchas

- **Do NOT add the `tabs` permission.** The restricted-page guard reads `tab.url` and works without it:
  executing a keyboard shortcut grants `activeTab`, which makes `tab.url` available via
  `chrome.tabs.query`. Adding `tabs` broadens permissions for nothing and is a Web Store review flag.
- `readability.js` is third-party vendored code — keep it pristine; fixes go upstream.
- `reader.js` injects `article.content` (Readability-sanitized HTML) via `innerHTML` into the Shadow
  DOM — the intended trust model (Readability strips scripts). `escapeHTML` covers title/byline only.
- Listeners (`keydown` capture, `resize`) attach once at injection and persist for the tab's lifetime;
  `close()` only hides the host (inert when `!active`). Don't add re-attach logic without also handling
  the double-injection guard.
