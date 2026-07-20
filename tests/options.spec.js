/* Options-page UX: the how-to-use guide, shortcut docs, and first-run open.
 * Uses the REAL unpacked extension (options runs in a genuine extension context
 * with real chrome.storage / chrome.runtime — no shim needed). */
import { test, expect } from './fixtures.js';

const optionsUrl = (id) => `chrome-extension://${id}/src/options/options.html`;

// Settings groups are collapsible <details class="card"> now: Reader is open by default, the
// rest (Image gallery / Smart open / Per-site data) start collapsed to keep the page short.
// Read-only assertions still work on collapsed content, but click/fill/selectOption need the
// section expanded first — call this after a navigation before interacting with those controls.
const openSections = (page) =>
  page.evaluate(() => document.querySelectorAll('details.card').forEach((d) => { d.open = true; }));

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

test('settings are grouped into collapsible Reader / Image gallery / Smart open / Per-site data cards', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  const cards = page.locator('details.card');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0).locator('summary')).toContainText('Reader');
  await expect(cards.nth(1).locator('summary')).toContainText('Image gallery');
  await expect(cards.nth(2).locator('summary')).toContainText('Smart open');
  await expect(cards.nth(3).locator('summary')).toContainText('Per-site data');
  // Reader is open by default; the rest collapse so the page stays short.
  await expect(cards.nth(0)).toHaveJSProperty('open', true);
  await expect(cards.nth(1)).toHaveJSProperty('open', false);
  await expect(cards.nth(2)).toHaveJSProperty('open', false);
  await expect(cards.nth(3)).toHaveJSProperty('open', false);
  // A representative control lives in each group (print under Reader, gallery column under
  // Image gallery, a threshold under Smart open, per-site rules under Per-site data). Only
  // Reader is open, so the collapsed ones are asserted attached rather than visible.
  await expect(cards.nth(0).locator('#printSourceUrl')).toBeVisible();
  await expect(cards.nth(1).locator('#galleryColumns')).toBeAttached();
  await expect(cards.nth(2).locator('#autoGalleryMin')).toBeAttached();
  await expect(cards.nth(3).locator('#siteHost')).toBeAttached();
});

test('the Per-site data header badges the count of sites with saved data (visible while collapsed)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await expect(page.locator('#perSiteCount')).toHaveText(''); // fresh profile → nothing saved → no badge

  // A rule on one host + a saved pick on another = two distinct sites (the focus-host count).
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [{ match: 'a.test', mode: 'text' }] },
    obr_picks: { 'b.test': { sel: '#x', t: 1 } },
  }, res)));
  await page.reload();

  // The count shows on the still-COLLAPSED section (no openSections) — that's the whole point.
  await expect(page.locator('details.card', { hasText: 'Per-site data' })).toHaveJSProperty('open', false);
  await expect(page.locator('#perSiteCount')).toHaveText('(2)');
});

test('sections remember their open/closed state across reloads (per-device localStorage)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  const gallery = page.locator('details.card').nth(1); // Image gallery, collapsed by default
  await expect(gallery).toHaveJSProperty('open', false);

  await gallery.locator('summary').click();
  await expect(gallery).toHaveJSProperty('open', true);
  // The <details> `toggle` event is async, so wait for the write to land before reloading.
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('obr_options_open') || '{}').optSecGallery))
    .toBe(true);

  await page.reload();
  await expect(page.locator('details.card').nth(1)).toHaveJSProperty('open', true); // restored
});

test('the per-site rules editor renders (empty state) below the guide', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await openSections(page); // Per-site data starts collapsed
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
  await openSections(page);

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
  await openSections(page);

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
  await openSections(page);

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
  // Scoping auto-expands the (otherwise-collapsed) Per-site data section so the filtered
  // rules/picks lists are actually visible — the ⚙ deep-link and focus dropdown rely on this.
  await expect(page.locator('#perSiteSection')).toHaveJSProperty('open', true);

  // example.com's pick shows; its whole-site AND path-scoped rules both show; other.test hidden.
  await expect(page.locator('#picks .pick-host')).toHaveText(['example.com']);
  const scopedPats = page.locator('#sites .site-pat-input'); // the pattern is now an editable field
  await expect(scopedPats).toHaveCount(2);
  await expect(scopedPats.nth(0)).toHaveValue('example.com');
  await expect(scopedPats.nth(1)).toHaveValue('example.com/blog/*');

  // "Show all" → everything visible again, banner gone, ?site dropped from the URL.
  await page.locator('#siteFilterClear').click();
  await expect(page.locator('#siteFilterBar')).toBeHidden();
  await expect(page.locator('#picks .pick-host')).toHaveCount(2);
  await expect(page.locator('#sites .site-pat-input')).toHaveCount(3);
  expect(new URL(page.url()).search).toBe('');
});

test('each per-site rule shows a plain-English gloss of what it does (scope + mode + auto)', async ({ page, extensionId }, testInfo) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [
      { match: 'example.com', mode: 'auto', auto: true },        // whole site, auto-open, smart pick
      { match: 'example.com/forum/t/*', mode: 'text', auto: true }, // path-scoped, auto-open, forced Reader
      { match: 'other.test/blog/*', mode: 'images' },            // path-scoped, click-only, forced Gallery
      { match: '*.sub.test', mode: 'auto' },                     // all subdomains, click-only, smart pick
    ] },
  }, res)));
  await page.goto(optionsUrl(extensionId));
  await openSections(page); // Per-site data starts collapsed; the mode <select> + screenshot need it open

  // The gloss is derived (nothing stored), so it always matches the live rule.
  await expect(page.locator('#sites .site-sub')).toHaveText([
    'Whole site · opens by itself when the page looks like an article or gallery',
    'Only /forum/t/* · opens by itself, always as Reader',
    'Only /blog/* · sets the default mode to Gallery; opens on click',
    'All subdomains · sets the default mode; opens on click',
  ]);

  // Flipping mode updates the gloss in place (no full re-render).
  const forumRow = page.locator('.site-row', { hasText: '/forum/t/*' });
  await forumRow.locator('.site-mode').selectOption('images');
  await expect(forumRow.locator('.site-sub')).toHaveText('Only /forum/t/* · opens by itself, always as Gallery');

  await testInfo.attach('per-site-rules', { body: await page.locator('#sites').screenshot(), contentType: 'image/png' });
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

test('the "auto-open on pages like this" prefill fills + focuses the add-rule form (the menu URL deep-link)', async ({ page, context, serviceWorker, extensionId }) => {
  // Mirror the REAL flow (like the stash test): the SW writes the one-shot prefill key with NO
  // options page open (so no live onChanged listener consumes it early), then openOptionsPage()
  // loads a fresh page that must come up pre-filled. Park off any options URL + close stragglers.
  await page.goto('about:blank');
  for (const p of context.pages()) { if (p.url().includes('/options.html')) await p.close(); }

  await serviceWorker.evaluate(() => new Promise((res) => chrome.storage.local.set({
    obr_options_prefill: { pattern: 'example.com/forum/*', auto: true },
  }, res)));
  await page.goto(optionsUrl(extensionId)); // fresh load consumes it

  // Per-site data is expanded (scoped), the add-rule field carries the full pattern (not just the
  // host), Auto-open is ticked, and focus lands on the field — the "scroll to the edit area" intent.
  await expect(page.locator('#perSiteSection')).toHaveJSProperty('open', true);
  await expect(page.locator('#siteHost')).toHaveValue('example.com/forum/*');
  await expect(page.locator('#siteAuto')).toBeChecked();
  await expect(page.locator('#siteHost')).toBeFocused();
  // The stash is consumed so a later plain open doesn't re-fill the form.
  await expect
    .poll(() => page.evaluate(() => new Promise((res) =>
      chrome.storage.local.get('obr_options_prefill', (d) => res(d.obr_options_prefill || null)))))
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
  // The shim models a real GRANTED SET so contains/getAll/remove stay coherent with each
  // other — a request-only stub made the uncheck path pass vacuously (no `remove` meant the
  // revoke silently no-opped) while asserting the opposite of the shipped behaviour.
  await page.evaluate(() => {
    window.__permCalls = [];
    window.__permRemoved = [];
    window.__permGrant = true;
    window.__granted = [];
    chrome.permissions = {
      request: (need, cb) => {
        window.__permCalls.push(need);
        if (window.__permGrant) (need.origins || []).forEach((o) => window.__granted.push(o));
        cb(window.__permGrant);
      },
      remove: (need, cb) => {
        window.__permRemoved.push(need);
        window.__granted = window.__granted.filter((o) => (need.origins || []).indexOf(o) === -1);
        cb(true);
      },
      contains: (need, cb) => cb((need.origins || []).every((o) => window.__granted.indexOf(o) !== -1)),
      getAll: (cb) => cb({ origins: window.__granted.slice() }),
    };
  });

  await openSections(page); // Per-site data starts collapsed
  await page.fill('#siteHost', 'example.com');
  await page.click('#siteAddBtn');
  const row = page.locator('.site-row'); // the only rule (fresh storage per test)
  await expect(row).toBeVisible();
  await expect(row.locator('.site-pat-input')).toHaveValue('example.com');
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

  // UNCHECK: clears the flag AND hands the site permission back (nothing else needs it),
  // verified against contains() rather than trusting remove()'s own callback.
  await cb.click();
  await expect.poll(storedRule).toEqual({ match: 'example.com', mode: 'auto' });
  await expect.poll(() => page.evaluate(() => window.__permRemoved)).toEqual([
    { origins: ['*://example.com/*', '*://www.example.com/*'] },
  ]);
  await expect.poll(() => page.evaluate(() => window.__granted)).toEqual([]);
  expect(await page.evaluate(() => window.__permCalls.length)).toBe(1); // no re-request

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
  await openSections(page); // Per-site data starts collapsed
  await page.fill('#siteHost', 'ex*mple.com');
  await page.click('#siteAddBtn');
  const row = page.locator('.site-row'); // the only rule (fresh storage per test)
  await expect(row).toBeVisible();
  await expect(row.locator('.site-pat-input')).toHaveValue('ex*mple.com');
  await expect(row.locator('.site-auto input')).toBeDisabled();
  await expect(row.locator('.site-auto')).toHaveAttribute('title', /can.t auto-open/);
});

const storedFirstRule = (page) => page.evaluate(() => new Promise((res) =>
  chrome.storage.sync.get('obr_settings', (d) => res(((d.obr_settings || {}).siteRules || [])[0]))));

test('a rule pattern is editable in place: refine a whole-site auto rule to a path (auto survives a same-host edit)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [{ match: 'example.com', mode: 'auto', auto: true }] },
  }, res)));
  await page.goto(optionsUrl(extensionId));
  // Same-host edit → origins unchanged → already granted, so auto is kept.
  await page.evaluate(() => { chrome.permissions = { contains: (n, cb) => cb(true), request: (n, cb) => cb(true) }; });

  await openSections(page); // Per-site data starts collapsed; the pattern field needs it open
  const pat = page.locator('.site-pat-input');
  await expect(pat).toHaveValue('example.com');
  await expect(page.locator('.site-row .site-auto input')).toBeChecked();

  await pat.fill('example.com/blog/*');
  await pat.press('Enter');

  await expect.poll(() => storedFirstRule(page)).toEqual({ match: 'example.com/blog/*', mode: 'auto', auto: true });
  await expect(page.locator('.site-sub')).toHaveText('Only /blog/* · opens by itself when the page looks like an article or gallery');
});

test('editing a rule pattern to a new, ungranted host turns Auto-open off (re-grant via the checkbox)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [{ match: 'example.com', mode: 'auto', auto: true }] },
  }, res)));
  await page.goto(optionsUrl(extensionId));
  // New host is NOT granted → auto must drop (silently keeping it would be a dead flag).
  await page.evaluate(() => { chrome.permissions = { contains: (n, cb) => cb(false), request: (n, cb) => cb(false) }; });

  await openSections(page); // Per-site data starts collapsed; the pattern field needs it open
  const pat = page.locator('.site-pat-input');
  await pat.fill('other.test');
  await pat.press('Enter');

  await expect.poll(() => storedFirstRule(page)).toEqual({ match: 'other.test', mode: 'auto' });
  await expect(page.locator('.site-row .site-auto input')).not.toBeChecked();
});

test('Escape cancels an in-progress pattern edit without persisting', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [{ match: 'example.com', mode: 'text' }] },
  }, res)));
  await page.goto(optionsUrl(extensionId));

  await openSections(page); // Per-site data starts collapsed; the pattern field needs it open
  const pat = page.locator('.site-pat-input');
  await pat.fill('example.com/typo');
  await pat.press('Escape');
  await expect(pat).toHaveValue('example.com');
  await expect.poll(() => storedFirstRule(page)).toEqual({ match: 'example.com', mode: 'text' });
});

test('the "focus on a site" dropdown scopes the lists (manual, since the current tab can\'t be auto-detected)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [
      { match: 'example.com', mode: 'text' },
      { match: 'other.test/blog/*', mode: 'images' },
    ] },
  }, res)));
  await page.goto(optionsUrl(extensionId));

  const focusBar = page.locator('#siteFocusBar');
  const focus = page.locator('#siteFocus');
  await expect(focusBar).toBeVisible();
  await expect(focus.locator('option')).toHaveText(['All sites', 'example.com', 'other.test']);

  // Focusing a site scopes the rules list, shows the scope banner, and hides the focus bar.
  await focus.selectOption('other.test');
  await expect(page.locator('#siteFilterBar')).toBeVisible();
  await expect(page.locator('#siteFilterName')).toHaveText('other.test');
  await expect(focusBar).toBeHidden();
  await expect(page.locator('#sites .site-pat-input')).toHaveValue('other.test/blog/*'); // only other.test's rule

  // "Show all" restores the global list + the focus bar.
  await page.locator('#siteFilterClear').click();
  await expect(focusBar).toBeVisible();
  await expect(page.locator('#sites .site-pat-input')).toHaveCount(2);
});

test('toggling Auto-open after a mode change repaints the gloss with the CURRENT mode (not the stale one)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [{ match: 'example.com/forum/t/*', mode: 'text' }] },
  }, res)));
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => { chrome.permissions = { contains: (n, cb) => cb(true), request: (n, cb) => cb(true) }; });

  await openSections(page); // Per-site data starts collapsed; the mode <select> needs it open
  const row = page.locator('.site-row');
  await row.locator('.site-mode').selectOption('images'); // Reader -> Gallery
  await expect(row.locator('.site-sub')).toContainText('Gallery');
  // Now toggle Auto-open: the gloss must still read Gallery, not repaint the stale Reader.
  await row.locator('.site-auto input').check();
  await expect(row.locator('.site-sub')).toHaveText('Only /forum/t/* · opens by itself, always as Gallery');
});

test('a subdomain-wildcard rule WITH a path shows both facets in the gloss', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [{ match: '*.example.com/blog/*', mode: 'text' }] },
  }, res)));
  await page.goto(optionsUrl(extensionId));
  await expect(page.locator('.site-sub')).toHaveText('Only /blog/* (all subdomains) · sets the default mode to Reader; opens on click');
});

test('editing a rule pattern to duplicate another rule is rejected (marked invalid, not persisted)', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => new Promise((res) => chrome.storage.sync.set({
    obr_settings: { siteRules: [
      { match: 'a.test', mode: 'text' },
      { match: 'b.test', mode: 'images' },
    ] },
  }, res)));
  await page.goto(optionsUrl(extensionId));

  await openSections(page); // Per-site data starts collapsed; the pattern field needs it open
  const firstPat = page.locator('#sites .site-pat-input').first();
  await firstPat.fill('b.test'); // collide with the 2nd rule
  await expect(firstPat).toHaveClass(/invalid/); // live ✗
  await firstPat.press('Enter');
  const matches = () => page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_settings', (d) => res(((d.obr_settings || {}).siteRules || []).map((r) => r.match)))));
  await expect.poll(matches).toEqual(['a.test', 'b.test']); // unchanged — the collision was not written
});

// Origins are HOST-scoped, so two PATH rules on one host share ONE grant. Releasing it on
// behalf of one would silently pause the other while its checkbox still read "on".
// Proven: this fails (the grant is revoked out from under the sibling) without the
// stillNeeded guard in releaseRuleOrigins.
test('unchecking one rule does NOT revoke a host grant a sibling auto rule still needs', async ({ page, extensionId }) => {
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(() => {
    window.__permRemoved = []; window.__granted = [];
    chrome.permissions = {
      request: (need, cb) => { (need.origins||[]).forEach(o => { if (window.__granted.indexOf(o) === -1) window.__granted.push(o); }); cb(true); },
      remove: (need, cb) => { window.__permRemoved.push(need);
        window.__granted = window.__granted.filter(o => (need.origins||[]).indexOf(o) === -1); cb(true); },
      contains: (need, cb) => cb((need.origins||[]).every(o => window.__granted.indexOf(o) !== -1)),
      getAll: (cb) => cb({ origins: window.__granted.slice() }),
    };
  });
  await openSections(page);
  // Two PATH rules on the SAME host -> one shared host-scoped grant.
  for (const p of ['example.com/blog/*', 'example.com/forum/*']) {
    await page.fill('#siteHost', p); await page.click('#siteAddBtn');
  }
  const rows = page.locator('.site-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).locator('.site-auto input').click();
  await rows.nth(1).locator('.site-auto input').click();
  await expect.poll(() => page.evaluate(() => window.__granted.length)).toBe(2);

  // Uncheck ONE. The other still needs the shared grant -> must NOT revoke.
  await rows.nth(0).locator('.site-auto input').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__permRemoved)).toEqual([]);
  expect(await page.evaluate(() => window.__granted.length)).toBe(2);

  // Uncheck the LAST one -> now nothing needs it -> revoke fires.
  await rows.nth(1).locator('.site-auto input').click();
  await expect.poll(() => page.evaluate(() => window.__granted)).toEqual([]);
  expect(await page.evaluate(() => window.__permRemoved.length)).toBe(1);
});
