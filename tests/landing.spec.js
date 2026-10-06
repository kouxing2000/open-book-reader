/* The landing page (site/index.html) is where every Share invite points. Two things a share
 * depends on fail silently, so they are pinned here: the ?ref=share-<surface> hand-off onto
 * the store button as UTM tags, and a link-preview image that actually exists.
 * site/read.html is where every "Share this article" link lands: it reads the article out of
 * the #fragment and, by asking the extension, shows a friend either how to get Open Book or
 * how to open the article in it. */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect } from './fixtures.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const LANDING = pathToFileURL(path.join(SITE, 'index.html')).href;
const STORE = 'https://chromewebstore.google.com/detail/kmcomogkbbdjhfocbncljmgcnfmaljca';

test('a share ref becomes store UTM tags; anything else leaves the store link alone', async ({ page }) => {
  const storeHref = async (query) => {
    await page.goto(LANDING + query);
    return page.locator('#store-link').getAttribute('href');
  };
  expect(await storeHref('?ref=share-end')).toBe(STORE + '?utm_source=share&utm_medium=end');
  expect(await storeHref('?ref=share-options')).toBe(STORE + '?utm_source=share&utm_medium=options');
  expect(await storeHref('')).toBe(STORE);
  expect(await storeHref('?ref=newsletter')).toBe(STORE);
  expect(await storeHref('?ref=' + encodeURIComponent('share-x&utm_source=evil'))).toBe(STORE);
});

test('the link-preview image is absolute and exists in site/', async ({ page }) => {
  await page.goto(LANDING);
  const meta = await page.evaluate(() => ({
    image: document.querySelector('meta[property="og:image"]')?.content || '',
    card: document.querySelector('meta[name="twitter:card"]')?.content || '',
  }));
  expect(meta.card).toBe('summary_large_image');
  const url = new URL(meta.image); // throws on a relative URL, which unfurlers can't resolve
  expect(url.origin).toBe('https://openbook.peach-studio.com');
  expect(existsSync(path.join(SITE, url.pathname))).toBe(true);
});

const READ = pathToFileURL(path.join(SITE, 'read.html')).href;
const ARTICLE = 'https://example.com/story?id=7';
const readLink = (base, u, t) => base + '#u=' + encodeURIComponent(u) + (t == null ? '' : '&t=' + encodeURIComponent(t));
const readState = (page) => page.evaluate(() => document.body.dataset.state);

test('read page without Open Book: the store button carries share UTM, the other opens the article', async ({ page }) => {
  await page.goto(readLink(READ, ARTICLE, 'Rock & Roll'));
  await expect.poll(() => readState(page)).toBe('missing');
  expect(await page.locator('#title').textContent()).toBe('Rock & Roll');
  expect(await page.locator('#domain').textContent()).toBe('example.com');
  expect(await page.locator('#store-link').getAttribute('href')).toBe(STORE + '?utm_source=share&utm_medium=article');
  expect(await page.locator('[data-for="missing"] .article-link').getAttribute('href')).toBe(ARTICLE);
  expect(await page.locator('[data-for="missing"]').isVisible()).toBe(true);
  expect(await page.locator('[data-for="installed"]').isVisible()).toBe(false);
});

test('read page shows a crafted title as text, under the real destination domain', async ({ page }) => {
  const title = '<img src=x onerror="window.__pwned=1">Your account is locked';
  await page.goto(readLink(READ, 'https://www.evil.test/login', title));
  await expect.poll(() => readState(page)).toBe('missing');
  expect(await page.locator('#title').textContent()).toBe(title);
  expect(await page.locator('main img').count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('#domain').textContent()).toBe('evil.test');
  expect(await page.locator('#dest').textContent()).toBe('https://www.evil.test/login');
});

test('a read link to anything but http(s) offers nothing to open', async ({ page }) => {
  for (const u of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', '', 'not a url']) {
    await page.goto('about:blank'); // a hash-only change would not re-run the page's script
    await page.goto(readLink(READ, u, 'x'));
    expect({ u, state: await readState(page) }).toEqual({ u, state: 'bad' });
    expect(await page.locator('.article-link[href]').count()).toBe(0);
  }
});

// Facebook and LinkedIn point a post at og:url; on this page that address would drop the '#…'
// carrying the article, so every such share would land on "incomplete link".
test('the read page declares no og:url, and its preview image exists', async ({ page }) => {
  await page.goto(readLink(READ, ARTICLE, 'Story'));
  const meta = await page.evaluate(() => ({
    url: document.querySelector('meta[property="og:url"]'),
    image: document.querySelector('meta[property="og:image"]')?.content || '',
  }));
  expect(meta.url).toBeNull();
  const img = new URL(meta.image);
  expect(img.origin).toBe('https://openbook.peach-studio.com');
  expect(existsSync(path.join(SITE, img.pathname))).toBe(true);
});

// Where no Chrome extension can run, the store button is a dead end: offer the article and say
// where Open Book runs instead.
test('on a phone the read page offers the article and says where Open Book runs', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent',
    { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }));
  await page.goto(readLink(READ, ARTICLE, 'Story'));
  expect(await readState(page)).toBe('unsupported');
  expect(await page.locator('[data-for="unsupported"] .article-link').getAttribute('href')).toBe(ARTICLE);
  expect(await page.locator('#store-link').isVisible()).toBe(false);
});

test('in a browser without Chrome extensions (Firefox, Safari) the read page skips the store button', async ({ page }) => {
  // Non-configurable, or Chrome's own window.chrome is installed over it after this runs.
  await page.addInitScript(() => { Object.defineProperty(window, 'chrome', { configurable: false, writable: false, value: undefined }); });
  await page.goto(readLink(READ, ARTICLE, 'Story'));
  expect(await page.evaluate(() => window.chrome)).toBeUndefined(); // the stand-in took
  expect(await readState(page)).toBe('unsupported');
  expect(await page.locator('#store-link').isVisible()).toBe(false);
});

// A page loaded before the extension was installed can't reach it, so the way back from the
// store tab must reload into a fresh document — the hand-off from "installed it" to "open it".
test('without Open Book, coming back to the tab asks again in a fresh document', async ({ page }) => {
  await page.goto(readLink(READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('missing');
  await page.evaluate(() => { window.__sameDoc = 1; });
  const setVisibility = (v) => page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);
  await setVisibility('hidden');
  expect(await page.evaluate(() => window.__sameDoc)).toBe(1); // leaving reloads nothing
  await Promise.all([page.waitForEvent('load'), setVisibility('visible').catch(() => {})]);
  expect(await page.evaluate(() => window.__sameDoc)).toBeUndefined();
  await expect.poll(() => readState(page)).toBe('missing');
});

// The real wiring, end to end: the shipped manifest's externally_connectable, the worker's
// onMessageExternal and read.html's ping. The page is served AT the production origin (routed
// to the local file) because that origin is the only one the extension will answer. An
// unpacked load gets its own id, so the page is served pinging THAT id in place of the store's
// (the store id itself is pinned by the store-link assertion above).
async function serveReadAt(context, origin, extensionId) {
  const html = readFileSync(path.join(SITE, 'read.html'), 'utf8');
  const storeId = STORE.split('/').pop();
  expect(html).toContain("var EXT_ID = '" + storeId + "'");
  const body = html.replace("var EXT_ID = '" + storeId + "'", "var EXT_ID = '" + extensionId + "'");
  await context.route(origin + '/**', (route) => new URL(route.request().url()).pathname === '/read'
    ? route.fulfill({ body, contentType: 'text/html' })
    : route.fulfill({ status: 404, body: '' }));
}

test('on the real site origin, an installed Open Book is detected', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.goto(readLink('https://openbook.peach-studio.com/read', ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('[data-for="installed"] .article-link').getAttribute('href')).toBe(ARTICLE);
});

test('the same page on any other origin cannot reach Open Book', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.evil.test', extensionId);
  await page.goto(readLink('https://openbook.evil.test/read', ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('missing');
});
