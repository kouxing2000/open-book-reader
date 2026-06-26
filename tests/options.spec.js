/* Options-page UX: the how-to-use guide, shortcut docs, and first-run open.
 * Uses the REAL unpacked extension (options runs in a genuine extension context
 * with real chrome.storage / chrome.runtime — no shim needed). */
import { test, expect } from './fixtures.js';

const optionsUrl = (id) => `chrome-extension://${id}/src/options/options.html`;

test('the options page shows the how-to-use guide with the trigger + shortcut docs', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));

  const guide = page.locator('details.guide');
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('Toolbar icon');
  await expect(guide).toContainText('Right-click');
  await expect(guide).toContainText('Per-site rules');
  // Both shipped shortcuts are documented: Alt+B and Alt+Shift+B each end in <kbd>B</kbd>.
  await expect(guide.locator('kbd', { hasText: /^B$/ })).toHaveCount(2);
  await expect(guide.locator('kbd', { hasText: 'Esc' }).first()).toBeVisible();
  // The customize story: a button into Chrome's own editor (not an in-page editor).
  await expect(page.locator('#shortcutsBtn')).toBeVisible();
});

test('the guide is collapsible (native <details>)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  const guide = page.locator('details.guide');
  await expect(guide).toHaveJSProperty('open', true); // open by default for first-run discovery
  await guide.locator('summary').click();
  await expect(guide).toHaveJSProperty('open', false);
});

test('the per-site rules editor renders (empty state) below the guide', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await expect(page.locator('#siteHost')).toBeVisible();
  await expect(page.locator('#sites')).toContainText('No per-site rules yet.');
});

test('first install opens the options page automatically (onboarding)', async ({ context, extensionId }) => {
  // The fixture launches a fresh profile, so onInstalled fires with reason 'install'
  // and background.js calls openOptionsPage — an options tab should appear unprompted.
  await expect
    .poll(() => context.pages().some((p) => p.url().includes('/src/options/options.html')), { timeout: 8000 })
    .toBe(true);
});
