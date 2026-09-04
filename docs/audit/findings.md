# Repository audit — findings log

Phase 2 (automated sweeps + static review) of the plan in `plan.md`. Severity scale and the
CONFIRMED / SUSPECTED convention are defined there. Ordered by severity within each area.
Line numbers are as of the v1.8.1 tree.

The audit is read-only through Phase 3 by design; entries marked **FIXED** are the deliberate
exceptions `plan.md` records, each carrying its own verification.

## Summary

Counts are of NUMBERED entries only. Most areas also carry an unnumbered "done well" list, which
is part of the finding but not a defect. \* Marks a row containing **fixed** entries — fixed
findings stay counted so the tally matches the entries below. Fixed so far: PR1, PR2, S1, S2, R1,
C1, C3, D1–D4.

| area | P0 | P1 | P2 | P3 | Info | entries |
| --- | --- | --- | --- | --- | --- | --- |
| Security | 0 | 0 | 2* | 1 | 1 | S1–S4 |
| Privacy | 0 | 0 | 0 | 1 | 3 | V1–V4 |
| Reliability | 0 | 0 | 1* | 0 | 0 | R1 |
| Process | 0 | 1* | 1* | 1 | 0 | PR1–PR3 |
| Compatibility | 0 | 0 | 0 | 2* | 1 | C1–C3 |
| Maintainability | 0 | 0 | 0 | 1 | 0 | M1 |
| Documentation drift | 0 | 0 | 1* | 3* | 0 | D1–D4 |
| **total** | **0** | **1** | **5** | **9** | **5** | **20** |

One P1, in process, not in the product: a flaky timing assertion was the only gate on the Web Store
release pipeline and was red on master — **fixed** (PR1). No P0. The shipped code's security
posture is good for what it is (a content script that renders the page's own content in the page's
own origin); both P2 security items — the ZIP delivery path and the unpinned CI actions around the
release secrets — are now **fixed**, leaving S3 (a deny-list sanitizer, bounded impact) as the only
open security entry.

## Security

**S1 · P2 · CONFIRMED — FIXED 2026-09-03 — ZIP bytes fetched with host permissions are handed
back into page reach.**
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
**Fixed** in three parts, and one proposed part deliberately dropped:

1. `saveBlob` no longer appends the anchor. The detached-click assumption was probed before
   the change, not assumed: a detached `<a download>` click downloads in Chromium and
   `document.contains(a)` stays false.
2. `isBlockedHost` (`background.js`) rejects `localhost`, `*.localhost`/`.local`/`.internal`/
   `.home.arpa`, and **every bare IP literal**, v4 or v6 — checked **before** the request and
   again against `res.url` after it. The post-check is not belt-and-braces: `fetch` follows
   redirects by default and `redirect:'manual'` yields an opaque response with no readable
   `Location`, so a public URL that 302s to `127.0.0.1` is catchable only on the far side.

   The first draft was a per-range table (RFC 1918, CGNAT, link-local, unique-local,
   IPv4-mapped IPv6, multicast). Review found four defects in it — `fec0::/10` unblocked,
   `::127.0.0.1` and `::ffff:0:7f00:1` unblocked, and `192.0.0.0/16` blocked where the
   comment claimed `/24`, ~65k public addresses. The table existed only to keep **public**
   bare-IP image hosts working, which is close to nonexistent on the real web, and that one
   allowance was what made the predicate hard to get right. Refusing every IP literal is two
   lines, strictly stronger, and has no tail of future IANA special-purpose ranges. The
   intranet/NAS case it appears to threaten is carried by (3), not by the table.
3. `isBlockedTarget` exempts one host: the **tab's own**. A page can already read images on
   its own host (`<img>` needs no permission and no CORS), so refusing them buys no security
   and would break reading a page served from localhost, an intranet name, or a NAS at a bare
   IP — the whole class of false positive the blanket rule otherwise creates, and the reason
   (2) can afford to be blunt. Host-scoped, ports ignored, matching how
   host permissions are scoped; the exemption rides through the redirect check too, so an
   intranet page still cannot pivot to a neighbouring host.

   The trust boundary is that `ownHost` comes from `sender.url`/`sender.tab.url` and never
   from `msg`, which the page controls. `runDownload` therefore takes the raw `sender` and
   calls `senderHost` itself rather than accepting a host from its caller — that removes the
   seam entirely instead of testing it, and hand it the wrong object and it yields `''`,
   which means no exemption rather than a wide one.
4. `text/html` responses are refused.

**Dropped: the proposed `Content-Type: image/*` requirement.** S3 and several CDNs serve real
images as `application/octet-stream`, so demanding `image/*` would fail legitimate downloads to
close a gap (2) already covers — the exfiltration value of a non-image response comes from
reaching a non-public host, which is now blocked outright. A pinned test asserts an
octet-stream image still succeeds, so the decision can't be quietly reversed.

**Still not covered: DNS rebinding** — a public hostname whose A record answers `127.0.0.1`.
Blocking it needs the resolved address, which no extension API exposes.

Also fixed alongside: `permsFor` now filters the origin list through `isBlockedTarget`, so a page
cannot get a private address RENDERED to the user inside the extension's own permission prompt,
and cannot buy a grant the fetch would refuse. It filters by target rather than by host so the
tab's own bare-IP host keeps the grant the exemption needs. And the single-image path
(`obr-download-one`) gained a **protocol allowlist only** — not the host guard: it hands the URL
to `chrome.downloads`, which fetches as the browser with the user's own cookies, so an http(s)
target is what right-click → Save image already does, while `file:` is readable by the browser
and not by the page.

Tests (`gallery.spec.js`): the host table across every notation Chrome canonicalises — including
named hosts that merely LOOK local (`localhostage.example`, `192.168.1.1.example.com`), which pin
that the rule matches a host and not a substring — refusal **before any request leaves the
worker**, the redirect re-check, the same-host exemption and its limits, `senderHost`
normalisation, the `text/html` refusal, the octet-stream acceptance, the two `permsFor` filtering
cases, and a MutationObserver assertion that no `<a download>` ever enters the page DOM during a
real ZIP. The last one sits on the DELIVERY step, not on the ZIP writer, which is where the
defect was.

Mutation-proven in four directions: re-attaching the anchor fails the observer test; removing the
pre-flight check fails the pre-flight test; deleting the same-host exemption fails the exemption
test; and granting it unconditionally fails four tests, so the exemption cannot silently widen.

Two facts the URL parser contributed, both found by the tests rather than by reading: `hostname`
serializes an IPv6 host **with** its brackets, and it compresses an IPv4-mapped address into hex
groups (`::ffff:127.0.0.1` arrives as `::ffff:7f00:1`). Only the first still matters — `normHost`
strips the brackets — because the blanket rule never has to decode what an IPv6 literal MEANS.

**S2 · P2 · CONFIRMED — FIXED 2026-09-03 — release workflow runs third-party actions pinned by
tag with the Web Store secrets in scope.**
`.github/workflows/release.yml:29-32,80` uses `actions/checkout@v7`, `actions/setup-node@v6`,
`actions/upload-artifact@v7`; `ci.yml` and `pages.yml` likewise. A moved tag on any of those
would run attacker code in a job whose env holds `CHROME_REFRESH_TOKEN` and the client secret,
which is enough to publish an arbitrary build to every user. **Fixed:** all nine `uses:` across
the three workflows are pinned to full commit SHAs with the tag in a trailing comment, and PR2's
Dependabot `github-actions` entry moves the pins on purpose. The invariant is stated once, in
`release.yml` beside the job that actually holds the secrets. `permissions: contents: write`
stays on the release job only, as before.

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

**V4 · Info · RESOLVED 2026-09-04 (was P3 · SUSPECTED) — `obr_settings` has no byte cap.**
The entry's own open question — *"Whether the options page tells the user is for Phase 3 to
check"* — is answered in the code: `options.js:43` `flashSaved(ok)` renders `optSaveFailed`, not
the dishonest "Saved ✓", whenever `saveSettings` resolves `false`, and the comment at `:41` says
that was the intent. So this is a visible wall at roughly 80–100 site rules, not silent data
loss. Downgraded to Info; a proactive cap for a limit no real user reaches is not worth the code.
Original analysis follows.
`siteRules` grows with each rule (`settings.js:711` writes the whole object). At roughly 60–100
bytes per rule the 8 KB per-item sync quota lands near 80–100 rules; the write then fails and
`saveSettings` resolves `false`. Whether the options page tells the user is for Phase 3 to check
(`options.js` save paths). Fix if not: surface the failure, and cap or warn near the quota.

## Reliability

**R1 · P2 · CONFIRMED — FIXED 2026-09-04 — a slow answer to the permission popup orphans the
download.**
The worker keeps the pending download in module state (`permWaiters`, `permWindowId`,
`background.js:957-1000,1016-1025`) while the popup is open. An MV3 worker idles out after
about 30 s without events; the popup's `obr-perms-result` then reaches a fresh worker with an
empty waiter list, and the content script's pending `sendResponse` channel is gone, so the user's
click on Allow grants the permission but the ZIP never arrives.

**Upgraded to CONFIRMED without needing the repro**, because every link in the chain is
readable: `permWaiters` is plain module state, `permission.js:37` sends one fire-and-forget
message and closes, and **no content script had an `onMessage` listener at all** — so the
`sendResponse` channel was the only path back to the page, and it dies with the worker. The
page then reported **"Download failed"** while the request was still perfectly alive, which is
the part a user acts on.

**Fixed by surviving the restart rather than by preventing it.** Two other approaches were
weighed and rejected: holding a port open from the permission page, and heartbeating the worker
while waiters pend. Both work by keeping the worker alive, and neither is verifiable here — a
debugger attached over CDP keeps a service worker alive regardless, so any lifetime test would
return a green that means nothing. A fix that survives the worker dying is correct either way,
and cannot silently regress when Chrome changes a lifetime rule. The same constraint bounds the
tests: the trigger cannot be produced here, but what the PAGE sees when it fires — `sendMessage`
answering `undefined` — reproduces exactly, and that is the whole input to the fixed path.

**The first implementation of that idea was wrong, and its replacement is smaller.** It parked the
request payload in `storage.session` and pushed the result back via `chrome.tabs.sendMessage`,
which meant two delivery paths and a `live` tab set to de-duplicate them. Review found two P1
defects in that seam. (a) `permission.js:35` closes the popup INSIDE the `obr-perms-result`
response callback, so `resolveWaiters` had already nulled `permWindowId` by the time
`windows.onRemoved` fired; the fallback branch then flushed with no `live` set and the download
ran twice — a second full fetch of every image, or a duplicate file on disk. (b) That same branch
fired on ANY window closing, so an unrelated window closed during the prompt delivered a denial
and the later Allow click resumed nothing: R1's own bug, reintroduced. A third defect was scope,
not logic — `pendingKey` was one key per TAB, so the N parallel requests of "Save selected"
overwrote each other, and nothing anywhere listened for the `obr-download-one-result` the worker
pushed. R1 was fixed for ZIP only while the CHANGELOG claimed it whole.

**Shipped shape: the page holds the request; the worker holds nothing.** The only thing that must
cross the worker's death is the GRANT, and `chrome.permissions` already stores that durably. The
request's owner — the content script — was never at risk, so on a `null` response it re-sends the
same message with `noPrompt`, meaning "answer from permission state, never open a second popup".
The worker replies `{pending:true}` until `contains` is true, then runs the download and answers
down that live channel (`gallery.js: retryUntilAnswered`, 2 s cadence, 2 min ceiling).

That is ~130 lines lighter and deletes the defects rather than patching them: ONE delivery path,
so there is nothing to de-duplicate; one request per message, so parallel downloads cannot
collide; a live `sender` on every retry, so S1's exemption is never re-derived from stored state;
and no worker→page direction at all, so no content script needs an `onMessage` listener. The
`windows.onRemoved` handler is back to recognising only its own popup. `noPrompt` is
page-controlled but can only SUPPRESS a prompt — it reduces privilege, never raises it. Cost:
dismissing the prompt is no longer instant, it waits out the ceiling.

Tests (`gallery.spec.js`): page-side, a dead channel that retries rather than reporting failure
(asserting the first ask may prompt and no retry may), a `{pending:true}` answer that keeps
waiting, and every image of a Save-selected batch surviving; worker-side, against the REAL worker
from a real extension page, that `noPrompt` returns `{pending:true}` and opens **zero** windows —
because `noPrompt` is a contract between two files and a shim can only confirm the half that
wrote it. Six mutations, all red: dropping the retry, dropping the `pending` check, dropping the
`noPrompt` flag, dropping the worker's `noPrompt` branch, and both `permsFor` filter variants.

Fixed alongside, because the new waiting state exposed it: `setStatus` now cancels any pending
auto-clear. A timer armed by the gallery's hydration message used to blank the status bar ~2.5 s
in, which mattered little for a message that lasted 4 s and matters a lot for "Waiting for
permission…", which stays up as long as someone takes to answer.

**Done well (Info)**: the four orphaned-context doors and the once-per-page banner are covered
(`reader.spec.js:928,972,1002`, `extension-load.spec.js:553`); silent failures (z-index fights,
host wipe, iframes) have their own spec (`tests/silent-failure.spec.js`); the injection order
carries a paint check and a page-level notice path (`background.js:28-33`).

## Process

**PR1 · P1 · CONFIRMED — FIXED 2026-09-02 — master's CI is red, and the failing test is a timing
margin sitting on the release gate.**
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
passes on one. **Fixed** in `tests/reader.spec.js`: there were **three** flat budgets, not two — the
"book turn settles" assertion had the same defect and had simply not failed yet. All three now use
one shared `LEAF_TEARDOWN_MS = TURN_MS * 6`, and each test pins its own transition to `TURN_MS` so
the budget is a multiple of a known turn rather than a flat number against whatever the defaults
are. Absolute headroom over the animation goes from ~2.2s to ~4.9s on the curl paths.

Verified three ways: the four assertions pass 3/3 in isolation; the full suite goes from 6 failures
to 1 (the headless-focus artifact B2, which is not a defect); and **fail-closed was proven by
mutation** — with `f.layer.remove()` disabled in `endActiveFlip()` (`reader.js:2084`), all four
assertions fail, so the generous ceiling costs no sensitivity.

**No engine change.** The evidence does not show a leak: the leaf *is* removed, just later than a
tight budget allowed. The Phase 2 note suggesting a bounded fallback timer in `endActiveFlip` is
therefore withdrawn — adding one would risk cancelling a legitimately-running animation to fix a
problem that only existed in the test.

**PR2 · P2 · CONFIRMED — FIXED 2026-09-03 — no dependency automation, one known-vulnerable dev
dependency.**
No `.github/dependabot.yml` or Renovate config. `npm audit` reports one high-severity advisory
(`brace-expansion`, a transitive dev dependency, denial-of-service only); `npm outdated` shows
`@playwright/test` 1.60 → 1.62, `archiver` 7 → 8, `chrome-webstore-upload` 3.2 → 6, `dotenv` 16
→ 17. Nothing here ships to users, but the release job runs all of it with the Web Store secrets.
Fixed: `.github/dependabot.yml` covers both ecosystems, weekly and grouped so a solo maintainer
gets one PR per ecosystem rather than a stream; `npm audit fix` moved `brace-expansion`
**2.1.1 → 2.1.4** with no direct dependency change (Playwright stays 1.60), and `npm audit` now
reports 0 vulnerabilities. (npm also normalised two unrelated lockfile fields in the same run: it
added the root `license` field and dropped a stale `peer: true` marker.) This also makes S2 cheaper: once the actions are SHA-pinned, Dependabot
maintains the pins.

**PR3 · P3 · CONFIRMED — the release job tests what it packages, but from a fresh Playwright
download each run.**
`release.yml:52-59` installs Chromium then runs the suite, then packages, then uploads the same
`dist.zip` it attaches to the GitHub Release; the tag-to-manifest guard runs first (`:41-50`).
This is sound. The only gap is that a Playwright or Chromium release between two tags can change
the test browser under a release with no code change; pinning `@playwright/test` exactly (it is
`^1.49.0` in `package.json`) would make a release build reproducible.

## Compatibility

**C1 · P3 · CONFIRMED — FIXED 2026-09-03 — one CSS function newer than the declared minimum.**
`src/welcome.html:28` used `color-mix()` (Chrome 111) inside a decorative radial gradient;
`manifest.json` declares `minimum_chrome_version: "102"`. The first write-up understated this: the
call sat inside a `background:` **shorthand** carrying two layers, and an unsupported value drops
the WHOLE declaration — so on Chrome 102–110 the first-run page lost `var(--paper)` too, not just
the gradient. Fixed by precomputing `--card` at 80% alpha into a `--glow` variable per theme, which
needs nothing newer than custom properties (Chrome 49).

**C3 · P3 · CONFIRMED — FIXED 2026-09-03 — `:has()` sits in a selector list on the options page.**
`src/options/options.html:42` had `details.card .row:last-child, details.card .row:has(+ .subhead)`
in one rule. `:has()` is Chrome 105 against the declared floor of 102, and a selector **list** is
unforgiving — one unsupported compound invalidates the whole list — so on 102–104 the
`:last-child` half was dropped too and the last row in every card kept a doubled border. Same
mechanism as C1 (an unsupported token taking its neighbour down with it), a different language
construct. Fixed by splitting the list into two rules, which keeps `:has()` as the progressive
enhancement it was meant to be.

**C2 · Info · CORRECTED 2026-09-03 — the rest of the shipped code matches the declared minimum.**
As first written this entry claimed the sweep was complete; it was not. It grepped for
`color-mix()` after C1 rather than enumerating features against the 102 floor, and `:has()` was
sitting one file away — see C3. Presence of one feature was never evidence about the others.
Re-checked properly: no JS API newer than Chrome 102; `inert` (`reader.js`, `reader.style.js`) is
exactly 102; `inset`, `aspect-ratio` and `scrollbar-gutter` predate it. `site/` is out of this
entry's scope — it is not shipped in the package and has no min-Chrome contract, though
`site/uninstall.html` uses both `color-mix()` and `:has()` and loses its background below 111.

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

**D1 · P2 · CONFIRMED — FIXED 2026-09-03 — README overstates the ZIP permission.**
`README.md:84` says a ZIP requests `<all_urls>` host access. The code requests only the origins
the selected images live on (`background.js:917-955`); all-sites is an explicit secondary link
on the prompt (`permission.js:69-79`), locked by `extension-load.spec.js:275` and
`options.spec.js:782`. Fix the README (it is also what a store reviewer reads).

**D2 · P3 · CONFIRMED — FIXED 2026-09-03 — CLAUDE.md's injection order omits two files.**
CLAUDE.md lists the engine files as settings, readability, reader.style, reader, zip, gallery;
`background.js:21-28` also injects `qrcode.js` (before `reader.js`) and `notice.js` (last).

**D3 · P3 · CONFIRMED — FIXED 2026-09-03 — CLAUDE.md's test list omits a spec.**
`tests/silent-failure.spec.js` (7 tests) is not in the Tests section.

**D4 · P3 · CONFIRMED — FIXED 2026-09-03 — README's architecture block is stale.**
`README.md:45-58` omits `qrcode.js`, `notice.js`, `_locales/`, and the welcome, report, blocked
and permission pages.

**Done well (Info)**: all 22 function names cited in CLAUDE.md resolve to code; 24 of the 27
`DEFAULTS` keys are surfaced on the options page, and of the three that are not,
`autoAnchorWords` is documented as deliberately hidden (`docs/auto-open-spec.md:354`);
`galleryMinSize` and `transitionMs` are undocumented internals.

## Extraction (Phase 3 track A4)

Full report: **`sweep-2026-09-04.md`** — 42 real URLs through the real engine. 30 PASS, 0 FAIL;
extraction itself is in good shape (Wikipedia clean across en/zh/ja/ko/ar/he, RTL fine, a
127k-word Gutenberg book intact). The defects are in the heuristics AROUND extraction.

**A4-1 · P2 · CONFIRMED — a div-paragraph article loses the toolbar icon's auto-pick.**
`_proseStats` counts only leaf `p`/`blockquote`/`li`, so an article whose body copy sits in
`<div>`s reports ZERO prose words. Measured: `paulgraham.com/greatwork.html` extracts 11,619
words with `_proseStats().words === 0`. That feeds `_autoToggle`'s "not a real article" test,
so an image-bearing page of this shape opens the GALLERY on a long read. Reproduced with a
fixture + test, not inferred. CLAUDE.md's "a substantial article always wins" was false and is
corrected. Fix wants a decision — both candidate widenings loosen a heuristic that currently
has a clean false-positive record.

**A4-2 · P3 · CONFIRMED — the "extraction looks wrong" nag fires on correct extractions.**
Asked for the engine's own `_wholeExtractionSuspect` verdict, it fires on 2 of 42 rows, both
Ars Technica, both on complete and correct extractions — the comment-heavy-page false positive
the code comment already predicts. The comment calls it acceptable; the sweep supplies the
missing rate, which on that site is every article. Not fixed: tightening the ratio trades these
for false negatives on the truncation cases the nag exists to catch.

**A4-3 · Info · FIXED — the manual site proxy had no `chrome.i18n` shim**, so `OBR.t()` echoed
raw keys and the overlay rendered `colophonTheEnd` as visible text into every measurement.

**A4-4 · Info · method — a site list rots, and a 404 page extracts beautifully.** 11 of 42 URLs
were dead or bot-walled on the first run and several scored PASS. The runner now classifies
`DEADURL`/`BOTWALL` from the page's own title before scoring, since most sites serve a 404 body
with HTTP 200.

## Next (Phase 3)

Verify the remaining SUSPECTED entry (V4 — see below), then the plan's A2–A7 and B3/B6. **A4, the
real-site extraction sweep, is the highest-value work left**: everything fixed so far is process,
docs, CSS or hardening — nothing has yet tested extraction quality, which is the product.

Fixed so far: PR1, PR2, S1, S2, R1, C1, C3, D1–D4, A4-3. Still open: A4-1, A4-2, S3, V3, PR3, M1 — plus every
Phase 3 track. V4 is downgraded to Info: its open question (does the options page tell the user a
save failed?) is answered in the code — `options.js:43` renders `optSaveFailed`, so the quota
limit is a visible wall at ~80–100 rules, not silent loss.
