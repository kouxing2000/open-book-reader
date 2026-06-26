/* Open Book Reader — shared defaults
 * Loaded by the content script (injected) and by the options page (via <script>).
 * Attaches to globalThis.OBR so all injected files share one namespace.
 */
(function () {
  const OBR = (globalThis.OBR = globalThis.OBR || {});

  OBR.STORAGE_KEY = 'obr_settings';

  OBR.DEFAULTS = {
    fontSize: 19,          // px
    theme: 'paper',        // 'paper' | 'light' | 'dark'
    maxBookWidth: 0,       // 0 = fill the window (default). >0 caps the book width (px) for readability.
    gutter: 80,            // px, center spine width
    lineHeight: 1.62,
    fontFamily: 'serif',   // 'serif' | 'sans'
    columns: 2,            // columns (pages) per spread: 2, 3, or 4
    singlePageBelow: 720,  // px viewport width → fall back to one page
    transitionMs: 340,     // page-flip animation duration
    galleryColWidth: 240,  // image-gallery mode: masonry column width (px)
    galleryMinSize: 80,    // image-gallery mode: ignore images smaller than this (px)
    galleryAutoLoad: true, // image-gallery mode: progressively hydrate the page's lazy
                           // images as you near the end of the grid (prefetch). Off =
                           // only load what's already there + the manual "Load all".
    autoGalleryMin: 10,    // toolbar-icon auto-mode: open the gallery instead of the
                           // reader when the page has >= this many images (0 = off).
                           // Only the toolbar icon auto-picks; Alt+B / Alt+Shift+B stay explicit.
    autoTextMinWords: 200, // ...but a real article still wins: if the page has >= this
                           // many words in substantial prose blocks (see reader.js
                           // _articleWordCount — live-DOM, not Readability), open the
                           // reader even when image-heavy (so a figure-rich long read
                           // isn't dumped into the gallery). 0 = decide by image count alone.
    siteRules: []          // per-site rules: [{ match: '<glob>', mode: 'text'|'images'|'auto' }]
                           // `match` is a glob (`*` wildcard) tested against `host + pathname`,
                           // e.g. 'example.com' (whole site), 'example.com/blog/*' (a path),
                           // '*.example.com/*' (all subdomains). It overrides the toolbar-icon
                           // auto-pick (the reader/gallery still only open on a gesture). When
                           // several rules match, the MOST SPECIFIC wins (longest literal). See
                           // OBR.matchSiteRule. ONE shared chrome.storage.sync item (8KB quota)
                           // holds everything. Always read-modify-WRITE a fresh siteRules array
                           // (saveSettings shallow-merges, so a new array replaces it wholesale).
  };

  // Widest URL in an HTML srcset string (by `w`/`x` descriptor), or null if empty.
  // Tokenizes on whitespace (NOT bare commas) so URLs that legitimately contain commas —
  // data: URIs, CDN transform params like Cloudinary's `.../w_400,c_fill/...` — aren't
  // shattered. Same whitespace-anchored approach the vendored Readability uses
  // (REGEXPS.srcsetUrl). Shared by reader.js (lazy-image rescue) and gallery.js (collection
  // + full-res variant) so both parse srcset identically.
  OBR.bestFromSrcset = function (srcset) {
    if (!srcset) return null;
    const re = /(\S+)(\s+[\d.]+[wx])?(\s*(?:,|$))/g;
    let m, best = null, bestScore = -1;
    while ((m = re.exec(srcset)) !== null) {
      let score = 1;
      const d = m[2] && m[2].trim();
      if (d) {
        if (d.endsWith('w')) score = parseFloat(d) || 1;
        else if (d.endsWith('x')) score = (parseFloat(d) || 1) * 1000;
      }
      if (score > bestScore) { bestScore = score; best = m[1]; }
    }
    return best;
  };

  // Where "Report a problem" emails go. This is the ONLY developer-facing channel and
  // it is USER-INITIATED — see OBR.reportBroken. The matching Gmail filter / label live
  // in .meta/feedback.json so the `feedback` ingest pipeline can route these reports.
  OBR.FEEDBACK_EMAIL = 'studio.peach.go+open-book-reader@gmail.com';

  // The extension version, or 'unknown' outside an extension context (test harness / proxy,
  // where chrome.runtime.getManifest is absent).
  OBR.version = function () {
    try {
      if (globalThis.chrome && chrome.runtime && chrome.runtime.getManifest)
        return chrome.runtime.getManifest().version || 'unknown';
    } catch (e) { /* not in an extension context */ }
    return 'unknown';
  };

  // Build the prefilled "report a problem" mailto: URL. PURE — no side effects — so it
  // can be unit-tested without launching a mail client. The body carries a
  // `[feedback-meta v1]` marker (app-agnostic feedback-ingest contract): an unchanged
  // placeholder line above a `---` divider, then a human-readable metadata block, then the
  // marker + a one-line JSON the ingest parser consumes. ctx: { source, mode, imageCount?,
  // proseWords? }. The page URL is stripped of its query/hash before being included — the
  // path is enough to reproduce an extraction bug, and query strings can carry session
  // tokens we don't want to leak even into a user-reviewed draft.
  OBR._buildReportMailto = function (ctx) {
    ctx = ctx || {};
    let pageUrl = '', host = '';
    try {
      const u = new URL(globalThis.location ? location.href : 'about:blank');
      pageUrl = u.origin + u.pathname;
      host = u.hostname;
    } catch (e) { pageUrl = String((globalThis.location && location.href) || '').split(/[?#]/)[0]; }

    const meta = {
      app: 'open-book-reader',
      version: OBR.version(),
      build: OBR.version(),
      platform: 'chrome',
      locale: (globalThis.navigator && navigator.language) || 'unknown',
      reportSource: ctx.source || 'unknown',
      mode: ctx.mode || 'unknown',
      pageUrl: pageUrl,
    };
    if (typeof ctx.imageCount === 'number') meta.imageCount = ctx.imageCount;
    if (typeof ctx.proseWords === 'number') meta.proseWords = ctx.proseWords;

    // EXACT literal the ingest parser drops when left unchanged — do not reword.
    const PLACEHOLDER = '[Please describe the issue or feedback here]';
    const lines = [
      PLACEHOLDER, '', '---',
      'App: ' + meta.app,
      'Version: ' + meta.version,
      'Platform: ' + meta.platform,
      'Page: ' + (pageUrl || '(unknown)'),
      'Mode: ' + meta.mode,
    ];
    if ('imageCount' in meta) lines.push('Images detected: ' + meta.imageCount);
    if ('proseWords' in meta) lines.push('Prose words: ' + meta.proseWords);
    lines.push('', '[feedback-meta v1]', JSON.stringify(meta));

    const subject = 'Open Book Reader — problem' + (host ? ' on ' + host : '');
    return 'mailto:' + OBR.FEEDBACK_EMAIL +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(lines.join('\n'));
  };

  // Hand a prefilled bug-report email to the user's mail client. USER-INITIATED: the
  // extension transmits nothing itself — the user reviews the draft and sends it from
  // their own client — so this preserves the "sends nothing to the developer" posture.
  // Triggered by the ⚠ Report button in the reader and gallery toolbars.
  OBR.reportBroken = function (ctx) {
    const url = OBR._buildReportMailto(ctx);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.style.display = 'none';
      // Attach to the top document (not a Shadow root) so the mailto handoff fires.
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      try { globalThis.open && globalThis.open(url); } catch (_) { /* no mail handler */ }
    }
    return url;
  };

  // Ask the background service worker to open the options page. Content scripts can't
  // call chrome.runtime.openOptionsPage themselves (it's SW/extension-page only), so the
  // ⚙ button in the reader/gallery relays through a message. No-op in the test harness.
  OBR.openOptions = function () {
    try {
      if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'obr-open-options' }, () => { void chrome.runtime.lastError; });
      }
    } catch (e) { /* messaging unavailable */ }
  };

  // Normalize a host (or URL) to a stable key: lowercase, strip leading "www.".
  OBR.normalizeHost = function (h) {
    try { h = new URL(String(h).includes('://') ? h : 'http://' + h).hostname; } catch (e) { /* bare host */ }
    return String(h).toLowerCase().replace(/^www\./, '');
  };

  // Normalize a site-rule pattern: lowercase + www-strip the HOST part, keep the path as
  // typed (matching is case-insensitive anyway, but display reads cleaner).
  OBR.normalizePattern = function (p) {
    p = String(p).trim();
    if (!p) return '';
    const slash = p.indexOf('/');
    const host = (slash === -1 ? p : p.slice(0, slash)).toLowerCase().replace(/^www\./, '');
    return host + (slash === -1 ? '' : p.slice(slash));
  };

  // Compile a glob (`*` = any run of chars) into an anchored, case-insensitive RegExp over
  // a `host + pathname` target. A pattern with no "/" is a whole-site rule, so it also
  // matches any path under that host (the trailing "(?:/.*)?"). The host is www-stripped to
  // match the www-stripped target (so a stray "www." in a hand-edited pattern still works).
  function globToRegExp(pattern) {
    try {
      const p = String(pattern).trim().toLowerCase().replace(/^www\./, '');
      const esc = p.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
      const tail = p.indexOf('/') === -1 ? '(?:/.*)?' : '';
      return new RegExp('^' + esc + tail + '$');
    } catch (e) { return null; }
  }

  // Pick the mode of the most-specific site rule matching `url`, or null if none match.
  // Specificity = literal length of the pattern (wildcards removed); longest wins.
  OBR.matchSiteRule = function (url, rules) {
    if (!Array.isArray(rules) || !rules.length) return null;
    let target;
    try {
      const u = new URL(url);
      target = (OBR.normalizeHost(u.hostname) + u.pathname).toLowerCase();
    } catch (e) { return null; }
    let best = null, bestScore = -1;
    for (const r of rules) {
      if (!r || !r.match || !r.mode) continue;
      const re = globToRegExp(r.match);
      if (re && re.test(target)) {
        const score = String(r.match).trim().replace(/\*/g, '').length;
        if (score > bestScore) { bestScore = score; best = r.mode; }
      }
    }
    return best;
  };

  // Migrate the legacy exact-host `sites` map ({host:{mode}}) into `siteRules` on read,
  // so a user's earlier per-host rules survive the model change. Read-side only; the next
  // write persists siteRules. Harmless once everyone is on siteRules.
  function withMigration(s) {
    if (s.sites && typeof s.sites === 'object') {
      // Only seed from the legacy map when siteRules hasn't been written yet. Once any
      // siteRules write has happened (saveSettings purges `sites` from storage), the map
      // is gone — so a deliberately-emptied siteRules stays empty (no resurrection).
      if (!Array.isArray(s.siteRules) || !s.siteRules.length) {
        s.siteRules = Object.keys(s.sites)
          .filter((h) => s.sites[h] && s.sites[h].mode)
          .map((h) => ({ match: h, mode: s.sites[h].mode }));
      }
      delete s.sites; // consumed — don't carry the legacy key around in memory
    }
    if (!Array.isArray(s.siteRules)) s.siteRules = [];
    return s;
  }

  // Read settings merged over defaults (chrome.storage.sync).
  OBR.loadSettings = function () {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(OBR.STORAGE_KEY, (data) => {
          const saved = (data && data[OBR.STORAGE_KEY]) || {};
          resolve(withMigration(Object.assign({}, OBR.DEFAULTS, saved)));
        });
      } catch (e) {
        resolve(withMigration(Object.assign({}, OBR.DEFAULTS)));
      }
    });
  };

  // Persist ONLY the keys the user explicitly changes. Merging into the RAW saved
  // object (not DEFAULTS-merged) means unset keys keep falling back to DEFAULTS at
  // load time — so changing a default later actually takes effect. (Merging the
  // full object used to "bake in" the defaults-of-the-day and block future changes.)
  OBR.saveSettings = function (partial) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(OBR.STORAGE_KEY, (data) => {
          const savedRaw = (data && data[OBR.STORAGE_KEY]) || {};
          const nextRaw = Object.assign({}, savedRaw, partial);
          delete nextRaw.sites; // purge the legacy host-map once anything is written (see withMigration)
          const merged = Object.assign({}, OBR.DEFAULTS, nextRaw);
          try {
            chrome.storage.sync.set({ [OBR.STORAGE_KEY]: nextRaw }, () => resolve(merged));
          } catch (e) {
            resolve(merged);
          }
        });
      } catch (e) {
        resolve(Object.assign({}, OBR.DEFAULTS, partial));
      }
    });
  };

  /* ---------------------------------------------------------- reading position
   * Per-article reading position so the reader resumes where you left off.
   * Stored in chrome.storage.LOCAL (not sync): positions are per-device, can be
   * many, and shouldn't burn the 8KB sync quota that holds the user's settings.
   * One bounded map `obr_positions` = { '<origin+pathname>': { f, t } } where `f`
   * is the progress FRACTION (not a spread index — pagination depends on font /
   * columns / viewport, which may differ next session, so we restore the fraction
   * and let the reader re-anchor it onto the new column count). LRU-pruned to
   * POSITIONS_MAX so a heavy reader never grows the map without bound. */
  OBR.POSITIONS_KEY = 'obr_positions';
  OBR.POSITIONS_MAX = 300;

  // Stable per-article key: origin + pathname only (query/hash stripped so the
  // same article under different tracking params resolves to one position).
  OBR.positionKey = function (loc) {
    const l = loc || (typeof location !== 'undefined' ? location : null);
    if (!l) return '';
    try { return l.origin + l.pathname; } catch (e) { return l.href || ''; }
  };

  function localArea() {
    try { return (globalThis.chrome && chrome.storage && chrome.storage.local) || null; }
    catch (e) { return null; }
  }

  // Resolve to the saved fraction [0,1] for `key`, or null when none/unavailable.
  OBR.loadPosition = function (key) {
    return new Promise((resolve) => {
      const area = localArea();
      if (!area || !key) return resolve(null);
      try {
        area.get(OBR.POSITIONS_KEY, (data) => {
          const map = (data && data[OBR.POSITIONS_KEY]) || {};
          const e = map[key];
          resolve(e && typeof e.f === 'number' ? e.f : null);
        });
      } catch (e) { resolve(null); }
    });
  };

  // Serialize position writes so an in-flight read-modify-write can't interleave
  // with the next one (the debounced save and the close() flush both touch the
  // same shared map). Each write waits for the previous to land, so neither drops
  // the other's entry. (Cross-PROCESS atomicity — two tabs at once — is still
  // best-effort; chrome.storage offers no lock, and same-article-in-two-tabs is rare.)
  let saveChain = Promise.resolve();

  // Persist the fraction for `key`, LRU-pruning the map to POSITIONS_MAX entries.
  OBR.savePosition = function (key, fraction, now) {
    const run = () => new Promise((resolve) => {
      const area = localArea();
      if (!area || !key || typeof fraction !== 'number') return resolve();
      const stamp = typeof now === 'number' ? now : Date.now();
      try {
        area.get(OBR.POSITIONS_KEY, (data) => {
          const map = (data && data[OBR.POSITIONS_KEY]) || {};
          map[key] = { f: Math.max(0, Math.min(1, fraction)), t: stamp };
          const keys = Object.keys(map);
          if (keys.length > OBR.POSITIONS_MAX) {
            keys.sort((a, b) => (map[a].t || 0) - (map[b].t || 0));
            for (let i = 0; i < keys.length - OBR.POSITIONS_MAX; i++) delete map[keys[i]];
          }
          try { area.set({ [OBR.POSITIONS_KEY]: map }, resolve); }
          catch (e) { resolve(); }
        });
      } catch (e) { resolve(); }
    });
    saveChain = saveChain.then(run, run); // chain through failures too
    return saveChain;
  };

  // Estimated reading minutes from a word count (220 wpm). 0 when there's no
  // measurable text, so callers can hide the badge instead of showing "~1 min".
  OBR.readingTimeMin = function (words) {
    const w = Math.max(0, Math.floor(words || 0));
    return w < 1 ? 0 : Math.max(1, Math.round(w / 220));
  };
})();
