/* The landing page (site/index.html) is where every Share invite points. Two things a share
 * depends on fail silently, so they are pinned here: the ?ref=share-<surface> hand-off onto
 * the store button as UTM tags, and a link-preview image that actually exists.
 * site/read.html is where every "Share this article" link lands: it reads the article out of
 * the #fragment and, by asking the extension, either shows a friend how to get Open Book or,
 * when it is installed, goes straight on to the article. site/404.html stands in for it if it
 * is ever missing. */

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
  // Step 2 waits for Open Book; whoever already has it is told the one step that works.
  const step2 = page.locator('[data-for="missing"] button', { hasText: 'Read it as a book' });
  expect(await step2.isDisabled()).toBe(true);
  expect(await page.locator('[data-for="missing"]').textContent()).toContain('Already have Open Book? Open the article and press Alt+B.');
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
// onMessageExternal and read.html. The page is served AT the production origin (routed to the
// local file) because that origin is the only one the extension will answer, and it reaches the
// unpacked build through the page's own developer switch (localStorage 'obr-ext-id'), since an
// unpacked load gets its own id. The store id itself is pinned by the store-link assertion above.
async function serveReadAt(context, origin, extensionId) {
  const body = readFileSync(path.join(SITE, 'read.html'), 'utf8');
  await context.addInitScript((id) => { try { localStorage.setItem('obr-ext-id', id); } catch (e) { /* */ } }, extensionId);
  await context.route(origin + '/**', (route) => new URL(route.request().url()).pathname === '/read'
    ? route.fulfill({ body, contentType: 'text/html' })
    : route.fulfill({ status: 404, body: '' }));
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ body: '<title>The article</title><p>story</p>', contentType: 'text/html' }));
}
const LIVE_READ = 'https://openbook.peach-studio.com/read';
const countdown = (page) => page.locator('#countdown').textContent();
// Headless, the worker holds no real host grant (only its grant CHECK is stubbed), so Chrome hides
// tab URLs from it, while with the real all-sites grant it sees them. Stand in for that: the test
// names each URL it is about to load, and the worker's tabs.onUpdated listeners receive it as
// tab.url. Without this, the hand-off would rightly refuse a load it cannot identify.
async function seeTabUrls(serviceWorker) {
  await serviceWorker.evaluate(() => {
    const ev = chrome.tabs.onUpdated, wrapped = new Map();
    const add = ev.addListener.bind(ev), remove = ev.removeListener.bind(ev);
    ev.addListener = (fn) => {
      const w = (id, info, t) => fn(id, info, Object.assign({}, t, { url: (t && t.url) || globalThis.__loading }));
      wrapped.set(fn, w);
      add(w);
    };
    ev.removeListener = (fn) => { remove(wrapped.get(fn) || fn); wrapped.delete(fn); };
  });
}
const loading = (serviceWorker, url) => serviceWorker.evaluate((u) => { globalThis.__loading = u; }, url);

// Not opted in: the page ASKS FIRST, because the opt-in is what makes every later link
// seamless and a countdown would hurry people past it.
test('installed, not opted in: the page asks first and waits; Just this once goes to the article', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('#ask-panel').isVisible()).toBe(true);
  expect(await page.locator('#count-panel').isVisible()).toBe(false);
  expect(await page.locator('#turn-on').textContent()).toBe('Turn on & read');
  await page.clock.runFor(10000);
  expect(page.url()).toContain('/read'); // no countdown runs while it asks
  await page.locator('#once').click();
  await page.waitForURL(ARTICLE);
  expect(await page.title()).toBe('The article');
  await page.goBack(); // replace(), not a push
  expect(page.url()).not.toContain('/read');
});

test('Not now is remembered on this device: from then on the page counts down to the article', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  await page.locator('#not-now').click();
  expect(await page.locator('#count-panel').isVisible()).toBe(true);
  expect(await countdown(page)).toBe('Opening in 3…');
  expect(await page.locator('#key-hint').isVisible()).toBe(true);
  await page.clock.runFor(3000);
  await page.waitForURL(ARTICLE);
  // The next shared link skips the question.
  const next = await context.newPage();
  await next.clock.install();
  await next.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(next)).toBe('installed');
  expect(await next.locator('#ask-panel').isVisible()).toBe(false);
  expect(await countdown(next)).toBe('Opening in 3…');
});

test('counting down: Cancel stops it, and Read it as a book goes at once', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await context.addInitScript(() => { try { localStorage.setItem('obr-shared-optin-declined', '1'); } catch (e) { /* */ } });
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  await page.locator('#cancel').click();
  await page.clock.runFor(10000);
  expect(page.url()).toContain('/read');
  expect(await countdown(page)).toContain('Stopped');
  await page.locator('#read-now').click();
  await page.waitForURL(ARTICLE);
});

test('counting down: Just open the article leaves at once, and Back skips the page', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await context.addInitScript(() => { try { localStorage.setItem('obr-shared-optin-declined', '1'); } catch (e) { /* */ } });
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  await page.locator('#plain').click();
  await page.waitForURL(ARTICLE);
  await page.goBack(); // a pushed entry would land on the page and count down again
  expect(page.url()).not.toContain('/read');
});

// Opted in = Open Book holds the all-sites grant. The native prompt cannot be answered headless,
// so the worker's grant check is stubbed, and invokeReader is captured: what is under test is
// the hand-off (the worker arms on THIS tab, the page replaces itself with the article, and the
// worker opens the reader when it loads, as a 'shared' open, not the sentinel's 'auto').
test('opted in: the page leaves for the article and the worker opens the reader there', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    chrome.permissions.contains = (_need, cb) => cb(true);
    globalThis.__invoked = null;
    invokeReader = (...args) => { globalThis.__invoked = args; };
  });
  await seeTabUrls(serviceWorker);
  await loading(serviceWorker, ARTICLE);
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('#ask-panel').isVisible()).toBe(false); // already opted in: no question
  expect(await page.locator('#auto-hint').isVisible()).toBe(true);
  expect(await page.locator('#key-hint').isVisible()).toBe(false);
  expect(await page.locator('#optin').isVisible()).toBe(false);
  await page.clock.runFor(3000);
  await page.waitForURL(ARTICLE);
  await expect.poll(() => serviceWorker.evaluate(() => globalThis.__invoked)).not.toBeNull();
  const [tabId, url, mode, opts] = await serviceWorker.evaluate(() => globalThis.__invoked);
  expect({ tabIsNumber: typeof tabId === 'number', url, mode, opts })
    .toEqual({ tabIsNumber: true, url: ARTICLE, mode: 'text', opts: { auto: true, trigger: 'shared', incognito: false } });
  // The page replaced itself: Back skips it rather than counting down and handing off again.
  await serviceWorker.evaluate(() => { globalThis.__invoked = null; });
  await page.goBack();
  expect(page.url()).not.toContain('/read');
  await page.waitForTimeout(500);
  expect(await serviceWorker.evaluate(() => globalThis.__invoked)).toBeNull();
});

// Any site could embed the share page in a frame. Neither the page (it does not talk to Open
// Book from a frame) nor the worker (it answers top-level pages only) may let that frame steer
// the tab around it. The second frame skips the page's own check and messages the worker
// directly, so the worker's guard is tested on its own.
test('a framed share page cannot steer its host tab, even by messaging the worker directly', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    chrome.permissions.contains = (_need, cb) => cb(true);
    globalThis.__invoked = null;
    invokeReader = (...args) => { globalThis.__invoked = args; };
  });
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await context.route('https://openbook.peach-studio.com/raw-frame', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<script>chrome.runtime.sendMessage(${JSON.stringify(extensionId)}, { type: 'obr-open-shared', url: ${JSON.stringify(ARTICLE)} },
      (r) => { void chrome.runtime.lastError; document.title = 'answered:' + JSON.stringify(r || null); });</script>`,
  }));
  const host = 'https://evil.test/host';
  await context.route(host, (route) => route.fulfill({ contentType: 'text/html', body:
    `<iframe src="${readLink(LIVE_READ, ARTICLE, 'Story')}"></iframe><iframe id="raw" src="https://openbook.peach-studio.com/raw-frame"></iframe>` }));
  await serviceWorker.evaluate(() => {
    globalThis.__framedPings = 0;
    chrome.runtime.onMessageExternal.addListener((m, sender) => {
      if (m && m.type === 'obr-ping' && sender.frameId !== 0) globalThis.__framedPings += 1;
    });
  });
  await page.goto(host);
  await page.waitForTimeout(4500); // past the page's countdown, had it started
  // The page's own guard: framed, it never even asks (the worker's guard is tested below).
  expect(await serviceWorker.evaluate(() => globalThis.__framedPings)).toBe(0);
  expect(page.url()).toBe(host);
  expect(await serviceWorker.evaluate(() => globalThis.__invoked)).toBeNull();
  const framed = page.frames().find((f) => f.url().includes('/read'));
  expect(await framed.evaluate(() => document.body.dataset.state)).toBe('missing');
  // The worker did not answer the raw frame at all (no handler ran for it).
  const raw = page.frames().find((f) => f.url().includes('/raw-frame'));
  expect(await raw.evaluate(() => document.title)).toBe('answered:null');
});

// The hand-off is one shot and opens the reader ONLY on the shared article: a friend who goes
// somewhere else first (Back, a typed address, a redirect to another host) must not find the
// reader opened, unasked, on a page nobody shared. The arm is sent from the top-level share page
// by hand, so the next load is under the test's control.
test('the hand-off opens the reader only on the shared article, and any other page disarms it', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    chrome.permissions.contains = (_need, cb) => cb(true);
    globalThis.__invoked = [];
    invokeReader = (...args) => { globalThis.__invoked.push(args); };
  });
  await seeTabUrls(serviceWorker);
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await context.route('https://other.test/**', (route) => route.fulfill({ body: '<title>Elsewhere</title>', contentType: 'text/html' }));
  await context.route('https://www.example.com/**', (route) =>
    route.fulfill({ body: '<title>The article</title><p>story</p>', contentType: 'text/html' }));
  const arm = () => page.evaluate(({ id, url }) => new Promise((res) =>
    chrome.runtime.sendMessage(id, { type: 'obr-open-shared', url }, (r) => { void chrome.runtime.lastError; res(r); })),
  { id: extensionId, url: ARTICLE });
  await page.clock.install(); // hold every countdown: the loads below are the test's
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await arm()).toEqual({ armed: true });
  await loading(serviceWorker, 'https://other.test/');
  await page.goto('https://other.test/'); // went somewhere else first
  await loading(serviceWorker, ARTICLE);
  await page.goto(ARTICLE);               // ...then to the article: the arm is already spent
  await page.waitForTimeout(500);
  expect(await serviceWorker.evaluate(() => globalThis.__invoked.length)).toBe(0);
  // Same article on www. and a different query: that IS the shared article.
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await arm()).toEqual({ armed: true });
  await loading(serviceWorker, 'https://www.example.com/story?id=8');
  await page.goto('https://www.example.com/story?id=8');
  await expect.poll(() => serviceWorker.evaluate(() => globalThis.__invoked.length)).toBe(1);
});

test('without a grant covering the article, the worker declines and the page goes there itself', async ({ context, page, extensionId, serviceWorker }) => {
  // The ping says covered, but the grant is gone by the arm (revoked in between): the worker
  // does not arm, no reader opens, and the page still reaches the article.
  await serviceWorker.evaluate(() => {
    globalThis.__granted = true;
    chrome.permissions.contains = (_need, cb) => cb(globalThis.__granted);
    globalThis.__invoked = null;
    invokeReader = (...args) => { globalThis.__invoked = args; };
  });
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('#auto-hint').isVisible()).toBe(true); // the ping saw the grant
  await serviceWorker.evaluate(() => { globalThis.__granted = false; });
  await page.locator('#read-now').click();
  await page.waitForURL(ARTICLE);
  await page.waitForTimeout(500);
  expect(await serviceWorker.evaluate(() => globalThis.__invoked)).toBeNull();
});

test('Turn on & read opens the permission page for all sites, and waits', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  const popup = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html'));
  await page.locator('#turn-on').click();
  const perm = await popup;
  await perm.waitForLoadState();
  const q = new URL(perm.url()).searchParams;
  expect({ origins: q.get('origins'), reason: q.get('reason') }).toEqual({ origins: '<all_urls>', reason: 'shared-links' });
  expect(await perm.locator('#why').textContent()).toContain('shared');
  expect(await perm.locator('#origins').isVisible()).toBe(false); // no ZIP-style site list
  expect(await page.locator('#ask-status').textContent()).toContain('Waiting for your answer');
  await page.waitForTimeout(3500); // nothing leaves on its own while the answer is pending
  expect(page.url()).toContain('/read');
  // The Open Book window closed without a grant; focus comes back here: that is a no.
  await perm.close();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => page.locator('#ask-status').textContent()).toContain('Not turned on');
});

// The native prompt cannot be answered headless, so the grant is flipped in the worker the way
// Chrome would after "Allow": the page must notice it on its own and go straight on into
// reading mode, through the worker.
test('once the grant lands, Turn on & read goes straight into reading mode', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    globalThis.__granted = false;
    chrome.permissions.contains = (_need, cb) => cb(globalThis.__granted);
    globalThis.__invoked = null;
    invokeReader = (...args) => { globalThis.__invoked = args; };
  });
  await seeTabUrls(serviceWorker);
  await loading(serviceWorker, ARTICLE);
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  const popup = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html'));
  await page.locator('#turn-on').click();
  await (await popup).close();
  await serviceWorker.evaluate(() => { globalThis.__granted = true; });
  await page.clock.runFor(1600); // the page's re-check
  await page.waitForURL(ARTICLE);
  await expect.poll(() => serviceWorker.evaluate(() => globalThis.__invoked)).not.toBeNull();
  const [, url, mode, opts] = await serviceWorker.evaluate(() => globalThis.__invoked);
  expect({ url, mode, trigger: opts.trigger }).toEqual({ url: ARTICLE, mode: 'text', trigger: 'shared' });
});

// "Covered" is per article: the ping names the shared article, so a grant for that one site
// (auto-open turned on there) counts as much as the all-sites grant, and a grant for another
// site does not.
test('the ping asks about the shared article\'s own site', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    chrome.permissions.contains = (need, cb) => cb(need.origins.length === 1 && need.origins[0] === 'https://example.com/*');
  });
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('#ask-panel').isVisible()).toBe(false);
  expect(await page.locator('#auto-hint').isVisible()).toBe(true);
  const other = await context.newPage();
  await other.clock.install();
  await other.goto(readLink(LIVE_READ, 'https://other.test/a', 'Elsewhere'));
  await expect.poll(() => readState(other)).toBe('installed');
  expect(await other.locator('#ask-panel').isVisible()).toBe(true);
});

// The second opt-in: auto-open on the shared article's site, the context menu's flow. The site
// it names comes from the address, so a title made to look like another site changes nothing.
test('Always open this site asks for that site only, named from the address, not the title', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.goto(readLink(LIVE_READ, ARTICLE, 'mybank.com'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('#site-on').textContent()).toBe('Always open example.com in reading mode');
  const popup = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html'));
  await page.locator('#site-on').click();
  const perm = await popup;
  await perm.waitForLoadState();
  const q = new URL(perm.url()).searchParams;
  expect({ origins: q.get('origins'), reason: q.get('reason'), host: q.get('host') })
    .toEqual({ origins: '*://example.com/*,*://www.example.com/*', reason: 'auto-open', host: 'example.com' });
  expect(await page.locator('#ask-status').textContent()).toContain('Waiting for your answer');
});

// Allow, as the permission page reports it: the worker writes the auto-open rule, the page sees
// the site's grant on its next re-ping and hands the article over as a shared open.
test('once this site is allowed, auto-open is on there and the article opens in reading mode', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    globalThis.__granted = false;
    chrome.permissions.contains = (need, cb) => cb(globalThis.__granted && need.origins.indexOf('<all_urls>') === -1);
    globalThis.__invoked = [];
    invokeReader = (...args) => { globalThis.__invoked.push(args); };
  });
  await seeTabUrls(serviceWorker);
  await loading(serviceWorker, ARTICLE);
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  const popup = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html'));
  await page.locator('#site-on').click();
  const perm = await popup;
  await perm.waitForLoadState();
  await serviceWorker.evaluate(() => { globalThis.__granted = true; });
  await perm.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: 'obr-perms-result' }, () => res())));
  await expect.poll(() => serviceWorker.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_settings', (d) => res(((d.obr_settings || {}).siteRules || [])
      .filter((r) => r.match === 'example.com').map((r) => ({ match: r.match, auto: r.auto }))))))).toEqual([{ match: 'example.com', auto: true }]);
  await page.clock.runFor(1600); // the page's re-check
  await page.waitForURL(ARTICLE);
  await expect.poll(() => serviceWorker.evaluate(() => globalThis.__invoked.map((a) => a[3] && a[3].trigger))).toContain('shared');
});

// "Don't ask again" moves the page to the countdown; both opt-ins stay reachable under it.
test('counting down after Don\'t ask again, Always open this site is still offered', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await context.addInitScript(() => { try { localStorage.setItem('obr-shared-optin-declined', '1'); } catch (e) { /* */ } });
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('#optin-site').textContent()).toBe('Always open example.com in reading mode');
  const popup = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html'));
  await page.locator('#optin-site').click();
  const q = new URL((await popup).url()).searchParams;
  expect(q.get('reason')).toBe('auto-open');
  expect(await countdown(page)).toContain('Waiting for your answer');
});

// The choice is never offered while a grant covers the article, so a request then is not the
// page's button, and it must not write a rule without Chrome's prompt.
test('Always open this site is refused when a grant already covers the article', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => { chrome.permissions.contains = (_need, cb) => cb(true); });
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.clock.install();
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  let prompted = false;
  context.on('page', (p) => { if (p.url().includes('/src/permission.html')) prompted = true; });
  const reply = await page.evaluate((id) => new Promise((res) =>
    chrome.runtime.sendMessage(id, { type: 'obr-auto-open-site', url: 'https://victim.test/x' }, (r) => { void chrome.runtime.lastError; res(r); })), extensionId);
  expect(reply).toEqual({ ok: false });
  await page.waitForTimeout(500);
  expect(prompted).toBe(false);
  const rules = await serviceWorker.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_settings', (d) => res(((d.obr_settings || {}).siteRules || []).map((r) => r.match)))));
  expect(rules).not.toContain('victim.test');
});

// A friend who clicks one choice and then the other has changed their mind: the window still up
// must give way to one that asks what the page now says it asks, not queue behind it.
test('switching to Always open this site replaces the all-sites window', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  const first = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html'));
  await page.locator('#turn-on').click();
  const allSites = await first;
  expect(new URL(allSites.url()).searchParams.get('reason')).toBe('shared-links');
  const second = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html') && p !== allSites);
  const closed = allSites.waitForEvent('close');
  await page.locator('#site-on').click();
  await closed;
  expect(new URL((await second).url()).searchParams.get('reason')).toBe('auto-open');
});

// Only a window holding share-page asks alone gives way: another tab's ZIP prompt stays up, and
// the share page's ask queues behind it as any other ask does.
test('a share-page ask never closes another tab\'s permission window', async ({ context, page, extensionId, serviceWorker }) => {
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  const zipWindow = context.waitForEvent('page', (p) => p.url().includes('/src/permission.html'));
  await serviceWorker.evaluate(() => { requestPerm({ origins: ['*://cdn.test/*'] }, () => {}); });
  const zip = await zipWindow;
  let another = false;
  context.on('page', (p) => { if (p.url().includes('/src/permission.html')) another = true; });
  await page.locator('#site-on').click();
  await page.waitForTimeout(800);
  expect(zip.isClosed()).toBe(false);
  expect(another).toBe(false);
});

// The page can be out of date: a grant landed in another share tab after this one pinged. The
// worker refuses the ask, and the page goes on from what Open Book holds now, not "Not turned on".
test('an ask refused because the article is already covered goes straight into reading mode', async ({ context, page, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    globalThis.__granted = false;
    chrome.permissions.contains = (_need, cb) => cb(globalThis.__granted);
    globalThis.__invoked = [];
    invokeReader = (...args) => { globalThis.__invoked.push(args); };
  });
  await seeTabUrls(serviceWorker);
  await loading(serviceWorker, ARTICLE);
  await serveReadAt(context, 'https://openbook.peach-studio.com', extensionId);
  await page.goto(readLink(LIVE_READ, ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('installed');
  expect(await page.locator('#ask-panel').isVisible()).toBe(true);
  await serviceWorker.evaluate(() => { globalThis.__granted = true; }); // allowed in another tab
  await page.locator('#site-on').click();
  await page.waitForURL(ARTICLE);
  await expect.poll(() => serviceWorker.evaluate(() => globalThis.__invoked.map((a) => a[3] && a[3].trigger))).toContain('shared');
});

// The worker that asked is often gone by the time the friend answers (MV3 idles it out while the
// prompt is up), so the permission page writes the auto-open rule itself on Allow. Opened here
// with no worker waiting on it, which is that situation; the host must be the one its origins
// were built from.
test('the permission page writes the auto-open rule on its own Allow, for the site it asked for only', async ({ context, extensionId, serviceWorker }) => {
  const rulesNow = () => serviceWorker.evaluate(() => new Promise((res) =>
    chrome.storage.sync.get('obr_settings', (d) => res(((d.obr_settings || {}).siteRules || [])
      .map((r) => ({ match: r.match, auto: !!r.auto }))))));
  const allow = async (host, origins) => {
    const perm = await context.newPage();
    await perm.goto(`chrome-extension://${extensionId}/src/permission.html?reason=auto-open&host=${host}&origins=${encodeURIComponent(origins)}`);
    await perm.evaluate(() => { chrome.permissions.request = (_req, cb) => cb(true); });
    const closed = perm.waitForEvent('close');
    await perm.locator('#allow').click();
    await closed;
  };
  await allow('other.test', '*://example.com/*,*://www.example.com/*'); // a host its origins do not name
  expect(await rulesNow()).toEqual([]);
  await allow('example.com', '*://example.com/*,*://www.example.com/*');
  expect(await rulesNow()).toEqual([{ match: 'example.com', auto: true }]);
});

test('the same page on any other origin cannot reach Open Book', async ({ context, page, extensionId }) => {
  await serveReadAt(context, 'https://openbook.evil.test', extensionId);
  await page.goto(readLink('https://openbook.evil.test/read', ARTICLE, 'Story'));
  await expect.poll(() => readState(page)).toBe('missing');
});

// If the read page itself is ever missing (undeployed, renamed), GitHub Pages serves 404.html
// for /read, with the fragment intact: a share link must still reach its article, while every
// other missing path stays a plain 404, so the site never forwards wherever a link says.
async function serve404At(context, origin) {
  const body = readFileSync(path.join(SITE, '404.html'), 'utf8');
  await context.route(origin + '/**', (route) => route.fulfill({ status: 404, body, contentType: 'text/html' }));
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ body: '<title>The article</title><p>story</p>', contentType: 'text/html' }));
}

test('a share link whose read page is missing still goes straight to the article', async ({ context, page }) => {
  await serve404At(context, 'https://openbook.peach-studio.com');
  await page.goto(readLink('https://openbook.peach-studio.com/read', ARTICLE, 'Story'));
  await page.waitForURL(ARTICLE);
  expect(await page.title()).toBe('The article');
});

// GitHub Pages 404s /read/ and /read.html/ even while the read page exists, so a fallback on
// those paths would forward any visitor anywhere, permanently.
test('the 404 page forwards nothing else: another path, a trailing slash, or a non-http address', async ({ context, page }) => {
  await serve404At(context, 'https://openbook.peach-studio.com');
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  for (const url of [
    readLink('https://openbook.peach-studio.com/elsewhere', ARTICLE, 'Story'),
    readLink('https://openbook.peach-studio.com/read/', ARTICLE, 'Story'),
    readLink('https://openbook.peach-studio.com/read.html/', ARTICLE, 'Story'),
    // A javascript: address would run in this page without changing its URL: the dialog is
    // the only trace it leaves.
    readLink('https://openbook.peach-studio.com/read', 'javascript:alert(1)', 'x'),
  ]) {
    await page.goto('about:blank');
    await page.goto(url);
    await page.waitForTimeout(300);
    expect({ url, landed: page.url() }).toEqual({ url, landed: url });
    expect(await page.locator('h1').textContent()).toBe('404');
  }
  expect(dialogs).toEqual([]);
});
