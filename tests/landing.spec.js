/* The landing page (site/index.html) is where every Share invite points. Two things a share
 * depends on fail silently, so they are pinned here: the ?ref=share-<surface> hand-off onto
 * the store button as UTM tags, and a link-preview image that actually exists. */

import path from 'node:path';
import { existsSync } from 'node:fs';
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
