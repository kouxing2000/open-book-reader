/* Open Book Reader — image gallery mode
 * A second reading mode: collects every image on the page and lays them out as a
 * Pinterest-style masonry wall with a lightbox + keyboard nav. Rendered in an open
 * Shadow DOM so strict-CSP sites can't block it. Pure view: no network requests
 * beyond the <img> loads the page already makes (no downloads).
 *
 * Collection logic adapted from the masonry-image-gallery userscript.
 * Exposes globalThis.OBR.openGallery / closeGallery / toggleGallery.
 */
(function () {
  const OBR = (globalThis.OBR = globalThis.OBR || {});
  if (OBR._galleryLoaded) return; // guard against double injection
  OBR._galleryLoaded = true;

  const DL_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
  // Mode-switch glyphs (open book + framed picture) — shared with reader.js, defined once
  // on the OBR namespace in settings.js (loads first).
  const ICON_BOOK = OBR.ICONS.book;
  const ICON_IMAGES = OBR.ICONS.images;
  const RESCAN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  // Hands-free auto-scroll toggle glyphs (filled play / pause).
  const PLAY_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15l12-7.5z"/></svg>';
  const PAUSE_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  // Layout-toggle glyphs: a 2x2 grid (Wall / masonry) and stacked rows (Ordered / in-order).
  const GRID_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  const ROWS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="13" width="18" height="5" rx="1"/></svg>';
  // Lightbox "fit to width" glyph (a horizontal double-arrow).
  const FIT_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/></svg>';
  // Hide (eye-off) + Show (eye) glyphs for the image filter.
  const HIDE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a13 13 0 0 1-1.67 2.68"/><path d="M6.6 6.6A13 13 0 0 0 2 12s3 8 10 8a9 9 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="m2 2 20 20"/></svg>';
  const EYE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z"/><circle cx="12" cy="12" r="3"/></svg>';

  /* -------------------------------------------------- pure helpers (DOM-free) */
  // Whitespace-anchored srcset parser (handles comma-bearing CDN/data URLs); defined once
  // on the shared OBR namespace in settings.js, which always loads before this file.
  const bestFromSrcset = OBR.bestFromSrcset;

  function parseBackgroundImageUrls(bg) {
    if (!bg || bg === 'none') return [];
    const out = [];
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(bg)) !== null) if (m[2]) out.push(m[2]);
    return out;
  }

  function resolveUrl(url, base) {
    try { return new URL(url, base).href; } catch (e) { return null; }
  }

  function isSkippableDataUri(url) {
    return /^data:image\/(gif|svg)/i.test(url || '');
  }

  // Derive a safe download filename from an image URL.
  function filenameFromUrl(url, index = 0) {
    const ordinal = String(index + 1).padStart(3, '0');
    let name = '';
    try {
      const u = new URL(url);
      if (u.protocol === 'data:') {
        const m = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
        const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') : 'png';
        return `image-${ordinal}.${ext || 'png'}`;
      }
      name = decodeURIComponent(u.pathname.split('/').pop() || '');
    } catch (e) {
      name = (url || '').split(/[?#]/)[0].split('/').pop() || '';
    }
    name = name.replace(/[^\w.\-]+/g, '_').replace(/^[_.]+|_+$/g, '');
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      const stem = name.replace(/\.+$/, '') || `image-${ordinal}`;
      name = `${stem}.jpg`;
    }
    return name;
  }

  // Make filenames unique by suffixing -1, -2, … on (case-insensitive) collision.
  function uniquifyNames(names) {
    const seen = new Map();
    return names.map((raw) => {
      const key = raw.toLowerCase();
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      if (n === 0) return raw;
      const dot = raw.lastIndexOf('.');
      const stem = dot > 0 ? raw.slice(0, dot) : raw;
      const ext = dot > 0 ? raw.slice(dot) : '';
      return `${stem}-${n}${ext}`;
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Round-trip a message to the background service worker (which has the
  // downloads permission + host access for cross-origin fetches).
  function sendSW(msg) {
    return new Promise((resolve) => {
      try {
        if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage(msg, (resp) => {
            void chrome.runtime.lastError; // swallow "no receiver" in tests
            resolve(resp || null);
          });
        } else resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function saveBlob(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  }

  /* -------------------------------------------------- state */
  let settings = Object.assign({}, OBR.DEFAULTS);
  let host, root, wrap, gridEl, scrollerEl, countEl, rangeEl, autoSpeedEl, lbEl, lbImg, lbCounter, lbStrip, lbSecsEl, lbControls;
  let active = false, built = false;
  let images = [];           // [{url, w, h}]
  let lightboxIndex = -1;
  let busy = false;          // a batch download is in flight
  let sweeping = false;      // a hydration chunk / Load-all is in flight
  let sweepY = 0;            // how far down the page we've hydrated so far (px)
  let fullyHydrated = false; // confirmed end of page (set by "Load all"); stop for good
  let softDone = false;      // chunk path hit the end with nothing new — pause auto-
                             // prefetch until more content appears (self-heals on merge)
  let savedPageX = 0, savedPageY = 0; // user's real page scroll, restored on close
  let domObserver = null;    // watches the page for late/inserted images
  let mergeTimer = null, hydrateTimers = [], resizeTimer = null; // debounced re-collect / relayout
  let cols = [], colHeights = []; // JS-masonry columns + their estimated heights
  let ordered = false;       // active layout: false = Wall (masonry), true = Ordered (row-major)
  let renderedCols = 0;      // column count of the CURRENTLY rendered layout (0 = empty state)
  let galleryHost = '';      // normalized host for the current page (per-site layout memory key)
  let fitWidth = false;      // lightbox: fit a tall page to width (fills + scrolls) vs shrink-to-fit
  let hiddenPatterns = [];   // per-site image-filter glob patterns (obr_hidden), loaded on open
  let revealHidden = false;  // session peek: show filtered images (dimmed + unhide) instead of dropping
  let hiddenSkipped = 0;     // how many images the hidden-pattern filter dropped this collect
  let lastHide = null;       // last pattern added, for one-tap Undo
  let hideMenuEl = null, undoTimer = 0;
  const selected = new Set(); // selected image URLs (survives re-render)
  let autoScroll = false;          // hands-free auto-scroll engaged
  let autoRaf = 0;                 // requestAnimationFrame handle (0 = idle)
  let autoPrevTs = 0;              // prev frame timestamp (ms); 0 = first frame, seed only
  let autoFrac = 0;                // sub-pixel accumulator (scrollTop applies integer deltas)
  let autoRetriedAtBottom = false; // one-shot: already pushed past a soft-stop at this bottom
  let slideOn = false;             // lightbox slideshow engaged (auto-advance images)
  let slideTimer = 0;              // per-image dwell timeout handle (0 = idle)
  let slideStartTs = 0;            // when the current image's dwell began (ms) — for elapsed-aware re-aim
  // Debounced, clamped numeric settings wired to their form fields (created in build()):
  // auto-scroll speed, slideshow seconds, masonry column width. See makeNumSetting.
  let speedSetting = null, slideSecsSetting = null, sizePersistTimer = null;

  const MIN = () => settings.galleryMinSize || 80;

  // One debounced, clamped numeric setting wired to a form field. Folds together the three
  // near-identical setter trios the gallery used to carry (auto-scroll speed, slideshow
  // seconds, masonry column width). Each clamps to [min,max], applies the value live, and
  // debounces the chrome.storage.sync write — dragging / key-repeat / typing fire many
  // updates, sync throttles writes, and a raw write-per-tick races its own read-modify-write.
  //   set(v)     normalize the field + apply live + (debounced) persist  — change / spinner / nudge
  //   setLive(v) apply live only; DON'T touch the field or persist        — while typing in the field
  //   flush()    write any pending value now                              — close(), before a reopen reads it
  //   nudge(d)   set(current + d)                                         — +/- keys
  function makeNumSetting({ key, min, max, fallback, field, applyLive }) {
    let timer = null;
    const clamp = (v) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : (settings[key] || fallback)));
    const persist = (v) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; OBR.saveSettings({ [key]: v }); }, 400); };
    const setLive = (v) => {
      if (!Number.isFinite(v)) return;
      settings[key] = clamp(v);
      if (applyLive) applyLive(settings[key]);
    };
    const set = (v) => {
      const next = clamp(v);
      if (field) field.value = next; // normalize the field (clamp / strip junk)
      settings[key] = next;
      if (applyLive) applyLive(next);
      persist(next); // always (re)schedule — same-value re-saves collapse anyway
    };
    const flush = () => { if (!timer) return; clearTimeout(timer); timer = null; OBR.saveSettings({ [key]: settings[key] }); };
    const nudge = (d) => set((settings[key] || fallback) + d);
    return { set, setLive, flush, nudge };
  }

  /* -------------------------------------------------- collection */
  // The real image URL a lazy <img> defers into a non-standard attribute (data-src
  // and friends), or null if it has none. Same set reader.js recognises.
  function lazyAttrUrl(img) {
    return (
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      (img.getAttribute('data-srcset') && bestFromSrcset(img.getAttribute('data-srcset'))) ||
      null
    );
  }

  // Walk every page <img> that passes the tiny-image filter, calling fn(url, w, h)
  // for each kept image. Shared by collect() and imageCount() so the gallery and the
  // badge/auto-mode count can never diverge. (Our own UI is in Shadow DOM, so
  // querySelectorAll never sees the gallery's own tiles.)
  //
  // Lazy handling: many sites show a tiny placeholder (1x1, blurhash, spinner) in
  // src/currentSrc while the real URL waits in a data-* attribute. When the element
  // is still a placeholder (undecoded, or only a sub-min stand-in is showing) and a
  // lazy attribute is present, we (a) take the lazy URL instead of the placeholder,
  // and (b) skip the size filter — the placeholder's box must not reject a real image
  // whose true dimensions aren't known yet. Otherwise we use the live src and apply
  // the normal filter (natural size when decoded, else the laid-out box), which drops
  // avatars/emoji/sprites/tracker pixels.
  // The highest-resolution URL available for an <img>: the widest candidate across its own
  // srcset plus any sibling <source srcset> in an enclosing <picture>. null when there are
  // no srcset descriptors. Lets the lightbox + downloads serve full-res even when the grid
  // thumbnail (currentSrc) is a small responsive variant the browser picked for layout.
  function largestVariant(img) {
    const parts = [];
    const own = img.getAttribute('srcset');
    if (own) parts.push(own);
    const pic = img.closest('picture');
    if (pic) pic.querySelectorAll('source[srcset]').forEach((s) => {
      const ss = s.getAttribute('srcset');
      if (ss) parts.push(ss);
    });
    return parts.length ? bestFromSrcset(parts.join(', ')) : null;
  }

  // The gallery entry a single <img> contributes — { url, full, w, h } — or null if the
  // tiny-image filter drops it. `url` is the displayed thumbnail (currentSrc); `full` is the
  // best full-res variant (>= url) used by the lightbox + downloads. Single source of truth
  // for "what (if anything) does this <img> yield", reused by eachGalleryImg and the
  // <picture> de-duplication below.
  function galleryImgEntry(img) {
    const min = MIN();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const lazy = lazyAttrUrl(img);
    const placeholder = !img.complete || !nw || (nw < min && nh < min);
    if (lazy && placeholder) return { url: lazy, full: lazy, w: 0, h: 0 }; // rescued lazy image — keep regardless of placeholder size
    const url = img.currentSrc || (img.srcset && bestFromSrcset(img.srcset)) || lazy || img.src;
    const rect = img.getBoundingClientRect();
    const w = nw || rect.width, h = nh || rect.height;
    if (w && h && (w < min || h < min)) return null;
    return { url, full: largestVariant(img) || url, w, h };
  }

  // High-precision "is this an avatar / icon / badge?" test for the auto-filter (settings
  // .galleryHideAvatars). Deliberately NOT size-based (album art / product shots are small
  // squares too): a token match on the element's own class/id/alt/src, OR a profile-link
  // wrapper AROUND a small near-square image. Kept tight so it doesn't eat real content.
  const AVATAR_TOKEN = /\bavatars?\b|user[_-]?avatars?|gravatar|profile[_-]?(pic|photo|image)s?|\buserpics?\b|\bemoji\b|\bbadges?\b|\bsprite\b/i;
  const PROFILE_HREF = /(^|\/)(u|user|users|profile|profiles|member|members|people)(\/|$)|\/@[\w.-]/i;
  function isAvatarish(img) {
    try {
      const hay = ((img.className || '') + ' ' + (img.id || '') + ' ' + (img.alt || '') + ' ' + (img.getAttribute('src') || '')).toLowerCase();
      if (AVATAR_TOKEN.test(hay)) return true;
      const a = img.closest && img.closest('a[href]');
      if (a && PROFILE_HREF.test(a.getAttribute('href') || '')) {
        const nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
        if (nw && nh && Math.max(nw, nh) <= 180 && Math.abs(nw - nh) <= Math.max(nw, nh) * 0.25) return true; // small + near-square
      }
    } catch (e) { /* defensive */ }
    return false;
  }

  /* ---- element-selector hides (`css:` entries in obr_hidden) ----
   * The URL scopes can't discriminate when content and noise share an origin+path
   * (cdn.site.com/uploads/<hash>.jpg for both) but the noise sits in a distinct container
   * (.comment-author img). These entries match by PAGE STRUCTURE instead: `css:<selector>`,
   * tested with img.matches(). Only <img> elements can be element-matched; background-image
   * and <picture><source> entries have no element here and keep URL-only filtering. */
  function cssHiddenSelectors() {
    const out = [];
    for (const p of hiddenPatterns) if (typeof p === 'string' && p.startsWith('css:') && p.length > 4) out.push(p.slice(4));
    return out;
  }
  function matchesCssHidden(img, sels) {
    for (const s of sels) { try { if (img.matches(s)) return true; } catch (e) { /* bad selector — skip */ } }
    return false;
  }
  // A class that names WHAT the element is (usable as a hide anchor), not a state/utility flag.
  function stableClass(c) {
    return /^[a-zA-Z][\w-]{2,29}$/.test(c) && !/^(js-|is-|has-)/.test(c) &&
      !/(active|current|loaded|loading|lazy|shown|visible|hidden|hover|focus|open)/i.test(c);
  }
  // Derive the "images in this spot" selector for an <img>: its own semantic class
  // (`img.avatar-img`), else a stable-classed ancestor (`.comment-author img`, up to 4 levels),
  // else the reader's unique structural path (single-image; OBR._cssPathFor — reader.js loads
  // before gallery.js in the real injection order, guarded for the gallery-only test harness).
  function selectorScopeFor(img) {
    try {
      for (const c of img.classList) if (stableClass(c)) return 'img.' + CSS.escape(c);
      let el = img.parentElement, depth = 0;
      while (el && el !== document.body && depth < 4) {
        for (const c of el.classList) if (stableClass(c)) return '.' + CSS.escape(c) + ' img';
        el = el.parentElement; depth++;
      }
      if (OBR._cssPathFor) { const s = OBR._cssPathFor(img); if (s) return s; }
    } catch (e) { /* defensive */ }
    return null;
  }
  // The live page <img> whose collected URL is `url` (for deriving/removing element hides).
  // Null for background-image / <source>-only entries — those have no <img>.
  function findImgFor(url) {
    let found = null;
    document.querySelectorAll('img').forEach((img) => {
      if (found) return;
      const e = galleryImgEntry(img);
      if (e && resolveUrl(e.url, location.href) === url) found = img;
    });
    return found;
  }

  // Per-image ALLOW entries ('+<target>' in obr_hidden): the recovery path for an avatar
  // auto-filter false positive — "Unhide" on a revealed auto-hidden tile stores one, and the
  // filter then skips exactly that image. Exact-target compares (no globs).
  function isAllowed(url) {
    const t = OBR.hiddenTarget && OBR.hiddenTarget(url);
    if (!t) return false;
    for (const p of hiddenPatterns) if (typeof p === 'string' && p.startsWith('+') && p.slice(1) === t) return true;
    return false;
  }

  function eachGalleryImg(fn) {
    const hideAv = settings.galleryHideAvatars;
    const sels = cssHiddenSelectors();
    document.querySelectorAll('img').forEach((img) => {
      const e = galleryImgEntry(img);
      if (!e) return;
      // Avatar auto-filter: TAG, never silently vanish — tagged entries ride the same
      // hiddenSkipped count / "N hidden · Show" reveal as manual hides, so a false positive
      // is visible and recoverable (Unhide stores a per-image '+' allow entry).
      if (hideAv && isAvatarish(img) && !isAllowed(resolveUrl(e.url, location.href))) e.autoHidden = true;
      else if (sels.length && matchesCssHidden(img, sels)) e.elHidden = true; // tagged; collect() drops or (peeking) keeps it
      fn(e);
    });
  }

  // <picture><source srcset> URLs, calling fn(url) for each — but SKIPPING sources whose
  // <picture> has an <img> that eachGalleryImg already collects (galleryImgEntry != null,
  // via its real src or a rescued lazy URL). That <img> represents the picture; its
  // <source> siblings are the SAME photo at other formats/widths, so counting them too
  // would show one image as several tiles. A <source> is only collected when the picture's
  // <img> yields nothing usable (no <img>, or a small/placeholder fallback that didn't
  // clear the filter) — there the <source> is the only real URL we have. Shared by
  // collect() + imageCount() so the gallery and the badge count de-duplicate identically.
  function eachPictureSource(fn) {
    document.querySelectorAll('source[srcset]').forEach((s) => {
      const pic = s.closest('picture');
      const img = pic && pic.querySelector('img');
      if (img && galleryImgEntry(img)) return;
      fn(bestFromSrcset(s.srcset));
    });
  }

  // Scan every element's computed background-image. This is the EXPENSIVE part of a full
  // collect: getComputedStyle on every node forces a synchronous style recalc, so it's kept
  // OUT of the per-merge hot path (see collect()) and only run on the initial render and at
  // the end of a "Load all" sweep.
  function eachBackgroundImage(push) {
    const min = MIN();
    document.querySelectorAll('*').forEach((el) => {
      const urls = parseBackgroundImageUrls(getComputedStyle(el).backgroundImage);
      if (!urls.length) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < min || rect.height < min) return;
      urls.forEach((u) => push(u, rect.width, rect.height));
    });
  }

  // Collect gallery entries from the page. `withBackgrounds` adds the costly CSS
  // background-image scan; merges pass false (the cheap <img> + <picture> walk) so an
  // incremental re-collect — which runs on every MutationObserver hit and once per
  // hydration step (~80x during "Load all") — never forces a whole-document style recalc.
  function collect(withBackgrounds) {
    const seen = new Set();
    const out = [];
    hiddenSkipped = 0; // recomputed each collect (drives the "N hidden" toggle)
    const push = (rawUrl, w, h, fullRaw, elHidden, autoHidden) => {
      if (!rawUrl || isSkippableDataUri(rawUrl)) return;
      const url = resolveUrl(rawUrl, location.href);
      if (!url || seen.has(url)) return;
      seen.add(url);
      // Per-site image filter — URL globs here; element (`css:`) and avatar-auto matches
      // tagged upstream in eachGalleryImg: drop matches (or, while peeking, keep them tagged).
      const hidden = !!elHidden || !!autoHidden ||
        (hiddenPatterns.length && OBR.urlMatchesHidden && OBR.urlMatchesHidden(url, hiddenPatterns));
      if (hidden && !revealHidden) { hiddenSkipped++; return; }
      const full = (fullRaw && resolveUrl(fullRaw, location.href)) || url;
      out.push({ url, full, w: w || 0, h: h || 0, hidden, auto: !!autoHidden });
    };

    eachGalleryImg((e) => push(e.url, e.w, e.h, e.full, e.elHidden, e.autoHidden));
    eachPictureSource(push); // <picture> fallback sources: full === url
    if (withBackgrounds) eachBackgroundImage(push);

    return out;
  }

  // Lightweight count of gallery-worthy images, for the reader's "Images · N"
  // badge / mode-switch affordance. Reuses the SAME <img> walk + tiny-image filter
  // as collect() (via eachGalleryImg) plus the <source srcset> pass, but deliberately
  // SKIPS the per-element getComputedStyle background-image scan (the expensive part
  // of collect()) — a slight undercount on CSS-image galleries is fine for a hint;
  // full fidelity only matters once the gallery actually opens. Computed fresh each
  // call so it stays accurate across SPA navigations.
  function imageCount() {
    const seen = new Set();
    let n = 0;
    const tally = (rawUrl) => {
      if (!rawUrl || isSkippableDataUri(rawUrl)) return;
      const url = resolveUrl(rawUrl, location.href);
      if (!url || seen.has(url)) return;
      seen.add(url);
      n++;
    };
    eachGalleryImg((e) => { if (!e.autoHidden && !e.elHidden) tally(e.url); }); // filtered images don't inflate the badge
    eachPictureSource(tally);
    return n;
  }
  OBR._imageCount = imageCount;

  /* -------------------------------------------------- styles */
  function css() {
    return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; inset: 0; z-index: 2147483646;
      background: #0d0d0f; color: #e8e8ea;
      font: 14px/1.4 -apple-system, system-ui, "PingFang SC", sans-serif;
      display: flex; flex-direction: column;
    }
    .bar { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
      padding: 10px 16px; background: #16161a; border-bottom: 1px solid #26262c; }
    .title { font-weight: 600; white-space: nowrap; }
    .count { color: #9a9aa2; }
    .spacer { flex: 1; }
    .bar label { display: flex; align-items: center; gap: 8px; color: #b8b8c0; white-space: nowrap; }
    .bar input[type=range] { width: 150px; accent-color: #7c6cff; }
    .btn { background: #26262c; color: #e8e8ea; border: 1px solid #34343c;
      border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; font-family: inherit;
      display: inline-flex; align-items: center; gap: 6px; line-height: 1; white-space: nowrap; }
    .btn svg { width: 15px; height: 15px; flex: none; }
    .btn:hover { background: #34343c; }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn .icon { display: inline-flex; align-items: center; }
    .btn.autoscroll.on { background: #7c6cff; color: #fff; border-color: #7c6cff; }
    .btn.autoscroll.on:hover { background: #6a5aef; }
    /* .bar label.autospeed beats the generic ".bar label" so gap/size aren't overridden. */
    .bar label.autospeed { gap: 5px; font-size: 12px; }
    .autospeed-in { width: 64px; background: #131318; color: #e8e8ea; border: 1px solid #34343c;
      border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 12px; text-align: right;
      font-variant-numeric: tabular-nums; }
    .autospeed-in:focus { outline: none; border-color: #7c6cff; }
    /* Mode switch: recessed track holding a raised brand-accent "thumb" on the
       current side — reads as a physical toggle, matching the reader overlay. */
    .seg { display: inline-flex; padding: 3px; gap: 2px; background: #131318;
      border: 1px solid #34343c; border-radius: 9px;
      box-shadow: inset 0 1px 2px rgba(0,0,0,.55); }
    .seg-btn { display: inline-flex; align-items: center; gap: 6px;
      background: transparent; color: #b8b8c0; border: none; border-radius: 7px;
      padding: 5px 12px; cursor: pointer; font-size: 13px; font-family: inherit; line-height: 1;
      white-space: nowrap; transition: background .15s ease, color .15s ease; }
    .seg-btn svg { width: 15px; height: 15px; flex: none; }
    .seg-btn:not(.is-active):hover { color: #e8e8ea; background: rgba(124,108,255,.18); }
    .seg-btn.is-active { background: #7c6cff; color: #fff; cursor: default; font-weight: 600;
      box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 2px 6px rgba(124,108,255,.45); }
    .sep { width: 1px; align-self: stretch; background: #2c2c34; margin: 0 2px; }
    .selcount { color: #9a9aa2; min-width: 70px; }
    .status { color: #b8b8c0; font-size: 12px; min-width: 60px; }
    .selall { display: flex; align-items: center; gap: 6px; color: #b8b8c0; cursor: pointer; white-space: nowrap; }
    .scroll { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 12px;
      scrollbar-gutter: stable; } /* reserve the scrollbar width so Ordered rows justify against a
                                     stable clientWidth (no over-justify + right-edge clip when the
                                     vertical scrollbar appears after images decode) */
    /* JS masonry: a flex row of equal columns; each new tile is APPENDED to the
       shortest column so already-placed tiles never move (CSS multi-column would
       re-balance and shuffle existing images on every append). */
    .grid { display: flex; align-items: flex-start; gap: 12px; }
    .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
    /* Ordered layout: stacked justified ROWS, filled left->right / top->bottom so reading
       order == visual order. Each row is a horizontal flex; tile widths are set by
       justifyRow() (scaled to a shared row height, aspect preserved, no crop). A partial /
       single-column (strip) row centers. */
    .rows { flex: 1 1 auto; width: 100%; display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; gap: 12px; align-items: flex-start; justify-content: center; }
    .row .tile { flex: 0 0 auto; }
    .tile { position: relative; border-radius: 10px;
      overflow: hidden; background: #1a1a1f; cursor: zoom-in; display: block; line-height: 0;
      border: 1px solid #222228; transition: transform .12s ease, border-color .12s ease; }
    .tile:hover { transform: translateY(-2px); border-color: #7c6cff; }
    .tile.sel { border-color: #7c6cff; box-shadow: 0 0 0 2px #7c6cff inset; }
    .tile img { width: 100%; height: auto; display: block; }
    .tile-ctl { position: absolute; top: 8px; z-index: 2; opacity: 0; transition: opacity .12s ease; }
    .tile:hover .tile-ctl, .tile.sel .check { opacity: 1; }
    .check { left: 8px; width: 20px; height: 20px; margin: 0; cursor: pointer; accent-color: #7c6cff; }
    .tile-dl { right: 8px; width: 30px; height: 30px; border: none; border-radius: 8px; cursor: pointer;
      color: #fff; background: rgba(20,20,24,.78); padding: 0; display: flex; align-items: center; justify-content: center; }
    .tile-dl:hover { background: #7c6cff; }
    .tile-dl svg, .lb-dl svg { width: 16px; height: 16px; }
    /* ⊘ Hide button — sits left of the download button on hover. */
    .tile-hide { right: 44px; width: 30px; height: 30px; border: none; border-radius: 8px; cursor: pointer;
      color: #fff; background: rgba(20,20,24,.78); padding: 0; display: flex; align-items: center; justify-content: center; }
    .tile-hide:hover { background: #d05a6a; }
    .tile-hide svg { width: 16px; height: 16px; }
    /* Revealed (peeking) hidden tile: dimmed image + an always-visible Unhide affordance. */
    .tile.tile-is-hidden img { opacity: .4; filter: grayscale(.6); }
    /* Blast-radius preview: tiles a hovered Hide scope would remove. */
    .tile.hide-preview { border-color: #d05a6a; box-shadow: 0 0 0 2px #d05a6a inset; }
    .tile.hide-preview img { opacity: .45; }
    .tile-unhide { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); z-index: 3;
      display: inline-flex; align-items: center; gap: 6px; background: rgba(20,20,24,.9); color: #fff;
      border: 1px solid #7c6cff; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px;
      font-family: inherit; opacity: .95; }
    .tile-unhide:hover { background: #7c6cff; opacity: 1; }
    .tile-unhide svg { width: 15px; height: 15px; }
    .hidden-toggle.on { background: #7c6cff; color: #fff; border-color: #7c6cff; }
    .hidden-toggle.on:hover { background: #6a5aef; }
    /* ⊘ Hide scope popover (floated over the overlay). */
    .hide-menu { position: fixed; z-index: 2147483647; width: 320px; max-width: 92vw;
      background: #1b1b20; border: 1px solid #34343c; border-radius: 12px; padding: 8px;
      box-shadow: 0 14px 44px rgba(0,0,0,.55); }
    .hm-h { color: #9a9aa2; font-size: 12px; padding: 6px 8px 8px; }
    .hm-opt { display: block; width: 100%; text-align: left; background: transparent; border: none;
      border-radius: 8px; padding: 8px 10px; margin-bottom: 2px; cursor: pointer; font-family: inherit; }
    .hm-opt:hover { background: #26262c; }
    .hm-opt.rec { background: rgba(124,108,255,.16); box-shadow: inset 0 0 0 1px rgba(124,108,255,.5); }
    .hm-t { display: block; font-size: 13px; font-weight: 600; color: #e8e8ea; }
    .hm-s { display: block; font-size: 11px; color: #9a9aa2; margin-top: 1px;
      font-family: ui-monospace, SFMono-Regular, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 60px 0; text-align: center; color: #9a9aa2; width: 100%; }
    .lb { position: fixed; inset: 0; z-index: 2147483647; background: rgba(8,8,10,.94);
      display: none; align-items: center; justify-content: center; }
    .lb.open { display: flex; }
    .lb-img { max-width: 92vw; max-height: 88vh; object-fit: contain; border-radius: 6px;
      box-shadow: 0 12px 60px rgba(0,0,0,.6); }
    /* Fit-width reading: the page fills the width and the lightbox scrolls vertically for a
       tall page (manga/comic/scan) instead of shrinking it to fit. The chrome (arrows, close,
       counter, filmstrip, buttons) switches to position:fixed so it stays pinned while the
       image scrolls under it. */
    .lb.lb-fit { align-items: flex-start; overflow-y: auto; overflow-x: hidden; }
    .lb.lb-fit .lb-img { width: min(96vw, 1200px); max-width: none; max-height: none; height: auto;
      object-fit: fill; border-radius: 0; margin: 8px auto 88px; }
    .lb.lb-fit .lb-close, .lb.lb-fit .lb-dl, .lb.lb-fit .lb-fit-btn,
    .lb.lb-fit .lb-slideshow, .lb.lb-fit .lb-nav, .lb.lb-fit .lb-strip { position: fixed; }
    .lb-nav { position: absolute; top: 0; bottom: 0; width: 16vw; display: flex; align-items: center;
      cursor: pointer; color: #fff; font-size: 40px; opacity: .4; user-select: none; }
    .lb-nav:hover { opacity: 1; }
    .lb-prev { left: 0; justify-content: flex-start; padding-left: 20px; }
    .lb-next { right: 0; justify-content: flex-end; padding-right: 20px; }
    .lb-counter { color: #fff; font-size: 13px; opacity: .92; font-variant-numeric: tabular-nums; }
    .lb-close { position: absolute; top: 10px; right: 16px; font-size: 34px; line-height: 1;
      cursor: pointer; color: #fff; opacity: .75; width: 44px; height: 44px; display: flex;
      align-items: center; justify-content: center; z-index: 5; }
    .lb-close:hover { opacity: 1; }
    .lb-dl { position: absolute; top: 16px; right: 70px; width: 40px; height: 40px; z-index: 4;
      cursor: pointer; color: #fff; background: rgba(20,20,24,.7); border: none; border-radius: 10px;
      opacity: .85; display: flex; align-items: center; justify-content: center; }
    .lb-dl:hover { opacity: 1; background: #7c6cff; }
    .lb-dl svg { width: 20px; height: 20px; }
    .lb-fit-btn { position: absolute; top: 16px; right: 124px; width: 40px; height: 40px; z-index: 4;
      cursor: pointer; color: #fff; background: rgba(20,20,24,.7); border: none; border-radius: 10px;
      opacity: .85; display: flex; align-items: center; justify-content: center; }
    .lb-fit-btn:hover { opacity: 1; background: #7c6cff; }
    .lb-fit-btn.on { opacity: 1; background: #7c6cff; }
    .lb-fit-btn svg { width: 20px; height: 20px; }
    .lb-strip { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
      display: flex; gap: 8px; align-items: center; justify-content: center;
      padding: 12px 14px 14px; overflow-x: auto; overflow-y: hidden;
      background: linear-gradient(to top, rgba(8,8,10,.92), rgba(8,8,10,.5) 65%, rgba(8,8,10,0));
      opacity: 1; transition: opacity .25s ease; scrollbar-width: thin; }
    .lb-strip.is-hidden { opacity: 0; pointer-events: none; }
    .lb-strip::-webkit-scrollbar { height: 8px; }
    .lb-strip::-webkit-scrollbar-thumb { background: rgba(120,120,130,.6); border-radius: 4px; }
    .lb-thumb { flex: 0 0 auto; height: 60px; width: auto; max-width: 110px; object-fit: cover;
      border-radius: 6px; cursor: pointer; display: block; opacity: .5;
      border: 2px solid transparent; transition: opacity .12s, border-color .12s; }
    .lb-thumb:hover { opacity: .85; }
    .lb-thumb.is-active { opacity: 1; border-color: #7c6cff; }
    .lb-slideshow { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 4;
      display: flex; align-items: center; gap: 10px; max-width: 92vw;
      background: rgba(20,20,24,.72); border-radius: 22px; padding: 5px 14px;
      opacity: 1; transition: opacity .25s ease; }
    .lb-slideshow.is-hidden { opacity: 0; pointer-events: none; }
    .lb-play { flex: 0 0 auto; width: 30px; height: 30px; cursor: pointer; color: #fff; background: transparent;
      border: none; border-radius: 50%; opacity: .9; display: flex; align-items: center; justify-content: center; }
    .lb-play:hover { opacity: 1; background: #7c6cff; }
    .lb-play.on { opacity: 1; background: #7c6cff; }
    .lb-play svg { width: 16px; height: 16px; }
    .lb-secs { display: flex; align-items: center; gap: 4px; color: #cfcfd6; font-size: 12px; white-space: nowrap; }
    .lb-secs-in { width: 42px; background: #131318; color: #e8e8ea; border: 1px solid #34343c;
      border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 12px; text-align: right;
      font-variant-numeric: tabular-nums; }
    .lb-secs-in:focus { outline: none; border-color: #7c6cff; }
    `;
  }

  function applyStylesheet() {
    OBR.adoptStyles(root, css());
  }

  /* -------------------------------------------------- build */
  function build() {
    if (built) return;
    ({ host, root } = OBR.makeShadowHost('obr-gallery-host'));

    wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="bar">
        <!-- View cluster, leading the bar: the PRIMARY mode switch (Text ⇄ Images, the
             same control the reader carries), then the gallery's own layout sub-switch
             (Wall ⇄ Ordered) + its column-count Size, grouped right beside it — the
             layout is a sub-mode of Images, so it sits under the mode switch, not off in
             a corner. A divider sets this "how it's shown" cluster off from the rest. -->
        <span class="seg" role="group" aria-label="${OBR.t('galleryReadingModeGroup')}">
          <button class="seg-btn switch" data-act="text" title="${OBR.t('gallerySwitchToReaderTitle')}">${ICON_BOOK}<span>${OBR.t('galleryModeText')}</span></button>
          <button class="seg-btn is-active" data-act="images" aria-current="true" title="${OBR.t('galleryCurrentModeTitle')}">${ICON_IMAGES}<span>${OBR.t('galleryModeImages')}</span></button>
        </span>
        <span class="seg layout" role="group" aria-label="${OBR.t('galleryLayoutGroup')}">
          <button class="seg-btn lay-wall is-active" data-lay="wall" aria-current="true" title="${OBR.t('galleryLayoutWallTitle')}">${GRID_ICON}<span>${OBR.t('galleryLayoutWall')}</span></button>
          <button class="seg-btn lay-ordered" data-lay="ordered" aria-current="false" title="${OBR.t('galleryLayoutOrderedTitle')}">${ROWS_ICON}<span>${OBR.t('galleryLayoutOrdered')}</span></button>
        </span>
        <label>${OBR.t('gallerySizeLabel')} <input type="range" class="range" min="2" step="1" aria-label="${OBR.t('gallerySizeAria')}"></label>
        <span class="sep"></span>
        <span class="title">${OBR.t('galleryTitle')}</span>
        <span class="count"></span>
        <span class="sep"></span>
        <label class="selall"><input type="checkbox" class="selall-cb"> ${OBR.t('gallerySelectAll')}</label>
        <span class="selcount">${OBR.t('gallerySelectedCount', ['0'])}</span>
        <button class="btn dl-sel" disabled>${DL_ICON}<span>${OBR.t('galleryDownload')}</span></button>
        <button class="btn dl-zip" disabled>${DL_ICON}<span>${OBR.t('galleryZip')}</span></button>
        <button class="btn rescan" title="${OBR.t('galleryLoadAllTitle')}">${RESCAN_ICON}<span>${OBR.t('galleryLoadAll')}</span></button>
        <button class="btn autoscroll" aria-pressed="false" title="${OBR.t('galleryAutoScrollTitle')}"><span class="icon">${PLAY_ICON}</span><span class="lbl">${OBR.t('galleryAutoScroll')}</span></button>
        <label class="autospeed" title="${OBR.t('galleryAutoScrollSpeedTitle')}"><input type="number" class="autospeed-in" min="20" max="400" step="10" aria-label="${OBR.t('galleryAutoScrollSpeedAria')}"> ${OBR.t('gallerySpeedUnit')}</label>
        <button class="btn hidden-toggle" aria-pressed="false" style="display:none" title="${OBR.t('galleryShowFilteredTitle')}"><span class="icon">${EYE_ICON}</span><span class="lbl"></span></button>
        <button class="btn undo-hide" style="display:none" title="${OBR.t('galleryUndoHideTitle')}">${OBR.t('galleryUndo')}</button>
        <span class="status"></span>
        <span class="spacer"></span>
        <button class="btn report" data-act="report" title="${OBR.t('galleryReportTitle')}">${OBR.t('galleryReport')}</button>
        <button class="btn settings" data-act="settings" title="${OBR.t('gallerySettingsTitle')}">${OBR.t('gallerySettings')}</button>
        <button class="btn close" data-act="close">${OBR.t('galleryClose')}</button>
      </div>
      <div class="scroll"><div class="grid"></div></div>
      <div class="lb">
        <span class="lb-close">&times;</span>
        <button class="lb-fit-btn" aria-pressed="false" title="${OBR.t('galleryLightboxFitWidthTitle')}">${FIT_ICON}</button>
        <button class="lb-dl" title="${OBR.t('galleryLightboxDownloadTitle')}">${DL_ICON}</button>
        <div class="lb-slideshow">
          <button class="lb-play" aria-pressed="false" title="${OBR.t('gallerySlideshowStartTitle')}">${PLAY_ICON}</button>
          <label class="lb-secs" title="${OBR.t('gallerySlideSecondsTitle')}"><input type="number" class="lb-secs-in" min="1" max="30" step="1" aria-label="${OBR.t('gallerySlideSecondsAria')}"> ${OBR.t('gallerySecondsUnit')}</label>
          <span class="lb-counter"></span>
        </div>
        <div class="lb-nav lb-prev">&#8249;</div>
        <img class="lb-img" alt="">
        <div class="lb-nav lb-next">&#8250;</div>
        <div class="lb-strip is-hidden" aria-label="${OBR.t('galleryThumbnailsAria')}"></div>
      </div>`;
    root.appendChild(wrap);

    gridEl = wrap.querySelector('.grid');
    scrollerEl = wrap.querySelector('.scroll');
    countEl = wrap.querySelector('.count');
    rangeEl = wrap.querySelector('.range');
    autoSpeedEl = wrap.querySelector('.autospeed-in');
    lbEl = wrap.querySelector('.lb');
    lbImg = wrap.querySelector('.lb-img');
    lbCounter = wrap.querySelector('.lb-counter');
    lbStrip = wrap.querySelector('.lb-strip');
    lbSecsEl = wrap.querySelector('.lb-secs-in');
    lbControls = wrap.querySelector('.lb-slideshow');

    // The two debounced numeric settings. Speed has no live-apply (autoStep reads it each
    // frame); slideshow seconds re-aims the running dwell. (The Size slider is its own thing —
    // it picks a column COUNT, not a px width; see syncSizeSlider / sizeFromSlider below.)
    speedSetting = makeNumSetting({ key: 'galleryAutoScrollSpeed', min: 20, max: 400, fallback: 60, field: autoSpeedEl });
    slideSecsSetting = makeNumSetting({ key: 'gallerySlideSeconds', min: 1, max: 30, fallback: 3, field: lbSecsEl, applyLive: applySlideSecsLive });

    wrap.querySelector('.close').addEventListener('click', close);
    wrap.querySelector('.settings').addEventListener('click', () => { if (OBR.openOptions) OBR.openOptions(OBR.normalizeHost(location.href)); });
    wrap.querySelector('.report').addEventListener('click', () => {
      if (OBR.reportBroken) OBR.reportBroken({
        source: 'gallery-toolbar', mode: 'images',
        imageCount: OBR._imageCount ? OBR._imageCount() : undefined,
      });
    });
    wrap.querySelector('.switch').addEventListener('click', () => {
      close({ suppress: false }); // mode switch — still reading, not dismissing
      if (OBR.open) OBR.open(); // switch to the text reader
    });
    wrap.querySelector('.lb-close').addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
    wrap.querySelector('.lb-prev').addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
    wrap.querySelector('.lb-next').addEventListener('click', (e) => { e.stopPropagation(); step(1); });
    lbEl.addEventListener('click', (e) => {
      if (e.target !== lbImg && !lbStrip.contains(e.target) && !lbControls.contains(e.target)) closeLightbox();
    });
    lbEl.addEventListener('mousemove', revealChrome);         // show controls + filmstrip on activity, fade when idle
    lbStrip.addEventListener('mouseenter', pinChrome);        // keep visible while hovering the strip...
    lbStrip.addEventListener('mouseleave', revealChrome);
    lbControls.addEventListener('mouseenter', pinChrome);     // ...or the top controls (e.g. editing the seconds)
    lbControls.addEventListener('mouseleave', revealChrome);
    lbControls.addEventListener('focusin', pinChrome);        // don't fade the controls out from under a focused field
    lbControls.addEventListener('focusout', revealChrome);
    wrap.querySelector('.lb-play').addEventListener('click', (e) => {
      e.stopPropagation(); toggleSlideshow();
      e.currentTarget.blur(); // drop focus so arrow / +/- keys keep driving the lightbox, not the button
    });
    // Slideshow seconds: live while typing (setLive re-aims the running dwell; the field
    // isn't normalized so a partial entry like "1" before "12" isn't clobbered), clamp +
    // persist on change.
    lbSecsEl.addEventListener('input', () => slideSecsSetting.setLive(parseInt(lbSecsEl.value, 10)));
    lbSecsEl.addEventListener('change', () => slideSecsSetting.set(parseInt(lbSecsEl.value, 10)));

    // Size: pick a column count. Apply live + debounce-persist on every input tick (dragging
    // fires `input` dozens of times/sec — a raw save-per-tick would spam chrome.storage.sync
    // and race its own read-modify-write). Flush on release/change.
    rangeEl.addEventListener('input', sizeFromSlider);
    // Finish the drag: flush the pending persist so the final count lands in storage right
    // away (a reopen reads it), and drop focus so Page/Home/End/space drive the gallery
    // scroll again instead of nudging the slider value.
    rangeEl.addEventListener('pointerup', () => { flushSize(); rangeEl.blur(); });
    rangeEl.addEventListener('change', flushSize); // keyboard arrows / programmatic set

    wrap.querySelector('.lay-wall').addEventListener('click', () => setLayout(false));
    wrap.querySelector('.lay-ordered').addEventListener('click', () => setLayout(true));
    wrap.querySelector('.lb-fit-btn').addEventListener('click', (e) => {
      e.stopPropagation(); toggleFit();
      e.currentTarget.blur(); // drop focus so arrow / A keys keep driving the lightbox
    });
    wrap.querySelector('.hidden-toggle').addEventListener('click', (e) => { toggleReveal(); e.currentTarget.blur(); });
    wrap.querySelector('.undo-hide').addEventListener('click', (e) => { undoLastHide(); e.currentTarget.blur(); });
    // The ⊘ Hide scope popover, floated over the overlay (position:fixed → viewport coords).
    hideMenuEl = document.createElement('div');
    hideMenuEl.className = 'hide-menu';
    hideMenuEl.style.display = 'none';
    wrap.appendChild(hideMenuEl);
    // Close it on any click outside the menu (composedPath crosses the shadow boundary), and on
    // a grid scroll (a fixed popover would otherwise detach from its anchor tile).
    document.addEventListener('click', (e) => {
      if (!hideMenuOpen()) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(hideMenuEl) === -1) closeHideMenu();
    }, true);
    wrap.querySelector('.rescan').addEventListener('click', () => hydratePage(true));
    wrap.querySelector('.autoscroll').addEventListener('click', (e) => {
      toggleAutoScroll();
      e.currentTarget.blur(); // drop focus so Space / PageDown still drive the scroll
    });
    // Typing in the speed field applies live (autoStep reads settings each frame); persist
    // on change (blur / Enter / spinner) so a multi-keystroke entry isn't saved per keystroke.
    autoSpeedEl.addEventListener('input', () => speedSetting.setLive(parseInt(autoSpeedEl.value, 10)));
    autoSpeedEl.addEventListener('change', () => speedSetting.set(parseInt(autoSpeedEl.value, 10)));
    scrollerEl.addEventListener('scroll', onScrollerScroll, { passive: true });
    // Any real user scroll gesture takes over: cancel hands-free auto-scroll. Listen on
    // wheel/touchmove (user-gesture-only) NOT scroll — our own scrollTop writes fire scroll.
    scrollerEl.addEventListener('wheel', () => { if (autoScroll) stopAutoScroll(); }, { passive: true });
    scrollerEl.addEventListener('touchmove', () => { if (autoScroll) stopAutoScroll(); }, { passive: true });
    // Re-lay-out on viewport resize when the column count changes. Anchor the
    // topmost visible tile (keepScroll) so a resize doesn't snap the wall to the
    // top — same reading-position protection as the column-width slider.
    addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!active || !built) return;
        syncSizeSlider(); // the column ceiling (and the clamped count) move with the viewport
        if (!images.length) return;
        if (columnCount() !== renderedCols) relayoutActive(true);
        else if (ordered) rejustifyAll(); // same column count, new width — just resize Ordered tiles
      }, 150);
    });
    wrap.querySelector('.selall-cb').addEventListener('change', (e) => toggleSelectAll(e.target.checked));
    wrap.querySelector('.dl-sel').addEventListener('click', () => batchDownload(false));
    wrap.querySelector('.dl-zip').addEventListener('click', () => batchDownload(true));
    wrap.querySelector('.lb-dl').addEventListener('click', (e) => {
      e.stopPropagation();
      if (lightboxIndex >= 0) { const im = images[lightboxIndex]; downloadOne(im.full || im.url, lightboxIndex); }
    });

    applyStylesheet();
    built = true;
  }

  /* -------------------------------------------------- selection + download */
  function selectedUrls() {
    return images.map((im) => im.url).filter((u) => selected.has(u));
  }

  function setStatus(msg) {
    const el = wrap && wrap.querySelector('.status');
    if (el) el.textContent = msg || '';
  }

  function updateSelUI() {
    if (!wrap) return;
    const n = selectedUrls().length;
    wrap.querySelector('.selcount').textContent = OBR.t('gallerySelectedCount', [String(n)]);
    const selBtn = wrap.querySelector('.dl-sel');
    const zipBtn = wrap.querySelector('.dl-zip');
    selBtn.disabled = busy || n === 0;
    zipBtn.disabled = busy || n === 0;
    selBtn.querySelector('span').textContent = n ? OBR.t('galleryDownloadCount', [String(n)]) : OBR.t('galleryDownload');
    zipBtn.querySelector('span').textContent = n ? OBR.t('galleryZipCount', [String(n)]) : OBR.t('galleryZip');
    const all = wrap.querySelector('.selall-cb');
    all.checked = images.length > 0 && n === images.length;
    all.indeterminate = n > 0 && n < images.length;
  }

  function setSelected(url, on, tile) {
    if (on) selected.add(url); else selected.delete(url);
    if (tile) {
      tile.classList.toggle('sel', on);
      const cb = tile.querySelector('.check');
      if (cb) cb.checked = on;
    }
    updateSelUI();
  }

  function toggleSelectAll(on) {
    images.forEach((im) => (on ? selected.add(im.url) : selected.delete(im.url)));
    gridEl.querySelectorAll('.tile').forEach((tile) => {
      tile.classList.toggle('sel', on);
      const cb = tile.querySelector('.check');
      if (cb) cb.checked = on;
    });
    updateSelUI();
  }

  // Single download: the SW runs chrome.downloads.download (cross-origin OK). The
  // SW asks the user for the `downloads` permission the first time (resp.denied if
  // they decline). Returns the SW response so batch callers can tally results.
  function downloadOne(url, i) {
    return sendSW({ type: 'obr-download-one', url, filename: filenameFromUrl(url, i) }).then((resp) => {
      if (resp && resp.denied) setStatus(OBR.t('galleryDownloadsPermissionNeeded'));
      return resp;
    });
  }

  async function batchDownload(asZip) {
    if (busy) return;
    // Selection identity is the displayed thumbnail (im.url); download the full-res variant.
    const items = images.filter((im) => selected.has(im.url));
    if (!items.length) return;
    const urls = items.map((im) => im.full || im.url);
    busy = true;
    updateSelUI();
    setStatus(asZip ? OBR.t('galleryZipping') : OBR.t('galleryDownloading'));
    try {
      if (!asZip) {
        // Use each image's real index (not its position in the selected subset) so
        // fallback filenames (image-NNN) stay stable and meaningful. One permission
        // prompt covers the whole batch (later requests queue behind the first).
        const sent = await Promise.all(items.map((im) => downloadOne(im.full || im.url, images.indexOf(im))));
        const ok = sent.filter((r) => r && r.ok).length;
        setStatus(ok ? OBR.t('gallerySentCount', [String(ok)]) : OBR.t('galleryDownloadsPermissionNeeded'));
      } else {
        // SW fetches bytes (cross-origin host permission bypasses CORS), returns base64.
        const resp = await sendSW({ type: 'obr-fetch-bytes', urls });
        if (resp && resp.denied) { setStatus(OBR.t('galleryImageFetchPermissionNeeded')); return; }
        const results = (resp && resp.results) || [];
        const ok = results.filter((r) => r && r.ok && r.b64);
        if (!ok.length) {
          setStatus(OBR.t('galleryDownloadFailed'));
        } else {
          const names = uniquifyNames(ok.map((r, k) => filenameFromUrl(r.url, k)));
          const files = ok.map((r, k) => ({ name: names[k], bytes: b64ToBytes(r.b64) }));
          const zip = OBR._buildZip(files);
          saveBlob(new Blob([zip], { type: 'application/zip' }), 'images.zip');
          const failed = urls.length - ok.length;
          setStatus(failed ? OBR.t('galleryDoneSavedFailed', [String(ok.length), String(failed)]) : OBR.t('galleryDoneSaved', [String(ok.length)]));
        }
      }
    } catch (e) {
      setStatus(OBR.t('galleryDownloadFailed'));
    } finally {
      busy = false;
      updateSelUI();
      setTimeout(() => setStatus(''), 4000);
    }
  }

  /* -------------------------------------------------- render */
  // Build one masonry tile for image `im` at index `i` (its position in `images`).
  function makeTile(im, i) {
    const tile = document.createElement('a');
    tile.className = 'tile' + (selected.has(im.url) ? ' sel' : '');
    tile.dataset.idx = i; // stable anchor so a relayout can restore scroll position
    tile.href = im.url;
    tile.addEventListener('click', (e) => { e.preventDefault(); openLightbox(i); });
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = im.url;
    img.addEventListener('error', () => {
      // In the Ordered layout, removing a tile frees width its row was justified around —
      // re-justify (or drop an emptied row) so the row doesn't keep a permanent gap.
      const row = tile.parentElement && tile.parentElement.classList.contains('row') ? tile.parentElement : null;
      selected.delete(im.url);
      tile.remove();
      if (row) { if (row.children.length) justifyRow(row); else row.remove(); }
      updateSelUI();
    });
    // Ordered layout sizes each tile from the image's aspect ratio; a lazy/late image collected
    // with unknown dimensions (w/h = 0) used the fallback aspect, so patch its real size on decode
    // and re-justify just that row (bounded — once per unknown-size image, no earlier row moves).
    img.addEventListener('load', () => {
      if ((!im.w || !im.h) && img.naturalWidth && img.naturalHeight) {
        im.w = img.naturalWidth; im.h = img.naturalHeight;
        if (ordered && tile.parentElement && tile.parentElement.classList.contains('row')) justifyRow(tile.parentElement);
      }
    });
    tile.appendChild(img);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tile-ctl check';
    cb.checked = selected.has(im.url);
    cb.title = OBR.t('gallerySelectTile');
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => setSelected(im.url, e.target.checked, tile));
    tile.appendChild(cb);

    const dl = document.createElement('button');
    dl.className = 'tile-ctl tile-dl';
    dl.title = OBR.t('galleryDownload');
    dl.innerHTML = DL_ICON;
    dl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); downloadOne(im.full || im.url, i); });
    tile.appendChild(dl);

    const hb = document.createElement('button');
    hb.className = 'tile-ctl tile-hide';
    hb.title = OBR.t('galleryHide');
    hb.innerHTML = HIDE_ICON;
    hb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openHideMenu(im, hb); });
    tile.appendChild(hb);

    if (im.hidden) { // shown only while peeking (revealHidden): mark it + offer to un-hide
      tile.classList.add('tile-is-hidden');
      // An auto-hidden (avatar-filter) image un-hides via a per-image '+' allow entry, which
      // needs an http(s) target — a data: avatar (rare) gets no button (Options toggle remains).
      const canUnhide = !im.auto || (OBR.hiddenTarget && OBR.hiddenTarget(im.url));
      if (canUnhide) {
        const uh = document.createElement('button');
        uh.className = 'tile-unhide';
        uh.innerHTML = EYE_ICON + '<span>' + OBR.t('galleryUnhide') + '</span>';
        uh.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); unhideImage(im); });
        tile.appendChild(uh);
      }
    }
    return tile;
  }

  function renderEmpty() {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = OBR.t('galleryEmpty');
    gridEl.appendChild(e);
  }

  /* ---- JS masonry: columns we append into, never re-flowing placed tiles ---- */
  // The Size slider picks a COLUMN COUNT, not a px width — the columns are flex (`flex: 1 1 0`),
  // so within one count every width renders identically; only the count is visible. A count
  // slider makes every notch meaningful (a width slider wastes its whole low-count end on the
  // "2 columns" plateau). MIN_TILE caps how many columns fit, so the slider adapts per screen.
  const MIN_TILE = 140; // narrowest a tile may get before we stop offering more columns
  const STRIP_MAX = 900;          // px — capped width of the 1-column Ordered reading strip (centered)
  const ORD_ROW_MIN = 90;         // px — clamp: shortest a justified Ordered row may get
  const ORD_ROW_MAX = 560;        // px — clamp: tallest a justified Ordered row may get
  const ORD_FALLBACK_ASPECT = 0.72; // w/h for unknown-dimension (lazy) images — portrait-ish
  function maxCols() {
    const inner = (scrollerEl ? scrollerEl.clientWidth : 0) - 24; // .scroll padding
    return Math.max(2, Math.floor((inner + 12) / (MIN_TILE + 12)));
  }
  // Active-layout column setting + its slider floor. Wall spans 2..maxCols (a 2-up grid is the
  // biggest); Ordered spans 1..maxCols (1 = the single-page reading strip).
  function sizeKey() { return ordered ? 'galleryOrderedCols' : 'galleryColumns'; }
  function sizeLo() { return ordered ? 1 : 2; }
  function columnCount() {
    const lo = sizeLo();
    return Math.min(Math.max(lo, settings[sizeKey()] || (ordered ? 2 : 4)), maxCols());
  }
  // Reflect the stored count onto the slider for THIS screen + layout. The value is inverted so a
  // fuller bar = larger images = fewer columns; the floor moves with the layout (1 in Ordered).
  function syncSizeSlider() {
    if (!rangeEl) return;
    const mx = maxCols(), lo = sizeLo();
    rangeEl.min = lo;
    rangeEl.max = mx;
    rangeEl.value = lo + mx - columnCount();
  }
  // Slider moved: derive the count (inverse of syncSizeSlider), relayout if it changed, persist
  // the active-layout column setting AND the per-site pref.
  function sizeFromSlider() {
    const mx = maxCols(), lo = sizeLo();
    settings[sizeKey()] = Math.min(Math.max(lo, lo + mx - parseInt(rangeEl.value, 10)), mx);
    if (active && columnCount() !== renderedCols) relayoutActive(true);
    clearTimeout(sizePersistTimer);
    sizePersistTimer = setTimeout(() => { sizePersistTimer = null; persistSizeAndPref(); }, 400);
  }
  function flushSize() { if (!sizePersistTimer) return; clearTimeout(sizePersistTimer); sizePersistTimer = null; persistSizeAndPref(); }
  // Persist the active-layout column count globally (its default) and remember it (+ the layout)
  // for THIS site, so the host reopens the way you left it.
  function persistSizeAndPref() {
    OBR.saveSettings({ [sizeKey()]: settings[sizeKey()] });
    savePerSitePref();
  }
  function savePerSitePref() {
    // Store the RAW preference (settings[sizeKey()]), not the screen-clamped columnCount() — else
    // toggling layout on a narrow window would bake in a downgraded count that overrides the
    // preference on a wider screen. columnCount() re-clamps to the screen at render time.
    if (galleryHost && OBR.saveGalleryPref) OBR.saveGalleryPref(galleryHost, { ordered, cols: settings[sizeKey()] });
  }
  function columnPx(n) {
    const inner = (scrollerEl ? scrollerEl.clientWidth : 0) - 24;
    return Math.max(80, (inner - (n - 1) * 12) / n);
  }
  // Estimated rendered height of a tile, so we can append to the shortest column.
  // Uses the image's known aspect ratio; lazy images (size unknown) get a neutral
  // square estimate, which makes a run of them fill columns left-to-right (row order).
  function estHeight(im, px) {
    const ratio = im && im.w && im.h ? im.h / im.w : 1;
    return px * ratio + 14; // + border/caption slack
  }
  function buildColumns() {
    gridEl.innerHTML = '';
    const n = columnCount();
    cols = [];
    colHeights = new Array(n).fill(0);
    for (let c = 0; c < n; c++) {
      const col = document.createElement('div');
      col.className = 'col';
      gridEl.appendChild(col);
      cols.push(col);
    }
    renderedCols = n;
  }
  function placeTile(im, i) {
    const px = columnPx(cols.length);
    let idx = 0;
    for (let c = 1; c < colHeights.length; c++) if (colHeights[c] < colHeights[idx]) idx = c;
    cols[idx].appendChild(makeTile(im, i));
    colHeights[idx] += estHeight(im, px);
  }
  // Content-space top of a tile (independent of the current scrollTop).
  function tileTop(t) {
    return t.getBoundingClientRect().top - scrollerEl.getBoundingClientRect().top + scrollerEl.scrollTop;
  }
  // Bring the tile at index i to (roughly) the middle of the grid viewport. Used when the
  // lightbox closes so paging through the big view carries the reading spot back to the wall —
  // the image you just looked at ends up on screen instead of the one you opened from.
  function scrollGridToIndex(i) {
    if (!active || i < 0 || !scrollerEl || !gridEl) return;
    const t = gridEl.querySelector('.tile[data-idx="' + i + '"]');
    if (!t) return; // tile not built yet (shouldn't happen — every image has one)
    const mid = tileTop(t) - Math.max(0, (scrollerEl.clientHeight - t.offsetHeight) / 2);
    scrollerEl.scrollTop = Math.max(0, mid);
  }
  // Capture the topmost visible tile (by index) + its offset from the scroll top, so a rebuild
  // can restore the reading spot instead of snapping to the top. Layout-agnostic (reads .tile
  // data-idx), so Wall, Ordered, and a Wall<->Ordered switch all reuse it.
  function captureAnchor() {
    const a = { idx: -1, offset: 0 };
    if (!scrollerEl || !images.length) return a;
    const st = scrollerEl.scrollTop;
    let best = Infinity;
    gridEl.querySelectorAll('.tile').forEach((t) => {
      const d = Math.abs(tileTop(t) - st);
      if (d < best) { best = d; a.idx = +t.dataset.idx; a.offset = tileTop(t) - st; }
    });
    return a;
  }
  function restoreAnchor(a) {
    if (!a || a.idx < 0 || !scrollerEl) return;
    const t = gridEl.querySelector('.tile[data-idx="' + a.idx + '"]');
    if (t) scrollerEl.scrollTop = Math.max(0, tileTop(t) - a.offset);
  }

  // Lay every known image into fresh columns (initial render, resize, column-width change).
  // `keepScroll` anchors the topmost visible tile so a rebuild doesn't snap to the top.
  function layoutAll(keepScroll) {
    const anchor = keepScroll ? captureAnchor() : null;
    if (!images.length) { gridEl.innerHTML = ''; cols = []; colHeights = []; renderedCols = 0; renderEmpty(); return; }
    buildColumns();
    images.forEach((im, i) => placeTile(im, i));
    restoreAnchor(anchor);
  }

  /* ---- Ordered layout: justified ROWS, row-major, in reading order ----
   * Row r holds images [r*N .. r*N+N-1] (N = columnCount), so image i is ALWAYS in row
   * floor(i/N) at position i%N — order == reading order, and appending never moves an earlier
   * tile (the no-reflow property Wall got from shortest-column packing). Each row's tiles are
   * scaled to a shared height (aspect preserved, no crop); a partial / single (strip) row is
   * centered. */
  function orderedRowsEl() {
    let r = gridEl.querySelector('.rows');
    if (!r) { gridEl.innerHTML = ''; r = document.createElement('div'); r.className = 'rows'; gridEl.appendChild(r); }
    return r;
  }
  // Size the tiles of one Ordered row. Neighbour-independent: a partial row (k<N) is scaled as
  // if it had N slots of the same average aspect, so it matches the height of full rows without
  // stretching a lone trailing image to full width.
  function justifyRow(rowEl) {
    const tiles = rowEl.children;
    const k = tiles.length;
    if (!k || !scrollerEl) return;
    const GAP = 12;
    const innerW = Math.max(0, scrollerEl.clientWidth - 24); // .scroll padding
    const N = renderedCols || k;
    if (N <= 1) { // strip: one full-width (capped), centered page per row
      tiles[0].style.width = Math.min(innerW, STRIP_MAX) + 'px';
      return;
    }
    let sumA = 0;
    const aspects = [];
    for (let j = 0; j < k; j++) {
      const im = images[+tiles[j].dataset.idx];
      const a = im && im.w && im.h ? im.w / im.h : ORD_FALLBACK_ASPECT;
      aspects.push(a); sumA += a;
    }
    const avail = innerW - (N - 1) * GAP;
    // Divide by (sumA scaled to N slots) so full and partial rows land on the same height.
    let H = avail / (sumA * (N / k));
    H = Math.max(ORD_ROW_MIN, Math.min(ORD_ROW_MAX, H));
    for (let j = 0; j < k; j++) tiles[j].style.width = Math.round(aspects[j] * H) + 'px';
  }
  // Append tiles for images [startIdx..] into the Ordered rows, re-justifying only the rows the
  // append touched (the previously-partial last row + any new rows). Earlier rows never move.
  function appendOrderedTiles(startIdx) {
    const N = columnCount();
    if (renderedCols !== N) { layoutOrdered(true); return; } // column count drifted — full rebuild
    const rowsEl = orderedRowsEl();
    const firstRow = Math.floor(startIdx / N);
    for (let i = startIdx; i < images.length; i++) {
      const r = Math.floor(i / N);
      let row = rowsEl.children[r];
      if (!row) { row = document.createElement('div'); row.className = 'row'; rowsEl.appendChild(row); }
      row.appendChild(makeTile(images[i], i));
    }
    for (let r = firstRow; r < rowsEl.children.length; r++) justifyRow(rowsEl.children[r]);
  }
  function layoutOrdered(keepScroll) {
    const anchor = keepScroll ? captureAnchor() : null;
    if (!images.length) { gridEl.innerHTML = ''; renderedCols = 0; renderEmpty(); return; }
    const N = columnCount();
    renderedCols = N;
    gridEl.innerHTML = '';
    const rowsEl = document.createElement('div');
    rowsEl.className = 'rows';
    gridEl.appendChild(rowsEl);
    for (let i = 0; i < images.length; i++) {
      const r = Math.floor(i / N);
      let row = rowsEl.children[r];
      if (!row) { row = document.createElement('div'); row.className = 'row'; rowsEl.appendChild(row); }
      row.appendChild(makeTile(images[i], i));
    }
    for (let r = 0; r < rowsEl.children.length; r++) justifyRow(rowsEl.children[r]);
    restoreAnchor(anchor);
  }

  // Render (or re-render) the currently selected layout.
  function relayoutActive(keepScroll) { if (ordered) layoutOrdered(keepScroll); else layoutAll(keepScroll); }

  // Switch layout (toolbar Wall/Ordered toggle). Anchors the reading spot across the rebuild and
  // remembers the choice for this site.
  function setLayout(next) {
    if (ordered === !!next || !active) return;
    flushSize(); // commit any pending debounced size write to the CURRENT layout's key before switching
    ordered = !!next;
    updateLayoutToggle();
    syncSizeSlider();
    relayoutActive(true);
    savePerSitePref();
  }
  function updateLayoutToggle() {
    if (!wrap) return;
    const w = wrap.querySelector('.lay-wall'), o = wrap.querySelector('.lay-ordered');
    if (w) { w.classList.toggle('is-active', !ordered); w.setAttribute('aria-current', !ordered ? 'true' : 'false'); }
    if (o) { o.classList.toggle('is-active', ordered); o.setAttribute('aria-current', ordered ? 'true' : 'false'); }
  }
  OBR._gallerySetLayout = (on) => setLayout(!!on); // drive (tests)
  OBR._galleryLayoutOrdered = () => ordered;       // state (tests)

  function render() {
    images = collect(true); // initial render: include the CSS background-image scan
    if (lbStrip && lightboxIndex < 0) lbStrip.replaceChildren(); // rebuild the strip fresh on next open
    if (scrollerEl) scrollerEl.scrollTop = 0;
    syncSizeSlider(); // reflect the stored column count (max + value) for this screen + layout
    countEl.textContent = OBR.t('galleryImageCount', [String(images.length)]);
    relayoutActive(false);
    updateSelUI();
    updateHiddenToggle();
  }

  // Re-justify every Ordered row in place (widths depend on the viewport width). Cheap — style
  // writes only, no rebuild / image reload — so a resize at the same column count doesn't churn.
  function rejustifyAll() {
    const rowsEl = gridEl && gridEl.querySelector('.rows');
    if (!rowsEl) return;
    for (let r = 0; r < rowsEl.children.length; r++) justifyRow(rowsEl.children[r]);
  }

  /* -------------------------------------------------- image filter (Hide) */
  // Re-collect with the current filter state and re-lay-out, preserving scroll position. Used
  // after a hide / undo / unhide / reveal toggle (all infrequent, so a full re-collect is fine).
  function refreshFilter() {
    const sy = scrollerEl ? scrollerEl.scrollTop : 0;
    images = collect(true);
    if (countEl) countEl.textContent = OBR.t('galleryImageCount', [String(images.length)]);
    relayoutActive(false);
    if (scrollerEl) scrollerEl.scrollTop = Math.min(sy, Math.max(0, scrollerEl.scrollHeight - scrollerEl.clientHeight));
    updateSelUI();
    updateHiddenToggle();
  }
  // Live blast-radius preview: while hovering a popover option, mark the grid tiles that
  // scope would hide, so "which images are the same type" is visible before choosing.
  function previewHide(pattern) {
    clearHidePreview();
    if (!pattern || !gridEl) return;
    const marks = new Set();
    if (pattern.startsWith('css:')) {
      const s = pattern.slice(4);
      document.querySelectorAll('img').forEach((img) => {
        if (!matchesCssHidden(img, [s])) return;
        const e = galleryImgEntry(img);
        const u = e && resolveUrl(e.url, location.href);
        if (u) marks.add(u);
      });
    } else {
      images.forEach((m) => { if (OBR.urlMatchesHidden && OBR.urlMatchesHidden(m.url, [pattern])) marks.add(m.url); });
    }
    gridEl.querySelectorAll('.tile').forEach((t) => {
      const m = images[+t.dataset.idx];
      if (m && marks.has(m.url)) t.classList.add('hide-preview');
    });
  }
  function clearHidePreview() {
    if (gridEl) gridEl.querySelectorAll('.tile.hide-preview').forEach((t) => t.classList.remove('hide-preview'));
  }

  // The ⊘ Hide popover. The ELEMENT scope ("images in this spot", by page structure) leads
  // and carries the recommendation — it's what discriminates when URLs can't — followed by
  // the URL scopes (this image / folder / host). URL scopes are absent for data:/blob:
  // images (hidePatternsFor → null: their "pathname" is the whole payload).
  function openHideMenu(im, anchorBtn) {
    if (!hideMenuEl) return;
    hideMenuEl.replaceChildren();
    const opts = [];
    const imgEl = findImgFor(im.url);
    const sel = imgEl && selectorScopeFor(imgEl);
    if (sel) {
      // Count only images the gallery would actually show, so the number matches the marks.
      let n = 0;
      try { n = [...document.querySelectorAll(sel)].filter((el) => el.tagName === 'IMG' && galleryImgEntry(el)).length; } catch (e) { n = 0; }
      opts.push({ t: OBR.t('galleryHideSelector'), s: sel + ' · ' + OBR.t('galleryImageCount', [String(n)]), p: 'css:' + sel, rec: true });
    }
    const pats = OBR.hidePatternsFor ? OBR.hidePatternsFor(im.url) : null;
    if (pats) {
      opts.push({ t: OBR.t('galleryHideThis'), s: pats.image, p: pats.image });
      opts.push({ t: OBR.t('galleryHideFolder'), s: pats.folder, p: pats.folder, rec: !sel });
      opts.push({ t: OBR.t('galleryHideHost'), s: pats.host, p: pats.host });
    }
    if (!opts.length) return; // data: image with no derivable selector (test harness only)
    const head = document.createElement('div'); head.className = 'hm-h'; head.textContent = OBR.t('galleryHideMenuTitle');
    hideMenuEl.appendChild(head);
    opts.forEach((o) => {
      const b = document.createElement('button'); b.className = 'hm-opt' + (o.rec ? ' rec' : '');
      const tt = document.createElement('span'); tt.className = 'hm-t'; tt.textContent = o.t;
      const ss = document.createElement('span'); ss.className = 'hm-s'; ss.textContent = o.s;
      b.appendChild(tt); b.appendChild(ss);
      b.addEventListener('mouseenter', () => previewHide(o.p)); // mark what this scope would hide
      b.addEventListener('mouseleave', clearHidePreview);
      b.addEventListener('click', (e) => { e.stopPropagation(); closeHideMenu(); if (o.p) applyHide(o.p); });
      hideMenuEl.appendChild(b);
    });
    hideMenuEl.style.display = 'block';
    const r = anchorBtn.getBoundingClientRect();
    const mw = hideMenuEl.offsetWidth, mh = hideMenuEl.offsetHeight;
    let left = Math.min(Math.max(8, r.right - mw), Math.max(8, innerWidth - 8 - mw));
    let top = r.bottom + 6; if (top + mh > innerHeight - 8) top = Math.max(8, r.top - 6 - mh);
    hideMenuEl.style.left = left + 'px';
    hideMenuEl.style.top = top + 'px';
  }
  function closeHideMenu() { if (hideMenuEl) hideMenuEl.style.display = 'none'; clearHidePreview(); }
  function hideMenuOpen() { return !!hideMenuEl && hideMenuEl.style.display === 'block'; }
  // Persist the current pattern list. saveHidden resolves FALSE on a failed write (quota /
  // storage unavailable) — surface it in the console instead of silently losing the hide.
  function persistHidden() {
    if (!galleryHost || !OBR.saveHidden) return;
    OBR.saveHidden(galleryHost, hiddenPatterns).then((ok) => {
      if (ok === false) { try { console.warn('[OpenBookReader] hidden-image save failed (storage quota?) — the filter applies this session only'); } catch (e) { /* */ } }
    });
  }
  function applyHide(pattern) {
    if (!pattern) return;
    if (!hiddenPatterns.includes(pattern)) hiddenPatterns.push(pattern);
    lastHide = pattern;
    persistHidden();
    revealHidden = false;
    refreshFilter();
    flashUndo();
  }
  function undoLastHide() {
    if (!lastHide) return;
    const i = hiddenPatterns.indexOf(lastHide);
    if (i >= 0) hiddenPatterns.splice(i, 1);
    lastHide = null;
    persistHidden();
    hideUndo();
    refreshFilter();
  }
  // Un-hide a specific revealed image. Auto-hidden (avatar filter) → store a per-image '+'
  // allow entry; manual hides → drop every stored pattern that matches it (usually one) —
  // URL globs by URL, `css:` element entries by re-testing against the image's live <img>.
  function unhideImage(im) {
    if (im.auto) {
      const t = OBR.hiddenTarget && OBR.hiddenTarget(im.url);
      if (!t) return; // no stable key to allow (data: avatar) — the Options toggle remains
      if (!hiddenPatterns.includes('+' + t)) hiddenPatterns.push('+' + t);
    } else {
      const imgEl = findImgFor(im.url);
      hiddenPatterns = hiddenPatterns.filter((p) => {
        if (typeof p === 'string' && p.startsWith('css:')) return !(imgEl && matchesCssHidden(imgEl, [p.slice(4)]));
        if (typeof p === 'string' && p.startsWith('+')) return true; // allows are unhide state — keep
        return !(OBR.urlMatchesHidden && OBR.urlMatchesHidden(im.url, [p]));
      });
    }
    // If this unhide removed the pattern Undo points at, retire the stale Undo button.
    if (lastHide && !hiddenPatterns.includes(lastHide)) { lastHide = null; hideUndo(); }
    persistHidden();
    refreshFilter();
  }
  function toggleReveal() { revealHidden = !revealHidden; refreshFilter(); }
  function updateHiddenToggle() {
    const btn = wrap && wrap.querySelector('.hidden-toggle');
    if (!btn) return;
    const hiddenNow = revealHidden ? images.filter((im) => im.hidden).length : hiddenSkipped;
    btn.style.display = (hiddenNow > 0 || revealHidden) ? '' : 'none';
    btn.classList.toggle('on', revealHidden);
    btn.setAttribute('aria-pressed', revealHidden ? 'true' : 'false');
    btn.title = revealHidden ? OBR.t('galleryHideFilteredTitle') : OBR.t('galleryShowFilteredTitle');
    const lbl = btn.querySelector('.lbl');
    if (lbl) lbl.textContent = revealHidden ? OBR.t('galleryShowingHidden') : OBR.t('galleryHiddenCount', [String(hiddenNow)]);
  }
  function flashUndo() {
    const btn = wrap && wrap.querySelector('.undo-hide');
    if (!btn) return;
    btn.style.display = '';
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 6000);
  }
  function hideUndo() { const btn = wrap && wrap.querySelector('.undo-hide'); if (btn) btn.style.display = 'none'; clearTimeout(undoTimer); }
  OBR._galleryHide = (pat) => applyHide(pat);                 // drive (tests)
  OBR._galleryHiddenPatterns = () => hiddenPatterns.slice();  // state (tests)
  OBR._galleryRevealHidden = (on) => { revealHidden = !!on; refreshFilter(); };
  OBR._gallerySelectorFor = (url) => { const el = findImgFor(url); return el ? selectorScopeFor(el) : null; }; // derive (tests)

  // Re-collect and APPEND any images not already shown (lazy/late/inserted) to the
  // shortest column, without disturbing existing tiles or the user's selection.
  // `withBackgrounds` runs the costly CSS background-image scan too — passed only by the
  // end of a full "Load all" sweep; the frequent incremental merges skip it (cheap path).
  function mergeNewImages(withBackgrounds) {
    if (!active || !built) return 0;
    const have = new Set(images.map((im) => im.url));
    const startIdx = images.length;
    let added = 0;
    collect(withBackgrounds).forEach((im) => {
      if (have.has(im.url)) return;
      have.add(im.url);
      images.push(im);
      added++;
    });
    if (added) {
      if (!renderedCols) relayoutActive(false);       // was empty-state — first real render
      else if (ordered) appendOrderedTiles(startIdx); // append rows; re-justify only touched rows
      else { if (!cols.length) buildColumns(); for (let i = startIdx; i < images.length; i++) placeTile(images[i], i); }
      countEl.textContent = OBR.t('galleryImageCount', [String(images.length)]);
      updateSelUI();
      softDone = false;
      if (lightboxIndex >= 0) { // keep the open lightbox's filmstrip + counter in sync as images hydrate
        buildFilmstrip();
        syncFilmstripActive(lightboxIndex);
        lbCounter.textContent = OBR.t('galleryLightboxCounter', [String(lightboxIndex + 1), String(images.length)]);
      }
    }
    // The collect() above recomputed hiddenSkipped — hydration can surface newly-filtered
    // images even when nothing visible was added, so the "N hidden · Show" toggle must
    // refresh here too (not just on render/hide/reveal), else it sits stale/invisible on
    // exactly the lazy-forum pages the filter is for.
    updateHiddenToggle();
    return added;
  }

  /* ---- live-merge: pick up images that load / get inserted after open ---- */
  function scheduleMerge() {
    clearTimeout(mergeTimer);
    mergeTimer = setTimeout(mergeNewImages, 250);
  }

  function startWatching() {
    // Catch images that finish decoding or get inserted by the page shortly after we
    // open (async hydration, JS-driven galleries) — non-intrusive, no scrolling.
    if (!domObserver && typeof MutationObserver === 'function') {
      const containsImg = (n) =>
        n.nodeType === 1 && (n.tagName === 'IMG' || (n.querySelector && n.querySelector('img')));
      domObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) if (containsImg(n)) { scheduleMerge(); return; }
        }
      });
      domObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    // A couple of delayed sweeps catch images still in flight at open time.
    hydrateTimers = [setTimeout(mergeNewImages, 600), setTimeout(mergeNewImages, 1800)];
  }

  function stopWatching() {
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    clearTimeout(mergeTimer);
    hydrateTimers.forEach(clearTimeout);
    hydrateTimers = [];
  }

  /* ---- progressive hydration: load the page's lazy images on demand ----
   * Rather than force-loading the whole page up front (wasteful — the user may only
   * want the first batch), we advance a cursor (sweepY) down the underlying page a
   * chunk at a time, only when needed: when the user nears the end of the gallery
   * (prefetched EARLY so tiles are ready before they arrive), or via "Load all".
   * Scrolling the page fires native loading="lazy" / IntersectionObserver loaders and
   * mounts virtualized rows; we merge cumulatively. The overlay covers the viewport so
   * the page-scroll is invisible; the user's real scroll position is restored on close. */
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function hydratePage(toBottom) {
    if (!active || busy || sweeping || fullyHydrated) return 0;
    if (!toBottom && softDone) return 0;
    sweeping = true;
    const btn = wrap && wrap.querySelector('.rescan');
    if (toBottom && btn) btn.disabled = true;
    setStatus(toBottom ? OBR.t('galleryLoadingAll') : OBR.t('galleryLoadingMore'));
    const de = document.documentElement;
    de.style.overflow = ''; // open() locked this to 'hidden'; allow programmatic scroll
    // Small steps with a dwell at each: big jumps can skip a page's IntersectionObserver
    // triggers (and overshoot the content), so creep down letting loaders fire.
    const step = Math.max(150, Math.floor(window.innerHeight * 0.6));
    const maxSteps = toBottom ? 80 : 3; // a chunk is ~3 short steps; "all" sweeps the page
    let added = 0, noGrow = 0;
    try {
      for (let i = 0; i < maxSteps; i++) {
        const h0 = de.scrollHeight;
        sweepY = Math.min(sweepY + step, Math.max(0, h0 - 1));
        window.scrollTo(0, sweepY);
        await wait(200); // let native lazy / IntersectionObserver loaders fire + mount
        if (!active) break; // closed mid-sweep: stop scrolling so close() can restore position
        added += mergeNewImages();
        const h1 = de.scrollHeight;
        const atBottom = sweepY + window.innerHeight >= h1 - 2;
        // Only conclude "the end" after consecutive bottom hits with no growth AND no
        // new images — otherwise a slow infinite-scroll page looks done before it is.
        if (atBottom && h1 <= h0) {
          if (++noGrow >= 2) { if (toBottom) fullyHydrated = true; else softDone = true; break; }
        } else {
          noGrow = 0;
        }
      }
      // A full "Load all" folds in CSS background-images once at the end (the per-step merges
      // skip the costly getComputedStyle scan), so the explicit "load everything" stays faithful.
      if (toBottom && active) added += mergeNewImages(true);
    } catch (e) {
      /* ignore — partial hydration is fine */
    } finally {
      de.style.overflow = active ? 'hidden' : ''; // re-lock (gallery still open)
      sweeping = false;
      // A progressive chunk that surfaced NO new images means there's nothing more to
      // pull here right now — pause auto-prefetch and let auto-scroll reach its stop
      // condition. The atBottom/no-growth check inside the loop misses the nasty case
      // where an infinite-scroll page keeps GROWING (so it never looks "at bottom") yet
      // yields no gallery-worthy images: without this, auto-scroll would hammer
      // hydratePage forever ("keeps showing Load more"). Self-heals — mergeNewImages()
      // flips softDone back to false the instant late/inserted images actually arrive
      // (MutationObserver), and the explicit "give me more" gestures (PageDown,
      // auto-scroll's one bottom-retry) clear it too.
      if (!toBottom && active && added === 0) softDone = true;
      if (btn) btn.disabled = false;
      setStatus(added ? OBR.t('galleryAddedImages', [String(added)]) : (fullyHydrated ? OBR.t('galleryAllImagesLoaded') : ''));
      setTimeout(() => setStatus(''), 2500);
    }
    return added;
  }

  // Prefetch the next chunk EARLY — while the user is still ~1.5 screens from the
  // bottom of the gallery — so the new tiles are there before they scroll to them.
  function onScrollerScroll() {
    if (hideMenuOpen()) closeHideMenu(); // a fixed popover would detach from its tile on scroll
    if (!scrollerEl || sweeping || fullyHydrated || softDone || !settings.galleryAutoLoad) return;
    const remaining = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
    if (remaining < scrollerEl.clientHeight * 1.5) hydratePage(false);
  }

  // Explicit keyboard scroll toward the bottom: unlike the passive prefetch above this
  // ignores `softDone` (the user is actively asking to go further) and isn't gated by
  // galleryAutoLoad, so a stalled feed can always be advanced by paging down.
  function maybeHydrateOnDown() {
    if (!scrollerEl || sweeping || fullyHydrated) return;
    const remaining = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
    if (remaining < scrollerEl.clientHeight * 1.5) { softDone = false; hydratePage(false); }
  }

  // After the initial render, if the grid doesn't even fill the viewport there's
  // nothing to scroll — pull one chunk so the experience isn't a dead end.
  function maybePreload() {
    if (!scrollerEl || sweeping || fullyHydrated || softDone || !settings.galleryAutoLoad) return;
    if (scrollerEl.scrollHeight <= scrollerEl.clientHeight + 8) hydratePage(false);
  }

  OBR._galleryLoadMore = () => hydratePage(false); // progressive chunk (tests)
  OBR._galleryRescan = () => hydratePage(true);    // "Load all" (button + tests)

  /* ---- hands-free auto-scroll: rAF-driven smooth descent of the masonry wall ----
   * Toggle on and the wall scrolls down by itself; near the bottom it keeps pulling more
   * lazy images (explicit-gesture semantics: ignores galleryAutoLoad, pushes once past a
   * soft-stop) so you can passively browse. Stops at the genuine end, on toggle, on any
   * manual scroll/key/wheel, on lightbox open, and on close. */
  const AUTO_DT_CAP = 0.05; // s — cap per-frame delta so a backgrounded/janky tab can't lurch
  const AUTO_PIN    = 2;    // px from true bottom that counts as "pinned"

  function autoStep(ts) {
    if (!autoScroll || !active || !scrollerEl) { autoRaf = 0; return; }
    if (lightboxIndex >= 0) { stopAutoScroll(); return; }
    if (!autoPrevTs) { autoPrevTs = ts; autoRaf = requestAnimationFrame(autoStep); return; }
    let dt = (ts - autoPrevTs) / 1000; autoPrevTs = ts;
    if (dt > AUTO_DT_CAP) dt = AUTO_DT_CAP; if (dt < 0) dt = 0;

    const speed = Math.max(1, settings.galleryAutoScrollSpeed || 60); // px/sec, read live
    autoFrac += speed * dt;
    const whole = Math.floor(autoFrac);
    if (whole >= 1) { autoFrac -= whole; scrollerEl.scrollTop += whole; } // browser clamps to range

    const remaining = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
    const near = scrollerEl.clientHeight * 1.5;
    if (remaining >= near) autoRetriedAtBottom = false; // re-arm soft-stop retry when buffer returns

    // Binge feed near the bottom — ignore galleryAutoLoad, push past a soft stop ONCE per arrival.
    if (remaining < near && !sweeping && !fullyHydrated) {
      if (!softDone) hydratePage(false);
      else if (!autoRetriedAtBottom) { autoRetriedAtBottom = true; softDone = false; hydratePage(false); }
    }
    // Genuine end: pinned, nothing loading, feed exhausted (hard end or our soft retry came up empty).
    if (remaining <= AUTO_PIN && !sweeping && (fullyHydrated || (softDone && autoRetriedAtBottom))) {
      stopAutoScroll(); return;
    }
    autoRaf = requestAnimationFrame(autoStep);
  }

  function startAutoScroll() {
    if (!active || autoScroll) return;
    closeLightbox();
    autoScroll = true; autoPrevTs = 0; autoFrac = 0; autoRetriedAtBottom = false;
    updateAutoBtn();
    autoRaf = requestAnimationFrame(autoStep);
  }
  function stopAutoScroll() {
    if (!autoScroll && !autoRaf) return;
    autoScroll = false;
    if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = 0; }
    autoPrevTs = 0; autoFrac = 0; autoRetriedAtBottom = false;
    updateAutoBtn();
  }
  function toggleAutoScroll() { autoScroll ? stopAutoScroll() : startAutoScroll(); }

  function updateAutoBtn() {
    const btn = wrap && wrap.querySelector('.autoscroll');
    if (!btn) return;
    btn.classList.toggle('on', autoScroll);
    btn.setAttribute('aria-pressed', autoScroll ? 'true' : 'false');
    btn.querySelector('.icon').innerHTML = autoScroll ? PAUSE_ICON : PLAY_ICON;
    btn.querySelector('.lbl').textContent = autoScroll ? OBR.t('galleryAutoScrollStop') : OBR.t('galleryAutoScroll');
    btn.title = autoScroll ? OBR.t('galleryAutoScrollStopTitle') : OBR.t('galleryAutoScrollTitle');
  }

  OBR._galleryAutoScroll = (on) => { on ? startAutoScroll() : stopAutoScroll(); }; // drive (tests)
  OBR._galleryAutoScrollOn = () => autoScroll;                                     // state (tests)

  /* -------------------------------------------------- lightbox */
  const STRIP_IDLE_MS = 2500;
  let stripTimer = 0;

  // Filmstrip thumbnails under the big image. Append-only by count (mirrors mergeNewImages)
  // so hydration growth never churns existing nodes or restarts their lazy-load.
  function buildFilmstrip() {
    if (!lbStrip) return;
    if (images.length <= 1) { lbStrip.replaceChildren(); lbStrip.style.display = 'none'; return; }
    lbStrip.style.display = 'flex';
    for (let idx = lbStrip.childElementCount; idx < images.length; idx++) {
      const im = images[idx];
      const t = document.createElement('img');
      t.className = 'lb-thumb';
      t.loading = 'lazy';            // off-screen thumbs stay undecoded
      t.src = im.url;                // same small URL the grid tile already cached -> no new request
      t.alt = OBR.t('galleryThumbnailAlt', [String(idx + 1)]);
      t.dataset.idx = idx;
      t.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(idx); });
      lbStrip.appendChild(t);
    }
    while (lbStrip.childElementCount > images.length) lbStrip.lastElementChild.remove();
  }
  function syncFilmstripActive(i) {
    if (!lbStrip || lbStrip.style.display === 'none') return;
    const thumbs = lbStrip.children;
    for (let k = 0; k < thumbs.length; k++) thumbs[k].classList.toggle('is-active', k === i);
    const el = thumbs[i];
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  function revealChrome() {          // show the filmstrip + top controls, then fade both after idle
    if (lightboxIndex < 0) return;
    if (lbStrip) lbStrip.classList.remove('is-hidden');
    if (lbControls) lbControls.classList.remove('is-hidden');
    clearTimeout(stripTimer);
    stripTimer = setTimeout(() => {
      if (lbStrip) lbStrip.classList.add('is-hidden');
      if (lbControls) lbControls.classList.add('is-hidden');
    }, STRIP_IDLE_MS);
  }
  function pinChrome() { clearTimeout(stripTimer); } // keep visible while the pointer is over a control

  /* ---- slideshow: auto-advance the big image, play once, stop at the end ---- */
  function slideDwellMs() { return Math.max(1, Math.min(30, settings.gallerySlideSeconds || 3)) * 1000; }
  function advanceSlide() {
    if (slideOn && lightboxIndex >= 0 && lightboxIndex < images.length - 1) openLightbox(lightboxIndex + 1, true);
  }
  function scheduleSlide() {
    clearTimeout(slideTimer); slideTimer = 0;
    if (!slideOn || lightboxIndex < 0) return;
    if (lightboxIndex >= images.length - 1) { stopSlideshow(); return; } // reached the end -> auto-pause
    slideStartTs = Date.now();
    slideTimer = setTimeout(advanceSlide, slideDwellMs());
  }
  // Speed changed mid-play: re-aim the CURRENT image's timer at the new dwell measured from when
  // the image started — so +/- responds now without resetting the clock (repeated taps can't stall
  // it). A reduction below the elapsed time advances right away.
  function applySlideSecsLive() {
    if (!slideOn || lightboxIndex < 0 || lightboxIndex >= images.length - 1) return;
    clearTimeout(slideTimer);
    const remaining = Math.max(0, slideDwellMs() - (Date.now() - slideStartTs));
    slideTimer = setTimeout(advanceSlide, remaining);
  }
  function startSlideshow() {
    if (lightboxIndex < 0 || slideOn) return;
    if (lightboxIndex >= images.length - 1) return; // nothing to advance to from the last image
    slideOn = true;
    updatePlayBtn();
    scheduleSlide();
  }
  function stopSlideshow() {
    if (!slideOn && !slideTimer) return;
    slideOn = false;
    clearTimeout(slideTimer); slideTimer = 0;
    updatePlayBtn();
  }
  function toggleSlideshow() { slideOn ? stopSlideshow() : startSlideshow(); }
  function updatePlayBtn() {
    const btn = wrap && wrap.querySelector('.lb-play');
    if (!btn) return;
    btn.classList.toggle('on', slideOn);
    btn.setAttribute('aria-pressed', slideOn ? 'true' : 'false');
    btn.innerHTML = slideOn ? PAUSE_ICON : PLAY_ICON;
    btn.title = slideOn ? OBR.t('gallerySlideshowPauseTitle') : OBR.t('gallerySlideshowStartTitle');
  }
  OBR._gallerySlideshow = (on) => { on ? startSlideshow() : stopSlideshow(); }; // drive (tests)
  OBR._gallerySlideshowOn = () => slideOn;                                      // state (tests)

  /* ---- fit-width: read a tall page at full width (scrolls) vs shrink the page to fit ---- */
  function applyLightboxFit() {
    if (lbEl) lbEl.classList.toggle('lb-fit', fitWidth);
    updateFitBtn();
  }
  function updateFitBtn() {
    const btn = wrap && wrap.querySelector('.lb-fit-btn');
    if (!btn) return;
    btn.classList.toggle('on', fitWidth);
    btn.setAttribute('aria-pressed', fitWidth ? 'true' : 'false');
    btn.title = fitWidth ? OBR.t('galleryLightboxFitPageTitle') : OBR.t('galleryLightboxFitWidthTitle');
  }
  function toggleFit() {
    fitWidth = !fitWidth;
    settings.galleryFitWidth = fitWidth;
    applyLightboxFit();
    if (lbEl) lbEl.scrollTop = 0; // start a freshly-fit page at the top
    OBR.saveSettings({ galleryFitWidth: fitWidth });
  }
  OBR._galleryFitWidth = (on) => { fitWidth = !!on; settings.galleryFitWidth = fitWidth; applyLightboxFit(); OBR.saveSettings({ galleryFitWidth: fitWidth }); }; // drive (tests)
  OBR._galleryFitWidthOn = () => fitWidth; // state (tests)

  function openLightbox(i, fromAuto) {
    stopAutoScroll(); // opening the lightbox is a manual interaction
    lightboxIndex = i;
    if (fitWidth && lbEl) lbEl.scrollTop = 0; // each page starts at the top in fit-width reading
    lbImg.src = images[i].full || images[i].url;
    lbImg.alt = OBR.t('galleryImageAlt', [String(i + 1)]);
    lbCounter.textContent = OBR.t('galleryLightboxCounter', [String(i + 1), String(images.length)]);
    lbEl.classList.add('open');
    const multi = images.length > 1;                          // a slideshow needs >1 image
    const play = wrap.querySelector('.lb-play');
    const secs = wrap.querySelector('.lb-secs');
    if (play) play.style.display = multi ? '' : 'none';
    if (secs) secs.style.display = multi ? '' : 'none';
    buildFilmstrip();
    syncFilmstripActive(i);
    if (!fromAuto) revealChrome(); // don't pop the controls/filmstrip up on every auto-advance
    if (slideOn) scheduleSlide();  // (re)arm the dwell after any navigation while playing
  }
  function closeLightbox() {
    const lastIdx = lightboxIndex; // remember where paging through the big view left off
    lbEl.classList.remove('open');
    lightboxIndex = -1;
    clearTimeout(stripTimer);
    stopSlideshow();
    scrollGridToIndex(lastIdx); // carry that position back so the just-viewed image is on screen
  }
  function step(dir) {
    if (lightboxIndex < 0 || !images.length) return;
    lightboxIndex = (lightboxIndex + dir + images.length) % images.length;
    openLightbox(lightboxIndex);
  }

  /* -------------------------------------------------- open / close */
  // opts.trigger === 'auto': opened by the auto-open sentinel (no gesture) — show the
  // transient "Auto-opened" chip with its escape hatch.
  async function open(opts) {
    if (active) return;
    const trigger = opts && opts.trigger;
    settings = await OBR.loadSettings();
    // Per-site layout memory: a host reopens in the layout (+ column count) you left it in. Wall
    // is the default; a site only opens Ordered if it was remembered that way.
    galleryHost = OBR.normalizeHost ? OBR.normalizeHost(location.href) : '';
    let pref = null;
    try { pref = OBR.loadGalleryPref ? await OBR.loadGalleryPref(galleryHost) : null; } catch (e) { pref = null; }
    ordered = pref ? !!pref.ordered : false;
    if (pref && typeof pref.cols === 'number') settings[ordered ? 'galleryOrderedCols' : 'galleryColumns'] = pref.cols;
    fitWidth = !!settings.galleryFitWidth;
    // Per-site image filter (hidden patterns). Fresh filter state each open.
    revealHidden = false; lastHide = null;
    try { hiddenPatterns = OBR.loadHidden ? await OBR.loadHidden(galleryHost) : []; } catch (e) { hiddenPatterns = []; }
    if (OBR.close) OBR.close({ suppress: false }); // ensure the text reader isn't also showing (defensive — not a user dismissal)
    build();
    applyStylesheet();
    updateLayoutToggle();  // reflect the resolved layout on the Wall/Ordered switch
    applyLightboxFit();    // reflect the persisted lightbox fit-width preference
    if (autoSpeedEl) autoSpeedEl.value = settings.galleryAutoScrollSpeed || 60; // reflect the persisted speed
    if (lbSecsEl) lbSecsEl.value = settings.gallerySlideSeconds || 3;           // reflect the persisted slideshow secs
    savedPageX = window.scrollX; savedPageY = window.scrollY; // restored on close
    sweepY = 0; fullyHydrated = false; softDone = false; // fresh hydration cursor per open
    autoScroll = false; autoFrac = 0; autoRetriedAtBottom = false; // fresh auto-scroll state
    slideOn = false; clearTimeout(slideTimer); slideTimer = 0; // fresh slideshow state
    host.style.display = '';
    document.documentElement.style.overflow = 'hidden';
    active = true;
    render();
    startWatching(); // pick up late/lazy/inserted images without user action
    maybePreload();  // if the grid is shorter than the viewport, pull one chunk now
    if (trigger === 'auto' && OBR._showAutoChip) OBR._showAutoChip('opened');
  }
  // Records a USER-initiated dismissal into the shared auto-open suppression set —
  // internal close paths (mode switch, the reader's defensive cross-close) pass
  // { suppress: false }. Mirrors reader.js close(); see there for the why.
  function close(opts) {
    if (!active) return;
    if (!(opts && opts.suppress === false) && OBR._autoSuppress) OBR._autoSuppress();
    stopAutoScroll(); // cancel the rAF before hiding the host (no orphan scrollTop writes)
    speedSetting.flush();     // persist a just-edited speed before a reopen reads storage
    slideSecsSetting.flush(); // persist a just-edited slideshow dwell too
    flushSize();              // persist a just-dragged size (column count) too
    stopWatching();
    closeLightbox();
    host.style.display = 'none';
    document.documentElement.style.overflow = '';
    window.scrollTo(savedPageX, savedPageY); // page may have been scrolled to hydrate
    active = false;
  }
  function toggle() { active ? close() : open(); }

  OBR.openGallery = open;
  OBR.closeGallery = close;
  OBR.toggleGallery = toggle;

  // Toolbar-icon auto-mode (background.js calls this on action click). If a mode is
  // already open, just close it (predictable toggle-off). Otherwise auto-pick by a
  // two-signal rule: open the gallery only when the page is image-heavy
  // (>= autoGalleryMin images) AND NOT a substantial article — i.e. fewer than
  // autoTextMinWords words of real prose (OBR._articleWordCount, live-DOM, not
  // Readability). A real article always wins (you came
  // to read), so a figure-rich long read opens in the reader, not the gallery. Image
  // count alone is unreliable; the text signal is what disambiguates a photo board
  // from an illustrated essay. The keyboard commands bypass this entirely.
  // Returns a Promise<'closed-text'|'closed-images'|'images'|'text'> for tests.
  OBR._autoToggle = function () {
    const shown = (id) => {
      const h = document.getElementById(id);
      return !!h && getComputedStyle(h).display !== 'none';
    };
    if (shown('obr-host')) { if (OBR.close) OBR.close(); return Promise.resolve('closed-text'); }
    if (shown('obr-gallery-host')) { close(); return Promise.resolve('closed-images'); }
    const load = OBR.loadSettings ? OBR.loadSettings() : Promise.resolve(OBR.DEFAULTS);
    return load.then((s) => {
      // Sync the module-local settings (imageCount()'s avatar filter reads them) so a
      // pre-open auto-mode decision honors the user's galleryHideAvatars, not DEFAULTS.
      if (s) settings = Object.assign({}, settings, s);
      // Per-site rule wins over the auto-pick ladder (toolbar icon only; keyboard commands
      // and context-menu submodes bypass _autoToggle entirely). Most-specific rule wins.
      const override = OBR.matchSiteRule ? OBR.matchSiteRule(location.href, s && s.siteRules) : null;
      if (override === 'images' || override === 'text') {
        try { console.info(`[OpenBookReader] auto-mode → ${override}: per-site rule matched ${location.host}${location.pathname}`); } catch (e) { /* */ }
        if (override === 'images') { open(); return 'images'; }
        if (OBR.open) OBR.open();
        return 'text';
      }
      const min = (s && s.autoGalleryMin) || 0;
      const minWords = (s && s.autoTextMinWords) || 0;
      let n = 0;
      try { n = imageCount(); } catch (e) { n = 0; }
      // Only scan the page's prose when image count alone would send us to the gallery.
      let words = -1; // -1 = not computed; else = words in substantial prose paragraphs
      let mode, reason;
      if (min <= 0) {
        mode = 'text'; reason = 'auto-gallery off (autoGalleryMin=0)';
      } else if (n < min) {
        mode = 'text'; reason = `only ${n} image(s), below autoGalleryMin ${min}`;
      } else if (minWords > 0 && OBR._articleWordCount && (words = safeWordCount()) >= minWords) {
        mode = 'text'; reason = `${words} words of real prose (>= autoTextMinWords ${minWords}) — article wins`;
      } else {
        mode = 'images';
        reason = minWords > 0
          ? `${n} images and only ${words} words of prose (< autoTextMinWords ${minWords})`
          : `${n} images (>= ${min}); prose check off (autoTextMinWords=0)`;
      }
      // Why this mode was picked — open the page's DevTools console to see it.
      try {
        console.info(`[OpenBookReader] auto-mode → ${mode}: ${reason}  ` +
          `{images:${n}, proseWords:${words < 0 ? 'n/a' : words}, autoGalleryMin:${min}, autoTextMinWords:${minWords}}`);
      } catch (e) { /* console may be unavailable */ }
      if (mode === 'images') { open(); return 'images'; }
      if (OBR.open) OBR.open();
      return 'text';
    });
  };
  function safeWordCount() {
    try { return OBR._articleWordCount ? OBR._articleWordCount() : 0; } catch (e) { return 0; }
  }

  /* -------------------------------------------------- keyboard */
  // True when a form control inside the gallery holds focus — then leave scroll/space keys
  // to it (e.g. the column-width slider's PageUp/Down, the select-all checkbox's Space).
  function isFormFocused() {
    const a = root && root.activeElement;
    return !!a && /^(input|select|textarea|button)$/i.test(a.tagName);
  }

  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (hideMenuOpen()) { // the Hide popover owns keys while it's up
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHideMenu(); }
      return;
    }
    if (lightboxIndex >= 0) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
      else if (isFormFocused()) { /* editing the seconds field — leave caret/typing keys to it */ }
      else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
      // F toggles fit-width reading (fill the width + scroll a tall page vs shrink-to-fit).
      else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); toggleFit(); }
      // A toggles the slideshow; +/- nudge its per-image dwell (guard ctrl/meta so browser zoom still works).
      else if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); toggleSlideshow(); }
      else if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); slideSecsSetting.nudge(+1); }
      else if ((e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); slideSecsSetting.nudge(-1); }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); close();
    } else if (scrollerEl && (e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Auto-scroll toggle + speed nudge work regardless of focus — the gallery's only form
      // controls (size slider, select-all checkbox) don't use a / + / -, so there's no clash.
      e.preventDefault(); e.stopPropagation(); toggleAutoScroll();
    } else if (scrollerEl && (e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); speedSetting.nudge(+20); // guard ctrl/meta so browser zoom still works
    } else if (scrollerEl && (e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); speedSetting.nudge(-20);
    } else if (scrollerEl && !isFormFocused()) {
      // The overlay scroll-locks the page and the grid scrolls inside its own (unfocused)
      // container, so PageUp/Down/Home/End/space/arrows have no native target — drive it.
      const pg = Math.max(40, scrollerEl.clientHeight * 0.9);
      let top = null;
      if (e.key === 'PageDown') top = scrollerEl.scrollTop + pg;
      else if (e.key === 'PageUp') top = scrollerEl.scrollTop - pg;
      else if (e.key === ' ') top = scrollerEl.scrollTop + (e.shiftKey ? -pg : pg);
      else if (e.key === 'ArrowDown') top = scrollerEl.scrollTop + 80;
      else if (e.key === 'ArrowUp') top = scrollerEl.scrollTop - 80;
      else if (e.key === 'Home') top = 0;
      else if (e.key === 'End') top = scrollerEl.scrollHeight;
      if (top !== null) {
        e.preventDefault(); e.stopPropagation();
        stopAutoScroll(); // any manual scroll cancels hands-free auto-scroll
        const goingDown = top > scrollerEl.scrollTop;
        scrollerEl.scrollTop = top;
        // An explicit page/space/End toward the bottom is a clear "give me more" —
        // override the soft-stop (which otherwise pauses auto-load and leaves the user
        // stuck mid-feed) and pull the next chunk directly.
        if (goingDown) maybeHydrateOnDown();
      }
    }
  }, true);
})();
