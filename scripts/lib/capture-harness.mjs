// Shared capture harness for the marketing/asset scripts.
//
// capture-screenshots.mjs and capture-promo.mjs both need the same things: the
// content-script list in background.js's injection ORDER, a page carrying the chrome.storage
// and chrome.i18n shims the main-world scripts need, a static server for tests/fixtures, and
// a page-clock wait. It was two verbatim copies (identical but for the port), so it lives
// here once. Everything genuinely per-asset — the storyboard, the encode flags, the shot
// list — deliberately stays in the scripts.
//
// The injection order is load-bearing and mirrors background.js: settings defines the OBR
// namespace, reader.style supplies OBR._readerCSS, reader needs DEFAULTS + Readability, and
// zip supplies OBR._buildZip for the gallery's ZIP download. Reordering breaks the engine.

import http from 'http';
import { execFileSync } from 'node:child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const CONTENT = path.join(ROOT, 'src', 'content');
export const OUT = path.join(ROOT, 'store-assets');

const CONTENT_FILES = ['settings.js', 'readability.js', 'reader.style.js', 'reader.js', 'zip.js', 'gallery.js']
  .map((f) => path.join(CONTENT, f));

// chrome.storage.sync shim (localStorage-backed) for the injected main-world scripts.
// Serialized into the page by addInitScript, so it must stay self-contained — no imports,
// no closure over anything in this module.
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

// chrome.i18n shim. THE TRAP: the content scripts are injected into the MAIN world by
// addScriptTag, where chrome.i18n does not exist, so OBR.t() falls back to echoing the KEY —
// any capture that shows the reader's toolbar then renders `readerBtnThemeLabel`,
// `readerPageIndicator`, `readerFooterHint` as visible UI text on a marketing asset. This is
// NOT hypothetical and NOT limited to the video: capture-screenshots.mjs deliberately does
// `page.mouse.move(640, 8)` to REVEAL the topbar before shot 02, so a plain re-run puts raw
// identifiers straight into a Web Store screenshot.
//
// Which is why this is not exported for callers to remember — use preparePage() below. An
// earlier version of this file left both shims as opt-in pieces and immediately shipped a
// promo-flip.mp4 full of raw keys, because the two migrated scripts were never rewired.
//
// Returns an addInitScript ARGUMENT PAIR — [fn, messages] — because the catalog has to be
// read in node and handed across; an init script can't read the filesystem.
function i18nShimArgs() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));
  const fn = (msgs) => {
    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.i18n = {
      getMessage: (key, subs) => {
        const entry = msgs[key];
        if (!entry) return '';
        let out = entry.message;
        const list = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
        // Placeholders map a $NAME$ token to a positional "$1"/"$2" content slot.
        for (const [name, def] of Object.entries(entry.placeholders || {})) {
          const idx = parseInt(String(def.content).replace('$', ''), 10) - 1;
          const val = String(list[idx] ?? '');
          out = out.replace(new RegExp('\\$' + name + '\\$', 'gi'), () => val); // fn form: no $& expansion
        }
        return out;
      },
      getUILanguage: () => 'en',
    };
  };
  return [fn, catalog];
}

/** Static server for tests/fixtures. Path-escape guarded; defaults to the demo article. */
export function serveFixtures(port) {
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
    .listen(port);
}

/**
 * The ONLY supported way to get a page out of a capture context. Both shims are applied
 * here so a caller cannot construct an unshimmed page and quietly ship raw i18n keys —
 * closing the trap instead of documenting it. Must run before any navigation, which is
 * why it takes the context rather than a page.
 */
export async function preparePage(ctx) {
  // CONTEXT-scoped, not page-scoped. Page-scoped shimming only protects the one page it is
  // called on, so a later ctx.newPage() would silently yield an unshimmed page and put raw
  // i18n keys back on a marketing asset. Registering on the context makes the guarantee
  // structural: every page in this context is shimmed, including ones nobody remembered.
  // (Applies on the next navigation, and every caller goto()s after this.)
  await ctx.addInitScript(storageShim);
  await ctx.addInitScript(...i18nShimArgs());
  return ctx.pages()[0] || (await ctx.newPage());
}

/** Inject the content scripts the way background.js does on a toolbar gesture. */
export async function inject(page) {
  for (const f of CONTENT_FILES) await page.addScriptTag({ path: f });
}

/** Wait on the PAGE's clock, so the pause lands in the recorded video's timeline. */
export const wait = (page, ms) => page.evaluate((d) => new Promise((r) => setTimeout(r, d)), ms);

// SIGKILL anything still holding this run's unique --user-data-dir. Mirrors
// tests/fixtures.js's killByProfile; the dir is a fresh mkdtemp path, so it cannot match
// another run, let alone another program.
function killByProfile(dir) {
  let out = '';
  try { out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }); }
  catch { return; } // no ps — nothing safe to do here
  for (const line of out.split('\n')) {
    if (line.indexOf(dir) === -1) continue;
    const pid = parseInt(line, 10);
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}

/**
 * Tear a capture context down WITHOUT letting it hang the cleanup behind it.
 *
 * tests/fixtures.js documents (reproduced on macOS across three bundled Chromium builds,
 * and below Playwright with a bare spawn) that Chromium ignores the graceful SIGTERM and
 * never exits, so `context.close()` never settles. A `finally` that simply awaits close()
 * therefore never reaches the lines after it — leaking exactly the temp dirs it was added
 * to remove, and hanging instead of exiting. So: bound the close, then hard-kill by
 * profile dir, then remove the dirs with retries (signal delivery is instant, process
 * teardown is not, and Chromium may still be flushing the profile — without retries an
 * ENOTEMPTY/EBUSY race throws out of `finally` and REPLACES the real error).
 *
 * @param {import('playwright-core').BrowserContext|null} ctx
 * @param {boolean} alreadyClosed  skip the close (the caller closed it to finalize a video)
 * @param {string[]} dirs          temp dirs to remove; the first is the browser profile
 */
export async function closeCapture(ctx, alreadyClosed, dirs) {
  if (ctx && !alreadyClosed) {
    await Promise.race([
      ctx.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }
  if (dirs[0]) killByProfile(dirs[0]);
  for (const d of dirs) {
    if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
