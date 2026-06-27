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
  // Mode-switch glyphs (shared shape with reader.js): open book + framed picture.
  const ICON_BOOK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2H2z"/><path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2H22z"/></svg>';
  const ICON_IMAGES =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>';
  const RESCAN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  // Hands-free auto-scroll toggle glyphs (filled play / pause).
  const PLAY_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15l12-7.5z"/></svg>';
  const PAUSE_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

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
  const selected = new Set(); // selected image URLs (survives re-render)
  let autoScroll = false;          // hands-free auto-scroll engaged
  let autoRaf = 0;                 // requestAnimationFrame handle (0 = idle)
  let autoPrevTs = 0;              // prev frame timestamp (ms); 0 = first frame, seed only
  let autoFrac = 0;                // sub-pixel accumulator (scrollTop applies integer deltas)
  let autoRetriedAtBottom = false; // one-shot: already pushed past a soft-stop at this bottom
  let autoSpeedSaveTimer = null;   // debounces persisting the speed (key-repeat / typing)
  let slideOn = false;             // lightbox slideshow engaged (auto-advance images)
  let slideTimer = 0;              // per-image dwell timeout handle (0 = idle)
  let slideStartTs = 0;            // when the current image's dwell began (ms) — for elapsed-aware re-aim
  let slideSecsSaveTimer = null;   // debounces persisting the slideshow seconds

  const MIN = () => settings.galleryMinSize || 80;

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

  function eachGalleryImg(fn) {
    document.querySelectorAll('img').forEach((img) => {
      const e = galleryImgEntry(img);
      if (e) fn(e);
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

  function collect() {
    const seen = new Set();
    const out = [];
    const min = MIN();

    const push = (rawUrl, w, h, fullRaw) => {
      if (!rawUrl || isSkippableDataUri(rawUrl)) return;
      const url = resolveUrl(rawUrl, location.href);
      if (!url || seen.has(url)) return;
      seen.add(url);
      const full = (fullRaw && resolveUrl(fullRaw, location.href)) || url;
      out.push({ url, full, w: w || 0, h: h || 0 });
    };

    eachGalleryImg((e) => push(e.url, e.w, e.h, e.full));
    eachPictureSource(push); // <picture> fallback sources: full === url

    // CSS background-image
    document.querySelectorAll('*').forEach((el) => {
      const urls = parseBackgroundImageUrls(getComputedStyle(el).backgroundImage);
      if (!urls.length) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < min || rect.height < min) return;
      urls.forEach((u) => push(u, rect.width, rect.height));
    });

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
    eachGalleryImg((e) => tally(e.url));
    eachPictureSource(tally);
    return n;
  }
  OBR._imageCount = imageCount;

  /* -------------------------------------------------- styles */
  function css() {
    const colW = settings.galleryColWidth || 240;
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
    .scroll { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 12px; }
    /* JS masonry: a flex row of equal columns; each new tile is APPENDED to the
       shortest column so already-placed tiles never move (CSS multi-column would
       re-balance and shuffle existing images on every append). */
    .grid { display: flex; align-items: flex-start; gap: 12px; }
    .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
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
    .empty { padding: 60px 0; text-align: center; color: #9a9aa2; width: 100%; }
    .lb { position: fixed; inset: 0; z-index: 2147483647; background: rgba(8,8,10,.94);
      display: none; align-items: center; justify-content: center; }
    .lb.open { display: flex; }
    .lb-img { max-width: 92vw; max-height: 88vh; object-fit: contain; border-radius: 6px;
      box-shadow: 0 12px 60px rgba(0,0,0,.6); }
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
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css());
    root.adoptedStyleSheets = [sheet];
  }

  /* -------------------------------------------------- build */
  function build() {
    if (built) return;
    host = document.createElement('div');
    host.id = 'obr-gallery-host';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });

    wrap = document.createElement('div');
    wrap.className = 'wrap';
    const colW = settings.galleryColWidth || 240;
    wrap.innerHTML = `
      <div class="bar">
        <span class="title">🖼 Images</span>
        <span class="count"></span>
        <span class="sep"></span>
        <label class="selall"><input type="checkbox" class="selall-cb"> Select all</label>
        <span class="selcount">0 selected</span>
        <button class="btn dl-sel" disabled>${DL_ICON}<span>Download</span></button>
        <button class="btn dl-zip" disabled>${DL_ICON}<span>ZIP</span></button>
        <button class="btn rescan" title="Load every image — scroll the whole page to the bottom to pull in all lazy images">${RESCAN_ICON}<span>Load all</span></button>
        <button class="btn autoscroll" aria-pressed="false" title="Auto-scroll down through the gallery (A)"><span class="icon">${PLAY_ICON}</span><span class="lbl">Auto-scroll</span></button>
        <label class="autospeed" title="Auto-scroll speed in pixels/second — type a value, use the arrows, or press + / -"><input type="number" class="autospeed-in" min="20" max="400" step="10" aria-label="Auto-scroll speed (px/sec)"> px/s</label>
        <span class="status"></span>
        <span class="spacer"></span>
        <label>Size <input type="range" class="range" min="140" max="420" step="20" value="${colW}"></label>
        <span class="seg" role="group" aria-label="Reading mode">
          <button class="seg-btn switch" data-act="text" title="Switch to text reader">${ICON_BOOK}<span>Text</span></button>
          <button class="seg-btn is-active" data-act="images" aria-current="true" title="You are in image gallery">${ICON_IMAGES}<span>Images</span></button>
        </span>
        <button class="btn report" data-act="report" title="Report a problem on this page (opens an email)">⚠ Report</button>
        <button class="btn settings" data-act="settings" title="Open settings">⚙ Settings</button>
        <button class="btn close" data-act="close">Close (Esc)</button>
      </div>
      <div class="scroll"><div class="grid"></div></div>
      <div class="lb">
        <span class="lb-close">&times;</span>
        <button class="lb-dl" title="Download this image">${DL_ICON}</button>
        <div class="lb-slideshow">
          <button class="lb-play" aria-pressed="false" title="Start slideshow (A)">${PLAY_ICON}</button>
          <label class="lb-secs" title="Seconds per image — type a value, use the arrows, or press + / -"><input type="number" class="lb-secs-in" min="1" max="30" step="1" aria-label="Slideshow seconds per image"> s</label>
          <span class="lb-counter"></span>
        </div>
        <div class="lb-nav lb-prev">&#8249;</div>
        <img class="lb-img" alt="">
        <div class="lb-nav lb-next">&#8250;</div>
        <div class="lb-strip is-hidden" aria-label="Thumbnails"></div>
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

    wrap.querySelector('.close').addEventListener('click', close);
    wrap.querySelector('.settings').addEventListener('click', () => { if (OBR.openOptions) OBR.openOptions(); });
    wrap.querySelector('.report').addEventListener('click', () => {
      if (OBR.reportBroken) OBR.reportBroken({
        source: 'gallery-toolbar', mode: 'images',
        imageCount: OBR._imageCount ? OBR._imageCount() : undefined,
      });
    });
    wrap.querySelector('.switch').addEventListener('click', () => {
      close();
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
    // Slideshow seconds: live while typing (scheduleSlide re-reads it), clamp + persist on change.
    lbSecsEl.addEventListener('input', () => {
      const v = parseInt(lbSecsEl.value, 10);
      if (Number.isFinite(v)) { settings.gallerySlideSeconds = Math.max(1, Math.min(30, v)); applySlideSecsLive(); }
    });
    lbSecsEl.addEventListener('change', () => setSlideSecs(parseInt(lbSecsEl.value, 10)));

    rangeEl.addEventListener('input', () => {
      const v = parseInt(rangeEl.value, 10);
      settings.galleryColWidth = v;
      OBR.saveSettings({ galleryColWidth: v });
      // Only re-lay-out when the column COUNT changes (flex columns auto-resize width).
      // Keep the user where they were reading — a rebuild otherwise snaps to the top.
      if (active && columnCount() !== cols.length) layoutAll(true);
    });
    // Drop focus after the user finishes dragging the slider, so Page/Home/End/space
    // drive the gallery scroll again instead of nudging the slider value.
    rangeEl.addEventListener('pointerup', () => rangeEl.blur());

    wrap.querySelector('.rescan').addEventListener('click', () => hydratePage(true));
    wrap.querySelector('.autoscroll').addEventListener('click', (e) => {
      toggleAutoScroll();
      e.currentTarget.blur(); // drop focus so Space / PageDown still drive the scroll
    });
    // Typing in the speed field applies live (autoStep reads settings each frame); persist
    // on change (blur / Enter / spinner) so a multi-keystroke entry isn't saved per keystroke.
    autoSpeedEl.addEventListener('input', () => {
      const v = parseInt(autoSpeedEl.value, 10);
      if (Number.isFinite(v)) settings.galleryAutoScrollSpeed = Math.max(20, Math.min(400, v));
    });
    autoSpeedEl.addEventListener('change', () => setAutoSpeed(parseInt(autoSpeedEl.value, 10)));
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
        if (active && built && images.length && columnCount() !== cols.length) layoutAll(true);
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
    wrap.querySelector('.selcount').textContent = n + ' selected';
    const selBtn = wrap.querySelector('.dl-sel');
    const zipBtn = wrap.querySelector('.dl-zip');
    selBtn.disabled = busy || n === 0;
    zipBtn.disabled = busy || n === 0;
    selBtn.querySelector('span').textContent = n ? `Download (${n})` : 'Download';
    zipBtn.querySelector('span').textContent = n ? `ZIP (${n})` : 'ZIP';
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
      if (resp && resp.denied) setStatus('Downloads permission needed');
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
    setStatus(asZip ? 'Zipping…' : 'Downloading…');
    try {
      if (!asZip) {
        // Use each image's real index (not its position in the selected subset) so
        // fallback filenames (image-NNN) stay stable and meaningful. One permission
        // prompt covers the whole batch (later requests queue behind the first).
        const sent = await Promise.all(items.map((im) => downloadOne(im.full || im.url, images.indexOf(im))));
        const ok = sent.filter((r) => r && r.ok).length;
        setStatus(ok ? `Sent ${ok}` : 'Downloads permission needed');
      } else {
        // SW fetches bytes (cross-origin host permission bypasses CORS), returns base64.
        const resp = await sendSW({ type: 'obr-fetch-bytes', urls });
        if (resp && resp.denied) { setStatus('Image-fetch permission needed'); return; }
        const results = (resp && resp.results) || [];
        const ok = results.filter((r) => r && r.ok && r.b64);
        if (!ok.length) {
          setStatus('Download failed');
        } else {
          const names = uniquifyNames(ok.map((r, k) => filenameFromUrl(r.url, k)));
          const files = ok.map((r, k) => ({ name: names[k], bytes: b64ToBytes(r.b64) }));
          const zip = OBR._buildZip(files);
          saveBlob(new Blob([zip], { type: 'application/zip' }), 'images.zip');
          const failed = urls.length - ok.length;
          setStatus(failed ? `Done — ${ok.length} saved, ${failed} failed` : `Done — ${ok.length} saved`);
        }
      }
    } catch (e) {
      setStatus('Download failed');
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
    img.addEventListener('error', () => { selected.delete(im.url); tile.remove(); updateSelUI(); });
    tile.appendChild(img);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tile-ctl check';
    cb.checked = selected.has(im.url);
    cb.title = 'Select';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => setSelected(im.url, e.target.checked, tile));
    tile.appendChild(cb);

    const dl = document.createElement('button');
    dl.className = 'tile-ctl tile-dl';
    dl.title = 'Download';
    dl.innerHTML = DL_ICON;
    dl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); downloadOne(im.full || im.url, i); });
    tile.appendChild(dl);
    return tile;
  }

  function renderEmpty() {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No images found yet. Scroll the gallery to load more, or use ⟳ Load all.';
    gridEl.appendChild(e);
  }

  /* ---- JS masonry: columns we append into, never re-flowing placed tiles ---- */
  function columnCount() {
    const colW = settings.galleryColWidth || 240;
    const inner = (scrollerEl ? scrollerEl.clientWidth : 0) - 24; // .scroll padding
    return Math.max(1, Math.floor((inner + 12) / (colW + 12)));
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
  // Lay every known image into fresh columns (initial render, resize, column-width change).
  // `keepScroll` anchors the topmost visible tile so a rebuild doesn't snap to the top.
  function layoutAll(keepScroll) {
    let anchorIdx = -1, viewOffset = 0;
    if (keepScroll && scrollerEl && images.length) {
      const st = scrollerEl.scrollTop;
      let best = Infinity;
      gridEl.querySelectorAll('.tile').forEach((t) => {
        const d = Math.abs(tileTop(t) - st);
        if (d < best) { best = d; anchorIdx = +t.dataset.idx; viewOffset = tileTop(t) - st; }
      });
    }
    if (!images.length) { gridEl.innerHTML = ''; cols = []; colHeights = []; renderEmpty(); return; }
    buildColumns();
    images.forEach((im, i) => placeTile(im, i));
    if (anchorIdx >= 0) {
      const t = gridEl.querySelector('.tile[data-idx="' + anchorIdx + '"]');
      if (t) scrollerEl.scrollTop = Math.max(0, tileTop(t) - viewOffset);
    }
  }

  function render() {
    images = collect();
    if (lbStrip && lightboxIndex < 0) lbStrip.replaceChildren(); // rebuild the strip fresh on next open
    if (scrollerEl) scrollerEl.scrollTop = 0;
    countEl.textContent = images.length + ' images';
    layoutAll();
    updateSelUI();
  }

  // Re-collect and APPEND any images not already shown (lazy/late/inserted) to the
  // shortest column, without disturbing existing tiles or the user's selection.
  function mergeNewImages() {
    if (!active || !built) return 0;
    const have = new Set(images.map((im) => im.url));
    let added = 0;
    collect().forEach((im) => {
      if (have.has(im.url)) return;
      have.add(im.url);
      if (!cols.length) buildColumns(); // was empty-state
      const i = images.length;
      images.push(im);
      placeTile(im, i);
      added++;
    });
    if (added) {
      countEl.textContent = images.length + ' images';
      updateSelUI();
      softDone = false;
      if (lightboxIndex >= 0) { // keep the open lightbox's filmstrip + counter in sync as images hydrate
        buildFilmstrip();
        syncFilmstripActive(lightboxIndex);
        lbCounter.textContent = (lightboxIndex + 1) + ' / ' + images.length;
      }
    }
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
    setStatus(toBottom ? 'Loading all…' : 'Loading more…');
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
    } catch (e) {
      /* ignore — partial hydration is fine */
    } finally {
      de.style.overflow = active ? 'hidden' : ''; // re-lock (gallery still open)
      sweeping = false;
      if (btn) btn.disabled = false;
      setStatus(added ? `+${added} images` : (fullyHydrated ? 'All images loaded' : ''));
      setTimeout(() => setStatus(''), 2500);
    }
    return added;
  }

  // Prefetch the next chunk EARLY — while the user is still ~1.5 screens from the
  // bottom of the gallery — so the new tiles are there before they scroll to them.
  function onScrollerScroll() {
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
    btn.querySelector('.lbl').textContent = autoScroll ? 'Stop' : 'Auto-scroll';
    btn.title = autoScroll ? 'Stop auto-scroll (A)' : 'Auto-scroll down through the gallery (A)';
  }

  // Single source of truth for the speed: clamp to [20,400], apply live (autoStep reads
  // settings each frame), persist to storage.sync so it survives a reopen / new session,
  // and reflect into the toolbar field. Drives the field, the +/- keys, and the options page.
  function setAutoSpeed(value) {
    const cur = settings.galleryAutoScrollSpeed || 60;
    const next = Math.max(20, Math.min(400, Number.isFinite(value) ? value : cur));
    if (autoSpeedEl) autoSpeedEl.value = next; // normalize the field (clamp / strip junk) even if unchanged
    if (next === cur) return;                  // no change → nothing to apply or persist
    settings.galleryAutoScrollSpeed = next;    // live — autoStep reads it next frame
    // Debounce the persist: key-repeat on +/- and field typing fire many calls, and
    // chrome.storage.sync throttles writes (~120/min). Only the trailing value needs saving.
    clearTimeout(autoSpeedSaveTimer);
    autoSpeedSaveTimer = setTimeout(() => OBR.saveSettings({ galleryAutoScrollSpeed: next }), 400);
  }
  // Flush a pending debounced speed persist immediately (e.g. on close, before a reopen
  // reads storage). No-op if nothing is pending.
  function flushAutoSpeed() {
    if (!autoSpeedSaveTimer) return;
    clearTimeout(autoSpeedSaveTimer); autoSpeedSaveTimer = null;
    OBR.saveSettings({ galleryAutoScrollSpeed: settings.galleryAutoScrollSpeed });
  }
  function nudgeAutoSpeed(delta) { setAutoSpeed((settings.galleryAutoScrollSpeed || 60) + delta); }

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
      t.alt = 'Thumbnail ' + (idx + 1);
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
    btn.title = slideOn ? 'Pause slideshow (A)' : 'Start slideshow (A)';
  }
  // Single source of truth for the slideshow dwell: clamp to [1,30]s, apply live to a running
  // slideshow, persist to storage.sync (debounced), and reflect into the lightbox field.
  function setSlideSecs(value) {
    const next = Math.max(1, Math.min(30, Number.isFinite(value) ? value : (settings.gallerySlideSeconds || 3)));
    if (lbSecsEl) lbSecsEl.value = next; // normalize the field (clamp / strip junk)
    settings.gallerySlideSeconds = next;
    applySlideSecsLive();                // re-aim a running slideshow's current dwell (no reset)
    // Always (re)schedule the persist — the live `input` handler already set
    // settings.gallerySlideSeconds, so a `next === cur` short-circuit here would silently drop
    // the save on the normal type/spinner edit path. Debounced, so same-value re-saves collapse.
    clearTimeout(slideSecsSaveTimer);
    slideSecsSaveTimer = setTimeout(() => OBR.saveSettings({ gallerySlideSeconds: next }), 400);
  }
  function flushSlideSecs() {
    if (!slideSecsSaveTimer) return;
    clearTimeout(slideSecsSaveTimer); slideSecsSaveTimer = null;
    OBR.saveSettings({ gallerySlideSeconds: settings.gallerySlideSeconds });
  }
  function nudgeSlideSecs(delta) { setSlideSecs((settings.gallerySlideSeconds || 3) + delta); }

  OBR._gallerySlideshow = (on) => { on ? startSlideshow() : stopSlideshow(); }; // drive (tests)
  OBR._gallerySlideshowOn = () => slideOn;                                      // state (tests)

  function openLightbox(i, fromAuto) {
    stopAutoScroll(); // opening the lightbox is a manual interaction
    lightboxIndex = i;
    lbImg.src = images[i].full || images[i].url;
    lbImg.alt = 'Image ' + (i + 1);
    lbCounter.textContent = (i + 1) + ' / ' + images.length;
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
    lbEl.classList.remove('open');
    lightboxIndex = -1;
    clearTimeout(stripTimer);
    stopSlideshow();
  }
  function step(dir) {
    if (lightboxIndex < 0 || !images.length) return;
    lightboxIndex = (lightboxIndex + dir + images.length) % images.length;
    openLightbox(lightboxIndex);
  }

  /* -------------------------------------------------- open / close */
  async function open() {
    if (active) return;
    settings = await OBR.loadSettings();
    if (OBR.close) OBR.close(); // ensure the text reader isn't also showing
    build();
    applyStylesheet();
    if (rangeEl) rangeEl.value = settings.galleryColWidth || 240;
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
  }
  function close() {
    if (!active) return;
    stopAutoScroll(); // cancel the rAF before hiding the host (no orphan scrollTop writes)
    flushAutoSpeed();  // persist a just-edited speed before a reopen reads storage
    flushSlideSecs();  // persist a just-edited slideshow dwell too
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
    if (lightboxIndex >= 0) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
      else if (isFormFocused()) { /* editing the seconds field — leave caret/typing keys to it */ }
      else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
      // A toggles the slideshow; +/- nudge its per-image dwell (guard ctrl/meta so browser zoom still works).
      else if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); toggleSlideshow(); }
      else if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); nudgeSlideSecs(+1); }
      else if ((e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); nudgeSlideSecs(-1); }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); close();
    } else if (scrollerEl && (e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Auto-scroll toggle + speed nudge work regardless of focus — the gallery's only form
      // controls (size slider, select-all checkbox) don't use a / + / -, so there's no clash.
      e.preventDefault(); e.stopPropagation(); toggleAutoScroll();
    } else if (scrollerEl && (e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); nudgeAutoSpeed(+20); // guard ctrl/meta so browser zoom still works
    } else if (scrollerEl && (e.key === '-' || e.key === '_') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); nudgeAutoSpeed(-20);
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
