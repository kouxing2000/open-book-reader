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
  await page.goto(`chrome-extension://${extensionId}/_locales/en/messages.json`);
  const messages = JSON.parse(await page.locator('body').innerText());
  expect(messages.extName.message).toBe('Open Book — Reader View');
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

  // Positive landmark FIRST: both racing builds ran to completion, each creating all 14
  // ALWAYS-present items. (The fresh test profile has no rules, so the state-scoped
  // "Current selection"/"Stop"/"Clear" rows aren't created here — that's the whole point of the
  // redesign, and it's covered by the state-aware test below.) Without this, a build that
  // silently created nothing would satisfy the no-errors assertion.
  const ids = ['obr-open', 'obr-open-auto', 'obr-open-text', 'obr-open-images',
    'obr-sep', 'obr-configure-default', 'obr-def-auto', 'obr-def-text', 'obr-def-images',
    'obr-sep2', 'obr-rule-auto', 'obr-rule-auto-url', 'obr-sep-opts', 'obr-open-options'];
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
      // enableAutoOpen is fire-and-forget — poll until the rule lands.
      let rule = null;
      for (let i = 0; i < 40 && !rule; i++) {
        await new Promise((res) => setTimeout(res, 50));
        const s = await new Promise((res) => chrome.storage.sync.get('obr_settings', (d) => res(d.obr_settings || {})));
        rule = (s.siteRules || []).find((x) => x.match === 'example.com') || null;
      }
      const regged = await chrome.scripting.getRegisteredContentScripts({ ids: ['obr-sentinel'] });
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
    // the single-file download path is unchanged: a plain `downloads` permission, no origins
    one: permsFor({ type: 'obr-download-one', url: 'https://x.test/a.png' }),
  }));
  // Scheme-specific on purpose: narrower than `*://`, and exactly what we fetch.
  expect(r.single).toEqual({ origins: ['https://i.cdn.test/*'] });
  expect(r.multi).toEqual({ origins: ['https://i.cdn.test/*', 'https://img.other.test/*'] });
  expect(r.port).toEqual({ origins: ['http://host.test/*'] });   // port stripped, or the pattern is invalid
  expect(r.dataOnly).toBeNull();
  expect(r.junk).toBeNull();
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
  }, [...r.single.origins, ...r.multi.origins, ...r.port.origins]);
  Object.entries(wellFormed).forEach(([pattern, verdict]) => {
    expect(verdict, `pattern ${pattern}`).toBe('ok');
  });
});
