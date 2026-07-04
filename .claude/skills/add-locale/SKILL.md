---
name: add-locale
description: >-
  Add a new UI + store language to THIS Chrome extension (Open Book — Reader View).
  Use when localizing the extension into another locale: translating the _locales
  message catalog, the ASO store title/summary, and the store detailed description.
  Covers the exact rules and the gotchas that have bitten this repo before.
---

# Add a language to Open Book — Reader View

The one-and-done i18n plumbing is already built (`chrome.i18n` wiring, the `OBR.t`
helper, the packaging allowlist, the test-harness shim). Adding a language is now a
**translate + verify** task. This skill is the checklist so nothing is missed.

## The surfaces (what a "language" covers)
1. **In-app UI** — `_locales/<loc>/messages.json` (reader, gallery, context menu). Ships in the package.
2. **Store title + summary** — the `extName` / `extSummary` keys in that same file. Ship in the package via `__MSG__`; **no dashboard entry**.
3. **Store detailed description** — `.meta/LISTING.md` is the source; per-locale copy in `.meta/listings/<loc>.txt`. **Dashboard-only, pasted by hand** (there is no API for it).

## Steps
1. **Pick the locale code** = the `_locales` folder name (BCP-47 with `_`, e.g. `pt_BR`, `zh_TW`).
2. **Translate the catalog:** copy `_locales/en/messages.json` → `_locales/<loc>/messages.json` and translate every `message`. This is ~103 keys; a subagent per language works well (one file each, no conflicts).
3. **ASO title/summary (NOT a literal translation):**
   - `extName` = keep the `Open Book — ` brand + that language's real "reader mode" search term (de `Lesemodus`, es `Modo Lectura`, fr `Mode Lecture`, ja `リーダーモード`, ru `Режим чтения`, pt_BR `Modo de Leitura`).
   - `extSummary` ≤ **132 chars** for that locale (verify — Romance/Cyrillic run long).
4. **Detailed description:** translate `.meta/LISTING.md`'s Description into `.meta/listings/<loc>.txt` (keep the 22 bullets, the GitHub URL, and the keyboard shortcuts verbatim; weave the local reader-mode terms; ASO, not literal).
5. **Verify:** `npm run verify:locales` (parity, placeholders, tokens, char limits, src/manifest coverage). Then `npm test` — it runs the verify as `pretest` AND exercises the localized UI. **Read the exit code / full summary, never a `tail`.**
6. **Eyeball it:** `./scripts/test-locale.sh <loc>` launches an isolated Chrome for Testing in that language with the extension + a test article (check `de`/`ru` for toolbar overflow — long words).
7. **Ship:** `npm run bump -- patch` → `git push --follow-tags`. After it's live, the store's per-language dropdown appears — paste `.meta/listings/<loc>.txt` into that locale's Description.

## Translation rules (keys NEVER change; translate only human-readable words)
- Keep verbatim: `$TOKENS$` (`$COUNT$`, `$MINUTES$`, …) and every entry's `placeholders` block; glyphs/emoji (⌖ 🖨 ⚠ ⚙ ✕ 🖼 ⟳ ← → ↑↓ · — …); the `<b>…</b>` in `readerPickBarInstruction`; keyboard key names in `readerFooterHint` (`Space`, `T`, `P`, `Esc`) and shortcut letters in `(T)`/`(P)`/`(A)`; `ZIP`, `PDF`, `Mozilla Readability`, `Chrome`, `GitHub`, the repo URL.
- Toolbar labels must be **short** (they sit in a row) — use the shortest natural term.

## Gotchas (learned the hard way)
- ⚠️ **The test harness has NO `chrome.i18n`.** Tests inject content scripts into the page **main world**, which lacks `chrome.i18n` — so `OBR.t` would throw. `tests/helpers.js` shims it (`i18nShim`, registered next to `storageShim`) resolving from `_locales/en`. If you add a NEW `chrome.*` API to a content script, add its harness shim in the SAME change. (This gap once failed 101 tests.)
- ⚠️ **Verify by exit code / full summary — NEVER `npm test | tail -N`.** A truncated tail once hid `101 failed` behind a trailing `40 passed`, and a broken release got pushed. Use `npm test; echo $?` or read the whole log.
- **Packaging allowlist:** `_locales` must stay in `SHIP_DIRS` (`scripts/package-extension.js`) and `_locales/en/messages.json` in `REQUIRED_FILES` — else the whole localization silently doesn't ship. `packaging.spec.js` guards this.
- **`default_locale: "en"`** is load-bearing: Chrome rejects the package if `_locales/en` is missing, and any `__MSG_key__` with no en key breaks the manifest.
- **Manifest `__MSG__` fields to cover:** `name`, `description`, `action.default_title`, and both `commands[].description` — all need catalog keys (`extName`, `extSummary`, `actionTitle`, `cmdToggleReader`, `cmdToggleGallery`).
- **`chrome.i18n` resolves by the BROWSER's UI language** — there is no clean runtime override, so no in-app language picker (see the session notes). Test other locales via `test-locale.sh` (macOS: it sets `AppleLanguages` on Chrome for Testing; `--lang` is ignored on macOS).
- **CWS listing localization is real** (not one-language): the per-language dropdown in the dashboard appears only **after** a package that declares `_locales` is published. Titles/summaries come from the package; detailed descriptions + screenshots are per-language in the dashboard.

## Tools
- `npm run verify:locales` — `scripts/verify-locales.mjs` (drift guard; runs as `pretest`).
- `./scripts/test-locale.sh <loc> [url]` — isolated, auto-loading, correct-language Chrome for eyeballing.
