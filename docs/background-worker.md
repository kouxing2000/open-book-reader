# Service worker internals (`src/background.js`)

> Deep reference, loaded on demand. `CLAUDE.md` holds the always-on architecture map,
> conventions and cross-cutting gotchas; this file holds the detail you only need while
> actually working on this area.

The worker is the only always-loaded script and the one place MV3 lifecycle bugs live.
Two listener-registration races that have already shipped red Errors badges, plus the
local-only debug tracing you use to answer "did my click even reach the worker?".

## Context-menu builds must stay SERIALIZED

- **Context-menu builds must stay SERIALIZED** (`background.js`: `createMenus` + the `menuBuild` chain).
  `onInstalled` and `onStartup` BOTH fire in one worker activation when Chrome applies an update while
  the browser was closed, so `createMenus()` can run twice back-to-back. The obvious fire-and-forget
  shape (`removeAll(cb)` → 8 un-awaited `create()`s) is broken: two overlapping calls queue BOTH
  `removeAll`s before EITHER batch creates anything, so the second batch collides with the first's live
  items → 8 `Cannot create item with duplicate id obr-*` unchecked-lastError entries and a red **Errors**
  badge on the extension card. Don't "simplify" it back. Failures log via `console.warn`, never
  `console.error` — chrome://extensions collects the worker's `console.error` into that same Errors list.
  The menu is **state-aware**: `createMenus()` reads `siteRules` and scopes the "Stop auto-opening" and
  "Clear rule" rows with `documentUrlPatterns` so they appear only on the matching site (auto rules /
  whole-site rules respectively), and it re-runs on the `storage.onChanged` `siteRules` delta (alongside
  `syncSentinelRegistration`), plus `onInstalled`/`onStartup`. Chrome has no `onShown` event and we hold
  no `tabs` permission, so this declarative per-site scoping is the ONLY way to reflect state — and
  patterns can only ADD a row, never HIDE the always-present generic one (no negative match patterns),
  so "Stop" sits BESIDE "Auto-open on this site" (a pair), it doesn't replace it. The same scoped-add
  trick shows the disabled "Current selection: …" line inside the **Configure Default** submenu (the
  per-site default view — Smart pick / Reader / Gallery — which SETS the rule and does NOT open;
  Band 1's "Open now:" items are the immediate triggers). Click dispatch is a thin switch over the
  pure, unit-tested `OBR._menuAction(id)` → descriptor (plus `OBR._configureDefaultAction` for the
  Smart-pick clear-vs-keep decision) — keep the id→action mapping there, not inlined in the listener.

## `syncSentinelRegistration()` must stay SERIALIZED

- **`syncSentinelRegistration()` must stay SERIALIZED on its promise chain** — the exact
  `onInstalled`+`onStartup` double-fire that broke the context menu applies, and two overlapping
  syncs would race the register/update/unregister diff. Registration mechanics that are easy to
  get wrong: zero auto rules must UNREGISTER (an empty `matches` array is invalid); one INVALID
  pattern rejects a whole `registerContentScripts` call (hence `originsForRule`'s `[]` guard);
  a valid-but-ungranted pattern registers fine and silently never injects. Gate the
  `storage.onChanged` trigger on an actual `siteRules` delta — every font nudge and debounced
  gallery persist writes `obr_settings` and would otherwise wake a pointless re-diff.

## Debug timing — "why is opening slow?"

**Debug timing — "why is opening slow?"** (`settings.js`: `OBR.debugTiming` / `OBR._timer` / the
`OBR._debug` flag). A LOCAL-ONLY, off-by-default diagnostic: the flag lives in
`chrome.storage.local` (`obr_debug` — never synced, never in Options), and when on the SW +
reader + gallery log per-phase `performance.now()` deltas to the console. It STREAMS each phase as
it completes (a `… start` line, then one line per phase, then a `… done  …  total=Nms` summary) —
NOT a single end-of-run line — specifically so a mid-load HANG is localizable: the last streamed
line is the last phase that finished, so the stall is in whatever runs next (order: reader =
settings→build→extract→render→resume→layout; gallery = settings→build→render→watch; sw =
probe→inject→dispatch). A summary-only design would print nothing at all on a hang. A MISSING
`… start` line means the stall is before the timer ran (e.g. the SW never woke — the cold-start /
orphan cases). Enable from a console where `OBR` exists (`OBR.debugTiming(true)`; `(false)` off) — persisted in
storage, so it's then on everywhere. EASIEST path: the **Options page** (it loads settings.js into
its own window, so `OBR` is in that page's main world — F12 → Console → run it, no context switch).
`OBR` is NOT in a normal article page's default console (content scripts run in an ISOLATED world —
use the Console context dropdown, or just enable from Options). Where the lines show: `[OBR reader]`/
`[OBR gallery]` log to the ARTICLE page's console; `[OBR sw]` logs to the service-worker console
(chrome://extensions → service worker → Inspect). **Purely local — nothing is ever
sent anywhere; keep it that way** (the zero-telemetry invariant and why it is load-bearing live in
`CLAUDE.md`; don't restate the rationale here). The SW reads the
in-memory `OBR._debug` (hydrated at `importScripts` + kept fresh by the `storage.onChanged`
`local`/`obr_debug` branch) so the normal path adds NO per-invoke storage read, and it hands the
resolved flag into the `open()`/`openGallery()` dispatch so a cold first invoke still times itself.
`OBR._timer` snapshots the flag at creation and no-ops every `mark`/`flush` when off, so
instrumented call sites cost ~nothing in the normal path. The SW additionally traces every TRIGGER
entry point via `swLog()` (toolbar icon / keyboard command / context menu, plus the reasons a
trigger silently does nothing: no tab, restricted page, hidden `tab.url`, injection failure) — the
answer to "did my click even reach the worker?". Each line carries **`swAge`** = `performance.now()`
in the worker, i.e. ms since IT started: `swAge` under ~200ms means that trigger COLD-STARTED the
worker (MV3 evicts it after ~30s idle), which is the usual reason a first press feels dead and the
next is instant; a large `swAge` rules cold start out. Independent of debug mode, `invokeReader`
shows a **"working" badge** on the toolbar icon (`showWorking`/`clearWorking`, `chrome.action`, no
permission needed) — the only feedback surface once the worker is up but no content script exists
yet to draw an in-page toast. It is DELAYED by `BADGE_DELAY_MS` so a normal fast open never flashes
it, and cleared in a `finally` on every exit path. (Not an absolute guarantee: if the worker is
evicted mid-timer the `finally` never runs, which is why auto-open skips the badge entirely — see
the `invokeReader` comment in `background.js`.)

## The two FAILURE states (badge `!` + tooltip)

A trigger that cannot run at all gets the same surface, in red: `showFailure(tabId, state)` sets a
one-glyph `!` badge and puts the whole message in the **tooltip** (Chrome shows ~4 badge
characters). `chrome.action` is the only surface that survives these failures — on a restricted page
nothing of ours can be injected, so an in-page toast is impossible exactly where it is needed most.
Two states, keyed in `FAILURE_TEXT` (i18n key + English fallback, read like `src/permission.js`):

- **`blocked`** — `actionCannotRunHere`. The page forbids injection: the `chrome|edge|about|…:` URL
  guard, plus its backstop in the `catch` (a restricted tab reports no `tab.url` to a worker holding
  no host access, so the guard short-circuits and `executeScript` throws).
- **`reload`** — `actionReloadNeeded`. The orphaned engine (`st.engine && !st.ctxAlive`): only a page
  reload can replace content scripts left over from a previous extension instance.

Three structural rules, each of which the code would be wrong without:

- `runInvoke` RETURNS the state; `invokeReader` paints it. That keeps one call site per state, lets
  the URL guard's early return reach the same painter, and — critically — runs the paint *after*
  `runInvoke`'s `finally { clearWorking() }`, which would otherwise wipe the badge it just set.
- **Gesture only.** Same `!(opts && opts.auto)` rule as `showWorking`: an auto-open has nobody
  waiting on a click. Its `console.warn` still fires.
- **Nothing clears it, deliberately.** Chrome drops tab-specific badge text AND title on a
  cross-document navigation (reloads included), and does NOT on a same-document one — which is
  exactly the wanted behaviour, since neither state can be fixed without a real load. A
  `tabs.onUpdated` listener to do this by hand is redundant AND is the one thing that would wake
  this worker on every navigation in every tab. Both halves are pinned by
  `tests/extension-load.spec.js`; if a future Chrome stops clearing, that test goes red.

**The badge cannot be the only channel** — it is invisible to anyone who has not PINNED the icon
(an unpinned extension lives behind the puzzle menu) and its message needs a hover nobody performs.
So each state also gets a surface that survives that, chosen by what the page permits:

| state | page | second surface |
| --- | --- | --- |
| `blocked` | nothing of ours can run | `action.setPopup` armed for THAT TAB → `src/blocked.html`, so the click has an answer; plus that page opened once per profile as a tab (`obr_blocked_seen`) |

**`blocked` has two causes and the popup must not conflate them.** The URL guard means the browser
refused; the catch-all around `executeScript` means injection *failed*, which on an ordinary page is
our bug. `isHardBlock(url)` splits them and is deliberately WIDER than `RESTRICTED_SCHEME`: the guard
stays narrow because `file://` works once the user grants file access, while the popup must also
count the Web Store host, opaque-origin schemes and inline PDFs — `src/blocked.html`'s own bullet
list names those as browser rules, so calling them our fault would have the popup contradict itself
one line apart. A soft block arms `src/blocked.html?soft=1&u=<origin+pathname>` and reveals a Report
link; a hard block gets the explanation alone. It fails CLOSED (Report offered) for anything the URL
cannot classify, e.g. a transient failure on a page that is scriptable in principle.

**A report never carries a local path.** `_buildReportMeta` allowlists `http(s)` before doing its
`origin + pathname` strip. On any other scheme that expression is not a strip but the opposite —
Chrome returns `file://` plus the user's whole path, and `data:` carries the entire page payload —
so everything else reports `(local file)` / `(data URL)` instead. Keyed on `protocol`, never on
`origin`: Chrome says `file://` where Node says `"null"`, so an origin-string test passes in a unit
harness and still leaks in the browser. The test for it runs in a real service worker.
| `reload` | a normal page — the probe just ran there | `showReloadNotice()` injects `src/content/notice.js` and draws an in-page banner with a **Reload page** button: unmissable, and one click fixes it |

`setPopup` is per-tab on purpose: a manifest `default_popup` is mutually exclusive with
`action.onClicked` and would end one-click-to-read everywhere (the WONTFIX below). Chrome clears a
tab-specific popup on navigation exactly as it clears the badge — **verified, and pinned by test**,
because if it ever stopped, a restricted tab would keep the popup after navigating to a real
article and the icon would never open the reader there again.

`notice.js` is injected ALONE for the reload case and carries two hard constraints, both from the
orphaned world it runs in: no `chrome.*` (every call there throws) and no `chrome.i18n`, so the
worker resolves the strings and passes them as `args`.

## Reporting a page that doesn't work

`OBR.reportBroken()` opens the bundled `src/report.html` with diagnostics in the URL fragment. Every
in-overlay entry point (the reader's ⚠ Report, the gallery's, the colophon's) needs a reader that
opened AND is visible — precisely what a broken site denies. So the context menu carries
**`obr-report-page`**, which runs entirely in the worker: no content script, no injection, so it
still works when the overlay is covered, deleted, or never drawn. It calls the shared
`openReportPage()`, which builds the meta via `OBR._buildReportMeta({ pageUrl })` — the `pageUrl`
override exists because inside the worker `location` is the worker's own `chrome-extension://` URL.
The reader's paint verdict (`OBR._paintCheck`, see `docs/reader.md`) rides along in `meta.failure`,
so a report names the element that covered the reader instead of needing a reproduction.

## ACCEPTED LIMITATION — a cold start shows nothing (WONTFIX, closed 2026-07-24)

The badge covers the INJECTION only, never the worker's own boot before it. `showWorking()` is
called from `invokeReader`, which runs from a listener, and Chrome dispatches no listener until
top-level evaluation has finished — so the phase that dominates a slow open is exactly the phase
nothing can paint. **Don't re-litigate without new platform capability.** What was checked:

- **No extension JS of ANY kind runs during SW boot.** Every other surface — badge,
  `notifications`, icon swap, `declarativeContent` — needs the worker too.
- **`default_popup` is the ONE thing that renders without it** (a popup is an extension PAGE, so
  Chrome paints it directly and blocks only when its script messages the worker). Rejected: it is
  mutually exclusive with `action.onClicked`, so it ends "one click = read"; it flashes a bubble on
  every fast open; it holds keyboard focus; it makes nothing faster; and **a keyboard command
  cannot open a popup at all** — which is the trigger that actually hurts.
- **A periodic `chrome.alarms` keepalive would genuinely help**, but re-boots the worker every 30s
  forever: a battery cost on every user to spare an occasional wait, plus a Web Store review flag.

**Diagnostic rule: a multi-second `boot=` means a starved machine, not an extension bug — check
memory/swap first.** One reproduction read `boot=11959ms import=1280ms` against `probe=1 inject=29
dispatch=3`; note `boot` INCLUDES our `importScripts` and top-level evaluation, so the part that
ran before any of our code was `boot - import` — about 10.7s of the ~12s, with the host at ~79%
swap consumed. This is MV3-wide, not ours: uBlock Origin Lite users report ~1s on a cold toolbar
click, and the far tail is Chrome's own `ServiceWorker startup timed out`.

