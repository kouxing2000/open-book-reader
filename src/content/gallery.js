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
  let host, root, wrap, gridEl, scrollerEl, countEl, rangeEl, lbEl, lbImg, lbCounter;
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
    .lb img { max-width: 92vw; max-height: 88vh; object-fit: contain; border-radius: 6px;
      box-shadow: 0 12px 60px rgba(0,0,0,.6); }
    .lb-nav { position: absolute; top: 0; bottom: 0; width: 16vw; display: flex; align-items: center;
      cursor: pointer; color: #fff; font-size: 40px; opacity: .4; user-select: none; }
    .lb-nav:hover { opacity: 1; }
    .lb-prev { left: 0; justify-content: flex-start; padding-left: 20px; }
    .lb-next { right: 0; justify-content: flex-end; padding-right: 20px; }
    .lb-counter { position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,.5); padding: 6px 14px; border-radius: 20px; font-size: 13px; }
    .lb-close { position: absolute; top: 10px; right: 16px; font-size: 34px; line-height: 1;
      cursor: pointer; color: #fff; opacity: .75; width: 44px; height: 44px; display: flex;
      align-items: center; justify-content: center; z-index: 5; }
    .lb-close:hover { opacity: 1; }
    .lb-dl { position: absolute; top: 16px; right: 70px; width: 40px; height: 40px; z-index: 4;
      cursor: pointer; color: #fff; background: rgba(20,20,24,.7); border: none; border-radius: 10px;
      opacity: .85; display: flex; align-items: center; justify-content: center; }
    .lb-dl:hover { opacity: 1; background: #7c6cff; }
    .lb-dl svg { width: 20px; height: 20px; }
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
        <span class="lb-counter"></span>
        <div class="lb-nav lb-prev">&#8249;</div>
        <img class="lb-img" alt="">
        <div class="lb-nav lb-next">&#8250;</div>
      </div>`;
    root.appendChild(wrap);

    gridEl = wrap.querySelector('.grid');
    scrollerEl = wrap.querySelector('.scroll');
    countEl = wrap.querySelector('.count');
    rangeEl = wrap.querySelector('.range');
    lbEl = wrap.querySelector('.lb');
    lbImg = wrap.querySelector('.lb-img');
    lbCounter = wrap.querySelector('.lb-counter');

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
    lbEl.addEventListener('click', (e) => { if (e.target !== lbImg) closeLightbox(); });

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
    scrollerEl.addEventListener('scroll', onScrollerScroll, { passive: true });
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
    if (added) { countEl.textContent = images.length + ' images'; updateSelUI(); softDone = false; }
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

  /* -------------------------------------------------- lightbox */
  function openLightbox(i) {
    lightboxIndex = i;
    lbImg.src = images[i].full || images[i].url;
    lbImg.alt = 'Image ' + (i + 1);
    lbCounter.textContent = (i + 1) + ' / ' + images.length;
    lbEl.classList.add('open');
  }
  function closeLightbox() {
    lbEl.classList.remove('open');
    lightboxIndex = -1;
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
    savedPageX = window.scrollX; savedPageY = window.scrollY; // restored on close
    sweepY = 0; fullyHydrated = false; softDone = false; // fresh hydration cursor per open
    host.style.display = '';
    document.documentElement.style.overflow = 'hidden';
    active = true;
    render();
    startWatching(); // pick up late/lazy/inserted images without user action
    maybePreload();  // if the grid is shorter than the viewport, pull one chunk now
  }
  function close() {
    if (!active) return;
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
      else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); close();
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
