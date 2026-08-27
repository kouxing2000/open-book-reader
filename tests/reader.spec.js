/* Feature integration tests for the reader engine, in real Chromium.
 *
 * The harness injects the three content scripts the same way background.js does
 * on a toolbar gesture (settings -> readability -> reader), because headless
 * Playwright can't click the real toolbar icon to grant activeTab. Everything
 * after injection is the production engine, unmodified.
 */

import { test, expect } from './fixtures.js';
import { gotoArticle, gotoPictureArticle, gotoWrongContent, gotoThinPage, gotoTallFigures, gotoFixture, injectReader, openReader, readState, clickInReader } from './helpers.js';

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

// The turn is deliberately slowed so the synchronously-built leaf reliably outlives the query
// round-trip even under load — a fast default turn can finish before count() runs. Every wait
// downstream is expressed as a MULTIPLE of this, never as a flat millisecond number.
const TURN_MS = 1200;

test('the book page-turn floats a transient leaf and then cleans it up', async ({ page }) => {
  await page.evaluate((ms) => globalThis.OBR.saveSettings({ pageTurn: 'book', transitionMs: ms }), TURN_MS);
  await openReader(page);
  // Let the late font/image relayout fire first — layout() ends any in-flight turn, so flipping
  // before it settles would legitimately abort the leaf we're about to assert on.
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(150);

  await page.keyboard.press('ArrowRight');
  expect(await flipLayers(page)).toBe(1);            // built synchronously in the flip handler
  // Teardown fires when the turn ENDS, so this budget has to scale with TURN_MS. It was a flat
  // 3000ms — only 2.5x the transition this same test slows down to 1200ms — which held locally
  // but failed on the first attempt AND the retry on a loaded CI runner, blocking the v1.7.2
  // release (2026-07-29). A leaf that genuinely leaks is NEVER removed, so a generous ceiling
  // costs no sensitivity: this still fails closed on the bug it exists to catch.
  await expect.poll(() => flipLayers(page), { timeout: TURN_MS * 6 }).toBe(0);
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

// Regression test for "the page turn sometimes takes the wrong image". A turn is drawn from
// CLONES of the strip, and a cloned <img> does not inherit the original's loaded state — with
// nothing to size it from it lays out at 0, the clone re-breaks every column after it
// (column-fill: auto), and panel N stops being page N. The snapshot therefore PINS every
// replaced element to an inline px box measured off the live strip, which is what makes the
// clone's layout independent of load state.
//
// The pin must be an INLINE STYLE: `.obr-pages img` sets `width: auto`/`height: auto` as author
// rules, which outrank width/height ATTRIBUTES — an attribute-based version of this measures
// 0x0 in real Chromium and would leave the bug in place while looking fixed.
test('a turn clone pins its media to the live boxes, so it paginates identically', async ({ page }) => {
  // late-image-article's <img> carries NO width/height of its own (and is deliberately slow),
  // which is the real-world shape — tall-figures would prove less, because its markup already
  // dimensions every figure. It is also the harder case: the image is 40x1400, so the reader's
  // max-height cap is what decides the final box the pin has to reproduce.
  await page.goto('/late-image-article.html', { waitUntil: 'load' });
  await injectReader(page);
  await page.evaluate(() => globalThis.OBR.saveSettings({ pageTurn: 'curl' }));
  await openReader(page);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(150);

  await page.keyboard.press('ArrowRight');
  const r = await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const live = root.querySelector('.obr-pages:not(.obr-leaf-pages)');
    const clone = root.querySelector('.obr-flip-layer .obr-leaf-pages');
    if (!live || !clone) return null;
    const liveImgs = [...live.querySelectorAll('img')];
    const cloneImgs = [...clone.querySelectorAll('img')];
    return {
      imgs: liveImgs.length,
      pinned: cloneImgs.filter((im) => im.style.width && im.style.height).length,
      matched: cloneImgs.filter((im, i) => liveImgs[i] && Math.abs(
        parseFloat(im.style.height) - liveImgs[i].getBoundingClientRect().height) < 0.5).length,
      liveW: live.scrollWidth,
      cloneW: clone.scrollWidth,
      desyncs: globalThis.OBR._diagReader().flipDesyncs,
    };
  });

  expect(r).not.toBeNull();
  expect(r.imgs).toBeGreaterThan(0);      // the fixture really does carry images
  expect(r.pinned).toBe(r.imgs);          // every cloned image has an explicit box...
  expect(r.matched).toBe(r.imgs);         // ...and it is the live strip's box
  expect(r.cloneW).toBe(r.liveW);         // so the two paginate to the same column count
  expect(r.desyncs).toBe(0);              // and the engine agrees nothing drifted
});

// The guard of last resort, driven through the only thing that reproduces a re-paginating
// clone: a snapshot whose media collapse (OBR._pinPass seam, same shape as OBR._fitPass —
// and note it pins to ZERO rather than skipping, because a merely un-pinned clone re-fetches
// from cache and sizes itself fine). This test is the point of the seam: TWO successive
// versions of this guard shipped INERT because nothing in the suite could reach them, each
// looking correct in review. With the media collapsed the clone's columns re-break, and the
// turn must refuse to animate rather than show a page the reader never asked for.
test('a snapshot whose media collapse is caught by the guard, which refuses to animate it', async ({ page }) => {
  await gotoTallFigures(page);   // many images == a clone that really does re-paginate
  await injectReader(page);
  await page.evaluate(() => globalThis.OBR.saveSettings({ pageTurn: 'curl' }));
  await page.evaluate(() => { globalThis.OBR._pinPass = false; });
  await openReader(page);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(200);

  await page.keyboard.press('ArrowRight');
  const r = await page.evaluate(() => ({
    diag: globalThis.OBR._diagReader(),
    layers: document.getElementById('obr-host').shadowRoot.querySelectorAll('.obr-flip-layer').length,
    tx: document.getElementById('obr-host').shadowRoot.querySelector('.obr-pages').style.transform,
  }));

  expect(r.diag.flipDesyncs).toBeGreaterThan(0);            // the guard actually ran...
  expect(r.diag.lastFlipDesync.kind).toBe('clone-repaginated');
  expect(r.diag.lastFlipDesync.why).toBeTruthy();           // ...and named the divergence
  expect(r.layers).toBe(0);                                 // overlay dropped, no wrong page
  expect(r.tx).toContain('translateX(-');                   // the real strip still turned
});

// The other half of the same bug: a reflow the engine never subscribed to (a font face that
// swaps in after fonts.ready already resolved) leaves totalColumns/totalSpreads describing a
// layout the strip no longer has, so the turn's index math targets the wrong columns. Growing
// the content behind the engine's back reproduces exactly that state; the next turn must
// notice and re-measure BEFORE computing its target.
test('a reflow the engine never heard about is detected and healed before the next turn', async ({ page }) => {
  await openReader(page);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(150);
  const before = await readState(page);
  expect(await page.evaluate(() => globalThis.OBR._diagReader().flipDesyncs)).toBe(0);

  await page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const filler = document.createElement('p');
    filler.textContent = 'lorem ipsum dolor sit amet '.repeat(400);
    root.querySelector('.obr-content').appendChild(filler);
  });
  // Nothing told the engine, so its cached count is now a lie — the precondition of the bug.
  expect((await readState(page)).totalColumns).toBe(before.totalColumns);

  await page.keyboard.press('ArrowRight');
  const diag = await page.evaluate(() => globalThis.OBR._diagReader());
  const after = await readState(page);

  expect(diag.flipDesyncs).toBeGreaterThan(0);                     // detector fired...
  expect(after.totalColumns).toBeGreaterThan(before.totalColumns); // ...and it re-measured
  // Deliberately NOT asserting lastFlipDesync.kind: the same flip() continues into
  // flipOverlayValid, which may record a later desync of its own and overwrite it. The
  // re-measure above is the behaviour that matters, and only the stale-pagination path
  // produces it.
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

// close() is only ONE way to leave — a tab-close or in-page navigation never calls it,
// and the 400ms persist debounce would drop the last page turn. pagehide must flush.
test('flushes the pending position on pagehide (tab-close path, no close())', async ({ page }) => {
  await openReader(page);
  await page.keyboard.press('End'); // move off page 1; schedules a debounced save
  const fracLeft = progress(await readState(page));
  expect(fracLeft).toBeGreaterThan(0.4); // genuinely past page 1

  // A tab-close / in-page navigation never calls close(); pagehide must still flush the
  // pending position. Spy on savePosition so the flush is observed synchronously (the
  // store write itself is async) and prove it carries the CURRENT page, not a stale one.
  const flushed = await page.evaluate(() => {
    const calls = [];
    const orig = globalThis.OBR.savePosition;
    globalThis.OBR.savePosition = (key, f, now) => { calls.push(f); return orig(key, f, now); };
    try { window.dispatchEvent(new Event('pagehide')); }
    finally { globalThis.OBR.savePosition = orig; }
    return calls;
  });
  expect(flushed).toHaveLength(1); // pagehide flushed exactly once, bypassing the debounce
  expect(flushed[0]).toBeGreaterThan(0.4); // ...with the End position, not stuck at page 1
  expect(Math.abs(flushed[0] - fracLeft)).toBeLessThan(0.05);
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
  // Simulate the abort at the position-entry await (which runs after build()+renderContent)
  // by having it close() first — bumping openGen so the open() that follows aborts.
  await page.evaluate(async () => {
    const orig = OBR.loadPositionEntry;
    OBR.loadPositionEntry = () => { OBR.close(); return Promise.resolve(null); }; // concurrent takeover
    try { await OBR.open(); } finally { OBR.loadPositionEntry = orig; }
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
  expect(r.body).toContain('[Please describe the issue or feedback here]'); // unchanged placeholder the developer's feedback tooling drops
  expect(r.meta).toMatchObject({
    app: 'open-book-reader', platform: 'chrome', mode: 'text',
    reportSource: 'reader-toolbar', proseWords: 1234,
  });
  expect(r.meta.pageUrl).toBe(r.expectedUrl); // query/hash stripped to origin+pathname
});

test('the ⚠ Report button relays obr-open-report with the diagnostics meta (content side of the SW relay)', async ({ page }) => {
  await openReader(page);
  // reportBroken messages the SW (background.js `obr-open-report`), which opens report.html. The
  // headless harness has no real SW, so we capture the outgoing message and assert its shape — a
  // rename of the message type, or a break in _buildReportMeta, would make the ⚠ button a silent
  // no-op (the mailto fallback only fires when sendMessage is ABSENT, not when the SW is broken).
  // The SW handler itself is part of the gesture/SW wiring the headless harness can't exercise.
  const msg = await page.evaluate(() => {
    let sent = null;
    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.runtime = { lastError: null, sendMessage: (m) => { sent = m; } };
    globalThis.OBR.reportBroken({ source: 'reader-toolbar', mode: 'text' });
    return sent;
  });
  expect(msg && msg.type).toBe('obr-open-report');
  expect(msg.meta).toMatchObject({ app: 'open-book-reader', reportSource: 'reader-toolbar', mode: 'text' });
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
  expect(r.html).not.toContain('<div class="obr-print-brand">'); // no brand passed -> no branding footer (the CSS class always exists)
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

test('_qrSvg encodes a URL to a self-contained SVG, and the print doc appends the branding footer when asked', async ({ page }) => {
  await openReader(page);
  const r = await page.evaluate(() => {
    const storeUrl = 'https://chromewebstore.google.com/detail/kmcomogkbbdjhfocbncljmgcnfmaljca';
    const svg = globalThis.OBR._qrSvg('https://example.com/x');
    const same = globalThis.OBR._qrSvg('https://example.com/x'); // deterministic for the same input
    const branded = globalThis.OBR._buildPrintDoc({
      title: 'T', content: '<p>Body.</p>', fontFamily: 'serif', lineHeight: 1.6,
      brand: { name: 'Open Book Reader', tagline: 'Printed with the free, distraction-free reader',
        url: 'chromewebstore.google.com', qrSvg: globalThis.OBR._qrSvg(storeUrl) },
    });
    const plain = globalThis.OBR._buildPrintDoc({ title: 'T', content: '<p>Body.</p>' });
    return { svg, deterministic: svg === same, branded, plain, emptyType: typeof globalThis.OBR._qrSvg('') };
  });
  // A real, self-contained vector QR: quiet-zone <rect> + a dark-module <path>, stable per input.
  expect(r.svg).toContain('<svg');
  expect(r.svg).toContain('viewBox="0 0');
  expect(r.svg).toContain('<path d="M');
  expect(r.deterministic).toBe(true);
  expect(r.emptyType).toBe('string'); // empty text never throws (guarded), returns a string
  // Branding footer appears ONLY when a brand is passed (printReader gates it on printBranding).
  expect(r.branded).toContain('<div class="obr-print-brand">');
  expect(r.branded).toContain('Open Book Reader');
  expect(r.branded).toContain('Printed with the free, distraction-free reader'); // the attribution tagline
  expect(r.branded).toContain('chromewebstore.google.com');
  expect(r.branded).toContain('<svg'); // the QR is embedded in the footer
  expect(r.plain).not.toContain('<div class="obr-print-brand">'); // absent by default (the CSS class always exists)
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

  // The banner carries BOTH ways out: ⌖ Pick, which the user can apply themselves, and ⚠ Report,
  // for when they cannot. The toolbar has its own ⚠, but this is the moment it is least likely to
  // be found — the page looks broken, so nobody goes hunting through the chrome for it.
  // An extension reload orphans an already-injected engine: the overlay stays on screen and
  // fully interactive while every chrome.* in that world throws. The worker cannot see this —
  // a click on the stale overlay never reaches it — so the detection has to live in the page.
  // The harness runs these files in a plain main world, so `_ctxDead` is armed by giving the
  // page a live-looking chrome.runtime.id at load and taking it away afterwards, which is
  // exactly the transition an extension reload performs.
  test('an orphaned overlay retires itself and says why, instead of throwing on every click', async ({ page }) => {
    await gotoArticle(page);
    await page.addInitScript(() => {
      // Present BEFORE the content scripts load, so settings.js snapshots "this context lived".
      globalThis.chrome = globalThis.chrome || {};
      chrome.runtime = Object.assign({}, chrome.runtime, { id: 'test-extension-id' });
    });
    await page.reload();
    await injectReader(page);
    await page.evaluate(() => globalThis.OBR.open());
    await expect.poll(() => page.evaluate(() => !!globalThis.OBR._diagReader().active)).toBe(true);
    // Positive landmark: it really did open, so the assertions below measure the reload and not
    // a reader that was never there.
    expect(await page.evaluate(() => !!document.getElementById('obr-host'))).toBe(true);

    await page.evaluate(() => { delete chrome.runtime.id; });   // ← the extension reload
    const r = await page.evaluate(() => {
      const before = globalThis.OBR._ctxDead();
      document.getElementById('obr-host').click();              // door 1: a click on the stale overlay
      const notice = document.getElementById('obr-notice');
      return {
        dead: before,
        hostGone: !document.getElementById('obr-host'),         // retired, not left on screen
        scrollUnlocked: document.documentElement.style.overflow === '',
        notice: notice && notice.shadowRoot ? notice.shadowRoot.querySelector('.msg').textContent : '',
        acts: notice && notice.shadowRoot
          ? Array.from(notice.shadowRoot.querySelectorAll('button')).map((b) => b.textContent) : [],
      };
    });
    expect(r.dead).toBe(true);
    expect(r.hostGone).toBe(true);
    expect(r.scrollUnlocked).toBe(true);
    // Localized, because the strings were snapshotted at load while the context was alive —
    // OBR.t cannot run any more, so a banner resolved on demand would show raw keys.
    expect(r.notice).toContain('was updated');
    expect(r.acts).toEqual(['Reload page', 'Dismiss']);
  });

  // The regression that made the cure worse than the disease: the one-shot flag guarded the
  // TEARDOWN as well as the banner, so a second overlay reaching _ctxLost was never retired —
  // and the click and keydown guards then swallowed every way of closing it, on a page whose
  // scroll was still locked. The test lives at the altitude of the DEFECT: it re-triggers after
  // the first retire, which is what background.js does (it dispatches even after detecting the
  // orphan), rather than asserting _ctxLost in isolation.
  test('a SECOND retire after the banner still tears down — no unclosable, scroll-locked overlay', async ({ page }) => {
    await gotoArticle(page);
    await page.addInitScript(() => {
      globalThis.chrome = globalThis.chrome || {};
      chrome.runtime = Object.assign({}, chrome.runtime, { id: 'test-extension-id' });
    });
    await page.reload();
    await injectReader(page);
    await page.evaluate(() => globalThis.OBR.open());
    await expect.poll(() => page.evaluate(() => !!globalThis.OBR._diagReader().active)).toBe(true);
    expect(await page.evaluate(() => !!document.getElementById('obr-host'))).toBe(true); // landmark

    const r = await page.evaluate(async () => {
      delete chrome.runtime.id;                        // the extension reload
      document.getElementById('obr-host').click();     // first retire → banner
      const first = { host: !!document.getElementById('obr-host'),
                      overflow: document.documentElement.style.overflow };
      await globalThis.OBR.open();                     // …and the trigger the worker still sends
      return { first, second: { host: !!document.getElementById('obr-host'),
                                overflow: document.documentElement.style.overflow,
                                active: globalThis.OBR._diagReader().active } };
    });
    expect(r.first.host).toBe(false);
    expect(r.first.overflow).toBe('');
    // The re-open must not leave a live overlay behind in a world that cannot drive it.
    expect(r.second.host).toBe(false);
    expect(r.second.overflow).toBe('');   // scroll never left locked
    expect(r.second.active).toBe(false);
  });

  test('OBR.t degrades to the key instead of throwing when the context is dead', async ({ page }) => {
    // settings.js:23 in the crash report: the old guard tested whether chrome.i18n EXISTS, but an
    // invalidated context keeps the object and throws on the CALL.
    await gotoArticle(page);
    await injectReader(page);
    const out = await page.evaluate(() => {
      const real = chrome.i18n;
      chrome.i18n = { getMessage() { throw new Error('Extension context invalidated.'); } };
      try { return { value: globalThis.OBR.t('noticeDismiss'), threw: false }; }
      catch (e) { return { value: null, threw: true }; }
      finally { chrome.i18n = real; }
    });
    expect(out.threw).toBe(false);
    expect(out.value).toBe('noticeDismiss'); // the key, which is the documented degradation
  });

  // A page with NO article at all gets the empty state instead of the article — and the empty
  // state OWNS the two ways out, so the pill below it must stay down. Both halves matter: the
  // offer has to be on screen, and it must not be on screen twice.
  test('no article: an empty state carries both ways out, and the hint pill does not repeat them', async ({ page }) => {
    await gotoArticle(page);
    await injectReader(page);
    await page.evaluate(() => {
      // Readability returns an article for almost anything — even a lone <div> of text becomes
      // one. It yields NULL only when there is genuinely nothing, which is what an SPA shell or
      // a login wall looks like at open time, and that is the path the empty state exists for.
      document.body.innerHTML = '';
      globalThis.OBR.open();  // async — poll below rather than reading straight after
    });
    await expect.poll(() => page.evaluate(() => !!globalThis.OBR._diagReader().active)).toBe(true);
    const r = await page.evaluate(() => {
      const root = document.getElementById('obr-host').shadowRoot;
      const empty = root.querySelector('.obr-empty');
      return {
        shown: !!empty,
        head: empty ? empty.querySelector('.obr-empty-head').textContent : '',
        acts: empty ? Array.from(empty.querySelectorAll('[data-pick]')).map((b) => b.dataset.pick) : [],
        // The duplication this replaced: the pill said the same thing directly underneath.
        pillShown: root.querySelector('.obr-pick-hint').classList.contains('show'),
        // Alert chrome would have to fight three themes and the user's font size — assert the
        // empty state takes its colour from the theme instead of a hardcoded alert palette.
        headColor: empty ? getComputedStyle(empty.querySelector('.obr-empty-head')).color : '',
        overlayColor: getComputedStyle(root.querySelector('.obr-overlay')).color,
      };
    });
    expect(r.shown).toBe(true);
    expect(r.head).toBe('No article on this page');
    // 'report-empty', not 'report': the hint bar's button reports 'suspect-extraction', which
    // would be a lie here — Readability returned nothing at all, a different report and a
    // different fix. Asserting the exact action is what keeps the two from being merged back.
    expect(r.acts).toEqual(['start', 'report-empty']);
    expect(r.pillShown).toBe(false);               // …and offered exactly once
    expect(r.headColor).toBe(r.overlayColor);      // inherits the theme, is not an alert colour

    await page.evaluate(() => {
      window.__obrMsgs = [];
      chrome.runtime = { lastError: null, sendMessage(m, cb) { window.__obrMsgs.push(m); if (cb) cb({ ok: true }); } };
      document.getElementById('obr-host').shadowRoot.querySelector('[data-pick="report-empty"]').click();
    });
    const sent = await page.evaluate(() => window.__obrMsgs.filter((m) => m.type === 'obr-open-report'));
    expect(sent).toHaveLength(1);
    expect(sent[0].meta.reportSource).toBe('empty-state');
    expect(sent[0].meta.failure).toEqual({ state: 'no-article', by: '' });
  });

  test('the "Wrong content?" banner offers ⚠ Report, and the report names why it was flagged', async ({ page }) => {
    await gotoThinPage(page);
    await injectReader(page);
    await page.evaluate(() => globalThis.OBR.open());
    // Same capture as the ⚙ Settings test above: the reader runs in the test's main world with no
    // real chrome.runtime, so install a recording sendMessage before the click.
    await page.evaluate(() => {
      window.__obrMsgs = [];
      chrome.runtime = { lastError: null, sendMessage(m, cb) { window.__obrMsgs.push(m); if (cb) cb({ ok: true }); } };
    });
    // Positive landmark: the button must actually be in the banner, or the click below would
    // silently do nothing and an empty __obrMsgs would read as a delivery failure instead.
    expect(await page.evaluate(() => !!document.getElementById('obr-host').shadowRoot
      .querySelector('.obr-pick-hint [data-pick="report"]'))).toBe(true);
    await clickInReader(page, '.obr-pick-hint [data-pick="report"]');
    const sent = await page.evaluate(() => window.__obrMsgs.filter((m) => m.type === 'obr-open-report'));
    expect(sent).toHaveLength(1);
    expect(sent[0].meta.reportSource).toBe('pick-hint');
    // The verdict rides along, so "it doesn't work on this site" arrives with the numbers that
    // triggered it instead of needing a reproduction.
    expect(sent[0].meta.failure.state).toBe('suspect-extraction');
    expect(sent[0].meta.failure.by).toMatch(/^\d+ of \d+ words kept$/);
    expect(sent[0].meta.mode).toBe('text');
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
  test('_sanitizeContentHTML neutralizes every script vector and strips iframe/form, keeping src-based media', async ({ page }) => {
    const r = await page.evaluate(() => OBR._sanitizeContentHTML(
      '<p>hi</p><img src="x" onerror="boom()">'
      + '<a href="javascript:boom()">a</a>'
      + '<form action="javascript:boom()"><button formaction="javascript:boom()">b</button></form>'
      + '<iframe srcdoc="<script>boom()<\/script>"></iframe>'
      + '<iframe src="https://www.example.com/embed/abc"></iframe>' // cross-origin framing — removed wholesale
      + '<video src="https://cdn.example.com/clip.mp4"></video>'    // a legit src-based media embed must survive
      + '<svg><script>boom()<\/script></svg>'));
    expect(r).not.toMatch(/onerror/i);            // inline handler
    expect(r).not.toMatch(/javascript:/i);        // href + action + formaction
    expect(r).not.toMatch(/srcdoc/i);             // inline-HTML iframe (page-origin) vector
    expect(r).not.toMatch(/<script/i);            // both HTML and SVG <script> removed
    expect(r).not.toMatch(/<iframe/i);            // iframes stripped (cross-origin framing / clickjacking)
    expect(r).not.toMatch(/example\.com\/embed/); // ...including the src, so no framed content survives
    expect(r).not.toMatch(/<form/i);              // forms stripped (phishing surface in the trusted overlay)
    expect(r).toMatch(/cdn\.example\.com\/clip/); // but src-based media embeds are preserved
  });

  test('_sanitizeContentHTML strips javascript: obscured by control/whitespace chars in the scheme', async ({ page }) => {
    // Browsers normalize away leading C0-control/space and embedded TAB/LF/CR before resolving a
    // URL scheme, so these all execute despite a naive /^\s*javascript:/ check. (<iframe> is now
    // removed wholesale; keep one here to prove the scheme normalization ALSO neutralizes it.)
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

/* ----------------------------------- picking an image-rich block (photo-essay pages).
 * The regression lives at the WIRING, not the parser: on a figure+figcaption photo essay
 * (photo-essay.html, distilled from a real forbes.ru gallery — issue #1) Readability
 * SUCCEEDS with a caption-only, image-free parse, and extractFromNode used to trust any
 * non-empty success — so the ⌖ Pick button returned the same broken result no matter what
 * the user pointed at. rawFallback's contract ("you see exactly what you picked") has to
 * win over a parse that dropped every image in the picked block. */
test.describe('picking an image-rich block', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page, 'photo-essay.html');
    await injectReader(page);
  });

  // Shadow-DOM view of what the reader actually rendered.
  const rendered = (page) => page.evaluate(() => {
    const root = document.getElementById('obr-host').shadowRoot;
    const pages = root.querySelector('.obr-pages');
    return {
      imgs: pages ? pages.querySelectorAll('img').length : 0,
      text: pages ? pages.textContent.replace(/\s+/g, ' ') : '',
    };
  });

  // The real picker flow: ⌖, then click the gallery section's top padding (the padding
  // makes elementFromPoint yield the SECTION itself, not one of its figures).
  const pickGallerySection = async (page) => {
    await clickInReader(page, '.obr-btn[data-act="pick"]');
    const pt = await page.evaluate(() => {
      const r = document.getElementById('photo-gallery').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 12) };
    });
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.click(pt.x, pt.y);
  };

  test('⌖ Pick on the gallery section renders its figures, not a caption-only parse', async ({ page }) => {
    await openReader(page);

    // Precondition landmark, not a wish: the whole-page parse must reproduce the bug —
    // caption text extracted, zero images — or this test no longer exercises the defect
    // path and the fixture needs rebuilding (see photo-essay.html's header comment).
    const before = await rendered(page);
    expect(before.imgs).toBe(0);
    expect(before.text).toContain('GCAP-DENSE');

    await pickGallerySection(page);

    // The picked block holds 6 figures; the reader must show them all, captions included.
    await expect.poll(() => rendered(page).then((r) => r.imgs)).toBe(6);
    const after = await rendered(page);
    expect(after.text).toContain('GCAP-1');
    expect(after.text).toContain('GCAP-6');
  });

  test('the fallback fires for a LAZY-placeholder gallery too (guard counts the hydrated block)', async ({ page }) => {
    // The shape a JS-lazy gallery has before its own script runs: every img holds a
    // placeholder src and the real URL sits in data-src. The guard must count the
    // HYDRATED block — a live-src count is zero here and would skip the fallback on
    // exactly the page class the fix exists for.
    await page.evaluate(() => {
      document.querySelectorAll('#photo-gallery img').forEach((img) => {
        img.setAttribute('data-src', img.getAttribute('src'));
        img.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');
      });
    });
    await openReader(page);
    await pickGallerySection(page);
    await expect.poll(() => rendered(page).then((r) => r.imgs)).toBe(6);
    const after = await rendered(page);
    expect(after.text).toContain('GCAP-1');
  });

  // NOTE: this asserts the happy route only — for a 0-image pick, the Readability parse
  // and rawFallback render the SAME text, so these assertions cannot tell the branches
  // apart. It's a smoke test that a plain text pick renders what was picked, not proof
  // of which path served it.
  test('a text-only pick renders the picked prose, nothing dragged in', async ({ page }) => {
    await openReader(page);
    await clickInReader(page, '.obr-btn[data-act="pick"]');
    // Pick the decoy aside: plenty of text, no images — the parse path, not rawFallback.
    // It sits below the six figures, so bring it into the viewport first (picker mode
    // unlocks page scroll for exactly this reason).
    const pt = await page.evaluate(() => {
      const el = document.querySelector('#essay-decoy p');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.click(pt.x, pt.y);
    await expect.poll(() => rendered(page).then((r) => r.text)).toContain('GDECOY-MARKER');
    const s = await rendered(page);
    expect(s.imgs).toBe(0); // nothing to rescue; no figures dragged in from elsewhere
  });
});

test('vendored Readability exposes disableConditionalCleaning as a public option (image-rescue no longer mutates private _flags)', async ({ page }) => {
  // Finding #4 fix: the image-dominant re-parse switched from clearing the private
  // _flags field in reader.js to this constructor option on the vendored lib. Verify
  // the option toggles exactly the conditional-cleaning flag and leaves the others
  // intact. (Reading _flagIsActive here is test-only introspection of the vendored
  // library; the point of the fix is that APPLICATION code no longer does this. The
  // end-to-end behavior is guarded by the "image-dominant forum post" test above.)
  const r = await page.evaluate(() => {
    const doc = () => new DOMParser().parseFromString(
      '<!DOCTYPE html><html><body><p>x</p></body></html>', 'text/html');
    const def = new Readability(doc());
    const off = new Readability(doc(), { disableConditionalCleaning: true });
    return {
      defaultConditional: def._flagIsActive(def.FLAG_CLEAN_CONDITIONALLY),
      disabledConditional: off._flagIsActive(off.FLAG_CLEAN_CONDITIONALLY),
      defaultStrip: def._flagIsActive(def.FLAG_STRIP_UNLIKELYS),
      disabledStrip: off._flagIsActive(off.FLAG_STRIP_UNLIKELYS),
      defaultWeight: def._flagIsActive(def.FLAG_WEIGHT_CLASSES),
      disabledWeight: off._flagIsActive(off.FLAG_WEIGHT_CLASSES),
    };
  });
  // Default: conditional cleaning ON; with the option: OFF.
  expect(r.defaultConditional).toBe(true);
  expect(r.disabledConditional).toBe(false);
  // The option must touch ONLY conditional cleaning; the other two flags stay on.
  expect(r.defaultStrip).toBe(true);
  expect(r.disabledStrip).toBe(true);
  expect(r.defaultWeight).toBe(true);
  expect(r.disabledWeight).toBe(true);
});

test('incognito leaves no reading trace on disk, but deliberate preferences still persist', async ({ page }) => {
  // The manifest declares no `incognito` key, so Chrome's default "spanning" mode gives normal
  // and incognito windows ONE worker and ONE chrome.storage. A content script can't tell which
  // kind of tab it's in, so the SW sets OBR._incognito from tab.incognito. Without that, reading
  // in incognito wrote obr_positions (which carries origin+pathname — browsing history),
  // obr_lifetime and obr_usage into storage.local, which OUTLIVES the incognito session.
  // Passive records must be suppressed; a preference the user deliberately changed must not be.
  // obr_engage is included deliberately: it is SYNC storage AND a permanent kill-switch — one
  // recorded colophon impression retires the engagement chip forever on every device — so an
  // incognito leak there is the worst of the set. An earlier version of this test omitted it and
  // passed while that hole was wide open.
  const read = () => page.evaluate(() => new Promise((res) => chrome.storage.local.get(
    ['obr_positions', 'obr_lifetime', 'obr_usage'],
    (d) => chrome.storage.sync.get('obr_engage', (s) => res({
      positions: Object.keys(d.obr_positions || {}).length,
      lifetime: Object.keys(d.obr_lifetime || {}).length,
      usage: Object.keys(d.obr_usage || {}).length,
      engage: Object.keys(s.obr_engage || {}).length,
    })))));

  await page.evaluate(() => { OBR._incognito = true; });
  await openReader(page);
  await page.keyboard.press('End');   // finishing is what bumps lifetime + marks the position
  await page.evaluate(() => OBR.close());
  await page.waitForTimeout(300);     // past the persist debounce
  expect(await read()).toEqual({ positions: 0, lifetime: 0, usage: 0, engage: 0 });

  // A deliberate settings write is the user's own choice — it must still stick.
  await page.evaluate(() => OBR.saveSettings({ theme: 'dark' }));
  await expect.poll(() => page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_settings', (d) => res((d.obr_settings || {}).theme))))).toBe('dark');
  await page.evaluate(() => OBR.saveSettings({ theme: 'paper' })); // restore for later tests

  // Control: with the flag off, the same journey DOES record — proving the test can fail.
  await page.evaluate(() => { OBR._incognito = false; });
  await openReader(page);
  await page.keyboard.press('End');
  await page.evaluate(() => OBR.close());
  await expect.poll(() => read().then((r) => r.positions)).toBeGreaterThan(0);
});

test('rapid re-triggers start ONE open instead of cancelling each other', async ({ page }) => {
  // Regression: `active` is only set at the END of the open path, after ~5 awaits (settings,
  // saved pick, position/engage/lifetime), so `if (active) return` guarded nothing during that
  // window. Every trigger inside it started a RIVAL open, and since each open does ++openGen the
  // newcomer cancelled the in-flight one — so mashing the shortcut because nothing had appeared
  // yet cancelled each attempt in turn. A real-world debug trace showed 4x "start" against a
  // single completed run. Probing via the debug-timing console output keeps this on OBSERVABLE
  // behaviour rather than the internal `opening` flag.
  const starts = [];
  page.on('console', (m) => { if (m.text().includes('[OBR reader] start')) starts.push(m.text()); });
  await page.evaluate(() => OBR.debugTiming(true));
  await page.evaluate(() => { for (let i = 0; i < 5; i++) OBR.toggle(); });
  await expect.poll(() => readState(page).then((s) => s.indicator)).toContain('pages');
  expect(starts.length).toBe(1);                  // 5 before the guard, 1 after
  expect(await readState(page).then((s) => s.hostDisplay)).not.toBe('none'); // and it really opened
  await page.evaluate(() => OBR.debugTiming(false));
});

/* --------------------------------------------- tall-figure shrink-to-slack (fitTallFigures) */

// Count the blank TAILS the pass exists to remove: non-final columns whose content stops well
// short of the column bottom. This is the quantity the fix actually moves, measured off the real
// rendered geometry — deliberately NOT the pass's internals (no assertions on inline max-height
// or on which figure got picked), so a future rewrite achieving the same result still passes.
function blankTails(page) {
  return page.evaluate(() => {
    const sr = document.getElementById('obr-host').shadowRoot;
    const pages = sr.querySelector('.obr-pages');
    const content = sr.querySelector('.obr-content');
    const cs = getComputedStyle(pages);
    const colW = parseFloat(cs.columnWidth), gap = parseFloat(cs.columnGap), colH = parseFloat(cs.height);
    const pr = pages.getBoundingClientRect();
    const colOf = (x) => Math.round((x - pr.left) / (colW + gap));
    const cols = Math.max(1, Math.round((pages.scrollWidth + gap) / (colW + gap)));
    const ends = new Array(cols).fill(0);
    for (const n of content.querySelectorAll('p, h1, figure, figcaption')) {
      for (const r of n.getClientRects()) {
        if (r.width <= 0.5 || r.height <= 0.5) continue;
        const c = colOf(r.left);
        if (c < 0 || c >= cols) continue;
        ends[c] = Math.max(ends[c], r.bottom - pr.top);
      }
    }
    const slacks = ends.slice(0, Math.max(0, cols - 1)).map((e) => Math.max(0, colH - e));
    return { cols, bigBlanks: slacks.filter((s) => s > colH * 0.30).length };
  });
}

/* openReader() resolves at the FIRST layout, but the reader keeps re-paginating through its
 * late-media settle window (scheduleMediaRelayout's 80ms debounce, re-armed per decoded image,
 * plus document.fonts.ready). Sampling once therefore sometimes read the PRE-settle geometry and
 * reported the un-fitted column count — a flake, not a regression (observed once in a full-file
 * run; the same test passed 3/3 in isolation). Read until two consecutive samples agree so the
 * assertion sees the settled layout. */
async function settledBlankTails(page) {
  let prev = await blankTails(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const cur = await blankTails(page);
    if (cur.cols === prev.cols && cur.bigBlanks === prev.bigBlanks) return cur;
    prev = cur;
  }
  return prev;
}

test.describe('tall-figure shrink-to-slack', () => {
  test('fits bumped figures into the slack they stranded, cutting blank pages', async ({ page }) => {
    await gotoTallFigures(page);
    await injectReader(page);

    // A/B on ONE fixture via the OBR._fitPass seam: without the pass, the CSS cap alone leaves
    // each tall figure bumped with a large blank tail behind it; with it, those figures shrink
    // into the slack. Comparing the two runs (rather than asserting fixed pixel counts) keeps
    // this robust to font/metric drift while still proving the pass is what causes the win.
    await page.evaluate(() => { OBR._fitPass = false; });
    await openReader(page);
    const off = await settledBlankTails(page);
    await page.evaluate(() => OBR.close());

    await page.evaluate(() => { OBR._fitPass = true; });
    await openReader(page);
    const on = await settledBlankTails(page);

    expect(off.bigBlanks).toBeGreaterThan(0);        // the fixture really does strand blanks
    expect(on.bigBlanks).toBeLessThan(off.bigBlanks); // ...and the pass removes some of them
    expect(on.cols).toBeLessThanOrEqual(off.cols);    // never costs pages
  });

  test('is idempotent across relayouts and never strands an unfitted shrink', async ({ page }) => {
    await gotoTallFigures(page);
    await injectReader(page);
    await openReader(page);
    const first = await settledBlankTails(page); // same pre-settle race as the A/B test above
    // Re-run layout twice (the late-image settle window does exactly this). The pass clears its
    // own overrides first, so repeated layouts must converge to the same geometry rather than
    // ratcheting images smaller each time.
    for (let i = 0; i < 2; i++) {
      await page.setViewportSize({ width: 1281, height: 800 });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(300);
    }
    const again = await blankTails(page);
    expect(again.cols).toBe(first.cols);
    expect(again.bigBlanks).toBe(first.bigBlanks);
    // Every surviving override must have actually moved its figure up a column (verify-or-revert),
    // so no image is ever left shrunken for nothing.
    const stranded = await page.evaluate(() => {
      const sr = document.getElementById('obr-host').shadowRoot;
      const pages = sr.querySelector('.obr-pages');
      const cs = getComputedStyle(pages);
      const colW = parseFloat(cs.columnWidth), gap = parseFloat(cs.columnGap);
      const pr = pages.getBoundingClientRect();
      const colOf = (x) => Math.round((x - pr.left) / (colW + gap));
      let bad = 0;
      for (const el of sr.querySelectorAll('.obr-content [data-obr-fit]')) {
        const block = el.closest('figure') || el;
        // A fitted figure shares a column with preceding text, so it must NOT sit at a column top.
        if (block.getBoundingClientRect().top - pr.top < 4 && colOf(block.getBoundingClientRect().left) > 0) bad++;
      }
      return bad;
    });
    expect(stranded).toBe(0);
  });
});

/* ------------------------------------------------ back-cover colophon + engagement */

// The engagement/colophon state persists in the shimmed (localStorage-backed) storage
// across tests in this context, so each test below seeds its own clean slate BEFORE
// opening — otherwise an earlier test's ✕ (done=true) or accumulated ask impressions
// would leak in and the assertions would depend on test order.
function resetEngagement(page) {
  // obr_positions clears too: an earlier End-pressing test leaves fin:1 on this
  // article's entry, which would defeat the "counts once" assertions below.
  return page.evaluate(() => new Promise((res) =>
    chrome.storage.sync.set({ obr_engage: {} }, () =>
      chrome.storage.local.set({ obr_usage: {}, obr_lifetime: {}, obr_positions: {} }, res))));
}

// Re-open within the same page session. openReader()'s indicator poll would pass
// instantly on the PREVIOUS open's still-rendered DOM (close only hides the host), so
// wait on the _opensCompleted hook instead, plus a double rAF for the deferred layout().
async function reopenReader(page) {
  const before = await page.evaluate(() => OBR._opensCompleted || 0);
  await page.evaluate(() => OBR.open());
  await expect.poll(() => page.evaluate(() => OBR._opensCompleted || 0)).toBe(before + 1);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test.describe('back-cover colophon', () => {
  test('shows The End + reading stats at the article end, with the quiet ask', async ({ page }) => {
    await resetEngagement(page);
    await openReader(page);
    await page.keyboard.press('End');
    const colo = await page.evaluate(() => {
      const el = document.getElementById('obr-host').shadowRoot.querySelector('.obr-colophon');
      if (!el) return null;
      return {
        fin: el.querySelector('.obr-colo-fin')?.textContent || '',
        stats: el.querySelector('.obr-colo-stats')?.textContent || '',
        askHidden: el.querySelector('.obr-colo-ask')?.hidden,
        fadedIn: el.classList.contains('obr-colo-in'),
      };
    });
    expect(colo).not.toBeNull();
    expect(colo.fin).toContain('The End');
    expect(colo.stats).toMatch(/[\d,]+ words/);   // article word count
    expect(colo.stats).toMatch(/\d+ (min|h)/);    // accumulated reading time
    expect(colo.askHidden).toBe(false);           // fresh profile → the ask line is present
    expect(colo.fadedIn).toBe(true);              // revealed when its spread came on screen
  });

  test('✕ retires the ask everywhere (synced) but keeps the stats page', async ({ page }) => {
    await resetEngagement(page);
    await openReader(page);
    await page.keyboard.press('End');
    await page.evaluate(() =>
      document.getElementById('obr-host').shadowRoot.querySelector('.obr-colo-x').click());
    // Hidden immediately, and the outcome is persisted for every future surface.
    expect(await page.evaluate(() =>
      document.getElementById('obr-host').shadowRoot.querySelector('.obr-colo-ask').hidden)).toBe(true);
    await expect.poll(() => page.evaluate(() => new Promise((res) =>
      chrome.storage.sync.get('obr_engage', (d) => res((d.obr_engage || {}).done))))).toBe(true);
    // Reopen: the reward page still appears; only the ask is gone.
    await page.evaluate(() => OBR.close());
    await reopenReader(page);
    await page.keyboard.press('End');
    const again = await page.evaluate(() => {
      const el = document.getElementById('obr-host').shadowRoot.querySelector('.obr-colophon');
      return { stats: el.querySelector('.obr-colo-stats').textContent, askHidden: el.querySelector('.obr-colo-ask').hidden };
    });
    expect(again.stats).toMatch(/words/);
    expect(again.askHidden).toBe(true);
  });

  test('colophon setting off = the article just ends', async ({ page }) => {
    await resetEngagement(page);
    await page.evaluate(() => OBR.saveSettings({ colophon: false }));
    await openReader(page);
    await page.keyboard.press('End');
    expect(await page.evaluate(() =>
      !!document.getElementById('obr-host').shadowRoot.querySelector('.obr-colophon'))).toBe(false);
    await page.evaluate(() => OBR.saveSettings({ colophon: true })); // restore for later tests
  });

  // Pure parity guard for the "546 words -> blank facing page" report: the colophon may only
  // fill an ALREADY-blank trailing page, never open its own fresh spread. It fits iff the
  // content does NOT divide evenly into spreads; single-page mode (no facing page) always fits.
  test('_colophonFitsLastSpread: only fills an existing blank, never opens a blank spread', async ({ page }) => {
    const r = await page.evaluate(() => {
      const F = OBR._colophonFitsLastSpread;
      return {
        // 2-up: odd content columns leave a spare page -> fits; even fills spreads -> would blank.
        twoOdd: F(3, 2), twoOdd2: F(5, 2), twoOdd3: F(7, 2),
        twoEven: F(2, 2), twoEven2: F(4, 2), twoEven3: F(6, 2),
        // 3-up: fits unless content is a multiple of 3.
        threeSpare: F(4, 3), threeSpare2: F(5, 3), threeFull: F(6, 3), threeFull2: F(3, 3),
        // single-page: no facing page can go blank -> always fits, any parity.
        singleEven: F(4, 1), singleOdd: F(5, 1),
      };
    });
    expect(r).toEqual({
      twoOdd: true, twoOdd2: true, twoOdd3: true,
      twoEven: false, twoEven2: false, twoEven3: false,
      threeSpare: true, threeSpare2: true, threeFull: false, threeFull2: false,
      singleEven: true, singleOdd: true,
    });
  });

  test('lifetime line appears for an established reader and hides via its inline link', async ({ page }) => {
    await resetEngagement(page);
    // 3 articles / 2h already on this device; finishing this one makes it the 4th.
    await page.evaluate(() => new Promise((res) =>
      chrome.storage.local.set({ obr_lifetime: { articles: 3, ms: 7200000 } }, res)));
    await openReader(page);
    await page.keyboard.press('End');
    const life = await page.evaluate(() => {
      const el = document.getElementById('obr-host').shadowRoot.querySelector('.obr-colo-life');
      return { hidden: el.hidden, text: el.querySelector('span').textContent };
    });
    expect(life.hidden).toBe(false);
    expect(life.text).toMatch(/4 articles finished/);
    expect(life.text).toMatch(/2 h/);
    // The inline "hide" is the promised off switch — flips the synced setting directly.
    await page.evaluate(() =>
      document.getElementById('obr-host').shadowRoot.querySelector('.obr-colo-hide').click());
    expect(await page.evaluate(() =>
      document.getElementById('obr-host').shadowRoot.querySelector('.obr-colo-life').hidden)).toBe(true);
    await expect.poll(() => page.evaluate(() => new Promise((res) =>
      chrome.storage.sync.get('obr_settings', (d) => res((d.obr_settings || {}).colophonLifetime))))).toBe(false);
    await page.evaluate(() => OBR.saveSettings({ colophonLifetime: true })); // restore
  });

  test('finishing an article counts once toward the device totals', async ({ page }) => {
    await resetEngagement(page);
    await openReader(page);
    await page.keyboard.press('End');
    await page.keyboard.press('Home');
    await page.keyboard.press('End'); // reaching the end twice must not double-count
    await expect.poll(() => page.evaluate(() => new Promise((res) =>
      chrome.storage.local.get('obr_lifetime', (d) => res((d.obr_lifetime || {}).articles))))).toBe(1);
    // Re-open the same article and finish again: still one.
    await page.evaluate(() => OBR.close());
    await reopenReader(page);
    await page.keyboard.press('End');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => new Promise((res) =>
      chrome.storage.local.get('obr_lifetime', (d) => res((d.obr_lifetime || {}).articles))))).toBe(1);
  });

  test('"Use full page" after a saved pick cannot double-count a finished article', async ({ page }) => {
    // Regression (review finding): reExtractWholePage resets the in-memory priorFin, so the
    // finish count must be gated on the STORED fin flag, not the session copy. Seed the
    // whole-page entry as already finished, read via a saved pick, then switch to full page
    // and press End — the lifetime count must stay 0.
    await resetEngagement(page);
    await page.evaluate(() => new Promise((res) => chrome.storage.local.set(
      { obr_positions: { [location.origin + location.pathname]: { f: 1, fin: 1, t: 1 } } }, res)));
    await page.evaluate(() => OBR.savePick(OBR.normalizeHost(location.href), 'article'));
    await openReader(page); // reads via the saved pick (its own #pick position key)
    await clickInReader(page, '.obr-pick-hint [data-pick="fullpage"]');
    await expect.poll(() => readState(page).then((s) => s.indicator)).toContain('pages');
    await page.keyboard.press('End');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => new Promise((res) =>
      chrome.storage.local.get('obr_lifetime', (d) => res((d.obr_lifetime || {}).articles || 0))))).toBe(0);
    await page.evaluate(() => OBR.clearPick(OBR.normalizeHost(location.href))); // clean up for later tests
  });
});

test.describe('engagement ask policy', () => {
  test('_shouldAskEngage: regulars only, capped, spaced, one channel at a time', async ({ page }) => {
    const r = await page.evaluate(() => {
      const now = Date.now();
      const P = OBR._shouldAskEngage;
      const DAY = 24 * 3600 * 1000;
      return {
        fresh: P({ opens: 1, days: 1 }, {}, now),
        regular: P({ opens: 5, days: 2 }, {}, now),
        oneBusyDay: P({ opens: 9, days: 1 }, {}, now),
        done: P({ opens: 9, days: 5 }, { done: true }, now),
        colophonUser: P({ opens: 9, days: 5 }, { colSeen: 1 }, now),
        capped: P({ opens: 9, days: 5 }, { asks: 2 }, now),
        tooSoon: P({ opens: 9, days: 5 }, { asks: 1, lastAsk: now - DAY }, now),
        spaced: P({ opens: 9, days: 5 }, { asks: 1, lastAsk: now - 91 * DAY }, now),
      };
    });
    expect(r).toEqual({
      fresh: false, regular: true, oneBusyDay: false, done: false,
      colophonUser: false, capped: false, tooSoon: false, spaced: true,
    });
  });

  test('the chip appears on a user close for an established profile, and the ask is recorded', async ({ page }) => {
    await resetEngagement(page);
    await page.evaluate(() => new Promise((res) =>
      chrome.storage.local.set({ obr_usage: { opens: 6, days: 3, lastDay: '2020-01-01' } }, res)));
    await openReader(page);
    await page.evaluate(() => OBR.close()); // user-initiated close = the one ask moment
    await expect.poll(() => page.evaluate(() => {
      const h = document.getElementById('obr-engage-chip-host');
      return h ? (h.shadowRoot.querySelector('.msg')?.textContent || '') : '';
    })).toContain('Enjoying');
    // Recorded BEFORE showing — an ignored ask still counts toward the lifetime cap.
    const engage = await page.evaluate(() => new Promise((res) =>
      chrome.storage.sync.get('obr_engage', (d) => res(d.obr_engage || {}))));
    expect(engage.asks).toBe(1);
    expect(engage.lastAsk).toBeGreaterThan(0);
  });

  test('a mode switch is not a dismissal — no chip on suppress:false closes', async ({ page }) => {
    await resetEngagement(page);
    await page.evaluate(() => new Promise((res) =>
      chrome.storage.local.set({ obr_usage: { opens: 6, days: 3, lastDay: '2020-01-01' } }, res)));
    await openReader(page);
    await page.evaluate(() => OBR.close({ suppress: false })); // internal close path
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => !!document.getElementById('obr-engage-chip-host'))).toBe(false);
  });
});
