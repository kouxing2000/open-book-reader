/* Shared helpers for the reader feature tests. */

import path from 'path';
import { fileURLToPath } from 'url';
import { expect } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(__dirname, '..', 'src', 'content');

export const CONTENT_FILES = [
  path.join(CONTENT, 'settings.js'),
  path.join(CONTENT, 'readability.js'),
  path.join(CONTENT, 'reader.js'),
];

// Image-gallery mode needs settings + zip (for ZIP downloads) + gallery.
export const GALLERY_FILES = [
  path.join(CONTENT, 'settings.js'),
  path.join(CONTENT, 'zip.js'),
  path.join(CONTENT, 'gallery.js'),
];

// All modes together (for cross-mode switching tests).
export const ALL_FILES = [...CONTENT_FILES, path.join(CONTENT, 'zip.js'), path.join(CONTENT, 'gallery.js')];

/**
 * A minimal chrome.storage.sync shim backed by localStorage, injected into the
 * page before the reader scripts run. The reader normally runs in a content-script
 * world where chrome.storage exists; this test harness injects it into the page's
 * main world (because headless Playwright can't grant activeTab via a real toolbar
 * gesture), so we provide storage here. localStorage backing makes settings survive
 * a page reload, which lets us test persistence end-to-end.
 */
export function storageShim() {
  const listeners = [];
  // One localStorage-backed area (own backing key + change-event area name).
  const makeArea = (backingKey, areaName) => {
    const read = () => JSON.parse(localStorage.getItem(backingKey) || '{}');
    const write = (all) => localStorage.setItem(backingKey, JSON.stringify(all));
    return {
      get(keys, cb) {
        const all = read();
        const list = keys == null ? Object.keys(all) : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in all) out[k] = all[k];
        cb(out);
      },
      set(items, cb) {
        const before = read();
        write({ ...before, ...items });
        const changes = {};
        for (const k of Object.keys(items)) changes[k] = { oldValue: before[k], newValue: items[k] };
        listeners.forEach((fn) => fn(changes, areaName));
        if (cb) cb();
      },
    };
  };
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.storage = {
    sync: makeArea('__obr_test_store', 'sync'),
    local: makeArea('__obr_test_store_local', 'local'), // reading positions live here
    onChanged: { addListener: (fn) => listeners.push(fn) },
  };
}

/** Navigate to the fixture article with the storage shim installed. */
export async function gotoArticle(page) {
  await page.addInitScript(storageShim);
  await page.goto('/article.html');
}

/** Load the responsive-image article (a <picture> lead figure whose real image lives in
 *  <source srcset> behind a grey placeholder, plus a genuinely-empty placeholder figure). */
export async function gotoPictureArticle(page) {
  await page.addInitScript(storageShim);
  await page.goto('/picture-article.html');
}

/** Load the illustrated-article fixture (real prose + 12 figures) and wait for the
 *  figures to decode, so OBR._imageCount and OBR._articleWordCount both see real data. */
export async function gotoIllustratedArticle(page) {
  await page.addInitScript(storageShim);
  await page.goto('/illustrated-article.html');
  await page.waitForFunction(
    () => document.images.length >= 12 && Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0)
  );
}

/** Inject the three content scripts (mirrors background.js FILES order). */
export async function injectReader(page) {
  for (const file of CONTENT_FILES) {
    await page.addScriptTag({ path: file });
  }
}

/** Open the reader and wait until pagination has been computed. */
export async function openReader(page) {
  await page.evaluate(() => globalThis.OBR.open());
  await expect.poll(() => readState(page).then((s) => s.indicator)).toContain('pages');
}

/** Read the reader's observable state out of the open shadow DOM. */
export function readState(page) {
  return page.evaluate(() => {
    const host = document.getElementById('obr-host');
    if (!host) return { present: false };
    const root = host.shadowRoot;
    const pages = root.querySelector('.obr-pages');
    const overlay = root.querySelector('.obr-overlay');
    const indicator = root.querySelector('.obr-indicator')?.textContent || '';
    const m = indicator.match(/\/\s*(\d+)\s*pages/);
    const transform = pages?.style.transform || '';
    const tx = (transform.match(/-?\d+(\.\d+)?/) || [0])[0];
    return {
      present: true,
      hostDisplay: getComputedStyle(host).display,
      theme: (overlay?.className.match(/obr-overlay (\w+)/) || [, ''])[1],
      title: root.querySelector('.obr-doc-title')?.textContent || '',
      imagesBadge: root.querySelector('.obr-seg-badge')?.textContent || '',
      contentText: root.querySelector('.obr-content')?.textContent || '',
      indicator,
      totalColumns: m ? Number(m[1]) : 0,
      fontSize: parseFloat(pages?.style.fontSize || '0'),
      translateX: Number(tx),
      meta: root.querySelector('.obr-doc-meta')?.textContent || '',
      progressWidth: root.querySelector('.obr-progress-fill')?.style.width || '',
    };
  });
}

/** Click a control/zone inside the reader's shadow DOM (Playwright pierces open roots). */
export async function clickInReader(page, selector) {
  await page.locator(`#obr-host >> ${selector}`).click();
}

/** Click inside the gallery's shadow DOM. */
export async function clickInGallery(page, selector) {
  await page.locator(`#obr-gallery-host >> ${selector}`).click();
}

/* ----------------------------------------------------------------- gallery */

/**
 * Stub the background service worker the gallery talks to for downloads. The
 * main-world test harness has no extension SW, so we record outgoing messages on
 * window.__obrMsgs and answer obr-fetch-bytes with dummy bytes so the ZIP path runs.
 */
export function downloadShim() {
  window.__obrMsgs = [];
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.runtime = {
    lastError: null,
    sendMessage(msg, cb) {
      window.__obrMsgs.push(msg);
      let resp = { ok: true };
      if (msg && msg.type === 'obr-fetch-bytes') {
        resp = { results: (msg.urls || []).map((url) => ({ url, ok: true, b64: 'iVBORw0KGgo=' })) };
      }
      if (cb) setTimeout(() => cb(resp), 0);
    },
  };
}

/** Load the image-heavy fixture and wait for its <img>s to decode (natural size set). */
export async function gotoImages(page) {
  await page.addInitScript(storageShim);
  await page.addInitScript(downloadShim);
  await page.goto('/images.html');
  await page.waitForFunction(
    () => document.images.length >= 7 && Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0)
  );
}

/** Load the lazy / infinite-scroll fixture (3 normal + 1 placeholder-lazy image;
 *  2 more appear only once the page is scrolled). Waits for the initial images. */
export async function gotoLazyImages(page) {
  await page.addInitScript(storageShim);
  await page.addInitScript(downloadShim);
  await page.goto('/lazy-images.html');
  await page.waitForFunction(() => document.images.length >= 4 && Array.from(document.images).every((i) => i.complete));
}

/** Load the "grows on scroll but never mounts a new image" fixture (4 initial tiles;
 *  every downward scroll appends an image-less spacer and bumps window.__grows). Used to
 *  pin the progressive-hydration / auto-scroll stop behaviour on infinite-scroll pages. */
export async function gotoGrowNoImages(page) {
  await page.addInitScript(storageShim);
  await page.addInitScript(downloadShim);
  await page.goto('/grow-no-images.html');
  await page.waitForFunction(() => document.images.length >= 4 && Array.from(document.images).every((i) => i.complete));
}

/** Messages the gallery sent to the (stubbed) service worker. */
export function sentMessages(page) {
  return page.evaluate(() => window.__obrMsgs || []);
}

export async function injectGallery(page) {
  for (const file of GALLERY_FILES) await page.addScriptTag({ path: file });
}

export async function injectAll(page) {
  for (const file of ALL_FILES) await page.addScriptTag({ path: file });
}

export async function openGallery(page) {
  await page.evaluate(() => globalThis.OBR.openGallery());
  await expect.poll(() => galleryState(page).then((s) => s.tiles)).toBeGreaterThan(0);
}

/** Read the gallery's observable state out of its shadow DOM. */
export function galleryState(page) {
  return page.evaluate(() => {
    const host = document.getElementById('obr-gallery-host');
    if (!host) return { present: false, tiles: 0 };
    const r = host.shadowRoot;
    const lb = r.querySelector('.lb');
    const strip = r.querySelector('.lb-strip');
    const controls = r.querySelector('.lb-slideshow');
    const activeThumb = strip && strip.querySelector('.lb-thumb.is-active');
    return {
      present: true,
      hostDisplay: getComputedStyle(host).display,
      count: r.querySelector('.count')?.textContent || '',
      tiles: r.querySelectorAll('.tile').length,
      lbOpen: lb?.classList.contains('open') || false,
      lbCounter: r.querySelector('.lb-counter')?.textContent || '',
      filmstrip: strip ? strip.querySelectorAll('.lb-thumb').length : 0,
      filmstripActive: activeThumb ? +activeThumb.dataset.idx : -1,
      filmstripHidden: strip ? strip.classList.contains('is-hidden') : true,
      controlsHidden: controls ? controls.classList.contains('is-hidden') : true,
      cols: r.querySelectorAll('.col').length,
      selCount: r.querySelector('.selcount')?.textContent || '',
      status: r.querySelector('.status')?.textContent || '',
      dlSelDisabled: r.querySelector('.dl-sel') ? r.querySelector('.dl-sel').disabled : true,
      scrollTop: r.querySelector('.scroll')?.scrollTop || 0,
      autoOn: r.querySelector('.autoscroll')?.classList.contains('on') || false,
      autoSpeed: r.querySelector('.autospeed-in')?.value || '',
    };
  });
}
