#!/usr/bin/env node
/* Record the marketing video, and cut every video asset from that ONE recording.
 *
 * Loads the real unpacked extension into Chromium, serves the demo fixtures, injects the
 * content scripts the way background.js does on a toolbar gesture, then plays a scripted
 * storyboard while Playwright records. ffmpeg trims the single .webm into:
 *
 *   promo-video.mp4  the full storyboard — the Chrome Web Store video slot (via YouTube)
 *                    and Product Hunt. Silent and near-wordless on purpose: the pitch is
 *                    something you SEE, and a text-free clip serves all eight store
 *                    locales from one URL. The only text is the closing card.
 *   promo-flip.mp4   just the flip sequence — Reddit / forum video upload
 *   promo-flip.gif   the same window as a seamless loop — inline-embed fallback
 *
 * WHY ONE RECORDING. The promo choreography already CONTAINS the flip sequence, so a
 * separate flip capture meant a second Chromium launch, a second port, and a second copy
 * of the launch block, totalSpreads(), the video-finalize ordering, and the encode flags —
 * the machinery that actually has failure modes. Cutting sub-windows out of one webm
 * deletes all of it. Forward-then-back flips serve both masters: they demonstrate
 * bidirectional navigation in the promo AND land back on page 1, which is what makes the
 * GIF loop seamlessly.
 *
 * Recorded at 1280x720 so YouTube gets native 16:9 with no letterboxing. The GIF/MP4
 * sub-cuts downscale, so they don't care about the source aspect.
 *
 *   node scripts/capture-promo.mjs      # -> store-assets/promo-{video.mp4,flip.mp4,flip.gif}
 *   HEADED=true node scripts/capture-promo.mjs
 *
 * Requires ffmpeg on PATH (brew install ffmpeg).
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { ROOT, OUT, serveFixtures, inject, wait, preparePage } from './lib/capture-harness.mjs';

const OUT_VIDEO = path.join(OUT, 'promo-video.mp4');
const OUT_FLIP_MP4 = path.join(OUT, 'promo-flip.mp4');
const OUT_FLIP_GIF = path.join(OUT, 'promo-flip.gif');
const W = 1280, H = 720;   // 16:9 for YouTube
const PORT = 5178;
const GIF_WIDTH = 720;     // GIFs are heavy; keep the inline-embed fallback small
const GIF_FPS = 12;
const COLUMNS = 2;

// A larger font yields more columns -> more pages to flip (the demo fixtures are short),
// and a slightly longer transition reads clearly at GIF frame rates.
const SETTINGS = {
  obr_settings: {
    maxBookWidth: 1080, theme: 'paper', columns: COLUMNS,
    fontSize: 24, lineHeight: 1.68, transitionMs: 460,
  },
};

const iconDataUri = () =>
  'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'icons', 'icon128.png')).toString('base64');

// The card uses the manifest's short_name, NOT the full store title. That title is
// keyword-bearing and long by design ("Open Book — Two-Page Reader View & Image Gallery");
// on a card it reads as spam, and hardcoding it here is how this card silently goes stale
// on the next ASO pass. short_name is the stable brand.
const endCard = (icon) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#efe6d4;font-family:Georgia,"Songti SC",serif;color:#3a3122}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
  img{width:96px;height:96px;image-rendering:-webkit-optimize-contrast}
  h1{margin:0;font-size:40px;font-weight:600;letter-spacing:.2px}
  p{margin:0;font-size:20px;opacity:.72}
</style>
<div class="wrap">
  <img src="${icon}" alt="">
  <h1>Open Book</h1>
  <p>Reader view and image gallery for Chrome &middot; free and open source</p>
</div>`;

// Read the reader's "n pages" indicator out of its (open) shadow root, so we flip exactly
// as far as the article goes and always land back on page 1 for a clean loop.
async function totalSpreads(page, columns) {
  const totalColumns = await page.evaluate(() => {
    const host = document.getElementById('obr-host');
    const txt = host?.shadowRoot?.querySelector('.obr-indicator')?.textContent || '';
    const m = txt.match(/(\d+)\s*pages/);
    return m ? parseInt(m[1], 10) : 0;
  });
  // A silent 0 here (the indicator text changed, e.g. a reworded readerPageIndicator)
  // would degrade to a one-flip promo with no error at all. Say so instead.
  if (!totalColumns) console.warn('  ! could not read the page indicator — falling back to a single flip');
  return Math.max(1, Math.ceil((totalColumns || columns) / columns));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = serveFixtures(PORT);
  const base = `http://localhost:${PORT}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-promo-'));
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-promo-vid-'));
  const args = [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`];
  if (process.env.HEADED !== 'true') args.push('--headless=new');

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference', // the reader falls back to instant under reduce-motion
    recordVideo: { dir: videoDir, size: { width: W, height: H } },
  });
  const recStart = Date.now();      // ~ video t0
  const page = await preparePage(ctx);

  // ---- 1. the cluttered "before" ------------------------------------------------
  await page.goto(`${base}/demo-cluttered.html`);
  await page.evaluate((s) => globalThis.localStorage.setItem('__obr_shot_store', JSON.stringify(s)), SETTINGS);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await wait(page, 400);
  const t0 = Date.now();            // promo starts here; earlier frames are pre-roll
  await wait(page, 1800);

  // ---- 2. the transformation ----------------------------------------------------
  // The clean counterpart carries the SAME article; extracting from the cluttered DOM
  // drags breadcrumbs and share links into the reader — real behaviour, but it reads as a
  // defect in a 2-second beat. This is the convention the store's before/after hero uses.
  await page.goto(`${base}/demo-article.html`);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await inject(page);
  await page.evaluate(() => globalThis.OBR.open());
  await wait(page, 1500);           // let pagination settle (late image/font relayout)

  // ---- 3. the flips — the pitch, and the GIF's window ----------------------------
  const spreads = await totalSpreads(page, COLUMNS);
  const flips = Math.min(3, Math.max(1, spreads - 1));
  // Nudge the mouse each beat so the controls stay awake and visible.
  const nudge = async (i) => { await page.mouse.move(620 + (i % 2) * 40, 380 + (i % 2) * 20); };
  await nudge(0);
  await wait(page, 500);            // hold on page 1 — the GIF's loop entry point
  const flipStart = Date.now();
  for (let i = 0; i < flips; i++) { // forward
    await page.keyboard.press('ArrowRight');
    await nudge(i);
    await wait(page, 900);
  }
  await wait(page, 250);
  for (let i = 0; i < flips; i++) { // back to page 1 -> seamless loop
    await page.keyboard.press('ArrowLeft');
    await nudge(i);
    await wait(page, 900);
  }
  await wait(page, 400);
  const flipEnd = Date.now();

  // ---- 4. the second mode -------------------------------------------------------
  await page.goto(`${base}/demo-gallery-cluttered.html`);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await wait(page, 1200);           // the cluttered image page first
  await inject(page);               // scripts are per-page; re-inject after navigation
  await page.evaluate(() => globalThis.OBR.openGallery());
  await wait(page, 2000);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 520);   // a slow drift down the masonry wall
  await wait(page, 1600);

  // ---- 5. the only text ---------------------------------------------------------
  await page.setContent(endCard(iconDataUri()));
  await wait(page, 2400);
  const tEnd = Date.now();

  const video = page.video();
  await ctx.close();                // finalizes the .webm — must precede video.path()
  const webm = await video.path();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const ff = (a) => execFileSync('ffmpeg', a, { stdio: ['ignore', 'ignore', 'inherit'] });
  const at = (t) => Math.max(0, (t - recStart) / 1000);

  // Full storyboard.
  ff(['-y', '-ss', String(at(t0)), '-t', String((tEnd - t0) / 1000), '-i', webm,
      '-vf', `scale=${W}:${H}:flags=lanczos,fps=30`, '-c:v', 'libx264', '-profile:v', 'high',
      '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT_VIDEO]);

  // Flip sub-window. Start ~0.5s early so page 1 is visible at the GIF's loop seam.
  const fss = Math.max(0, at(flipStart) - 0.5);
  const fdur = (flipEnd - flipStart) / 1000 + 0.8;
  ff(['-y', '-ss', String(fss), '-t', String(fdur), '-i', webm,
      '-vf', 'scale=960:-2:flags=lanczos,fps=24', '-c:v', 'libx264', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT_FLIP_MP4]);

  // GIF via a generated palette (flat quantisation bands badly on paper tones).
  const palette = path.join(videoDir, 'palette.png');
  const vf = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  ff(['-y', '-ss', String(fss), '-t', String(fdur), '-i', webm, '-vf', `${vf},palettegen=stats_mode=diff`, palette]);
  ff(['-y', '-ss', String(fss), '-t', String(fdur), '-i', webm, '-i', palette,
      '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`, '-loop', '0', OUT_FLIP_GIF]);

  fs.rmSync(videoDir, { recursive: true, force: true });
  const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1);
  console.log(`\n${flips} flips each way · ${((tEnd - t0) / 1000).toFixed(1)}s storyboard · silent · ${W}x${H}`);
  console.log(`  video -> ${path.relative(ROOT, OUT_VIDEO)}     (${mb(OUT_VIDEO)} MB)`);
  console.log(`  flip  -> ${path.relative(ROOT, OUT_FLIP_MP4)}  (${mb(OUT_FLIP_MP4)} MB)`);
  console.log(`  gif   -> ${path.relative(ROOT, OUT_FLIP_GIF)}  (${mb(OUT_FLIP_GIF)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
