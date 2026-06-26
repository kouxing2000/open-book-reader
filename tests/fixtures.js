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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..'); // repo root = unpacked extension

export const test = base.extend({
  // A persistent context with the extension loaded. One per test (clean storage).
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obr-e2e-'));
    const headed = process.env.HEADED === 'true';

    const args = [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ];
    if (!headed) args.push('--headless=new');

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // must be false for extensions; mode is set via the arg above
      args,
      viewport: { width: 1280, height: 800 },
    });

    await use(context);

    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  // The extension's background service worker.
  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
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
