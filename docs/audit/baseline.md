# Repository audit — Phase 1 baseline

Test-suite baseline and the claims inventory, per `plan.md`. Tree: v1.8.1 (`0d808b1`).

## Test-suite baseline

| | |
| --- | --- |
| Command | `npm test` (Playwright, `workers: 1`, `fullyParallel: false`) |
| Result (audit environment) | **256 passed, 6 failed, 9m25s** |
| Result (CI on the same commit) | **261 passed, 1 failed, 4.9m** — [CI run 28](https://github.com/kouxing2000/open-book-reader/actions/runs/33322147517) |
| Result (release job, same commit) | **passed** — [release run 16](https://github.com/kouxing2000/open-book-reader/actions/runs/33322147166) |
| Spec files | 7 (`reader`, `gallery`, `options`, `auto-open`, `extension-load`, `silent-failure`, `packaging`) |
| Static gates | `verify-locales` (as `pretest`) + the parse check in `packaging.spec.js`. No lint, no type check. |

### Environment caveat

The audit container has Chromium **141**; Playwright 1.60 expects **148**. The existing build was
aliased into place rather than downloaded. Everything below distinguishes environment artifacts
from real behaviour by probe, not by assumption.

### The six failures, characterised

Each was re-run in isolation three times and probed directly.

| test | isolated | verdict |
| --- | --- | --- |
| `reader.spec.js:294` rapid flips strand no leaf | 3/3 fail | **timing margin** — see B1 |
| `options.spec.js:343` prefill fills + focuses the add-rule form | 3/3 fail | **environment artifact** — see B2 |
| `reader.spec.js:308` soft curl turn settles | passes | timing margin (the one CI also fails) |
| `reader.spec.js:489` Auto theme follows the OS | passes | load-dependent (30s timeout under full-suite load) |
| `reader.spec.js:537` font size preserves progress | passes | load-dependent |
| `reader.spec.js:554` column count preserves progress | passes | load-dependent |

**B2 — the options focus failure is an artifact, not a defect (CONFIRMED).** A probe read
`document.activeElement.id === 'siteHost'` with `document.hasFocus() === false`: the code focuses
the field correctly; `toBeFocused` fails only because the browser window has no OS focus in a
headless container. Nothing to fix in the product.

**B1 — the leaf-cleanup assertions are on a knife edge (CONFIRMED).** With `DEFAULTS.pageTurn:
'curl'` and `transitionMs: 340`, a probe sampling every 500 ms found the transient leaf gone
between 1.0–1.5 s after a single turn and between 1.5–2.0 s after an interrupted one. The
assertion at `reader.spec.js:305` allows a flat **2000 ms**; the one at `:322` allows a flat
**3000 ms**. Both are margins of well under 2× over an observed 1.5–2 s teardown, so a slow runner
tips them over. This is the same defect class a previous commit already fixed for the sibling test
at `:250` by scaling the budget to `TURN_MS * 6` — the fix was never applied to these two, which
still carry flat numbers.

That is not a cosmetic point: **`reader.spec.js:308` failed on CI at v1.8.1 on both the first
attempt and the retry**, while the release job for the identical commit passed. `npm test` is the
only gate in `release.yml` before the Web Store upload, and this same assertion class already
blocked the v1.7.2 release once. It is logged as PR1 in `findings.md`.

Everything else is green. Excluding the six above, **the suite is a genuine pass** and the two
engines, the options page, the auto-open ladder and the packaging allowlist are all exercised
against real Chromium.

## Claims inventory

Every user-facing claim mined from `README.md`, `_locales/en/messages.json` (as rendered by
`src/options/options.html`), `src/welcome.html`, `PRIVACY.md` / `site/privacy.html`, and the last
five CHANGELOG versions, mapped to the test that proves it.

Evidence column: a spec file plus test line, `UNPROVEN`, or `MANUAL` (cannot be automated in this
harness — no real toolbar click, no real permission prompt, no real print dialog).

### Text reader

| id | claim | source | evidence |
| --- | --- | --- | --- |
| C1 | Extracts the article with Readability into a Shadow DOM | README:14 | reader:17 |
| C2 | Paginates into left/right pages | README:14 | reader:57 |
| C3 | Arrow keys flip pages | README:33 | reader:169 |
| C4 | `Home` / `End` jump to first / last | README:34 | reader:184 |
| C5 | `+` / `−` change font size | README:35 | reader:518 |
| C6 | `T` cycles the theme | README:36 | reader:472 |
| C7 | `Esc` exits | README:37 | reader:632 |
| C8 | Clicking a page edge flips | README:38 | reader:196 |
| C9 | Toolbar icon toggles the open mode off | README:37 | gallery:598 |
| C10 | Resumes where you left off | README:40 | reader:575 |
| C11 | Shows a progress hairline | README:41 | reader:616 |
| C12 | Shows an estimated reading time | README:41 | reader:627 |
| C13 | Realistic page-turn: 3D book / soft curl / slide / off | README:14, optPageTurnHint | reader:235, :268, :308 |
| C14 | Respects "reduce motion" | optPageTurnHint | reader:280 |
| C15 | ⊞ cycles 2 → 3 → 4 columns | optGuideReadTopbar | reader:158 |
| C16 | Width defaults to Full, capped by `maxBookWidth` | optMaxWidthHint | reader:143, :150 |
| C17 | Auto theme follows the OS | (options theme control) | reader:489 |
| C18 | Settings sync across devices | README:43, optNoteSync | reader:829 (persistence); sync itself MANUAL |
| C19 | Positions are local, not synced | README:43 | reader:1413 (incognito), storage area at settings.js:843 |
| C20 | Print / Save as PDF | optGuideReadTopbar | reader:740 |
| C21 | Optional source-URL footer on print | optPrintUrl | reader:740 (doc build); the toggle itself UNPROVEN |
| C22 | Optional QR branding footer on print | optPrintBranding | reader:787 |
| C23 | Back-cover colophon with reading stats | optColophonHint | reader:1604, :1649 |
| C24 | Lifetime totals on the end page | optColophonLife | reader:1683, :1707 |
| C25 | Tall images do not strand blank pages | CHANGELOG 1.7.1 | reader:122, :1520, :1542 |
| C26 | Images pinned small by markup use the full column | CHANGELOG 1.7.1 | reader:97 |
| C27 | A non-article page shows an empty state, not an error | CHANGELOG 1.8.0 | reader:1021 |
| C28 | Reloading the extension leaves no dead reader | CHANGELOG 1.8.0 | reader:928, :972; extension-load:553 |

### Content override

| id | claim | source | evidence |
| --- | --- | --- | --- |
| C29 | Selecting text first reads just the selection | optGuideWrongSelect | reader:1193 |
| C30 | `readSelection` off ignores the selection | optReadSelHint | reader:1207 |
| C31 | ⌖ Pick re-reads from the clicked block | optGuideWrongPick | reader:1221 |
| C32 | Escape cancels the picker | optGuideWrongPick | reader:1244 |
| C33 | "Save for this site" reuses the pick | optGuideWrongSave | reader:1258 |
| C34 | Saved picks are listed and removable in options | optPicksHint | options:153, :190, :219 |
| C35 | A "Wrong content?" banner appears on a suspect parse | docs/reader.md | reader:885, :905 |
| C36 | A pick on a photo essay keeps its images | CHANGELOG 1.8.1 | reader:1293, :1321, :1340 |

### Image gallery

| id | claim | source | evidence |
| --- | --- | --- | --- |
| C37 | Collects page images, filters tiny ones | README:63 | gallery:18 |
| C38 | Wall (masonry) layout | README:63 | gallery:159 |
| C39 | Ordered row-major layout | README:63 | gallery:1023 |
| C40 | Size at max = one page at a time | optGuideGalleryLayout | gallery:1054 |
| C41 | Lightbox with arrow browsing and Esc | optGuideGalleryLightbox | gallery:187 |
| C42 | Filmstrip tracks and jumps | (gallery UI) | gallery:234, :243, :256 |
| C43 | Fit-width scroll mode, `F` toggles | optGuideGalleryFit | gallery:1078 |
| C44 | Auto-scroll, `A` toggles, `+`/`−` nudge | optGuideGalleryScroll | gallery:904, :911, :931 |
| C45 | Slideshow with a per-image seconds setting | optGalSlideSpeedHint | gallery:284, :300, :324 |
| C46 | "Load all" pulls lazy images | optGuideGalleryLoadAll | gallery:832 |
| C47 | Auto-load on scroll (off by default) | optGalAutoLoad | gallery:840 |
| C48 | ⊘ Hide filters avatars / noise per site | optGuideGalleryHide | gallery:1125, :1152, :1169 |
| C49 | A hide false positive is recoverable | (gallery UI) | gallery:1180 |
| C50 | Element-scope hide removes all images in that spot | optGuideGalleryHide | gallery:1258, :1298 |
| C51 | Per-tile and lightbox download | optGuideGalleryLoadAll | gallery:508, :530 |
| C52 | Select tiles → ZIP | optGuideGalleryLoadAll | gallery:517 |
| C53 | Layout choice is remembered per site | (gallery UI) | gallery:1068 |
| C54 | 📖 / 🖼 switch modes, one at a time | README:64 | gallery:539 |

### Smart open, per-site rules, auto-open

| id | claim | source | evidence |
| --- | --- | --- | --- |
| C55 | Toolbar icon smart-picks reader vs gallery | optGuideOpenToolbar | gallery:575, :583 |
| C56 | A substantial article always wins over image count | optKeepReaderHint | gallery:610 |
| C57 | Threshold off (0) always opens the reader | optAutoGalleryHint | gallery:591 |
| C58 | CJK prose is counted per character | (engine) | gallery:647 |
| C59 | `Alt+B` reader / `Alt+Shift+B` gallery | README:33, manifest | MANUAL (Chrome dispatches the command) |
| C60 | Right-click → Open in Book Reader | optGuideOpenRightClick | extension-load:183, :204 (menu build); the click MANUAL |
| C61 | Per-site rules force a mode, most-specific wins | optRulesHint | gallery:679, :687, :712 |
| C62 | Auto-open opens content pages, skips lists | README:73 | auto-open:26, :36, :47 |
| C63 | Structured-data veto on a list page | docs/auto-open-spec.md | auto-open:110, :119, :128 |
| C64 | `Esc` suppresses that page for the session | README:75 | auto-open:157, :330 |
| C65 | A chip offers one-click stop | README:75 | auto-open:271, :296, :318 |
| C66 | Enabling asks once, scoped to that site | README:76 | options:426; the prompt itself MANUAL |
| C67 | Turning a rule off releases the grant | CLAUDE.md gotcha | options:643, extension-load:337 |
| C68 | A sibling rule keeps a shared grant alive | CLAUDE.md gotcha | auto-open:399, options:643 |

### Permissions and privacy

| id | claim | source | evidence |
| --- | --- | --- | --- |
| C69 | Install asks only for activeTab, scripting, storage, contextMenus | README:80 | extension-load:25 |
| C70 | No downloads/host access held by default | README:82 | extension-load:131 |
| C71 | `downloads` requested at first download | README:83 | MANUAL (real permission prompt) |
| C72 | ZIP asks only for the origins the images live on | code (README says `<all_urls>` — see D1) | extension-load:275, options:782 |
| C73 | Auto-open grants are per-site | README:85 | auto-open:353, :376 |
| C74 | No data collected, nothing sent to the developer | README:88, optNotePrivacy | UNPROVEN as a test; verified by inventory (V1 in findings.md) |
| C75 | Runs only when invoked | README:66 | UNPROVEN (harness injects directly — the ~2 lines of gesture wiring are the known gap) |
| C76 | Incognito leaves no reading trace | site/privacy.html:87 | reader:1413 |
| C77 | A ZIP fetch cannot pull local files | (SSRF hardening) | gallery:1325 |
| C78 | A ZIP fetch sends no cookies | (SSRF hardening) | gallery:1346 |
| C79 | A report never carries a local path or page contents | CHANGELOG 1.8.0 | extension-load:500 |
| C80 | Strict-CSP sites cannot block the reader | README:66 | UNPROVEN (no CSP fixture) |

### Onboarding, feedback, failure states

| id | claim | source | evidence |
| --- | --- | --- | --- |
| C81 | First install opens the welcome page | welcome.html | options:128 |
| C82 | Options page carries a how-to guide, collapsed by default | optGuide* | options:42, :59 |
| C83 | Sections remember open/closed state | (options UI) | options:105 |
| C84 | Per-site data badge counts sites with data | (options UI) | options:89 |
| C85 | ⚙ deep-links options scoped to the site | (reader/gallery UI) | reader:688, gallery:384, options:317 |
| C86 | ⚠ Report builds a parseable report | docs/engagement.md | reader:702, :722; gallery:391 |
| C87 | The report page offers email or a web form | site/privacy.html:68 | options:137 (page runs); the form POST UNPROVEN |
| C88 | A blocked page says why, with a badge and a popup | CHANGELOG 1.8.0 | extension-load:366, :420, :445 |
| C89 | A soft block offers Report; a `chrome://` page does not | CHANGELOG 1.8.0 | extension-load:445, :483 |
| C90 | The reader reports when it opened but is not visible | CHANGELOG 1.8.0 | silent-failure:71, :85, :102, :137 |
| C91 | Chrome's shortcut editor opens from options | optGuideShortcutsBtn | options:42 (link present); the navigation UNPROVEN |
| C92 | The rating ask is capped and spaced | docs/engagement.md | reader:1745, :1767, :1784 |
| C93 | Reset to defaults clears saved picks | (options UI) | options:411 |
| C94 | Packaging ships only the allowlist | CLAUDE.md | packaging:14 |
| C95 | Store title/summary come from `_locales` | CHANGELOG 1.7.2 | `verify-locales` + extension-load:25 |

### Counts

| | claims | proven | partial | unproven | manual |
| --- | --- | --- | --- | --- | --- |
| Text reader | 28 | 26 | 1 (C21) | 0 | 1 (C18 sync) |
| Content override | 8 | 8 | 0 | 0 | 0 |
| Gallery | 18 | 18 | 0 | 0 | 0 |
| Smart open / auto-open | 14 | 12 | 0 | 0 | 2 (C59, C60) |
| Permissions / privacy | 12 | 8 | 0 | 3 (C74, C75, C80) | 1 (C71) |
| Onboarding / feedback | 15 | 12 | 2 (C87, C91) | 0 | 0 |
| **Total** | **95** | **84** | **3** | **3** | **4** |

### The gaps worth closing

Ordered by how much an undetected regression would cost.

1. **C80 — strict-CSP sites (UNPROVEN).** The Constructable-Stylesheets design exists precisely so
   a strict-CSP site cannot block the reader, and nothing tests it. A fixture served with
   `Content-Security-Policy: default-src 'self'` plus the existing render assertions would cover it;
   `tests/server.js` can set the header. This also guards the print path, which has its own
   documented CSP workaround (`reader.js:375-380`).
2. **C75 — "runs only when invoked".** The known harness gap (no `activeTab` in headless), and the
   single most load-bearing privacy claim. Not fully automatable, but the negative half is: assert
   that a page load with no gesture and no auto-open rule leaves `globalThis.OBR` undefined.
3. **C74 — "collects nothing".** Verified by inventory, not by test. A cheap guard is a static
   assertion in `packaging.spec.js` that shipped `src/` contains no network primitive except the
   worker's one `fetch`, so a future one has to be deliberate.
4. **C87 — the report form POST.** The only path that sends user text off-device, untested. Stub
   the form target and assert the body carries the `[feedback-meta v1]` marker and no page URL
   beyond origin+pathname.
5. **C21 — the print source-URL toggle**, and **C91 — the shortcuts link**. Small, cheap, low risk.
