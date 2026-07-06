/* macOS locale lock for the test browser.
 *
 * Extension PAGES (options / welcome / report / permission) are real pages where chrome.i18n
 * follows the browser's UI locale. On Linux (CI) `--lang=en-US` (in fixtures.js) pins it, but
 * macOS IGNORES `--lang` and reads the OS locale — so on a non-English Mac the suite renders in
 * the dev's language (e.g. zh_CN) and English text assertions break. Cocoa apps read their UI
 * language from the `AppleLanguages` default, so we set it on the Chrome-for-Testing bundle for
 * the run and delete it after (same approach as scripts/test-locale.sh). No-op off macOS. */
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import os from 'node:os';

const isMac = os.platform() === 'darwin';
const bundleId = () => {
  const app = chromium.executablePath().split('/Contents/MacOS/')[0];
  return execSync(`defaults read "${app}/Contents/Info" CFBundleIdentifier`).toString().trim();
};

export function lockEnLocale() {
  if (!isMac) return;
  try { execSync(`defaults write "${bundleId()}" AppleLanguages '(en-US)'`); }
  catch (e) { console.warn('en-locale lock skipped (extension-page tests may use the OS locale):', e.message); }
}

export function unlockLocale() {
  if (!isMac) return;
  try { execSync(`defaults delete "${bundleId()}" AppleLanguages`); }
  catch (e) { /* nothing to revert */ }
}
