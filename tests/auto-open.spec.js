/* Auto-open sentinel + engine integration tests, in real Chromium.
 *
 * The harness injects settings.js + sentinel.js the same way the SW's registered
 * content script would load them (and seeds rules through the storage shim), because
 * headless Playwright can't drive a real registerContentScripts round-trip or a
 * permission prompt. Everything past injection is the production ladder, unmodified.
 * The SW-side slices (registration sync, the obr-auto-open handler) are covered by the
 * manual checklist in docs/auto-open-spec.md §10.
 */

import { test, expect } from './fixtures.js';
import {
  gotoFixture, seedSettings, injectSentinel, waitSentinelDone,
  injectAll, sentMessages, clickInReader,
} from './helpers.js';

const AUTO_TEXT = { siteRules: [{ match: 'localhost', mode: 'text', auto: true }] };
const AUTO_IMAGES = { siteRules: [{ match: 'localhost', mode: 'images', auto: true }] };
const AUTO_AUTO = { siteRules: [{ match: 'localhost', mode: 'auto', auto: true }] };

const autoOpenMessages = async (page) =>
  (await sentMessages(page)).filter((m) => m && m.type === 'obr-auto-open');

/* ------------------------------------------------------------- content gate */

test('auto-opens a forum topic page (prose + anchor block pass)', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('opened');
  expect(s.mode).toBe('text');
  expect(await autoOpenMessages(page)).toEqual([{ type: 'obr-auto-open', mode: 'text' }]);
});

test('a forum index of long topic titles never opens (the anchor-block gate)', async ({ page }) => {
  // 12 rows × ~22 words each pass a naive 200-word total, but no block reaches 80.
  await gotoFixture(page, 'forum-list.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).not.toBe('opened');
  expect(s.probesDone).toBe(4); // every probe ran and the gate held each time
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('a matching rule WITHOUT auto:true does nothing, ever', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html'); // a page that would pass the gate
  await seedSettings(page, { siteRules: [{ match: 'localhost', mode: 'text' }] });
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('no-rule');
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('a path-scoped auto rule fires on its path and nowhere else', async ({ page }) => {
  const rules = {
    siteRules: [
      { match: 'localhost', mode: 'text' }, // whole-site rule, NOT auto
      { match: 'localhost/forum-*', mode: 'text', auto: true },
    ],
  };
  await gotoFixture(page, 'forum-topic.html'); // /forum-topic.html — inside the path rule
  await seedSettings(page, rules);
  await injectSentinel(page);
  expect((await waitSentinelDone(page)).outcome).toBe('opened');

  await gotoFixture(page, 'article.html'); // outside it — most-specific match has no auto
  await seedSettings(page, rules);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('no-rule');
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('an images rule opens a lazy manga chapter with nothing decoded yet', async ({ page }) => {
  // All 12 pages are src-less data-src placeholders: naturalWidth is 0 everywhere, but
  // the laid-out boxes + lazy evidence must satisfy the image gate.
  await gotoFixture(page, 'manga-lazy.html');
  await seedSettings(page, AUTO_IMAGES);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('opened');
  expect(s.mode).toBe('images');
  expect(await autoOpenMessages(page)).toEqual([{ type: 'obr-auto-open', mode: 'images' }]);
});

test('an auto-mode rule resolves text-first (an article always wins)', async ({ page }) => {
  // Make BOTH gates pass on one page: the forum topic already clears the text gate;
  // add a lazy image set that would clear the image gate on its own.
  await gotoFixture(page, 'forum-topic.html');
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) {
      const img = document.createElement('img');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('data-src', '/pic.png?i=' + i);
      img.width = 360; img.height = 480;
      document.body.appendChild(img);
    }
  });
  await seedSettings(page, AUTO_AUTO);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('opened');
  expect(s.mode).toBe('text'); // prose wins over a passing image gate
});

/* ------------------------------------------------------------- metadata veto */

test('a declared CollectionPage vetoes a gate-passing index (pinned-announcement hole)', async ({ page }) => {
  await gotoFixture(page, 'meta-collection-pinned.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('vetoed');
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('carousel Articles nested under itemListElement do NOT suspend the veto', async ({ page }) => {
  await gotoFixture(page, 'meta-carousel-list.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('vetoed');
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('og:type=article plays no role — the list veto holds', async ({ page }) => {
  await gotoFixture(page, 'meta-og-sloppy.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('vetoed');
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('NewsArticle + BreadcrumbList MUST open (exact-@type matching, @graph, arrays)', async ({ page }) => {
  await gotoFixture(page, 'meta-news-breadcrumb.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('opened');
  expect(s.mode).toBe('text');
});

test('a short post declaring DiscussionForumPosting stays closed — claims never lower the bar', async ({ page }) => {
  await gotoFixture(page, 'meta-short-post.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).not.toBe('opened');
  expect(await autoOpenMessages(page)).toEqual([]);
});

/* --------------------------------------------------- suppression + SPA re-arm */

test('suppression is per exact page (query included) and survives SPA navigation back', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  expect((await waitSentinelDone(page, 1)).outcome).toBe('opened');

  // The user dismisses reading mode here (what a user-initiated close() records), then
  // SPA-navigates to ANOTHER topic on the same pathname — phpBB-style ?t= routing. The
  // sentinel re-arms off the URL compare (pushState is invisible to the isolated world;
  // the DOM mutation is what trips the observer) and must open again: one Esc must not
  // silence the whole forum.
  await page.evaluate(() => {
    OBR._autoSuppress();
    history.pushState({}, '', '/forum-topic.html?t=2');
    document.body.appendChild(document.createElement('div'));
  });
  expect((await waitSentinelDone(page, 2)).outcome).toBe('opened');
  expect(await autoOpenMessages(page)).toHaveLength(2);

  // SPA back to the DISMISSED page: suppressed for the rest of the page session.
  await page.evaluate(() => {
    history.pushState({}, '', '/forum-topic.html');
    document.body.appendChild(document.createElement('div'));
  });
  const s = await waitSentinelDone(page, 3);
  expect(s.outcome).toBe('suppressed');
  expect(await autoOpenMessages(page)).toHaveLength(2); // no third open
});

test('a hash-only change does NOT re-arm the sentinel (settle window survives a scroll-spy)', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page);
  const s1 = await waitSentinelDone(page, 1);
  expect(s1.outcome).toBe('opened');
  const armsBefore = s1.armCount;

  // A scroll-spy / in-page anchor rewriting only location.hash must not re-arm (the
  // re-arm key is origin+pathname+search, hash excluded) — otherwise a hash-churning page
  // would perpetually reset the 0–5s window and never open.
  await page.evaluate(() => { location.hash = '#section-2'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => OBR._sentinelState.armCount)).toBe(armsBefore);
});

test('an already-open overlay stops the ladder (never yank a live overlay)', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html');
  await seedSettings(page, AUTO_TEXT);
  await injectAll(page); // the user is already reading (manual open)
  await page.evaluate(() => OBR.open());
  await expect.poll(() => page.evaluate(() => {
    const h = document.getElementById('obr-host');
    return !!h && getComputedStyle(h).display !== 'none';
  })).toBe(true);

  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('overlay-open');
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('a hidden tab defers probing until it becomes visible', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html');
  await seedSettings(page, AUTO_TEXT);

  // A genuinely backgrounded tab isn't drivable in headless=new (bringToFront doesn't
  // occlude the other page), so shadow document.hidden and hand-fire visibilitychange —
  // exactly the two signals the sentinel consumes. The real-tab behavior rides the
  // manual checklist (docs/auto-open-spec.md §10).
  await page.evaluate(() => {
    window.__obrHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__obrHidden });
  });
  await injectSentinel(page);
  await page.waitForTimeout(500); // the whole fast schedule would have elapsed by now
  expect(await page.evaluate(() => OBR._sentinelState.done)).toBe(false);
  expect(await page.evaluate(() => OBR._sentinelState.probesDone)).toBe(0); // zero probes behind the user's back

  await page.evaluate(() => {
    window.__obrHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const s = await waitSentinelDone(page);
  expect(s.outcome).toBe('opened');
});

/* -------------------------------------------------- enable-time confirmation */

test('the enable flow shows a confirmation chip when the enabling page does not qualify', async ({ page }) => {
  await gotoFixture(page, 'forum-list.html'); // the user enabled from a LIST page
  await seedSettings(page, AUTO_TEXT);
  await page.evaluate(() => { (globalThis.OBR = globalThis.OBR || {})._justEnabled = true; });
  await injectSentinel(page);
  const s = await waitSentinelDone(page);
  expect(s.outcome).not.toBe('opened');

  const chip = await page.evaluate(() => {
    const host = document.getElementById('obr-auto-chip-host');
    return host ? host.shadowRoot.textContent : null;
  });
  expect(chip).toContain('Auto-open is on for localhost'); // wrongly opening would be the exact false positive the ladder prevents
  expect(await autoOpenMessages(page)).toEqual([]);
});

test('an ordinary (registered) load never shows the confirmation chip', async ({ page }) => {
  await gotoFixture(page, 'forum-list.html');
  await seedSettings(page, AUTO_TEXT);
  await injectSentinel(page); // no _justEnabled flag
  await waitSentinelDone(page);
  expect(await page.evaluate(() => !!document.getElementById('obr-auto-chip-host'))).toBe(false);
});

/* ------------------------------------------------------- engine integration */

test('open({trigger:"auto"}) shows the auto chip; a manual open does not', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html');
  await injectAll(page);
  await page.evaluate(() => OBR.open({ trigger: 'auto' }));
  await expect.poll(() => page.evaluate(() => {
    const h = document.getElementById('obr-auto-chip-host');
    return h ? h.shadowRoot.textContent : '';
  })).toContain('Opened automatically');

  // Reset: close + drop the chip, then a MANUAL open must stay chip-free.
  await page.evaluate(() => {
    OBR.close();
    const h = document.getElementById('obr-auto-chip-host');
    if (h) h.remove();
  });
  await page.evaluate(() => OBR.open());
  await expect.poll(() => page.evaluate(() => OBR._opensCompleted || 0)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => !!document.getElementById('obr-auto-chip-host'))).toBe(false);
});

test('the chip Stop button clears ONLY the auto flag — the mode rule survives', async ({ page }) => {
  await gotoFixture(page, 'forum-topic.html');
  await seedSettings(page, { siteRules: [{ match: 'localhost', mode: 'text', auto: true }] });
  await injectAll(page);
  await page.evaluate(() => OBR.open({ trigger: 'auto' }));
  await expect.poll(() => page.evaluate(() => !!document.getElementById('obr-auto-chip-host'))).toBe(true);

  await page.evaluate(() => {
    document.getElementById('obr-auto-chip-host').shadowRoot.querySelector('.stop').click();
  });
  await expect
    .poll(() => page.evaluate(() => new Promise((res) =>
      chrome.storage.sync.get('obr_settings', (d) => res((d.obr_settings || {}).siteRules)))))
    .toEqual([{ match: 'localhost', mode: 'text' }]); // auto gone, mode kept
});

test('Esc records suppression; the in-overlay mode switch and cross-close do not', async ({ page }) => {
  await gotoFixture(page, 'illustrated-article.html'); // enough images for the gallery
  await injectAll(page);

  // Mode switch reader → gallery: the user is still reading, nothing may be recorded.
  await page.evaluate(() => OBR.open());
  await expect.poll(() => page.evaluate(() => OBR._opensCompleted || 0)).toBe(1);
  await clickInReader(page, '[data-act="images"]'); // close({suppress:false}) + openGallery()
  await expect.poll(() => page.evaluate(() => {
    const h = document.getElementById('obr-gallery-host');
    return !!h && getComputedStyle(h).display !== 'none';
  })).toBe(true);
  expect(await page.evaluate(() => Array.from(OBR._autoSuppressed || []))).toEqual([]);

  // Esc on the gallery IS a user dismissal: the page key must be recorded.
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => Array.from(OBR._autoSuppressed || []))).toEqual([
    await page.evaluate(() => location.origin + location.pathname + location.search),
  ]);
});

/* --------------------------------------------------------- pure helper units */

test('originsForRule maps rule globs to host-scoped origin patterns', async ({ page }) => {
  await gotoFixture(page, 'article.html');
  await injectSentinel(page);
  const r = await page.evaluate(() => ({
    site: OBR.originsForRule('example.com'),
    www: OBR.originsForRule('www.example.com'),          // www-stripped, same grant
    path: OBR.originsForRule('example.com/t/*'),          // path enforced by the rule, not the grant
    wildcard: OBR.originsForRule('*.example.com/*'),
    midHost: OBR.originsForRule('ex*mple.com'),           // not expressible as a match pattern
    bad: OBR.originsForRule(''),
  }));
  expect(r.site).toEqual(['*://example.com/*', '*://www.example.com/*']);
  expect(r.www).toEqual(['*://example.com/*', '*://www.example.com/*']);
  expect(r.path).toEqual(['*://example.com/*', '*://www.example.com/*']);
  expect(r.wildcard).toEqual(['*://*.example.com/*']);
  expect(r.midHost).toEqual([]); // load-bearing: one invalid pattern rejects a whole registration
  expect(r.bad).toEqual([]);
});

test('matchSiteRuleEx returns the winning rule object; matchSiteRule stays its mode wrapper', async ({ page }) => {
  await gotoFixture(page, 'article.html');
  await injectSentinel(page);
  const r = await page.evaluate(() => {
    const rules = [
      { match: 'example.com', mode: 'text' },
      { match: 'example.com/t/*', mode: 'images', auto: true },
    ];
    return {
      specific: OBR.matchSiteRuleEx('https://example.com/t/42', rules),
      whole: OBR.matchSiteRuleEx('https://example.com/about', rules),
      modeOnly: OBR.matchSiteRule('https://example.com/t/42', rules),
      none: OBR.matchSiteRuleEx('https://other.org/', rules),
    };
  });
  expect(r.specific).toEqual({ match: 'example.com/t/*', mode: 'images', auto: true });
  expect(r.whole).toEqual({ match: 'example.com', mode: 'text' });
  expect(r.modeOnly).toBe('images');
  expect(r.none).toBe(null);
});

test('upsertSiteRule sets/preserves the auto flag; setRuleAuto flips only its target', async ({ page }) => {
  await gotoFixture(page, 'article.html');
  await injectSentinel(page);
  const r = await page.evaluate(() => {
    const a = OBR.upsertSiteRule({ siteRules: [] }, 'example.com', 'text', { auto: true }).siteRules;
    // Re-upserting WITHOUT opts must preserve the existing flag (mode change keeps auto)...
    const b = OBR.upsertSiteRule({ siteRules: a.map((x) => ({ ...x })) }, 'example.com', 'images').siteRules;
    // ...and opts.auto:false must clear it.
    const c = OBR.upsertSiteRule({ siteRules: b.map((x) => ({ ...x })) }, 'example.com', 'images', { auto: false }).siteRules;
    const d = OBR.setRuleAuto(
      [{ match: 'a.com', mode: 'text', auto: true }, { match: 'b.com', mode: 'text', auto: true }],
      'a.com', false
    );
    return { a, b, c, d };
  });
  expect(r.a).toEqual([{ match: 'example.com', mode: 'text', auto: true }]);
  expect(r.b).toEqual([{ match: 'example.com', mode: 'images', auto: true }]);
  expect(r.c).toEqual([{ match: 'example.com', mode: 'images' }]);
  expect(r.d).toEqual([{ match: 'a.com', mode: 'text' }, { match: 'b.com', mode: 'text', auto: true }]);
});

test('_proseStats measures both signals the text gate needs (words + anchor block)', async ({ page }) => {
  await gotoFixture(page, 'forum-list.html');
  await injectSentinel(page);
  const list = await page.evaluate(() => OBR._proseStats());
  expect(list.words).toBeGreaterThanOrEqual(200); // a naive total-words gate WOULD pass here…
  expect(list.maxBlock).toBeLessThan(80);         // …which is exactly why the anchor block exists

  await gotoFixture(page, 'forum-topic.html');
  await injectSentinel(page);
  const topic = await page.evaluate(() => OBR._proseStats());
  expect(topic.words).toBeGreaterThanOrEqual(200);
  expect(topic.maxBlock).toBeGreaterThanOrEqual(80);
});
