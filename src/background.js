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
  'src/content/reader.js',       // text engine; exposes OBR.toggle()
  'src/content/zip.js',          // OBR._buildZip (used by gallery's ZIP download)
  'src/content/gallery.js'       // image-gallery mode; exposes OBR.toggleGallery()
];

// mode: 'text' (reader), 'images' (masonry gallery), or 'auto' (toolbar icon —
// pick the mode by how many images the page has; see the func below).
async function invokeReader(tabId, url, mode) {
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
      func: (m) => {
        const OBR = globalThis.OBR;
        if (!OBR) return;
        // Explicit intent from the keyboard commands — always honor the named mode.
        if (m === 'images') return OBR.toggleGallery && OBR.toggleGallery();
        if (m === 'text') return OBR.toggle && OBR.toggle();
        // 'auto' (toolbar icon): let the engine pick the mode by image count.
        if (OBR._autoToggle) return OBR._autoToggle();
        return OBR.toggle && OBR.toggle();
      },
      args: [mode]
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
function createMenus() {
  const ctx = ['page', 'image'];
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: 'obr-open', title: 'Open in Book Reader', contexts: ctx });
    chrome.contextMenus.create({ id: 'obr-open-auto', parentId: 'obr-open', title: 'Auto (smart pick)', contexts: ctx });
    chrome.contextMenus.create({ id: 'obr-open-text', parentId: 'obr-open', title: 'Reader (text)', contexts: ctx });
    chrome.contextMenus.create({ id: 'obr-open-images', parentId: 'obr-open', title: 'Gallery (images)', contexts: ctx });
    // Set a persistent whole-site rule (most-specific path rules are typed in Options).
    chrome.contextMenus.create({ id: 'obr-sep', parentId: 'obr-open', type: 'separator', contexts: ctx });
    chrome.contextMenus.create({ id: 'obr-rule-text', parentId: 'obr-open', title: 'Always open this site as Reader', contexts: ctx });
    chrome.contextMenus.create({ id: 'obr-rule-images', parentId: 'obr-open', title: 'Always open this site as Gallery', contexts: ctx });
    chrome.contextMenus.create({ id: 'obr-rule-clear', parentId: 'obr-open', title: 'Clear rule for this site', contexts: ctx });
    void chrome.runtime.lastError;
  });
}

// Add/replace/remove the WHOLE-SITE rule for `host` (read-modify-write the raw settings
// object). OBR.upsertSiteRule folds in any legacy `sites` map and does the add/replace/
// remove — the same shared helper the read (loadSettings) and save paths use.
function setSiteRule(host, mode) {
  if (!host) return;
  chrome.storage.sync.get('obr_settings', (data) => {
    void chrome.runtime.lastError;
    const raw = (data && data.obr_settings) || {};
    OBR.upsertSiteRule(raw, host, mode);
    chrome.storage.sync.set({ obr_settings: raw }, () => { void chrome.runtime.lastError; });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const id = info.menuItemId;
  // Rule items: persist a whole-site rule, then open that mode now (clear just clears).
  if (id === 'obr-rule-text' || id === 'obr-rule-images' || id === 'obr-rule-clear') {
    // Gate on a parseable URL before normalizing: OBR.normalizeHost is lenient (it treats a
    // non-URL string as a bare host), so a falsy/garbage source would otherwise write a bogus
    // whole-site rule. A context-menu source is normally a real page URL; this just keeps the
    // no-op-on-junk guard the deleted hostOf provided (setSiteRule bails on an empty host).
    const src = info.pageUrl || tab.url || '';
    let host = '';
    try { new URL(src); host = OBR.normalizeHost(src); } catch (e) { /* not a real URL — no-op */ }
    if (id === 'obr-rule-clear') return setSiteRule(host, null);
    const mode = id === 'obr-rule-images' ? 'images' : 'text';
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

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  // First install only: open the options page once so the how-to-use guide + shortcuts
  // are seen at least once (not on updates/reloads — reason would be 'update').
  if (details && details.reason === 'install') {
    try { chrome.runtime.openOptionsPage(); } catch (e) { /* */ }
  }
});
// Also recreate on browser startup — onInstalled does NOT fire then, and createMenus
// is removeAll-guarded so re-running is safe. Belt-and-suspenders so the menu is always
// present whenever the service worker is alive, regardless of how it woke.
chrome.runtime.onStartup.addListener(() => { createMenus(); });

/* ---------------------------------------------------------------- downloads
 * The gallery (a content script) can't call chrome.downloads or fetch cross-origin
 * image bytes, so it delegates to the service worker. Those capabilities are
 * OPTIONAL permissions, requested on first use (not at install) — see the
 * permission flow below. */
const FETCH_CONCURRENCY = 5;

async function fetchBytesBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

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

function openPermPopup(need) {
  const params = new URLSearchParams();
  if (need.permissions) params.set('perms', need.permissions.join(','));
  if (need.origins) params.set('origins', need.origins.join(','));
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
  waiters.forEach(({ need, cb }) => chrome.permissions.contains(need, (has) => cb(!!has)));
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

  // The reader/gallery overlay (a content script) can't call openOptionsPage itself —
  // that API exists only in the SW/extension pages. The ⚙ button relays here.
  if (msg.type === 'obr-open-options') {
    try {
      const site = msg.site && String(msg.site).trim();
      // With a site, open the options page scoped to it (?site=...); else the normal page
      // (openOptionsPage focuses an existing options tab — keep that for the unscoped case).
      if (site) {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html?site=' + encodeURIComponent(site)) });
      } else {
        chrome.runtime.openOptionsPage();
      }
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
