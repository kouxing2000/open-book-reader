/* Open Book Reader — background service worker (MV3)
 *
 * Injects the reader on demand (toolbar click or Alt+B command).
 * Nothing runs against a page until the user explicitly invokes it.
 */

// Reuse the shared settings helpers (host normalization + the legacy sites→siteRules
// migration) instead of re-implementing them here. settings.js touches no DOM at load
// time, so a classic service worker can importScripts it. Leading slash = resolve from
// the extension root (this worker lives in src/, so a bare 'src/…' path would double up).
// MV3 evicts this worker after ~30s idle, so a trigger arriving cold pays for this whole
// top-level evaluation before ANY listener can run — the usual cause of "the first press did
// nothing, the next one was instant". performance.now() in a worker is measured from the
// worker's own creation, so these two readings ARE the cold-start cost, reported by swLog().
const SW_IMPORT_T0 = performance.now();
importScripts('/src/content/settings.js');
const SW_IMPORT_MS = Math.round(performance.now() - SW_IMPORT_T0);
const OBR = globalThis.OBR;

const FILES = [
  'src/content/settings.js',     // defines globalThis.OBR.DEFAULTS
  'src/content/readability.js',  // bundled Mozilla Readability (Apache-2.0)
  'src/content/reader.style.js', // reader stylesheet (OBR._readerCSS); loads before reader.js
  'src/content/qrcode.js',       // vendored qrcode-generator (MIT); the print branding QR
  'src/content/reader.js',       // text engine; exposes OBR.toggle()
  'src/content/zip.js',          // OBR._buildZip (used by gallery's ZIP download)
  'src/content/gallery.js',      // image-gallery mode; exposes OBR.toggleGallery()
  'src/content/notice.js'        // OBR._notice — the page-level banner (reader.js paint check)
];

// The banner alone, for a page where the ENGINE cannot be trusted to draw anything (an orphaned
// isolated world). Self-contained by design — see the constraints at the top of notice.js.
const NOTICE_FILES = ['src/content/notice.js'];

/* The schemes the injection guard refuses to even attempt. Deliberately NARROW: file:// is not
 * here because it WORKS once the user grants file access, and widening this would take that away. */
const RESTRICTED_SCHEME = /^(chrome|edge|about|chrome-extension|edge-extension|view-source):/i;

/* Is this failure the browser's rule rather than our fault? A different, WIDER question than the
 * guard above, and it decides one thing only: whether the blocked popup offers a Report link.
 * It has to match what that popup's own bullet list already tells the user — the Web Store and
 * local files are named there, so classifying them as our fault would have the popup contradict
 * itself one line apart and invite reports about something no release can change.
 * Not knowable from the URL, and therefore deliberately failing CLOSED (report offered) rather
 * than open: a page that is scriptable in principle but failed transiently. */
function isHardBlock(url) {
  if (!url) return true;                       // a restricted tab reports no URL to a worker holding no host access
  if (RESTRICTED_SCHEME.test(url)) return true;
  if (/^(file|blob|data|filesystem|devtools|chrome-untrusted):/i.test(url)) return true;
  if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) return true;
  if (/\.pdf($|[?#])/i.test(url)) return true; // Chrome's inline PDF viewer is not scriptable
  return false;
}

/* Trigger tracing (only when OBR.debugTiming(true) — see settings.js). Answers "did my click
 * even reach the worker?", which is the question a silent first trigger raises. `swAge` is
 * performance.now() in the WORKER, i.e. ms since this service worker started: a small value
 * (< ~200ms) means the trigger COLD-STARTED the worker — MV3 evicts it after ~30s idle, and that
 * boot (plus importScripts of settings.js) is the usual reason a first press feels dead while the
 * next one is instant. A large value means the worker was already warm, so a failure there is NOT
 * cold start and the reason will be in the lines that follow. */
// Trace emitted BEFORE the debug flag finished hydrating from storage. Without this the very
// trigger that cold-started the worker — the case this instrumentation exists for — would be
// dropped, because the queued event and the async storage read are in flight simultaneously,
// and the reader would then wrongly conclude "the worker never woke". Bounded so a debug-off
// session can never accumulate.
const SW_PENDING = [];
const SW_PENDING_MAX = 40;
// "Worth building a trace line for": debug is on, OR the flag hasn't resolved yet so we can't
// tell — in which case swLog buffers it and the flush decides. Callers use this to avoid the
// eager JSON.stringify on the hot path once we KNOW debug is off.
const swWant = () => OBR._debug || !OBR._debugReady;
OBR._onDebugReady = function () {
  if (OBR._debug) { for (let i = 0; i < SW_PENDING.length; i++) { try { console.info.apply(console, SW_PENDING[i]); } catch (e) { /* */ } } }
  SW_PENDING.length = 0;
};

function swLog() {
  // Not resolved yet: buffer rather than drop, and decide once the flag lands.
  if (!OBR._debug && !OBR._debugReady) {
    if (SW_PENDING.length < SW_PENDING_MAX) SW_PENDING.push(swLogArgs(arguments));
    return;
  }
  if (!OBR._debug) return;
  try {
    // The tag (swAge / boot / import) is built by swLogArgs below. boot = how long the worker
    // took to become READY (top-level evaluated, listeners registered); import = the settings.js
    // importScripts slice of that. A trigger whose swAge is close to boot waited out a cold start
    // — that IS the delay you felt. When swAge >> boot the worker was already warm, so a failure
    // there is NOT cold start; look further down the trace instead.
    console.info.apply(console, swLogArgs(arguments));
  } catch (e) { /* */ }
}

// Build the tagged argument list once, so a buffered line keeps the swAge/boot reading from
// WHEN IT HAPPENED rather than from when it was eventually flushed.
function swLogArgs(args) {
  const age = Math.round(performance.now());
  const ready = typeof SW_BOOT_MS === 'number' ? SW_BOOT_MS : -1;
  const tag = '[OBR sw] (swAge=' + age + 'ms boot=' + ready + 'ms import=' + SW_IMPORT_MS + 'ms'
    + (ready >= 0 && age - ready < 250 ? ' COLD-START' : '') + ')';
  return [tag].concat(Array.prototype.slice.call(args));
}

/* A "working on it" badge on the toolbar icon. Injecting the content scripts happens BEFORE any
 * content script exists to draw an in-page toast, so that feedback has to come from the worker.
 * chrome.action badges need no permission and work on any tab. DELAYED (see BADGE_DELAY_MS) so a
 * normal fast open never flashes it; only an open slow enough to look broken gets a visible signal.
 *
 * ACCEPTED LIMITATION — this badge covers the INJECTION only, never the worker's own cold start,
 * which is the dominant cost of a slow open. showWorking() is called from invokeReader, which runs
 * from a listener, and Chrome dispatches no listener until top-level evaluation has finished — so
 * the silent phase is precisely the phase nothing can paint. Closed WONTFIX 2026-07-24; the
 * measured evidence and every rejected alternative (default_popup, an alarms keepalive) are in
 * docs/background-worker.md — read that before re-opening it. */
const BADGE_DELAY_MS = 350;
const badgeTimers = new Map();
function showWorking(tabId) {
  clearWorking(tabId);
  badgeTimers.set(tabId, setTimeout(() => {
    try {
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c6cff' }, () => void chrome.runtime.lastError);
      chrome.action.setBadgeText({ tabId, text: '...' }, () => void chrome.runtime.lastError);
    } catch (e) { /* tab gone */ }
  }, BADGE_DELAY_MS));
}
function clearWorking(tabId) {
  const t = badgeTimers.get(tabId);
  if (t) { clearTimeout(t); badgeTimers.delete(tabId); }
  try { chrome.action.setBadgeText({ tabId, text: '' }, () => void chrome.runtime.lastError); } catch (e) { /* */ }
}

/* ------------------------------------------------------------ failure states
 * The two ways a trigger can do NOTHING from the user's seat: the page forbids injection
 * ('blocked'), or the page carries an orphaned engine that only a reload can replace
 * ('reload'). Both used to report to the service-worker console alone, so all the user saw
 * was a dead click — indistinguishable from a broken extension.
 *
 * Painted on the ACTION (badge + tooltip) because that is the only surface that survives the
 * failure: on a restricted page we cannot inject anything, so an in-page toast is impossible
 * exactly where it is most needed, while chrome.action needs no permission and works on any
 * tab. The badge is one glyph (Chrome shows ~4 characters) — the TOOLTIP carries the message. */
const FAILURE_BADGE = '!';
const FAILURE_COLOR = '#c5221f'; // red; must not read as the '...' working badge (#7c6cff)
// Key + English fallback, read the way src/permission.js reads its strings: a missing catalog
// entry still says something usable instead of surfacing a bare key.
const FAILURE_TEXT = {
  blocked: ['actionCannotRunHere',
    "Open Book Reader can't run on this page — the browser blocks extensions here. Try it on an article page."],
  reload: ['actionReloadNeeded',
    'Reload this page to use Open Book Reader — the extension was updated while this tab was open.'],
};
function i18nOr(key, fallback) {
  try { return (chrome.i18n && chrome.i18n.getMessage(key)) || fallback; } catch (e) { return fallback; }
}

/* NOTHING CLEARS THIS STATE, on purpose. Chrome drops tab-specific badge text AND title on a
 * cross-document navigation of that tab (reloads included), so the '!' expires exactly when
 * its diagnosis does, with no listener of ours — and a tabs.onUpdated listener is the one
 * thing that would wake this worker on every navigation in every tab, which for an on-demand
 * extension is a real cost for nothing. Same-document (SPA) navigation does NOT clear it, and
 * must not: neither state can be fixed without a real load, so the message stays true. Both
 * halves are pinned by a test in tests/extension-load.spec.js — if a future Chrome stops
 * clearing, that test goes red and this comment is the thing to revisit. */
function showFailure(tabId, state, url) {
  const msg = FAILURE_TEXT[state];
  if (!msg) return;
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: FAILURE_COLOR }, () => void chrome.runtime.lastError);
    chrome.action.setBadgeText({ tabId, text: FAILURE_BADGE }, () => void chrome.runtime.lastError);
    chrome.action.setTitle({ tabId, title: i18nOr(msg[0], msg[1]) }, () => void chrome.runtime.lastError);
    // The badge is invisible to anyone who has not PINNED the icon (an unpinned extension lives
    // behind the puzzle menu), and its message needs a hover to read. So each state also gets a
    // surface that survives that: a click target here, and — where the page allows drawing at
    // all — the in-page banner below.
    if (state === 'blocked') armBlockedPopup(tabId, url);
  } catch (e) { /* tab gone */ }
}

/* A popup armed for ONE TAB. Clicking the icon there opens a small bundled page instead of
 * firing action.onClicked, so the dead click gets an answer — while every other tab keeps the
 * direct one-click-to-read path (a manifest `default_popup` would end that everywhere, which is
 * why the global popup was rejected: docs/background-worker.md). Chrome drops the per-tab popup
 * on navigation exactly as it drops the badge, so nothing here needs cleaning up (verified;
 * tests/extension-load.spec.js pins it — if it ever stopped, a restricted tab would keep a popup
 * after navigating to a real article and the icon would never open the reader again). */
function armBlockedPopup(tabId, url) {
  // SOFT block: the URL is a page we should have been able to open, so this is our fault, not
  // Chrome's — the popup offers a Report link and carries the page URL for it. HARD block (a
  // restricted scheme, or no URL at all, which is how a restricted tab looks to a worker holding
  // no host access): the explanation only, since inviting reports about a browser rule we cannot
  // change buys nothing and costs a reply each. The url rides in the popup's own query string
  // rather than worker memory so it survives the worker being evicted; it is a first-party
  // extension page and _buildReportMeta strips the query and fragment before anything is sent.
  const soft = !isHardBlock(url);
  // Stripped to origin+pathname HERE, not just at report time: the query and fragment are thrown
  // away by _buildReportMeta anyway, so carrying them through the popup URL is surface for nothing.
  let clean = '';
  try { const u = new URL(url); clean = u.origin + u.pathname; } catch (e) { clean = ''; }
  const popup = 'src/blocked.html' + (soft && clean ? '?soft=1&u=' + encodeURIComponent(clean) : '');
  try {
    chrome.action.setPopup({ tabId, popup }, () => void chrome.runtime.lastError);
  } catch (e) { /* tab gone */ }
  // First time ever, open the explanation instead of waiting to be found: the badge may be
  // hidden and the popup needs a click nobody knows to make. Once per profile, never again.
  try {
    chrome.storage.local.get('obr_blocked_seen', (d) => {
      void chrome.runtime.lastError;
      if (d && d.obr_blocked_seen) return;
      chrome.storage.local.set({ obr_blocked_seen: 1 }, () => void chrome.runtime.lastError);
      try { chrome.tabs.create({ url: chrome.runtime.getURL('src/blocked.html') + '?first=1' }); } catch (e) { /* */ }
    });
  } catch (e) { /* storage unavailable — the popup still explains it */ }
}

/* The orphaned-engine case, where the badge is the weakest possible answer: the page is a normal
 * one we CAN draw on (the probe just ran there), and the fix is a single click. So inject the
 * banner and offer the reload. notice.js is injected on its own — the engine files would hit
 * their own double-injection guards, and everything in that world's chrome.* is dead anyway. */
async function showReloadNotice(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: NOTICE_FILES });
    await chrome.scripting.executeScript({
      target: { tabId },
      // Strings are resolved HERE: chrome.i18n is part of the same invalidated context on that
      // page, so the injected function must not look anything up.
      func: (text, reload, dismiss) => {
        const O = globalThis.OBR;
        if (O && O._notice) O._notice({ text, actions: [{ label: reload, act: 'reload' }, { label: dismiss, act: 'dismiss' }] });
      },
      args: [
        i18nOr('noticeReload', 'Open Book Reader was updated. Reload this page to use it here.'),
        i18nOr('noticeReloadBtn', 'Reload page'),
        i18nOr('noticeDismiss', 'Dismiss'),
      ],
    });
  } catch (e) {
    console.warn('[OpenBookReader] could not show the reload notice:', (e && e.message) || e);
  }
}

// mode: 'text' (reader), 'images' (masonry gallery), or 'auto' (toolbar icon —
// pick the mode by how many images the page has; see the func below).
// opts.auto: the auto-open sentinel triggered this (no gesture): dispatch calls
// OBR.open/openGallery DIRECTLY with { trigger: 'auto' } — never the toggles, which
// could CLOSE a just-opened overlay on a rare double fire — and the engines show the
// "Auto-opened" chip.
async function invokeReader(tabId, url, mode, opts) {
  if (!tabId) { swLog('invokeReader: NO TAB ID — nothing to inject into'); return; }
  const failure = await runInvoke(tabId, url, mode, opts);
  if (!failure) return;
  // Show the state only for a real user GESTURE — an auto-open has nobody waiting on a click,
  // so an unprompted error badge there is wrong (the console.warn still fires either way).
  // And only HERE, after runInvoke's `finally` has cleared the working badge: setting it any
  // earlier would hand the cleanup the very state it is meant to leave behind.
  if (opts && opts.auto) return;
  showFailure(tabId, failure, url);
  if (failure === 'reload') showReloadNotice(tabId); // …and say it IN the page, where it is unmissable
}

// The actual work. Returns the user-visible failure state ('blocked' | 'reload'), or null when
// the trigger landed — invokeReader above owns painting it, so each state has ONE call site.
async function runInvoke(tabId, url, mode, opts) {
  // Don't try to inject into restricted pages.
  if (url && RESTRICTED_SCHEME.test(url)) {
    swLog('invokeReader: restricted page, skipping —', url);
    return 'blocked';
  }
  swLog('invokeReader: mode=' + mode, 'tab=' + tabId, 'url=' + (url ? 'visible' : 'HIDDEN (restricted or no activeTab yet)'));

  // Local debug-timing flag (see settings.js). Read off the in-memory OBR._debug — hydrated at
  // importScripts and kept fresh by the storage.onChanged listener below — so the normal path
  // adds NO per-invoke storage read (which would slow the very thing we're measuring).
  const dbg = !!OBR._debug;
  const t = dbg && OBR._timer ? OBR._timer('[OBR sw]') : null;
  let failure = null; // 'reload' / 'blocked' — returned to the caller, which paints it

  // Only for a real user gesture: an auto-open has no one waiting on a click, so a badge
  // there would appear unprompted (and could stick if the worker is evicted mid-timer).
  if (!(opts && opts.auto)) showWorking(tabId); // cleared in the finally below, whatever happens
  try {
    // Probe the tab. Returns the full page-side STATE, not just "is the engine loaded": a
    // trigger that silently does nothing on a page the reader already worked on is a state
    // problem, not an injection one, and the bare boolean could never show which.
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const O = globalThis.OBR;
        let ctxAlive = false;
        // An extension reload/update ORPHANS already-injected content scripts: they keep
        // running, so _engineLoaded stays true, but their extension context is dead and every
        // chrome.* call throws "Extension context invalidated". chrome.runtime.id going
        // undefined is the canonical tell.
        try { ctxAlive = !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { ctxAlive = false; }
        return {
          engine: !!(O && O._engineLoaded),
          gallery: !!(O && O._galleryLoaded),
          ctxAlive: ctxAlive,
          reader: O && O._diagReader ? O._diagReader() : null,
          gal: O && O._diagGallery ? O._diagGallery() : null,
        };
      },
    });
    const st = result || {};
    if (t) t.mark(st.engine ? 'probe(warm)' : 'probe');
    if (swWant()) swLog('page state:', JSON.stringify(st));
    // The one failure the user cannot diagnose unaided, and cannot fix by re-triggering: the
    // engine is present so we skip injection, but it is a corpse from a previous extension
    // instance. Re-injecting can't revive it either — reader.js/gallery.js bail on their own
    // _engineLoaded/_galleryLoaded guards. Only a PAGE RELOAD gives a fresh isolated world.
    if (st.engine && !st.ctxAlive) {
      // UNCONDITIONAL (console.warn, never console.error — the Errors-badge rule): this is the
      // one failure the user cannot diagnose unaided, and gating it behind debug mode would be
      // circular, since turning debug on needs a working extension. Warn is also correct because
      // it IS a real fault, unlike the benign restricted-page no-op.
      console.warn('[OpenBookReader] ORPHANED ENGINE: content scripts survive from a previous '
        + 'extension instance (chrome.runtime.id is undefined). Injection is skipped and every '
        + 'dispatch is a no-op. RELOAD THE PAGE — re-injection cannot fix this '
        + '(the double-injection guards block it).');
      failure = 'reload'; // …and say the same thing on the toolbar, where the user will see it
    }
    if (!st.engine) {
      await chrome.scripting.executeScript({ target: { tabId }, files: FILES });
      if (t) t.mark('inject');
    }

    // Toggle the requested mode. Reports what it actually DID (and any throw) so a dispatch
    // that quietly does nothing is visible in the trace instead of looking like a dead trigger.
    const [{ result: acted } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m, auto, debug, incognito) => {
        const OBR = globalThis.OBR;
        if (!OBR) return { did: 'NO OBR IN PAGE — injection did not take' };
        OBR._debug = !!debug; // carry the flag BOTH ways, so turning debug off propagates too
        // A content script cannot tell an incognito tab from a normal one; only the SW can
        // (tab.incognito). Set BEFORE any open() so the very first position/usage write is
        // already suppressed. See the incognito note in settings.js.
        OBR._incognito = !!incognito;
        const snap = () => (OBR._diagReader ? OBR._diagReader() : null);
        const before = snap();
        let did = 'dispatched';
        try {
          if (auto) {
            // Sentinel-triggered: open directly (mode was resolved page-side).
            if (m === 'images') { if (OBR.openGallery) OBR.openGallery({ trigger: 'auto' }); else did = 'NO openGallery'; }
            else if (OBR.open) OBR.open({ trigger: 'auto' }); else did = 'NO open';
          } else if (m === 'images') {
            if (OBR.toggleGallery) OBR.toggleGallery(); else did = 'NO toggleGallery';
          } else if (m === 'text') {
            if (OBR.toggle) OBR.toggle(); else did = 'NO toggle';
          } else if (OBR._autoToggle) {
            OBR._autoToggle(); // 'auto' (toolbar icon): the engine picks the mode by image count
          } else if (OBR.toggle) {
            OBR.toggle();
          } else { did = 'NO entry point available'; }
        } catch (e) {
          // A dead (orphaned) engine throws here — "Extension context invalidated" — which is
          // exactly the silent no-op the user sees. Report it instead of swallowing it.
          did = 'THREW: ' + ((e && e.message) || e);
        }
        return { did: did, before: before, after: snap() };
      },
      args: [mode, !!(opts && opts.auto), dbg, !!(opts && opts.incognito)]
    });
    if (t) t.mark('dispatch');
    if (swWant()) swLog('dispatch:', JSON.stringify(acted));
    // Before this func caught its own exceptions, a throw (canonically "Extension context
    // invalidated" from an orphaned engine) rejected executeScript and printed via the outer
    // catch. Capturing it must not make it QUIETER, so surface any non-success unconditionally.
    if (acted && acted.did && acted.did !== 'dispatched') {
      console.warn('[OpenBookReader] trigger did not take effect:', acted.did);
    }
    if (t) t.flush('mode=' + mode);
  } catch (err) {
    // Injecting is EXPECTED to fail on a restricted page — chrome://, the Web Store, a
    // PDF viewer, another extension, the New Tab page. The toolbar icon and shortcut stay
    // clickable there but there's nothing we can open. The url guard above catches these
    // when the URL is visible, but it ISN'T always: a restricted tab reports an empty/
    // undefined `tab.url` to a worker that holds no host access, so the `url &&` guard
    // short-circuits to false and we reach the doomed executeScript anyway ("Cannot access
    // a chrome:// URL"). Log via console.WARN, never console.error — chrome://extensions
    // collects the worker's console.error into the card's red Errors list, and a red badge
    // for a benign no-op is misleading (same rule createMenus / syncSentinelRegistration
    // already follow). This is the backstop; the guard is the fast path.
    console.warn('[OpenBookReader] cannot open on this page:', (err && err.message) || err);
    swLog('invokeReader FAILED:', (err && err.message) || err);
    // Same user-facing state as the URL guard above — this IS that guard's miss (and any other
    // page we simply cannot inject into). The guard is the fast path; this is the backstop.
    failure = 'blocked';
  } finally {
    clearWorking(tabId); // never leave a stuck badge, on success or failure
  }
  return failure;
}

chrome.action.onClicked.addListener((tab) => {
  swLog('trigger: toolbar icon', tab && tab.incognito ? '(incognito)' : '');
  invokeReader(tab.id, tab.url, 'auto', { incognito: tab && tab.incognito });
});

chrome.commands.onCommand.addListener(async (command) => {
  swLog('trigger: keyboard command', command);
  const mode = command === 'toggle-gallery' ? 'images'
    : command === 'toggle-reader' ? 'text'
    : null;
  if (!mode) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { swLog('command: tabs.query returned NO active tab — trigger dropped'); return; }
  invokeReader(tab.id, tab.url, mode, { incognito: tab.incognito });
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

// "Auto-open on pages like this…": stash a best-guess URL PATTERN (not the whole host) plus the
// auto flag, then open Options — which pre-fills the add-rule form with the pattern (editable),
// checks Auto-open, expands the Per-site data section, and scrolls to it, so the user reviews
// and adjusts the scope before saving. Same one-shot chrome.storage.local relay as the ⚙ scope.
function openOptionsPrefill(pattern) {
  const openPage = () => { try { chrome.runtime.openOptionsPage(); } catch (e) { /* */ } };
  const p = pattern && String(pattern).trim();
  try {
    if (p && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ obr_options_prefill: { pattern: p, auto: true } }, openPage);
    } else {
      openPage();
    }
  } catch (e) { openPage(); }
}

/* Open the bundled report page with diagnostics in the URL #fragment (an extension page of our
 * own, so the fragment never leaves the device; nothing is sent until the user submits from it).
 * Takes EITHER a meta object a content script already built (the ⚠ Report relay) or a ctx to
 * build one from here — the context-menu entry has no content script to ask, and importScripts
 * has already given this worker the same shared builder. `pageUrl` must be passed in that case:
 * inside the worker `location` is the worker's own chrome-extension:// URL. */
function openReportPage(metaOrCtx) {
  const m = metaOrCtx || {};
  // A ctx carries `source`; a built meta carries `reportSource`. Only the former needs building.
  const meta = m.reportSource ? m : OBR._buildReportMeta(m);
  try {
    const frag = encodeURIComponent(JSON.stringify(meta));
    chrome.tabs.create({ url: chrome.runtime.getURL('src/report.html') + '#' + frag });
  } catch (e) { console.warn('[OpenBookReader] could not open the report page:', (e && e.message) || e); }
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
    const autoPatterns = OBR.autoRuleOrigins(rules);
    // The site's CURRENT whole-site default view, shown as a disabled info line (Chrome can't
    // radio-check a per-site item declaratively — no negation, no onShown — so we ADD the one
    // matching mode's line via documentUrlPatterns, exactly like Stop/Clear). Whole-site rules
    // only; path rules resolve to the host origin and would mislabel every page (they live in
    // Options, which shows them with a plain-English gloss).
    const modePatterns = (m) => uniq(rules
      .filter((r) => r && r.match && r.mode === m && r.match.indexOf('/') === -1)
      .flatMap((r) => OBR.originsForRule(r.match)));
    const currText = modePatterns('text');
    const currImages = modePatterns('images');
    const currAuto = modePatterns('auto');

    await removeAll();
    await add({ id: 'obr-open', title: OBR.t('ctxOpenTitle'), contexts: ctx });
    // Band 1 — "Open now:" — a one-shot open for THIS visit (the prefix flags the immediate action).
    await add({ id: 'obr-open-auto', parentId: 'obr-open', title: OBR.t('ctxAuto'), contexts: ctx });
    await add({ id: 'obr-open-text', parentId: 'obr-open', title: OBR.t('ctxReader'), contexts: ctx });
    await add({ id: 'obr-open-images', parentId: 'obr-open', title: OBR.t('ctxGallery'), contexts: ctx });
    // Band 2 — the site's DEFAULT VIEW (a persistent whole-site rule; path rules are
    // typed in Options). This is the "which view" axis.
    // Band 2 — Configure Default: the site's persistent default VIEW, in a submenu. Unlike the
    // old flat "Always open as…", choosing here does NOT open anything now (that's Band 1's job)
    // — it just writes the whole-site rule. The disabled "Current selection: …" line names the
    // active default, scoped per mode like Stop/Clear (Chrome can't radio-check declaratively —
    // no onShown, no negation — so it's simply omitted on a rule-less site).
    await add({ id: 'obr-sep', parentId: 'obr-open', type: 'separator', contexts: ctx });
    await add({ id: 'obr-configure-default', parentId: 'obr-open', title: OBR.t('ctxConfigureDefault'), contexts: ctx });
    if (currText.length) await add({ id: 'obr-def-current-text', parentId: 'obr-configure-default', title: OBR.t('ctxCurrentReader'), contexts: ctx, enabled: false, documentUrlPatterns: currText });
    if (currImages.length) await add({ id: 'obr-def-current-images', parentId: 'obr-configure-default', title: OBR.t('ctxCurrentGallery'), contexts: ctx, enabled: false, documentUrlPatterns: currImages });
    if (currAuto.length) await add({ id: 'obr-def-current-auto', parentId: 'obr-configure-default', title: OBR.t('ctxCurrentAuto'), contexts: ctx, enabled: false, documentUrlPatterns: currAuto });
    const anyCurr = uniq([...currText, ...currImages, ...currAuto]); // scope the divider too, so a rule-less site shows neither
    if (anyCurr.length) await add({ id: 'obr-def-sep', parentId: 'obr-configure-default', type: 'separator', contexts: ctx, documentUrlPatterns: anyCurr });
    await add({ id: 'obr-def-auto', parentId: 'obr-configure-default', title: OBR.t('optModeAuto'), contexts: ctx });   // Smart pick
    await add({ id: 'obr-def-text', parentId: 'obr-configure-default', title: OBR.t('optModeReader'), contexts: ctx });  // Reader
    await add({ id: 'obr-def-images', parentId: 'obr-configure-default', title: OBR.t('optModeGallery'), contexts: ctx }); // Gallery
    // Band 3 — AUTO-OPEN, a separate axis (whether the view opens with no click). Kept
    // apart from Band 2 by its own divider — the user asked not to conflate the two.
    await add({ id: 'obr-sep2', parentId: 'obr-open', type: 'separator', contexts: ctx });
    await add({ id: 'obr-rule-auto', parentId: 'obr-open', title: OBR.t('ctxAutoOpen'), contexts: ctx });
    // A path/URL-scoped variant: opens Options with a best-guess pattern pre-filled + editable
    // (the menu can't show the pattern in its label — it's built before the right-click, with no
    // way to read the URL — so it hands off to Options, where the user reviews it before saving).
    await add({ id: 'obr-rule-auto-url', parentId: 'obr-open', title: OBR.t('ctxAutoOpenUrl'), contexts: ctx });
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
    // "This page doesn't work" — the ONLY report path that survives the failures worth
    // reporting. Every in-overlay ⚠ Report button needs a reader that opened and is visible,
    // which is precisely what a broken site denies; this one needs no content script at all,
    // so it still works when the overlay is covered, deleted, or never drawn.
    await add({ id: 'obr-report-page', parentId: 'obr-open', title: OBR.t('ctxReportPage'), contexts: ctx });
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
    // The union of origin patterns over all auto rules (the shared definition — the options
    // page's revoke guard reads the SAME function, so a grant is never released while this
    // registration still expects it)...
    const patterns = OBR.autoRuleOrigins(raw.siteRules);
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
  // Keep the SW's in-memory debug flag in step with a toggle made from any other context
  // (a content-script or page console calling OBR.debugTiming). Local area, no rule work.
  if (area === 'local' && changes.obr_debug) { OBR._debug = !!changes.obr_debug.newValue; return; }
  if (area !== 'sync' || !changes.obr_settings) return;
  const rulesOf = (v) => JSON.stringify((v && (v.siteRules || v.sites)) || []);
  if (rulesOf(changes.obr_settings.oldValue) !== rulesOf(changes.obr_settings.newValue)) {
    syncSentinelRegistration();
    createMenus(); // the state-aware menu (Stop / Clear visibility) follows the rules
  }
});
chrome.permissions.onAdded.addListener(() => { syncSentinelRegistration(); });
chrome.permissions.onRemoved.addListener(() => { syncSentinelRegistration(); });

// "Stop auto-opening on this site": clear the auto flag on whichever rule matches the page
// (path rules included), keeping its mode. Uses the page URL so a path-scoped auto rule is
// turned off precisely; the storage write re-syncs registration + rebuilds the menu.
function stopAutoOpen(src, done) {
  const finish = (ok) => { if (done) { try { done(ok); } catch (e) { /* receiver gone */ } } };
  chrome.storage.sync.get('obr_settings', (data) => {
    void chrome.runtime.lastError;
    const raw = (data && data.obr_settings) || {};
    OBR.migrateSiteRules(raw);
    const rule = OBR.matchSiteRuleEx(src, raw.siteRules);
    if (!(rule && rule.auto)) return finish(false);
    const next = OBR.setRuleAuto(raw.siteRules, rule.match, false);
    // Give the site permission back on exactly the same terms as the options checkbox, so
    // WHERE you turn auto-open off doesn't change what happens to the grant. `remove` needs
    // no user gesture (only `request` does), so the worker can do this itself. No verify step
    // here: unlike the options page there's nothing to report to. Note it DOES change
    // bookkeeping even when it cannot change access — under a covering broad grant the per-site
    // entries disappear from permissions.getAll() while access itself remains (observed).
    const release = OBR.releasableOrigins(rule, next);
    raw.siteRules = next;
    chrome.storage.sync.set({ obr_settings: raw }, () => {
      void chrome.runtime.lastError;
      if (release.length) {
        try { chrome.permissions.remove({ origins: release }, () => { void chrome.runtime.lastError; }); }
        catch (e) { /* permissions unavailable — the flag is cleared either way */ }
      }
      finish(true);
    });
  });
}

// Configure Default → set the site's default VIEW and STOP — it does NOT open now (Band 1's
// "Open now:" is the trigger). Reader/Gallery preserve any auto flag (no opts). "Smart pick"
// routes through _configureDefaultAction: clear the rule when auto-open is off (don't leave a
// no-op {mode:'auto'}), keep it at mode 'auto' when auto-open is on.
function configureDefault(host, mode) {
  if (!host) return;
  if (mode !== 'auto') return setSiteRule(host, mode);
  chrome.storage.sync.get('obr_settings', (data) => {
    void chrome.runtime.lastError;
    const raw = (data && data.obr_settings) || {};
    OBR.migrateSiteRules(raw);
    const prev = (raw.siteRules || []).find((r) => r && r.match === host);
    const act = OBR._configureDefaultAction(prev, 'auto');
    setSiteRule(host, act.clear ? null : act.mode);
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  swLog('trigger: context menu', info.menuItemId);
  if (!tab) { swLog('menu: no tab in the click event — dropped'); return; }
  const act = OBR._menuAction(info.menuItemId); // pure id → descriptor; null = ignore (separators/parent)
  if (!act) { swLog('menu: id maps to no action (separator/parent) — ignored'); return; }
  const src = info.pageUrl || tab.url || '';
  // The gesture-only actions don't need a rule host.
  if (act.do === 'open') return void invokeReader(tab.id, tab.url, act.mode, { incognito: tab.incognito });
  if (act.do === 'stop-auto') return stopAutoOpen(src);
  if (act.do === 'report') return openReportPage({ source: 'context-menu', mode: 'none', pageUrl: src });
  if (act.do === 'auto-url') return void openOptionsPrefill(OBR._pathPatternForUrl(src));
  // Host-scoped actions. Gate on a parseable URL before normalizing: OBR.normalizeHost is lenient
  // (treats a non-URL as a bare host), so a garbage source would otherwise write a bogus rule.
  // (options is intentionally OUTSIDE this guard — it opens unscoped on a junk URL.)
  if (act.do === 'options') {
    let host = '';
    try { new URL(src); host = OBR.normalizeHost(src); } catch (e) { /* open unscoped */ }
    return openOptionsForSite(host);
  }
  let host = '';
  try { new URL(src); host = OBR.normalizeHost(src); } catch (e) { return; /* not a real URL — no-op */ }
  if (act.do === 'clear') return setSiteRule(host, null);
  if (act.do === 'enable-auto') return void (host && enableAutoOpen(host, tab));
  if (act.do === 'configure') return configureDefault(host, act.mode);
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
function permsFor(msg) {
  const type = msg && msg.type;
  if (type === 'obr-download-one') return { permissions: ['downloads'] };
  if (type === 'obr-fetch-bytes') {
    // LEAST PRIVILEGE: ask for the origins these images actually live on, not <all_urls>.
    // The exact URLs are right here in the message; the old code keyed off `type` alone and
    // threw them away, so downloading one album escalated to read access on every site the
    // user would ever visit — and that single broad grant then subsumes every per-site
    // auto-open grant, which is what made the options Site access card collapse to one
    // all-covering row. The popup still offers "all sites" as a deliberate opt-out for people
    // who download a lot (permission.js), so the escape hatch is a choice, not the default.
    // data:/blob: images need no host permission, so they contribute nothing here; a message
    // with only those yields null and skips the prompt entirely.
    const origins = [];
    (msg.urls || []).forEach((u) => {
      try {
        const url = new URL(u);
        if (!/^https?:$/.test(url.protocol)) return;
        // `*://host/*`, matching originsForRule's shape — host granularity, both schemes.
        // NOT scheme-pinned: nearly every host redirects http->https, and the SW fetch follows
        // redirects, so an `http://host/*` grant would fail the moment an http image URL
        // (still common in lazy-load `data-src` markup) 301s to https. NOT url.origin either:
        // that keeps the port, and a port belongs to neither originsForRule's shape nor the
        // documented match-pattern host grammar — port-less matches any port, which is what we
        // want anyway. A `*` inside the hostname can't form a valid pattern, and ONE invalid
        // entry fails the whole permissions.request, so drop it rather than sink the batch.
        if (url.hostname.includes('*')) return;
        const o = '*://' + url.hostname + '/*';
        if (origins.indexOf(o) === -1) origins.push(o);
      } catch (e) { /* not an absolute http(s) URL — nothing to request */ }
    });
    return origins.length ? { origins } : null;
  }
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
  // A ZIP prompt carries an origins list + the "Allow all sites" escape link, so it needs more
  // room than a plain permission ask. Start close to the right size (permission.js fine-tunes to
  // the exact content height after load) so there's no visible jump — and so the escape link is
  // visible even if that resize ever no-ops.
  const isZip = need.origins && need.reason !== 'auto-open';
  chrome.windows.create(
    {
      url: chrome.runtime.getURL('src/permission.html') + '?' + params.toString(),
      type: 'popup',
      width: 460,
      height: isZip ? 460 : 340,
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
  // The in-overlay chip's "Stop auto-opening on this site". A content script can't call
  // permissions.remove, so it relays here instead of clearing the flag itself — otherwise the
  // chip and the context menu would share a verb while only one of them released the grant.
  // The sender's own URL decides which rule (never a URL from the message body).
  if (msg.type === 'obr-stop-auto') {
    const url = (_sender && _sender.url) || (_sender && _sender.tab && _sender.tab.url) || '';
    if (!url) { sendResponse({ ok: false }); return true; }
    stopAutoOpen(url, (ok) => sendResponse({ ok: !!ok }));
    return true; // async response
  }

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
      invokeReader(tab.id, url, mode, { auto: true, incognito: tab.incognito });
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
    openReportPage(msg.meta || {});
    sendResponse({ ok: true });
    return true;
  }

  if ((msg.type === 'obr-download-one' && msg.url) ||
      (msg.type === 'obr-fetch-bytes' && Array.isArray(msg.urls))) {
    const need = permsFor(msg);
    // Nothing host-scoped to ask for (e.g. every image is a data:/blob: URL) — no prompt.
    if (!need) { runDownload(msg, sendResponse); return true; }
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

/* Worker READY. Every listener above is now registered — this is the moment a queued trigger can
 * finally be handled, so this reading is the true cold-start cost the user waits out. Kept at the
 * very bottom on purpose: anything added below this line lands OUTSIDE the measurement. Reported
 * on every swLog() line as `boot=`, with `COLD-START` flagged when a trigger arrived within
 * 250ms of it. Assigned to a `var` so swLog() (defined earlier) can read it without a TDZ error
 * if it ever runs mid-evaluation. */
var SW_BOOT_MS = Math.round(performance.now());
