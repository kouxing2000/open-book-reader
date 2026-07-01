/* Feature integration tests for the image-gallery mode, in real Chromium.
 * The harness injects settings.js + gallery.js (mirroring background.js), then
 * drives the unmodified gallery against an image-heavy fixture page. */

import { test, expect } from './fixtures.js';
import {
  gotoImages, injectGallery, openGallery, galleryState, clickInGallery, sentMessages,
  gotoArticle, injectAll, readState, clickInReader, gotoIllustratedArticle, gotoLazyImages,
  gotoGrowNoImages,
} from './helpers.js';

test.describe('image gallery', () => {
  test.beforeEach(async ({ page }) => {
    await gotoImages(page);
    await injectGallery(page);
  });

  test('collects page images and filters out tiny ones', async ({ page }) => {
    await openGallery(page);
    const s = await galleryState(page);
    // fixture: 5 large <img> + 1 background-image kept; 2 tiny (<80px) filtered.
    expect(s.tiles).toBe(6);
    expect(s.count).toBe('6 images');
  });

  // Perf split (REFACTOR-PLAN 1.2): the costly getComputedStyle('*') background-image scan
  // runs only on initial render and at the end of a full "Load all" — NOT on the per-step
  // progressive merges. So a CSS background-image that appears AFTER open is folded in by
  // "Load all" (_galleryRescan), not by a progressive chunk (_galleryLoadMore). This pins
  // both halves: that the cheap path skips it, and that the Load-all fold-in still catches it.
  test('a CSS background-image added after open is folded in by "Load all", not a progressive chunk', async ({ page }) => {
    // Auto-load OFF so open()'s maybePreload doesn't leave a hydration sweep in flight that
    // would make the explicit _galleryLoadMore/_galleryRescan hooks below no-op (sweeping guard).
    await page.evaluate(() => globalThis.OBR.saveSettings({ galleryAutoLoad: false }));
    await openGallery(page);
    const before = (await galleryState(page)).tiles; // 6, incl. the fixture's 1 background

    // Mount a NEW element carrying a valid (loadable) CSS background-image. A bare <div> is
    // not an <img>, so the MutationObserver's containsImg() never auto-merges it — it can only
    // enter the gallery via a full background scan. A data:image/png URL keeps it deterministic
    // (loads instantly, no network) and isn't dropped by the gif/svg data-URI filter.
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 200;
      const x = c.getContext('2d'); x.fillStyle = '#33aa77'; x.fillRect(0, 0, 200, 200);
      const d = document.createElement('div');
      d.style.width = '200px';
      d.style.height = '200px';
      d.style.backgroundImage = "url('" + c.toDataURL('image/png') + "')"; // quoted (data URL has commas)
      document.body.appendChild(d);
    });

    // Progressive chunk = cheap <img>/<picture> walk → the new background is NOT collected.
    // (images.html is static, so a chunk mounts no real <img> either: the count holds.)
    await page.evaluate(() => globalThis.OBR._galleryLoadMore());
    expect((await galleryState(page)).tiles).toBe(before);

    // "Load all" runs the full background scan at the end and folds the new background in.
    await page.evaluate(() => globalThis.OBR._galleryRescan());
    await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBe(before + 1);
  });

  test('a <picture> with multiple <source>s counts as one image, not one per source', async ({ page }) => {
    // Same photo expressed as a loaded <img> + 2 <source> variants (avif/webp). The <img>
    // represents the picture; its <source> siblings must NOT each become their own tile.
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#0a7'; ctx.fillRect(0, 0, 160, 120);
      const pic = document.createElement('picture');
      // unsupported types so the browser falls back to the <img>'s data-URL (and doesn't
      // try to load the bogus source URLs); the engine still sees the <img> as loaded.
      pic.innerHTML = '<source type="image/x-nope" srcset="hero.avif"><source type="image/x-nope" srcset="hero.webp">';
      const img = document.createElement('img');
      img.width = 160; img.height = 120; img.src = c.toDataURL('image/png');
      pic.appendChild(img);
      document.body.appendChild(pic);
      window.__picImg = img;
    });
    await page.waitForFunction(() => window.__picImg?.complete && window.__picImg.naturalWidth > 0);

    // _imageCount sees the 5 large fixture <img> (skips the CSS background) + the
    // <picture>'s ONE <img> = 6. If the 2 <source>s were counted it would read 8.
    expect(await page.evaluate(() => globalThis.OBR._imageCount())).toBe(6);
    // collect() (the gallery) adds the CSS background too: 6 fixture + the <picture> = 7
    // tiles. The 2 <source>s add nothing.
    await openGallery(page);
    expect((await galleryState(page)).tiles).toBe(7);
  });

  test('a <picture> whose <img> fallback is below the size filter still collects the larger <source>', async ({ page }) => {
    // The opposite edge of the dedup: a small placeholder <img> (40x40, under the 80px
    // filter) with a larger <source>. eachGalleryImg drops the tiny <img>, so the <source>
    // is the only usable URL and must NOT be skipped — otherwise the image vanishes.
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 40;
      c.getContext('2d').fillRect(0, 0, 40, 40);
      const pic = document.createElement('picture');
      // unsupported type => the browser keeps the small <img> fallback (doesn't fetch the source)
      pic.innerHTML = '<source type="image/x-nope" srcset="https://obr.test/big-source.jpg 800w">';
      const img = document.createElement('img');
      img.width = 40; img.height = 40; img.src = c.toDataURL('image/png');
      pic.appendChild(img);
      document.body.appendChild(pic);
      window.__tinyImg = img;
    });
    await page.waitForFunction(() => window.__tinyImg?.complete && window.__tinyImg.naturalWidth === 40);

    await openGallery(page);
    const hasSource = await page.evaluate(() =>
      [...document.getElementById('obr-gallery-host').shadowRoot.querySelectorAll('.tile img')]
        .some((im) => (im.getAttribute('src') || '').includes('big-source.jpg')));
    expect(hasSource).toBe(true); // the larger <source> survived; the picture isn't lost
  });

  test('lightbox uses the largest srcset variant while the grid keeps the thumbnail', async ({ page }) => {
    // A <picture> whose <img> displays a small data-URL thumbnail, with larger variants in
    // a <source srcset>. The grid tile should show the thumbnail; the lightbox should load
    // the largest variant (the same URL downloads would use).
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      c.getContext('2d').fillStyle = '#147'; c.getContext('2d').fillRect(0, 0, 160, 120);
      const pic = document.createElement('picture');
      // unsupported type => the browser keeps the small <img> as the displayed thumbnail
      pic.innerHTML = '<source type="image/x-nope" srcset="https://obr.test/small-200.jpg 200w, https://obr.test/huge-2000.jpg 2000w">';
      const img = document.createElement('img');
      img.width = 160; img.height = 120; img.src = c.toDataURL('image/png');
      pic.appendChild(img);
      document.body.appendChild(pic);
      window.__thumb = img.src;
    });
    await page.waitForFunction(() => { const i = document.querySelector('picture img'); return i && i.complete && i.naturalWidth > 0; });

    await openGallery(page);
    const idx = await page.evaluate(() => {
      const tiles = [...document.getElementById('obr-gallery-host').shadowRoot.querySelectorAll('.tile')];
      return tiles.findIndex((t) => t.getAttribute('href') === window.__thumb);
    });
    expect(idx).toBeGreaterThanOrEqual(0);

    await clickInGallery(page, `.tile >> nth=${idx}`); // opens the lightbox on our picture
    const lb = await page.evaluate(() => {
      const root = document.getElementById('obr-gallery-host').shadowRoot;
      const tile = [...root.querySelectorAll('.tile')].find((t) => t.getAttribute('href') === window.__thumb);
      return {
        lightboxSrc: root.querySelector('.lb-img').getAttribute('src'),
        tileThumbSrc: tile.querySelector('img').getAttribute('src'),
      };
    });
    expect(lb.lightboxSrc).toContain('huge-2000.jpg');  // lightbox = largest variant
    expect(lb.tileThumbSrc.startsWith('data:')).toBe(true); // grid = small displayed thumbnail
  });

  test('lays tiles out in masonry columns', async ({ page }) => {
    await openGallery(page);
    const s = await galleryState(page);
    expect(s.cols).toBeGreaterThan(1); // JS masonry: multiple flex columns at 1280px wide
    expect(s.tiles).toBe(6);           // all images distributed across them
  });

  test('toolbar labels stay on one line in a narrow window (no per-character wrap)', async ({ page }) => {
    // Regression: without white-space:nowrap the flex bar dumped all its shrink onto
    // the only shrinkable items (the text labels), collapsing "Images" / "Select all" /
    // "Size" to one character per line. They must stay single-line; the bar wraps instead.
    await page.setViewportSize({ width: 560, height: 800 });
    await openGallery(page);
    const r = await page.evaluate(() => {
      const root = document.getElementById('obr-gallery-host').shadowRoot;
      const m = (sel) => {
        const el = root.querySelector(sel);
        const cs = getComputedStyle(el);
        return { h: el.offsetHeight, line: parseFloat(cs.lineHeight) || 18, ws: cs.whiteSpace };
      };
      return { title: m('.title'), selall: m('.selall'), size: m('.bar label:not(.selall)') };
    });
    for (const part of [r.title, r.selall, r.size]) {
      expect(part.ws).toBe('nowrap');
      expect(part.h).toBeLessThan(part.line * 2); // one line tall, not a stacked column
    }
  });

  test('lightbox opens, navigates with arrows (wrapping), and Escape closes it', async ({ page }) => {
    await openGallery(page);

    await clickInGallery(page, '.tile >> nth=0');
    expect((await galleryState(page)).lbCounter).toBe('1 / 6');

    await page.keyboard.press('ArrowRight');
    expect((await galleryState(page)).lbCounter).toBe('2 / 6');

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft'); // 1 -> wrap to last
    expect((await galleryState(page)).lbCounter).toBe('6 / 6');

    await page.keyboard.press('Escape');
    expect((await galleryState(page)).lbOpen).toBe(false);
    expect((await galleryState(page)).hostDisplay).not.toBe('none'); // gallery still open
  });

  test('closing the lightbox carries the just-viewed image back onto the grid', async ({ page }) => {
    await openGallery(page);
    // Force the wall to overflow so there's a scroll position worth restoring.
    await page.evaluate(() => { document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll').style.maxHeight = '120px'; });

    // Open at the first image (grid parked at the top), then page to the LAST image.
    await clickInGallery(page, '.tile >> nth=0');
    const before = (await galleryState(page)).scrollTop;
    await page.keyboard.press('ArrowLeft'); // 1 -> wrap to the last image
    expect((await galleryState(page)).lbCounter).toBe('6 / 6');

    await page.keyboard.press('Escape');
    expect((await galleryState(page)).lbOpen).toBe(false);

    // Without the fix the grid stays where the lightbox opened (the top). It should now have
    // scrolled down so the last image — the one just viewed — is on screen.
    const after = (await galleryState(page)).scrollTop;
    expect(after).toBeGreaterThan(before);
    const lastVisible = await page.evaluate(() => {
      const r = document.getElementById('obr-gallery-host').shadowRoot;
      const s = r.querySelector('.scroll');
      const tiles = r.querySelectorAll('.tile');
      const t = tiles[tiles.length - 1];
      const sr = s.getBoundingClientRect(), tr = t.getBoundingClientRect();
      return tr.bottom > sr.top && tr.top < sr.bottom; // the last tile intersects the viewport
    });
    expect(lastVisible).toBe(true);
  });

  test('filmstrip renders one thumb per image and is shown on open', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    const s = await galleryState(page);
    expect(s.filmstrip).toBe(6);          // one thumb per image (fixture has 6)
    expect(s.filmstripHidden).toBe(false); // revealed when the lightbox opens
    expect(s.filmstripActive).toBe(0);     // current image's thumb is highlighted
  });

  test('filmstrip active thumb tracks navigation (wrapping)', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    expect((await galleryState(page)).filmstripActive).toBe(0);

    await page.keyboard.press('ArrowRight');
    expect((await galleryState(page)).filmstripActive).toBe(1);

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft'); // 0 -> wrap to last
    expect((await galleryState(page)).filmstripActive).toBe(5);
  });

  test('clicking a filmstrip thumb jumps to it without closing the lightbox', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    await clickInGallery(page, '.lb-strip .lb-thumb >> nth=3');
    const s = await galleryState(page);
    expect(s.lbOpen).toBe(true);          // backdrop-close guard: a thumb click must NOT close
    expect(s.lbCounter).toBe('4 / 6');
    expect(s.filmstripActive).toBe(3);
  });

  test('filmstrip and top controls auto-hide when idle and reappear on mouse move', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    let s = await galleryState(page);
    expect(s.filmstripHidden).toBe(false);
    expect(s.controlsHidden).toBe(false);

    await page.waitForTimeout(2900); // STRIP_IDLE_MS (2500) + buffer, no mouse movement
    s = await galleryState(page);
    expect(s.filmstripHidden).toBe(true);  // bottom filmstrip clears the image
    expect(s.controlsHidden).toBe(true);   // top control pill clears the image too

    await page.mouse.move(300, 200);
    await page.mouse.move(320, 220); // two points so a real mousemove fires
    await expect.poll(() => galleryState(page).then((x) => x.filmstripHidden)).toBe(false);
    expect((await galleryState(page)).controlsHidden).toBe(false);
  });

  test('slideshow auto-advances the big image and the filmstrip follows', async ({ page }) => {
    await page.evaluate(() => globalThis.OBR.saveSettings({ gallerySlideSeconds: 1 }));
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    expect((await galleryState(page)).lbCounter).toBe('1 / 6');

    await page.keyboard.press('a'); // start the slideshow (A key)
    expect(await page.evaluate(() => globalThis.OBR._gallerySlideshowOn())).toBe(true);

    await expect.poll(() => galleryState(page).then((s) => s.lbCounter)).toBe('2 / 6');
    expect((await galleryState(page)).filmstripActive).toBe(1); // highlight tracks the auto-advance

    await page.keyboard.press('a'); // pause
    expect(await page.evaluate(() => globalThis.OBR._gallerySlideshowOn())).toBe(false);
  });

  test('slideshow plays once and auto-pauses on the last image', async ({ page }) => {
    await page.evaluate(() => globalThis.OBR.saveSettings({ gallerySlideSeconds: 1 }));
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0'); // 1 / 6
    await page.keyboard.press('ArrowLeft');        // wrap -> 6 / 6
    await page.keyboard.press('ArrowLeft');        // 5 / 6
    expect((await galleryState(page)).lbCounter).toBe('5 / 6');

    await page.keyboard.press('a'); // play from the second-to-last image
    await expect.poll(() => galleryState(page).then((s) => s.lbCounter)).toBe('6 / 6');
    expect(await page.evaluate(() => globalThis.OBR._gallerySlideshowOn())).toBe(false); // stopped at the end
  });

  test('the play button toggles the slideshow and closing the lightbox stops it', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    await clickInGallery(page, '.lb-play');
    expect(await page.evaluate(() => globalThis.OBR._gallerySlideshowOn())).toBe(true);
    expect((await galleryState(page)).lbOpen).toBe(true); // a control click must NOT close the lightbox
    await page.keyboard.press('Escape');
    expect((await galleryState(page)).lbOpen).toBe(false);
    expect(await page.evaluate(() => globalThis.OBR._gallerySlideshowOn())).toBe(false); // closing stops it
  });

  test('the slideshow seconds field persists and survives a reopen', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    await page.evaluate(() => {
      const el = document.getElementById('obr-gallery-host').shadowRoot.querySelector('.lb-secs-in');
      el.value = '7';
      el.dispatchEvent(new Event('input', { bubbles: true }));  // real browsers fire input before change
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate(() => globalThis.OBR.closeGallery()); // close() flushes the debounced persist
    expect(await page.evaluate(() => globalThis.OBR.loadSettings().then((s) => s.gallerySlideSeconds))).toBe(7);
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    const secs = await page.evaluate(() => document.getElementById('obr-gallery-host').shadowRoot.querySelector('.lb-secs-in').value);
    expect(secs).toBe('7');
  });

  test('the +/- keys nudge the slideshow speed while it is playing (without stalling it)', async ({ page }) => {
    await page.evaluate(() => globalThis.OBR.saveSettings({ gallerySlideSeconds: 5 }));
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    await page.keyboard.press('a'); // play (5s dwell — long enough that it won't advance mid-test)
    expect(await page.evaluate(() => globalThis.OBR._gallerySlideshowOn())).toBe(true);

    await page.keyboard.press('-');
    await page.keyboard.press('-');
    const secs = await page.evaluate(() => document.getElementById('obr-gallery-host').shadowRoot.querySelector('.lb-secs-in').value);
    expect(secs).toBe('3'); // 5 -> 3, applied live in the field
    expect(await page.evaluate(() => globalThis.OBR._gallerySlideshowOn())).toBe(true); // still playing, not stalled
    await expect.poll(() => page.evaluate(() => globalThis.OBR.loadSettings().then((s) => s.gallerySlideSeconds))).toBe(3);
  });

  test('the lightbox × button closes it (not obscured by the next-nav zone)', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.tile >> nth=0');
    expect((await galleryState(page)).lbOpen).toBe(true);
    // Playwright hit-tests the click target: if .lb-next overlaps the ×, this times out.
    await clickInGallery(page, '.lb-close');
    expect((await galleryState(page)).lbOpen).toBe(false);
    expect((await galleryState(page)).hostDisplay).not.toBe('none'); // gallery itself stays open
  });

  test('PageDown / Home scroll the grid (page is scroll-locked, scroller is unfocused)', async ({ page }) => {
    await openGallery(page);
    // Force the scroller to overflow regardless of image count so there's room to scroll.
    await page.evaluate(() => { document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll').style.maxHeight = '120px'; });
    const top = () => page.evaluate(() => document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll').scrollTop);
    expect(await top()).toBe(0);
    await page.keyboard.press('PageDown');
    expect(await top()).toBeGreaterThan(0);
    await page.keyboard.press('Home');
    expect(await top()).toBe(0);
  });

  test('Escape closes the gallery', async ({ page }) => {
    await openGallery(page);
    await page.keyboard.press('Escape');
    expect((await galleryState(page)).hostDisplay).toBe('none');
  });

  test('the ⚙ settings button asks the SW to open the options page', async ({ page }) => {
    await openGallery(page);
    await clickInGallery(page, '.settings');
    const msgs = await sentMessages(page);
    expect(msgs.some((m) => m && m.type === 'obr-open-options')).toBe(true);
  });

  test('the ⚠ Report button builds a feedback mailto carrying the gallery image count', async ({ page }) => {
    await openGallery(page);
    const r = await page.evaluate(() => {
      const root = document.getElementById('obr-gallery-host').shadowRoot;
      const hasBtn = !!root.querySelector('.btn.report');
      const url = globalThis.OBR._buildReportMailto({
        source: 'gallery-toolbar', mode: 'images', imageCount: globalThis.OBR._imageCount(),
      });
      const body = decodeURIComponent((url.split('&body=')[1] || ''));
      let meta = null; try { meta = JSON.parse(body.split('[feedback-meta v1]\n')[1] || ''); } catch (e) {}
      return { hasBtn, meta, to: url.split('?')[0] };
    });
    expect(r.hasBtn).toBe(true);
    expect(r.to).toBe('mailto:studio.peach.go+open-book-reader@gmail.com');
    expect(r.meta).toMatchObject({ app: 'open-book-reader', mode: 'images', reportSource: 'gallery-toolbar' });
    expect(r.meta.imageCount).toBeGreaterThan(0);
  });

  test('column-width slider changes column count and persists', async ({ page }) => {
    await openGallery(page);
    const narrow = (await galleryState(page)).cols; // ~5 cols at the 240px default
    await page.evaluate(() => {
      const r = document.getElementById('obr-gallery-host').shadowRoot.querySelector('.range');
      r.value = '420';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect((await galleryState(page)).cols).toBeLessThan(narrow); // wider tiles → fewer columns

    // The persist is debounced (dragging fires `input` repeatedly, which would otherwise
    // spam chrome.storage.sync) — poll for the write to land rather than reading it
    // synchronously. Same approach as the auto-scroll-speed persistence tests.
    await expect
      .poll(() => page.evaluate(() => new Promise((r) =>
        chrome.storage.sync.get('obr_settings', (d) => r((d.obr_settings || {}).galleryColWidth)))))
      .toBe(420);
  });

  test('column-width slider preserves scroll position (does not snap to top)', async ({ page }) => {
    await openGallery(page);
    // Force overflow and scroll into the wall so there's a position worth protecting.
    await page.evaluate(() => { document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll').style.maxHeight = '160px'; });
    await page.evaluate(() => { const s = document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll'); s.scrollTop = s.scrollHeight; });
    const before = await page.evaluate(() => document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll').scrollTop);
    expect(before).toBeGreaterThan(0);
    const colsBefore = (await galleryState(page)).cols;

    // Change column width enough to force a column-count change -> a full relayout.
    await page.evaluate(() => {
      const r = document.getElementById('obr-gallery-host').shadowRoot.querySelector('.range');
      r.value = '420';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Guard against a false pass: the relayout must actually have fired (column
    // count changed). Otherwise the slider skips layoutAll and scroll is trivially kept.
    expect((await galleryState(page)).cols).toBeLessThan(colsBefore);
    const after = await page.evaluate(() => document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll').scrollTop);
    expect(after).toBeGreaterThan(0); // did NOT snap back to the top
  });
});

test.describe('gallery downloads', () => {
  test.beforeEach(async ({ page }) => {
    await gotoImages(page);
    await injectGallery(page);
    await openGallery(page);
  });

  test('selecting tiles updates the count and enables the download buttons', async ({ page }) => {
    expect((await galleryState(page)).selCount).toBe('0 selected');
    expect((await galleryState(page)).dlSelDisabled).toBe(true);

    await clickInGallery(page, '.tile >> nth=0 >> .check');
    const s = await galleryState(page);
    expect(s.selCount).toBe('1 selected');
    expect(s.dlSelDisabled).toBe(false);
  });

  test('per-tile download button asks the SW to download that image', async ({ page }) => {
    await clickInGallery(page, '.tile >> nth=1 >> .tile-dl');
    const msgs = await sentMessages(page);
    const one = msgs.find((m) => m.type === 'obr-download-one');
    expect(one).toBeTruthy();
    expect(one.url).toMatch(/^data:image\//);
    expect(one.filename).toMatch(/\.(png|jpg)$/);
  });

  test('Select all + ZIP fetches every image and builds the archive', async ({ page }) => {
    await clickInGallery(page, '.selall-cb');
    expect((await galleryState(page)).selCount).toBe('6 selected');

    await clickInGallery(page, '.dl-zip');
    await expect.poll(() => galleryState(page).then((s) => s.status)).toContain('saved');

    const msgs = await sentMessages(page);
    const fetchMsg = msgs.find((m) => m.type === 'obr-fetch-bytes');
    expect(fetchMsg).toBeTruthy();
    expect(fetchMsg.urls).toHaveLength(6); // all collected images
  });

  test('lightbox download button asks the SW to download the shown image', async ({ page }) => {
    await clickInGallery(page, '.tile >> nth=0');
    await clickInGallery(page, '.lb-dl');
    const msgs = await sentMessages(page);
    expect(msgs.some((m) => m.type === 'obr-download-one')).toBe(true);
  });
});

test.describe('mode switching', () => {
  test('switches text <-> images and only one mode shows at a time', async ({ page }) => {
    await gotoArticle(page);
    await injectAll(page);

    // Open the text reader.
    await page.evaluate(() => globalThis.OBR.open());
    expect((await readState(page)).hostDisplay).not.toBe('none');

    // Reader -> gallery via the 🖼 Images segment of the mode toggle.
    await clickInReader(page, '.obr-seg-btn[data-act="images"]');
    await expect.poll(() => galleryState(page).then((s) => s.hostDisplay)).not.toBe('none');
    expect((await readState(page)).hostDisplay).toBe('none'); // reader hidden

    // Gallery -> reader via the 📖 button.
    await clickInGallery(page, '.switch');
    await expect.poll(() => readState(page).then((s) => s.hostDisplay)).not.toBe('none');
    expect((await galleryState(page)).hostDisplay).toBe('none'); // gallery hidden
  });

  test('the reader mode toggle advertises the page image count on the Images segment', async ({ page }) => {
    await gotoImages(page); // image fixture: 5 large <img> + 2 tiny + 1 CSS background
    await injectAll(page);  // both engines, so OBR._imageCount is available

    await page.evaluate(() => globalThis.OBR.open());
    await expect.poll(() => readState(page).then((s) => s.hostDisplay)).not.toBe('none');

    // The lightweight badge count walks <img> + <source srcset> with the tiny
    // filter but deliberately SKIPS the background-image scan — so it sees the 5
    // large <img> (2 tiny filtered) and not the 1 CSS background the gallery keeps.
    expect((await readState(page)).imagesBadge).toBe(' · 5');
  });
});

// The toolbar icon calls OBR._autoToggle (background.js); the keyboard commands
// bypass it. The fixture has 5 gallery-worthy <img>, so the threshold straddles it.
test.describe('toolbar auto-mode', () => {
  test('opens the gallery when the page has at least autoGalleryMin images', async ({ page }) => {
    await gotoImages(page); // 5 gallery-worthy images
    await injectAll(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ autoGalleryMin: 3 }));
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('images');
    await expect.poll(() => galleryState(page).then((s) => s.hostDisplay)).not.toBe('none');
  });

  test('opens the text reader when images are below the threshold', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ autoGalleryMin: 10 }));
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('text');
    await expect.poll(() => readState(page).then((s) => s.hostDisplay)).not.toBe('none');
  });

  test('off (0) always opens the text reader regardless of image count', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ autoGalleryMin: 0 }));
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('text');
  });

  test('a second toolbar click closes the open mode (toggle-off)', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ autoGalleryMin: 3 }));
    await page.evaluate(() => globalThis.OBR._autoToggle()); // opens gallery
    await expect.poll(() => galleryState(page).then((s) => s.hostDisplay)).not.toBe('none');
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('closed-images'); // closes it
    await expect.poll(() => galleryState(page).then((s) => s.hostDisplay)).toBe('none');
  });

  // Image count alone is unreliable: a long article can carry many figures. The
  // word-count signal keeps an illustrated article in the reader.
  test('a long illustrated article stays in the reader despite many images', async ({ page }) => {
    await gotoIllustratedArticle(page); // 12 figures (>= default autoGalleryMin 10) + ~300 words
    await injectAll(page);
    // Defaults: autoGalleryMin 10, autoTextMinWords 200. Image-heavy, but it's a real read.
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('text');
    await expect.poll(() => readState(page).then((s) => s.hostDisplay)).not.toBe('none');
  });

  test('_articleWordCount counts the page\'s real prose (live DOM, not Readability)', async ({ page }) => {
    await gotoIllustratedArticle(page);
    await injectAll(page);
    expect(await page.evaluate(() => globalThis.OBR._articleWordCount())).toBeGreaterThan(200);
  });

  test('prose signal counts large paragraphs but ignores tiny caption-sized ones', async ({ page }) => {
    await gotoImages(page); // 5 images, no real prose
    await injectAll(page);
    // An image board's "text": many short captions — none should count.
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        const p = document.createElement('p');
        p.textContent = 'short caption number ' + i; // ~4 words, below MIN_PARA_WORDS
        document.body.appendChild(p);
      }
    });
    expect(await page.evaluate(() => globalThis.OBR._articleWordCount())).toBe(0);

    // A few real paragraphs (>= 20 words each) DO count.
    await page.evaluate(() => {
      const para = Array(40).fill('word').join(' '); // 40-word paragraph
      for (let i = 0; i < 3; i++) {
        const p = document.createElement('p'); p.textContent = para; document.body.appendChild(p);
      }
    });
    expect(await page.evaluate(() => globalThis.OBR._articleWordCount())).toBe(120); // 3 x 40
  });

  test('prose signal counts CJK text (no spaces) per character, not as one word', async ({ page }) => {
    await gotoImages(page); // 5 images, no real prose
    await injectAll(page);
    // A real Chinese paragraph: 33 characters, no spaces. Whitespace tokenizing would
    // see ONE word and drop it; per-character counting sees 33 and keeps it.
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.textContent = '这是一段真正的中文文章正文内容用来验证按字符计数的逻辑是否正确有效'; // 33 chars
      document.body.appendChild(p);
    });
    expect(await page.evaluate(() => globalThis.OBR._articleWordCount())).toBe(33);
  });

  test('with the text check off (0), the same illustrated article opens the gallery', async ({ page }) => {
    await gotoIllustratedArticle(page);
    await injectAll(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ autoTextMinWords: 0 })); // count-only
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('images');
    await expect.poll(() => galleryState(page).then((s) => s.hostDisplay)).not.toBe('none');
  });
});

// A per-site rule overrides the auto-pick ladder for the toolbar icon (only).
test.describe('per-site rules', () => {
  // Store a rule whose glob matches the host:path the fixtures are served under.
  // `matchTpl` may contain {host} / {path}, resolved in-page from location.
  const setRule = (page, matchTpl, mode, extra = {}) => page.evaluate(([matchTpl, mode, extra]) => {
    const host = globalThis.OBR.normalizeHost(location.hostname);
    const match = matchTpl.replace('{host}', host).replace('{path}', location.pathname);
    return globalThis.OBR.saveSettings(Object.assign({ siteRules: [{ match, mode }] }, extra));
  }, [matchTpl, mode, extra]);

  test('a whole-site rule forces the gallery even below the image threshold', async ({ page }) => {
    await gotoImages(page); // 5 images
    await injectAll(page);
    await setRule(page, '{host}', 'images', { autoGalleryMin: 99 }); // ladder alone → text
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('images');
    await expect.poll(() => galleryState(page).then((s) => s.hostDisplay)).not.toBe('none');
  });

  test('a path-glob rule matches the current path and forces the reader', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    // images.html served under the fixture host; '{host}/images*' should match it.
    await setRule(page, '{host}/images*', 'text', { autoGalleryMin: 1 }); // ladder alone → images
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('text');
    await expect.poll(() => readState(page).then((s) => s.hostDisplay)).not.toBe('none');
  });

  test('mode "auto" falls through to the normal ladder', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    await setRule(page, '{host}', 'auto', { autoGalleryMin: 3 });
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('images');
  });

  test('a rule for a different host does not apply', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ autoGalleryMin: 99, siteRules: [{ match: 'other.example', mode: 'images' }] }));
    expect(await page.evaluate(() => globalThis.OBR._autoToggle())).toBe('text');
  });
});

test.describe('matchSiteRule (glob, most-specific-wins)', () => {
  test('matches host / path / subdomain and resolves specificity', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    const out = await page.evaluate(() => {
      const m = (url, rules) => globalThis.OBR.matchSiteRule(url, rules);
      return {
        wholeSite: m('https://example.com/x/y', [{ match: 'example.com', mode: 'images' }]),
        pathHit: m('https://example.com/blog/post', [{ match: 'example.com/blog/*', mode: 'text' }]),
        pathMiss: m('https://example.com/news/x', [{ match: 'example.com/blog/*', mode: 'text' }]),
        subdomain: m('https://news.example.com/x', [{ match: '*.example.com/*', mode: 'images' }]),
        www: m('https://www.example.com/x', [{ match: 'example.com', mode: 'text' }]),
        otherHost: m('https://other.com/x', [{ match: 'example.com', mode: 'images' }]),
        mostSpecific: m('https://example.com/gallery/a', [
          { match: 'example.com', mode: 'text' },
          { match: 'example.com/gallery/*', mode: 'images' },
        ]),
        none: m('https://example.com/', []),
      };
    });
    expect(out).toEqual({
      wholeSite: 'images', pathHit: 'text', pathMiss: null, subdomain: 'images',
      www: 'text', otherHost: null, mostSpecific: 'images', none: null,
    });
  });
});

test.describe('legacy sites migration', () => {
  test('migrates a legacy sites map to siteRules — and a cleared rule does not resurrect', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    // Seed the OLD storage shape (exact-host map) directly.
    await page.evaluate(() => new Promise((res) =>
      chrome.storage.sync.set({ obr_settings: { sites: { 'example.com': { mode: 'images' } } } }, res)));
    let s = await page.evaluate(() => globalThis.OBR.loadSettings());
    expect(s.siteRules).toEqual([{ match: 'example.com', mode: 'images' }]); // migrated on read
    expect(s.sites).toBeUndefined(); // legacy key dropped from the returned object

    // Clear all rules and persist — this must purge the legacy map for good.
    await page.evaluate(() => globalThis.OBR.saveSettings({ siteRules: [] }));
    s = await page.evaluate(() => globalThis.OBR.loadSettings());
    expect(s.siteRules).toEqual([]); // stays empty: no resurrection from the old map
  });
});

test.describe('normalizeHost', () => {
  test('lowercases, strips leading www., accepts URLs and bare hosts', async ({ page }) => {
    await gotoImages(page);
    await injectAll(page);
    const out = await page.evaluate(() => {
      const n = globalThis.OBR.normalizeHost;
      return [n('WWW.Example.COM'), n('https://www.foo.com/p?x=1'), n('Bar.org'), n('sub.example.com')];
    });
    expect(out).toEqual(['example.com', 'foo.com', 'bar.org', 'sub.example.com']);
  });
});

test.describe('lazy / late images', () => {
  // Open with auto-load OFF so hydration only happens when we drive it explicitly.
  async function openManual(page) {
    await gotoLazyImages(page);
    await injectGallery(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ galleryAutoLoad: false }));
    await openGallery(page);
  }

  test('captures a lazy image\'s real data-src, not its tiny placeholder', async ({ page }) => {
    await openManual(page);
    // 3 normal + 1 lazy (rescued from data-src despite a 2x2 placeholder showing).
    expect((await galleryState(page)).tiles).toBe(4);
  });

  test('live-merges an image inserted into the page after the gallery is open', async ({ page }) => {
    await openManual(page);
    expect((await galleryState(page)).tiles).toBe(4);
    // A script inserts a new image (SPA / async hydration) — the MutationObserver grabs it.
    await page.evaluate(() => {
      const cv = document.createElement('canvas');
      cv.width = 200; cv.height = 150;
      const x = cv.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, 200, 150);
      const im = document.createElement('img');
      im.width = 200; im.height = 150; im.src = cv.toDataURL('image/png');
      document.body.appendChild(im);
    });
    await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBe(5);
  });

  // The bug: CSS multi-column re-flowed every tile on append. JS masonry must keep
  // each already-placed tile in the exact same column:position when new ones append.
  test('appending new images never moves already-placed tiles', async ({ page }) => {
    const positions = () => page.evaluate(() => {
      const r = document.getElementById('obr-gallery-host').shadowRoot;
      const map = {};
      [...r.querySelectorAll('.col')].forEach((col, ci) => {
        [...col.querySelectorAll('.tile')].forEach((t, ri) => { map[t.getAttribute('href')] = ci + ':' + ri; });
      });
      return map;
    });
    await openManual(page); // 4 tiles, auto-load off
    const before = await positions();
    expect(Object.keys(before).length).toBe(4);
    await page.evaluate(() => globalThis.OBR._galleryLoadMore()); // appends +3
    await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBe(7);
    const after = await positions();
    for (const url of Object.keys(before)) expect(after[url]).toBe(before[url]); // unchanged
  });

  test('Load more pulls the next chunk only (not the whole page)', async ({ page }) => {
    await openManual(page);
    expect((await galleryState(page)).tiles).toBe(4);
    await page.evaluate(() => globalThis.OBR._galleryLoadMore()); // one chunk, shallow scroll
    await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBe(7); // +3 shallow batch
    // The deep batch (only reachable near the bottom) is NOT loaded yet.
    expect(await page.evaluate(() => window.__obrInjected())).toBe(1);
  });

  test('Load all sweeps to the bottom and pulls every batch', async ({ page }) => {
    await openManual(page);
    expect((await galleryState(page)).tiles).toBe(4);
    await page.evaluate(() => globalThis.OBR._galleryRescan()); // scroll to bottom
    await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBe(10); // +3 +3 both batches
    expect(await page.evaluate(() => window.__obrInjected())).toBe(2);
  });

  test('auto-load prefetches a chunk on open when the grid is short', async ({ page }) => {
    await gotoLazyImages(page);
    await injectGallery(page);
    await openGallery(page); // galleryAutoLoad defaults to true → maybePreload pulls a chunk
    await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBe(7); // 4 + shallow batch
  });

  test('closing mid-Load-all stops scrolling and restores the page position', async ({ page }) => {
    await openManual(page); // page at scrollY 0; auto-load off
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Start a full sweep (scrolls the page in 200ms steps) but DON'T await it; close after one step.
    await page.evaluate(() => { globalThis.OBR._galleryRescan(); return new Promise((r) => setTimeout(r, 280)); });
    await page.evaluate(() => globalThis.OBR.closeGallery());
    // Give any in-flight sweep step time to (not) clobber the restored position.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    expect(await page.evaluate(() => window.scrollY)).toBe(0); // restored, not left mid-sweep
  });

  // Regression: an infinite-scroll page that keeps GROWING but mounts no new gallery
  // image must not make progressive hydration (and thus auto-scroll) loop forever
  // pulling chunks. A progressive chunk that surfaces nothing now arms the soft-done
  // pause, so the NEXT progressive pull short-circuits instead of scrolling again.
  // Without the fix the second pull runs and grows the page once more (test goes red).
  test('a progressive chunk that finds no new images stops the next pull (no endless Load-more)', async ({ page }) => {
    await gotoGrowNoImages(page);
    await injectGallery(page);
    await page.evaluate(() => globalThis.OBR.saveSettings({ galleryAutoLoad: false }));
    await openGallery(page);
    expect((await galleryState(page)).tiles).toBe(4);

    // First progressive pull: it scrolls the page (which grows it), but no new image mounts.
    const added1 = await page.evaluate(() => globalThis.OBR._galleryLoadMore());
    const growsAfter1 = await page.evaluate(() => window.__grows);
    expect(added1).toBe(0);
    expect(growsAfter1).toBeGreaterThan(0); // the sweep really did scroll/grow the page

    // Second progressive pull: soft-done is armed, so this must short-circuit — no further
    // scrolling, no further growth. (Pre-fix it kept sweeping and growsAfter2 > growsAfter1.)
    const added2 = await page.evaluate(() => globalThis.OBR._galleryLoadMore());
    const growsAfter2 = await page.evaluate(() => window.__grows);
    expect(added2).toBe(0);
    expect(growsAfter2).toBe(growsAfter1);
    expect((await galleryState(page)).tiles).toBe(4); // still no new images
  });
});

test.describe('gallery auto-scroll', () => {
  // Open on a short viewport so the masonry wall overflows the scroller (auto-scroll has room).
  // Auto-load OFF so the only loading is the binge path; speed is tunable per test.
  async function openAuto(page, speed = 600) {
    await page.setViewportSize({ width: 520, height: 300 });
    await gotoLazyImages(page);
    await injectGallery(page);
    await page.evaluate((s) => globalThis.OBR.saveSettings({ galleryAutoLoad: false, galleryAutoScrollSpeed: s }), speed);
    await openGallery(page);
  }

  const scrollMax = (page) => page.evaluate(() => {
    const el = document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll');
    return el.scrollHeight - el.clientHeight;
  });
  const clickAuto = (page) => page.evaluate(() =>
    document.getElementById('obr-gallery-host').shadowRoot.querySelector('.autoscroll').click());

  test('toggling auto-scroll advances the scroll position', async ({ page }) => {
    await openAuto(page);
    expect((await galleryState(page)).scrollTop).toBe(0);
    await page.evaluate(() => globalThis.OBR._galleryAutoScroll(true));
    await expect.poll(() => galleryState(page).then((s) => s.scrollTop)).toBeGreaterThan(0);
  });

  test('the toolbar Auto-scroll button toggles the .on state and aria-pressed', async ({ page }) => {
    await openAuto(page, 20); // slow so it won't reach the bottom and auto-stop mid-test
    await clickAuto(page);
    await expect.poll(() => galleryState(page).then((s) => s.autoOn)).toBe(true);
    expect(await page.evaluate(() =>
      document.getElementById('obr-gallery-host').shadowRoot.querySelector('.autoscroll').getAttribute('aria-pressed'))).toBe('true');
    await clickAuto(page);
    await expect.poll(() => galleryState(page).then((s) => s.autoOn)).toBe(false);
  });

  test('a wheel gesture over the grid cancels auto-scroll', async ({ page }) => {
    await openAuto(page, 60);
    await page.evaluate(() => globalThis.OBR._galleryAutoScroll(true));
    await expect.poll(() => page.evaluate(() => globalThis.OBR._galleryAutoScrollOn())).toBe(true);
    await page.evaluate(() =>
      document.getElementById('obr-gallery-host').shadowRoot.querySelector('.scroll')
        .dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true })));
    expect(await page.evaluate(() => globalThis.OBR._galleryAutoScrollOn())).toBe(false);
  });

  test('the speed field shows the persisted value, and +/- change it (no numpad needed)', async ({ page }) => {
    await openAuto(page, 100);
    expect((await galleryState(page)).autoSpeed).toBe('100'); // field reflects the persisted speed on open
    await page.keyboard.press('Equal'); // the main-row "=" / "+" key — no numpad
    await expect.poll(() => galleryState(page).then((s) => s.autoSpeed)).toBe('120');
    await page.keyboard.press('Minus');
    await page.keyboard.press('Minus');
    await expect.poll(() => galleryState(page).then((s) => s.autoSpeed)).toBe('80');
    // The persisted value tracks the field (persist is debounced, so poll for it).
    await expect.poll(() => page.evaluate(() => globalThis.OBR.loadSettings().then((s) => s.galleryAutoScrollSpeed))).toBe(80);
  });

  test('the +/- keys work even when the size slider has focus', async ({ page }) => {
    await openAuto(page, 100);
    await page.evaluate(() => document.getElementById('obr-gallery-host').shadowRoot.querySelector('.range').focus());
    await page.keyboard.press('Equal');
    await expect.poll(() => galleryState(page).then((s) => s.autoSpeed)).toBe('120');
  });

  test('typing a speed in the field persists it and it survives a reopen', async ({ page }) => {
    await openAuto(page, 60);
    await page.evaluate(() => {
      const el = document.getElementById('obr-gallery-host').shadowRoot.querySelector('.autospeed-in');
      el.value = '250';
      el.dispatchEvent(new Event('input', { bubbles: true }));  // real browsers fire input before change
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // close() flushes the debounced persist, so the value is saved before the reopen reads storage.
    await page.evaluate(() => globalThis.OBR.closeGallery());
    expect(await page.evaluate(() => globalThis.OBR.loadSettings().then((s) => s.galleryAutoScrollSpeed))).toBe(250);
    await openGallery(page);
    expect((await galleryState(page)).autoSpeed).toBe('250');
  });

  test('an out-of-range typed value is clamped on change', async ({ page }) => {
    await openAuto(page, 60);
    await page.evaluate(() => {
      const el = document.getElementById('obr-gallery-host').shadowRoot.querySelector('.autospeed-in');
      el.value = '9000'; el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => galleryState(page).then((s) => s.autoSpeed)).toBe('400'); // clamped to max
  });

  test('a manual nav key (PageDown) cancels auto-scroll', async ({ page }) => {
    await openAuto(page, 60);
    await page.evaluate(() => globalThis.OBR._galleryAutoScroll(true));
    await expect.poll(() => page.evaluate(() => globalThis.OBR._galleryAutoScrollOn())).toBe(true);
    await page.keyboard.press('PageDown');
    expect(await page.evaluate(() => globalThis.OBR._galleryAutoScrollOn())).toBe(false);
  });

  test('auto-scroll stops itself at the genuine bottom after Load all', async ({ page }) => {
    await openAuto(page, 4000); // fast: reach the bottom quickly
    await page.evaluate(() => globalThis.OBR._galleryRescan()); // sweep → fullyHydrated, 10 tiles
    await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBe(10);
    const max = await scrollMax(page);
    expect(max).toBeGreaterThan(150); // the wall genuinely overflows — so reaching the bottom means a real descent
    await page.evaluate(() => globalThis.OBR._galleryAutoScroll(true));
    // Descends to the end and turns itself off.
    await expect.poll(() => page.evaluate(() => globalThis.OBR._galleryAutoScrollOn()), { timeout: 8000 }).toBe(false);
    expect((await galleryState(page)).scrollTop).toBeGreaterThanOrEqual(max - 3); // parked at the bottom
  });
});
