#!/usr/bin/env node
/* Capture Chrome Web Store screenshots (1280x800) of every Open Book Reader feature.
 *
 * Loads the real unpacked extension into headless Chromium, serves the demo fixtures,
 * injects the content scripts the same way background.js does on a toolbar gesture
 * (headless can't click the real toolbar icon to grant activeTab), then snapshots the
 * text reader, the image gallery, the lightbox, and the options page.
 *
 *   node scripts/capture-screenshots.mjs            # all shots -> store-assets/
 *   HEADED=true node scripts/capture-screenshots.mjs
 */
import { chromium } from '@playwright/test';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { ROOT, OUT, serveFixtures, inject, wait, preparePage, closeCapture } from './lib/capture-harness.mjs';

const W = 1280, H = 800;
const PORT = 5177;

// The capture harness (page prep, fixture server, script injection, wait) lives in
// lib/capture-harness.mjs. Get the page from preparePage() — never construct one by hand.

// Compose a 1280x800 before/after hero from two full-viewport screenshots (PNG buffers):
// a cluttered source page on the left, the Open Book Reader result on the right.
async function composeBeforeAfter(page, beforeBuf, afterBuf, out, opts) {
  const o = { kicker: 'SAME PAGE - TRANSFORMED', title: 'Read any article as a calm open book',
    sub: 'Ads, sidebars, and clutter stripped away - just the story, two facing pages.',
    beforeLabel: 'A typical web article', afterLabel: 'Open Book Reader', ...opts };
  const before = `data:image/png;base64,${beforeBuf.toString('base64')}`;
  const after = `data:image/png;base64,${afterBuf.toString('base64')}`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0}
    .stage{width:1280px;height:800px;box-sizing:border-box;
      background:radial-gradient(120% 120% at 50% 0%, #f3ead6 0%, #e7dabe 60%, #ddcdab 100%);
      font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#3a3122;
      display:flex;flex-direction:column;align-items:center;padding:46px 48px 40px}
    .kicker{font-size:14px;font-weight:800;letter-spacing:3px;color:#a9742a;margin-bottom:8px}
    .title{font-family:Georgia,"Songti SC",serif;font-size:38px;font-weight:700;text-align:center;margin:0 0 6px}
    .sub{font-size:16px;color:#6f6651;margin-bottom:8px}
    .row{flex:1;display:flex;align-items:center;justify-content:center;gap:30px;width:100%}
    figure{margin:0;display:flex;flex-direction:column;align-items:center}
    .shot{width:512px;height:320px;object-fit:cover;object-position:top center;border-radius:10px;
      border:1px solid rgba(0,0,0,.12);box-shadow:0 16px 34px rgba(60,40,10,.28)}
    .after .shot{outline:3px solid #c98a2e;outline-offset:0}
    figcaption{margin-top:14px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
    .dot{width:10px;height:10px;border-radius:50%}
    .before .dot{background:#d24a4a}.after .dot{background:#2f9e54}
    .before figcaption{color:#8a4040}.after figcaption{color:#2f7a46}
    .arrow{font-size:54px;color:#a9742a;font-weight:300;line-height:1;margin-top:-30px}
  </style>
  <div class="stage">
    <div class="kicker">${o.kicker}</div>
    <div class="title">${o.title}</div>
    <div class="sub">${o.sub}</div>
    <div class="row">
      <figure class="before"><img class="shot" src="${before}"><figcaption><span class="dot"></span>${o.beforeLabel}</figcaption></figure>
      <div class="arrow">&rarr;</div>
      <figure class="after"><img class="shot" src="${after}"><figcaption><span class="dot"></span>${o.afterLabel}</figcaption></figure>
    </div>
  </div>`;
  await page.setContent(html);
  await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => {}))));
  await page.locator('.stage').screenshot({ path: out });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = serveFixtures(PORT);
  const base = `http://localhost:${PORT}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-shots-'));
  const headed = process.env.HEADED === 'true';
  const args = [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`];
  if (!headed) args.push('--headless=new');

  // try/finally so a failure part-way through the shot list still releases the fixture
  // port and the temp profile — a leaked port is what makes the NEXT run die on EADDRINUSE.
  let ctx = null;
  let closed = false;
  try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: { width: W, height: H },
    deviceScaleFactor: 1, // the store requires exactly 1280x800 (or 640x400)
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];

  const page = await preparePage(ctx);

  const shots = [];
  const snap = async (name) => {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    shots.push(name);
  };

  // The reader fills the window by default, but for the store we cap the width so the
  // paper sits framed on the background with its shadow + spine — the "open book" look.
  // maxBookWidth is a real setting; this just showcases it.
  await page.goto(`${base}/demo-article.html`);
  await page.evaluate(() => globalThis.localStorage.setItem(
    '__obr_shot_store', JSON.stringify({ obr_settings: { maxBookWidth: 1120 } })
  ));
  await inject(page);

  // 1) Text reader — paper theme, two-page spread, chrome auto-hidden (immersive hero).
  await page.evaluate(() => globalThis.OBR.open());
  await wait(page, 2600); // let the floating topbar/footer auto-hide (2.2s idle)
  await snap('01-reader-paper.png');

  // 0) Before/after hero — same article cluttered (left) vs the reader (right). Built from
  //    two full-viewport shots, so it stays exactly 1280x800. Listed FIRST in the store.
  const afterBuf = fs.readFileSync(path.join(OUT, '01-reader-paper.png'));
  await page.goto(`${base}/demo-cluttered.html`);
  await wait(page, 500);
  const beforeBuf = await page.screenshot();
  await composeBeforeAfter(page, beforeBuf, afterBuf, path.join(OUT, '00-before-after.png'));
  shots.push('00-before-after.png');
  // Return to the article + reader for the remaining text-mode shot.
  await page.goto(`${base}/demo-article.html`);
  await page.evaluate(() => globalThis.localStorage.setItem(
    '__obr_shot_store', JSON.stringify({ obr_settings: { maxBookWidth: 1120 } })
  ));
  await inject(page);

  // 2) Text reader — dark theme, three columns, controls visible.
  await page.evaluate(() => globalThis.OBR.saveSettings({ theme: 'dark', columns: 3 }));
  await page.evaluate(() => globalThis.OBR.close());
  await page.evaluate(() => globalThis.OBR.open());
  await wait(page, 600);
  await page.mouse.move(640, 8); // reveal the auto-hiding topbar/footer
  await wait(page, 300);
  await snap('02-reader-dark-3col.png');
  await page.evaluate(() => globalThis.OBR.saveSettings({ theme: 'paper', columns: 2 }));
  await page.evaluate(() => globalThis.OBR.close());

  // 0b) Gallery before/after hero — a cluttered image thread (left) vs the masonry wall (right).
  await page.goto(`${base}/demo-gallery-cluttered.html`);
  await page.waitForFunction(
    () => document.images.length >= 12 && Array.from(document.images).every((i) => i.complete)
  );
  await wait(page, 300);
  const galleryBeforeBuf = await page.screenshot();
  await inject(page);
  await page.evaluate(() => globalThis.OBR.openGallery());
  await wait(page, 900);
  const galleryAfterBuf = await page.screenshot();
  await page.evaluate(() => globalThis.OBR.closeGallery());
  await composeBeforeAfter(page, galleryBeforeBuf, galleryAfterBuf, path.join(OUT, '00b-gallery-before-after.png'), {
    kicker: 'EVERY IMAGE, ONE CLEAN WALL',
    title: 'Turn any image-heavy page into a gallery',
    sub: 'Pulls every picture out of the ads, posts, and thumbnails into a tidy masonry wall.',
    beforeLabel: 'A typical image page',
    afterLabel: 'Open Book Reader gallery',
  });
  shots.push('00b-gallery-before-after.png');

  // 3) Image gallery — masonry wall.
  await page.goto(`${base}/demo-gallery.html`);
  await page.waitForFunction(
    () => document.images.length >= 12 && Array.from(document.images).every((i) => i.complete)
  );
  await inject(page);
  await page.evaluate(() => globalThis.OBR.openGallery());
  await wait(page, 800);
  await snap('03-gallery-masonry.png');

  // 4) Gallery — lightbox open on one image.
  await page.evaluate(() => {
    const r = document.getElementById('obr-gallery-host').shadowRoot;
    r.querySelectorAll('.tile')[3].click();
  });
  await wait(page, 500);
  await snap('04-gallery-lightbox.png');
  await page.keyboard.press('Escape');
  await page.evaluate(() => globalThis.OBR.closeGallery());

  // 5) Options page (runs in the real extension context with real chrome.storage).
  // Settings groups are collapsible <details> now (Reader open, the rest collapsed); expand
  // them all so the store shot shows the full feature set instead of three collapsed headers.
  await page.goto(`chrome-extension://${extId}/src/options/options.html`);
  await page.evaluate(() => document.querySelectorAll('details.card, details.guide').forEach((d) => { d.open = true; }));
  await wait(page, 400);
  await snap('05-options.png');

  // 6) Promo tile — 440x280 store marquee (clipped to the tile element).
  await page.goto(`${base}/demo-promo.html`);
  await wait(page, 300);
  await page.locator('.tile').screenshot({ path: path.join(OUT, 'promo-440x280.png') });
  shots.push('promo-440x280.png');

  // 7) Video thumbnail — 1280x720, the poster frame for promo-video.mp4.
  //
  // This is NOT a YouTube-browse asset: it is what the store's media carousel and Product
  // Hunt show before anyone presses play. Left to YouTube's auto-pick it would choose from
  // three frames of a video whose opening beat is a deliberately ad-choked page, so the
  // store tile would advertise clutter. It lives here rather than in its own script because
  // this is the stills script and it already owns the screenshot -> data-URI -> HTML card
  // -> screenshot composer that the caption band needs.
  //
  // 16:9, so the viewport changes here; nothing pins it (no recordVideo in this script).
  // NOTE: it is NOT restored — this must stay the LAST beat, or any store shot appended
  // after it comes out 1280x720 and the Web Store rejects it.
  await page.setViewportSize({ width: 1280, height: 720 });
  // Park the cursor away from the topbar. Shot 02 above deliberately left it at (640, 8),
  // and scheduleHideChrome() does not arm the hide timer while the pointer is over the
  // controls — so inheriting that position could keep the toolbar up through the wait below.
  await page.mouse.move(640, 700);
  await page.goto(`${base}/demo-article.html`);
  await page.evaluate(() => globalThis.localStorage.setItem('__obr_shot_store', JSON.stringify({
    obr_settings: { maxBookWidth: 980, theme: 'paper', columns: 2, fontSize: 26, lineHeight: 1.72 },
  })));
  await inject(page);
  await page.evaluate(() => globalThis.OBR.open());
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // The mouse is never moved here, so the reader's controls auto-hide and the frame is
  // pure book — no toolbar. (Shot 02 above deliberately does the opposite.)
  await wait(page, 2400);
  const thumbBuf = await page.screenshot();
  fs.writeFileSync(path.join(OUT, 'thumbnail-clean.png'), thumbBuf);
  shots.push('thumbnail-clean.png');

  // Captioned variant. Small-size legibility is the whole job of a thumbnail: an untexted
  // page reads as generic once the carousel shrinks it. Reuses the tagline already on the
  // promo tile rather than inventing new marketing copy.
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>
      html,body{margin:0;width:1280px;height:720px;overflow:hidden}
      .wrap{position:relative;width:1280px;height:720px}
      .shot{width:100%;height:100%;object-fit:cover;display:block}
      .band{position:absolute;left:0;right:0;bottom:0;height:190px;
        background:linear-gradient(to top,rgba(46,38,26,.94) 0%,rgba(46,38,26,.88) 58%,rgba(46,38,26,0) 100%);
        display:flex;align-items:flex-end;justify-content:center;padding-bottom:58px}
      h1{margin:0;font-family:Georgia,"Songti SC",serif;font-size:56px;font-weight:600;
        color:#f4ead6;letter-spacing:.3px;text-align:center;text-shadow:0 2px 10px rgba(0,0,0,.35)}
    </style>
    <div class="wrap">
      <img class="shot" src="data:image/png;base64,${thumbBuf.toString('base64')}">
      <div class="band"><h1>Read the web like an open book</h1></div>
    </div>`);
  // Await DECODE, not just load: setContent resolves on 'load', which guarantees
  // img.complete but not that the ~190KB data-URI has been rastered into the frame the
  // screenshot grabs. Losing that race yields a caption band over an empty page.
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, 'thumbnail-text.png') });
  shots.push('thumbnail-text.png');

  await ctx.close();
  closed = true;

  console.log(`\nCaptured ${shots.length} screenshots -> ${path.relative(ROOT, OUT)}/`);
  shots.forEach((s) => console.log('  ' + s));
  } finally {
    // Port FIRST: it must never be held hostage to a browser that won't exit.
    server.close();
    await closeCapture(ctx, closed, [userDataDir]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
