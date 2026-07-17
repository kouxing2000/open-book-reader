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
  await expect(cards.nth(1).locator('#galleryColumns')).toBeVisible();
  await expect(cards.nth(2).locator('#siteHost')).toBeVisible();
});

test('the per-site rules editor renders (empty state) below the guide', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await expect(page.locator('#siteHost')).toBeVisible();
  await expect(page.locator('#sites')).toContainText('No per-site rules yet.');
});

test('first install opens the welcome page automatically (onboarding)', async ({ context, extensionId }) => {
  // The fixture launches a fresh profile, so onInstalled fires with reason 'install' and
  // background.js opens the one-screen WELCOME page (activation — pin/shortcuts/sample),
  // NOT the settings form it used to dump new users into.
  await expect
    .poll(() => context.pages().some((p) => p.url().includes('/src/welcome.html')), { timeout: 8000 })
    .toBe(true);
});

test('the report page runs its external (CSP-safe) script: diagnostics fill + Send enables on input', async ({ page, extensionId }) => {
  // report.html is a bundled extension page. MV3's CSP (script-src 'self') BLOCKS inline
  // <script>, so the page logic MUST live in an external file (src/report.js). If it ever
  // regresses to inline, the script silently never runs — the diagnostics box stays empty and
  // the Send button never enables. This test reproduces exactly that failure surface.
  const meta = { app: 'open-book-reader', version: '9.9.9', mode: 'text', pageUrl: 'https://example.com/a' };
  await page.goto(`chrome-extension://${extensionId}/src/report.html#` + encodeURIComponent(JSON.stringify(meta)));

  // Script ran → diagnostics populated from the #fragment.
  await expect(page.locator('#diag')).toContainText('"version": "9.9.9"');
  // Send starts disabled and enables once a description is typed.
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#desc').fill('the reader grabbed the comments');
  await expect(page.locator('#send')).toBeEnabled();
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

test('a site stashed in storage.local scopes a freshly-opened options page, then is cleared (the ⚙ deep-link path)', async ({ page, context, serviceWorker, extensionId }) => {
  // Mirror the REAL flow: the SERVICE WORKER writes the picks + stashes the site (background.js
  // does this on the ⚙ message) with NO options page open yet — so nothing consumes the stash
  // early — then openOptionsPage() loads a fresh page that must come up scoped to that site.
  //
  // Onboarding now opens a WELCOME tab (no options storage.onChanged listener), so there's no
  // onboarding race to defend against — but still guarantee ZERO options tabs/listeners are live
  // when we stash: park our own page off any options URL and close any that slipped open.
  await page.goto('about:blank');
  for (const p of context.pages()) { if (p.url().includes('/options.html')) await p.close(); }

  await serviceWorker.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_picks: { 'example.com': { sel: '#a', t: 2 }, 'other.test': { sel: '#b', t: 1 } },
  }, res)));
  await serviceWorker.evaluate(() => new Promise((res) => chrome.storage.local.set({ obr_options_site: 'example.com' }, res)));
  await page.goto(optionsUrl(extensionId)); // fresh load, no ?site=
  await expect(page.locator('#siteFilterBar')).toBeVisible();
  await expect(page.locator('#siteFilterName')).toHaveText('example.com');
  await expect(page.locator('#picks .pick-host')).toHaveText(['example.com']);
  // The stash is consumed so a LATER plain open isn't stuck on a stale site.
  await expect
    .poll(() => page.evaluate(() => new Promise((res) =>
      chrome.storage.local.get('obr_options_site', (d) => res(d.obr_options_site || null)))))
    .toBe(null);
});

test('a storage.local site change re-scopes an already-open options tab (so ⚙ need not duplicate it)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_picks: { 'example.com': { sel: '#a', t: 2 }, 'other.test': { sel: '#b', t: 1 } },
  }, res)));
  await page.reload();
  await expect(page.locator('#picks .pick-host')).toHaveCount(2); // unscoped to start

  // The user clicks ⚙ from example.com while this tab is already open → SW stashes the site.
  // The onChanged listener must re-scope live (no new tab).
  await page.evaluate(() => new Promise((res) => chrome.storage.local.set({ obr_options_site: 'example.com' }, res)));
  await expect(page.locator('#siteFilterBar')).toBeVisible();
  await expect(page.locator('#siteFilterName')).toHaveText('example.com');
  await expect(page.locator('#picks .pick-host')).toHaveText(['example.com']);
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

test('the Auto-open checkbox asks for the site permission — grant, uncheck, and deny paths', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  // Stub the permission prompt: a real permissions.request pops a native dialog headless
  // can't answer. NOTE this assumes chrome.* stays monkey-patchable on extension pages
  // (true today; if Chrome ever freezes it, this coverage moves to the manual checklist).
  await page.evaluate(() => {
    window.__permCalls = [];
    window.__permGrant = true;
    chrome.permissions = {
      request: (need, cb) => { window.__permCalls.push(need); cb(window.__permGrant); },
    };
  });

  await page.fill('#siteHost', 'example.com');
  await page.click('#siteAddBtn');
  const row = page.locator('.site-row', { hasText: 'example.com' });
  await expect(row).toBeVisible();
  const cb = row.locator('.site-auto input');
  await expect(cb).not.toBeChecked();

  const storedRule = () => page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_settings', (d) => res(((d.obr_settings || {}).siteRules || [])[0]))));

  // GRANT: checking asks for exactly the rule's origins, then persists the flag.
  await cb.click();
  await expect.poll(storedRule).toEqual({ match: 'example.com', mode: 'auto', auto: true });
  expect(await page.evaluate(() => window.__permCalls)).toEqual([
    { origins: ['*://example.com/*', '*://www.example.com/*'] },
  ]);

  // UNCHECK: clears only the flag — no permission call, never an auto-revoke.
  await cb.click();
  await expect.poll(storedRule).toEqual({ match: 'example.com', mode: 'auto' });
  expect(await page.evaluate(() => window.__permCalls.length)).toBe(1);

  // DENY: the checkbox reverts and nothing persists.
  await page.evaluate(() => { window.__permGrant = false; });
  await cb.click();
  await expect(cb).not.toBeChecked();
  await expect.poll(storedRule).toEqual({ match: 'example.com', mode: 'auto' });
});

test('a rule whose host cannot form a match pattern gets a disabled Auto checkbox', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  // A mid-host wildcard is fine as a RULE glob but cannot become a Chrome origin
  // pattern (originsForRule → []) — auto-open must be visibly unavailable, with the
  // why in the tooltip, not silently broken.
  await page.fill('#siteHost', 'ex*mple.com');
  await page.click('#siteAddBtn');
  const row = page.locator('.site-row', { hasText: 'ex*mple.com' });
  await expect(row).toBeVisible();
  await expect(row.locator('.site-auto input')).toBeDisabled();
  await expect(row.locator('.site-auto')).toHaveAttribute('title', /can.t auto-open/);
});
