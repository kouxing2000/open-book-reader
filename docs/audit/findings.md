# Repository audit — findings log

Phase 2 (automated sweeps + static review) of the plan in `plan.md`. Severity scale and the
CONFIRMED / SUSPECTED convention are defined there. Ordered by severity within each area.
Line numbers are as of the v1.8.1 tree.

Nothing here is fixed yet — the audit is read-only until Phase 4.

## Summary

Counts are of NUMBERED entries only. Most areas also carry an unnumbered "done well" list, which
is part of the finding but not a defect.

| area | P0 | P1 | P2 | P3 | Info | entries |
| --- | --- | --- | --- | --- | --- | --- |
| Security | 0 | 0 | 2 | 1 | 1 | S1–S4 |
| Privacy | 0 | 0 | 0 | 2 | 2 | V1–V4 |
| Reliability | 0 | 0 | 1 | 0 | 0 | R1 |
| Process | 0 | 1 | 1 | 1 | 0 | PR1–PR3 |
| Compatibility | 0 | 0 | 0 | 1 | 1 | C1–C2 |
| Maintainability | 0 | 0 | 0 | 1 | 0 | M1 |
| Documentation drift | 0 | 0 | 1 | 3 | 0 | D1–D4 |
| **total** | **0** | **1** | **5** | **9** | **4** | **19** |

One P1, in process, not in the product: a flaky timing assertion is the only gate on the Web Store
release pipeline, and it is currently red on master (PR1). No P0. The shipped code's security
posture is good for what it is (a content script that renders the page's own content in the page's
own origin); the two P2 security items are a hardening gap in the ZIP delivery path and unpinned
CI actions around the release secrets.

## Security

**S1 · P2 · CONFIRMED (channel) / SUSPECTED (end-to-end) — ZIP bytes fetched with host
permissions are handed back into page reach.**
`src/content/gallery.js:127-135` (`saveBlob`) delivers the archive by creating a blob URL, putting
it on an `<a download>` appended to `document.documentElement` (the page's light DOM, not the
Shadow DOM), clicking it, and revoking the URL 10 s later. A blob URL minted by a content script
belongs to the page's origin, and an element attached to the page is observable by page script,
so a hostile page can learn the URL and read the archive during that window. What the archive
contains is whatever the worker fetched: `src/background.js:857-873` (`fetchBytesBase64`) already
restricts to http(s) and omits credentials, but does not reject loopback, link-local or private
address ranges, or non-image responses, and the URLs come from the page (`data-src`, `srcset`,
`<picture><source>` are trusted as the full-size URL at `gallery.js:236-262`, so a decoy thumbnail
can front an unloaded URL). Preconditions for abuse: the user opens the gallery on the hostile
page, clicks Download as ZIP, and either already holds the all-sites grant or approves the host
the page chose. Loot is limited to unauthenticated responses on the user's network. That is why
this is P2, not P1.
Fix, smallest first: (1) do not attach the anchor — a detached anchor click still downloads in
Chromium — or build and download the ZIP in the worker via `chrome.downloads` so bytes never
re-enter the page; (2) in `fetchBytesBase64`, reject `localhost`, `*.localhost`, IP literals in
loopback/link-local/RFC 1918 ranges, and require a `Content-Type` starting with `image/`;
(3) extend `tests/gallery.spec.js` "ZIP download SSRF hardening" to cover both.

**S2 · P2 · CONFIRMED — release workflow runs third-party actions pinned by tag with the Web
Store secrets in scope.**
`.github/workflows/release.yml:29-32,80` uses `actions/checkout@v7`, `actions/setup-node@v6`,
`actions/upload-artifact@v7`; `ci.yml` and `pages.yml` likewise. A moved tag on any of those
would run attacker code in a job whose env holds `CHROME_REFRESH_TOKEN` and the client secret,
which is enough to publish an arbitrary build to every user. Fix: pin every `uses:` to a full
commit SHA (with the tag in a trailing comment) and add a Dependabot config for
`github-actions` so the pins move on purpose. Keep `permissions: contents: write` on the release
job only, as it is today.

**S3 · P3 · CONFIRMED — the content sanitizer is a deny-list.**
`src/content/reader.js:510-535` (`sanitizeContentHTML`) removes script/style/noscript/iframe/form,
inline `on*`, `srcdoc`, and `javascript:` URLs (with the control-character normalisation that the
tests at `reader.spec.js:1151,1170` lock in). It leaves `object`, `embed`, `base`, `meta`, `link`,
`template`, and `style=` attributes with `url()`. Impact is bounded: every sink runs in the page's
own origin — the overlay is a Shadow DOM inside the page (`reader.js:1076`), and the print path
writes into an `about:blank` iframe that inherits the page origin (`reader.js:378-397`) — so a
bypass gives the page nothing it lacks. Worth closing anyway because `base` can redirect relative
links inside the trusted-looking overlay, and the picked-block `rawFallback` path relies on this
function alone (Readability strips `object`/`embed` itself). Fix: switch to an allow-list of
elements and attributes, or at minimum add those elements to the removal set.

**S4 · Info · CONFIRMED — single-image download takes a page-chosen URL and filename.**
`src/background.js:903-906` passes `msg.url` and `msg.filename` straight to
`chrome.downloads.download`. The filename is derived and sanitised on the content side
(`gallery.js:65-84`, `[\w.-]` only, extension forced), and the URL is what the page showed as an
image, so this is equivalent to the page's own `<a download>`; no escalation. Info-level, listed
so the next reviewer does not re-derive it. Consider re-sanitising the filename in the worker so
the guarantee does not depend on the content script.

**Done well (Info)**: no `externally_connectable`, no `web_accessible_resources`, MV3 default
CSP (`manifest.json`); every worker listener registers at top level
(`background.js:396,401,734,745,746,796,830,847,1016,1020`); URL-bearing worker actions use
`sender.tab` / `sender.url`, never the payload (`background.js:1037,1044-1045`); the sentinel is
registered only for origins actually granted (`background.js:640-660`); ZIP grants are derived
per origin from the image URLs, with all-sites only behind an explicit link
(`background.js:917-955`, `permission.js:73-76`); all three input-bearing extension pages render
untrusted values with `textContent` (`report.js:42`, `permission.js:52`, `blocked.js`); no
`eval`/`Function`/`postMessage` anywhere in shipped code; the report page strips query, hash and
non-http schemes from the page URL (`settings.js:328-350`, locked by `extension-load.spec.js:500`).

## Privacy

**V1 · Info · CONFIRMED — the "collects nothing" claim holds against the code.**
Network primitives in shipped code: one `fetch` (`background.js:872`, ZIP bytes, only after a
user click and a grant); a form POST to a public Google Form only when the user clicks Send on the
report page (`report.js:97-104`); `mailto:` navigation (`report.js:91,108`);
`chrome.runtime.setUninstallURL` to the project site (`background.js:828-834`, no parameters);
outbound links on the welcome page. No beacons, sockets, or remote scripts. Each flow is
described on the public privacy page (`site/privacy.html:58-99`). Debug timing writes
`obr_debug` to `storage.local` only (`settings.js:122`).

**V2 · Info · CONFIRMED — storage is bounded and incognito-gated where it should be.**
Every passive per-page write goes through `skipPassiveWrite()` (`settings.js:856,865,877,1085,
1093,1361`; `reader.js:1284`). Positions are LRU-capped (`POSITIONS_MAX`, `settings.js:843`);
sync maps carry byte caps under the 8 KB per-item quota (`PICKS_MAX_BYTES`, `HIDDEN_MAX_BYTES`,
`settings.js:897,954`); writes resolve `false` on `lastError` instead of pretending
(`settings.js:708-712,805,832,1055`).

**V3 · P3 · CONFIRMED — deliberate per-site preferences persist from incognito, by design.**
Saved picks, hidden-image patterns and gallery layout are sync-stored maps keyed by host
(`settings.js:895-1006`) and are not gated, which is the documented intent (CLAUDE.md, incognito
gotcha). The privacy page's "Incognito windows leave no reading record" (`site/privacy.html:87`)
is accurate for reading traces; consider one clause saying that settings you change on purpose
are still remembered, so the wording cannot be read as "nothing at all".

**V4 · P3 · SUSPECTED — `obr_settings` has no byte cap.**
`siteRules` grows with each rule (`settings.js:711` writes the whole object). At roughly 60–100
bytes per rule the 8 KB per-item sync quota lands near 80–100 rules; the write then fails and
`saveSettings` resolves `false`. Whether the options page tells the user is for Phase 3 to check
(`options.js` save paths). Fix if not: surface the failure, and cap or warn near the quota.

## Reliability

**R1 · P2 · SUSPECTED — a slow answer to the permission popup can orphan the download.**
The worker keeps the pending download in module state (`permWaiters`, `permWindowId`,
`background.js:957-1000,1016-1025`) while the popup is open. An MV3 worker idles out after
about 30 s without events; the popup's `obr-perms-result` then reaches a fresh worker with an
empty waiter list, and the content script's pending `sendResponse` channel is gone, so the user's
click on Allow grants the permission but the ZIP never arrives. Phase 3: reproduce with a slow
Allow. Fix: after `obr-perms-result`, re-check `permissions.contains` and have the content script
retry its request when the response is `null`, or persist the pending request in
`storage.session`.

**Done well (Info)**: the four orphaned-context doors and the once-per-page banner are covered
(`reader.spec.js:928,972,1002`, `extension-load.spec.js:553`); silent failures (z-index fights,
host wipe, iframes) have their own spec (`tests/silent-failure.spec.js`); the injection order
carries a paint check and a page-level notice path (`background.js:28-33`).

## Process

**PR1 · P1 · CONFIRMED — master's CI is red, and the failing test is a timing margin sitting on the
release gate.**
`npm test` is the only gate in `release.yml:59` before the Web Store upload. At v1.8.1 (`0d808b1`,
the current HEAD) [CI run 28](https://github.com/kouxing2000/open-book-reader/actions/runs/33322147517)
failed — `reader.spec.js:308` "the soft curl turn floats a transient leaf, then settles to the
plain-flip state", on the first attempt *and* the retry — while
[release run 16](https://github.com/kouxing2000/open-book-reader/actions/runs/33322147166) for the
identical commit passed. The same assertion class already blocked the v1.7.2 release outright
(fixed then for the sibling test at `reader.spec.js:250` by scaling its budget to `TURN_MS * 6`).
Two assertions were left on flat numbers: `reader.spec.js:305` (2000 ms) and `:322` (3000 ms).
Measured teardown of the transient leaf, with `DEFAULTS.pageTurn: 'curl'` and `transitionMs: 340`,
is 1.0–1.5 s for a single turn and 1.5–2.0 s for an interrupted one (probe, `baseline.md` B1) — a
margin under 2×, which a loaded runner erases. Both fail 3/3 in the audit environment.
Consequences: a red master hides a real regression, and a release either fails on a coin flip or
passes on one. Fix: apply the existing `TURN_MS * 6` pattern to both assertions — a leaf that
genuinely leaks is never removed, so the assertion keeps failing closed on the bug it exists to
catch. Then consider whether `endActiveFlip` should also run off a bounded fallback timer rather
than only `leafAnim.finished`, so teardown does not depend on the animation promise settling.

**PR2 · P2 · CONFIRMED — no dependency automation, one known-vulnerable dev dependency.**
No `.github/dependabot.yml` or Renovate config. `npm audit` reports one high-severity advisory
(`brace-expansion`, a transitive dev dependency, denial-of-service only); `npm outdated` shows
`@playwright/test` 1.60 → 1.62, `archiver` 7 → 8, `chrome-webstore-upload` 3.2 → 6, `dotenv` 16
→ 17. Nothing here ships to users, but the release job runs all of it with the Web Store secrets.
Fix: add Dependabot for `npm` and `github-actions`; run `npm audit fix`.

**PR3 · P3 · CONFIRMED — the release job tests what it packages, but from a fresh Playwright
download each run.**
`release.yml:52-59` installs Chromium then runs the suite, then packages, then uploads the same
`dist.zip` it attaches to the GitHub Release; the tag-to-manifest guard runs first (`:41-50`).
This is sound. The only gap is that a Playwright or Chromium release between two tags can change
the test browser under a release with no code change; pinning `@playwright/test` exactly (it is
`^1.49.0` in `package.json`) would make a release build reproducible.

## Compatibility

**C1 · P3 · CONFIRMED — one CSS function newer than the declared minimum.**
`src/welcome.html:28` uses `color-mix()` (Chrome 111) inside a decorative radial gradient;
`manifest.json` declares `minimum_chrome_version: "102"`. On 102–110 the gradient declaration is
dropped and the page still renders. Either replace it with a pre-computed colour or accept and
note it.

**C2 · Info · CONFIRMED — otherwise the code matches the declared minimum.**
A grep of shipped code found no JS API newer than Chrome 102; `inert` (`reader.js`,
`reader.style.js`) is exactly 102; other CSS features used (`inset`, `aspect-ratio`,
`scrollbar-gutter`) predate it. The true minimum is 102 for function and 111 for the welcome
page's decoration.

## Maintainability

**M1 · P3 · CONFIRMED — two engines duplicate their lifecycle scaffolding, and nothing lints.**
`reader.js` (2,544 lines) and `gallery.js` (2,006) each define `open`, `openInner`, `close`,
`toggle`, `build`, `hardTeardown`, `watchCtx`, `applyStylesheet`. There is no ESLint or type
check in the repo, so the parse test in `packaging.spec.js:56` is the only static gate. Fix:
a shared engine-lifecycle helper in `settings.js`, and ESLint plus `// @ts-check` with JSDoc as a
cheap first step (no build needed).

**Done well (Info)**: only two TODO markers in the repo, both template text in
`scripts/package-extension.js:201,205`; no unreferenced shipped file except the two licence
notices, which are shipped on purpose; locale parity is enforced (`verify-locales`: 8 locales,
353 keys each, runs as `pretest`).

## Documentation drift

**D1 · P2 · CONFIRMED — README overstates the ZIP permission.**
`README.md:84` says a ZIP requests `<all_urls>` host access. The code requests only the origins
the selected images live on (`background.js:917-955`); all-sites is an explicit secondary link
on the prompt (`permission.js:69-79`), locked by `extension-load.spec.js:275` and
`options.spec.js:782`. Fix the README (it is also what a store reviewer reads).

**D2 · P3 · CONFIRMED — CLAUDE.md's injection order omits two files.**
CLAUDE.md lists the engine files as settings, readability, reader.style, reader, zip, gallery;
`background.js:21-28` also injects `qrcode.js` (before `reader.js`) and `notice.js` (last).

**D3 · P3 · CONFIRMED — CLAUDE.md's test list omits a spec.**
`tests/silent-failure.spec.js` (7 tests) is not in the Tests section.

**D4 · P3 · CONFIRMED — README's architecture block is stale.**
`README.md:45-58` omits `qrcode.js`, `notice.js`, `_locales/`, and the welcome, report, blocked
and permission pages.

**Done well (Info)**: all 22 function names cited in CLAUDE.md resolve to code; 24 of the 27
`DEFAULTS` keys are surfaced on the options page, and of the three that are not,
`autoAnchorWords` is documented as deliberately hidden (`docs/auto-open-spec.md:354`);
`galleryMinSize` and `transitionMs` are undocumented internals.

## Next (Phase 3)

Verify every SUSPECTED entry above (S1 end-to-end, V4, R1), then the plan's A2–A7 and B3/B6.
PR1 is the one item worth pulling forward out of order: master is red now, and every other finding
is easier to act on against a green baseline.
