/* Feature integration tests for the reader engine, in real Chromium.
 *
 * The harness injects the three content scripts the same way background.js does
 * on a toolbar gesture (settings -> readability -> reader), because headless
 * Playwright can't click the real toolbar icon to grant activeTab. Everything
 * after injection is the production engine, unmodified.
 */

import { test, expect } from './fixtures.js';
import { gotoArticle, gotoPictureArticle, gotoWrongContent, gotoThinPage, injectReader, openReader, readState, clickInReader } from './helpers.js';

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

test('clicking near the right edge advances the page', async ({ page }) => {
  await openReader(page);
  const start = await readState(page);

  // No blocking overlay any more — a plain click in the right edge band turns the page.
  const vp = page.viewportSize();
  await page.mouse.click(Math.round(vp.width * 0.9), Math.round(vp.height * 0.5));
  const after = await readState(page);
  expect(after.translateX).toBeLessThan(start.translateX);
});

test('a click in the edge band does not turn the page while text is selected', async ({ page }) => {
  await openReader(page);
  const start = await readState(page);

  // Select content inside the reader's (open) shadow DOM, then fire a click in the right edge
  // band WITHOUT a preceding mousedown (which would collapse the selection). The flip guard must
  // win — otherwise double-click-to-select-a-word near the edge would flip the page mid-selection.
  await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const p = root.querySelector('.obr-pages p') || root.querySelector('p');
    const sel = root.getSelection ? root.getSelection() : getSelection();
    sel.removeAllRanges();
    const r = document.createRange(); r.selectNodeContents(p); sel.addRange(r);
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: window.innerWidth * 0.9, clientY: window.innerHeight * 0.5 }));
  });
  const after = await readState(page);
  expect(after.translateX).toBe(start.translateX); // selection present → no flip
});

/* ---------------------------------------------------- 3D "book" page turn ----
   The default viewport (1280px) gives 2 columns/spread, so these run the book path. */
const flipLayers = (page) => page.locator('#obr-host >> .obr-flip-layer').count();

test('the book page-turn floats a transient leaf and then cleans it up', async ({ page }) => {
  // Slow the turn so the (synchronously-built) leaf reliably outlives the query round-trip
  // even under load — otherwise a fast default turn can finish before count() runs.
  await page.evaluate(() => globalThis.OBR.saveSettings({ pageTurn: 'book', transitionMs: 1200 }));
  await openReader(page);
  // Let the late font/image relayout fire first — layout() ends any in-flight turn, so flipping
  // before it settles would legitimately abort the leaf we're about to assert on.
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(150);

  await page.keyboard.press('ArrowRight');
  expect(await flipLayers(page)).toBe(1);            // built synchronously in the flip handler
  await expect.poll(() => flipLayers(page), { timeout: 3000 }).toBe(0); // torn down when it finishes
});

test('the book turn settles to the exact same state as the plain flip (additive overlay)', async ({ page }) => {
  await page.evaluate(() => globalThis.OBR.saveSettings({ pageTurn: 'book' }));
  await openReader(page);
  await page.keyboard.press('ArrowRight');
  const mid = await readState(page); // real strip already snapped to the destination
  expect(mid.translateX).toBeLessThan(0);

  await expect.poll(() => flipLayers(page), { timeout: 2000 }).toBe(0);
  const after = await readState(page);
  // The transient leaf never touches the real strip — final state == the snapped state.
  expect(after.translateX).toBe(mid.translateX);
  expect(after.indicator).toBe(mid.indicator);
});

for (const mode of ['slide', 'off']) {
  test(`pageTurn:'${mode}' advances without ever creating a leaf`, async ({ page }) => {
    await page.evaluate((m) => globalThis.OBR.saveSettings({ pageTurn: m }), mode);
    await openReader(page);
    const start = await readState(page);

    await page.keyboard.press('ArrowRight');
    expect(await flipLayers(page)).toBe(0);          // no 3D leaf in slide/off mode
    const after = await readState(page);
    expect(after.translateX).toBeLessThan(start.translateX); // but the page still advanced
  });
}

test('prefers-reduced-motion forces an instant flip with no leaf', async ({ page }) => {
  // reduceMotion is captured when reader.js loads, so set it before re-injecting.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoArticle(page);
  await injectReader(page);
  await openReader(page);
  const start = await readState(page);

  await page.keyboard.press('ArrowRight');
  expect(await flipLayers(page)).toBe(0);
  const after = await readState(page);
  expect(after.translateX).toBeLessThan(start.translateX);
});

test('rapid flips strand no leaf and advance by two spreads', async ({ page }) => {
  await openReader(page);
  const start = await readState(page);

  await page.keyboard.press('ArrowRight');
  const one = await readState(page);
  await page.keyboard.press('ArrowRight'); // interrupts the first turn mid-flight
  const two = await readState(page);

  expect(one.translateX).toBeLessThan(start.translateX);
  expect(two.translateX).toBeLessThan(one.translateX); // second flip advanced further
  await expect.poll(() => flipLayers(page), { timeout: 2000 }).toBe(0); // nothing orphaned
});

test('the soft curl turn floats a transient leaf, then settles to the plain-flip state', async ({ page }) => {
  // The curl runs on its own ~760ms+ duration, so the overlay reliably outlives the query.
  await page.evaluate(() => globalThis.OBR.saveSettings({ pageTurn: 'curl' }));
  await openReader(page);
  // Let the late font/image relayout fire first — layout() ends any in-flight turn, so flipping
  // before it settles would legitimately abort the leaf we're about to assert on.
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(150);

  await page.keyboard.press('ArrowRight');
  expect(await flipLayers(page)).toBe(1);                 // curl overlay built synchronously
  const mid = await readState(page);
  expect(mid.translateX).toBeLessThan(0);                 // real strip already at destination

  await expect.poll(() => flipLayers(page), { timeout: 3000 }).toBe(0); // sliced strips cleaned up
  const after = await readState(page);
  expect(after.translateX).toBe(mid.translateX);          // additive: real strip untouched
  expect(after.indicator).toBe(mid.indicator);
});

// Regression test for the leaf-size bug: the turning leaf and the laid-page overlay must
// each span a FULL page (half the paper, full height) — NOT just the smaller text/viewport
// area. offsetWidth/offsetHeight read the layout box, so they ignore the rotation transform.
for (const mode of ['curl', 'book']) {
  test(`the turning page (${mode}) is sized to the full paper page, not the text area`, async ({ page }) => {
    await page.evaluate((m) => globalThis.OBR.saveSettings({ pageTurn: m }), mode);
    await openReader(page);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(150);

    await page.keyboard.press('ArrowRight');
    const sz = await page.evaluate((leafSel) => {
      const root = document.getElementById('obr-host').shadowRoot;
      const leaf = root.querySelector(leafSel);
      const stat = root.querySelector('.obr-flip-static');
      const paper = root.querySelector('.obr-paper');
      if (!leaf || !stat || !paper) return null;
      return {
        leafW: leaf.offsetWidth, leafH: leaf.offsetHeight,
        statW: stat.offsetWidth, statH: stat.offsetHeight,
        paperW: paper.offsetWidth, paperH: paper.offsetHeight,
      };
    }, mode === 'curl' ? '.obr-curl' : '.obr-leaf');

    expect(sz).not.toBeNull();
    expect(sz.leafH).toBe(sz.paperH);                          // full page height (incl. margins)
    expect(sz.statH).toBe(sz.paperH);
    expect(Math.abs(sz.leafW - sz.paperW / 2)).toBeLessThanOrEqual(1); // one full page wide
    expect(Math.abs(sz.statW - sz.paperW / 2)).toBeLessThanOrEqual(1);
  });
}

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

test('the Auto theme follows the OS color scheme and flips live', async ({ page }) => {
  // Select Auto with the OS in dark mode, then open: 'auto' resolves to the concrete
  // 'dark' overlay class (we never persist the concrete theme — only resolve at render).
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => OBR.saveSettings({ theme: 'auto' }));
  await openReader(page);
  expect((await readState(page)).theme).toBe('dark');

  // Switching the OS to light flips the open reader to 'paper' (the signature light look,
  // not stark-white 'light') live — no reopen — via the prefers-color-scheme listener.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => readState(page).then((s) => s.theme)).toBe('paper');

  // The stored preference stays 'auto' through both resolutions.
  const stored = await page.evaluate(
    () => new Promise((r) => chrome.storage.sync.get('obr_settings', (d) => r(d.obr_settings)))
  );
  expect(stored.theme).toBe('auto');

  // Pressing Theme while on Auto exits into an explicit concrete theme — from the resolved
  // 'paper' (OS light), the cycle advances to 'light' and persists it (no longer 'auto').
  await clickInReader(page, '.obr-btn[data-act="theme"]');
  expect((await readState(page)).theme).toBe('light');
  const stored2 = await page.evaluate(
    () => new Promise((r) => chrome.storage.sync.get('obr_settings', (d) => r(d.obr_settings)))
  );
  expect(stored2.theme).toBe('light');
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

test('two open() calls in flight at once initialize only once (re-entrancy guard)', async ({ page }) => {
  // Fire two open()s synchronously (before the first's awaits resolve) and AWAIT BOTH to
  // completion — so the count is final, not racing the assertion. Without the generation
  // guard both run to completion (count 2); with it, only the latest does (count 1).
  await page.evaluate(async () => {
    globalThis.OBR._opensCompleted = 0;
    await Promise.all([OBR.open(), OBR.open()]);
  });
  expect(await page.evaluate(() => OBR._opensCompleted)).toBe(1);
  const s = await readState(page);
  expect(s.present).toBe(true);
  expect(s.indicator).toContain('pages');
  expect(s.totalColumns).toBeGreaterThan(0); // a single, consistent pagination
});

test('an open() aborted after build() leaves no unclosable overlay', async ({ page }) => {
  // The openGen guard can abort open() AFTER build() has appended #obr-host but BEFORE
  // active=true (e.g. the gallery takes over mid-open). Since close()/Escape/✕ all bail on
  // !active, a host left visible by such an abort would be a wedged, unclosable overlay.
  // Simulate the abort at the loadPosition await (which runs after build()+renderContent)
  // by having it close() first — bumping openGen so the open() that follows aborts.
  await page.evaluate(async () => {
    const orig = OBR.loadPosition;
    OBR.loadPosition = () => { OBR.close(); return Promise.resolve(null); }; // concurrent takeover
    try { await OBR.open(); } finally { OBR.loadPosition = orig; }
  });
  expect((await readState(page)).hostDisplay).toBe('none'); // aborted open must not leave it shown

  // …and the reader still works afterward — open shows it, Escape closes it (no permanent wedge).
  await openReader(page);
  expect((await readState(page)).hostDisplay).not.toBe('none');
  await page.keyboard.press('Escape');
  expect((await readState(page)).hostDisplay).toBe('none');
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
    // A normal article but NO url — the doc printReader() builds when printSourceUrl is off.
    const noUrl = globalThis.OBR._buildPrintDoc({
      title: 'T', byline: '', content: '<p>Body.</p>', fontFamily: 'serif', lineHeight: 1.6,
    });
    const empty = globalThis.OBR._buildPrintDoc({ title: 'X', content: '' });
    return { hasBtn, html, noUrl, empty };
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
  expect(r.html).toContain('<div class="obr-print-source">'); // footer rendered when a URL is passed
  // A real article but no url (printReader omits it when printSourceUrl is off) -> no footer,
  // and the body still renders. Isolates "no url" from the empty-content fallback below.
  expect(r.noUrl).toContain('Body.');
  expect(r.noUrl).not.toContain('<div class="obr-print-source">');
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

/* ----------------------------------- content override: selection / picker / saved pick.
 * Uses the wrong-content fixture: #real-article (REAL-MARKER) is the genuine article;
 * #decoy (DECOY-MARKER) is a larger block the whole-page extractor latches onto. */
test.describe('content override', () => {
  test.beforeEach(async ({ page }) => {
    await gotoWrongContent(page);
    await injectReader(page);
  });

  // Centre of the first REAL-MARKER paragraph, in viewport coords (for the picker).
  const realParaPoint = (page) => page.evaluate(() => {
    const r = document.querySelector('#real-article p').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });

  test('whole-page extraction grabs the decoy (the bug this feature recovers from)', async ({ page }) => {
    await openReader(page);
    const s = await readState(page);
    expect(s.contentText).toContain('DECOY-MARKER'); // the wrong block won, as designed
  });

  test('_wholeExtractionSuspect flags a failed/thin parse but not a full-size one', async ({ page }) => {
    const r = await page.evaluate(() => {
      // Add a known, substantial amount of prose to the live page so proseWordCount is high.
      const big = document.createElement('div');
      big.innerHTML = ('<p>' + Array(60).fill('word').join(' ') + '</p>').repeat(8); // ~480 words
      document.body.appendChild(big);
      const live = OBR._articleWordCount();
      const text = (n) => Array(n).fill('w').join(' ');
      return {
        live,
        failed: OBR._wholeExtractionSuspect(null), // no article → placeholder showing
        thin: OBR._wholeExtractionSuspect({ content: '<p>x</p>', textContent: text(Math.floor(live * 0.2)) }),
        full: OBR._wholeExtractionSuspect({ content: '<p>x</p>', textContent: text(live) }),
      };
    });
    expect(r.live).toBeGreaterThanOrEqual(200); // a substantial page, so the ratio test engages
    expect(r.failed).toBe(true);  // failed parse is always suspect
    expect(r.thin).toBe(true);    // kept ~20% of the page's prose → suspect
    expect(r.full).toBe(false);   // kept ~all of it → confident, no nag
  });

  test('the "Wrong content?" banner stays quiet for a confident, full-size whole-page read', async ({ page }) => {
    // The decoy is a LARGE wrong block (~70% of the page's prose), so the size heuristic can't
    // tell it's wrong — the banner must NOT auto-nag; the ⌖ Pick toolbar button carries that case.
    await openReader(page);
    const r = await page.evaluate(() => {
      const root = document.getElementById('obr-host').shadowRoot;
      const hint = root.querySelector('.obr-pick-hint');
      return {
        bannerShown: hint.classList.contains('show'),
        hasToolbarPick: !!root.querySelector('.obr-btn[data-act="pick"]'),
      };
    });
    expect(r.bannerShown).toBe(false);   // no auto-nag on a full-size extraction
    expect(r.hasToolbarPick).toBe(true); // the ⌖ Pick affordance is still available
  });

  // The positive direction: a genuinely suspect whole-page parse MUST surface the banner. Uses a
  // separate fixture (short article + a big comment thread Readability strips) so the extraction
  // keeps < half the page's prose → extractionSuspect = true. Guards against the gate being
  // disabled/inverted (which the two tests above wouldn't catch).
  test('the "Wrong content?" banner DOES pop when the whole-page parse is suspect (thin extraction)', async ({ page }) => {
    await gotoThinPage(page);
    await injectReader(page);
    await page.evaluate(() => globalThis.OBR.open());
    const r = await page.evaluate(() => {
      const root = document.getElementById('obr-host').shadowRoot;
      const hint = root.querySelector('.obr-pick-hint');
      return { live: OBR._articleWordCount(), bannerShown: hint.classList.contains('show'), bannerText: hint.textContent };
    });
    expect(r.live).toBeGreaterThanOrEqual(200);   // a substantial page (the ratio gate engages)
    expect(r.bannerShown).toBe(true);             // …yet extraction kept < half → banner pops
    expect(r.bannerText).toContain('Wrong content?');
  });

  test('_extractFromNode scopes extraction to the chosen subtree', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = OBR._extractFromNode(document.getElementById('real-article'));
      return { text: a && a.textContent };
    });
    expect(r.text).toContain('REAL-MARKER');
    expect(r.text).not.toContain('DECOY-MARKER');
  });

  test('_cssPathFor builds a selector that round-trips to the element', async ({ page }) => {
    const r = await page.evaluate(() => {
      const el = document.getElementById('real-article');
      const sel = OBR._cssPathFor(el);
      return { sel, roundTrips: sel ? document.querySelector(sel) === el : false };
    });
    expect(r.sel).toBe('#real-article');
    expect(r.roundTrips).toBe(true);
  });

  test('_cssPathFor prefers a readable class over a brittle nth-of-type path', async ({ page }) => {
    const r = await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.innerHTML = '<section><p>a</p><p>b</p></section>'
        + '<div class="reader-body-zone"><p>z</p></div>';
      document.body.appendChild(wrap);
      const el = wrap.querySelector('.reader-body-zone');
      const sel = OBR._cssPathFor(el);
      return { sel, roundTrips: sel ? document.querySelector(sel) === el : false };
    });
    expect(r.sel).toContain('reader-body-zone'); // used the stable class, not :nth-of-type
    expect(r.sel).not.toContain('nth-of-type');
    expect(r.roundTrips).toBe(true);
  });

  test('_cssPathFor uses a lone <article> landmark directly', async ({ page }) => {
    const sel = await page.evaluate(() => {
      const a = document.getElementById('real-article'); // the only <article> on the page
      a.removeAttribute('id'); // force it past the id candidate
      return OBR._cssPathFor(a);
    });
    expect(sel).toBe('article');
  });

  test('scoped extraction strips inline handlers and javascript: URLs (rawFallback is sanitized)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const el = document.createElement('div'); // thin root → Readability bails → rawFallback path
      el.innerHTML = '<p>hi</p><img src="x" onerror="window.__pwned=1">'
        + '<a href="javascript:window.__pwned=1">x</a>';
      document.body.appendChild(el);
      const a = OBR._extractFromNode(el);
      return { content: (a && a.content) || '' };
    });
    expect(r.content).not.toMatch(/onerror/i);     // inline handler stripped
    expect(r.content).not.toMatch(/javascript:/i); // javascript: URL neutralized
  });

  // Direct unit test of the sanitizer itself — no Readability in the loop (a substantial root
  // gets ACCEPTED and cleaned by Readability, masking what sanitizeContentHTML does), so the
  // full vector matrix is proven against the function in isolation.
  test('_sanitizeContentHTML neutralizes every script vector but keeps src-based embeds', async ({ page }) => {
    const r = await page.evaluate(() => OBR._sanitizeContentHTML(
      '<p>hi</p><img src="x" onerror="boom()">'
      + '<a href="javascript:boom()">a</a>'
      + '<form action="javascript:boom()"><button formaction="javascript:boom()">b</button></form>'
      + '<iframe srcdoc="<script>boom()<\/script>"></iframe>'
      + '<iframe src="https://www.example.com/embed/abc"></iframe>' // a legit embed must survive
      + '<svg><script>boom()<\/script></svg>'));
    expect(r).not.toMatch(/onerror/i);          // inline handler
    expect(r).not.toMatch(/javascript:/i);      // href + action + formaction
    expect(r).not.toMatch(/srcdoc/i);           // inline-HTML iframe (page-origin) vector
    expect(r).not.toMatch(/<script/i);          // both HTML and SVG <script> removed
    expect(r).toMatch(/example\.com\/embed/);   // but src-based embeds are preserved
  });

  test('_sanitizeContentHTML strips javascript: obscured by control/whitespace chars in the scheme', async ({ page }) => {
    // Browsers normalize away leading C0-control/space and embedded TAB/LF/CR before resolving a
    // URL scheme, so these all execute despite a naive /^\s*javascript:/ check. <iframe src> is
    // kept (legit embeds), so an obfuscated javascript: there would auto-run on insertion.
    const r = await page.evaluate(() => OBR._sanitizeContentHTML(
      '<a href="java\tscript:boom()">a</a>'         // embedded TAB
      + '<a href="\u0001javascript:boom()">b</a>'   // leading C0 control
      + '<a href="javascript\r:boom()">c</a>'       // CR before the colon
      + '<iframe src="java\tscript:boom()"></iframe>'));
    expect(r).not.toMatch(/javascript/i); // every obfuscated scheme neutralized
    expect(r).not.toMatch(/boom/i);       // payload removed along with the attribute
  });

  test('_extractFromSelector merges every match of a multi-node selector', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = OBR._extractFromSelector('#real-article p'); // all three paragraphs
      return { text: a && a.textContent };
    });
    expect(r.text).toContain('REAL-MARKER'); // 1st paragraph
    expect(r.text).toContain('brass key');   // 3rd paragraph → merged, not just the first match
    expect(r.text).not.toContain('DECOY-MARKER');
  });

  test('reads ONLY the selected text when text is selected', async ({ page }) => {
    await page.evaluate(() => {
      const sel = getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('real-article'));
      sel.addRange(range);
    });
    await openReader(page);
    const s = await readState(page);
    expect(s.contentText).toContain('REAL-MARKER');
    expect(s.contentText).not.toContain('DECOY-MARKER');
  });

  test('ignores the selection when readSelection is off (reads the whole page)', async ({ page }) => {
    await page.evaluate(() => OBR.saveSettings({ readSelection: false }));
    await page.evaluate(() => {
      const sel = getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('real-article'));
      sel.addRange(range);
    });
    await openReader(page);
    const s = await readState(page);
    expect(s.contentText).toContain('DECOY-MARKER'); // selection ignored → whole-page result
  });

  test('the ⌖ Pick button enters picker mode and reads the clicked block', async ({ page }) => {
    await openReader(page);
    await clickInReader(page, '.obr-btn[data-act="pick"]');

    // Picker host is up and the reader is hidden so the page shows through.
    const picking = await page.evaluate(() => ({
      pickHostShown: !!document.getElementById('obr-pick-host')
        && getComputedStyle(document.getElementById('obr-pick-host')).display !== 'none',
      readerHidden: getComputedStyle(document.getElementById('obr-host')).display === 'none',
    }));
    expect(picking.pickHostShown).toBe(true);
    expect(picking.readerHidden).toBe(true);

    const p = await realParaPoint(page);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);

    await expect.poll(() => readState(page).then((s) => s.contentText)).toContain('REAL-MARKER');
    const s = await readState(page);
    expect(s.contentText).not.toContain('DECOY-MARKER');
    expect(s.hostDisplay).not.toBe('none'); // reader restored after the pick
  });

  test('Escape cancels the picker and leaves the original content untouched', async ({ page }) => {
    await openReader(page);
    await clickInReader(page, '.obr-btn[data-act="pick"]');
    await page.keyboard.press('Escape');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.getElementById('obr-host')).display))
      .not.toBe('none'); // reader restored
    const s = await readState(page);
    expect(s.contentText).toContain('DECOY-MARKER'); // unchanged — cancel re-extracts nothing
    const pickGone = await page.evaluate(() =>
      getComputedStyle(document.getElementById('obr-pick-host')).display === 'none');
    expect(pickGone).toBe(true);
  });

  test('saves a pick per site, auto-applies it on reopen, then clears it', async ({ page }) => {
    await openReader(page);
    await clickInReader(page, '.obr-btn[data-act="pick"]');
    const p = await realParaPoint(page);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => readState(page).then((s) => s.contentText)).toContain('REAL-MARKER');

    // Save for this site → persisted to chrome.storage.sync under obr_picks.
    await clickInReader(page, '.obr-pick-hint [data-pick="save"]');
    await expect
      .poll(() => page.evaluate(() => new Promise((res) =>
        chrome.storage.sync.get('obr_picks', (d) => res(Object.keys(d.obr_picks || {}).length)))))
      .toBeGreaterThan(0);

    // Reopen with no selection → the saved pick auto-applies (reads REAL, not DECOY).
    await page.evaluate(() => OBR.close());
    await openReader(page);
    let s = await readState(page);
    expect(s.contentText).toContain('REAL-MARKER');
    expect(s.contentText).not.toContain('DECOY-MARKER');

    // Clear the pick → falls back to the whole page (the decoy) again.
    await clickInReader(page, '.obr-pick-hint [data-pick="clear"]');
    await expect.poll(() => readState(page).then((x) => x.contentText)).toContain('DECOY-MARKER');
  });
});
