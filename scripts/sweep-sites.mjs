// Real-site extraction sweep (audit track A4).
//
// Drives the REAL engine over the manual site proxy against a list of real URLs and scores
// what came out. This is the only thing in the repo that measures the product's core value —
// extraction quality — rather than its plumbing. Everything the unit suite does is against
// fixtures we wrote, which can only ever confirm what we already thought.
//
//   node scripts/sweep-sites.mjs                 # all of tests/fixtures/sweep-sites.json
//   node scripts/sweep-sites.mjs --cat news      # one category
//   node scripts/sweep-sites.mjs --url https://… # one URL, verbose
//   node scripts/sweep-sites.mjs --out metrics/sweep.json
//
// READ THE VERDICTS RIGHT. A snapshot fetch is not a browser: the proxy strips scripts to
// freeze the SSR DOM, so a client-rendered page with no SSR, or a paywall, returns a page the
// extension would never see in real use. Those score SNAPSHOT, not FAIL — calling them
// extension bugs is the mistake this sweep exists to avoid making twice.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8351;
const NAV_TIMEOUT = 45000;

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const outPath = argOf('--out') || path.join(ROOT, 'metrics', 'sweep-sites.json');

let sites = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'sweep-sites.json'), 'utf8'));
if (argOf('--url')) sites = [{ cat: 'adhoc', url: argOf('--url') }];
else if (argOf('--cat')) sites = sites.filter((s) => s.cat === argOf('--cat'));

/* ---------------------------------------------------------------- measurement
 * Runs in the page. Everything here is read off the SAME helpers the engine uses on a real
 * page (OBR._proseStats, OBR._countWords), so `kept/live` is literally the ratio
 * _wholeExtractionSuspect judges on — the product's own quality signal, not a new one
 * invented for the sweep. */
async function measure() {
  const out = { ok: false };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  try {
    // BEFORE opening: what the live page actually holds.
    out.pageTitle = norm(document.title).slice(0, 160);
    out.livePose = globalThis.OBR._proseStats();
    out.live = out.livePose.words;
    out.pageImages = document.images.length;

    globalThis.OBR.toggle();
    await new Promise((r) => setTimeout(r, 1200)); // extraction + first paginate

    const host = document.getElementById('obr-host');
    if (!host || !host.shadowRoot) { out.err = 'no reader host'; return out; }
    const content = host.shadowRoot.querySelector('.obr-content');
    if (!content) { out.err = 'no .obr-content'; return out; }

    const h1 = content.querySelector('.obr-doc-h1');
    out.title = norm(h1 && h1.textContent).slice(0, 160);
    const byline = content.querySelector('.obr-byline');
    out.byline = norm(byline && byline.textContent).slice(0, 120);

    // Body only. The <h1>, byline and colophon are the READER's own chrome, not the page's —
    // counting the colophon added ~10 words of our own UI to every single row and would have
    // shown up as extraction coverage.
    const bodyText = Array.from(content.children)
      .filter((el) => !el.classList.contains('obr-doc-h1') && !el.classList.contains('obr-byline')
                   && !el.classList.contains('obr-colophon'))
      .map((el) => el.textContent).join(' ');
    out.kept = globalThis.OBR._countWords(bodyText);
    out.paras = content.querySelectorAll('p').length;
    out.imgs = content.querySelectorAll('img').length;
    // Link DENSITY is the boilerplate tell: a nav/related-links block that slipped into the
    // article is mostly anchors, while real prose is mostly not. Word ratio alone cannot see
    // it, because such a block makes `kept` go UP, which looks like better coverage.
    out.links = content.querySelectorAll('a').length;
    out.linksPer100w = out.kept ? +(out.links / (out.kept / 100)).toFixed(1) : 0;
    out.ratio = out.live ? +(out.kept / out.live).toFixed(2) : null;
    // Ask the ENGINE for its verdict rather than re-deriving it: _wholeExtractionSuspect is
    // what gates the user-facing "this extraction looks wrong" nag, and a sweep that reported
    // a lookalike ratio of its own would be measuring the sweep, not the product.
    out.suspect = globalThis.OBR._wholeExtractionSuspect({ content: '<p>x</p>', textContent: bodyText });

    globalThis.OBR.close();
    await new Promise((r) => setTimeout(r, 200));
    globalThis.OBR.toggleGallery();
    await new Promise((r) => setTimeout(r, 900));
    const gh = document.getElementById('obr-gallery-host');
    out.tiles = gh && gh.shadowRoot ? gh.shadowRoot.querySelectorAll('.tile').length : 0;
    globalThis.OBR.closeGallery();

    out.ok = true;
  } catch (e) {
    out.err = String(e && e.message ? e.message : e);
  }
  return out;
}

/* A site list ROTS. Slugs 404, and a 404 page is still a valid HTML page with a nav bar, so
 * it extracts "successfully" and scores PASS — on the first run of this sweep, 11 of 42 URLs
 * were dead or bot-walled and several were graded PASS. A grade computed from a page the
 * target site never served is worse than no grade, so this runs BEFORE any scoring. Matching
 * on the page's own <title> because the proxy follows redirects and most sites serve their
 * 404 body with HTTP 200. */
const DEAD_TITLE = /(^|\W)(404|not found|page unavailable|page not found)(\W|$)/i;
const WALL_TITLE = /just a moment|attention required|are you a robot|not a bot|access denied|cloudflare|enable javascript/i;
// Non-English 404 titles, one per locale in the list — these must be spelled out; a regex for
// "404" alone does not match any of them.
const DEAD_INTL = /見つかりませんでした|찾을 수 없|页面不存在|الصفحة غير موجودة|página no encontrada|seite nicht gefunden/i;

/* Verdict. SNAPSHOT is deliberately not a failure grade — see the header. */
function grade(r) {
  if (r.httpStatus && r.httpStatus !== 200) return r.httpStatus === 502 || r.httpStatus === 415 ? 'SNAPSHOT' : 'FETCH';
  const title = r.pageTitle || '';
  if (DEAD_TITLE.test(title) || DEAD_INTL.test(title)) return 'DEADURL';
  if (WALL_TITLE.test(title)) return 'BOTWALL';
  if (!r.ok) return 'FAIL';
  if (r.live < 50 && r.kept < 50) return 'SNAPSHOT';       // nothing was in the frozen DOM
  if (!r.kept) return 'FAIL';                               // reader opened empty on real prose
  if (r.live >= 200 && r.ratio < 0.5) return 'THIN';        // _wholeExtractionSuspect's own rule
  if (!r.title) return 'NOTITLE';
  // WIDE is a REVIEW flag, not a failure: kept far exceeds the page's substantial-prose total,
  // which happens both when boilerplate was dragged in AND when an article is legitimately made
  // of short blocks (`live` only counts leaf blocks of >=20 words). Every WIDE row was read by
  // hand; see docs/audit/sweep-2026-09-04.md. Link density is NOT a grade — Wikipedia scores
  // ~9 links/100w on a textbook-clean extraction, so grading on it manufactures failures.
  if (r.ratio > 2.5) return 'WIDE';
  return 'PASS';
}

(async () => {
  const proxy = spawn('node', [path.join(ROOT, 'tests', 'manual-site-proxy.mjs'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Race the ready line against the proxy dying: an already-bound port makes it exit immediately,
  // and waiting on stdout alone then hangs forever with the real reason already printed on stderr.
  await new Promise((res, rej) => {
    proxy.stdout.once('data', res);
    proxy.once('exit', (code) => rej(new Error(`manual-site-proxy exited (${code}) before it was ready — is port ${PORT} already in use?`)));
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(NAV_TIMEOUT);

  /* This script reads engine internals (_proseStats, _countWords, _wholeExtractionSuspect)
   * and shadow-DOM class names, and nothing in `npm test` covers that coupling. A rename
   * would land here as a sweep where every row scores badly — a plausible-looking regression
   * report about the ENGINE rather than about this file. Two checks stop that.
   *
   * First, up front and network-free: are the helper names still there? The engine bundle is
   * loaded onto the proxy's own index page, so no live site can make this fail for the wrong
   * reason. The DOM half can't be checked here (there is no article to render) — it is the
   * end-of-run check below instead. */
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/engine.js' });
  const missing = await page.evaluate(() =>
    ['_proseStats', '_countWords', '_wholeExtractionSuspect', 'toggle', 'toggleGallery', 'close']
      .filter((k) => !globalThis.OBR || typeof globalThis.OBR[k] !== 'function'));
  if (missing.length) {
    await browser.close(); proxy.kill();
    throw new Error(`sweep self-check failed — OBR no longer exposes: ${missing.join(', ')}. Fix the runner; its grades would be meaningless.`);
  }

  const results = [];

  for (const site of sites) {
    const row = { cat: site.cat, url: site.url };
    const started = Date.now();
    try {
      const resp = await page.goto(`http://127.0.0.1:${PORT}/read?u=${encodeURIComponent(site.url)}`, {
        waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT,
      });
      row.httpStatus = resp ? resp.status() : 0;
      if (row.httpStatus === 200) {
        await page.waitForFunction(() => globalThis.OBR && globalThis.OBR.toggle, null, { timeout: 15000 });
        Object.assign(row, await page.evaluate(measure));
      }
    } catch (e) {
      row.err = String(e && e.message ? e.message : e).split('\n')[0].slice(0, 160);
    }
    row.ms = Date.now() - started;
    row.grade = grade(row);
    results.push(row);
    console.log(
      `${row.grade.padEnd(8)} ${String(row.cat).padEnd(9)} kept=${String(row.kept ?? '-').padStart(6)}` +
      ` live=${String(row.live ?? '-').padStart(6)} ratio=${String(row.ratio ?? '-').padStart(5)}` +
      ` a/100w=${String(row.linksPer100w ?? '-').padStart(5)} img=${String(row.imgs ?? '-').padStart(3)}` +
      ` tiles=${String(row.tiles ?? '-').padStart(3)}  ${row.url.slice(0, 62)}`
    );
  }

  await browser.close();
  proxy.kill();

  // Second half of the self-check. If NO row anywhere found `.obr-content`, the shadow-DOM
  // names this file reads are wrong — every grade below is then a fact about the runner, not
  // about the sites. Refuse to write a report rather than publish 42 confident FAILs.
  if (results.length > 2 && !results.some((r) => r.ok)) {
    throw new Error('sweep self-check failed — not one page produced a readable overlay. Check the .obr-* class names in measure() before reading anything into these grades.');
  }

  const tally = results.reduce((a, r) => ((a[r.grade] = (a[r.grade] || 0) + 1), a), {});
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), tally, results }, null, 2));
  console.log('\n' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`wrote ${outPath}`);
})();
