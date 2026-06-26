#!/usr/bin/env node
/* Record a looping GIF of the two-page reader flipping pages, for marketing posts.
 *
 * Reuses the capture-screenshots harness: loads the real unpacked extension into
 * Chromium, serves a demo article, injects the content scripts the way background.js
 * does on a toolbar gesture, opens the reader, then performs a real arrow-key flip
 * sequence while Playwright records a video. ffmpeg converts the video to a tight,
 * seamless-looping GIF (page 1 -> forward -> back to page 1).
 *
 *   node scripts/capture-flip-gif.mjs            # -> store-assets/promo-flip.gif
 *   HEADED=true node scripts/capture-flip-gif.mjs
 *
 * Requires ffmpeg on PATH (brew install ffmpeg).
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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
const OUT_GIF = path.join(OUT, 'promo-flip.gif');
const OUT_MP4 = path.join(OUT, 'promo-flip.mp4');
const W = 1280, H = 800;
const PORT = 5178;
const GIF_WIDTH = 720;   // GIFs are heavy; keep the inline-embed fallback small
const FPS = 12;

const CONTENT_FILES = ['settings.js', 'readability.js', 'reader.js', 'zip.js', 'gallery.js'].map((f) =>
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

// Read the reader's "n pages" indicator out of its (open) shadow root, so we flip
// exactly as far as the article goes and always land back on page 1 for a clean loop.
async function totalSpreads(page, columns) {
  const totalColumns = await page.evaluate(() => {
    const host = document.getElementById('obr-host');
    const txt = host?.shadowRoot?.querySelector('.obr-indicator')?.textContent || '';
    const m = txt.match(/(\d+)\s*pages/);
    return m ? parseInt(m[1], 10) : 0;
  });
  return Math.max(1, Math.ceil((totalColumns || columns) / columns));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = serveFixtures();
  const base = `http://localhost:${PORT}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-gif-'));
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-gif-vid-'));
  const headed = process.env.HEADED === 'true';
  const args = [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`];
  if (!headed) args.push('--headless=new');

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference', // reader disables the flip animation under reduce-motion
    recordVideo: { dir: videoDir, size: { width: W, height: H } },
  });
  const recStart = Date.now(); // ~ video t0

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.addInitScript(storageShim);

  const COLUMNS = 2;
  await page.goto(`${base}/demo-article.html`);
  // Framed "open book" look: cap the width so the paper sits on the background with
  // its spine + shadow. A larger font yields more columns -> more pages to flip (the
  // demo fixtures are short); a slightly longer transition reads clearly in a GIF.
  await page.evaluate(() => globalThis.localStorage.setItem(
    '__obr_shot_store',
    JSON.stringify({ obr_settings: { maxBookWidth: 1120, theme: 'paper', columns: 2, fontSize: 23, lineHeight: 1.68, transitionMs: 420 } })
  ));
  await inject(page);
  await page.evaluate(() => globalThis.OBR.open());
  await wait(page, 1100); // let pagination settle (late-image/font relayout)

  const spreads = await totalSpreads(page, COLUMNS);
  const flips = Math.min(5, Math.max(1, spreads - 1));

  // Keep the controls (hint bar + progress) visible by nudging the mouse each beat,
  // and let the horizontal page-slide animation play between holds.
  const nudge = async (i) => { await page.mouse.move(620 + (i % 2) * 40, 400 + (i % 2) * 20); };
  await nudge(0);
  await wait(page, 600); // hold on page 1 before flipping (loop entry point)
  const flipStart = Date.now();

  for (let i = 0; i < flips; i++) {       // forward
    await page.keyboard.press('ArrowRight');
    await nudge(i);
    await wait(page, 850);
  }
  await wait(page, 300);
  for (let i = 0; i < flips; i++) {        // back to page 1 -> seamless loop
    await page.keyboard.press('ArrowLeft');
    await nudge(i);
    await wait(page, 850);
  }
  await wait(page, 400);
  const flipEnd = Date.now();

  const video = page.video();
  await ctx.close();                       // finalizes the .webm
  const webm = await video.path();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  // Trim to the flip sequence (drop the page-load + reader-open pre-roll) and convert
  // to a high-quality GIF via a generated palette. Start ~0.5s before the first flip
  // so page 1 is visible at the loop seam.
  const ss = Math.max(0, (flipStart - recStart) / 1000 - 0.5);
  const dur = (flipEnd - flipStart) / 1000 + 0.8;
  const palette = path.join(videoDir, 'palette.png');
  const vf = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  const ff = (a) => execFileSync('ffmpeg', a, { stdio: ['ignore', 'ignore', 'inherit'] });
  // GIF (universal-embed fallback) via a generated palette.
  ff(['-y', '-ss', String(ss), '-t', String(dur), '-i', webm, '-vf', `${vf},palettegen=stats_mode=diff`, palette]);
  ff(['-y', '-ss', String(ss), '-t', String(dur), '-i', webm, '-i', palette,
      '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`, '-loop', '0', OUT_GIF]);
  // MP4 (preferred for Reddit video upload — autoplays, loops, ~10x smaller than the GIF).
  ff(['-y', '-ss', String(ss), '-t', String(dur), '-i', webm,
      '-vf', 'scale=960:-2:flags=lanczos,fps=24', '-c:v', 'libx264', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT_MP4]);

  fs.rmSync(videoDir, { recursive: true, force: true });
  const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1);
  console.log(`\n${flips} flips each way`);
  console.log(`  GIF -> ${path.relative(ROOT, OUT_GIF)}  (${mb(OUT_GIF)} MB)`);
  console.log(`  MP4 -> ${path.relative(ROOT, OUT_MP4)}  (${mb(OUT_MP4)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
