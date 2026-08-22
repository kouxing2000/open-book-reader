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
  expect(manifest.default_locale).toBe('en');
  // Name + summary are localized via _locales/*, so the raw manifest carries the
  // __MSG__ placeholder that Chrome resolves per locale at load.
  expect(manifest.name).toBe('__MSG_extName__');
  // Install asks for only the minimal set — nothing scary at install time.
  // (contextMenus adds the right-click "Open in Book Reader" surface; no install warning.)
  expect(manifest.permissions.sort()).toEqual(['activeTab', 'contextMenus', 'scripting', 'storage']);
  expect(manifest.host_permissions).toBeUndefined();
  // downloads + <all_urls> are OPTIONAL, requested on first image download.
  expect(manifest.optional_permissions).toEqual(['downloads']);
  expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
  // Auto-open ships with ZERO manifest delta: per-site origin requests ride the
  // optional <all_urls> above, registerContentScripts + persistAcrossSessions are
  // Chrome 96+ — a bump past 102 (once proposed off a wrong claim; 105 is Firefox's
  // milestone) would strand users for nothing.
  expect(manifest.minimum_chrome_version).toBe('102');

  // The resolved English (default-locale) store name lives in the messages catalog.
  // Assert the INVARIANTS, not the exact copy: the title is ASO-tuned and gets
  // rewritten whenever `npm run ranking` says a keyword is winnable, so pinning the
  // literal string only guarantees this test breaks on every marketing edit while
  // catching no bug. What must hold is that the catalog resolves at all (a broken
  // __MSG_extName__ ships an extension literally named "__MSG_extName__") and that
  // the name stays inside the store's hard 75-character limit.
  await page.goto(`chrome-extension://${extensionId}/_locales/en/messages.json`);
  const messages = JSON.parse(await page.locator('body').innerText());
  expect(messages.extName.message).toMatch(/^Open Book\b/);
  expect(messages.extName.message.length).toBeLessThanOrEqual(75);
  expect(messages.extSummary.message.length).toBeLessThanOrEqual(132);
});

// Regression: onInstalled and onStartup BOTH fire in one worker activation when Chrome
// applies an update while the browser is closed, so createMenus() can run twice back-to-back.
// The old fire-and-forget version queued both removeAll()s before either batch of creates,
// so the second batch collided on every id ("Cannot create item with duplicate id obr-open",
// ... — 8 unchecked lastErrors on the extension's error page).
test('racing createMenus() calls rebuild the menu without duplicate-id errors', async ({ serviceWorker }) => {
  const { builds, errs } = await serviceWorker.evaluate(async () => {
    // Drain the extension's own onInstalled build first, so the counts below are ours alone.
    await createMenus();

    // Segment creates into BUILDS instead of counting them globally. Each build starts with
    // removeAll and awaits every create (background.js `createMenus`), and the menuBuild chain
    // serializes builds — so a create can never be attributed to the wrong segment.
    // Counting globally was FLAKY: the drain above only settles builds queued so far, so under
    // parallel load the extension's OWN onStartup build lands inside this window and every
    // total reads 3 instead of 2. That extra build is just another racer, which is precisely
    // what the test is about — so measure the invariant that actually matters: every build
    // that completes creates the full set, and nothing collides, however many race.
    const builds = [], errs = [];
    const realCreate = chrome.contextMenus.create;
    const realRemoveAll = chrome.contextMenus.removeAll;
    chrome.contextMenus.removeAll = function (cb) {
      builds.push([]);                       // a build begins
      return realRemoveAll.call(chrome.contextMenus, cb);
    };
    chrome.contextMenus.create = function (props, cb) {
      return realCreate.call(chrome.contextMenus, props, () => {
        if (chrome.runtime.lastError) errs.push(chrome.runtime.lastError.message);
        else if (builds.length) builds[builds.length - 1].push(props.id);
        if (cb) cb();
      });
    };
    try {
      createMenus();        // onInstalled …
      await createMenus();  // … and onStartup, same task. The chain settles both.
    } finally {
      chrome.contextMenus.create = realCreate;
      chrome.contextMenus.removeAll = realRemoveAll;
    }
    return { builds, errs };
  });

  // Positive landmark FIRST: both racing builds ran to completion, each creating all 15
  // ALWAYS-present items. (The fresh test profile has no rules, so the state-scoped
  // "Current selection"/"Stop"/"Clear" rows aren't created here — that's the whole point of the
  // redesign, and it's covered by the state-aware test below.) Without this, a build that
  // silently created nothing would satisfy the no-errors assertion.
  const ids = ['obr-open', 'obr-open-auto', 'obr-open-text', 'obr-open-images',
    'obr-sep', 'obr-configure-default', 'obr-def-auto', 'obr-def-text', 'obr-def-images',
    'obr-sep2', 'obr-rule-auto', 'obr-rule-auto-url', 'obr-sep-opts', 'obr-report-page',
    'obr-open-options'];
  const sorted = (a) => a.slice().sort();
  const want = JSON.stringify(sorted(ids));
  const complete = builds.filter((b) => JSON.stringify(sorted(b)) === want);
  // Our two racing builds both ran to completion. A THIRD build may also appear (the
  // extension's own onStartup under load) and the LAST one may be truncated by un-patching
  // mid-flight — neither is a defect, so require at least two complete ones rather than an
  // exact count. Without this landmark, a build that silently created nothing would still
  // satisfy the no-errors assertion below.
  expect(complete.length,
    `complete builds (saw ${builds.length}, sizes ${JSON.stringify(builds.map((b) => b.length))})`)
    .toBeGreaterThanOrEqual(2);
  // No build invented an id outside the known set (a partial trailing build is a subset).
  builds.forEach((b, i) => b.forEach((id) => {
    expect(ids, `build ${i + 1} created unexpected id ${id}`).toContain(id);
  }));
  // …and the racing builds' creates collided with nothing (the bug: 8 duplicate-id errors).
  expect(errs).toEqual([]);
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

test('syncSentinelRegistration tracks the auto rules: register, skip invalid globs, unregister', async ({ serviceWorker }) => {
  // Headless can't GRANT an origin, but registration itself is drivable: stub only the
  // grant check and exercise the real registerContentScripts round-trip in the real SW.
  const r = await serviceWorker.evaluate(async () => {
    const out = {};
    const realContains = chrome.permissions.contains;
    chrome.permissions.contains = (_need, cb) => cb(true); // pretend the origins are granted
    try {
      await new Promise((res) => chrome.storage.sync.set({ obr_settings: { siteRules: [
        { match: 'example.com', mode: 'text', auto: true },
        { match: 'ex*ample.com', mode: 'text', auto: true }, // originsForRule → [] — must not poison the batch
      ] } }, res));
      await syncSentinelRegistration();
      const regged = await chrome.scripting.getRegisteredContentScripts({ ids: ['obr-sentinel'] });
      out.matches = regged[0] && regged[0].matches.slice().sort();
      out.persist = regged[0] && regged[0].persistAcrossSessions;
      out.js = regged[0] && regged[0].js.map((p) => p.split('/').pop());

      // Dropping the last auto flag must UNREGISTER (an empty matches array is invalid).
      await new Promise((res) => chrome.storage.sync.set({ obr_settings: { siteRules: [
        { match: 'example.com', mode: 'text' },
      ] } }, res));
      await syncSentinelRegistration();
      out.after = (await chrome.scripting.getRegisteredContentScripts({ ids: ['obr-sentinel'] })).length;
    } finally {
      chrome.permissions.contains = realContains;
    }
    return out;
  });
  expect(r.matches).toEqual(['*://example.com/*', '*://www.example.com/*']);
  expect(r.persist).toBe(true); // survives browser restarts without re-registration
  expect(r.js).toEqual(['settings.js', 'sentinel.js']);
  expect(r.after).toBe(0);
});

test('the "Auto-open on this site" context item is created (real SW build)', async ({ serviceWorker }) => {
  // The exact item a user right-clicks to turn the feature on. Capture what createMenus()
  // actually creates in the LIVE service worker (there's no contextMenus "get all" API).
  const created = await serviceWorker.evaluate(async () => {
    const seen = [];
    const real = chrome.contextMenus.create;
    chrome.contextMenus.create = function (props, cb) {
      return real.call(chrome.contextMenus, props, () => { void chrome.runtime.lastError; seen.push({ id: props.id, title: props.title }); if (cb) cb(); });
    };
    try { await createMenus(); } finally { chrome.contextMenus.create = real; }
    return seen;
  });
  const auto = created.find((m) => m.id === 'obr-rule-auto');
  expect(auto, 'obr-rule-auto must be among the created menu items').toBeTruthy();
  expect(auto.title).toBe('Auto-open on this site'); // resolved i18n, not a blank/placeholder title

  const opts = created.find((m) => m.id === 'obr-open-options');
  expect(opts, 'the "Settings…" jump to the options page must be present').toBeTruthy();
  expect(opts.title).toBe('Settings…'); // resolved i18n
});

test('the menu is state-aware: Clear only where a rule exists, Stop only on auto sites', async ({ serviceWorker }) => {
  // The redesign: menu rows follow the SITE's saved rules via documentUrlPatterns (rebuilt
  // on rule changes), since Chrome can't morph the menu at click time without the `tabs`
  // permission. Seed two rules and capture what the REAL service worker builds.
  const created = await serviceWorker.evaluate(async () => {
    await new Promise((res) => chrome.storage.sync.set({ obr_settings: { siteRules: [
      { match: 'ruled.com', mode: 'text' },              // a view rule, NOT auto
      { match: 'auto.com', mode: 'auto', auto: true },   // auto-open on
    ] } }, res));
    const seen = [];
    const real = chrome.contextMenus.create;
    chrome.contextMenus.create = function (props, cb) {
      return real.call(chrome.contextMenus, props, () => {
        void chrome.runtime.lastError;
        seen.push({ id: props.id, patterns: props.documentUrlPatterns || null });
        if (cb) cb();
      });
    };
    try { await createMenus(); } finally { chrome.contextMenus.create = real; }
    return seen;
  });
  const byId = (id) => created.find((m) => m.id === id);
  expect(byId('obr-rule-auto'), '"Auto-open" (turn-on) is always present').toBeTruthy();

  const clear = byId('obr-rule-clear');
  expect(clear, 'Clear appears once a whole-site rule exists').toBeTruthy();
  expect(clear.patterns.slice().sort())
    .toEqual(['*://auto.com/*', '*://ruled.com/*', '*://www.auto.com/*', '*://www.ruled.com/*']); // scoped to BOTH ruled sites

  const stop = byId('obr-rule-auto-stop');
  expect(stop, 'Stop appears only where auto-open is on').toBeTruthy();
  expect(stop.patterns.slice().sort()).toEqual(['*://auto.com/*', '*://www.auto.com/*']);
  expect(stop.patterns).not.toContain('*://ruled.com/*'); // NOT offered on the non-auto site
});

test('enabling auto-open (the menu-click path) writes the rule and registers the sentinel', async ({ serviceWorker }) => {
  // This is the whole "turn it on" flow the user drives from the context menu, run against
  // the REAL service worker: enableAutoOpen() upserts an auto rule and syncs registration.
  // Only the native permission PROMPT is unavailable headless, so we stub contains→granted
  // (the popup's job) and drive the rest for real.
  const r = await serviceWorker.evaluate(async () => {
    const realContains = chrome.permissions.contains;
    chrome.permissions.contains = (_need, cb) => cb(true); // as if the site origin were already granted
    try {
      await new Promise((res) => chrome.storage.sync.set({ obr_settings: { siteRules: [] } }, res));
      enableAutoOpen('example.com', { id: 999999 }); // bogus tab id: injectSentinelNow just no-ops (caught)
      // enableAutoOpen is fire-and-forget AND lands its two effects — the stored rule and the
      // sentinel registration — as separate async steps. Poll until BOTH are in, or whichever
      // finishes second races the assertions below (observed: the rule present, registration
      // still empty, so `matches` came back undefined).
      let rule = null, regged = [];
      for (let i = 0; i < 40 && !(rule && regged.length); i++) {
        await new Promise((res) => setTimeout(res, 50));
        const s = await new Promise((res) => chrome.storage.sync.get('obr_settings', (d) => res(d.obr_settings || {})));
        rule = (s.siteRules || []).find((x) => x.match === 'example.com') || null;
        regged = await chrome.scripting.getRegisteredContentScripts({ ids: ['obr-sentinel'] });
      }
      return { rule, matches: regged[0] && regged[0].matches.slice().sort() };
    } finally {
      chrome.permissions.contains = realContains;
    }
  });
  expect(r.rule).toEqual({ match: 'example.com', mode: 'auto', auto: true }); // flagged in real storage
  expect(r.matches).toEqual(['*://example.com/*', '*://www.example.com/*']);  // sentinel registered for it
});


// LEAST PRIVILEGE for the ZIP fetch. The old code keyed off the message TYPE and always asked
// for <all_urls>, so downloading one album granted read access to every site — and that one
// broad grant then subsumed every per-site auto-open grant. The exact URLs are in the message,
// so the request is now derived from them.
test('permsFor derives ZIP origins from the actual image URLs, never <all_urls>', async ({ serviceWorker }) => {
  const r = await serviceWorker.evaluate(() => ({
    single: permsFor({ type: 'obr-fetch-bytes', urls: ['https://i.cdn.test/a/1.jpg'] }),
    // several images on one host collapse to ONE origin; two hosts give two
    multi: permsFor({ type: 'obr-fetch-bytes', urls: [
      'https://i.cdn.test/a/1.jpg', 'https://i.cdn.test/b/2.jpg', 'https://img.other.test/3.png',
    ] }),
    // a match pattern's host may NOT carry a port, so it is stripped; the path never appears
    port: permsFor({ type: 'obr-fetch-bytes', urls: ['http://host.test:8080/deep/path/x.png'] }),
    // data:/blob: need no host permission -> nothing to ask for -> no prompt at all
    dataOnly: permsFor({ type: 'obr-fetch-bytes', urls: ['data:image/png;base64,AAAA'] }),
    junk: permsFor({ type: 'obr-fetch-bytes', urls: ['not a url'] }),
    // a `*` in the host can't form a valid pattern, and ONE bad entry fails the whole request
    starHost: permsFor({ type: 'obr-fetch-bytes', urls: ['https://foo*bar.test/x.png'] }),
    // the single-file download path is unchanged: a plain `downloads` permission, no origins
    one: permsFor({ type: 'obr-download-one', url: 'https://x.test/a.png' }),
  }));
  // `*://host/*` — host granularity, BOTH schemes. Scheme-pinning looks narrower but breaks
  // the common case: an http image URL 301s to https and the SW fetch follows the redirect
  // straight out of its own grant.
  expect(r.single).toEqual({ origins: ['*://i.cdn.test/*'] });
  expect(r.multi).toEqual({ origins: ['*://i.cdn.test/*', '*://img.other.test/*'] });
  // Port stripped — a port-less pattern matches ANY port, and it keeps the shape identical to
  // originsForRule. (Not because Chrome rejects ports: contains() accepts `host:8080` patterns.)
  expect(r.port).toEqual({ origins: ['*://host.test/*'] });
  expect(r.dataOnly).toBeNull();
  expect(r.junk).toBeNull();
  // A `*` typed into a host is percent-encoded by the URL parser ('foo%2Abar.test'), so it
  // never reaches permsFor's wildcard guard and the pattern stays well-formed. Asserting the
  // OBSERVED behaviour, not the guard's premise.
  expect(r.starHost).toEqual({ origins: ['*://foo%2Abar.test/*'] });
  expect(r.one).toEqual({ permissions: ['downloads'] });
  // The regression that matters: no code path hands back the blanket grant on its own.
  const asked = JSON.stringify([r.single, r.multi, r.port]);
  expect(asked).not.toContain('<all_urls>');

  // Every generated pattern must be WELL-FORMED: permissions.contains validates its input
  // (it rejects e.g. a pathless 'http://host.test' with "Empty path"), and one invalid entry
  // sinks an entire permissions request. It does NOT police ports — 'http://h:8080/*' is
  // accepted here — so the port strip is about matching the documented match-pattern grammar
  // and staying consistent with originsForRule, not about dodging an API error.
  const wellFormed = await serviceWorker.evaluate(async (origins) => {
    const out = {};
    for (const o of origins) {
      out[o] = await new Promise((res) => {
        try {
          chrome.permissions.contains({ origins: [o] }, () => res(
            chrome.runtime.lastError ? chrome.runtime.lastError.message : 'ok'));
        } catch (e) { res('threw: ' + (e && e.message)); }
      });
    }
    return out;
  }, [...r.single.origins, ...r.multi.origins, ...r.port.origins, ...r.starHost.origins]);
  Object.entries(wellFormed).forEach(([pattern, verdict]) => {
    expect(verdict, `pattern ${pattern}`).toBe('ok');
  });
});


// stopAutoOpen is what the context menu AND the in-overlay chip both go through (the chip
// relays via 'obr-stop-auto' because a content script cannot call permissions.remove). It must
// clear only the auto flag, keep the mode rule, and hand the site grant back.
test('stopAutoOpen clears the auto flag, keeps the mode, and releases the site grant', async ({ serviceWorker }) => {
  const out = await serviceWorker.evaluate(async () => {
    const removed = [];
    const realRemove = chrome.permissions.remove;
    chrome.permissions.remove = (need, cb) => { removed.push(need); if (cb) cb(true); };
    await new Promise((res) => chrome.storage.sync.set({ obr_settings: { siteRules: [
      { match: 'stopme.test', mode: 'text', auto: true },
      { match: 'other.test', mode: 'auto', auto: true },
    ] } }, res));
    const ok = await new Promise((res) => stopAutoOpen('https://stopme.test/thread/1', res));
    const rules = await new Promise((res) =>
      chrome.storage.sync.get('obr_settings', (d) => res(d.obr_settings.siteRules)));
    chrome.permissions.remove = realRemove;
    return { ok, rules, removed };
  });
  expect(out.ok).toBe(true);
  // auto gone, mode kept — "stop automating" must not also forget "this site reads as text".
  expect(out.rules).toEqual([
    { match: 'stopme.test', mode: 'text' },
    { match: 'other.test', mode: 'auto', auto: true },
  ]);
  // …and only THAT site's origins are handed back; the untouched rule keeps its grant.
  expect(out.removed).toEqual([{ origins: ['*://stopme.test/*', '*://www.stopme.test/*'] }]);
});


// The two ways a trigger does NOTHING from the user's seat. Each also logs a console.warn, but
// that lands in a console no ordinary user opens — so without a badge a dead click is all they
// get, which is indistinguishable from a broken extension.
test('a blocked page gets a "!" badge + tooltip, and Chrome retires it on navigation', async ({ page, serviceWorker }) => {
  // Learn the tab id from the navigation itself. tabs.query({active, currentWindow}) hands
  // back a DIFFERENT tab here (the fixture's worker-wake page leaves another window focused),
  // and querying by URL needs the `tabs` permission this extension deliberately doesn't hold —
  // so the badge would land on a tab Playwright cannot navigate, and every assertion about what
  // a navigation does to it would be vacuous.
  await serviceWorker.evaluate(() => {
    globalThis.__navTab = null;
    chrome.tabs.onUpdated.addListener((id, info) => { if (info && info.status === 'loading') globalThis.__navTab = id; });
  });
  await page.goto('/');
  const tabId = await serviceWorker.evaluate(() => globalThis.__navTab);
  expect(tabId, 'the test must act on the tab Playwright drives').toBeTruthy();

  const shown = await serviceWorker.evaluate(async (id) => {
    await invokeReader(id, 'chrome://settings/', 'auto', {}); // the URL guard's early return
    return { text: await chrome.action.getBadgeText({ tabId: id }), title: await chrome.action.getTitle({ tabId: id }) };
  }, tabId);
  expect(shown.text).toBe('!');
  expect(shown.title).toContain("can't run on this page"); // the tooltip carries the message

  // The tooltip must resolve from the CATALOG, not from the English fallback baked into
  // background.js: the two strings are identical, so a typo'd key would read correctly here
  // while silently shipping English to the other seven locales. Resolve the key the code uses.
  const resolved = await serviceWorker.evaluate(() => ({
    blocked: chrome.i18n.getMessage(FAILURE_TEXT.blocked[0]),
    reload: chrome.i18n.getMessage(FAILURE_TEXT.reload[0]),
  }));
  expect(resolved.blocked).not.toBe('');
  expect(resolved.reload).not.toBe('');

  // The state expires on its own. background.js registers NO tabs.onUpdated listener to clear
  // it (that listener would wake the worker on every navigation in every tab); it relies on
  // Chrome dropping tab-specific badge text + title when the tab does a cross-document
  // navigation. That is the load-bearing assumption, so pin BOTH halves of it here.
  //   1. a same-document (SPA) navigation must NOT clear it — the diagnosis is still true…
  await page.evaluate(() => history.pushState({}, '', '/?spa=1'));
  await page.waitForTimeout(300);
  expect(await serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('!');
  //   2. …and a real navigation must, tooltip included.
  await page.goto('/article.html');
  await expect.poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('');
  const title = await serviceWorker.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId);
  expect(title).not.toContain("can't run on this page");
  expect(title).not.toBe(''); // back to the extension's own tooltip, not a blank one

  // Auto-open has nobody waiting on a click, so it stays console-only.
  const auto = await serviceWorker.evaluate(async (id) => {
    await invokeReader(id, 'chrome://settings/', 'auto', { auto: true });
    return chrome.action.getBadgeText({ tabId: id });
  }, tabId);
  expect(auto).toBe('');
});

test('a blocked page also arms a per-tab popup, and navigation disarms it', async ({ page, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    globalThis.__navTab = null;
    chrome.tabs.onUpdated.addListener((id, info) => { if (info && info.status === 'loading') globalThis.__navTab = id; });
  });
  await page.goto('/');
  const tabId = await serviceWorker.evaluate(() => globalThis.__navTab);

  const armed = await serviceWorker.evaluate(async (id) => {
    // Suppress the once-per-profile explainer TAB so this test measures the popup alone.
    await chrome.storage.local.set({ obr_blocked_seen: 1 });
    await invokeReader(id, 'chrome://settings/', 'auto', {});
    return { tab: await chrome.action.getPopup({ tabId: id }), global: await chrome.action.getPopup({}) };
  }, tabId);
  expect(armed.tab).toMatch(/src\/blocked\.html$/); // the click now has an answer…
  expect(armed.global).toBe('');                    // …on THIS tab only

  // THE load-bearing assumption. A per-tab popup suppresses action.onClicked for that tab, so if
  // Chrome ever stopped clearing it on navigation, this tab would keep the popup after moving to
  // a real article and the icon would never open the reader there again. Same lifecycle as the
  // badge, which is why no listener of ours cleans it up.
  await page.goto('/article.html');
  await expect.poll(() => serviceWorker.evaluate((id) => chrome.action.getPopup({ tabId: id }), tabId)).toBe('');
});

test('a SOFT block (a normal URL that would not inject) offers Report; a real chrome:// page does not', async ({ page, serviceWorker }) => {
  // `blocked` has two sources: the restricted-scheme guard, and the catch-all around a failed
  // injection. The second fires on ordinary pages too, and THAT is a fault worth hearing about —
  // so the popup carries a Report link exactly there, and stays a plain explanation on a page
  // the browser genuinely blocks. The scheme test is the only thing separating them.
  await serviceWorker.evaluate(() => {
    globalThis.__navTab = null;
    chrome.tabs.onUpdated.addListener((id, info) => { if (info && info.status === 'loading') globalThis.__navTab = id; });
  });
  await page.goto('/');
  const tabId = await serviceWorker.evaluate(() => globalThis.__navTab);

  const popups = await serviceWorker.evaluate(async (id) => {
    await chrome.storage.local.set({ obr_blocked_seen: 1 }); // suppress the once-per-profile tab
    const real = chrome.scripting.executeScript;
    const get = () => chrome.action.getPopup({ tabId: id });
    // Hard: the URL guard short-circuits before any injection is attempted.
    await invokeReader(id, 'chrome://settings/', 'auto', {});
    const hard = await get();
    // Hard with no URL at all — how a restricted tab looks to a worker holding no host access.
    chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
    try {
      await invokeReader(id, '', 'auto', {});
      const blind = await get();
      // Soft: a perfectly ordinary article URL whose injection blew up anyway.
      await invokeReader(id, 'https://news.test/story/7?utm=x#frag', 'auto', {});
      return { hard, blind, soft: await get() };
    } finally { chrome.scripting.executeScript = real; }
  }, tabId);

  expect(popups.hard).toMatch(/src\/blocked\.html$/);   // a Chrome rule — nothing to report
  expect(popups.blind).toMatch(/src\/blocked\.html$/);  // unknown URL is treated as restricted
  expect(popups.soft).toContain('src/blocked.html?soft=1&u=');
  // The page URL rides in the popup's own query string so it survives the worker being evicted —
  // already stripped to origin+pathname, since the report throws the rest away regardless.
  expect(decodeURIComponent(popups.soft.split('&u=')[1])).toBe('https://news.test/story/7');
});

test('isHardBlock covers what blocked.html actually claims, not just the URL scheme', async ({ serviceWorker }) => {
  // The popup's bullet list names the Web Store and local files as browser rules. A classifier
  // that reads only the scheme calls both "a normal page" one line below that list and asks for
  // a report about something no release can change. These are the cases that discrepancy hides.
  const got = await serviceWorker.evaluate(() => [
    'chrome://settings/', 'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x', 'file:///Users/me/a.pdf',
    'https://example.com/paper.pdf', 'devtools://devtools/bundled/x.html',
    'data:text/html,<p>x</p>', 'blob:https://x.com/a', '',
    'https://news.test/story/7',           // the one that SHOULD offer Report
  ].map((u) => [u, isHardBlock(u)]));
  const hard = got.filter(([, h]) => h).map(([u]) => u);
  const soft = got.filter(([, h]) => !h).map(([u]) => u);
  expect(soft).toEqual(['https://news.test/story/7']); // exactly one, and it is a real article URL
  expect(hard).toHaveLength(9);                        // positive landmark: nothing silently dropped
});

test('a report never carries a local path — origin+pathname is not a strip on an opaque origin', async ({ serviceWorker }) => {
  // Chrome reports `new URL('file:///Users/me/tax.pdf').origin` as "file://" and the pathname as
  // the whole local path, so the documented "stripped to origin+pathname" guarantee inverts into
  // mailing someone their own filesystem. Same shape for data: (the entire payload). This runs in
  // a REAL service worker on purpose: Node reports that origin as "null" instead, so a check
  // written against Node's value passes in a unit harness and still leaks in the browser.
  const built = await serviceWorker.evaluate(() => [
    'file:///Users/me/Documents/tax-return.pdf', 'data:text/html,<p>private note</p>',
    'blob:https://x.com/abc', 'https://news.test/story/7?utm=x#frag',
  ].map((u) => OBR._buildReportMeta({ source: 't', mode: 'none', pageUrl: u }).pageUrl));
  expect(built).toEqual(['(local file)', '(data URL)', '(blob URL)', 'https://news.test/story/7']);
  expect(built.join(' ')).not.toContain('tax-return');  // the assertion that matters
  expect(built.join(' ')).not.toContain('private note');
});

test('the report path survives a page the reader cannot draw on: menu item + worker-built meta', async ({ serviceWorker }) => {
  // Every ⚠ Report button lives inside an overlay, so the failures worth reporting are exactly
  // the ones that hide it. This entry point runs entirely in the worker — no content script.
  const created = await serviceWorker.evaluate(async () => {
    const seen = [];
    const real = chrome.contextMenus.create;
    chrome.contextMenus.create = function (props, cb) {
      return real.call(chrome.contextMenus, props, () => { void chrome.runtime.lastError; seen.push({ id: props.id, title: props.title }); if (cb) cb(); });
    };
    try { await createMenus(); } finally { chrome.contextMenus.create = real; }
    return seen;
  });
  const item = created.find((m) => m.id === 'obr-report-page');
  expect(item, 'the report entry must be in the menu').toBeTruthy();
  expect(item.title).toBe('Report that this page doesn’t work…'); // resolved i18n, not a raw key
  expect(await serviceWorker.evaluate(() => OBR._menuAction('obr-report-page'))).toEqual({ do: 'report' });

  // …and it opens the bundled report page carrying the PAGE's url. Inside the worker `location`
  // is the worker's own chrome-extension:// URL, so the url has to be passed in explicitly —
  // this asserts the built meta, which is the whole value of the entry point.
  const opened = await serviceWorker.evaluate(async () => {
    const real = chrome.tabs.create;
    let url = '';
    chrome.tabs.create = (o) => { url = o.url; };
    try { openReportPage({ source: 'context-menu', mode: 'none', pageUrl: 'https://news.test/story/7?utm=x#frag' }); }
    finally { chrome.tabs.create = real; }
    return url;
  });
  expect(opened).toContain('src/report.html#');
  const meta = JSON.parse(decodeURIComponent(opened.split('#')[1]));
  expect(meta.reportSource).toBe('context-menu');
  expect(meta.app).toBe('open-book-reader');
  expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
  // Query + fragment stripped, exactly as the in-page path strips them: a session token must
  // not reach the draft even though the user reviews it before sending.
  expect(meta.pageUrl).toBe('https://news.test/story/7');
});

test('an orphaned engine gets the "reload this page" state, not another dead click', async ({ page, serviceWorker }) => {
  await page.goto('/');
  const out = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const real = chrome.scripting.executeScript;
    // Content scripts surviving a previous extension instance can't be staged headlessly, so
    // stub the page PROBE to report what that state looks like — engine loaded, extension
    // context dead. Everything after the probe (skip injection, dispatch into a corpse) is the
    // real code path, and it is exactly the silent no-op the user cannot diagnose unaided.
    chrome.scripting.executeScript = async () => [{ result: { engine: true, gallery: false, ctxAlive: false, reader: null, gal: null } }];
    try {
      await invokeReader(tab.id, 'http://localhost:5099/article.html', 'auto', {});
    } finally { chrome.scripting.executeScript = real; }
    return { text: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) };
  });
  expect(out.text).toBe('!');
  expect(out.title).toContain('Reload this page');
});
