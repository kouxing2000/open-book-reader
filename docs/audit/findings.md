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
C1, C3, D1–D4, A4-3, A3-1, A3-2, A3-3.

| area | P0 | P1 | P2 | P3 | Info | entries |
| --- | --- | --- | --- | --- | --- | --- |
| Security | 0 | 0 | 2* | 1 | 1 | S1–S4 |
| Privacy | 0 | 0 | 0 | 1 | 3 | V1–V4 |
| Reliability | 0 | 0 | 1* | 0 | 0 | R1 |
| Process | 0 | 1* | 2* | 1 | 0 | PR1–PR4 |
| Compatibility | 0 | 0 | 0 | 2* | 1 | C1–C3 |
| Maintainability | 0 | 0 | 0 | 1 | 0 | M1 |
| Documentation drift | 0 | 0 | 1* | 3* | 0 | D1–D4 |
| Test coverage (A3) | 0 | 0 | 3* | 0 | 1 | A3-1–A3-4 |
| Chrome API contracts (A7) | 0 | 0 | 0 | 1 | 1 | A7-1–A7-2 |
| Accessibility (B6) | 0 | 0 | 1 | 4 | 0 | B6-1–B6-5 |
| Extraction (A4) | 0 | 0 | 0 | 1 | 3* | A4-1–A4-4 |
| **total** | **0** | **1** | **10** | **15** | **10** | **36** |

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
check"* — is answered in the code: `options.js:45`, inside `flashSaved(ok)`, renders `optSaveFailed`, not
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

**PR4 · P2 · CONFIRMED — the grouped dependency PR carries a change that would break releases,
and no CI run can see it.** (`PR4` is this audit's fourth Process finding; the GitHub pull requests
it is about are #3 and #4. The two numbering schemes are unrelated.)
Dependabot PR #4 bumps four dev deps as one group. CI is red, but the red is the *lesser* problem.

- **`archiver` 7 → 8 — this is what CI catches.** v8 **removed the default export**: `index.js`
  now exports only `Archiver`, `ZipArchive`, `TarArchive`, `JsonArchive`. So
  `import archiver from 'archiver'` (`package-extension.js:22`) binds `undefined` and
  `archiver('zip', …)` throws. The release notes list exactly one breaking change — *"esm: node
  v18+ required"* — and do not mention the export removal at all. Migration is two lines:
  `import { ZipArchive } from 'archiver'` and `new ZipArchive({ zlib: { level: 9 } })`;
  `directory()`, `file()` and `finalize()` are still on the base class and `pipe()` comes from
  `Transform`, so nothing else in the script changes.
- **`chrome-webstore-upload` 3 → 6 — this is what CI CANNOT catch.** v4 requires Node 20 and wraps
  API errors in `CWSError`; **v6 moves to Chrome Web Store API v2 and makes a `publisherId` option
  mandatory** (upstream changelogs, read 2026-09-04 — re-check before acting, these are third-party
  facts the repo cannot verify for itself). `deploy-to-store.js:47-50` builds its config from exactly four values —
  `extensionId`, `clientId`, `clientSecret`, `refreshToken` — and there is no `publisherId`
  anywhere in the repo or the CI secrets. Merging this makes the next tag push fail at the upload
  step, and **the suite would stay green the whole time**, because the publish path only runs on a
  `v*` tag. This is the "unchanged metric that cannot see the change" trap in its exact form.
- `dotenv` 16 → 17 and `@playwright/test` 1.49 → 1.62 are routine. The Playwright jump is 13
  minors on the harness this repo has documented macOS-only hangs with, so it is worth landing
  where the result can be watched rather than inside a four-package group.

**Recommendation: split the group.** The failing packaging fix and the publish-path migration have
nothing to do with each other and one of them needs a credential that does not exist yet.

**Dependabot #3, same finding.** It bumps `actions/setup-node` v6 → v7 by editing the tag, which
the S2 commit replaced with a SHA, so it will conflict. Dependabot updates SHA pins natively
(bumping the SHA and rewriting the `# v6` comment) but has to regenerate against the pinned form —
which it cannot do until the pins reach origin. **Sequence: push first, then close #3 and let it
re-open.** Closing it before the push accomplishes nothing.

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

**A4-1 · Info · CONFIRMED mechanism, ZERO measured incidence — WON'T FIX 2026-09-04 — a
div-paragraph article loses the toolbar icon's auto-pick.**
`_proseStats` counts only leaf `p`/`blockquote`/`li`, so an article whose body copy sits in
`<div>`s reports ZERO prose words. Measured: `paulgraham.com/greatwork.html` extracts 11,619
words with `_proseStats().words === 0`. That feeds `_autoToggle`'s "not a real article" test.
Reproduced with a fixture + test, not inferred. CLAUDE.md's "a substantial article always wins"
was false and is corrected.

**Downgraded from P2 after measuring the CONSEQUENCE rather than the mechanism.** The original
write-up said an image-bearing page of this shape opens the gallery — but that branch needs BOTH
a zero-ish prose count AND `imageCount() >= autoGalleryMin`, and only the first had been
measured. Re-run across all 42 sweep URLs against the gallery's **own filtered** tile count (what
`_autoToggle` actually reads, not `document.images.length`): 17 rows are image-heavy, and **not
one** of them is a real article with a prose count under the threshold. Two rows match on paper —
`commons.wikimedia.org/wiki/Category:Photographs` (`tiles=49`, `live=75`) and `qiita.com`
(`tiles=17`, `live=156`) — and both are listing pages where the gallery IS the right answer.
Commons only scores as prose at all because Readability pulled 534 words of category boilerplate
out of it.

The detail that undoes the original claim: **`paulgraham.com` has one image** (`tiles=1`). The
essay used to prove the bug can never reach the gallery branch; it opens in the reader, correctly.

**And the widening has a measured cost the status quo does not.** `qiita.com` sits at
`live=156, kept=192, tiles=17` — correctly a gallery today, and any rule that counts `<div>` text
pushes it over 200 and flips it to text. One measured regression against zero measured defects.
Cost beyond correctness: `_proseStats` is also the auto-open **sentinel's**, which is pre-gesture
code running on every page load of an enabled site, so `querySelectorAll('div')` plus a per-div
leaf check is not the same scan as `p, blockquote, li`.

**Not proof of absence.** 42 URLs chosen for extraction diversity bounds the frequency loosely,
and the shape lives in older CMS templates that such a corpus under-samples. The fixture pins the
CONSEQUENCE rather than the rule, so a future fix changes the test and cannot land silently.
A narrow zero-prose fallback remains the cheapest candidate if evidence ever arrives; its own
false-positive rate is unmeasured (the sweep records no `body.textContent` totals).

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

## Test coverage (Phase 3 track A3)

Ten deliberate breakages, each run against the FULL suite, reverted after. A mutation the suite
still passes is a proven coverage gap; one it catches is proof the matching test is load-bearing
rather than decorative. Run with a throwaway driver, deleted afterwards — the deliverable is the
table below, and a committed script that rewrites `src/` is a foot-gun in a public repo (see the
note at the end of this section).

**7 caught, 3 survived.** The security and privacy guards are all covered — every sanitizer rule,
the least-privilege permission ask, the incognito write gate, and the orphaned-context detection
failed the suite the moment they were broken. The three survivors are below.

| # | area | mutation | verdict |
| --- | --- | --- | --- |
| 1 | security | sanitizer stops stripping `on*` handlers | CAUGHT (2 tests) |
| 2 | security | sanitizer stops removing `<script>`/`<iframe>`/`<form>` | CAUGHT |
| 3 | security | sanitizer stops stripping `javascript:` URLs | CAUGHT |
| 4 | security | ZIP permission ask escalates back to `<all_urls>` | CAUGHT |
| 5 | privacy | incognito passive-write gate always off | CAUGHT |
| 6 | reliability | orphaned-context detection never fires | CAUGHT |
| 7 | reliability | **double-injection guard removed** | **SURVIVED** |
| 8 | i18n | CJK word counting dropped | CAUGHT |
| 9 | defaults | **`autoGalleryMin` default 10 → 3** | **SURVIVED** |
| 10 | correctness | **ZIP central-directory size field off by one** | **SURVIVED** |

**A3-1 · P2 · CONFIRMED — FIXED 2026-09-05 — nothing tested the double-injection guard.**
`if (OBR._engineLoaded) return;` could be deleted and all 278 tests passed. No test injected the
engine twice into one live page — the settings-persistence test re-injects only after a full
reload, which wipes `OBR` and so is not the case the guard exists for. CLAUDE.md states the
consequence explicitly ("listeners attach once at injection and persist for the tab's lifetime"),
so a second engine runs beside the first with its own capture-phase `keydown` on the same node,
its own overlay, and its own reading-position writer.

*Fix:* `reader.spec.js` › "injecting the engine a second time into a live page is a no-op".
Re-injects `reader.js` alone into an open reader and asserts **`OBR.open` is the same function
object**, because reaching the bottom of the file necessarily rebinds it to a new closure. That is
the contract itself rather than a symptom of it: an earlier draft asserted only the host count,
which stays green if the guard is *moved* below the listener block — one overlay on screen, every
listener doubled. Verified red on both mutations (guard deleted, guard relocated), green with it.

**A3-2 · P2 · CONFIRMED — FIXED 2026-09-05 — the only test that exercised the shipped defaults was
insensitive to half of them.**
`gallery.spec.js` ("a long illustrated article stays in the reader despite many images") was the
one auto-mode test that set no settings, and its comment said *"Defaults: autoGalleryMin 10,
autoTextMinWords 200. Image-heavy, but it's a real read."* Lowering the `autoGalleryMin` DEFAULT
from 10 to 3 left it green — the fixture carries ~300 prose words, so `autoTextMinWords` decides
the verdict and the image count never gets a vote. The test's stated reason ("12 figures >= default
autoGalleryMin 10") was not the reason it passed.

*Fix:* one **deleted line**, not a new test. `gallery.spec.js` › "opens the text reader when images
are below the threshold" already used the same fixture and expected the same verdict; it passed
`autoGalleryMin: 10` explicitly, which is that setting's own default, and that line was the entire
reason the shipped default could be changed with the suite green. Removing it puts the test on the
shipped defaults, where `images.html`'s zero prose words leave the image count as the only input
that can decide. Verified red at `autoGalleryMin: 3`. An earlier draft added a 15-line near-clone
instead; the existing test one line away from doing the job is the cheaper and more honest fix.

**A3-3 · P2 · CONFIRMED — FIXED 2026-09-05 — the hand-rolled ZIP writer's output was never parsed
as a real archive.**
Corrupting the central-directory size field in `OBR._buildZip` (`zip.js`) left all 278 tests green.
`packaging.spec.js` does run `unzip` — but against `dist.zip`, which **archiver** built, not
`_buildZip`. The gallery's download tests assert a blob was produced and delivered, never that the
bytes form a readable archive.

*Fix:* `gallery.spec.js` › "ZIP writer output is a real archive (A3-3)". Builds in the page, then
reads the bytes back with `unzip` — **both extracting and listing, because they are different
oracles.** A STORE entry extracts from its LOCAL header, so `unzip -t`/`-p`/`-x` are clean on an
archive whose central-directory sizes are wrong; that is the A3-3 mutation, and the first version
of this test used only those subcommands and passed under the very mutation it was written for.
`unzip -Z` lists FROM the central directory and shows the wrong sizes. One binary, two questions.

**Sensitivity, measured across 31 single-field mutations of `zip.js`: 19 caught, 12 survived.**
The survivors, so nobody reads green as total:

| survivor | why |
| --- | --- |
| local/central UTF-8 flag, name length in chars | unreachable — `filenameFromUrl` (`gallery.js:79`) sanitizes names to ASCII via `/[^\w.\-]+/g`, and JS `\w` is ASCII without the `u` flag |
| central `version made by` | the A3-4 wart below; also unreachable for ASCII names |
| **central CRC** | Info-ZIP verifies the LOCAL CRC; reading the central copy needs the multi-line `unzip -Zv` parse, judged not worth the complexity |
| **EOCD entries-on-this-disk** | only the offset-10 total is read; 7-Zip and Windows read offset 8 |
| DOS date/time, disk-start, internal/external attrs, local `version needed` | no reader consults them for a single-disk STORE archive |

The two in bold are genuine gaps rather than unreachable code. Both are cheap to close if a real
defect ever points at them; neither is closed today.

**A3-4 · Info · CONFIRMED — `zip.js` declares "version made by = MS-DOS/FAT" while setting the
UTF-8 name flag, and Info-ZIP believes the former.**
Found while writing A3-3's test. `zip.js` writes `version made by = 20` (upper byte 0 = MS-DOS/FAT)
in every central-directory record, so Info-ZIP puts filenames through an OEM code-page translation
before matching them — a non-ASCII name is then displayed mangled and cannot be extracted by name
(exit 11), UTF-8 flag or not. Python's `zipfile` reads the same archive correctly, which is what
makes this an interop wart rather than a corrupt archive. **Incidence is zero**: `filenameFromUrl`
(`gallery.js:79`) replaces every non-`[\w.\-]` character with `_`, so no non-ASCII name can reach
`_buildZip` today. Fix if it ever can: `cv.setUint16(4, 0x031e)` (made by Unix 3.0). Not applied —
a one-line change to shipped byte-format code with no reachable defect behind it.

**If you re-run A3, the tool must fail safe.** Anything that mutates shipped source to test the
suite has to survive being killed: a `finally` block does not, and an interrupted first run here
left the reader's `on*`-handler stripping DISABLED in the working tree. Three properties earn their
place — refuse to start unless `src/` is clean (a mutation must be distinguishable from real work,
and a leftover one must never be mistaken for it); write the original bytes to a recovery file
before each mutation and restore from it on startup; revert on SIGINT/SIGTERM. Keep it out of the
repo: it was one `git add -A` from committing a source-rewriting script to a public repo, and a
module like that RUNS when imported, so it cannot be safely inspected by importing it.

**The durable fix is tests, not a kept driver — and it is now done.** A3-1, A3-2 and A3-3 all have
tests (2026-09-05), so mutations 7, 9 and 10 are CAUGHT and re-running this list only re-confirms
covered code. Suite: 278 → 281.

**A green oracle is not the same as a sensitive one.** A3-3's first test used `unzip` alone, passed,
and passed *equally* under the mutation it existed to catch — the tool simply does not read the
field that was broken. Any test written against a finding here should be run once with the mutation
applied before it is called a fix; "it passes" and "it can fail" are different claims.

## Chrome API contracts (Phase 3 track A7)

Each of the plan's five A7 items read against the code rather than sampled. **Four hold, one was a
wrong premise in the plan, and one real gap is a missing test rather than a defect.** No P0–P2.

**Top-level listener registration — holds.** Every `addListener` in `src/` was enumerated, not
grepped for and spot-checked: **14 sites = 10 + 3 + 1.** The ten in `background.js` all sit at
column 0, i.e. in the worker's initial evaluation, which is the MV3 contract — a listener registered
inside a callback or after an `await` does not wake a terminated worker. Three are in
`options.js:925,926,980` and one in `reader.js:2518`; those are a page and a content script, where
the rule does not apply. The content-script one is `storage.onChanged`, not `runtime.onMessage`, so
CLAUDE.md's "no content script listens for a push" still describes the code.

**`permissions.remove` semantics — holds**, and is the subject of its own CLAUDE.md gotcha after S1:
`remove()` resolves `true` for origins never granted and cannot carve a hole out of `<all_urls>`, so
every caller re-checks `contains()` and reports only that.

**MV3 worker termination — holds**, and R1 is the worked example: the worker now stores nothing
across a permission prompt, because the prompt outlives it.

**Context-menu idempotency — holds.** `createMenus()` serializes every build on one `menuBuild`
promise chain and calls `contextMenus.removeAll()` before each rebuild, so a duplicate id is
unreachable; `create()` reads `lastError` in its callback rather than throwing. It is invoked from
`onInstalled`, `onStartup`, and the `storage.onChanged` handler — the three points where the rules
it renders can have changed.

**A7-1 · Info · CONFIRMED — the plan's "unbounded `obr_positions` growth" describes code that does
not exist.** `settings.js:735` sets `POSITIONS_MAX = 300` and `makeMapStore` LRU-prunes by the
entry's `t` on every write, so the map is bounded by construction. `positionsStore` takes no
`maxBytes`, which is correct for `storage.local`: 300 entries of an origin+pathname key are ~4
orders of magnitude under the area's quota, and the byte bound exists for the 8KB **sync** items.
Recorded because the plan line is what a future session would resume from.

**A7-2 · P3 · CONFIRMED — nothing tests the reading-position LRU bound.** No test in the suite
references `POSITIONS_MAX` or drives `savePosition` past it; the only test that touches
`savePosition` spies on it to observe a flush (`reader.spec.js:626`). So the bound that keeps a
heavy reader's `storage.local` from growing without limit is unverified — the same shape as
A3-1..A3-3, found by reading rather than by mutation. Fix is one test: write `POSITIONS_MAX + N`
positions and assert the map holds `POSITIONS_MAX` and that the survivors are the newest.

## Accessibility (Phase 3 track B6)

Measured in real Chromium against the article fixture with focusable controls planted in the page,
not read off the source — a Tab sweep on a fixture with no focusable content of its own cannot tell
"trapped" from "nothing else to focus", and the first version of this probe made exactly that
mistake. Numbers below are from that run.

**Done well.** Every control is a real `<button>` or labelled form control, so the UA focus ring
survives (`outline: auto 1px` measured on a focused toolbar button — nothing in `reader.style.js`
sets `outline: none`). `aria-label`, `aria-current` and `aria-pressed` are on the segmented controls
and the toggles, and are updated when state changes. `prefers-reduced-motion: reduce` forces an
instant page turn and has a test. Gallery tiles are keyboard-reachable (2 focusable elements per
tile). The reader's toolbar tab order matches its visual order.

**B6-1 · P2 · CONFIRMED — the overlay covers the page but the keyboard still walks through it.**
There is no focus trap, no `role="dialog"`/`aria-modal` on either host, and the page behind is
neither `inert` nor `aria-hidden`. Measured Tab order with the reader open: the four planted page
controls come FIRST, then the eleven overlay controls, then `body`, then the page controls again.
So a keyboard user opening the reader tabs four times into content they cannot see, and tabbing off
the Close button lands them back there. A screen reader has it worse — the whole underlying document
is still in its buffer, with nothing marking the reader as the active surface. This is the one B6
finding with a user-visible failure rather than a missing nicety.

**B6-2 · P3 · CONFIRMED — a page turn announces nothing.** Zero `[aria-live]` elements in either
engine's shadow root. `.obr-indicator` goes from "1–2 / 6 pages" to "3–4 / 6 pages" silently, and
the gallery's `.status` (download progress, "Done — 6 saved") is equally mute. Both are exactly the
transient, non-focus-moving updates `aria-live="polite"` exists for.

**B6-3 · P3 · CONFIRMED — opening the reader does not move focus into it.** `document.activeElement`
is still `body` immediately after `OBR.open()` resolves. Combined with B6-1 there is no signal at
all — visual, focus, or announced — that a full-screen surface just opened. Fixing B6-1 would
normally carry this with it: focus the overlay on open, restore it to the trigger on close.

**B6-4 · P3 · CONFIRMED — under `forced-colors: active` the selected mode is carried by font weight
alone.** Measured with the media emulated: the active and inactive segmented buttons come back with
identical `background-color`, `color`, `border-color` and `box-shadow` (the purple fill and its
shadow are both dropped), leaving `font-weight` 600 vs 400 as the only visual difference. Not
invisible, and `aria-current="true"` still carries it non-visually — but weight alone is a thin
signal for the users this mode exists for. The standard fix is a `@media (forced-colors: active)`
block that re-expresses selection with a system colour or an added border; there is currently no
`forced-colors` rule anywhere in `src/`.

**B6-5 · P3 · CONFIRMED — two gallery inputs delete their focus ring.**
`gallery.js:513` and `:653` set `outline: none` on `.autospeed-in:focus` and `.lb-secs-in:focus`,
substituting a `border-color` change. That is a weak indicator in normal rendering and can be no
indicator at all under forced colours, where the border colour is overridden by the system palette —
so the substitute and the thing it replaced both disappear. These are the only two `outline: none`
rules in the shipped engines.

## Next (Phase 3)

A3, A4, A7 and B6 are done, and A3's three findings are now closed by tests rather than logged.
Extraction came back clean (30 PASS, 0 FAIL), the security/privacy guards are all covered, and the
Chrome API contracts hold. B6 is the one track that came back with a user-visible defect: the
overlay does not trap focus (B6-1). What remains: the plan's A2, A5, A6 and B3, the open findings
above, and PR #4 (see Process → PR4).

Fixed so far: PR1, PR2, S1, S2, R1, C1, C3, D1–D4, A4-3, A3-1, A3-2, A3-3. Still open: B6-1..B6-5,
A4-2, PR4, S3, V3, PR3, M1, A7-2, and A3-4 / A7-1 (Info) — plus the Phase 3 tracks above. V4 is downgraded to Info: its open
question (does the options page tell the user a save failed?) is answered in the code —
`options.js:45` renders `optSaveFailed`, so the quota limit is a visible wall at ~80–100 rules, not
silent loss.
