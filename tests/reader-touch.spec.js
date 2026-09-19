/* The reader on a phone: single-column layout, tap-to-turn, and the toolbar.
 *
 * This is the first spec in the repo to run BELOW settings.singlePageBelow (720), so it is the
 * only coverage of the one-column path a phone actually gets. It is also the only spec with
 * hasTouch, which is what makes page.touchscreen.tap() emit real touch events instead of mouse
 * ones -- the distinction the three fixes here turn on.
 *
 * Reported by a user on Vivaldi/Android: the middle of the screen did nothing, so the reader
 * looked stuck on its first page.
 */

import { test, expect } from './fixtures.js';
import { gotoArticle, injectReader, openReader, readState } from './helpers.js';

// 412x915 is a common Android CSS viewport and is comfortably under singlePageBelow.
test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });

const W = 412, MID_Y = 450;
const LEFT_X = Math.round(W * 0.1), CENTRE_X = Math.round(W * 0.5), RIGHT_X = Math.round(W * 0.9);

const diag = (page) => page.evaluate(() => globalThis.OBR._diagReader());

/** Wait out the touch auto-hide (CHROME_HIDE_TOUCH_MS = 5000) and confirm it actually hid. */
async function waitForChromeHidden(page) {
  await expect.poll(() => diag(page).then((d) => d.chromeHidden), { timeout: 12_000 }).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await gotoArticle(page);
  await injectReader(page);
  await openReader(page);
});

test('a phone viewport renders one page per spread', async ({ page }) => {
  const d = await diag(page);
  expect(d.perSpread).toBe(1);

  // The spine is the centre gutter between two facing pages; it is hidden on an odd split.
  const spineShown = await page.evaluate(() => {
    const spine = document.getElementById('obr-host').shadowRoot.querySelector('.obr-spine');
    return getComputedStyle(spine).display !== 'none';
  });
  expect(spineShown).toBe(false);
});

test('tapping the right edge turns the page forward and the left edge turns it back', async ({ page }) => {
  const start = await readState(page);

  await page.touchscreen.tap(RIGHT_X, MID_Y);
  const forward = await readState(page);
  expect(forward.translateX).toBeLessThan(start.translateX);

  await page.touchscreen.tap(LEFT_X, MID_Y);
  const back = await readState(page);
  expect(back.translateX).toBe(start.translateX);
});

test('a tap latches touch mode, which swaps the footer hint to the gesture map', async ({ page }) => {
  await page.touchscreen.tap(CENTRE_X, MID_Y);

  expect((await diag(page)).touch).toBe(true);
  const hint = await page.evaluate(
    () => document.getElementById('obr-host').shadowRoot.querySelector('.obr-hint').textContent
  );
  // The keyboard hint is dead weight on a phone; the touch one names the two tap zones.
  expect(hint).toContain('Edges turn pages');
  expect(hint).not.toContain('Esc exit');
});

test('a centre tap SHOWS the auto-hidden toolbar', async ({ page }) => {
  // Regression guard for the compatibility-mouse-event ordering bug. A tap emits a synthesized
  // mousemove BEFORE the click; if the mousemove reveal were not gated on !touchMode it would
  // show the chrome first, so the click's toggle could only ever find it visible and hide it --
  // and the centre tap would look as dead as the band it replaced.
  await page.touchscreen.tap(CENTRE_X, MID_Y); // latch touch mode
  await waitForChromeHidden(page);

  await page.touchscreen.tap(CENTRE_X, MID_Y);
  expect((await diag(page)).chromeHidden).toBe(false);
});

test('a centre tap does not turn the page', async ({ page }) => {
  const start = await readState(page);
  await page.touchscreen.tap(CENTRE_X, MID_Y);
  expect((await readState(page)).translateX).toBe(start.translateX);
});

test('a second centre tap hides the toolbar immediately, not on the timer', async ({ page }) => {
  await page.touchscreen.tap(CENTRE_X, MID_Y);
  await waitForChromeHidden(page);
  await page.touchscreen.tap(CENTRE_X, MID_Y);
  expect((await diag(page)).chromeHidden).toBe(false);

  await page.touchscreen.tap(CENTRE_X, MID_Y);
  // No poll: hideChrome() clears the timer and adds the class synchronously.
  expect((await diag(page)).chromeHidden).toBe(true);
});

test('the toolbar still auto-hides after a toolbar button is tapped', async ({ page }) => {
  // The reported defect: mouseenter latched overControls=true and mouseleave never fired on
  // touch, so the chrome stayed up for the rest of the session. Against the unfixed code the
  // hide timer is never even scheduled and this poll runs out.
  // Settle to a known state first: open() shows the chrome on a timer, so whether it is still up
  // when the body starts is a race. Hide, then reveal deliberately.
  await page.touchscreen.tap(CENTRE_X, MID_Y); // latch touch mode
  await waitForChromeHidden(page);
  await page.touchscreen.tap(CENTRE_X, MID_Y); // reveal
  expect((await diag(page)).chromeHidden).toBe(false);

  const before = (await readState(page)).fontSize;
  await page.locator('#obr-host >> .obr-btn[data-act="font+"]').tap();
  expect((await readState(page)).fontSize).toBeGreaterThan(before); // the tap really landed

  await waitForChromeHidden(page);
});

test('a hybrid device that hovers the toolbar and then taps still auto-hides', async ({ page }) => {
  // The regression the gating itself introduced. mouseenter latches overControls while on mouse;
  // the matching mouseleave is gated off once touch latches, so without setTouchMode() clearing
  // it the chrome is pinned over the text for the rest of the page's life.
  // Drive it from the mouse side first, so touchMode is genuinely false when mouseenter fires.
  await page.mouse.move(CENTRE_X, MID_Y);
  expect((await diag(page)).touch).toBe(false);

  const bar = page.locator('#obr-host >> .obr-topbar');
  await bar.hover();                                   // overControls = true, hide timer cleared
  expect((await diag(page)).chromeHidden).toBe(false);

  // Latch touch with an EDGE tap, not a centre one. A centre tap would call toggleChrome(),
  // which hides the chrome directly and bypasses overControls entirely -- masking the very
  // latch this test exists to catch (verified: with a centre tap the test passes even with
  // the release removed). An edge tap turns a page and leaves the chrome alone.
  await page.touchscreen.tap(RIGHT_X, MID_Y);
  expect((await diag(page)).touch).toBe(true);
  await page.mouse.move(LEFT_X, MID_Y);                // the mouseleave that no longer clears it

  await waitForChromeHidden(page);
});

test('a drag-selection still suppresses the page turn on touch', async ({ page }) => {
  await page.touchscreen.tap(CENTRE_X, MID_Y); // latch touch mode first

  // A native touchscreen.tap collapses the selection at pointerdown, before the click -- so it
  // cannot express "click while a selection is live". Mirror reader.spec.js's technique and
  // dispatch the click alone, with no preceding pointerdown.
  const start = await readState(page);
  await page.evaluate((x) => {
    const root = document.getElementById('obr-host').shadowRoot;
    const p = root.querySelector('.obr-content p');
    const sel = root.getSelection ? root.getSelection() : getSelection();
    const range = document.createRange();
    range.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: 450 }));
  }, RIGHT_X);

  expect((await readState(page)).translateX).toBe(start.translateX);
});
