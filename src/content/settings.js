/* Open Book Reader — shared defaults
 * Loaded by the content script (injected), the options page (via <script>), AND the
 * background service worker (via importScripts in background.js). Attaches to globalThis.OBR
 * so all three share one namespace.
 * CONSTRAINT: touch NO DOM at load time (no top-level document/window/navigator/location) —
 * the service worker has no DOM, so a top-level DOM access throws at importScripts and the
 * worker never registers (killing the toolbar/commands/context-menus/downloads). Keep every
 * such access inside a function body, as reportBroken/makeShadowHost/_buildReportMailto do.
 */
(function () {
  const OBR = (globalThis.OBR = globalThis.OBR || {});

  // i18n helper: resolve a localized UI string from _locales/<lang>/messages.json.
  // `subs` is an optional string or array of strings for $PLACEHOLDER$ slots.
  // Falls back to the key name if a message is missing (a visible signal of a
  // missing/misspelled key rather than a silent blank). chrome.i18n is available
  // in content scripts and the SW with no extra permission.
  OBR.t = function (key, subs) {
    // chrome.i18n is present in content scripts / the SW, but NOT in a plain page
    // main world (e.g. the test harness before its i18n shim loads) — guard so a
    // missing i18n degrades to the key name instead of a hard TypeError.
    var i18n = typeof chrome !== 'undefined' && chrome.i18n;
    return (i18n && i18n.getMessage(key, subs)) || key;
  };

  OBR.STORAGE_KEY = 'obr_settings';

  OBR.DEFAULTS = {
    fontSize: 19,          // px
    theme: 'paper',        // 'auto' | 'paper' | 'light' | 'dark'. 'auto' follows the OS
                           // color scheme (paper in light mode, dark in dark mode); the
                           // resolution lives in reader.js resolveTheme().
    maxBookWidth: 0,       // 0 = fill the window (default). >0 caps the book width (px) for readability.
    gutter: 80,            // px, center spine width
    lineHeight: 1.62,
    fontFamily: 'serif',   // 'serif' | 'sans'
    columns: 2,            // columns (pages) per spread: 2, 3, or 4
    singlePageBelow: 720,  // px viewport width → fall back to one page
    transitionMs: 340,     // page-flip animation duration
    pageTurn: 'curl',      // page-flip effect: 'curl' (soft paper bend - the page slices
                           // into strips that curve as it turns) | 'book' (rigid 3D page
                           // about the spine) | 'slide' (eased translateX) | 'off'
                           // (instant). prefers-reduced-motion forces instant regardless.
                           // 'curl'/'book' fall back to 'slide' for odd / single-page
                           // layouts (no center spine to hinge on).
    readSelection: true,   // text reader: if text is selected when the reader opens, read
                           // ONLY that selection instead of the whole page (a manual override
                           // for when auto-extraction picks the wrong content). The selection
                           // is read exactly as highlighted. Off = always read the whole page.
    printSourceUrl: true,  // print / Save as PDF: append a footer with the full source URL
                           // so the saved copy links back to the article. Off = omit it
                           // (e.g. when sharing a PDF and you'd rather not expose the URL).
    printBranding: true,   // print / Save as PDF: append a small "Open Book Reader" footer with
                           // a QR code to the project page, so a shared PDF can lead readers back
                           // to the extension. Off = no branding block.
    galleryColumns: 4,     // image-gallery WALL layout: masonry column COUNT (fewer = larger images;
                           // clamped per screen so "biggest" is a 2-up grid everywhere)
    galleryOrderedCols: 2, // image-gallery ORDERED layout: columns per row (1 = single-page reading
                           // strip). The first-flip landing; independent of galleryColumns (Wall).
    galleryMinSize: 80,    // image-gallery mode: ignore images smaller than this (px)
    galleryAutoLoad: true, // image-gallery mode: progressively hydrate the page's lazy
                           // images as you near the end of the grid (prefetch). Off =
                           // only load what's already there + the manual "Load all".
    galleryAutoScrollSpeed: 60, // image-gallery mode: hands-free auto-scroll speed (px/sec).
                                // Toggle via the toolbar Auto-scroll button or the "A" key;
                                // nudge live with +/-.
    gallerySlideSeconds: 3,     // image-gallery lightbox: slideshow dwell time per image (sec).
                                // Toggle via the lightbox play button or the "A" key; nudge live
                                // with +/-. Plays once and auto-pauses on the last image.
    galleryFitWidth: false, // image-gallery lightbox: fit a tall page to the WIDTH (fills across +
                            // scrolls down) instead of shrinking the whole page to fit the viewport
                            // — for reading manga/comic/scan pages one at a time. Toggle in the lightbox.
    galleryHideAvatars: true, // image-gallery: high-precision auto-filter that drops avatar/icon
                            // images (profile pics, emoji, badges) — detected by profile-link wrapper
                            // + avatar/gravatar/emoji class/alt/src token, NOT by size, so album art /
                            // product shots stay. Complements the manual per-site Hide (obr_hidden).
    autoGalleryMin: 10,    // toolbar-icon auto-mode: open the gallery instead of the
                           // reader when the page has >= this many images (0 = off).
                           // Only the toolbar icon auto-picks; Alt+B / Alt+Shift+B stay explicit.
    autoTextMinWords: 200, // ...but a real article still wins: if the page has >= this
                           // many words in substantial prose blocks (see OBR._proseStats —
                           // live-DOM, not Readability), open the
                           // reader even when image-heavy (so a figure-rich long read
                           // isn't dumped into the gallery). 0 = decide by image count alone.
    autoAnchorWords: 80,   // auto-open (sentinel) text gate: besides the total-words bar,
                           // at least ONE single prose block must carry this many words.
                           // A forum index can accumulate 200 words of long topic titles,
                           // but only a real post has one substantial paragraph. Not
                           // surfaced in the options UI (MVP) — documented here.
    siteRules: []          // per-site rules: [{ match: '<glob>', mode: 'text'|'images'|'auto', auto?: true }]
                           // `auto: true` = auto-open: on a page matching this rule, the
                           // registered sentinel (src/content/sentinel.js) may open the
                           // rule's mode WITHOUT a gesture once the content gate passes.
                           // Needs a per-origin host permission, granted when the flag is
                           // set (context menu / options); see OBR.originsForRule.
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

  // Mode-switch glyphs shared by the reader and gallery toolbars (an open book + a framed
  // picture). Defined once here — settings.js loads before both engines — so the two stay
  // visually identical instead of carrying byte-for-byte copies that can drift apart.
  OBR.ICONS = {
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2H2z"/><path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2H22z"/></svg>',
    images: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>',
  };

  // Create an overlay host element with an open Shadow root (the build prologue both engines
  // share). Open mode so Playwright can pierce it in tests. Returns { host, root }.
  OBR.makeShadowHost = function (id) {
    const host = document.createElement('div');
    host.id = id;
    document.documentElement.appendChild(host);
    return { host, root: host.attachShadow({ mode: 'open' }) };
  };

  // Apply a stylesheet to a Shadow root via Constructable Stylesheets, so strict-CSP sites
  // (style-src) can't block the overlay's CSS. Replaces the per-engine applyStylesheet().
  OBR.adoptStyles = function (root, cssText) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    root.adoptedStyleSheets = [sheet];
  };

  // Where "Report a problem" emails go. This is the ONLY developer-facing channel and
  // it is USER-INITIATED — see OBR.reportBroken. The address (and its Gmail label) live in
  // .meta/feedback.json.
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

  // The diagnostic block shared by the mailto and the report page. PURE — no side effects — so
  // it can be unit-tested. The `[feedback-meta v1]` marker is a machine-readable tail the
  // developer's feedback tooling reads: an unchanged placeholder line, a `---` divider, a
  // human-readable metadata block, then the marker + a one-line JSON that IS this object.
  // ctx: { source, mode, imageCount?, proseWords? }. The page URL is stripped to origin+pathname
  // (no query/hash) so session tokens can't leak even into a user-reviewed draft.
  OBR._buildReportMeta = function (ctx) {
    ctx = ctx || {};
    let pageUrl = '';
    try {
      const u = new URL(globalThis.location ? location.href : 'about:blank');
      pageUrl = u.origin + u.pathname;
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
    return meta;
  };

  OBR._buildReportMailto = function (ctx) {
    const meta = OBR._buildReportMeta(ctx);
    const pageUrl = meta.pageUrl;
    let host = '';
    try { host = new URL(pageUrl).hostname; } catch (e) { /* */ }

    // EXACT literal the developer's feedback tooling drops when left unchanged — do not reword.
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

  // Open the bundled report page so the user can choose EMAIL or a WEB FORM. The page is a
  // first-party extension page (offline-capable; diagnostics never touch a third-party page),
  // opened via the SW relay because content scripts can't call chrome.tabs.create. The form
  // path exists because a `mailto:` silently fails for users with no configured mail client.
  // USER-INITIATED throughout: the extension only OPENS the page; nothing is sent until the
  // user submits from it. Falls back to a direct mailto when messaging is unavailable (e.g.
  // the test harness or an unexpected SW gap). Triggered by the ⚠ Report button.
  OBR.reportBroken = function (ctx) {
    const meta = OBR._buildReportMeta(ctx);
    try {
      if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'obr-open-report', meta: meta }, () => { void chrome.runtime.lastError; });
        return meta;
      }
    } catch (e) { /* fall through to mailto */ }
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
  // `site` (optional): a host to focus — the options page filters its site-rules + saved-picks
  // lists to that site (with a "Show all" toggle). The reader/gallery pass the current host so
  // opening settings from a page jumps straight to that site's overrides.
  OBR.openOptions = function (site) {
    try {
      if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'obr-open-options', site: site || '' }, () => { void chrome.runtime.lastError; });
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

  // Best-guess a PATH-scoped rule pattern from a full page URL — for the context menu's
  // "Auto-open on pages like this…" (the user reviews/edits it in Options before it saves, so
  // an imperfect guess is fine). Rules of thumb, in order:
  //  - a script/file endpoint (…/viewtopic.php?t=1) keeps the file so every topic matches but
  //    the index (…/viewforum.php) doesn't — path-less sites like phpBB route through one path;
  //  - a clean nested path (/forum/topic/123) drops the last, page-specific segment → /forum/topic/*
  //    so sibling pages match;
  //  - a root or single-segment path has no section to scope to → fall back to the whole host.
  OBR._pathPatternForUrl = function (url) {
    try {
      const u = new URL(url);
      const host = OBR.normalizeHost(u.hostname);
      const segs = (u.pathname || '/').split('/').filter(Boolean);
      if (!segs.length) return host;
      if (/\.[a-z0-9]{1,8}$/i.test(segs[segs.length - 1])) return host + u.pathname + '*';
      if (segs.length >= 2) return host + '/' + segs.slice(0, -1).join('/') + '/*';
      return host;
    } catch (e) { return ''; }
  };

  // The context-menu id → action mapping, as a PURE descriptor, so the dispatch in background.js
  // is a thin switch and the mapping itself is unit-testable — a wrong mode (e.g. obr-def-images
  // → 'text') surfaces in a test instead of only under a manual right-click. 'open' = one-shot
  // open now (Band 1); 'configure' = set the site's default view (Band 2); the rest name their
  // side effect. Returns null for ids we don't handle (separators, the parent item).
  OBR._menuAction = function (id) {
    switch (id) {
      case 'obr-open-text': return { do: 'open', mode: 'text' };
      case 'obr-open-images': return { do: 'open', mode: 'images' };
      case 'obr-open-auto':
      case 'obr-open': return { do: 'open', mode: 'auto' };
      case 'obr-def-text': return { do: 'configure', mode: 'text' };
      case 'obr-def-images': return { do: 'configure', mode: 'images' };
      case 'obr-def-auto': return { do: 'configure', mode: 'auto' };
      case 'obr-rule-clear': return { do: 'clear' };
      case 'obr-rule-auto': return { do: 'enable-auto' };
      case 'obr-rule-auto-url': return { do: 'auto-url' };
      case 'obr-rule-auto-stop': return { do: 'stop-auto' };
      case 'obr-open-options': return { do: 'options' };
      default: return null;
    }
  };

  // What "Configure Default → <mode>" should WRITE for a site, given its current rule (or null).
  // Reader/Gallery just set the mode. "Smart pick" (mode 'auto') with auto-open OFF CLEARS the
  // rule — smart pick IS the global default, so leaving a no-op {mode:'auto'} would only add
  // menu noise ("Clear rule"/"Current selection") for a site with no real preference. With
  // auto-open ON we keep the rule at mode 'auto' (auto-open + smart-pick view). Returns
  // { mode } to upsert, or { clear: true } to remove the whole-site rule.
  OBR._configureDefaultAction = function (prevRule, mode) {
    if (mode !== 'auto') return { mode: mode };
    if (prevRule && prevRule.auto === true) return { mode: 'auto' };
    return { clear: true };
  };

  // Compile a glob (`*` = any run of chars) into an anchored, case-insensitive RegExp over
  // a `host + pathname` target. A pattern with no "/" is a whole-site rule, so it also
  // matches any path under that host (the trailing "(?:/.*)?"). The host is www-stripped to
  // match the www-stripped target (so a stray "www." in a hand-edited pattern still works).
  function globToRegExp(pattern) {
    try {
      let p = String(pattern).trim().toLowerCase().replace(/^www\./, '');
      // A leading "*." (subdomain wildcard) ALSO matches the apex, mirroring Chrome's
      // "*.example.com" match-pattern semantics (which includes example.com itself). So a
      // "*.example.com/*" rule fires on example.com and www.example.com too — not only on
      // dotted subdomains — keeping it consistent with the origin permission originsForRule()
      // grants for it (auto-open registers the sentinel on the apex/www as well, and the
      // target host is www-stripped before matching, so it arrives here as the bare apex).
      let sub = '';
      if (p.startsWith('*.')) { sub = '(?:[^/]*\\.)?'; p = p.slice(2); }
      const esc = p.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
      const tail = p.indexOf('/') === -1 ? '(?:/.*)?' : '';
      return new RegExp('^' + sub + esc + tail + '$');
    } catch (e) { return null; }
  }

  // The most-specific site rule OBJECT matching `url`, or null if none match.
  // Specificity = literal length of the pattern (wildcards removed); longest wins.
  // The auto-open paths need the whole rule (its `auto` flag and exact `match`, e.g.
  // for the chip's "stop auto-opening"), so this returns the entry itself;
  // OBR.matchSiteRule below stays the mode-only wrapper every older call site uses.
  OBR.matchSiteRuleEx = function (url, rules) {
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
        if (score > bestScore) { bestScore = score; best = r; }
      }
    }
    return best;
  };

  // Pick the MODE of the most-specific site rule matching `url`, or null if none match.
  OBR.matchSiteRule = function (url, rules) {
    const r = OBR.matchSiteRuleEx(url, rules);
    return r ? r.mode : null;
  };

  // Map a site-rule glob to the Chrome origin match patterns a sentinel registration (or a
  // permissions.request) needs to cover it. Origins are HOST-scoped — the path part of a
  // rule is enforced by the sentinel's own rule check, not the grant. Returns [] when the
  // host part can't form a valid match pattern (a mid-host `*`, an empty host): callers
  // MUST treat [] as "cannot auto-open" — one invalid pattern rejects a whole
  // registerContentScripts call. PURE + testable.
  //   'example.com'        -> ['*://example.com/*', '*://www.example.com/*']
  //   'example.com/t/*'    -> ['*://example.com/*', '*://www.example.com/*']
  //   '*.example.com/...'  -> ['*://*.example.com/*']  (already covers www)
  OBR.originsForRule = function (match) {
    const p = OBR.normalizePattern(match);
    if (!p) return [];
    const host = p.split('/')[0].replace(/:\d+$/, ''); // match patterns can't carry a port
    if (!host) return [];
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      // A match-pattern host allows ONE leading "*." wildcard and nothing else.
      if (!base || base.includes('*')) return [];
      return ['*://*.' + base + '/*'];
    }
    if (host.includes('*')) return []; // mid-host wildcard — not expressible as a match pattern
    return ['*://' + host + '/*', '*://www.' + host + '/*'];
  };

  // The de-duped origin patterns the AUTO rules collectively need. ONE definition, shared by
  // the sentinel registration + context-menu scoping (background.js) and the options page's
  // revoke guard — they MUST agree. If the registration thinks a rule needs an origin but the
  // revoke guard doesn't, the grant is handed back while the sentinel still expects it: a
  // silently dead auto rule. The reverse orphans a grant nothing uses. (Consolidated from two
  // identical unions in background.js plus per-rule computations in options.js that omitted the
  // `mode` filter — so the union and the release test could disagree on a modeless rule.)
  // A rule is live only with BOTH `match` and `mode` (matchSiteRuleEx ignores modeless rules);
  // originsForRule yields [] for globs that can't form a match pattern. PURE + testable.
  OBR.autoRuleOrigins = function (rules) {
    const out = [];
    (Array.isArray(rules) ? rules : []).forEach((r) => {
      if (!r || r.auto !== true || !r.match || !r.mode) return;
      OBR.originsForRule(r.match).forEach((o) => { if (out.indexOf(o) === -1) out.push(o); });
    });
    return out;
  };

  // The origins a rule can give back once it is no longer auto: its own, MINUS whatever the
  // remaining auto rules still need. Origins are HOST-scoped (a rule's path is enforced by the
  // sentinel, not the grant), so `host/blog/*` and `host/forum/*` share ONE grant — releasing
  // for one would silently pause the other while its checkbox still read "on". `[]` means
  // "keep the grant". `remainingRules` is the rule list AFTER the change. PURE + testable.
  OBR.releasableOrigins = function (rule, remainingRules) {
    const mine = OBR.originsForRule(rule && rule.match);
    if (!mine.length) return [];
    const needed = OBR.autoRuleOrigins(remainingRules);
    return mine.filter((o) => needed.indexOf(o) === -1);
  };

  // Migrate the legacy exact-host `sites` map ({host:{mode}}) into `siteRules` on a RAW
  // settings object (mutates in place) and guarantee `siteRules` is an array, so a user's
  // earlier per-host rules survive the model change. Shared by the read path (loadSettings)
  // AND the write path (OBR.upsertSiteRule, called from the service worker) — the one
  // migration rule lives here, not copied per call site. Only seeds from the legacy map
  // when siteRules hasn't been written yet (not-array or empty): once any siteRules write
  // has happened (saveSettings purges `sites` from storage), the map is gone — so a
  // deliberately-emptied siteRules stays empty (no resurrection).
  OBR.migrateSiteRules = function (s) {
    if (s.sites && typeof s.sites === 'object') {
      if (!Array.isArray(s.siteRules) || !s.siteRules.length) {
        s.siteRules = Object.keys(s.sites)
          .filter((h) => s.sites[h] && s.sites[h].mode)
          .map((h) => ({ match: h, mode: s.sites[h].mode }));
      }
      delete s.sites; // consumed — don't carry the legacy key around in memory
    }
    if (!Array.isArray(s.siteRules)) s.siteRules = [];
    return s;
  };

  // Add / replace / remove the WHOLE-SITE rule for `host` on a RAW settings object (mutates
  // `raw.siteRules` in place; the caller persists). Falsy `mode` removes the rule. Folds in
  // any legacy `sites` map first so old per-host rules survive the first touch. PURE aside
  // from mutating the passed object — no storage I/O — so the service worker's context-menu
  // rule handler (and tests) call it directly. `host` should be pre-normalized via
  // OBR.normalizeHost.
  // `opts.auto`: true sets the auto-open flag, false clears it, absent PRESERVES whatever
  // the replaced rule had — so "Always open as Gallery" on an auto-enabled site changes the
  // mode without silently killing auto-open.
  OBR.upsertSiteRule = function (raw, host, mode, opts) {
    OBR.migrateSiteRules(raw); // fold in any legacy map; guarantees raw.siteRules is an array
    const prev = raw.siteRules.find((r) => r && r.match === host);
    raw.siteRules = raw.siteRules.filter((r) => !(r && r.match === host)); // drop existing whole-site rule
    if (mode) {
      const rule = { match: host, mode };
      const auto = opts && 'auto' in opts ? !!opts.auto : !!(prev && prev.auto);
      if (auto) rule.auto = true; // absent (not `false`) when off — keeps sync bytes lean
      raw.siteRules.push(rule);
    }
    return raw;
  };

  // Set / clear the auto-open flag on the EXACT rule `match` in a fresh copy of `rules`
  // (no mutation — callers hand the result to saveSettings). Used by the auto chip's
  // "stop auto-opening" (which must clear `auto` on whichever rule matched — possibly a
  // path rule — while KEEPING its mode) and the options page checkbox.
  OBR.setRuleAuto = function (rules, match, on) {
    return (Array.isArray(rules) ? rules : []).map((r) => {
      if (!r || r.match !== match) return r;
      const c = Object.assign({}, r);
      if (on) c.auto = true; else delete c.auto;
      return c;
    });
  };

  // Read settings merged over defaults (chrome.storage.sync).
  OBR.loadSettings = function () {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(OBR.STORAGE_KEY, (data) => {
          const saved = (data && data[OBR.STORAGE_KEY]) || {};
          resolve(OBR.migrateSiteRules(Object.assign({}, OBR.DEFAULTS, saved)));
        });
      } catch (e) {
        resolve(OBR.migrateSiteRules(Object.assign({}, OBR.DEFAULTS)));
      }
    });
  };

  // Serialize setting writes so two near-simultaneous saves can't interleave their
  // read-modify-write and drop each other's keys (e.g. the gallery's debounced column-width
  // and slideshow-seconds persists landing together). Each save waits for the previous to
  // commit before it reads. Mirrors the savePosition saveChain above. (Cross-PROCESS — two
  // tabs at once — is still best-effort; chrome.storage offers no lock.)
  let settingsChain = Promise.resolve();

  // Persist ONLY the keys the user explicitly changes. Merging into the RAW saved
  // object (not DEFAULTS-merged) means unset keys keep falling back to DEFAULTS at
  // load time — so changing a default later actually takes effect. (Merging the
  // full object used to "bake in" the defaults-of-the-day and block future changes.)
  OBR.saveSettings = function (partial) {
    const run = () => new Promise((resolve) => {
      try {
        chrome.storage.sync.get(OBR.STORAGE_KEY, (data) => {
          const savedRaw = (data && data[OBR.STORAGE_KEY]) || {};
          const nextRaw = Object.assign({}, savedRaw, partial);
          delete nextRaw.sites; // purge the legacy host-map once anything is written (see OBR.migrateSiteRules)
          try {
            // Resolve TRUE only on a confirmed write; FALSE on lastError (quota/throttle) or a
            // throw, so the Options page can show an error instead of a false "Saved ✓" (mirrors
            // OBR.savePick). No caller reads a settings object back — every call site ignores it.
            chrome.storage.sync.set({ [OBR.STORAGE_KEY]: nextRaw },
              () => resolve(!(globalThis.chrome && chrome.runtime && chrome.runtime.lastError)));
          } catch (e) {
            resolve(false);
          }
        });
      } catch (e) {
        resolve(false);
      }
    });
    settingsChain = settingsChain.then(run, run); // chain through failures too
    return settingsChain;
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
  function syncArea() {
    try { return (globalThis.chrome && chrome.storage && chrome.storage.sync) || null; }
    catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ map stores
   * ONE factory for every LRU-bounded map this extension keeps in chrome.storage
   * (reading positions, saved picks, gallery layout prefs, hidden images):
   * serialized writes — a chained read-modify-write, so two near-simultaneous saves
   * can't interleave and drop each other's entries — timestamped entries, and bounds
   * by entry COUNT and (optionally) serialized BYTES. These used to be hand-copied
   * near-clones, and the copies DRIFTED: the hidden-images clone shipped without the
   * byte bound savePick had, a real sync-quota bug — so the shape now lives here
   * once. (Cross-PROCESS atomicity — two tabs at once — is still best-effort;
   * chrome.storage offers no lock.)
   *   area:     () => storage area, resolved lazily (absent in the test harness)
   *   key:      the single storage item holding the whole map
   *   max:      LRU entry-count bound
   *   maxBytes: optional serialized-size bound (headroom under the 8KB sync quota)
   * API: read(k) → entry|null · readAll() → raw map · write(k, val, now?) → stores
   * {…val, t} (val == null deletes k), prunes, resolves TRUE only on a CONFIRMED
   * write / FALSE on failure (quota, unavailable, lastError) · remove(k). */
  function makeMapStore({ area, key, max, maxBytes }) {
    let chain = Promise.resolve();
    const read = (k) => new Promise((resolve) => {
      const a = area();
      if (!a || !k) return resolve(null);
      try { a.get(key, (d) => { const m = (d && d[key]) || {}; resolve(k in m ? m[k] : null); }); }
      catch (e) { resolve(null); }
    });
    const readAll = () => new Promise((resolve) => {
      const a = area();
      if (!a) return resolve({});
      try { a.get(key, (d) => resolve((d && d[key]) || {})); } catch (e) { resolve({}); }
    });
    const write = (k, val, now) => {
      const run = () => new Promise((resolve) => {
        const a = area();
        if (!a || !k) return resolve(false);
        const stamp = typeof now === 'number' ? now : Date.now();
        try {
          a.get(key, (d) => {
            const map = (d && d[key]) || {};
            if (val == null) {
              if (!(k in map)) return resolve(true); // nothing to delete — skip the write
              delete map[k];
            } else {
              map[k] = Object.assign({}, val, { t: stamp });
            }
            // LRU-prune by entry count, then (optionally) by serialized bytes.
            const byAge = () => Object.keys(map).sort((x, y) => (map[x].t || 0) - (map[y].t || 0));
            let keys = byAge();
            while (keys.length > max) delete map[keys.shift()];
            if (maxBytes) while (keys.length > 1 && JSON.stringify(map).length > maxBytes) delete map[(keys = byAge()).shift()];
            try {
              a.set({ [key]: map },
                () => resolve(!(globalThis.chrome && chrome.runtime && chrome.runtime.lastError)));
            } catch (e) { resolve(false); }
          });
        } catch (e) { resolve(false); }
      });
      chain = chain.then(run, run); // chain through failures too
      return chain;
    };
    return { read, readAll, write, remove: (k) => write(k, null) };
  }

  const positionsStore = makeMapStore({ area: localArea, key: OBR.POSITIONS_KEY, max: OBR.POSITIONS_MAX });

  // Resolve to the saved fraction [0,1] for `key`, or null when none/unavailable.
  OBR.loadPosition = (key) => positionsStore.read(key).then((e) => (e && typeof e.f === 'number' ? e.f : null));

  // Persist the fraction for `key`, LRU-pruning the map to POSITIONS_MAX entries.
  OBR.savePosition = function (key, fraction, now) {
    if (!key || typeof fraction !== 'number') return Promise.resolve(false);
    return positionsStore.write(key, { f: Math.max(0, Math.min(1, fraction)) }, now);
  };

  /* --------------------------------------------------------------- saved picks
   * Per-site "read THIS block" override — the result of the ⌖ element picker. A
   * small map keyed by normalized host -> { sel, t }, where `sel` is a CSS selector
   * for the chosen content node. Stored in chrome.storage.SYNC (like the site
   * mode-rules) so a site customization follows the user across devices; bounded by
   * BOTH entry count (PICKS_MAX) and serialized bytes (PICKS_MAX_BYTES), LRU-dropping
   * oldest, so it stays under the 8KB sync per-item quota even with long selectors. On
   * a later visit the reader resolves `sel` and extracts from that node; a stale
   * selector simply misses and falls back to whole-page. */
  OBR.PICKS_KEY = 'obr_picks';
  OBR.PICKS_MAX = 50;
  OBR.PICKS_MAX_BYTES = 7500; // headroom under chrome.storage.sync QUOTA_BYTES_PER_ITEM (8192)

  // Bounds cover BOTH entry count and serialized bytes (a long structuralPath selector
  // can be 100+ chars).
  const picksStore = makeMapStore({ area: syncArea, key: OBR.PICKS_KEY, max: OBR.PICKS_MAX, maxBytes: OBR.PICKS_MAX_BYTES });

  // The whole saved-pick map { host: { sel, t } } — for the Options list view.
  OBR.loadPicks = () => picksStore.readAll();

  // Resolve to the saved CSS selector string for `host`, or null when none/unavailable.
  OBR.loadPick = (host) => picksStore.read(host).then((e) => (e && typeof e.sel === 'string' ? e.sel : null));

  // Resolves to TRUE on a confirmed write, FALSE on any failure (quota, unavailable,
  // lastError) — so callers can tell the user instead of falsely reporting "saved".
  OBR.savePick = function (host, sel, now) {
    if (!host || !sel) return Promise.resolve(false);
    return picksStore.write(host, { sel: String(sel) }, now);
  };

  OBR.clearPick = (host) => (host ? picksStore.remove(host) : Promise.resolve(false));

  /* --------------------------------------------------------- gallery layout prefs
   * Per-site memory of the image-gallery LAYOUT (Wall masonry vs Ordered row-major) and
   * its column count, so a manga/comic host reopens in the reading layout you left it in
   * while a photo board stays on the wall. Map { host: { ordered, cols, t } } in
   * chrome.storage.SYNC (follows the user across devices, like saved picks / mode-rules),
   * bounded + LRU-pruned by entry count so it stays well under the 8KB sync per-item quota
   * (each entry is tiny). No new permission — `storage` already covers this. Mirrors the
   * saved-picks read-modify-write + serialization chain exactly. */
  OBR.GALLERY_KEY = 'obr_gallery';
  OBR.GALLERY_MAX = 60;

  const galleryStore = makeMapStore({ area: syncArea, key: OBR.GALLERY_KEY, max: OBR.GALLERY_MAX });

  // Resolve to { ordered, cols } for `host`, or null when none/unavailable. `cols` is
  // undefined when the stored entry has no numeric column count (caller falls back to defaults).
  OBR.loadGalleryPref = (host) => galleryStore.read(host).then((e) => (e && typeof e === 'object'
    ? { ordered: !!e.ordered, cols: typeof e.cols === 'number' ? e.cols : undefined }
    : null));

  // Persist { ordered, cols } for `host`, LRU-pruning to GALLERY_MAX entries. Resolves TRUE
  // on a confirmed write, FALSE on any failure.
  OBR.saveGalleryPref = function (host, pref, now) {
    if (!host || !pref) return Promise.resolve(false);
    return galleryStore.write(host, { ordered: !!pref.ordered, cols: typeof pref.cols === 'number' ? pref.cols : 2 }, now);
  };

  /* --------------------------------------------------------- hidden images
   * Per-site image filter: a list of URL glob patterns whose matches the gallery drops
   * (forum avatars, badges, emoji CDNs — noise a different-URL-per-user set that dedup and
   * the min-size filter can't catch). Map { host: { p:[pattern,...], t } } in
   * chrome.storage.SYNC (follows the user like saved picks / mode-rules), bounded by host
   * count AND per-host pattern count, LRU-pruned. Patterns are globs over `host+pathname`,
   * matched with the SAME globToRegExp compiler as the site-rules. No new permission. */
  OBR.HIDDEN_KEY = 'obr_hidden';
  OBR.HIDDEN_HOSTS_MAX = 80;
  OBR.HIDDEN_PER_HOST_MAX = 40;
  OBR.HIDDEN_MAX_BYTES = 7500;   // headroom under chrome.storage.sync QUOTA_BYTES_PER_ITEM (8192)
  OBR.HIDDEN_PAT_MAX_LEN = 500;  // quota-poison backstop: one giant pattern must not sink the map

  // The glob target for an image URL: normalized `host + pathname`, lowercased (query/hash
  // dropped so a pattern isn't defeated by cache-busting params). Null when unparseable —
  // and for non-http(s) URLs: a data:/blob: "pathname" is the whole payload (tens of KB of
  // base64), which would poison the 8KB sync quota; those images are hidden by the ELEMENT
  // (`css:`) scope instead.
  OBR.hiddenTarget = function (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return (OBR.normalizeHost(u.hostname) + u.pathname).toLowerCase();
    } catch (e) { return null; }
  };

  // True when `url` matches any URL glob in `pats` (reuses the site-rule glob compiler).
  // Entries prefixed `css:` are ELEMENT selectors (matched in the gallery via img.matches,
  // for noise a URL can't discriminate — same-CDN avatars vs content), and entries prefixed
  // `+` are per-image ALLOWS (avatar-auto-filter overrides) — both skipped here.
  OBR.urlMatchesHidden = function (url, pats) {
    if (!Array.isArray(pats) || !pats.length) return false;
    const target = OBR.hiddenTarget(url);
    if (!target) return false;
    for (const p of pats) {
      if (typeof p === 'string' && (p.startsWith('css:') || p.startsWith('+'))) continue;
      const re = globToRegExp(p);
      if (re && re.test(target)) return true;
    }
    return false;
  };

  // Derive the three "hide like this" scope patterns from an image URL — { image, folder, host }.
  // PURE + testable. `folder` snaps to a known avatar/icon path token when present (so one rule
  // catches every user's avatar under `/user_avatar/<user>/...`), else the immediate parent dir.
  OBR.hidePatternsFor = function (url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // data:/blob: → element scope only
    const host = OBR.normalizeHost(u.hostname);
    const path = u.pathname || '/';
    const image = host + path; // exact (no wildcard) — matches just this URL
    const AVT = /^(avatars?|user[_-]?avatars?|gravatars?|profiles?|userpics?|emojis?|badges?|icons?|thumbs?)$/i;
    const segs = path.split('/').filter(Boolean);
    let tokenIdx = -1;
    for (let i = 0; i < segs.length; i++) if (AVT.test(segs[i])) { tokenIdx = i; break; }
    let folder;
    if (tokenIdx >= 0) folder = host + '/' + segs.slice(0, tokenIdx + 1).join('/') + '/*';
    else { const dir = path.slice(0, path.lastIndexOf('/') + 1); folder = host + (dir === '/' ? '/*' : dir + '*'); }
    return { image, folder, host };
  };

  const hiddenStore = makeMapStore({ area: syncArea, key: OBR.HIDDEN_KEY, max: OBR.HIDDEN_HOSTS_MAX, maxBytes: OBR.HIDDEN_MAX_BYTES });

  // Read the hidden-pattern list for `host` (a fresh array copy), or [] when none.
  OBR.loadHidden = (host) => hiddenStore.read(host).then((e) => (e && Array.isArray(e.p) ? e.p.slice() : []));

  // The whole hidden map { host: [pattern,...] } — for the Options list view.
  OBR.loadHiddenMap = () => hiddenStore.readAll().then((map) => {
    const out = {};
    for (const h of Object.keys(map)) if (map[h] && Array.isArray(map[h].p)) out[h] = map[h].p.slice();
    return out;
  });

  // Replace the WHOLE pattern list for `host` (empty list removes the host). De-dupes, caps
  // each pattern's length (quota-poison backstop: a data: payload smuggled in as a pattern
  // would sink every later write for the host) and the per-host count; the store then
  // LRU-prunes hosts by count AND bytes. Resolves TRUE on a confirmed write.
  OBR.saveHidden = function (host, pats, now) {
    if (!host) return Promise.resolve(false);
    const clean = [];
    for (const p of (pats || [])) {
      const s = String(p || '').trim();
      if (s && s.length <= OBR.HIDDEN_PAT_MAX_LEN && !clean.includes(s)) clean.push(s);
    }
    return hiddenStore.write(host, clean.length ? { p: clean.slice(0, OBR.HIDDEN_PER_HOST_MAX) } : null, now);
  };

  // Estimated reading minutes from a word count (220 wpm). 0 when there's no
  // measurable text, so callers can hide the badge instead of showing "~1 min".
  OBR.readingTimeMin = function (words) {
    const w = Math.max(0, Math.floor(words || 0));
    return w < 1 ? 0 : Math.max(1, Math.round(w / 220));
  };

  /* ---------------------------------------------------------- prose heuristics
   * "Article-ness" signals shared by the toolbar auto-mode (gallery.js _autoToggle),
   * the reader's suspect-extraction banner, AND the auto-open sentinel — ONE
   * implementation so the three verdicts always agree. (Lived in reader.js
   * originally; moved here because the sentinel loads only settings.js+sentinel.js.)
   * DOM access is strictly call-time — see the load-time constraint at the top.
   *
   * We count a block (<p>/<blockquote>/<li>) only when it holds >= MIN_PARA_WORDS
   * itself — a real article is carried by big paragraphs, whereas captions, nav,
   * tags and one-line snippets are short and don't count. Read straight off the
   * live DOM rather than Readability's extraction, so it still scores a real
   * article even when extraction undercounts, and it's far cheaper than a full
   * parse. (Our own UI is in Shadow DOM, so querySelectorAll never sees it.) */
  const MIN_PARA_WORDS = 20;
  // CJK (incl. compatibility ideographs), kana, and hangul write without spaces, so a
  // whole Chinese/Japanese/Korean paragraph is ONE whitespace token — it would never
  // clear MIN_PARA_WORDS and the count would read ~0 on a real CJK article. Count each
  // CJK/kana/hangul glyph as its own word, plus the space-delimited tokens of whatever's
  // left (Latin, digits, punctuation). Pure-Latin text is unaffected.
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\uff66-\uff9f]/g;

  // CJK-aware word count of a plain string (the shared tokenizer).
  OBR._countWords = function (text) {
    const t = (text || '').trim();
    if (!t) return 0;
    return (t.match(CJK_RE) || []).length + (t.replace(CJK_RE, ' ').match(/\S+/g) || []).length;
  };

  // { words, maxBlock }: total words in substantial prose leaf blocks, and the word
  // count of the single largest leaf block (the auto-open "anchor block" — a forum
  // index can total 200 words of long topic titles, but only a real post carries one
  // substantial paragraph).
  OBR._proseStats = function () {
    let words = 0, maxBlock = 0;
    document.querySelectorAll('p, blockquote, li').forEach((el) => {
      if (el.querySelector('p, blockquote, li')) return; // leaf blocks only — no nesting double-count
      const w = OBR._countWords(el.textContent);
      if (w > maxBlock) maxBlock = w;
      if (w >= MIN_PARA_WORDS) words += w;
    });
    return { words, maxBlock };
  };

  // Long-standing alias (gallery/_autoToggle, reports, tests).
  OBR._articleWordCount = function () { return OBR._proseStats().words; };

  /* ---------------------------------------------------------- auto-open shared bits
   * The in-page suppression set + page key shared by both engines and the sentinel
   * (registered content scripts and executeScript injections share the extension's
   * one isolated world per frame), the "stop auto-opening here" writer, and the
   * transient status chip. */

  // Suppression key: origin+pathname+SEARCH. Query-routed forums (viewtopic.php?t=123)
  // put every topic on one pathname — an Esc keyed on pathname alone would silence the
  // whole forum. The set is in-memory (page-session lifetime), so unlike OBR.positionKey
  // there is no quota reason to strip the query.
  OBR._autoPageKey = function () {
    try { return location.origin + location.pathname + location.search; }
    catch (e) { return (globalThis.location && location.href) || ''; }
  };

  // Record a user-initiated dismissal of reading mode on this page. The sentinel never
  // auto-opens a recorded page again this page session; a full reload starts fresh.
  OBR._autoSuppress = function () {
    (OBR._autoSuppressed = OBR._autoSuppressed || new Set()).add(OBR._autoPageKey());
  };

  // Clear the auto flag on whichever rule matched the current URL (possibly a path
  // rule), KEEPING its mode — "stop automating" must not also forget "this site is a
  // gallery site". Resolves true on a confirmed write, false when nothing matched.
  // Relay to the service worker rather than clearing the flag here. A content script cannot
  // call permissions.remove, so doing it in-page would clear `auto` while KEEPING the site
  // grant — the chip and the context menu share the verb "Stop auto-opening", and they must
  // not differ in what happens to the permission. The SW's stopAutoOpen owns both halves.
  // Falls back to the local write when messaging is unavailable (the test harness), which is
  // the old behaviour: flag cleared, grant kept.
  OBR._stopAutoHere = function () {
    const local = () => OBR.loadSettings().then((s) => {
      const rule = OBR.matchSiteRuleEx(location.href, s.siteRules);
      if (!rule || !rule.auto) return false;
      return OBR.saveSettings({ siteRules: OBR.setRuleAuto(s.siteRules, rule.match, false) });
    });
    try {
      if (!(globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage)) return local();
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'obr-stop-auto' }, (resp) => {
          if (chrome.runtime.lastError || !resp) return local().then(resolve); // SW asleep/absent
          resolve(!!resp.ok);
        });
      });
    } catch (e) { return local(); }
  };

  // Transient auto-open status chip, in its OWN tiny shadow host so it rides above
  // either engine's overlay — and can exist with no engine at all (the enable-time
  // confirmation, §3.1 of docs/auto-open-spec.md). kind: 'opened' (auto-opened; carries
  // the Stop button) | 'enabled' (auto-open armed but this page didn't qualify) |
  // 'stopped' (feedback after Stop). Best-effort UI: never throws into an open().
  let chipTimer = null;
  OBR._showAutoChip = function (kind, host) {
    try {
      const prev = document.getElementById('obr-auto-chip-host');
      if (prev) prev.remove();
      clearTimeout(chipTimer);
      const made = OBR.makeShadowHost('obr-auto-chip-host');
      const el = made.host, root = made.root;
      OBR.adoptStyles(root, `
        .chip { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
          z-index: 2147483647; display: flex; align-items: center; gap: 9px;
          padding: 8px 10px 8px 14px; border-radius: 12px;
          font: 12.5px/1.4 -apple-system, system-ui, "PingFang SC", sans-serif;
          background: rgba(24,25,30,.96); color: #eee;
          box-shadow: 0 8px 26px rgba(0,0,0,.35); max-width: 92vw; }
        .msg { opacity: .92; }
        button { border: none; cursor: pointer; border-radius: 7px; font: inherit; }
        .stop { background: #7c6cff; color: #fff; padding: 5px 11px; white-space: nowrap; }
        .stop:hover { background: #6a59f2; }
        .x { background: transparent; color: inherit; opacity: .6; padding: 4px 7px; }
        .x:hover { opacity: 1; }`);
      const chip = document.createElement('div');
      chip.className = 'chip';
      const msg = document.createElement('span');
      msg.className = 'msg';
      const gone = () => { clearTimeout(chipTimer); el.remove(); };
      if (kind === 'opened') {
        msg.textContent = OBR.t('autoChipOpened');
        const stop = document.createElement('button');
        stop.className = 'stop';
        stop.textContent = OBR.t('autoChipStop');
        stop.addEventListener('click', () => {
          // Only confirm "turned off" when a rule was actually cleared — _stopAutoHere
          // resolves false on a no-op (no matching auto rule), so don't flash a misleading
          // confirmation then.
          OBR._stopAutoHere().then((ok) => { if (ok) OBR._showAutoChip('stopped'); });
        });
        chip.append(msg, stop);
      } else {
        msg.textContent = kind === 'stopped'
          ? OBR.t('autoChipStopped')
          : OBR.t('autoChipEnabled', [host || '']);
        chip.append(msg);
      }
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '✕';
      x.setAttribute('aria-label', OBR.t('autoChipDismiss'));
      x.addEventListener('click', gone);
      chip.append(x);
      root.append(chip);
      chipTimer = setTimeout(gone, kind === 'opened' ? 6000 : 5000);
    } catch (e) { /* chip is best-effort — never break an open over it */ }
  };
})();
