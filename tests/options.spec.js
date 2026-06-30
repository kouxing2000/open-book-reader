/* Options-page UX: the how-to-use guide, shortcut docs, and first-run open.
 * Uses the REAL unpacked extension (options runs in a genuine extension context
 * with real chrome.storage / chrome.runtime — no shim needed). */
import { test, expect } from './fixtures.js';

const optionsUrl = (id) => `chrome-extension://${id}/src/options/options.html`;

test('the options page shows the how-to-use guide with the trigger + shortcut docs', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));

  const guide = page.locator('details.guide');
  await expect(guide).toBeVisible();
  await guide.locator('summary').click(); // collapsed by default — expand to read the docs
  await expect(guide).toContainText('Toolbar icon');
  await expect(guide).toContainText('Right-click');
  await expect(guide).toContainText('Per-site rules');
  await expect(guide).toContainText('Picked the wrong content'); // the override docs are discoverable
  // Both shipped shortcuts are documented: Alt+B and Alt+Shift+B each end in <kbd>B</kbd>.
  await expect(guide.locator('kbd', { hasText: /^B$/ })).toHaveCount(2);
  await expect(guide.locator('kbd', { hasText: 'Esc' }).first()).toBeVisible();
  // The customize story: a button into Chrome's own editor (not an in-page editor).
  await expect(page.locator('#shortcutsBtn')).toBeVisible();
});

test('the guide is collapsed by default and expands on click (native <details>)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  const guide = page.locator('details.guide');
  await expect(guide).toHaveJSProperty('open', false); // collapsed by default — settings come first
  await guide.locator('summary').click();
  await expect(guide).toHaveJSProperty('open', true);
});

test('settings are grouped into Reader / Image gallery / Smart open cards', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  const cards = page.locator('section.card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).locator('h2')).toContainText('Reader');
  await expect(cards.nth(1).locator('h2')).toContainText('Image gallery');
  await expect(cards.nth(2).locator('h2')).toContainText('Smart open');
  // A representative control lives in each group (print under Reader, gallery
  // column under Image gallery, per-site rules under Smart open).
  await expect(cards.nth(0).locator('#printSourceUrl')).toBeVisible();
  await expect(cards.nth(1).locator('#galleryColWidth')).toBeVisible();
  await expect(cards.nth(2).locator('#siteHost')).toBeVisible();
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

test('saved content picks render their host + selector and can be removed', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));

  // Empty state first (fresh profile → no saved picks).
  await expect(page.locator('#picks')).toContainText('No saved picks yet.');

  // Seed two picks directly into the real chrome.storage.sync, then reload so the
  // options page lists them (this is what the reader's "Save for this site" writes).
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_picks: {
      'example.com': { sel: '#main > article', t: 2 },
      'blog.test': { sel: '#post-body', t: 1 },
    },
  }, res)));
  await page.reload();

  const picks = page.locator('#picks');
  await expect(picks.locator('.pick-host')).toHaveCount(2);
  await expect(page.locator('#picksCount')).toHaveText('(2)'); // count badge tracks the list
  await expect(picks).toContainText('example.com');
  await expect(picks).toContainText('blog.test');
  // The stored selector is shown in an editable input.
  await expect(picks.locator('.pick-row', { hasText: 'example.com' }).locator('.pick-sel-input'))
    .toHaveValue('#main > article');

  // Remove the example.com row → it disappears AND is gone from storage.
  await picks.locator('.pick-row', { hasText: 'example.com' }).locator('.site-remove').click();
  await expect(picks.locator('.pick-host')).toHaveCount(1);
  await expect(page.locator('#picksCount')).toHaveText('(1)'); // count updates on remove
  await expect(picks).not.toContainText('example.com');

  const remaining = await page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_picks', (d) => res(d.obr_picks || {}))));
  expect(Object.keys(remaining)).toEqual(['blog.test']);
});

test('a saved pick selector is editable: valid edits persist, invalid ones are rejected', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_picks: { 'example.com': { sel: '#old-selector', t: 1 } },
  }, res)));
  await page.reload();

  const input = page.locator('#picks .pick-sel-input').first();
  await expect(input).toHaveValue('#old-selector');

  // Edit to a valid selector → ✓ and persisted to storage.
  await input.fill('.article-body');
  await expect(page.locator('#picks .pick-valid.ok')).toBeVisible();
  await input.blur();
  await expect
    .poll(() => page.evaluate(() => new Promise((res) =>
      chrome.storage.sync.get('obr_picks', (d) => res(d.obr_picks['example.com'].sel)))))
    .toBe('.article-body');

  // Edit to a syntactically broken selector → ✗ and NOT persisted (last good value stays).
  await input.fill(':::');
  await expect(page.locator('#picks .pick-valid.bad')).toBeVisible();
  await input.blur();
  const stored = await page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_picks', (d) => res(d.obr_picks['example.com'].sel))));
  expect(stored).toBe('.article-body');
});

test('a wrongly-edited selector can be cancelled with Escape or reverted with ↶', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_picks: { 'example.com': { sel: '#good', t: 1 } },
  }, res)));
  await page.reload();

  const row = page.locator('#picks .pick-row', { hasText: 'example.com' });
  const input = row.locator('.pick-sel-input');
  const revert = row.locator('.pick-revert');
  const stored = () => page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_picks', (d) => res(d.obr_picks['example.com'].sel))));

  await expect(revert).toBeHidden(); // nothing to undo yet

  // Escape cancels an in-progress edit BEFORE it commits → back to last saved, nothing written.
  await input.fill('.typo-in-progress');
  await expect(revert).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveValue('#good');
  await expect(revert).toBeHidden();
  expect(await stored()).toBe('#good');

  // Now commit a valid-but-wrong edit (blur), then ↶ Revert restores AND re-saves the original.
  await input.fill('.bad-but-valid');
  await input.blur();
  await expect.poll(stored).toBe('.bad-but-valid');
  await expect(revert).toBeVisible();
  await revert.click();
  await expect(input).toHaveValue('#good');
  await expect.poll(stored).toBe('#good');
  await expect(revert).toBeHidden();
});

test('?site= scopes the rules + picks lists to one site, and "Show all" clears it', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_picks: { 'example.com': { sel: '#a', t: 2 }, 'other.test': { sel: '#b', t: 1 } },
    obr_settings: { siteRules: [
      { match: 'example.com', mode: 'text' },
      { match: 'example.com/blog/*', mode: 'images' }, // PATH-scoped rule for the same host
      { match: 'other.test', mode: 'images' },
    ] },
  }, res)));

  // Open scoped to example.com.
  await page.goto(optionsUrl(extensionId) + '?site=example.com');
  await expect(page.locator('#siteFilterBar')).toBeVisible();
  await expect(page.locator('#siteFilterName')).toHaveText('example.com');

  // example.com's pick shows; its whole-site AND path-scoped rules both show; other.test hidden.
  await expect(page.locator('#picks .pick-host')).toHaveText(['example.com']);
  await expect(page.locator('#sites .site-host')).toHaveText(['example.com', 'example.com/blog/*']);

  // "Show all" → everything visible again, banner gone, ?site dropped from the URL.
  await page.locator('#siteFilterClear').click();
  await expect(page.locator('#siteFilterBar')).toBeHidden();
  await expect(page.locator('#picks .pick-host')).toHaveCount(2);
  await expect(page.locator('#sites .site-host')).toHaveCount(3);
  expect(new URL(page.url()).search).toBe('');
});

test('savePick bounds the map by bytes (not just count) and reports success', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  const r = await page.evaluate(async () => {
    // A ~200-char selector so 50 entries serialize to ~12.5KB — over BOTH the 7500-byte
    // budget AND the 8192 sync per-item quota. Count-pruning alone would leave 50 entries
    // (~12.5KB, which would actually fail the quota and resolve false); byte-pruning must
    // drop the count BELOW PICKS_MAX to fit. Monotonic `now` makes LRU deterministic
    // (site0 oldest → dropped; site59 newest → kept).
    const long = 'body ' + '> div:nth-of-type(7) '.repeat(9) + '> article';
    let lastOk;
    for (let i = 0; i < 60; i++) lastOk = await OBR.savePick('site' + i + '.example.com', long + ' /*' + i + '*/', 1000 + i);
    const map = await new Promise((res) => chrome.storage.sync.get('obr_picks', (d) => res(d.obr_picks || {})));
    return {
      lastOk,
      count: Object.keys(map).length,
      bytes: JSON.stringify(map).length,
      keptNewest: !!map['site59.example.com'],
      droppedOldest: !map['site0.example.com'],
    };
  });
  expect(r.lastOk).toBe(true);               // a confirmed write resolves true (byte-prune kept it under quota)
  expect(r.bytes).toBeLessThanOrEqual(7500); // PICKS_MAX_BYTES
  expect(r.count).toBeLessThan(50);          // byte-pruning dropped BELOW PICKS_MAX — proves it fired
  expect(r.keptNewest).toBe(true);
  expect(r.droppedOldest).toBe(true);        // LRU dropped the oldest
});

test('reset to defaults also clears saved content picks', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_picks: { 'example.com': { sel: '#main', t: 1 } },
  }, res)));
  await page.reload();
  await expect(page.locator('#picks .pick-host')).toHaveCount(1);

  await page.locator('#reset').click();
  await expect(page.locator('#picks')).toContainText('No saved picks yet.');
  const after = await page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_picks', (d) => res(d.obr_picks || null))));
  expect(after === null || Object.keys(after).length === 0).toBe(true);
});
