/* Open Book Reader — background service worker (MV3)
 *
 * Injects the reader on demand (toolbar click or Alt+B command).
 * Nothing runs against a page until the user explicitly invokes it.
 */

// Reuse the shared settings helpers (host normalization + the legacy sites→siteRules
// migration) instead of re-implementing them here. settings.js touches no DOM at load
// time, so a classic service worker can importScripts it. Leading slash = resolve from
// the extension root (this worker lives in src/, so a bare 'src/…' path would double up).
importScripts('/src/content/settings.js');
const OBR = globalThis.OBR;

const FILES = [
  'src/content/settings.js',     // defines globalThis.OBR.DEFAULTS
  'src/content/readability.js',  // bundled Mozilla Readability (Apache-2.0)
  'src/content/reader.style.js', // reader stylesheet (OBR._readerCSS); loads before reader.js
  'src/content/reader.js',       // text engine; exposes OBR.toggle()
  'src/content/zip.js',          // OBR._buildZip (used by gallery's ZIP download)
  'src/content/gallery.js'       // image-gallery mode; exposes OBR.toggleGallery()
];

// mode: 'text' (reader), 'images' (masonry gallery), or 'auto' (toolbar icon —
// pick the mode by how many images the page has; see the func below).
// opts.auto: the auto-open sentinel triggered this (no gesture): dispatch calls
// OBR.open/openGallery DIRECTLY with { trigger: 'auto' } — never the toggles, which
// could CLOSE a just-opened overlay on a rare double fire — and the engines show the
// "Auto-opened" chip.
async function invokeReader(tabId, url, mode, opts) {
  if (!tabId) return;
  // Don't try to inject into restricted pages.
  if (url && /^(chrome|edge|about|chrome-extension|edge-extension|view-source):/i.test(url)) {
    return;
  }

  try {
    // Inject the engine once per tab; OBR._engineLoaded marks it present.
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(globalThis.OBR && globalThis.OBR._engineLoaded)
    });
    if (!result) {
      await chrome.scripting.executeScript({ target: { tabId }, files: FILES });
    }

    // Toggle the requested mode.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (m, auto) => {
        const OBR = globalThis.OBR;
        if (!OBR) return;
        if (auto) {
          // Sentinel-triggered: open directly (mode was resolved page-side).
          if (m === 'images') return OBR.openGallery && OBR.openGallery({ trigger: 'auto' });
          return OBR.open && OBR.open({ trigger: 'auto' });
        }
        // Explicit intent from the keyboard commands — always honor the named mode.
        if (m === 'images') return OBR.toggleGallery && OBR.toggleGallery();
        if (m === 'text') return OBR.toggle && OBR.toggle();
        // 'auto' (toolbar icon): let the engine pick the mode by image count.
        if (OBR._autoToggle) return OBR._autoToggle();
        return OBR.toggle && OBR.toggle();
      },
      args: [mode, !!(opts && opts.auto)]
    });
  } catch (err) {
    console.error('[OpenBookReader] injection failed:', err);
  }
}

chrome.action.onClicked.addListener((tab) => invokeReader(tab.id, tab.url, 'auto'));

chrome.commands.onCommand.addListener(async (command) => {
  const mode = command === 'toggle-gallery' ? 'images'
    : command === 'toggle-reader' ? 'text'
    : null;
  if (!mode) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) invokeReader(tab.id, tab.url, mode);
});

/* --------------------------------------------------------- context menu
 * A third trigger surface (alongside the toolbar icon and keyboard commands).
 * A context-menu click grants activeTab, so invokeReader injects on the active tab
 * with no host permission — same model as the toolbar. Leaf items map to a mode;
 * the parent item never fires onClicked when it has children. */
// Builds are SERIALIZED on this chain. createMenus() can run twice in one worker lifetime
// (Chrome fires onStartup *and* onInstalled/'update' when an update is applied while the
// browser was closed), and two overlapping calls both queue their removeAll() before either
// one creates anything — so the second call's creates land on top of the first's items and
// every id collides ("Cannot create item with duplicate id obr-open", ...). Awaiting each
// step keeps a removeAll from ever being queued ahead of a previous batch's creates.
// A failed step is logged with console.WARN, never console.error: chrome://extensions
// collects the worker's console.error into the extension's Errors list — the very red badge
// this serialization exists to prevent. A warn keeps the failure visible in the SW console
// (and one failed parent means every child fails too, i.e. NO menu — worth seeing) without
// re-creating the symptom.
// Open the options page, optionally SCOPED to a site (its rules/picks/hidden lists filter
// to that host, with a "Show all" chip). Shared by the reader/gallery ⚙ relay and the
// context-menu "Settings…" item. Always routes through openOptionsPage() so an already-open
// options tab is FOCUSED, not duplicated (we can't dedupe via tabs.query without the `tabs`
// permission — a deliberate non-goal). The scope rides a one-shot chrome.storage.local key
// instead of a ?site= URL: options.js reads + clears it on load, and its storage.onChanged
// listener re-scopes a tab that's already open. (local, not session — session doesn't
// reliably survive the SW→page handoff; the key is consumed immediately so it never lingers.)
function openOptionsForSite(site) {
  const s = site && String(site).trim();
  const openPage = () => { try { chrome.runtime.openOptionsPage(); } catch (e) { /* */ } };
  try {
    if (s && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ obr_options_site: s }, openPage); // stash, THEN open
    } else {
      openPage();
    }
  } catch (e) { openPage(); }
}

// The migrated siteRules from storage (a fresh array; [] on any failure). Used by
// createMenus() to tailor the menu to the current site's saved state.
function getSiteRules() {
  return new Promise((res) => {
    try {
      chrome.storage.sync.get('obr_settings', (d) => {
        void chrome.runtime.lastError;
        const raw = (d && d.obr_settings) || {};
        OBR.migrateSiteRules(raw);
        res(raw.siteRules || []);
      });
    } catch (e) { res([]); }
  });
}

let menuBuild = Promise.resolve();
function createMenus() {
  menuBuild = menuBuild.then(async () => {
    const ctx = ['page', 'image'];
    const removeAll = () => new Promise((res) => chrome.contextMenus.removeAll(() => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[OpenBookReader] contextMenus.removeAll:', err.message);
      res();
    }));
    const add = (props) => new Promise((res) => chrome.contextMenus.create(props, () => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[OpenBookReader] contextMenus.create', props.id + ':', err.message);
      res();
    }));

    // State-aware menu (docs/auto-open-spec.md): the menu reflects the current SITE's
    // saved rules. Chrome has no "menu about to open" event and we hold no `tabs`
    // permission, so we can't morph by the page under the cursor at click time — but
    // `documentUrlPatterns` makes an item appear only on matching sites (declarative,
    // permission-free), and we rebuild here on every siteRules change. Hard limit:
    // patterns only ADD an item, they can't HIDE a generic one (match patterns have no
    // negation), so a site's state shows as an ADDED "Stop"/"Clear" beside the
    // always-present actions — a pair, not a swap.
    const rules = await getSiteRules();
    const uniq = (a) => [...new Set(a)];
    // "Clear rule" (menu) removes only the WHOLE-SITE rule, so offer it only where one
    // exists (`match` with no path) — this kills the old no-op "Clear" on fresh sites.
    const clearPatterns = uniq(rules
      .filter((r) => r && r.match && r.mode && r.match.indexOf('/') === -1)
      .flatMap((r) => OBR.originsForRule(r.match)));
    // "Stop auto-opening" appears wherever an auto rule matches (path rules too; the
    // handler uses info.pageUrl to clear the exact one).
    const autoPatterns = uniq(rules
      .filter((r) => r && r.auto === true && r.match && r.mode)
      .flatMap((r) => OBR.originsForRule(r.match)));

    await removeAll();
    await add({ id: 'obr-open', title: OBR.t('ctxOpenTitle'), contexts: ctx });
    // Band 1 — open once (one-shot, this visit only).
    await add({ id: 'obr-open-auto', parentId: 'obr-open', title: OBR.t('ctxAuto'), contexts: ctx });
    await add({ id: 'obr-open-text', parentId: 'obr-open', title: OBR.t('ctxReader'), contexts: ctx });
    await add({ id: 'obr-open-images', parentId: 'obr-open', title: OBR.t('ctxGallery'), contexts: ctx });
    // Band 2 — the site's DEFAULT VIEW (a persistent whole-site rule; path rules are
    // typed in Options). This is the "which view" axis.
    await add({ id: 'obr-sep', parentId: 'obr-open', type: 'separator', contexts: ctx });
    await add({ id: 'obr-rule-text', parentId: 'obr-open', title: OBR.t('ctxAlwaysReader'), contexts: ctx });
    await add({ id: 'obr-rule-images', parentId: 'obr-open', title: OBR.t('ctxAlwaysGallery'), contexts: ctx });
    // Band 3 — AUTO-OPEN, a separate axis (whether the view opens with no click). Kept
    // apart from Band 2 by its own divider — the user asked not to conflate the two.
    await add({ id: 'obr-sep2', parentId: 'obr-open', type: 'separator', contexts: ctx });
    await add({ id: 'obr-rule-auto', parentId: 'obr-open', title: OBR.t('ctxAutoOpen'), contexts: ctx });
    if (autoPatterns.length) {
      await add({ id: 'obr-rule-auto-stop', parentId: 'obr-open', title: OBR.t('ctxStopAutoOpen'), contexts: ctx, documentUrlPatterns: autoPatterns });
    }
    // Clear — only on sites that actually carry a whole-site rule.
    if (clearPatterns.length) {
      await add({ id: 'obr-sep3', parentId: 'obr-open', type: 'separator', contexts: ctx, documentUrlPatterns: clearPatterns });
      await add({ id: 'obr-rule-clear', parentId: 'obr-open', title: OBR.t('ctxClearRule'), contexts: ctx, documentUrlPatterns: clearPatterns });
    }
    // Footer — a jump to the full options page (scoped to this site), always available.
    await add({ id: 'obr-sep-opts', parentId: 'obr-open', type: 'separator', contexts: ctx });
    await add({ id: 'obr-open-options', parentId: 'obr-open', title: OBR.t('ctxOptions'), contexts: ctx });
  }).catch((e) => {
    // Swallow so a failed build can't poison the chain for the next one — but say so.
    console.warn('[OpenBookReader] context menu build failed:', e);
  });
  return menuBuild;
}

// Add/replace/remove the WHOLE-SITE rule for `host` (read-modify-write the raw settings
// object). OBR.upsertSiteRule folds in any legacy `sites` map and does the add/replace/
// remove — the same shared helper the read (loadSettings) and save paths use.
// `opts.auto` (optional) sets/clears the auto-open flag; absent preserves it.
// `then` (optional) runs after the write commits.
function setSiteRule(host, mode, opts, then) {
  if (!host) return;
  chrome.storage.sync.get('obr_settings', (data) => {
    void chrome.runtime.lastError;
    const raw = (data && data.obr_settings) || {};
    OBR.upsertSiteRule(raw, host, mode, opts);
    chrome.storage.sync.set({ obr_settings: raw }, () => {
      void chrome.runtime.lastError;
      if (then) then();
    });
  });
}

/* --------------------------------------------------------- auto-open sentinel
 * Per-site auto-open (docs/auto-open-spec.md): rules carrying `auto: true` get a tiny
 * REGISTERED content script (the sentinel) on their granted origins, which runs the
 * strict decision ladder on each page load / SPA navigation and messages back here to
 * open. Registration is DECLARATIVE state in Chrome — this block keeps it in sync with
 * the settings + the granted permissions. */
const SENTINEL_ID = 'obr-sentinel';
const SENTINEL_FILES = ['src/content/settings.js', 'src/content/sentinel.js'];

// Serialized + idempotent on a promise chain, exactly like createMenus(): onInstalled
// and onStartup can both fire in one worker activation, and two overlapping syncs would
// race the register/update/unregister diff. Failures log via console.warn, never
// console.error (the chrome://extensions red-badge rule).
let sentinelSync = Promise.resolve();
function syncSentinelRegistration() {
  sentinelSync = sentinelSync.then(async () => {
    const raw = await new Promise((res) => {
      try { chrome.storage.sync.get('obr_settings', (d) => { void chrome.runtime.lastError; res((d && d.obr_settings) || {}); }); }
      catch (e) { res({}); }
    });
    OBR.migrateSiteRules(raw);
    // The union of origin patterns over all auto rules...
    let patterns = [];
    for (const r of raw.siteRules) {
      if (r && r.auto === true && r.match && r.mode) patterns.push(...OBR.originsForRule(r.match));
    }
    patterns = [...new Set(patterns)];
    // ...filtered to what's actually granted. Registering an UNGRANTED (but valid)
    // pattern would merely never inject — this filter is hygiene, keeping the
    // registration equal to what can run. (Invalid globs never get here:
    // originsForRule returns [] for them, which matters — one invalid pattern
    // rejects a whole registerContentScripts call.)
    const granted = [];
    for (const p of patterns) {
      const has = await new Promise((res) => {
        try { chrome.permissions.contains({ origins: [p] }, (h) => { void chrome.runtime.lastError; res(!!h); }); }
        catch (e) { res(false); }
      });
      if (has) granted.push(p);
    }
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SENTINEL_ID] }).catch(() => []);
    const current = existing && existing[0];
    if (!granted.length) {
      // No active auto rules → UNREGISTER entirely (an empty `matches` array is invalid).
      if (current) await chrome.scripting.unregisterContentScripts({ ids: [SENTINEL_ID] });
      return;
    }
    const desired = {
      id: SENTINEL_ID,
      js: SENTINEL_FILES,
      matches: granted,
      runAt: 'document_idle',
      persistAcrossSessions: true, // Chrome 96+; survives restarts so startup needs no re-registration
    };
    const same = current && JSON.stringify((current.matches || []).slice().sort()) === JSON.stringify(granted.slice().sort());
    if (!current) await chrome.scripting.registerContentScripts([desired]);
    else if (!same) await chrome.scripting.updateContentScripts([desired]);
  }).catch((e) => {
    console.warn('[OpenBookReader] sentinel registration sync failed:', e && e.message ? e.message : e);
  });
  return sentinelSync;
}

// Registration only affects FUTURE document loads — on an SPA forum the enabling tab
// would stay sentinel-less until a full reload (no auto-open on the very next topic
// click). So the enable flow also injects the sentinel straight into the current tab,
// then re-arms it with the one-shot "just enabled" flag (the ladder decides between
// opening right away and showing the confirmation chip; on a RE-enable the sentinel's
// own double-injection guard makes the file loads a no-op and the explicit arm is what
// restarts probing).
async function injectSentinelNow(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { (globalThis.OBR = globalThis.OBR || {})._justEnabled = true; }
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: SENTINEL_FILES });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { const O = globalThis.OBR; if (O && O._sentinelArm) O._sentinelArm(); }
    });
  } catch (e) {
    console.warn('[OpenBookReader] sentinel inject failed:', e && e.message ? e.message : e);
  }
}

// The context-menu "Auto-open on this site" flow: ensure the origin permission (via the
// permission popup when not yet granted — its click is the genuine gesture
// permissions.request needs), flag the rule, sync registration, arm the current tab.
function enableAutoOpen(host, tab) {
  const origins = OBR.originsForRule(host);
  if (!origins.length) return; // host can't form a match pattern — options page explains this case
  const finish = () => {
    chrome.storage.sync.get('obr_settings', (data) => {
      void chrome.runtime.lastError;
      const raw = (data && data.obr_settings) || {};
      OBR.migrateSiteRules(raw);
      const prev = raw.siteRules.find((r) => r && r.match === host);
      const mode = (prev && prev.mode) || 'auto'; // keep an existing mode choice; else decide per page
      OBR.upsertSiteRule(raw, host, mode, { auto: true });
      chrome.storage.sync.set({ obr_settings: raw }, async () => {
        void chrome.runtime.lastError;
        await syncSentinelRegistration(); // storage.onChanged also fires, but be explicit + ordered
        injectSentinelNow(tab && tab.id);
      });
    });
  };
  try {
    chrome.permissions.contains({ origins }, (has) => {
      void chrome.runtime.lastError;
      if (has) return finish();
      requestPerm({ origins, reason: 'auto-open', host }, (granted) => { if (granted) finish(); });
    });
  } catch (e) {
    console.warn('[OpenBookReader] auto-open enable failed:', e && e.message ? e.message : e);
  }
}

// Keep the registration honest across every input that feeds it: settings writes that
// actually change siteRules (every font nudge writes obr_settings — don't wake a
// re-diff for those), permission grants/revocations (a revoked origin deactivates that
// site's sentinel; the rule keeps its flag and re-arms if the permission comes back),
// and worker activations.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.obr_settings) return;
  const rulesOf = (v) => JSON.stringify((v && (v.siteRules || v.sites)) || []);
  if (rulesOf(changes.obr_settings.oldValue) !== rulesOf(changes.obr_settings.newValue)) {
    syncSentinelRegistration();
    createMenus(); // the state-aware menu (Stop / Clear visibility) follows the rules
  }
});
chrome.permissions.onAdded.addListener(() => { syncSentinelRegistration(); });
chrome.permissions.onRemoved.addListener(() => { syncSentinelRegistration(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const id = info.menuItemId;
  // "Settings…": open the options page, scoped to this site (same as the overlay ⚙).
  if (id === 'obr-open-options') {
    const src = info.pageUrl || tab.url || '';
    let host = '';
    try { new URL(src); host = OBR.normalizeHost(src); } catch (e) { /* not a real URL — open unscoped */ }
    openOptionsForSite(host);
    return;
  }
  // "Stop auto-opening on this site": clear the auto flag on whichever rule matches the
  // page (path rules included), keeping its mode. Uses info.pageUrl so a path-scoped auto
  // rule is turned off precisely; the storage write re-syncs registration + rebuilds the
  // menu (Stop then disappears here). No open/close — just flips the flag.
  if (id === 'obr-rule-auto-stop') {
    const src = info.pageUrl || tab.url || '';
    chrome.storage.sync.get('obr_settings', (data) => {
      void chrome.runtime.lastError;
      const raw = (data && data.obr_settings) || {};
      OBR.migrateSiteRules(raw);
      const rule = OBR.matchSiteRuleEx(src, raw.siteRules);
      if (rule && rule.auto) {
        raw.siteRules = OBR.setRuleAuto(raw.siteRules, rule.match, false);
        chrome.storage.sync.set({ obr_settings: raw }, () => { void chrome.runtime.lastError; });
      }
    });
    return;
  }
  // Rule items: persist a whole-site rule, then open that mode now (clear just clears).
  if (id === 'obr-rule-text' || id === 'obr-rule-images' || id === 'obr-rule-clear' || id === 'obr-rule-auto') {
    // Gate on a parseable URL before normalizing: OBR.normalizeHost is lenient (it treats a
    // non-URL string as a bare host), so a falsy/garbage source would otherwise write a bogus
    // whole-site rule. A context-menu source is normally a real page URL; this just keeps the
    // no-op-on-junk guard the deleted hostOf provided (setSiteRule bails on an empty host).
    const src = info.pageUrl || tab.url || '';
    let host = '';
    try { new URL(src); host = OBR.normalizeHost(src); } catch (e) { /* not a real URL — no-op */ }
    if (id === 'obr-rule-clear') return setSiteRule(host, null);
    if (id === 'obr-rule-auto') return host && enableAutoOpen(host, tab);
    const mode = id === 'obr-rule-images' ? 'images' : 'text';
    // Preserving the auto flag here (no opts) means "Always open as…" on an
    // auto-enabled site changes the mode without silently killing auto-open.
    setSiteRule(host, mode);
    return invokeReader(tab.id, tab.url, mode);
  }
  // Open-once items.
  const mode = id === 'obr-open-text' ? 'text'
    : id === 'obr-open-images' ? 'images'
    : (id === 'obr-open-auto' || id === 'obr-open') ? 'auto'
    : null;
  if (mode) invokeReader(tab.id, tab.url, mode);
});

// The uninstall survey (a static GitHub Pages form) is our only window into WHY people
// leave — the extension itself collects nothing, so a churned user is otherwise invisible.
// Chrome opens this URL in a tab on uninstall; the page transmits only what the user chooses
// to type (see site/uninstall.html). Param-free by design — the extension appends NO
// version/usage data. (Opening the page still makes the browser's own request to GitHub
// Pages, as any navigation does — but the extension itself sends nothing.)
const UNINSTALL_SURVEY_URL = 'https://kouxing2000.github.io/open-book-reader/uninstall.html';

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  syncSentinelRegistration(); // registration persists, but an update may change the rules/logic
  // Set on install AND update so a changed survey URL propagates with the next version.
  try { chrome.runtime.setUninstallURL(UNINSTALL_SURVEY_URL); } catch (e) { /* */ }
  // First install only: open a one-screen WELCOME page — pin the icon, the two shortcuts, a
  // sample article — so a brand-new user reaches first value in one glance. (Not on
  // updates/reloads — reason would be 'update'.) The old flow opened the OPTIONS page, i.e.
  // a settings form for a thing they hadn't used yet — configuration, not activation.
  if (details && details.reason === 'install') {
    try { chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') }); } catch (e) { /* */ }
  }
});
// Also recreate on browser startup — onInstalled does NOT fire on a plain launch, and
// createMenus serializes its builds so re-running (or racing onInstalled, which DOES fire
// at startup when an update was applied while the browser was closed) is safe.
// Belt-and-suspenders so the menu is always present whenever the worker is alive.
chrome.runtime.onStartup.addListener(() => { createMenus(); syncSentinelRegistration(); });

/* ---------------------------------------------------------------- downloads
 * The gallery (a content script) can't call chrome.downloads or fetch cross-origin
 * image bytes, so it delegates to the service worker. Those capabilities are
 * OPTIONAL permissions, requested on first use (not at install) — see the
 * permission flow below. */
const FETCH_CONCURRENCY = 5;

async function fetchBytesBase64(url) {
  // These URLs are page-supplied <img> src values, so a hostile/compromised page can
  // seed them. The ZIP "download all" fetches each in the service worker after the
  // on-demand <all_urls> grant, so harden against SSRF-into-local-file:
  //   1. Protocol allowlist — only http(s). Blocks file:/blob:/data:/chrome:/ftp:, so
  //      a crafted <img src="file:///etc/passwd"> can't route a local file into the ZIP.
  //   2. No credentials — a seeded URL pointing at an authenticated same-site endpoint
  //      then gets no cookies, so no logged-in/private content is captured. (Trade-off:
  //      images strictly behind a login/session gate now 403 and land in the per-image
  //      "failed" count; the user can still single-download those via chrome.downloads,
  //      which uses the browser's own cookie jar.)
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw new Error('invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('unsupported protocol: ' + parsed.protocol);
  }
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

// Test-only hook: exposes the ZIP-fetch helper so the e2e suite can assert the SSRF
// hardening above (protocol allowlist + credential-less fetch) directly, since the
// message path needs an interactive <all_urls> grant that headless tests can't drive.
// Mirrors the unconditional `OBR._*` test helpers the content scripts already expose.
if (typeof self !== 'undefined') self.__obrFetchBytesBase64 = fetchBytesBase64;

// Run an async worker over items with bounded concurrency.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

// Do the actual download work (assumes the needed permission is already granted).
function runDownload(msg, sendResponse) {
  if (msg.type === 'obr-download-one') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename || undefined, conflictAction: 'uniquify' },
      () => { void chrome.runtime.lastError; sendResponse({ ok: true }); }
    );
  } else if (msg.type === 'obr-fetch-bytes') {
    runPool(msg.urls, FETCH_CONCURRENCY, async (url) => {
      try { return { url, ok: true, b64: await fetchBytesBase64(url) }; }
      catch (e) { return { url, ok: false }; }
    }).then((results) => sendResponse({ results }), () => sendResponse({ results: [] }));
  }
}

/* Optional-permission flow.
 * A content script can't call chrome.permissions.request (the API isn't exposed
 * there), and relaying to the SW loses the user-gesture context. So when a
 * download needs a permission we don't yet hold, we open a tiny extension page
 * (src/permission.html) where the user's click IS a genuine gesture that can call
 * permissions.request. Each action asks only for what it needs: a single download
 * needs `downloads`; a ZIP needs cross-origin `<all_urls>` to fetch the bytes. */
function permsFor(type) {
  if (type === 'obr-download-one') return { permissions: ['downloads'] };
  if (type === 'obr-fetch-bytes') return { origins: ['<all_urls>'] };
  return null;
}

let permWindowId = null;
const permWaiters = []; // { need, cb }; cb(granted) runs once the prompt resolves

// A `need` may carry routing extras (reason/host — which explanation the popup shows).
// chrome.permissions.* validates its schema strictly, so strip them before any API call.
function permsOnly(need) {
  const clean = {};
  if (need.permissions) clean.permissions = need.permissions;
  if (need.origins) clean.origins = need.origins;
  return clean;
}

function openPermPopup(need) {
  const params = new URLSearchParams();
  if (need.permissions) params.set('perms', need.permissions.join(','));
  if (need.origins) params.set('origins', need.origins.join(','));
  if (need.reason) params.set('reason', need.reason);
  if (need.host) params.set('host', need.host);
  chrome.windows.create(
    {
      url: chrome.runtime.getURL('src/permission.html') + '?' + params.toString(),
      type: 'popup',
      width: 460,
      height: 340,
    },
    (win) => {
      void chrome.runtime.lastError;
      if (win) permWindowId = win.id;
      else resolveWaiters(); // couldn't open the prompt — don't leave callers hanging
    }
  );
}

function requestPerm(need, cb) {
  const wasIdle = permWaiters.length === 0;
  permWaiters.push({ need, cb });
  if (wasIdle) openPermPopup(need); // one popup at a time; later requests queue
}

// Resolve every waiter against the real post-prompt permission state. Safe to call
// more than once (the result message and the window-close event can both arrive):
// the first call drains the queue, later calls find it empty and no-op. We re-check
// chrome.permissions.contains per waiter rather than trusting a single granted bit,
// because waiters may need different permissions and the popup only asked for the
// first one's. contains is authoritative here — permissions.request commits the grant
// before its callback (and thus before either event) fires.
function resolveWaiters() {
  permWindowId = null;
  const waiters = permWaiters.splice(0);
  waiters.forEach(({ need, cb }) => chrome.permissions.contains(permsOnly(need), (has) => cb(!!has)));
}

// If the user closes the popup window without answering, treat it as a decline.
chrome.windows.onRemoved.addListener((id) => {
  if (id === permWindowId) resolveWaiters();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // The permission page reports its result; re-evaluate everything waiting.
  // Respond so the page's close() is driven by a real reply, not a closed channel.
  if (msg.type === 'obr-perms-result') { resolveWaiters(); sendResponse({ ok: true }); return true; }

  // The auto-open sentinel passed its ladder. Don't trust page-side state: re-run the
  // rule match on the SENDER's URL against fresh settings and require the winning rule
  // to actually carry auto:true (a page can't talk itself into an open the user never
  // configured); the mode must be one of the two concrete engines and must agree with
  // the rule (an 'auto' rule resolves page-side, so either engine is legitimate there).
  if (msg.type === 'obr-auto-open') {
    const tab = _sender && _sender.tab;
    const url = (_sender && _sender.url) || (tab && tab.url) || '';
    const mode = msg.mode === 'images' ? 'images' : msg.mode === 'text' ? 'text' : null;
    if (!tab || !tab.id || !url || !mode) { sendResponse({ ok: false }); return true; }
    chrome.storage.sync.get('obr_settings', (data) => {
      void chrome.runtime.lastError;
      const raw = (data && data.obr_settings) || {};
      OBR.migrateSiteRules(raw);
      const rule = OBR.matchSiteRuleEx(url, raw.siteRules);
      if (!rule || rule.auto !== true || (rule.mode !== 'auto' && rule.mode !== mode)) {
        sendResponse({ ok: false });
        return;
      }
      invokeReader(tab.id, url, mode, { auto: true });
      sendResponse({ ok: true });
    });
    return true; // async response
  }

  // The reader/gallery overlay (a content script) can't call openOptionsPage itself —
  // that API exists only in the SW/extension pages. The ⚙ button relays here; the
  // context-menu "Settings…" item calls the same helper directly (see below).
  if (msg.type === 'obr-open-options') {
    openOptionsForSite(msg.site);
    sendResponse({ ok: true });
    return true;
  }

  // The ⚠ Report button relays here — content scripts can't call chrome.tabs.create. Open the
  // bundled report page (first-party, offline) with the diagnostics in the URL #fragment (which
  // never leaves the device — it's the extension's own page). The page offers email or a web form.
  if (msg.type === 'obr-open-report') {
    try {
      const frag = encodeURIComponent(JSON.stringify(msg.meta || {}));
      chrome.tabs.create({ url: chrome.runtime.getURL('src/report.html') + '#' + frag });
    } catch (e) { /* */ }
    sendResponse({ ok: true });
    return true;
  }

  if ((msg.type === 'obr-download-one' && msg.url) ||
      (msg.type === 'obr-fetch-bytes' && Array.isArray(msg.urls))) {
    const need = permsFor(msg.type);
    chrome.permissions.contains(need, (has) => {
      if (has) return runDownload(msg, sendResponse);
      requestPerm(need, (granted) => {
        if (granted) runDownload(msg, sendResponse);
        else sendResponse(msg.type === 'obr-fetch-bytes' ? { results: [], denied: true } : { ok: false, denied: true });
      });
    });
    return true; // async response
  }
});
