# Auto-open — spec & implementation plan

Status: IMPLEMENTED (2026-07-16) — kept as the design record (decisions + rationale);
the living architecture summary is §0 below, tests in `tests/auto-open.spec.js`.
Shipped in 1.6.0. The permission-release behaviour below (2026-07) ships in v1.7.0:
its §10 items 5b/5c and the dashboard privacy-tab update (§9) gated that release.

## 0. As-built summary

> AUTHORITATIVE for what the code does today. Sections 1-12 below are the original
> design doc — still the reference for *why*, but written before implementation.

**Auto-open — per-site, opt-in, strict** (`sentinel.js` + `background.js`; full spec:
§1-12 below). A `siteRules` entry may carry `auto: true`: the SW then keeps ONE
registered content script (`syncSentinelRegistration()`, id `obr-sentinel`, `js:
[settings.js, sentinel.js]`, `persistAcrossSessions`, matches = union of `originsForRule()` over
auto rules filtered by `permissions.contains`) so content pages on that site (forum topics, manga
chapters) open with zero clicks while list/search pages stay untouched. The sentinel runs a
**strict-bias ladder** on every probe of a settle window (document_idle + ~1s/2.5s/5s, re-armed on
SPA URL change via popstate/hashchange + a MutationObserver href compare): (0) suppression set +
visibility + no-live-overlay check → (1) `matchSiteRuleEx` must return a rule with `auto:true` →
(2) JSON-LD **list-type veto** (`CollectionPage`/`ItemList`/`SearchResultsPage`/`ProfilePage`,
TOP-LEVEL nodes only — types nested under `itemListElement`/`item` never count, or Google's
carousel markup on category pages would neuter the veto; exact `@type` equality only, else
`BreadcrumbList` — schema.org's ItemList subtype on every news article — vetoes the web; an
article-ish top-level type alongside suspends the veto but NEVER lowers thresholds; `og:type` has
no role) → (3) content gate (text: `_proseStats().words >= autoTextMinWords` AND one block `>=
autoAnchorWords` — the anchor is what rejects an index of long topic titles; images: ≥
`autoGalleryMin` `<img>`s with decoded size OR lazy-evidence + layout box ≥ 120px — lazy manga
pages have decoded nothing at probe time). Pass → `obr-auto-open` message → the SW **re-validates
against fresh settings** (never trusts page state) → `invokeReader(…, {auto:true})` →
`OBR.open({trigger:'auto'})` + the "Auto-opened" chip (`OBR._showAutoChip`, its own shadow host;
Stop clears only the `auto` flag via `OBR.setRuleAuto`). A **user-initiated** `close()` (Esc/✕/
toolbar) records `origin+pathname+search` (query matters: phpBB routes every topic through one
pathname) into the shared in-page `OBR._autoSuppressed` set; internal closes (mode switch, cross-
close) pass `{suppress:false}`. **Permissions: zero manifest delta** — per-origin
`permissions.request` subsets of the already-optional `<all_urls>`; `originsForRule` → `[]` means
"can't auto-open" (load-bearing: one invalid pattern rejects the whole registration; valid-but-
ungranted patterns register fine and silently never inject). The enable flow (context-menu
`obr-rule-auto` → permission popup with `reason=auto-open`, or the options checkbox) also
`executeScript`s the sentinel into the CURRENT tab — registration only affects future document
loads, the SPA gap — and re-arms with a one-shot flag: a qualifying page opens immediately, a
non-qualifying one (enabled from a list page) shows an "Auto-open is on" confirmation chip instead
of wrongly opening.

## 1. Problem

Reading a forum / manga / webtoon site means invoking the reader on *every* topic page —
dozens of gestures per session. The extension already remembers per-site *how* to read
(`siteRules` pick the mode, `obr_gallery` remembers layout, `obr_picks` remembers the content
block), but never *that* the user reads there. Users want: on a site I chose, list pages stay
untouched, content pages enter reading mode with zero clicks.

## 2. Goals / non-goals

Goals
- Per-site **opt-in** auto-open: on an enabled site, pages that pass a readability gate open
  in the rule's mode automatically; pages that don't (forum indexes, search results) do nothing.
- **Strict bias (product decision)**: a missed auto-open (false negative) is always
  preferable to a wrong one (false positive) — a miss costs one manual click; a wrong open
  costs trust in the feature. Every ambiguity in the gate resolves toward NOT opening, and
  no signal may ever *lower* the content thresholds.
- Zero config for the common case: the content heuristic discriminates list vs topic; path
  globs remain the power-user override (already supported by `siteRules`).
- Instant, obvious escape: Esc closes; a chip offers "stop auto-opening here"; a closed page
  is never re-opened in the same page session.
- No install-time permission changes; no new data collection (story stays "fully local").

Non-goals (explicitly rejected or deferred)
- **Countdown timer before opening** — rejected. Opening the reader is instantly reversible
  (`close()` just hides the host and restores scroll), so the right pattern is act-instantly /
  undo-instantly. A 3s countdown makes auto slower than a manual click on the 95% of pages
  where it is right.
- **Floating action button (FAB)** — deferred. It costs the same permission + injection
  machinery as auto-open but only relocates a click the toolbar icon already provides. May
  return later as the "heuristic unsure" middle behavior.
- Global (all-sites) auto-open — never. Auto is per-site opt-in only.
- Learned path suggestions ("you always open the reader on /t/* — automate?") — v2.
- Telemetry of any kind.

## 3. UX spec

### 3.1 Enabling
- **Context menu** (primary): a new `Auto-open on this site` item in the existing
  `obr-open` submenu, after the `Configure Default` submenu (which holds the per-site
  default-view rule items — formerly the flat "Always open as..." rows). Click →
  1. if the origin permission is missing, run the existing permission-popup flow
     (`src/permission.html`) requesting just this site's origins;
  2. on grant, upsert the site rule with `auto: true` (mode = the rule's existing mode, else
     `auto`);
  3. `executeScript` the sentinel files into the **current tab** — registration only
     affects future document loads, so on an SPA forum the enabling tab would otherwise
     stay sentinel-less (no auto-open on the very next topic click) until a full reload.
     The sentinel's `OBR._sentinelLoaded` guard makes this safe, and its normal ladder (§4)
     decides the immediate experience: a qualifying page (the topic the user enabled from)
     auto-opens right away through the standard path; a non-qualifying page (enabled from a
     list) shows a transient confirmation chip — `Auto-open enabled for <host>` — once the
     probes exhaust, instead of wrongly opening. Unconditionally opening here would be the
     exact false positive the ladder exists to prevent, while a silent no-op would read as
     breakage. (The enable flow sets a one-shot `OBR._justEnabled` flag ahead of
     `sentinel.js`, so ordinary registered loads never show the chip. Other already-open
     tabs of the site stay sentinel-less until their next reload — accepted for MVP; a
     `chrome.tabs.query({ url: originsForRule(...) })` sweep could cover them — it works
     without the `tabs` permission once the origin is granted — but verify that in the
     harness before adopting it.)
- **Options page**: the site-rules table gains an `Auto` checkbox per rule (and on the
  add-rule row). Checking it calls `chrome.permissions.request` directly (extension page +
  click = valid gesture); a denied prompt reverts the checkbox. This is where **path-scoped**
  auto rules are authored (`forum.example.com/t/*`).
- The existing `Clear rule for this site` context item and the options-page remove button
  already delete the whole rule, which drops the auto flag with it.

### 3.2 Behavior on an enabled site
- Page loads (or SPA-navigates) → the sentinel evaluates the decision ladder (§4). If it
  passes, the page opens in the resolved mode **immediately** — no countdown.
- On auto-open, the reader/gallery shows a transient **chip** (~6s, dismissible):
  `Auto-opened · Esc closes · [Stop auto-opening on this site]`.
  The stop button removes only the `auto` flag (the mode rule survives — "stop automating"
  must not also forget "this site is a gallery site").
- **Suppression**: a user-initiated dismissal (§5.4) records that page's
  `origin+pathname+search` in an in-page set; the sentinel never auto-opens a recorded page
  again for the lifetime of that page session (covers SPA back/forward). The query string
  is part of the key — phpBB-style forums route every topic through one pathname
  (`viewtopic.php?t=123`), so an Esc keyed on pathname alone would suppress the whole
  forum; the set is in-memory, so there is no quota reason to strip the query (unlike
  `positionKey`). A full reload is a fresh decision — deliberate: re-navigating to a topic
  is a new reading intent.
- **Background tabs**: if `document.hidden`, defer evaluation until the tab first becomes
  visible (no surprise state changes behind the user's back; also dodges timer throttling).
- Nothing changes on sites without an auto rule: not a byte of extension JS runs there
  before a gesture, exactly as today.

## 4. Trigger decision (the ladder)

The **settle scheduler** wraps the whole ladder: forum posts and SPA content render late,
so the sentinel probes at `document_idle`, then ~1s / 2.5s / 5s, and **each probe runs the
full ladder below in order** — an open can only happen at the end of a fully-passed probe,
so the veto always runs before any open. Stop probing early on open or on URL change; give
up quietly after the last probe (no badge, no toast). The schedule re-arms on SPA URL
change (popstate + hashchange listeners, plus a `location.href` compare piggybacked on a
lightweight MutationObserver — the isolated world cannot see the page's `pushState` calls
directly).

0. **Suppression & state check** — skip if the page's `origin+pathname+search` is in the
   suppression set (§3.2), if the document is hidden (defer until first visible, §3.2), or
   if either overlay host is already visible (the user is reading — never yank or switch a
   live overlay under them; same visibility check as `_autoToggle`). After a user closes an
   overlay mid-page, auto stays quiet until an SPA navigation re-arms the ladder.
1. **Matching rule check** — `matchSiteRuleEx(location.href, siteRules)` (most-specific-wins,
   as today). No matching rule with `auto: true` → do nothing, ever.
2. **Declared page type — one-directional VETO** (schema.org JSON-LD `@type`; ~25 lines).
   Metadata is a *claim*, not a measurement, so under the strict bias (§2) it may only make
   the gate STRICTER — it can veto an open, never enable one:
   - **list-ish** (a top-level node of exact `@type` `CollectionPage` / `ItemList` /
     `SearchResultsPage` / `ProfilePage`) → **veto**: do not auto-open regardless of
     content. Plugs the pinned-announcement hole: an index with one long pinned paragraph
     + 200 words of topic titles passes the content gate, but its declared list type stops
     it. A misdeclared real article costs one manual click — the accepted direction.
   - The veto is **suspended** when an article-ish type (`Article` / `NewsArticle` /
     `BlogPosting` / `DiscussionForumPosting` / `QAPage`) is ALSO present as a top-level
     node (a topic page inside a declared forum hub). Suspended only means the content
     gate decides — thresholds never drop.
   - **Node-level scoping**: "top-level" = each `<script type="application/ld+json">`
     block's root object, the members of a root array or `@graph`, and a root node's
     `mainEntity`. Types nested under `itemListElement` / `item` NEVER count: Google's
     recommended carousel markup for category pages is an `ItemList` whose
     `itemListElement → item` entries are `Article`s — a flat "article-ish anywhere" scan
     would suspend the veto on exactly the list pages it exists for.
   - **Matching rules**: exact `@type` string equality only — never substring or
     subtype-aware matching (schema.org makes `BreadcrumbList` a subtype of `ItemList`,
     and breadcrumbs ride on virtually every news article; subtype matching would veto
     every news site — exact equality excludes them naturally). `@type` may be a string OR
     an array; JSON-LD often ships in several script blocks — handle both. Unparseable
     JSON-LD is ignored (neutral).
   - **`og:type` plays no role** — neither veto nor suspension. Sloppy templates stamp it
     sitewide too often to trust in either direction, and with prose-first `auto`
     resolution (step 3) there is no tie left for it to break.
   - Article-ish declarations do NOT lower the thresholds (considered and rejected:
     rescuing short posts by trusting the claim reopens the sloppy-template trap).
     Short-but-real posts simply don't auto-open; the manual click still works.
   - No metadata → neutral; the content gate decides (legacy forums must keep working).
   Note metadata cannot *accelerate* opening either: Readability needs the rendered DOM, so
   the settle window is bounded by content readiness regardless of what `<head>` declares.
3. **Gate by the rule's mode** (the list-vs-topic discriminator):
   - `text` → *prose gate*: `proseWords >= autoTextMinWords` (default 200, existing setting)
     **AND** at least one single prose block `>= autoAnchorWords` (new, default 80).
     The anchor-block requirement is what rejects forum indexes whose long topic titles can
     accumulate 200 words of >=20-word `<li>` rows without containing one real paragraph.
   - `images` → *image gate*: count of `<img>` that either has a **loaded natural size**
     `>= 120px` on both sides, OR carries **lazy-load evidence** (a `data-*` lazy URL or
     `loading="lazy"`) AND a rendered layout box `>= 120px` on both sides; compared against
     `autoGalleryMin` (default 10, existing setting). The lazy+layout-box arm matters:
     manga/webtoon pages have decoded almost nothing at probe time, but their placeholder
     boxes are laid out — a natural-size-only count would fail the exact sites `images`
     rules target — while requiring lazy evidence keeps decorative/broken `<img>`es from
     counting. Still deliberately more conservative than the gallery's own 80px,
     avatar-filtered collection — divergence fails toward NOT opening, and the fallback is
     the user's normal click.
   - `auto` → prose gate first (an article always wins, mirroring `_autoToggle`), else
     image gate → gallery, else nothing. (An earlier draft let article-ish metadata break
     a text-vs-gallery "tie" — dropped: prose-first already resolves every case
     deterministically, so metadata keeps exactly one job, the veto.)

Heuristic source of truth: the prose stats move from `reader.js` into `settings.js`
(`OBR._proseStats()` → `{ words, maxBlock }`) so the sentinel, `_autoToggle`, and the
suspect-extraction banner all share ONE implementation and always agree.
`OBR._articleWordCount` remains as a thin alias (gallery + tests keep working).

We do NOT vendor Mozilla's `isProbablyReaderable`: a second heuristic that occasionally
disagrees with the toolbar icon's verdict would make behavior unpredictable for zero
user-visible gain.

## 5. Architecture & permissions

### 5.1 Permission model — no manifest change
`optional_host_permissions: ["<all_urls>"]` is already declared (ZIP downloads), and
`chrome.permissions.request` may request any origin subset of it. Auto-open requests only
the enabled site's origins at rule-creation time. Install-time permissions are untouched;
the privacy story becomes "runs only when you invoke it — or on sites where you explicitly
turned auto-open on".

`originsForRule(match)` (new, `settings.js`, pure + testable) maps a rule glob to origin
patterns (origins are host-scoped; the path part is enforced by the sentinel, not the grant):
- literal host `example.com` → `["*://example.com/*", "*://www.example.com/*"]`
  (`normalizeHost` strips `www.` from targets, so the grant must cover both spellings);
- wildcard host `*.example.com/...` → `["*://*.example.com/*"]`;
- a host glob that does not form a valid Chrome match pattern → `[]` (options UI disables
  the Auto checkbox for that rule with a hint).

**Turning auto-open OFF now releases the site permission** (changed 2026-07; it previously
never auto-revoked). Every DELIBERATE turn-off path releases: the options checkbox, deleting
the rule, the context menu's "Stop auto-opening", and the in-overlay chip's Stop — the last
one RELAYS via an `obr-stop-auto` message, because a content script cannot call
`permissions.remove` and clearing in-page would drop the flag while keeping the grant. All of
those route through `OBR.releasableOrigins(rule, remainingRules)`, which returns `[]` (keep the
grant) when a sibling auto rule on the same host still needs it. "Reset to defaults" also
releases, but via `OBR.autoRuleOrigins` directly (it wipes every rule at once, so there is no
surviving sibling to test against). **Known exception:** editing a rule's *pattern* to a new
host (`patCommit`) drops `auto` and ORPHANS the old host's grant; it surfaces afterwards as a
"Not used by any auto-open rule" row in the Site access card rather than being handed back. Origins are HOST-scoped, so
`host/blog/*` and `host/forum/*` share ONE grant; releasing for one would silently pause the
other while its checkbox still read "on". The union side of that decision is
`OBR.autoRuleOrigins(rules)` — the SAME function the sentinel registration uses, so a grant
can never be released while the registration still expects it.

The superseded rationale, recorded because half of it was wrong: it argued that "silently
removing a permission the user granted is hostile UX **and** the grant may serve other
features (the ZIP download's `<all_urls>`)". The second clause is a mistake — ZIP's grant is
*separate*, so it was never a reason to hold the per-site pair. (ZIP now requests only the
origins its images live on; `<all_urls>` survives solely as an explicit opt-out.) The first clause was a real position, overridden by an explicit product decision: a
user switching auto-open off expects the access to go with it, and a grant that outlives the
only feature that asked for it is worse UX than a revoke the user just triggered. Revoking
is cheap to undo — the extension re-asks on next use.

Two mechanics this leans on. `permissions.remove` needs **no** user gesture (only `request`
does), so the service worker can release directly. And `remove` resolves `true` even for
origins that were never granted, and cannot carve a per-site hole out of a broader
`<all_urls>` grant — so any path that REPORTS the outcome must re-check
`permissions.contains` afterwards and trust only that (`options.js: revokeOrigins`). The SW
path reports nothing, so it skips the verify.

A revoked
origin fires `permissions.onRemoved` → registration re-sync → that site's sentinel
deactivates; the rule keeps its flag and re-arms if the permission comes back. One
consequence stated plainly: if a user takes the "Allow all sites" opt-out during a ZIP
download, every synced auto rule activates on that device — acceptable, since each rule was
its own explicit opt-in, and it is no longer what a plain ZIP download asks for.

### 5.2 Sentinel (new `src/content/sentinel.js`)
A tiny registered content script — NOT the engine. Registered as ONE registration
(id `obr-sentinel`, `js: [settings.js, sentinel.js]`, `runAt: document_idle`, top frame
only, `persistAcrossSessions: true`) whose `matches` is the union of `originsForRule()`
over all auto rules, filtered by `permissions.contains` per pattern.

It loads settings, runs the ladder (§4), and on a pass sends `obr-auto-open
{ mode: 'text'|'images' }` (mode already resolved — `auto` rules resolve in the sentinel).
It never touches the page DOM beyond reading it — with one exception: the enable-time
confirmation chip (§3.1), a small self-removing shadow-DOM toast shown only on the enable
gesture, never on ordinary probes.

Registered content scripts and `chrome.scripting.executeScript` share the extension's ONE
isolated world per frame, so the sentinel and the injected engine share `globalThis.OBR` —
the suppression set and the double-injection guards compose with zero new plumbing. This is
documented behavior, and the existing SW injection already relies on it (`background.js`
probes `OBR._engineLoaded` set by a prior `executeScript`); the Playwright harness cannot
prove it (it injects via `addScriptTag` into the page's main world), so it is
manual-verified — §10 item 3 only passes if the sentinel sees the engine's suppression
entry.

`sentinel.js` guards itself with `OBR._sentinelLoaded` (mirrors `_engineLoaded` /
`_galleryLoaded`) — the enable-time `executeScript` (§3.1) plus a later registered load
must not double-arm timers/observers. A sentinel injection also means `settings.js` runs
once for the sentinel and again on a manual engine invoke (the SW's `_engineLoaded` probe
doesn't know about the sentinel's copy) — harmless by inspection (the IIFE reassigns
functions and creates fresh promise chains), noted here so nobody "fixes" it.

### 5.3 Service worker (`src/background.js`)
- **`obr-auto-open` handler**: validate `sender.tab` + re-run `matchSiteRuleEx` on
  `sender.url` against fresh settings and require the winning rule to carry `auto: true`
  (don't trust page-side state), then inject the engine
  and open — `invokeReader(tabId, url, mode, { auto: true })`. When `auto` is set the
  dispatch calls `OBR.open({ trigger: 'auto' })` / `OBR.openGallery({ trigger: 'auto' })`
  directly instead of the toggles (a toggle could *close* a just-opened overlay on a rare
  double fire).
- **Registration sync** (`syncSentinelRegistration()`): compute desired `matches` from
  settings; diff against `chrome.scripting.getRegisteredContentScripts`; register / update /
  unregister accordingly. Triggers: `storage.onChanged` (sync, `obr_settings` — gate on an
  actual `siteRules` delta before diffing; every font nudge and debounced gallery persist
  writes `obr_settings` and would otherwise wake the SW into a pointless re-diff),
  `onInstalled`, `onStartup`, `permissions.onAdded` / `onRemoved` — all registered
  synchronously at the worker's top level (the MV3 event-wakeup requirement).
  Mechanics (verified empirically in real Chromium): registering a valid-but-**ungranted**
  pattern *succeeds and silently never injects* — the `permissions.contains` filter is
  registration hygiene, not correctness — but a single **invalid** pattern *rejects the
  whole `registerContentScripts` call*, so `originsForRule`'s invalid-glob → `[]` guard is
  load-bearing for the union registration. Zero auto rules → **unregister** the sentinel
  entirely (an empty `matches` array is itself invalid).
  **Must be serialized + idempotent on a promise chain, exactly like `createMenus()`** —
  `onInstalled` and `onStartup` can both fire in one worker activation, and two overlapping
  syncs would race the register/unregister diff. Failures log via `console.warn` (never
  `console.error` — the chrome://extensions red-badge rule).
- Context menu: new `obr-rule-auto` item + handler (permission check → popup flow if needed
  → `upsertSiteRule(raw, host, mode, { auto: true })` → current-tab sentinel injection; the
  sentinel's own ladder decides open-vs-confirmation-chip, §3.1 step 3).

### 5.4 Engine changes (`reader.js`, `gallery.js`)
- `open(opts)` accepts `{ trigger: 'auto' }` → renders the chip (§3.2). Chip's stop button:
  read-modify-write settings, clear `auto` on the rule that matched the current URL, keep
  the mode.
- `close()` (both engines) records `origin+pathname+search` into the shared in-page
  suppression set (`OBR._autoSuppressed`) — but **only for user-initiated dismissals**
  (Esc, the ✕ button, toolbar toggle-off), regardless of how the overlay was *opened*: if
  the user dismissed it here, a same-session SPA return must not re-open. Every internal
  close path passes `{ suppress: false }` and records nothing — the in-overlay 🖼/📖
  mode-switch (literally `close(); openGallery()` — `reader.js:201`, `gallery.js:703`) and
  the defensive cross-close each engine's `open()` performs on the other (`reader.js:1460`,
  `gallery.js:1754`). In all of those the user is still reading, not dismissing.

### 5.5 `manifest.json`
- **No changes at all.** (An earlier draft bumped `minimum_chrome_version` 102 → 105 for
  `persistAcrossSessions`; that was factually wrong — Chrome has shipped
  `registerContentScripts` *and* `persistAcrossSessions` since **96**; 105 is *Firefox's*
  milestone for that option. The existing `102` floor already suffices, a zero manifest
  delta is the better Web Store review story, and no Chrome 102–104 user gets stranded on
  1.5.0.)

## 6. Data model

`siteRules` entries gain one optional flag — `{ match, mode, auto?: true }`:
- `upsertSiteRule(raw, host, mode, opts?)` learns to set/preserve `auto`.
- New `OBR.matchSiteRuleEx(url, rules)` returns the winning rule *object*;
  `matchSiteRule` becomes a wrapper returning `.mode` (call sites unchanged).
- `migrateSiteRules` untouched (the legacy map never had auto).
- New `DEFAULTS.autoAnchorWords: 80` (documented in DEFAULTS; not surfaced in the options
  UI for MVP). Sync-quota cost of the flag: ~12 bytes/rule — negligible.

## 7. Implementation plan (ordered)

Each step lands green on the full suite before the next.

1. **Shared heuristics + rule helpers** (`settings.js`, `reader.js`)
   - Move prose counting into `settings.js` as `OBR._proseStats()`; keep
     `OBR._articleWordCount` as an alias in `reader.js`. **SW-safety constraint**:
     `settings.js` is `importScripts`'d into the service worker (`background.js:11`), so
     DOM access must stay strictly call-time — no top-level `document`/`window` references.
   - Add `matchSiteRuleEx`, `originsForRule`, extend `upsertSiteRule`; add
     `autoAnchorWords` to DEFAULTS. All pure/page-testable.
2. **Sentinel** (`src/content/sentinel.js`, new)
   - `OBR._sentinelLoaded` guard; ladder + settle probes + SPA re-arm + visibility
     deferral + suppression check + `obr-auto-open` message + the enable-time confirmation
     chip (§3.1, gated on the one-shot `OBR._justEnabled` flag). Expose an
     `OBR._sentinelState` test hook (mirrors the existing `OBR._*` helper convention) so
     specs can await "probes exhausted" deterministically.
3. **Service worker** (`background.js`)
   - `obr-auto-open` handler + `invokeReader` `{auto}` variant; serialized
     `syncSentinelRegistration()` + its triggers; `obr-rule-auto` context item + handler
     reusing the `permission.html` popup flow (extend that page's copy to also explain an
     origin request for auto-open), then the current-tab sentinel injection (§3.1 step 3).
4. **Engine UX** (`reader.js`, `gallery.js`, `reader.style.js`)
   - `open({trigger})` + auto chip + stop button; `close()` suppression recording.
5. **Options page** (`options.html/js`)
   - Auto checkbox column (+ add-row), gesture-context `permissions.request`, revert on
     deny, disabled-with-hint for rules whose host glob can't form a match pattern; update
     the how-to-use guide section (it is covered by `options.spec.js`).
6. **i18n**: new keys (context item, chip, options column/hints, permission-page copy) in
   every locale catalog under `_locales/`.
7. **Tests** (§8), then **docs** (§9).

## 8. Test plan

New fixtures:
- `tests/fixtures/forum-topic.html` — long posts with real paragraphs (passes prose gate).
- `tests/fixtures/forum-list.html` — many short `<li>` topic rows, including enough
  >=20-word titles to total >=200 words while NO single block reaches 80 (the anchor-block
  regression case; must NOT open).
- Metadata variants (§4 step 2): a list page with a pinned >=80-word announcement declaring
  `CollectionPage` (passes the content gate, must NOT open — the veto); a ~120-word post
  declaring `DiscussionForumPosting` (must NOT open — declarations never lower the bar); a
  real article whose JSON-LD carries `NewsArticle` + `BreadcrumbList` (MUST open —
  `BreadcrumbList` must not trigger the list veto); a category page with Google's carousel
  markup — top-level `ItemList` whose `itemListElement → item` entries are `Article`s
  (must NOT open — nested article types must not suspend the veto, §4 step 2); a
  sitewide-sloppy `og:type=article` list page (must NOT open — `og:type` plays no role).

New `tests/auto-open.spec.js` (same harness pattern: inject `settings.js` + `sentinel.js`
with the storage shim + a captured `chrome.runtime.sendMessage`):
- topic fixture + whole-site auto text rule → `obr-auto-open {mode:'text'}` within the
  settle window;
- list fixture + same rule → no message after probes exhaust (via `_sentinelState`);
- anchor-block guard: the long-titles list fixture → no message;
- path rule `host/t/*` fires on `/t/...` and not on `/forum/...`; most-specific-wins with a
  competing whole-site rule;
- image rule on an image-heavy fixture → `{mode:'images'}`; `auto` mode resolves text-first;
- suppression: auto-open → `OBR.close()` → simulated SPA nav back → no re-fire; a
  query-only navigation (`?t=1` → `?t=2`) is NOT suppressed (the key includes the search
  string); an internal `{suppress:false}` close records nothing. (These share the set
  between two in-page script tags — they do NOT prove registered-script/executeScript
  isolated-world sharing; that's documented behavior, manual-verified via §10 item 3.);
- enable path: sentinel injected with the one-shot `OBR._justEnabled` flag on the list
  fixture → confirmation chip renders, no `obr-auto-open` message;
- hidden document defers evaluation until visible.

Existing specs:
- `reader.spec.js`: chip renders on `open({trigger:'auto'})`, absent on manual open; stop
  button clears only the auto flag.
- `options.spec.js`: auto checkbox render/edit paths with a stubbed `chrome.permissions`
  (grant and deny).
- `extension-load.spec.js`: manifest still ships no new install-time permissions and
  `minimum_chrome_version` stays `102` (§5.5 — regression guard against re-adding the
  mistaken bump).
- Page-context unit coverage for `originsForRule` / `matchSiteRuleEx` / `_proseStats`.

Harness caveats (extend the existing one): a real `permissions.request` prompt and a real
`registerContentScripts` round-trip aren't drivable headless, and the SW-side
`obr-auto-open` handler (sender-tab validation, the fresh `matchSiteRuleEx` re-check, the
direct-open dispatch) is equally uncoverable — the harness captures `sendMessage` in-page.
The pure diff helper is tested in page context; the SW slices are manual-verified (§10
items 1–2 exercise the full sentinel → SW → engine path). Two realism notes: stubbing
`chrome.permissions` on the real options extension page assumes the `chrome.*` properties
stay monkey-patchable there (true today, but brittle — if Chrome freezes them, that spec
moves to the manual checklist); and the hidden-document-defers test can't get a genuinely
backgrounded tab in headless=new (bringToFront doesn't occlude the other page), so it
shadows `document.hidden` via `Object.defineProperty` and hand-fires `visibilitychange` —
exactly the two signals the sentinel consumes; the real-tab behavior rides §10.

## 9. Docs & copy

- Architecture blurb (sentinel + registration sync): §0 above. The registration-sync gotcha
  (same `onInstalled`+`onStartup` double-fire as the context menu) lives in
  `docs/background-worker.md`; the prose-stats-live-in-`settings.js` gotcha is in `CLAUDE.md`.
- `README.md`: feature bullet + privacy sentence ("auto-open runs only on sites you enable").
- `site/` landing + privacy page: same disclosure.
- Store listing source of truth (`.meta/LISTING.md` + localized descriptions): feature line.
- Developer Dashboard privacy-practices tab: extend the existing `<all_urls>` justification
  to also cover per-site auto-open. **Do this BEFORE pushing the release tag** (the API
  cannot set it and publish blocks on it).

## 10. Manual verification checklist (pre-release)

On a real forum (e.g. any Discourse instance):
1. Enable via context menu on a topic page → permission prompt → opens immediately; then
   WITHOUT reloading, SPA-navigate to another topic → auto-opens (current-tab sentinel
   injection, §3.1 step 3).
1b. Enable via context menu on a LIST page → no open; the confirmation chip shows instead;
   the next topic click auto-opens.
2. Navigate list → topic → list: list pages never open; topics open; SPA navigation included.
3. Esc on an auto-opened topic → navigate away and SPA-back → stays closed (this passing is
   also the registered-script/executeScript shared-isolated-world verification, §5.2); full
   reload → opens again. On a query-routed forum (phpBB-style `viewtopic.php?t=N`): Esc on
   one topic must not suppress the others.
4. Chip "stop auto-opening" → flag cleared, mode rule survives, sentinel deregisters
   (verify via `chrome.scripting.getRegisteredContentScripts` in the SW console).
5. Revoke site access in chrome://extensions → no errors, no red badge, sentinel gone;
   the rule row shows the paused line; re-grant via its inline Grant (or the checkbox) → back.
5b. **Release paths all agree** — with ONE auto rule on a host, each of: unchecking Auto-open,
   deleting the rule, "Reset to defaults", and the menu's "Stop auto-opening" drops that host
   from the options **Site access** card (and from `chrome.permissions.getAll`). With TWO auto
   rules on one host (`host/blog/*` + `host/forum/*`), switching off ONE must keep the grant —
   the other rule keeps auto-opening; only the last one released revokes.
5c. A plain ZIP download prompts for ONLY the image origins (listed in the popup) — not all
   sites. After deliberately taking "Allow all sites instead", per-site rows read "Redundant",
   ticking Auto-open prompts for nothing, and a per-site revoke says the entry was removed but
   all-sites access still covers the site.
6. A `*.example.com` wildcard rule and a path rule authored in options.
6b. An `images` auto rule on a lazy-loading manga/webtoon site: auto-opens even though
   below-fold images haven't decoded at probe time (lazy-evidence + layout-box counting,
   §4 step 3).
7. chrome://extensions Errors badge stays clean through install/update/startup (registration
   sync serialization).
8. **Menu bands** — Band 1 `Open now: …` opens immediately for this visit; `Configure Default ▸
   Smart pick / Reader / Gallery` SETS the site's default view and does NOT open. On a site that
   already has a whole-site rule, the submenu shows a disabled `Current selection: …` line for
   the active mode; on a rule-less site that line (and its divider) is absent.
9. **`Configure Default ▸ Smart pick`** clears an existing plain (non-auto) rule — back to the
   global default, leaving no no-op `{mode:'auto'}` behind — but KEEPS an auto-open rule at mode
   `auto` (logic in `OBR._configureDefaultAction`; id→action map in `OBR._menuAction`).
10. **`Auto-open on pages like this…`** on a topic page → opens the options page scoped to the
   site, with the add-rule field pre-filled with a best-guess path pattern (editable), Auto-open
   ticked, and the Per-site data section expanded + scrolled to + focused. On a phpBB-style
   `viewtopic.php?t=N` page the pattern keeps the script (`…/viewtopic.php*`).

## 11. Risks

- **False-positive open on a list page** → anchor-block gate + list-type metadata veto +
  per-site opt-in + chip + suppression; residual risk accepted (one Esc, self-healing).
- **Missed opens on short posts** — the deliberate cost of the strict bias (§2); the manual
  click and keyboard shortcut remain one gesture away. Revisit only with real user feedback.
- **Web Store review**: no manifest permission delta, but reviewer-visible behavior change on
  granted origins — mitigated by the privacy-tab update (§9) and the opt-in framing.
- **Heuristic divergence** (sentinel image count vs gallery collection) — conservative
  thresholds fail toward not opening; documented in §4.
- **Registration/permission drift** (revocations, sync from another device carrying rules
  this device has no grants for) — registration sync filters by `permissions.contains`, so
  an ungranted rule is simply dormant on this device. The options page keeps its checkbox
  CHECKED (the stored intent is real, and the sentinel re-arms if the grant returns) and adds a
  paused line with an inline re-grant — see `markPaused`/`refreshPausedLines`.

## 12. Rejected alternatives (for the record)

- `tabs.onUpdated`-driven injection from the SW: wakes the worker on every tab event
  browser-wide; misses no-nav SPA updates; sentinel is strictly cheaper and more reliable.
- `webNavigation` permission: new install-time permission (review flag) for something the
  sentinel gets for free.
- Vendoring `isProbablyReaderable`: second heuristic → verdict drift vs the toolbar icon.
- Countdown timer, FAB, global auto: see §2.
