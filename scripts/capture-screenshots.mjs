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
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const CONTENT = path.join(ROOT, 'src', 'content');
const OUT = path.join(ROOT, 'store-assets');
const W = 1280, H = 800;
const PORT = 5177;

const CONTENT_FILES = ['settings.js', 'readability.js', 'reader.style.js', 'reader.js', 'zip.js', 'gallery.js'].map((f) =>
  path.join(CONTENT, f)
);

// chrome.storage.sync shim (localStorage-backed) for the injected main-world scripts.
function storageShim() {
  const KEY = '__obr_shot_store';
  const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.storage = {
    sync: {
      get: (keys, cb) => {
        const all = read();
        const list = keys == null ? Object.keys(all) : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in all) out[k] = all[k];
        cb(out);
      },
      set: (items, cb) => {
        localStorage.setItem(KEY, JSON.stringify({ ...read(), ...items }));
        if (cb) cb();
      },
    },
    onChanged: { addListener: () => {} },
  };
}

function serveFixtures() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript' };
  return http
    .createServer((req, res) => {
      const rel = (decodeURIComponent((req.url || '/').split('?')[0]) || '/').replace(/^\/+/, '') || 'demo-article.html';
      const file = path.join(FIXTURES, rel);
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
      fs.createReadStream(file).pipe(res);
    })
    .listen(PORT);
}

async function inject(page) {
  for (const f of CONTENT_FILES) await page.addScriptTag({ path: f });
}

const wait = (page, ms) => page.evaluate((d) => new Promise((r) => setTimeout(r, d)), ms);

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
  const server = serveFixtures();
  const base = `http://localhost:${PORT}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-shots-'));
  const headed = process.env.HEADED === 'true';
  const args = [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`];
  if (!headed) args.push('--headless=new');

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: { width: W, height: H },
    deviceScaleFactor: 1, // the store requires exactly 1280x800 (or 640x400)
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.addInitScript(storageShim);

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
  await page.goto(`chrome-extension://${extId}/src/options/options.html`);
  await wait(page, 400);
  await snap('05-options.png');

  // 6) Promo tile — 440x280 store marquee (clipped to the tile element).
  await page.goto(`${base}/demo-promo.html`);
  await wait(page, 300);
  await page.locator('.tile').screenshot({ path: path.join(OUT, 'promo-440x280.png') });
  shots.push('promo-440x280.png');

  await ctx.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  server.close();

  console.log(`\nCaptured ${shots.length} screenshots -> ${path.relative(ROOT, OUT)}/`);
  shots.forEach((s) => console.log('  ' + s));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
