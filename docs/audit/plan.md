# Repository audit — plan

A structured functional + non-functional audit of the shipped extension and the process
around it. This file is the plan; results land beside it:

| file | what |
| --- | --- |
| `plan.md` (this file) | scope, threat model, tracks, checklists, phases, severity scale |
| `baseline.md` | Phase 1 output: test-suite baseline + the claims inventory |
| `findings.md` | the running findings log, one entry per finding, severity-ordered |

## Status — read this first

| phase | state | where |
| --- | --- | --- |
| 1 — Baseline | **done** (2026-09-02, v1.8.1 `0d808b1`) | `baseline.md` |
| 2 — Automated sweeps | **done** | `findings.md` (19 entries: 1×P1, 5×P2, 9×P3, 4×Info) |
| 3 — Deep dives | not started | — |
| 4 — Report + fix plan | not started | — |

Nothing has been fixed: the audit is read-only through Phase 3 by design (see **Rules while
auditing**), so every finding is logged, not patched.

**Resume here.** Read `findings.md` first — its Summary table and the Next section say what is
open. Then either:
- **act on PR1** (P1: master's CI is red at v1.8.1 and the failing assertion is the release gate) —
  worth pulling forward out of order, because a green baseline makes everything else easier to
  judge; or
- **start Phase 3** with the SUSPECTED findings (S1 end-to-end, V4, R1), then tracks A2–A7 and
  B3/B6 below.

Before running the suite in a fresh container, read the **Environment caveat** in `baseline.md` —
the preinstalled Chromium will not match Playwright's expected build, and the resulting failure
looks like a total regression but is not one.

The audit is **claims-driven**: the product's promises (README, store listing, options page,
privacy policy) are the specification, and each promise is checked against the code and the
tests. Because the extension injects into arbitrary pages and is marketed on "collects
nothing", security and privacy come first, then extraction correctness (the core value), then
performance, then maintainability.

## Scope

In scope: everything the package ships (`manifest.json`, `src/`, `_locales/`, `icons/`), the
test suite (`tests/`), the release pipeline (`.github/workflows/`, `scripts/`), the public docs
(`README.md`, `docs/`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`), the public
site (`site/`) and the feedback backend (`tools/feedback-form/`).

Out of scope: the vendored `readability.js` and `qrcode.js` internals (upstream's job — we audit
only how their OUTPUT is used and which upstream version is pinned), and gitignored private
material.

## Threat model (security + privacy tracks)

| id | actor | capability | what they want |
| --- | --- | --- | --- |
| T1 | a hostile web page the user opens the reader/gallery on | full script in its own origin; can reach into the open Shadow DOM overlay; controls every byte the engine extracts | escalate into the extension's origin or the isolated world; make the worker fetch/download/open something on its behalf |
| T2 | a hostile image host reached during a ZIP download | controls response bytes and headers | exploit the ZIP writer or the download path; get bytes it could not otherwise serve |
| T3 | hostile input to the extension's own pages | URL params, storage values planted by a content script, runtime messages | script execution in `chrome-extension://` origin; redirect the user |
| T4 | another extension or page talking to the worker | `runtime.sendMessage` if externally connectable | any privileged worker action |
| P1 | the developer / a third party (privacy) | — | any data leaving the device the policy does not disclose; any durable trace of private browsing |

## Track A — functional audit

The question: does the product do what it claims, correctly, and would the suite notice if it
stopped?

| # | activity | method | output |
| --- | --- | --- | --- |
| A1 | **Claims inventory** | mine README, listing copy, `_locales/en`, options/welcome/blocked/report/permission pages, last 5 CHANGELOG versions, `docs/`; one row per user-visible claim | table in `baseline.md`: claim → proving test, UNPROVEN, or MANUAL-ONLY |
| A2 | **Behavior coverage map** | map each spec file's tests to the feature list; no line coverage exists for a no-build project, so this is the substitute | list of features with zero automated coverage |
| A3 | **Mutation spot-checks** | break 10 deliberate things (drop a sanitizer rule, off-by-one in pagination, skip the incognito gate, swap a default) and run the suite; each one that stays green is a gap | pass/fail table |
| A4 | **Real-site sweep** | `npm run test:manual` proxy against ~40 sites spanning news, blogs, forums, docs, galleries, manga, CJK, RTL; score extraction (title, body, images, byline) against a reference reader view; seed from `tests/fixtures/test-sites.html` | scored matrix; failure cards become fixtures |
| A5 | **Edge-case matrix** | SPA navigation, nested iframes, host pages with their own Shadow DOM, strict-CSP pages, lazy images, very long articles, tiny viewports, browser zoom, vertical CJK, print | pass/fail per cell |
| A6 | **State transitions** | reader → gallery → close → extension reload → re-trigger; keyboard vs icon vs context menu vs auto-open entry points; double injection | no leaks, no double listeners, no stranded overlay |
| A7 | **Chrome API contracts** | MV3 worker termination and top-level listener registration; `storage.sync` per-item quota vs auto-open rules; unbounded `obr_positions` growth; context-menu idempotency; `permissions.remove` semantics | findings |

## Track B — non-functional audit

| # | area | what is checked |
| --- | --- | --- |
| B1 | **Security** | the deny-list sanitizer and every innerHTML/print-iframe sink; worker message handlers (sender validation, URL scheme/host validation on fetch/download/open); extension pages reflecting URL params or storage; manifest CSP, `externally_connectable`, `web_accessible_resources`; sentinel registration patterns; the feedback backend; vendored-code provenance |
| B2 | **Privacy** | every network primitive and every storage write, classified deliberate vs passive and checked against the incognito gate; retention/quota; what the report page and uninstall survey send; debug-timing stays local; policy text vs code |
| B3 | **Performance** | `OBR.debugTiming(true)` on a benchmark set (small/medium/huge article, image-heavy page); open time, clone cost on huge DOMs, repaginate-on-resize, gallery hydration, worker cold start; set budgets and add one timing assertion |
| B4 | **Reliability** | injection-sequence failure modes; the four orphan-context doors; storage error handling; what the user sees on restricted pages; worker state lost on termination |
| B5 | **Maintainability** | size/complexity of the five big files; duplication between engines; dead code; TODO markers; absence of lint/typecheck |
| B6 | **Accessibility** | focus trap in the overlay, keyboard-only operation, ARIA roles, page-turn announcements, reduced-motion for the flip, contrast per theme, forced-colors |
| B7 | **Internationalization** | hard-coded English in shipped code; pluralization; RTL layout; CJK word counting; `verify-locales` parity |
| B8 | **Compatibility** | every API/CSS feature used vs `minimum_chrome_version`; Edge/Brave/Arc behaviour |
| B9 | **Process** | action pinning, workflow permissions, secrets exposure, tag-guard logic, dependency freshness, Dependabot, packaging allowlist vs references |
| B10 | **Documentation drift** | sampled statements in CLAUDE.md/docs/README vs code |

## Phases

| phase | when | what | output |
| --- | --- | --- | --- |
| **1 — Baseline** | day 0 | `npm ci && npm test`; record pass rate, duration, environment; build the claims inventory (A1) | `baseline.md` |
| **2 — Automated sweeps** | day 1 | B1, B2, B4, B5, B7, B8, B9, B10 as static review + grep sweeps; `npm audit` / `npm outdated`; locale verification | first `findings.md` |
| **3 — Deep dives** | days 2–4 | A2–A7 with a checklist per module; B3 benchmarks; B6 headed a11y pass; verify every Phase 2 SUSPECTED finding | `findings.md` updated, fixtures added |
| **4 — Report + fix plan** | day 5 | severity-ordered findings with repro + proposed fix; coverage map; open issues or a dated summary | issues / summary |

Phases 1 and 2 parallelize well and need no browser interaction beyond the suite. Phase 3
needs a headed browser for the real-site sweep and the accessibility pass.

## Severity scale

| level | meaning |
| --- | --- |
| **P0** | exploitable privilege gain, cross-origin read, or undisclosed data leaving the device; data loss |
| **P1** | user-visible breakage of a core claim; a privacy gate with a hole; a process gap that could ship a bad build |
| **P2** | hardening; a claim with no automated proof; drift that would mislead a contributor |
| **P3** | low; cosmetic; nice-to-have |
| **Info** | observation, no action required |

Every finding records: id, severity, area, `file:line`, what the code does, why it matters under
the threat model, **CONFIRMED** (full path read or reproduced) vs **SUSPECTED**, and the smallest
safe fix.

## Rules while auditing

- Read-only until Phase 4: findings are logged, not fixed, so the picture stays whole.
- Security specifics stay descriptive in this public repo: vectors are named, payloads are
  not. Anything rated P0/P1 in security goes through the private channel in `SECURITY.md`
  before it is written up here.
- RULE #1 from `CLAUDE.md` applies to every audit file: nothing personal, no credentials, no
  private tooling names.
