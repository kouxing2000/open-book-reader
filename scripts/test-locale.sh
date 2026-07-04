#!/usr/bin/env bash
# Eyeball the extension's localization in an ISOLATED browser — fully automatic:
# auto-loads the unpacked extension AND opens a test article, in the chosen language.
# macOS only.
#
#   ./scripts/test-locale.sh                 # en, default test article
#   ./scripts/test-locale.sh de              # German
#   ./scripts/test-locale.sh ja https://...  # Japanese UI on your own test page
#
# locale: en | de | es | fr | ja | ru | pt-BR   (default en; use the BCP-47 tag
#         "pt-BR" here, NOT the on-disk folder name "pt_BR" — Chrome maps pt-BR -> pt_BR)
# url:    any article to test on               (default: a text+image Wikipedia page)
#
# It uses "Chrome for Testing" (the automation build Playwright installed) — a
# SEPARATE binary from your everyday Google Chrome, so your normal browser is
# untouched. Two reasons this is needed (Chrome 137+ / macOS quirks):
#   * regular Chrome now IGNORES --load-extension, so the extension never loads;
#   * on macOS the UI language comes from AppleLanguages, NOT the --lang flag.
# Chrome for Testing honors both. The locale override is written only to the
# for-testing binary's domain and reverted on exit — your real Chrome is never
# touched. Test one language at a time (the override is per-binary, not per-window).
set -euo pipefail

LOCALE="${1:-en}"
TESTURL="${2:-https://en.wikipedia.org/wiki/Book}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATADIR="/tmp/obr-test-${LOCALE}"

# Chrome for Testing path via Playwright (already installed for the test suite).
CFT="$(node -e "import('@playwright/test').then(m=>console.log(m.chromium.executablePath())).catch(()=>process.exit(1))" 2>/dev/null || true)"
if [ -z "${CFT}" ] || [ ! -x "${CFT}" ]; then
  echo "Chrome for Testing not found. Install it once with:  npx playwright install chromium"
  exit 1
fi
APP="${CFT%/Contents/MacOS/*}"
BUNDLE="$(defaults read "${APP}/Contents/Info" CFBundleIdentifier 2>/dev/null || echo com.google.chrome.for.testing)"

# Force the UI locale for this binary (macOS reads AppleLanguages), revert on exit.
defaults write "${BUNDLE}" AppleLanguages "(${LOCALE})"
cleanup() { defaults delete "${BUNDLE}" AppleLanguages >/dev/null 2>&1 || true; echo "· locale override reverted"; }
trap cleanup EXIT INT TERM

echo "Chrome for Testing (separate from your daily Chrome), language = ${LOCALE}"
echo "  ext  : ${REPO}  (auto-loaded)"
echo "  page : ${TESTURL}"
echo "  test : on the article press Alt+B (reader) / Alt+Shift+B (gallery)"
echo "  (this stays attached until you CLOSE the window, then reverts the locale)"

# Blocks until the window is closed; the trap then reverts the locale override.
"${CFT}" \
  --user-data-dir="${DATADIR}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions-except="${REPO}" \
  --load-extension="${REPO}" \
  "${TESTURL}" >/dev/null 2>&1 || true
