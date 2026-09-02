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
enabled per-site **auto-open** (its registered sentinel is the only pre-gesture code;
see `docs/auto-open-spec.md`).

```
manifest.json        MV3: action + 2 commands + minimal perms (activeTab, scripting, storage, contextMenus)
                     `name` is the ASO-tuned store title (long, keyword-bearing); `short_name`
                     ("Open Book", ≤12 chars) is what Chrome shows where space is tight —
                     toolbar, chrome://extensions. Keep it, or the store title leaks into the UI.
src/background.js    service worker — the only always-loaded script; injects the engine on gesture
src/content/
  settings.js        shared globalThis.OBR namespace + DEFAULTS + load/saveSettings (storage.sync)
  readability.js     VENDORED Mozilla Readability (Apache-2.0) — do not edit; see READABILITY-LICENSE.md
  reader.style.js    reader stylesheet as a JS string (OBR._readerCSS) — injected before reader.js
  qrcode.js          VENDORED qrcode-generator (MIT) — do not edit; the print-branding QR; see QRCODE-LICENSE.md
  reader.js          TEXT mode: extract → render (Shadow DOM) → paginate (CSS columns) → navigate → print/PDF
  zip.js             minimal ZIP writer (OBR._buildZip) — used by the gallery's "Download as ZIP"
  gallery.js         IMAGE mode: collect images → Wall masonry / Ordered rows + lightbox (Shadow DOM)
  notice.js          page-level banner (OBR._notice) — the one feedback surface for when the
                     reader's own UI can't be trusted (covered / host deleted / orphaned world).
                     Pure DOM, no chrome.*, no i18n: strings arrive pre-resolved from the caller
  sentinel.js        AUTO-OPEN sentinel — the ONLY pre-gesture code, and only on sites the user
                     enabled auto-open for (registered by the SW; see docs/auto-open-spec.md)
src/options/         options page (reuses settings.js)
src/welcome.html     first-run activation page — onInstalled opens it (pin icon, shortcuts, sample article)
src/report.html      ⚠ Report page (bundled, offline) — email OR a web form; opened via the SW relay
src/blocked.html     "not available on this page" (paired blocked.js) — armed per-tab as the
                     ACTION POPUP on a blocked trigger, so the dead icon click gets an answer;
                     also opened once per profile as a tab (?first=1). Offers Report on a SOFT block
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

**Rendering** (`reader.js`): Readability parses a `document.cloneNode(true)`; output renders into an
open Shadow DOM styled via Constructable Stylesheets (`adoptedStyleSheets`) so strict-CSP sites can't
block layout. Pagination = CSS multi-column: `.obr-pages` is transformed horizontally, "pages" are
columns, a "spread" is N columns-per-view (`columns`: 2/3/4, or 1 below `singlePageBelow`); the
center spine shows only for even N. The ⊞ topbar button cycles 2→3→4.

**Deep dives live in `docs/` and load on demand — keep them OUT of this file.** CLAUDE.md is read
on every turn of every session, so it carries only what you can get wrong *without* opening the
relevant file: the safety rules, the map, and the cross-cutting gotchas. Detail that only matters
while editing a feature belongs beside that feature.

| area | doc |
| --- | --- |
| Text reader — pagination, page-turn animation, print/PDF, progress fractions, content override (selection / picker / saved pick), tall-figure fitting, image sizing, why there is no text-wrap-around-image | `docs/reader.md` |
| Image gallery — lazy hydration, Wall + Ordered layouts, lightbox, avatar/noise filter, ZIP downloads | `docs/gallery.md` |
| Auto-open — the sentinel's decision ladder, permission model, registration | `docs/auto-open-spec.md` |
| Service worker — context-menu + sentinel-registration serialization, debug timing and trigger tracing | `docs/background-worker.md` |
| Welcome, colophon + rating ask, report page, feedback pipeline | `docs/engagement.md` |
| Repository audit — plan, test baseline + claims inventory, findings log | `docs/audit/` |

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

**Debug timing — "why is opening slow?"** `OBR.debugTiming(true)` (easiest from the Options page
console, where `OBR` is in the main world) turns on per-phase timing in the reader/gallery plus
service-worker trigger tracing — the answer to "did my click even reach the worker?". LOCAL-only
and off by default: the flag lives in `chrome.storage.local`, is never synced, and nothing is ever
sent anywhere — keep it that way, shipping numbers off-device would flip the "collects nothing"
Web Store disclosure. Full reference: `docs/background-worker.md`.

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
- **Two macOS-only harness hangs, both handled in `tests/fixtures.js` — don't re-diagnose them, and don't
  "fix" them by reinstalling browsers or moving Playwright versions (Linux CI is green on the same one).**
  (1) `Tearing down "context" exceeded the test timeout` on EVERY test: Chromium ignores Playwright's
  graceful SIGTERM and never exits (reproduced with a bare `spawn` + kill, across three bundled builds —
  it dies only on SIGKILL), so `context.close()` never settles. The fixture bounds the close, then
  hard-kills by the context's unique `--user-data-dir`. (2) A bare 30s timeout with no stack in any test
  taking the `serviceWorker` fixture: evaluating in an MV3 worker Chrome hasn't started does not throw,
  it HANGS forever. The fixture starts the worker first (load a page in the extension's own origin,
  fire one throwaway evaluate, load again) and only hands it over once it answers.

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
npm run screenshots      # store images + the 1280x720 video thumbnails → store-assets/ (gitignored)
npm run promo            # promo video + flip mp4/gif, from ONE recording → store-assets/
npm run ranking          # store-search rank per keyword/locale → metrics/ (gitignored)
```

- **Marketing-asset capture** (`npm run screenshots` / `npm run promo`) drives the REAL unpacked
  extension through Playwright — never a mockup. Both share `scripts/lib/capture-harness.mjs`;
  get the page from its `preparePage(ctx)` and never build one by hand, because that is what
  applies the `chrome.storage` **and `chrome.i18n`** shims. Without the i18n shim the injected
  main-world scripts have no `chrome.i18n`, so `OBR.t()` echoes the raw key and any asset
  showing the reader's toolbar renders `readerBtnThemeLabel` / `readerPageIndicator` as visible
  text — it has already shipped that way once. `npm run promo` cuts all three video artifacts
  out of a single recording, so the storyboard's forward-then-back flips are also what makes
  the GIF loop seamlessly; don't split them back apart.

- **Measuring an ASO/title change** → `npm run ranking` before and after, and read
  `scripts/check-store-ranking.mjs`'s header first. It documents the trap that already cost
  one bogus "we're absent from search" conclusion: parse rank from `data-item-id`, never from
  the result URL (our slug contains `%E2%80%94`, the encoded em dash, which naive character
  classes silently skip), and always cross-check the raw body for the extension id — a parser
  that yields empty on an unmatched shape looks exactly like a genuine absence. The script
  fails loudly on that mismatch instead of reporting a clean zero.

- **Tag-driven CI release** (`.github/workflows/release.yml`): `npm run bump -- minor` (or
  `patch`/`major`/`X.Y.Z`), then `git push --follow-tags`. Pushing a `v*` tag runs the suite, packages,
  uploads, and submits for review (`AUTO_PUBLISH='true'`) — the pushed tag is the release gesture; the
  version goes live once Google's review passes. The store rejects any non-incremented version, so the
  bump is mandatory; `bump-version.mjs` is its single source (don't hand-edit the two version fields).
  CI re-verifies the tag matches `manifest.json`. Repo secrets:
  `CHROME_EXTENSION_ID`/`CLIENT_ID`/`CLIENT_SECRET`/`REFRESH_TOKEN` (account-scoped — only the
  extension ID differs per extension).
- **A tag push runs the workflow file from THAT TAG's tree, not from `master`.** So a guard added to
  `release.yml` today protects nothing on an older tag that gets re-pushed or moved — every existing
  `v*` tag carries its own copy of the workflow as it was when that tag was cut. Consequence: before
  moving or re-pushing any `v*` tag, `gh workflow disable "Release to Chrome Web Store"` first (and
  re-enable after); editing `master`'s workflow is not a substitute. `master` is also protected by two
  zero-bypass rulesets (`deletion` + `non_fast_forward`) on the default branch and on `refs/tags/v*`.
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
  `manifest.json`, `icons/`, `src/`, `_locales/` ship — dev files can't leak. `_locales/` is
  load-bearing, not optional: every `__MSG_*__` in the manifest (name, description, command
  descriptions) resolves from it, so the store title/summary are PACKAGE data — there is no
  dashboard field for them and only a release can change them. `READABILITY-LICENSE.md` and
  `QRCODE-LICENSE.md` ship too (both live under `src/content/`, and the licenses require the notice
  beside the vendored code).
- **Privacy-practices gate**: adding a new permission blocks `publish` until you write its
  justification in the Developer Dashboard (the API can't set it) — the API fails with
  `400 "publish condition not met ... Privacy practices tab"`. Fill it BEFORE pushing a tag that adds
  a permission.
- **Listing copy + IDs**: `.meta/LISTING.md` (gitignored — kept out of this public repo per RULE #1;
  source of truth to paste from), with the localized detailed descriptions in `.meta/listings/<lang>.txt`. Public site (landing +
  privacy): `site/`, auto-deployed to GitHub Pages on push to `master` via `.github/workflows/pages.yml`
  → https://openbook.peach-studio.com/. The custom domain is a repo **Settings → Pages** field, NOT a
  `CNAME` file — a workflow-published site ignores that file entirely. It serves the repo at the DOMAIN
  ROOT, so root-absolute paths in `site/` are `/…`, never `/open-book-reader/…`; the old `github.io`
  URL 301s here. Host the privacy policy publicly; note that rendered
  article media still fetch from the origin even though the extension makes no requests.

## Gotchas

These are the CROSS-CUTTING ones — the rules you can break without ever opening the file they
belong to. Feature-local gotchas live with their feature in `docs/` (see the table above).

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

- **An extension reload ORPHANS this page's engine, and the worker cannot see it.** The old
  overlay stays on screen and fully interactive while every `chrome.*` in that world throws
  ("Extension context invalidated"); a click on it never reaches the service worker, so
  background.js's own orphan probe — which only runs on a fresh trigger — is blind to it. Detection
  therefore lives in the page: `OBR._ctxDead()` (settings.js; `died` requires having `lived`, so it
  is inert in the Playwright harness and the manual site proxy, which never had a context) guards
  **four doors** — `open()`, a capture-phase click listener on each host, each engine's `keydown`,
  and a 3s `watchCtx` interval — and `OBR._ctxLost(teardown)` retires the overlay and draws the
  banner. Guard the DOORS, never the individual `chrome.*` calls: that list has no end, and nothing
  behind a door runs unless a door opens. Three rules hold the design together: each engine's
  `hardTeardown()` must stay free of `chrome.*` (the normal `close()` flushes state through
  `chrome.storage`, which is exactly what is broken); the teardown runs on EVERY retire while only
  the console warn is once-per-page (guarding the teardown behind that flag stranded a second
  overlay on screen, unclosable, on a scroll-locked page); and the banner's strings are snapshotted
  at injection into `OBR._deadStrings`, because `OBR.t` cannot run once the context is dead.
- Listeners (`keydown` capture, `resize`) attach once at injection and persist for the tab's lifetime;
  `close()` only hides the host (inert when `!active`). Don't add re-attach logic without also handling
  the double-injection guard.

- **NEVER put a backtick in `reader.style.js` — the whole stylesheet is one JS template literal.**
  `OBR._readerCSS()` returns the entire reader CSS as a backticked string, so a stray backtick
  inside a *CSS comment* (writing a property or attribute name in prose) closes the string early
  and the file dies with `SyntaxError: Invalid or unexpected token`. The symptom is remote from the
  cause: the file simply never defines `_readerCSS`, and the reader throws
  `OBR._readerCSS is not a function` from `applyStylesheet()`. This has bitten three times — write
  such names as plain words (`the style attribute`, `minus-3em`), never quoted with backticks.
  Guarded by the `every shipped script parses` test in `packaging.spec.js`, which is the fast-fail
  nothing else in the suite provided. It parses each file with `new vm.Script`, NOT `node --check`:
  package.json is `"type": "module"`, so `node --check` would apply the ESM goal to files that ship
  as CLASSIC scripts (wrong goal, wrong answer in both directions). It walks the `src/` filesystem
  rather than `git ls-files`, so a newly added, not-yet-staged script is covered too.
