/* Confirms the extension actually loads in a real Chromium: the background
 * service worker registers and Chrome parses the manifest we ship. */

import { test, expect } from './fixtures.js';

test('background service worker registers with a valid extension id', async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/); // Chrome extension IDs are 32 chars, a-p
});

test('the SW importScripts settings.js — shared helpers are live in the worker', async ({ serviceWorker }) => {
  // background.js reuses settings.js (host normalization + the legacy sites→siteRules
  // migration) via importScripts. A wrong path would make the SW throw at load and never
  // register, so this both proves the import resolved AND that the shared helpers are usable
  // server-side (the context-menu "Always open this site as …" rule handler depends on them).
  const out = await serviceWorker.evaluate(() => ({
    hasNormalizeHost: typeof globalThis.OBR?.normalizeHost === 'function',
    hasUpsert: typeof globalThis.OBR?.upsertSiteRule === 'function',
    normalized: globalThis.OBR?.normalizeHost('https://WWW.Example.com/p?x=1'),
  }));
  expect(out.hasNormalizeHost).toBe(true);
  expect(out.hasUpsert).toBe(true);
  expect(out.normalized).toBe('example.com');
});

test('Chrome loads the shipped manifest (name + minimal install permissions)', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/manifest.json`);
  const manifest = JSON.parse(await page.locator('body').innerText());

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBe('Open Book Reader');
  // Install asks for only the minimal set — nothing scary at install time.
  // (contextMenus adds the right-click "Open in Book Reader" surface; no install warning.)
  expect(manifest.permissions.sort()).toEqual(['activeTab', 'contextMenus', 'scripting', 'storage']);
  expect(manifest.host_permissions).toBeUndefined();
  // downloads + <all_urls> are OPTIONAL, requested on first image download.
  expect(manifest.optional_permissions).toEqual(['downloads']);
  expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
});

test('by default the SW holds no downloads/host access (opt-in only)', async ({ serviceWorker }) => {
  // The privacy-by-default posture: until the user grants the optional permissions
  // on first download, the SW has neither chrome.downloads nor cross-origin fetch.
  const caps = await serviceWorker.evaluate(async () => {
    const hasDownloads = typeof chrome?.downloads?.download === 'function';
    const containsDownloads = await chrome.permissions.contains({ permissions: ['downloads'] });
    const containsHost = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    let fetchBlocked = false;
    try { await fetch('http://localhost:5099/pic.png'); } catch (e) { fetchBlocked = true; }
    return { hasDownloads, containsDownloads, containsHost, fetchBlocked };
  });
  expect(caps.containsDownloads).toBe(false); // optional permission not yet granted
  expect(caps.containsHost).toBe(false);      // optional host access not yet granted
  expect(caps.hasDownloads).toBe(false);      // chrome.downloads appears only after grant
  expect(caps.fetchBlocked).toBe(true);       // cross-origin fetch blocked without host access
});
