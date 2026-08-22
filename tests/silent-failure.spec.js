/* Reproduction lab for "I pressed the shortcut and the page never turned into read view".
 *
 * The two states background.js now badges (`blocked`, `reload`) both happen BEFORE the engine
 * runs. This file covers the other half: the trigger lands, the engine runs, and the user still
 * sees nothing — the class a page reload cannot fix, because the cause is the page itself.
 *
 * Each test drives tests/fixtures/hostile-page.html?mode=… — a normal article carrying exactly
 * ONE trait real sites have — and records what a USER would see. The load-bearing observation is
 * `topmostId`: elementFromPoint at the middle of the viewport, i.e. what is actually painted.
 * Asserting only "the overlay is in the DOM and display isn't none" is what lets a covered
 * overlay pass as working.
 *
 * These assertions describe CURRENT behaviour, including where it is wrong. A test here going
 * red because a failure was fixed is the intended signal — update it, don't route around it.
 */

import { test, expect } from './fixtures.js';
import { gotoFixture, injectReader, ALL_FILES } from './helpers.js';

/** What the user sees after a trigger — painted reality, not DOM presence. */
function observe(page) {
  return page.evaluate(() => {
    const O = globalThis.OBR;
    const host = document.getElementById('obr-host');
    const gal = document.getElementById('obr-gallery-host');
    const shown = (h) => !!h && getComputedStyle(h).display !== 'none';
    const top = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    const idOf = (el) => (el ? (el.id || el.tagName.toLowerCase()) : null);
    return {
      readerAttached: !!host,
      readerShown: shown(host),
      galleryShown: shown(gal),
      topmostId: idOf(top),                       // what is painted mid-viewport
      scrollLocked: document.documentElement.style.overflow === 'hidden',
      body: host && host.shadowRoot
        ? (host.shadowRoot.querySelector('.obr-content')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140)
        : '',
      // The recovery affordance: the "Wrong content? ⌖ Pick the block" bar, shown only when
      // the whole-page parse reads as suspect. Its ABSENCE on a bad parse is the finding.
      pickHint: host && host.shadowRoot
        ? (host.shadowRoot.querySelector('.obr-pick-msg')?.textContent || '')
        : '',
      diag: O && O._diagReader ? O._diagReader() : null,
    };
  });
}

/** The page-level banner's text ('' when no banner is up). Its host is a sibling of <body>. */
const noticeText = (page) => page.evaluate(() => {
  const h = document.getElementById('obr-notice');
  return h && h.shadowRoot ? (h.shadowRoot.querySelector('.msg')?.textContent || '') : '';
});

const openText = async (page) => {
  await page.evaluate(() => globalThis.OBR.toggle());
  await expect.poll(() => page.evaluate(() => !!globalThis.OBR._diagReader().active)).toBe(true);
};

test('control: on the plain article the reader opens AND is the thing on screen', async ({ page }) => {
  await gotoFixture(page, 'hostile-page.html');
  await injectReader(page);
  await openText(page);
  const o = await observe(page);
  // The positive landmark every other test in this file is measured against: without it, a
  // harness that silently renders nothing would make each failure below look reproduced.
  expect(o.readerShown).toBe(true);
  expect(o.topmostId).toBe('obr-host');
  expect(o.body).toContain('unhurried act');
});

test('z-fight: a site layer already at the max z-index no longer buries the reader', async ({ page }) => {
  await gotoFixture(page, 'hostile-page.html?mode=zfight');
  await injectReader(page);
  await openText(page);
  const o = await observe(page);
  // The overlay now takes the maximum z-index too, and its host is appended when the reader
  // opens — later in the document than the page's own furniture, so it wins the tie.
  expect(o.topmostId).toBe('obr-host');
  expect(o.body).toContain('unhurried act');
  await page.waitForTimeout(600); // let the paint check run: it must find nothing to report
  expect(await page.evaluate(() => globalThis.OBR._paintCheck)).toEqual({ state: 'ok', by: '' });
  expect(await noticeText(page)).toBe(''); // …and stay silent on a working page
});

test('z-fight, late widget: the one ordering z-index cannot win is DETECTED and reported', async ({ page }) => {
  await gotoFixture(page, 'hostile-page.html?mode=zlate');
  await injectReader(page);
  await openText(page);
  // The widget is inserted after our host exists, so it is later in the document at the same
  // z-index and legitimately wins. Nothing in `active` can see this — only the paint check.
  await expect.poll(() => page.evaluate(() => globalThis.OBR._paintCheck)).toEqual({
    state: 'covered', by: 'div#late-chat-widget z=2147483647',
  });
  // The user is told, in the page, with a way out — the badge would be invisible to anyone
  // who has not pinned the icon, and the reader's own ⚠ Report button is under the widget.
  expect(await noticeText(page)).toContain('covering it');
  // The verdict rides along in a report, so "it doesn't work here" arrives naming the element.
  const meta = await page.evaluate(() => globalThis.OBR._buildReportMeta({ source: 'test' }));
  expect(meta.failure).toEqual({ state: 'covered', by: 'div#late-chat-widget z=2147483647' });
});

test('wipe: a re-render of <html> deletes the reader host — and it puts itself back', async ({ page }) => {
  await gotoFixture(page, 'hostile-page.html?mode=wipe');
  await injectReader(page);
  await openText(page);
  expect((await observe(page)).topmostId).toBe('obr-host'); // it did open, first
  // The page rebuilds its own DOM at 1200ms and takes our host with it. The removal watcher
  // sees the childList mutation on <html> and re-attaches — the shadow root, the paginated
  // content and the reading position all live on in the retained host reference, so this is a
  // real recovery rather than a re-open. (Once only; a page that wipes on a schedule would
  // otherwise turn into an endless duel — the second removal reports instead.)
  await expect.poll(() => page.evaluate(() => document.body.textContent.includes('unhurried act')
    && !!document.getElementById('obr-host')), { timeout: 5000 }).toBe(true);
  const o = await observe(page);
  expect(o.readerAttached).toBe(true);
  expect(o.topmostId).toBe('obr-host');   // still the thing on screen, after the page wiped it
  expect(o.body).toContain('unhurried act'); // and still showing the article, not a fresh open
});

test('iframe: the reader opens on the page chrome — visible, but wrong and unflagged', async ({ page }) => {
  await gotoFixture(page, 'hostile-page.html?mode=iframe');
  await injectReader(page);
  await openText(page);
  const o = await observe(page);
  // Visible — so this is NOT the silent class. But it is not the good path either: Readability
  // finds just enough page furniture (title, byline, nav) to count as an article…
  expect(o.topmostId).toBe('obr-host');
  expect(o.body).not.toContain('unhurried act'); // the real text is in the frame, out of reach
  expect(o.body).toContain('Home · Essays · About'); // …what the reader shows instead: the nav
  // …and because it "succeeded", the Wrong content? / ⌖ Pick recovery bar never appears. The
  // user gets a reader full of junk and no offered way out. This is the finding, and it is still
  // open: the fix belongs in EXTRACTION (descend into the same-origin content frame), not in the
  // "should I nag?" predicate — widening that flags every genuinely short page instead.
  expect(o.pickHint).toBe('');
});

test('the banner replaces rather than stacks, and its Report carries the verdict', async ({ page }) => {
  // notice.js is the surface all of the above fall back to, and the worker injects it ALONE into
  // pages whose engine is a corpse — so exercise it on its own terms, not through the reader.
  await gotoFixture(page, 'hostile-page.html');
  await injectReader(page);
  const drawn = await page.evaluate(() => {
    const O = globalThis.OBR;
    O._notice({ text: 'first', actions: [{ label: 'Dismiss', act: 'dismiss' }] });
    O._notice({ text: 'second', actions: [{ label: 'Report', act: 'report' }, { label: 'Dismiss', act: 'dismiss' }] });
    return document.querySelectorAll('#obr-notice').length; // a repeated trigger must not pile up
  });
  expect(drawn).toBe(1);
  expect(await noticeText(page)).toBe('second');

  // Report relays to the worker (captured by the harness's message shim) with the paint verdict
  // attached — that payload is what makes a report actionable without a reproduction.
  await page.evaluate(() => { globalThis.OBR._paintCheck = { state: 'covered', by: 'div#x z=2147483647' }; });
  await page.locator('#obr-notice >> text=Report').click();
  const sent = await page.evaluate(() => window.__obrMsgs.filter((m) => m.type === 'obr-open-report'));
  expect(sent).toHaveLength(1);
  expect(sent[0].meta.failure).toEqual({ state: 'covered', by: 'div#x z=2147483647' });
  expect(sent[0].meta.reportSource).toBe('notice');
  expect(await noticeText(page)).toBe(''); // acting on it closes it
});

test('image-heavy post: the toolbar icon opens the GALLERY, which reads as "no read view"', async ({ page }) => {
  await gotoFixture(page, 'hostile-page.html?mode=images');
  for (const f of ALL_FILES) await page.addScriptTag({ path: f }); // _autoToggle lives in gallery.js
  await page.waitForFunction(() => document.images.length >= 14
    && Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
  const picked = await page.evaluate(() => globalThis.OBR._autoToggle());
  expect(picked).toBe('images'); // the documented auto-pick, not a bug — but not read view either
  const o = await observe(page);
  expect(o.galleryShown).toBe(true);
  expect(o.readerShown).toBe(false);
  // Alt+B (the named-mode command) still reaches the reader — the escape hatch the user needs
  // to be told about, since the icon alone will never give them text on a page like this.
  await page.evaluate(() => globalThis.OBR.toggleGallery());
  await openText(page);
  expect((await observe(page)).topmostId).toBe('obr-host');
});
