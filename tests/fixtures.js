/* Playwright fixtures for loading the unpacked Open Book Reader extension.
 *
 * Pattern adapted from the retired AiEditorChromePlugin: launch a *persistent*
 * Chromium context with --load-extension, then read the extension ID off the
 * background service worker. Extensions require headless=new (the modern headless
 * mode); the old --headless mode cannot run MV3 service workers.
 */

import { test as base, chromium, expect } from '@playwright/test';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..'); // repo root = unpacked extension

/** SIGKILL every process whose command line contains `dir`, matched LITERALLY.
 *  Deliberately not `pkill -f`: that takes an extended REGEX, and `dir` comes from
 *  os.tmpdir(), which honours $TMPDIR — a `(` or `[` in there makes pkill fail (silently, so
 *  nothing is killed and the hang returns) and other metacharacters widen the match. Listing
 *  processes and comparing with indexOf has neither problem. */
function killByProfile(dir) {
  let out = '';
  // -ww: never truncate the command line to terminal width (Linux procps does by default,
  // which would hide the --user-data-dir we match on).
  try { out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }); }
  catch (e) { return; } // no ps (or it failed) — nothing safe to do here
  for (const line of out.split('\n')) {
    if (line.indexOf(dir) === -1) continue;
    const pid = parseInt(line, 10);
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
  }
}

export const test = base.extend({
  // A persistent context with the extension loaded. One per test (clean storage).
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-e2e-'));
    const headed = process.env.HEADED === 'true';

    const args = [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      // Pin the browser UI language so chrome.i18n resolves to English on any machine.
      // Extension PAGES (options / welcome / report / permission) are real pages where
      // chrome.i18n follows the browser locale — without this, the suite renders in the
      // dev's OS locale (e.g. zh_CN) and locale-specific text assertions break. Content
      // scripts are unaffected (the harness shims chrome.i18n to _locales/en separately).
      // `--lang` works on Linux (CI); macOS IGNORES it and reads the OS locale (handled by
      // the AppleLanguages override in tests/global-setup.js).
      '--lang=en-US',
    ];
    if (!headed) args.push('--headless=new');

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // must be false for extensions; mode is set via the arg above
      args,
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    await use(context);

    // BOUND THE TEARDOWN. Playwright closes a browser gracefully — SIGTERM, then wait for the
    // process to exit — and Chromium can simply never exit: verified on macOS across three
    // bundled builds (and with a bare spawn + SIGTERM, so it is below Playwright), the browser
    // disconnects but its process keeps spinning and only dies on SIGKILL. context.close() then
    // never settles and EVERY test fails with "Tearing down context exceeded the test timeout"
    // while the test body itself passed — a whole-suite outage with no relation to the code
    // under test. The browser is already disconnected by then, so waiting buys nothing: give it
    // a moment, then hard-kill whatever still belongs to THIS context's --user-data-dir (a
    // unique mkdtemp path, so it cannot match another run, let alone another program).
    // Where close() behaves, the race returns immediately and the kill matches nothing.
    // A close() REJECTION is a different animal from the hang and is re-thrown below: the
    // bound exists for a browser that will not exit, and must not also swallow a crashed
    // renderer or a page that blocked teardown, which are real signals about the code
    // under test.
    const outcome = await Promise.race([
      context.close().then(() => 'closed', (e) => e),
      new Promise((r) => setTimeout(() => r('hung'), 1500)),
    ]);
    killByProfile(userDataDir);
    // Signal delivery is instant; process teardown is not, and Chromium may still be flushing
    // the profile. Without retries an ENOTEMPTY/EBUSY race throws out of the fixture and
    // reports a PASSING test as failed — a new flake in the place a flake fix was intended.
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (outcome !== 'closed' && outcome !== 'hung') throw outcome;
  },

  // The extension's background service worker.
  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    // START THE WORKER before any test evaluates in it. Evaluating in an MV3 worker Chrome has
    // not brought up does NOT throw — Playwright waits for an execution context that never
    // arrives — so the test dies on the 30s timeout with no stack, no message, and no hint
    // that the worker was the problem. `serviceWorker.evaluate(() => 1 + 1)` reproduces it.
    // Measured on macOS across repeated fresh launches: the FIRST evaluate after launch hangs
    // 6/6; loading a page in the extension's OWN ORIGIN and evaluating again succeeds 6/6, and
    // the worker then stays evaluable (verified across a 35s idle). So: open the origin, fire
    // one throwaway evaluate — that is the call that hangs, so it is deliberately never
    // awaited — open it again, and only hand the worker over once it answers. Costs ~400ms
    // here; where the first evaluate already works (Linux CI, which is green on this same
    // Playwright) every step below is a fast no-op.
    // manifest.json is the waker deliberately: a static file, so no extension script runs and
    // the fixture contributes no side effects of its own. about:blank and data: pages do NOT
    // work — it is the extension ORIGIN that matters, not merely having another page open.
    const wakeUrl = `chrome-extension://${sw.url().split('/')[2]}/manifest.json`;
    const wake = async () => {
      const p = await context.newPage();
      try { await p.goto(wakeUrl); } finally { await p.close().catch(() => {}); }
    };
    await wake();
    sw.evaluate(() => true).catch(() => {}); // priming call — may never settle, by design
    let ready = false;
    // 3 x 3.5s plus four short navigations stays comfortably inside the 30s test timeout, so a
    // worker that never wakes reports the explicit error below instead of an unexplained
    // Playwright timeout.
    for (let i = 0; i < 3 && !ready; i++) {
      await wake().catch(() => {}); // a transient navigation failure should retry, not abort
      ready = await Promise.race([
        sw.evaluate(() => true).then(() => true, () => false),
        new Promise((r) => setTimeout(() => r(false), 3500)),
      ]);
    }
    // Fail LOUDLY rather than let the test body inherit a worker that hangs on first touch.
    if (!ready) throw new Error('service worker never became evaluable — see the MV3 note in tests/fixtures.js');
    await use(sw);
  },

  // The extension ID (derived from the service worker URL).
  extensionId: async ({ serviceWorker }, use) => {
    const id = serviceWorker.url().split('/')[2];
    await use(id);
  },

  // Reuse the persistent context's initial page instead of opening a new one.
  page: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },
});

export { expect };
