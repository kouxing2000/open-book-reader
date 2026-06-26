/* Feature integration tests for the reader engine, in real Chromium.
 *
 * The harness injects the three content scripts the same way background.js does
 * on a toolbar gesture (settings -> readability -> reader), because headless
 * Playwright can't click the real toolbar icon to grant activeTab. Everything
 * after injection is the production engine, unmodified.
 */

import { test, expect } from './fixtures.js';
import { gotoArticle, gotoPictureArticle, injectReader, openReader, readState, clickInReader } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await gotoArticle(page);
  await injectReader(page);
});

test('extracts the article and renders it into an open Shadow DOM', async ({ page }) => {
  await openReader(page);
  const s = await readState(page);

  expect(s.present).toBe(true);
  expect(s.title).toContain('Slow Reading');
  expect(s.contentText).toContain('unhurried act'); // body text extracted by Readability
  expect(s.contentText).not.toContain('boilerplate that should not appear'); // footer stripped
});

test('bestFromSrcset picks the widest candidate and keeps comma-bearing URLs intact', async ({ page }) => {
  const r = await page.evaluate(() => ({
    widest: OBR.bestFromSrcset('a-200.jpg 200w, a-1600.jpg 1600w, a-800.jpg 800w'),
    density: OBR.bestFromSrcset('a@1x.jpg 1x, a@3x.jpg 3x, a@2x.jpg 2x'),
    // Cloudinary-style transform params put commas INSIDE the URL — a bare comma split shatters these.
    commaUrl: OBR.bestFromSrcset('https://cdn.test/w_400,c_fill/s.jpg 400w, https://cdn.test/w_1600,c_fill/b.jpg 1600w'),
    none: OBR.bestFromSrcset(''),
  }));
  expect(r.widest).toBe('a-1600.jpg');
  expect(r.density).toBe('a@3x.jpg');
  expect(r.commaUrl).toBe('https://cdn.test/w_1600,c_fill/b.jpg');
  expect(r.none).toBe(null);
});

test('rescues a <picture> placeholder image from <source srcset> and drops an empty one', async ({ page }) => {
  await gotoPictureArticle(page);
  await injectReader(page); // beforeEach injected into the previous page; this is a fresh document
  await openReader(page);
  const r = await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    return {
      contentText: root.querySelector('.obr-content').textContent,
      srcs: [...root.querySelectorAll('.obr-content img')].map((im) => im.getAttribute('src') || ''),
    };
  });
  expect(r.contentText).toContain('Responsive Image Problem');            // article extracted
  expect(r.srcs.some((s) => /lead-1600\.(webp|jpg)/.test(s))).toBe(true); // real image rescued from <source srcset>
  expect(r.srcs.some((s) => /grey-placeholder|blank-spacer/.test(s))).toBe(false); // no placeholder renders as a blank box
});

test('paginates a long article into multiple columns', async ({ page }) => {
  await openReader(page);
  const s = await readState(page);
  expect(s.totalColumns).toBeGreaterThan(2);
  expect(s.indicator).toMatch(/\/\s*\d+\s*pages/);
});

test('re-paginates after a late-loading image so the tail stays reachable', async ({ page }) => {
  // A page whose height is dominated by one tall image served with a delay; the
  // image reports height 0 at first layout, so the initial column count is short.
  // (beforeEach already registered the storage shim via addInitScript, which
  // re-runs on this navigation.) Use 'domcontentloaded' so navigation doesn't
  // block on the delayed image — we want the reader to open before it loads.
  await page.goto('/late-image-article.html', { waitUntil: 'domcontentloaded' });
  await injectReader(page);
  await openReader(page);

  const before = (await readState(page)).totalColumns; // measured while img is height 0

  // Wait for the image to finish loading inside the shadow DOM and the relayout
  // (80ms debounce) to settle, then confirm the column count grew to cover it.
  await expect
    .poll(() => readState(page).then((s) => s.totalColumns), { timeout: 8000 })
    .toBeGreaterThan(before);

  // Pagination must now agree with the actually-rendered content (no stale,
  // unreachable columns): the reported count matches a fresh measurement.
  const consistent = await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const pages = root.querySelector('.obr-pages');
    const cs = getComputedStyle(pages);
    const colW = parseFloat(cs.columnWidth);
    const gap = parseFloat(cs.columnGap) || 0;
    const live = Math.max(1, Math.round((pages.scrollWidth + gap) / (colW + gap)));
    const reported = Number((root.querySelector('.obr-indicator').textContent.match(/\/\s*(\d+)/) || [])[1]);
    return { live, reported };
  });
  expect(consistent.reported).toBe(consistent.live);
});

test('recovers an image-dominant forum post Readability would otherwise drop', async ({ page }) => {
  // Forum/image-board thread (synthetic fixture): the main post is a gallery of
  // images with almost no text, which Readability's conditional cleaning discards
  // in favour of the text-heavy replies. The reader's adaptive re-extraction must
  // bring the gallery back. The lead image also hides its real URL behind a lazy
  // attr with an anti-adblock decoy in src.
  await page.goto('/image-board-thread.html', { waitUntil: 'domcontentloaded' });
  await injectReader(page);
  await openReader(page);

  const r = await page.evaluate(() => {
    const c = document.getElementById('obr-host').shadowRoot.querySelector('.obr-content');
    const srcs = [...c.querySelectorAll('img')].map((i) => i.getAttribute('src') || '');
    return {
      imgCount: srcs.length,
      usesDecoy: srcs.some((s) => /adblock/i.test(s)),
      galleryImgs: srcs.filter((s) => /pic\.png/.test(s)).length,
      hasReplyText: c.textContent.includes('感谢分享'),
    };
  });
  expect(r.galleryImgs).toBeGreaterThanOrEqual(10); // the dropped gallery is back
  expect(r.usesDecoy).toBe(false);                  // hydrated past the adblock decoy
  expect(r.hasReplyText).toBe(true);                // replies kept too, not lost
});

test('caps an over-tall image to the column height so it is not clipped', async ({ page }) => {
  // tall.png is 40x1400 — taller than a column. Wait for it to load, then assert
  // it was scaled down to fit (rather than rendered at full height and clipped).
  await page.goto('/late-image-article.html', { waitUntil: 'load' });
  await injectReader(page);
  await openReader(page);

  const r = await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const img = root.querySelector('img');
    const colH = root.querySelector('.obr-viewport').getBoundingClientRect().height;
    return { colH, imgH: img.getBoundingClientRect().height, natural: img.naturalHeight };
  });
  expect(r.natural).toBe(1400);          // the source image really is over-tall
  expect(r.imgH).toBeLessThanOrEqual(r.colH); // but it was capped to fit one column
  expect(r.imgH).toBeGreaterThan(0);
});

const paperWidth = (page) =>
  page.evaluate(() => document.getElementById('obr-host').shadowRoot.querySelector('.obr-paper').getBoundingClientRect().width);

test('fills the window width by default (no cap)', async ({ page }) => {
  await openReader(page);
  const paperW = await paperWidth(page);
  const vw = await page.evaluate(() => window.innerWidth);
  expect(paperW).toBeGreaterThan(vw - 60); // ~full window minus the small edge margin
});

test('an external maxBookWidth change applies live to an open reader', async ({ page }) => {
  await openReader(page);
  const before = await paperWidth(page);
  // Simulate the Options page capping the width while the reader is open.
  await page.evaluate(() => globalThis.OBR.saveSettings({ maxBookWidth: 600 }));
  await expect.poll(() => paperWidth(page)).toBeLessThan(before - 100);
});

test('the Columns button cycles 2 -> 3 -> 4 columns per spread', async ({ page }) => {
  await openReader(page);
  expect((await readState(page)).indicator).toMatch(/^1\D2\b/); // default: 2 per spread

  await clickInReader(page, '.obr-btn[data-act="columns"]');
  await expect.poll(() => readState(page).then((s) => s.indicator)).toMatch(/^1\D3\b/);

  await clickInReader(page, '.obr-btn[data-act="columns"]');
  await expect.poll(() => readState(page).then((s) => s.indicator)).toMatch(/^1\D4\b/);
});

test('flips forward and back with the arrow keys', async ({ page }) => {
  await openReader(page);
  const start = await readState(page);

  await page.keyboard.press('ArrowRight');
  const fwd = await readState(page);
  expect(fwd.translateX).toBeLessThan(start.translateX); // moved left (next spread)
  expect(fwd.indicator).not.toBe(start.indicator);

  await page.keyboard.press('ArrowLeft');
  const back = await readState(page);
  expect(back.translateX).toBe(start.translateX);
  expect(back.indicator).toBe(start.indicator);
});

test('Home and End jump to the first and last spread', async ({ page }) => {
  await openReader(page);

  await page.keyboard.press('End');
  const end = await readState(page);
  expect(end.translateX).toBeLessThan(0);

  await page.keyboard.press('Home');
  const home = await readState(page);
  expect(home.translateX).toBe(0);
});

test('the right click-zone advances the page', async ({ page }) => {
  await openReader(page);
  const start = await readState(page);

  await clickInReader(page, '.obr-zone-right');
  const after = await readState(page);
  expect(after.translateX).toBeLessThan(start.translateX);
});

test('the Theme button cycles paper -> light -> dark and persists', async ({ page }) => {
  await openReader(page);
  expect((await readState(page)).theme).toBe('paper');

  await clickInReader(page, '.obr-btn[data-act="theme"]');
  expect((await readState(page)).theme).toBe('light');

  await clickInReader(page, '.obr-btn[data-act="theme"]');
  expect((await readState(page)).theme).toBe('dark');

  // Persisted to (shimmed) chrome.storage.sync.
  const stored = await page.evaluate(
    () => new Promise((r) => chrome.storage.sync.get('obr_settings', (d) => r(d.obr_settings)))
  );
  expect(stored.theme).toBe('dark');
});

test('the A+ / A- buttons change font size within bounds', async ({ page }) => {
  await openReader(page);
  const base = (await readState(page)).fontSize;

  await clickInReader(page, '.obr-btn[data-act="font+"]');
  expect((await readState(page)).fontSize).toBe(base + 1);

  await clickInReader(page, '.obr-btn[data-act="font-"]');
  await clickInReader(page, '.obr-btn[data-act="font-"]');
  expect((await readState(page)).fontSize).toBe(base - 1);
});

// Reading position is held as a fraction (left page / total pages), so a re-paginate
// from a font or column change lands you near where you were — not back on page 1.
const progress = (s) => {
  const left = Number((s.indicator.match(/^\s*(\d+)/) || [, 1])[1]);
  return s.totalColumns ? (left - 1) / s.totalColumns : 0;
};

test('changing font size preserves reading progress (does not reset to page 1)', async ({ page }) => {
  await openReader(page);

  // Read into the article so we have a non-trivial position to protect.
  await page.keyboard.press('End');
  const before = await readState(page);
  expect(before.translateX).toBeLessThan(0); // genuinely past page 1
  const fracBefore = progress(before);
  expect(fracBefore).toBeGreaterThan(0.4);

  await clickInReader(page, '.obr-btn[data-act="font+"]');
  const after = await readState(page);
  expect(after.fontSize).toBe(before.fontSize + 1);
  expect(after.translateX).toBeLessThan(0); // did NOT snap back to page 1
  expect(Math.abs(progress(after) - fracBefore)).toBeLessThan(0.2); // roughly same spot
});

test('changing column count preserves reading progress (does not reset to page 1)', async ({ page }) => {
  await openReader(page);

  await page.keyboard.press('End');
  const before = await readState(page);
  expect(before.translateX).toBeLessThan(0);
  const fracBefore = progress(before);
  expect(fracBefore).toBeGreaterThan(0.4);

  await clickInReader(page, '.obr-btn[data-act="columns"]'); // 2 -> 3 per spread
  const after = await readState(page);
  expect(after.translateX).toBeLessThan(0); // did NOT snap back to page 1
  // Re-anchoring across a column-COUNT change is granular: the restored spread can
  // round up to one full spread of the NEW layout away from the exact fraction
  // (3 cols / totalColumns), and headless CI paginates into fewer columns than a
  // local run, making that spread coarser. So bound the drift by one new-layout
  // spread + a small epsilon, not a fixed fraction.
  const tol = 3 / after.totalColumns + 0.06;
  expect(Math.abs(progress(after) - fracBefore)).toBeLessThan(tol);
});

test('resumes the saved reading position when reopened on the same article', async ({ page }) => {
  await openReader(page);
  expect((await readState(page)).translateX).toBe(0); // fresh: starts on page 1

  await page.keyboard.press('End'); // read to the end, then leave
  const left = await readState(page);
  expect(left.translateX).toBeLessThan(0);
  const fracLeft = progress(left);
  await page.evaluate(() => globalThis.OBR.close());

  // Reopen the same article — should land back near where we left off, not page 1.
  await openReader(page);
  const back = await readState(page);
  expect(back.translateX).toBeLessThan(0); // resumed, did NOT reset to page 1
  expect(Math.abs(progress(back) - fracLeft)).toBeLessThan(0.2);
});

test('the progress hairline tracks position (0% at start, 100% at the end)', async ({ page }) => {
  await openReader(page);
  expect((await readState(page)).progressWidth).toBe('0%');

  await page.keyboard.press('End');
  expect((await readState(page)).progressWidth).toBe('100%');

  await page.keyboard.press('Home');
  expect((await readState(page)).progressWidth).toBe('0%');
});

test('shows an estimated reading time for the article', async ({ page }) => {
  await openReader(page);
  expect((await readState(page)).meta).toMatch(/^~\d+ min$/);
});

test('Escape closes the reader and restores the page', async ({ page }) => {
  await openReader(page);
  expect((await readState(page)).hostDisplay).not.toBe('none');
  expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('hidden');

  await page.keyboard.press('Escape');
  expect((await readState(page)).hostDisplay).toBe('none');
  expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
});

test('OBR.toggle() opens, closes, and reopens', async ({ page }) => {
  await openReader(page);
  expect((await readState(page)).hostDisplay).not.toBe('none');

  await page.evaluate(() => globalThis.OBR.toggle());
  expect((await readState(page)).hostDisplay).toBe('none');

  await page.evaluate(() => globalThis.OBR.toggle());
  expect((await readState(page)).hostDisplay).not.toBe('none');
});

test('the ⚙ Settings button asks the SW to open the options page', async ({ page }) => {
  await openReader(page);
  // The reader runs in the test's main world without a real chrome.runtime; install a
  // capturing sendMessage and reveal the (auto-hiding) topbar so the click lands.
  await page.evaluate(() => {
    window.__obrMsgs = [];
    chrome.runtime = { lastError: null, sendMessage(m, cb) { window.__obrMsgs.push(m); if (cb) cb({ ok: true }); } };
    document.getElementById('obr-host').shadowRoot.querySelector('.obr-overlay').classList.remove('obr-chrome-hidden');
  });
  await clickInReader(page, '.obr-btn[data-act="settings"]');
  const msgs = await page.evaluate(() => window.__obrMsgs);
  expect(msgs.some((m) => m && m.type === 'obr-open-options')).toBe(true);
});

test('the ⚠ Report button builds a feedback mailto with a parseable [feedback-meta v1] marker', async ({ page }) => {
  await openReader(page);
  const r = await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const hasBtn = !!root.querySelector('.obr-btn[data-act="report"]');
    const url = globalThis.OBR._buildReportMailto({ source: 'reader-toolbar', mode: 'text', proseWords: 1234 });
    const body = decodeURIComponent((url.split('&body=')[1] || ''));
    let meta = null; try { meta = JSON.parse(body.split('[feedback-meta v1]\n')[1] || ''); } catch (e) {}
    return { hasBtn, meta, body, to: url.split('?')[0], expectedUrl: location.origin + location.pathname };
  });
  expect(r.hasBtn).toBe(true);
  expect(r.to).toBe('mailto:studio.peach.go+open-book-reader@gmail.com');
  expect(r.body).toContain('[Please describe the issue or feedback here]'); // unchanged placeholder the ingest parser drops
  expect(r.meta).toMatchObject({
    app: 'open-book-reader', platform: 'chrome', mode: 'text',
    reportSource: 'reader-toolbar', proseWords: 1234,
  });
  expect(r.meta.pageUrl).toBe(r.expectedUrl); // query/hash stripped to origin+pathname
});

test('the 🖨 Print button builds a standalone, flat print document (no screen-layout machinery)', async ({ page }) => {
  await openReader(page);
  const r = await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const hasBtn = !!root.querySelector('.obr-btn[data-act="print"]');
    const html = globalThis.OBR._buildPrintDoc({
      title: 'A & B <Title> "Q"',
      byline: 'By <Jane> & John',
      content: '<p>Body paragraph one.</p><p>Body paragraph two.</p>',
      fontFamily: 'serif', lineHeight: 1.7,
      url: 'https://example.com/path',
    });
    const empty = globalThis.OBR._buildPrintDoc({ title: 'X', content: '' });
    return { hasBtn, html, empty };
  });
  expect(r.hasBtn).toBe(true);
  // A complete, standalone document
  expect(r.html).toContain('<!doctype html>');
  expect(r.html).toContain('</html>');
  // Title -> <title> (drives the default Save-as-PDF filename), HTML-escaped
  expect(r.html).toContain('<title>A &amp; B &lt;Title&gt; &quot;Q&quot;</title>');
  // Byline escaped; content inserted; source URL present
  expect(r.html).toContain('By &lt;Jane&gt; &amp; John');
  expect(r.html).toContain('Body paragraph one.');
  expect(r.html).toContain('https://example.com/path');
  // The chosen font family + line height actually reach the stylesheet
  expect(r.html).toContain('12pt/1.7');
  expect(r.html).toContain('Georgia'); // serif stack
  // Empty extraction degrades to a readable fallback, not a blank page
  expect(r.empty).toContain('Could not extract a readable article');
  // Flat paper layout — NONE of the on-screen reader's column / transform / clip machinery,
  // so the browser paginates it vertically onto paper instead of printing one clipped spread.
  expect(r.html).not.toMatch(/column-/);
  expect(r.html).not.toContain('translateX');
  expect(r.html).not.toMatch(/overflow:\s*hidden/);
});

test('saveSettings persists only changed keys (default changes still apply)', async ({ page }) => {
  await openReader(page);
  await clickInReader(page, '.obr-btn[data-act="font+"]'); // changes only fontSize

  const stored = await page.evaluate(
    () => new Promise((r) => chrome.storage.sync.get('obr_settings', (d) => r(d.obr_settings)))
  );
  // Only the touched key is persisted — layout defaults (maxBookWidth) stay unset,
  // so a future change to DEFAULTS.maxBookWidth takes effect instead of being shadowed.
  expect(stored).toHaveProperty('fontSize');
  expect(stored).not.toHaveProperty('maxBookWidth');
});

test('settings persist across a full page reload', async ({ page }) => {
  await openReader(page);
  await clickInReader(page, '.obr-btn[data-act="theme"]'); // paper -> light
  expect((await readState(page)).theme).toBe('light');

  // Reload the page entirely, re-inject, reopen. The localStorage-backed storage
  // shim survives the reload, so the saved theme should be restored.
  await page.reload();
  await injectReader(page);
  await openReader(page);

  expect((await readState(page)).theme).toBe('light');
});
