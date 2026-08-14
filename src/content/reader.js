/* Open Book Reader — content engine
 * Injected on demand. Builds a Shadow-DOM two-page reader over the current page.
 * Exposes globalThis.OBR.open / close / toggle.
 */
(function () {
  const OBR = (globalThis.OBR = globalThis.OBR || {});
  if (OBR._engineLoaded) return;     // guard against double injection
  OBR._engineLoaded = true;

  const THEMES = ['paper', 'light', 'dark'];
  const FONT_STACKS = {
    serif: 'Georgia, "Songti SC", "STSong", "Noto Serif SC", serif',
    sans: '-apple-system, system-ui, "PingFang SC", "Noto Sans SC", sans-serif'
  };
  const FONT_MIN = 14, FONT_MAX = 26;

  // Mode-switch glyphs (open book + framed picture) — shared with gallery.js, defined once
  // on the OBR namespace in settings.js (loads first).
  const ICON_BOOK = OBR.ICONS.book;
  const ICON_IMAGES = OBR.ICONS.images;

  let settings = Object.assign({}, OBR.DEFAULTS);
  let host, root, overlay, pagesEl, viewportEl, indicatorEl, titleEl, paperEl, metaEl, progressFillEl, pickHintEl;
  // Element-picker mode (the ⌖ Pick override): a separate Shadow host so its highlight
  // box / instruction bar can't disturb the reader's styles, plus the live hover target.
  let pickerActive = false, pickHost = null, pickRoot = null, pickBox = null, pickLabel = null, pickHoverNode = null;
  let active = false, built = false;
  let chromeTimer = null, overControls = false;
  let currentSpread = 0, totalSpreads = 1, totalColumns = 1;
  let colW = 0, colGap = 0, pagesPerSpread = 2;
  let savedScrollY = 0;
  let mediaTimer = null;
  // While a 'book' or 'curl' page turn is animating: { layer, anims: [Animation...] }. The
  // real strip is already at its destination (see bookFlip/curlFlip), so this is purely the
  // transient overlay; endActiveFlip() tears it down at any moment (finish, relayout, close).
  let activeFlip = null;
  // Per-article resume: posKey identifies the article; restoreFraction holds the
  // saved progress fraction until the first relayout positions us there (it keeps
  // re-anchoring through the late-image settle window, then a user nav clears it).
  let posKey = '', restoreFraction = null, saveTimer = null;
  // The article Readability last parsed (held so Print can reuse it without re-parsing).
  let lastArticle = null;
  let printing = false; // re-entrancy guard for printReader (the native print dialog is modal)
  // Generation token for the async open(): a newer open() or a close() bumps it, so an
  // earlier in-flight open() aborts after its next await instead of double-initializing.
  let openGen = 0;
  // Where the current content came from, driving the ⌖ Pick hint banner:
  // 'whole' (whole page) | 'selection' (read a text selection) | 'pick-manual'
  // (just picked a block — offer to save) | 'pick-saved' (a saved per-site pick
  // auto-applied — offer full-page / clear). pickNode is the live element a pick
  // is reading from (so "Save for this site" can derive its selector).
  let contentSource = 'whole', pickNode = null;
  // Whether a WHOLE-page extraction looks wrong (failed, or kept far less text than the live
  // page's prose) — the only case the "Wrong content?" banner auto-pops for. Confident parses
  // stay quiet; the ⌖ Pick toolbar button remains the always-available affordance.
  let extractionSuspect = false;

  /* ----- back-cover colophon + reading-time state (see the colophon section) -----
   * readMs accumulates ACTIVE reading time this session: the clock pauses while the tab
   * is hidden and each silent gap is capped (READ_GAP_CAP) so a walked-away tab doesn't
   * inflate the count. priorMs/priorFin come from the article's saved position entry;
   * engageState/lifetimeStats load once per open (ask policy + lifetime line). Everything
   * stays in extension storage — no telemetry. contentColumns is the column count of the
   * article WITHOUT the colophon page (finish detection needs the last CONTENT spread). */
  let readMs = 0, lastTick = 0;
  let priorMs = 0, priorFin = false;
  let engageState = null, lifetimeStats = null;
  let colophonEl = null, articleWords = 0, contentColumns = 1;
  let finishedThisOpen = false, colSeenThisOpen = false;
  let openedByAuto = false;   // this session was sentinel-opened (tempers the ask moment)
  let flipSnapping = false;   // inside beginFlip's synchronous snap (see syncColophonView)
  const READ_GAP_CAP = 240000;        // ms of credit for one silent gap (no input events)
  const COLOPHON_MIN_WORDS = 300;     // short pieces get no colophon — the moment must be earned
  const COLOPHON_ASK_SEEN_MAX = 10;   // unacted ask impressions before the ask retires itself
  const LIFETIME_MIN_ARTICLES = 3;    // lifetime line appears from the 3rd finished article

  // The current usable text selection, or null. "Usable" = a non-collapsed
  // selection with enough text to be a deliberate choice (guards against a stray
  // click-drag selecting a word or two). Read straight off the live page.
  function currentSelection() {
    try {
      const s = globalThis.getSelection && getSelection();
      if (s && s.rangeCount && !s.isCollapsed && s.toString().trim().length >= 40) return s;
    } catch (e) { /* getSelection unavailable */ }
    return null;
  }

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Live OS color-scheme query, for the 'auto' theme. resolveTheme() maps the stored
  // preference to a concrete overlay class: 'auto' -> 'dark' when the OS is in dark mode,
  // else 'paper' (the signature light look — deliberately NOT stark-white 'light'); every
  // other value maps to itself. The change listener at the bottom of the file re-applies it
  // live while reading, so a scheduled OS dark-mode flip is honored mid-article.
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  function resolveTheme() {
    return settings.theme === 'auto' ? (systemDark.matches ? 'dark' : 'paper') : settings.theme;
  }

  /* ---------------------------------------------------------------- styles */
  // The stylesheet itself lives in reader.style.js (OBR._readerCSS) — a pure function of
  // these inputs — so this logic file stays focused. reader.style.js loads before reader.js.
  function applyStylesheet() {
    OBR.adoptStyles(root, OBR._readerCSS(settings, reduceMotion, FONT_STACKS));
  }

  /* ---------------------------------------------------------------- build */
  function build() {
    if (built) return;
    ({ host, root } = OBR.makeShadowHost('obr-host'));
    // Stay hidden until open() reveals it at the very end. open() can abort AFTER build()
    // but BEFORE active=true (the openGen guard, e.g. the gallery taking over mid-open);
    // since close()/Escape/✕ all bail on !active, a visible host left by such an abort would
    // be an unclosable overlay. Initializing hidden makes "visible ⟺ active" hold regardless.
    host.style.display = 'none';

    overlay = document.createElement('div');
    overlay.className = 'obr-overlay ' + resolveTheme();
    overlay.innerHTML = `
      <div class="obr-topbar">
        <!-- The mode switch (Text ⇄ Images) LEADS the bar — it's the highest-level control
             (which reading mode entirely), shared with the gallery, so it sits in the same
             prominent far-left slot in both overlays rather than buried among the tools. -->
        <span class="obr-seg" role="group" aria-label="${OBR.t('readerSegGroupLabel')}">
          <button class="obr-seg-btn is-active" data-act="text" aria-current="true" title="${OBR.t('readerSegTextTitle')}">${ICON_BOOK}<span>${OBR.t('readerSegTextLabel')}</span></button>
          <button class="obr-seg-btn" data-act="images" title="${OBR.t('readerSegImagesTitle')}">${ICON_IMAGES}<span>${OBR.t('readerSegImagesLabel')}</span><span class="obr-seg-badge" hidden></span></button>
        </span>
        <span class="obr-topdiv"></span>
        <span class="obr-doc-title"></span>
        <span class="obr-doc-meta"></span>
        <span class="obr-controls">
          <button class="obr-btn" data-act="font-" title="${OBR.t('readerBtnFontSmallerTitle')}">A−</button>
          <button class="obr-btn" data-act="font+" title="${OBR.t('readerBtnFontLargerTitle')}">A+</button>
          <button class="obr-btn" data-act="theme" title="${OBR.t('readerBtnThemeTitle')}">${OBR.t('readerBtnThemeLabel')}</button>
          <button class="obr-btn" data-act="columns" title="${OBR.t('readerBtnColumnsTitle')}">⊞ 2</button>
          <button class="obr-btn" data-act="pick" title="${OBR.t('readerBtnPickTitle')}">${OBR.t('readerBtnPickLabel')}</button>
          <button class="obr-btn" data-act="print" title="${OBR.t('readerBtnPrintTitle')}">${OBR.t('readerBtnPrintLabel')}</button>
          <button class="obr-btn" data-act="report" title="${OBR.t('readerBtnReportTitle')}">${OBR.t('readerBtnReportLabel')}</button>
          <button class="obr-btn" data-act="settings" title="${OBR.t('readerBtnSettingsTitle')}">${OBR.t('readerBtnSettingsLabel')}</button>
          <button class="obr-btn" data-act="close" title="${OBR.t('readerBtnCloseTitle')}">${OBR.t('readerBtnCloseLabel')}</button>
        </span>
      </div>
      <div class="obr-book">
        <div class="obr-paper">
          <div class="obr-viewport"><div class="obr-pages"></div></div>
          <div class="obr-spine"></div>
        </div>
      </div>
      <div class="obr-footer">
        <span class="obr-indicator"></span>
        <span class="obr-hint">${OBR.t('readerFooterHint')}</span>
      </div>
      <div class="obr-pick-hint"></div>
      <div class="obr-progress"><div class="obr-progress-fill"></div></div>`;
    root.appendChild(overlay);

    titleEl = overlay.querySelector('.obr-doc-title');
    metaEl = overlay.querySelector('.obr-doc-meta');
    viewportEl = overlay.querySelector('.obr-viewport');
    pagesEl = overlay.querySelector('.obr-pages');
    paperEl = overlay.querySelector('.obr-paper');
    indicatorEl = overlay.querySelector('.obr-indicator');
    progressFillEl = overlay.querySelector('.obr-progress-fill');
    pickHintEl = overlay.querySelector('.obr-pick-hint');

    // Click near the left/right edge turns the page. We listen on the content itself (NOT a
    // blocking overlay) so the page text stays fully selectable — a drag-select leaves a
    // non-collapsed selection, which suppresses the flip; a plain click in the edge band still
    // turns. Clicks on links/buttons/chrome are left to their own handlers.
    overlay.addEventListener('click', (e) => {
      if (!active || pickerActive) return;
      if (e.target.closest('a, button, input, label, .obr-topbar, .obr-footer, .obr-pick-hint')) return;
      // The content is in an open shadow root; window.getSelection() can't see selections inside
      // it, so use shadowRoot.getSelection() (Chrome) and fall back to the document selection.
      const sel = root.getSelection ? root.getSelection() : (globalThis.getSelection && getSelection());
      if (sel && !sel.isCollapsed && String(sel).trim()) return; // mid text-selection → don't flip
      const w = window.innerWidth;
      if (e.clientX < w * 0.28) flip(-1);
      else if (e.clientX > w * 0.72) flip(1);
    });
    overlay.querySelectorAll('.obr-btn, .obr-seg-btn').forEach((b) =>
      b.addEventListener('click', () => handleAction(b.dataset.act)));

    // Auto-hide the floating chrome: reveal on mouse move, hide when idle,
    // and never hide while the pointer is over the controls themselves.
    overlay.addEventListener('mousemove', showChrome);
    [overlay.querySelector('.obr-topbar'), overlay.querySelector('.obr-footer')].forEach((bar) => {
      bar.addEventListener('mouseenter', () => { overControls = true; clearTimeout(chromeTimer); });
      bar.addEventListener('mouseleave', () => { overControls = false; scheduleHideChrome(); });
    });

    applyStylesheet();
    built = true;
  }

  function showChrome() {
    if (!built) return;
    tickRead(); // mouse activity keeps the reading clock's gaps small (tickRead gates on active)
    overlay.classList.remove('obr-chrome-hidden');
    scheduleHideChrome();
  }

  function scheduleHideChrome() {
    clearTimeout(chromeTimer);
    if (overControls) return;
    chromeTimer = setTimeout(() => {
      if (!overControls) overlay.classList.add('obr-chrome-hidden');
    }, 2200);
  }

  function handleAction(act) {
    if (act === 'close') return close();
    if (act === 'report') return OBR.reportBroken && OBR.reportBroken({
      source: 'reader-toolbar', mode: 'text',
      proseWords: OBR._articleWordCount ? OBR._articleWordCount() : undefined,
    });
    if (act === 'settings') return OBR.openOptions && OBR.openOptions(OBR.normalizeHost(location.href));
    if (act === 'theme') return cycleTheme();
    if (act === 'font+') return changeFont(1);
    if (act === 'font-') return changeFont(-1);
    if (act === 'columns') return cycleColumns();
    if (act === 'pick') return startPicker();
    if (act === 'print') return printReader();
    if (act === 'text') return; // already in the text reader — active segment is a no-op
    if (act === 'images') { close({ suppress: false }); if (OBR.openGallery) OBR.openGallery(); return; } // mode switch — still reading, not dismissing
  }

  /* ----------------------------------------------------- print / save as PDF */
  // Pure: build a complete standalone print document from the cleaned article.
  // Deliberately a flat, vertically-flowing page (no columns / transform / fixed
  // height / overflow clip) so the browser paginates it onto paper — the screen
  // reader's layout would otherwise print as a single clipped horizontal spread.
  // Always a white paper theme (printing the dark/sepia screen theme wastes ink);
  // honors the reader's font family + line-height, but sizes in paper points since
  // screen px don't map to paper. Exposed for unit testing, like _buildReportMailto.
  // The print-branding QR links to the Chrome Web Store listing (the same public URL as the
  // README / landing "Add to Chrome" button), so a shared PDF sends readers straight to install.
  // Canonical URL lives on the shared namespace (settings.js) — the colophon and the
  // engagement chip point at the same place.
  const STORE_URL = OBR.STORE_URL;

  function printCSS({ fontFamily, lineHeight }) {
    const fam = FONT_STACKS[fontFamily] || FONT_STACKS.serif;
    const lh = lineHeight || 1.6;
    return `
      @page { margin: 18mm 16mm; }
      * { box-sizing: border-box; }
      html, body { background: #fff; color: #1a1a1a; }
      body { max-width: 40em; margin: 0 auto; padding: 0; font: 12pt/${lh} ${fam}; }
      h1 { font-size: 1.9em; line-height: 1.2; margin: 0 0 .2em; }
      h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .4em; break-after: avoid; }
      p { text-align: justify; hyphens: auto; orphans: 2; widows: 2; margin: 0 0 1em; }
      a { color: inherit; text-decoration: underline; }
      img, figure, table, pre, blockquote { break-inside: avoid; }
      img { max-width: 100%; height: auto; }
      figure { margin: 1em 0; }
      figcaption { font-size: .85em; color: #555; text-align: center; }
      blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #ccc; color: #333; }
      pre { white-space: pre-wrap; background: #f4f4f4; padding: .8em; border-radius: 4px; font-size: .9em; }
      code { font-family: ui-monospace, Menlo, Consolas, monospace; }
      hr { border: 0; border-top: 1px solid #ddd; }
      .obr-print-byline { color: #555; font-style: italic; margin: 0 0 1.4em; }
      .obr-print-source { margin-top: 2em; padding-top: .8em; border-top: 1px solid #ddd; font-size: .8em; color: #777; word-break: break-all; }
      .obr-print-brand { margin-top: 1.4em; padding-top: .8em; border-top: 1px solid #ddd; display: flex; align-items: center; gap: 12px; break-inside: avoid; }
      .obr-print-brand .obr-qr { width: 72px; height: 72px; flex: 0 0 auto; }
      .obr-print-brand .obr-qr svg { width: 100%; height: 100%; display: block; }
      .obr-print-brand .obr-brand-name { font-weight: 700; font-size: .9em; color: #333; }
      .obr-print-brand .obr-brand-tagline { font-size: .8em; color: #555; margin-top: .15em; }
      .obr-print-brand .obr-brand-url { font-size: .75em; color: #888; margin-top: .15em; word-break: break-all; }`;
  }

  // Render a QR code for `text` as a self-contained SVG string (a white quiet-zone square + one
  // <path> of the dark modules). Pure + CSP-safe: the vendored qrcode-generator (qrcode.js, loaded
  // before this file) is array math only — no DOM, no eval — and SVG (not canvas) prints crisp with
  // no data-URL. Returns '' if the encoder is unavailable or the text won't fit any QR version.
  function qrSvg(text, opts) {
    opts = opts || {};
    const border = opts.border == null ? 2 : opts.border; // quiet-zone modules
    const dark = opts.dark || '#000', light = opts.light || '#fff';
    try {
      if (typeof qrcode !== 'function') return '';
      const qr = qrcode(0, opts.ecl || 'M'); // typeNumber 0 = auto-size to the shortest fit
      qr.addData(String(text));
      qr.make();
      const n = qr.getModuleCount(), dim = n + border * 2;
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + (c + border) + ',' + (r + border) + 'h1v1h-1z';
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" '
        + 'shape-rendering="crispEdges" role="img" aria-label="QR code">'
        + '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>'
        + '<path d="' + d + '" fill="' + dark + '"/></svg>';
    } catch (e) { return ''; }
  }
  OBR._qrSvg = qrSvg;
  function buildPrintDoc({ title, byline, content, fontFamily, lineHeight, url, brand }) {
    const t = escapeHTML(title || '');
    // `brand.qrSvg` is our own generated markup (a fixed project URL, no user input), so it's
    // injected raw; the name/url text is escaped.
    let brandHtml = '';
    if (brand && brand.qrSvg) {
      brandHtml = '<div class="obr-print-brand"><div class="obr-qr">' + brand.qrSvg + '</div>'
        + '<div class="obr-brand-text"><div class="obr-brand-name">' + escapeHTML(brand.name || '') + '</div>'
        + (brand.tagline ? '<div class="obr-brand-tagline">' + escapeHTML(brand.tagline) + '</div>' : '')
        + (brand.url ? '<div class="obr-brand-url">' + escapeHTML(brand.url) + '</div>' : '')
        + '</div></div>';
    }
    return '<!doctype html><html><head><meta charset="utf-8">'
      + `<title>${t || OBR.t('readerPrintDefaultTitle')}</title><style>${printCSS({ fontFamily, lineHeight })}</style></head>`
      + `<body><h1>${t}</h1>`
      + (byline ? `<div class="obr-print-byline">${escapeHTML(byline)}</div>` : '')
      + (content || `<p>${OBR.t('readerPrintNoArticle')}</p>`)
      + (url ? `<div class="obr-print-source">${escapeHTML(url)}</div>` : '')
      + brandHtml
      + '</body></html>';
  }
  OBR._buildPrintDoc = buildPrintDoc;

  // Pure: does the back-cover colophon FIT the last content spread's already-blank page, or
  // would its break-before push it onto a fresh spread whose facing page is blank? The
  // colophon takes the single column at index `contentColumns`; it opens a NEW spread exactly
  // when the content fills whole spreads — contentColumns is a multiple of pagesPerSpread. A
  // single-page layout (pagesPerSpread < 2) has no facing page to blank, so it always fits.
  // Exposed for a unit test: the parity is easy to get subtly wrong (the "546 words → blank
  // page" report was this returning true when it should be false).
  OBR._colophonFitsLastSpread = function (contentColumns, pagesPerSpread) {
    if (pagesPerSpread < 2) return true;
    return contentColumns % pagesPerSpread !== 0;
  };

  // Hand a clean print document to the browser's print dialog (which offers
  // "Save as PDF"). Renders into a hidden iframe so the page's own CSS and the
  // reader's screen-only column transform are entirely out of the picture.
  function printReader() {
    if (printing) return; // a print is already in flight; let the modal dialog finish first
    printing = true;
    const title = (lastArticle && lastArticle.title) || document.title;
    const byline = (lastArticle && lastArticle.byline) || '';
    const content = lastArticle && lastArticle.content ? lastArticle.content : '';
    // Full URL so the saved/printed copy links back to the exact article (query
    // included — unlike the Report mailto, this output never leaves the user's device
    // unless they choose to share it). Opt out via the printSourceUrl setting.
    let url = '';
    if (settings.printSourceUrl !== false) {
      try { url = location.href; } catch (e) { /* opaque origin */ }
    }
    // Optional "Open Book Reader" footer + QR to the project page, so a shared PDF can lead a
    // reader back to the extension. Local + no new permission — the QR is drawn from a fixed URL.
    // A short wordmark reads cleaner in a footer than the full ASO store name (manifest name =
    // "Open Book — Reader View"); the brand is "Open Book Reader". The QR links to the store
    // listing; the visible line shows the store DOMAIN, not the long opaque item URL.
    let brand = null;
    if (settings.printBranding !== false) {
      brand = { name: 'Open Book Reader', tagline: OBR.t('readerPrintBrandTagline'),
        url: 'chromewebstore.google.com', qrSvg: qrSvg(STORE_URL) };
    }

    const docHtml = buildPrintDoc({
      title, byline, content,
      fontFamily: settings.fontFamily, lineHeight: settings.lineHeight, url, brand,
    });

    // Render into an OFF-SCREEN (not 0x0 / visibility:hidden) iframe so the print
    // engine actually paints it, and write via about:blank document.write rather than
    // srcdoc: a srcdoc frame navigates to about:srcdoc, which strict-CSP sites (GitHub,
    // many news sites) block via frame-src — the frame loads empty and prints blank.
    // about:blank is the initial empty document and isn't frame-src-checked.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed; left:-10000px; top:0; width:820px; height:1160px; border:0; opacity:0;';
    document.documentElement.appendChild(iframe);

    const win = iframe.contentWindow;
    const doc = win && (iframe.contentDocument || win.document);

    let done = false, timer = 0;
    const cleanup = () => {
      if (done) return;
      done = true; printing = false;
      clearTimeout(timer);
      try { iframe.remove(); } catch (e) {}
    };
    if (!doc) { cleanup(); return; }
    doc.open();
    doc.write(docHtml);
    doc.close();

    // Belt-and-suspenders for strict style-src that would drop the inline <style>:
    // also adopt the same sheet in the iframe's own realm (Constructable Stylesheets
    // bypass CSP — the trick reader.js already uses for its Shadow DOM). Best-effort.
    try {
      const Sheet = win.CSSStyleSheet;
      if (Sheet && 'replaceSync' in Sheet.prototype) {
        const sheet = new Sheet();
        sheet.replaceSync(printCSS({ fontFamily: settings.fontFamily, lineHeight: settings.lineHeight }));
        doc.adoptedStyleSheets = [sheet];
      }
    } catch (e) { /* the inline <style> already covers the common case */ }

    const fire = () => {
      // afterprint fires when the dialog closes (including after Save as PDF) — that's the
      // primary cleanup. The timer is only a leak-guard for the rare case it never fires;
      // keep it long so it can't yank the iframe while a slow user is still in the dialog
      // (which would blank the preview / fail the save), and clear it once afterprint wins.
      try { win.addEventListener('afterprint', cleanup); } catch (e) {}
      timer = setTimeout(cleanup, 600000);
      try { win.focus(); win.print(); } catch (e) { cleanup(); }
    };

    // Let images settle so figures aren't dropped, but cap the wait so a slow or
    // broken image can't hang the print.
    const pending = Array.from(doc.images || []).filter((im) => !im.complete);
    if (!pending.length) { fire(); return; }
    let left = pending.length, settled = false;
    const ready = () => { if (settled) return; settled = true; fire(); };
    const onOne = () => { if (--left <= 0) ready(); };
    pending.forEach((im) => { im.addEventListener('load', onOne); im.addEventListener('error', onOne); });
    setTimeout(ready, 2000);
  }
  OBR.printReader = printReader;

  /* ---------------------------------------------------------------- extract */
  // Forums and image boards often defer the real image URL into a non-standard
  // attribute and leave src empty or pointing at a placeholder / anti-adblock
  // decoy. Readability does copy an image-looking attribute into src, but it
  // takes the FIRST match — and some pages deliberately order a decoy URL ahead
  // of the real one (e.g. an "adblock" trap), so the genuine image is lost and
  // the now-empty post gets cleaned away as low-content.
  //
  // We don't know the attribute name up front, so don't hardcode one: scan every
  // attribute for a value that looks like an image URL and pick the first that
  // isn't a placeholder/decoy. No attribute names or site domains are baked in —
  // this generalizes across data-src / data-original / data-echo / custom names.
  // A bare image URL token (absolute, protocol-relative, or relative path), same
  // shape Readability's own _fixLazyImages uses to recognise an image attribute.
  const IMG_URL = /^\S+\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]\S*)?$/i;
  // Generic placeholder / decoy signals (not tied to any one site): data URIs,
  // 1x1 / blank / spacer pixels, "loading" spinners, and anti-adblock bait.
  const DECOY_URL = /^data:|\b(?:blank|spacer|placeholder|loading|pixel|transparent|grey|gray|default|1x1)\b|ad-?blo/i;

  // Widest URL in a srcset string. Defined once on the shared OBR namespace (settings.js,
  // which loads before this file); lets us rescue the very common responsive pattern
  // <picture><source srcset><img src="grey-placeholder.png">, where the real image lives in
  // a sibling <source> the <img>'s own attributes never hold.
  const bestSrcsetUrl = OBR.bestFromSrcset;

  function hydrateLazyImages(doc) {
    doc.querySelectorAll('img').forEach((img) => {
      const cur = (img.getAttribute('src') || '').trim();
      if (cur && !DECOY_URL.test(cur)) return; // already has a usable, real src
      // 1) the image's own srcset, then a sibling <source srcset> in an enclosing <picture>.
      let rescued = bestSrcsetUrl(img.getAttribute('srcset'));
      if (!rescued) {
        const pic = img.closest('picture');
        if (pic) for (const s of pic.querySelectorAll('source[srcset]')) {
          rescued = bestSrcsetUrl(s.getAttribute('srcset'));
          if (rescued) break;
        }
      }
      // 2) any other attribute holding a bare image URL (data-src / data-original / ...).
      if (!rescued) for (const at of img.attributes) {
        if (at.name === 'src' || at.name === 'alt') continue;
        const v = (at.value || '').trim();
        if (IMG_URL.test(v) && !DECOY_URL.test(v)) { rescued = v; break; }
      }
      if (rescued && !DECOY_URL.test(rescued)) img.setAttribute('src', rescued);
    });
  }

  // Distinct content-image URLs under a DOM scope / in a fragment of HTML, used
  // to compare how many of the page's images each extraction pass preserved.
  function imageUrlSet(scope) {
    const s = new Set();
    scope.querySelectorAll('img').forEach((img) => {
      const u = img.getAttribute('src');
      if (u && IMG_URL.test(u)) s.add(u);
    });
    return s;
  }
  function imageUrlSetFromHtml(html) {
    return imageUrlSet(new DOMParser().parseFromString(html, 'text/html'));
  }

  // Run the full extraction pipeline against a `base` DOCUMENT clone: hydrate lazy
  // images, parse with Readability, then the image-rescue re-parse. Shared by the
  // whole-page path (extractArticle) and the scoped paths (a picked node / a
  // selection) so all three behave identically. `base` must be a Document (kept a
  // clone of the live document, so baseURI/documentURI resolve relative URLs).
  // Strip live-script + embedded-chrome vectors from an extracted-content HTML string: <script>/
  // <style>/<noscript>/<iframe>/<form>, every inline on* handler, and javascript: URLs. <iframe>
  // (cross-origin framing / clickjacking inside the trusted reader overlay) and <form> (a phishing
  // surface rendered in the overlay chrome) are dropped wholesale — no article content needs them.
  // Vendored Readability is NOT
  // a sanitizer (it keeps e.g. <img onerror>), and we inject content via innerHTML into the
  // reader's Shadow DOM and the print iframe — so EVERY content path (Readability and the
  // rawFallback) runs through this, making the "no live handlers" trust model actually true.
  // innerHTML never executes <script> or fires handlers on insertion; we remove on* before any
  // later event (e.g. an <img onerror> after hydrateLazyImages rewrites its src) can fire.
  function sanitizeContentHTML(html) {
    try {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      doc.querySelectorAll('script, style, noscript, iframe, form').forEach((n) => n.remove());
      doc.querySelectorAll('*').forEach((n) => {
        for (const a of Array.from(n.attributes)) {
          const name = a.name.toLowerCase();
          // srcdoc carries inline HTML that an <iframe> runs in THIS page's origin —
          // a path our <script>/on* stripping never sees. <iframe> itself is now removed
          // wholesale above, so this is belt-and-suspenders for any stray srcdoc carrier;
          // src-based media embeds (<video>/<audio>) still work.
          if (name.startsWith('on') || name === 'srcdoc') n.removeAttribute(a.name);
          else if (name === 'href' || name === 'src' || name === 'xlink:href'
            || name === 'action' || name === 'formaction') { // form*action can also carry javascript:
            // Browsers strip leading C0-control/space AND every embedded TAB/LF/CR before
            // resolving a URL scheme, so "java\tscript:", "\x01javascript:", "javascript\r:"
            // all execute despite a bare /^\s*javascript:/ check (\s misses C0 controls and
            // mid-scheme chars). Normalize the same way before testing.
            const v = a.value.replace(/[\u0000-\u0020]+/g, '');
            if (/^javascript:/i.test(v)) n.removeAttribute(a.name);
          }
        }
      });
      return doc.body.innerHTML;
    } catch (e) { return html; }
  }

  function parseBaseDoc(base) {
    hydrateLazyImages(base);
    // parse() mutates the document it's given, so hand each pass its own copy.
    let article = new Readability(base.cloneNode(true)).parse();
    if (!article || !article.content) return article || null;

    // Rescue image-dominant posts (forums, photo threads). Readability is tuned
    // for prose: its conditional cleaning discards blocks that are mostly images
    // with little text, so an image-only post vanishes entirely. If the page is
    // image-rich yet the clean pass yielded thin text AND kept under half those
    // images, re-extract with conditional cleaning disabled and take whichever
    // pass preserves more images. Keyed on image/text ratios only — no site,
    // selector, or attribute name is hardcoded.
    const pageImgs = imageUrlSet(base);
    const keptImgs = imageUrlSetFromHtml(article.content);
    const textLen = (article.textContent || '').replace(/\s+/g, '').length;
    if (pageImgs.size >= 4 && keptImgs.size * 2 < pageImgs.size && textLen < 1500) {
      // Re-parse with conditional cleaning disabled so the image-dominant block
      // survives. Uses the vendored Readability's public `disableConditionalCleaning`
      // constructor option (defined in readability.js) rather than mutating its
      // private _flags field — the coupling now lives in one documented spot in the
      // lib. An upstream refresh that drops the option degrades to a normal parse.
      const loose = new Readability(base.cloneNode(true), { disableConditionalCleaning: true });
      const alt = loose.parse();
      if (alt && alt.content && imageUrlSetFromHtml(alt.content).size > keptImgs.size) {
        article = alt;
      }
    }
    article.content = sanitizeContentHTML(article.content); // make the trust model real
    return article;
  }

  function extractArticle() {
    try {
      return parseBaseDoc(document.cloneNode(true));
    } catch (e) {
      console.warn('[OpenBookReader] Readability failed:', e);
    }
    return null;
  }

  // Build a full-document clone whose <body> is exactly `el` (a clone of it). We
  // clone the whole document (not just `el`) so the cloned <head> — and thus
  // baseURI/documentURI — survives, letting Readability resolve relative image/
  // link URLs against the real page just as the whole-page path does. importNode
  // CLONES `el`, so the live page is never mutated.
  function scopedBaseDoc(el) {
    const base = document.cloneNode(true);
    base.body.replaceChildren(base.importNode(el, true));
    return base;
  }

  // Last-resort article object built straight from a node's own HTML, used when
  // Readability rejects a small/odd scoped root (a short selection, a bare <div>).
  // This path bypasses Readability, so it relies on the same sanitizeContentHTML pass
  // the Readability path uses. Guarantees the user sees exactly what they picked/selected.
  function rawFallback(el) {
    const clone = el.cloneNode(true);
    hydrateLazyImages(clone);
    return {
      title: document.title || '',
      byline: '',
      content: sanitizeContentHTML(clone.innerHTML),
      textContent: clone.textContent || '',
    };
  }

  // Extract from a single live element (a picked node or a selection wrapper):
  // scope Readability to just that subtree, falling back to the node's raw HTML
  // when Readability bails. Returns the article object or null.
  function extractFromNode(el) {
    if (!el) return null;
    try {
      const article = parseBaseDoc(scopedBaseDoc(el));
      if (article && article.content) return article;
      return rawFallback(el);
    } catch (e) {
      console.warn('[OpenBookReader] scoped extraction failed:', e);
      try { return rawFallback(el); } catch (_) { return null; }
    }
  }

  // Extract from the user's current text selection — honoring the EXACT selected
  // range (not its container), so "read the selection" means just what's
  // highlighted. cloneContents() gives a fragment of the selection; we wrap it and
  // run it through the scoped path.
  function extractFromSelection(sel) {
    try {
      if (!sel || !sel.rangeCount) return null;
      const wrapper = document.createElement('div');
      for (let i = 0; i < sel.rangeCount; i++) {
        wrapper.appendChild(sel.getRangeAt(i).cloneContents());
      }
      return extractFromNode(wrapper);
    } catch (e) {
      console.warn('[OpenBookReader] selection extraction failed:', e);
    }
    return null;
  }

  // Exposed for tests (underscore = internal/testable, like _buildPrintDoc).
  OBR._sanitizeContentHTML = sanitizeContentHTML;
  OBR._extractFromNode = extractFromNode;
  OBR._extractFromSelection = extractFromSelection;

  /* ------------------------------------------------------------ element picker
   * A uBlock-Origin-style picker: hover the real page, the block under the cursor
   * highlights, click reads it. The manual override for when auto-extraction (or a
   * saved pick) chose the wrong content. Runs OVER the live page — so it hides the
   * reader host and temporarily unlocks page scroll (the same toggles open()/close()
   * and the gallery's hydratePage use), then restores them on exit. The live page is
   * never mutated; extraction clones the picked node. */
  function pickCss() {
    return `
    :host { all: initial; }
    .obr-pickbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; height: 40px;
      display: flex; align-items: center; justify-content: center; gap: 14px;
      background: rgba(20,21,26,.95); color: #f0ece0;
      font: 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 2px 12px rgba(0,0,0,.45);
    }
    .obr-pickbar b { color: #9b8cff; }
    .obr-pickbar button { border: none; cursor: pointer; padding: 5px 13px; border-radius: 6px;
      background: rgba(255,255,255,.16); color: inherit; font: inherit; }
    .obr-pickbar button:hover { background: rgba(255,255,255,.30); }
    .obr-pickbox { position: fixed; z-index: 2147483646; pointer-events: none;
      background: rgba(124,108,255,.20); border: 2px solid #7c6cff; border-radius: 3px;
      transition: left .04s linear, top .04s linear, width .04s linear, height .04s linear; }
    .obr-picklabel { position: fixed; z-index: 2147483647; pointer-events: none;
      padding: 2px 7px; border-radius: 4px; font: 11px/1.4 system-ui, sans-serif;
      background: #7c6cff; color: #fff; white-space: nowrap;
      max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    [hidden] { display: none !important; }
    `;
  }

  function buildPickHost() {
    if (pickHost) return;
    ({ host: pickHost, root: pickRoot } = OBR.makeShadowHost('obr-pick-host'));
    const wrap = document.createElement('div');
    wrap.innerHTML =
      `<div class="obr-pickbar">
         <span>${OBR.t('readerPickBarInstruction')}</span>
         <button class="obr-pickcancel">${OBR.t('readerPickBarCancel')}</button>
       </div>
       <div class="obr-pickbox" hidden></div>
       <div class="obr-picklabel" hidden></div>`;
    pickRoot.appendChild(wrap);
    OBR.adoptStyles(pickRoot, pickCss());
    pickBox = wrap.querySelector('.obr-pickbox');
    pickLabel = wrap.querySelector('.obr-picklabel');
    wrap.querySelector('.obr-pickcancel').addEventListener('click', () => endPicker(null));
  }

  function positionPickBox(el) {
    const r = el.getBoundingClientRect();
    pickBox.hidden = false;
    pickBox.style.left = r.left + 'px';
    pickBox.style.top = r.top + 'px';
    pickBox.style.width = r.width + 'px';
    pickBox.style.height = r.height + 'px';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    pickLabel.hidden = false;
    pickLabel.textContent = tag + id + (txt ? ' · ' + txt : '');
    pickLabel.style.left = Math.max(2, r.left) + 'px';
    pickLabel.style.top = Math.max(44, r.top - 20) + 'px'; // clear the 40px instruction bar
  }

  // elementFromPoint returns our own (open) shadow host retargeted to pickHost when the
  // pointer is over the instruction bar; the box/label are pointer-events:none so they're
  // transparent. Skip the host and the bare <html>/<body> so we highlight real blocks.
  function pickTargetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el === pickHost || (pickHost && pickHost.contains(el))) return null;
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  function onPickMove(e) {
    const el = pickTargetAt(e.clientX, e.clientY);
    if (!el) return;
    pickHoverNode = el;
    positionPickBox(el);
  }

  function onPickClick(e) {
    if (pickHost && pickHost.contains(e.target)) return; // let the Cancel button work
    e.preventDefault();
    e.stopPropagation();
    const node = pickHoverNode || pickTargetAt(e.clientX, e.clientY);
    if (node) endPicker(node);
  }

  function onPickScroll() {
    if (pickHoverNode) positionPickBox(pickHoverNode);
  }

  function onPickKey(e) {
    if (!pickerActive) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); endPicker(null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const p = pickHoverNode && pickHoverNode.parentElement;
      if (p && p !== document.documentElement && p !== document.body) { pickHoverNode = p; positionPickBox(p); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      const c = pickHoverNode && pickHoverNode.firstElementChild;
      if (c) { pickHoverNode = c; positionPickBox(c); }
    }
  }

  function startPicker() {
    if (pickerActive || !active) return;
    endActiveFlip();
    buildPickHost();
    pickerActive = true;
    pickHoverNode = null;
    pickBox.hidden = true;
    pickLabel.hidden = true;
    pickHost.style.display = '';
    // Reveal the real page: hide the reader and unlock scroll so the user can reach
    // the content (restored in endPicker, mirroring open()/close()).
    host.style.display = 'none';
    document.documentElement.style.overflow = '';
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
    window.addEventListener('scroll', onPickScroll, true);
  }

  function endPicker(node) {
    if (!pickerActive) return;
    pickerActive = false;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    window.removeEventListener('scroll', onPickScroll, true);
    if (pickHost) pickHost.style.display = 'none';
    // Restore the reader: re-lock scroll and show the host again.
    document.documentElement.style.overflow = 'hidden';
    host.style.display = '';
    if (node) {
      lastArticle = extractFromNode(node);
      pickNode = node;
      contentSource = 'pick-manual';
      posKey = ''; // a one-shot manual pick: don't resume/persist the whole-page position
      restoreFraction = null;
      currentSpread = 0;
      renderContent(lastArticle);
      updatePickHint();
      requestAnimationFrame(() => layout(false));
      watchMedia();
    } else {
      // Cancelled: content is unchanged, but a window resize may have been skipped while
      // the overlay was hidden — re-anchor to the current viewport so pagination is fresh.
      requestAnimationFrame(() => layout(true));
    }
    showChrome();
  }

  /* ------------------------------------------------------------ pick hint banner */
  // Render the small affordance above the footer for the current contentSource.
  // 'whole' invites the picker ONLY when the extraction looks suspect (extractionSuspect);
  // 'pick-manual' offers to save; 'pick-saved' offers to drop back to the full page or clear
  // the saved pick. 'selection', and a confident whole-page read, show nothing.
  function updatePickHint() {
    if (!pickHintEl) return;
    let html = '';
    if (contentSource === 'whole') {
      // Only nag when the parse looks wrong — a confident whole-page read shows nothing
      // (the ⌖ Pick toolbar button stays available for the rare same-size wrong block).
      if (extractionSuspect) {
        html = `<span class="obr-pick-msg">${OBR.t('readerHintWrongContent')}</span>
          <button class="obr-btn" data-pick="start">${OBR.t('readerHintPickBlock')}</button>`;
      }
    } else if (contentSource === 'pick-manual') {
      html = `<span class="obr-pick-msg">${OBR.t('readerHintPickedBlock')}</span>
        <button class="obr-btn" data-pick="save">${OBR.t('readerHintSaveForSite')}</button>`;
    } else if (contentSource === 'pick-saved') {
      html = `<span class="obr-pick-msg">${OBR.t('readerHintAutoPicked')}</span>
        <button class="obr-btn" data-pick="fullpage">${OBR.t('readerHintUseFullPage')}</button>
        <button class="obr-btn" data-pick="clear">${OBR.t('readerHintClearPick')}</button>`;
    }
    if (!html) { pickHintEl.classList.remove('show'); pickHintEl.innerHTML = ''; return; }
    html += `<button class="obr-pick-x" data-pick="dismiss" title="${OBR.t('readerHintDismiss')}">✕</button>`;
    pickHintEl.innerHTML = html;
    pickHintEl.querySelectorAll('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => handlePickHint(b.dataset.pick)));
    pickHintEl.classList.add('show');
  }

  function handlePickHint(action) {
    if (action === 'dismiss') return pickHintEl.classList.remove('show');
    if (action === 'start') return startPicker();
    if (action === 'save') return saveCurrentPick();
    if (action === 'fullpage') return reExtractWholePage();
    if (action === 'clear') return clearCurrentPick();
  }

  /* ------------------------------------------------------ saved-pick selectors */
  // Class names that read as semantic content containers — preferred over utility/
  // hashed classes so a saved selector is both robust and human-readable.
  const SEMANTIC_CLASS = /(content|article|post|entry|body|main|story|prose|read|text)/i;

  // el's classes that are plausibly stable (no hashes / build-tool gibberish), ranked
  // semantic-first then shortest. These make a selector survive layout tweaks and other
  // pages of the same site far better than an nth-of-type path does.
  function rankClasses(el) {
    const list = Array.prototype.filter.call(el.classList || [], (c) =>
      /^[A-Za-z][\w-]*$/.test(c) && c.length >= 3 && c.length <= 40 && !/\d{4,}/.test(c) && !/^css-/i.test(c));
    return list.sort((a, b) => (SEMANTIC_CLASS.test(b) - SEMANTIC_CLASS.test(a)) || (a.length - b.length));
  }

  // Last-resort exact path: walk up to the nearest unique id, emitting tag:nth-of-type
  // segments. Brittle (breaks on layout change / differs per page) but always exact.
  function structuralPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')' : tag);
      node = parent;
    }
    const sel = parts.join(' > ');
    try { return document.querySelector(sel) === el ? sel : null; } catch (e) { return null; }
  }

  // Build a CSS selector for persisting a pick. Prefer the SHORTEST readable selector
  // that uniquely identifies `el` on this page — a unique id, then a lone <main>/<article>
  // or [role], then a tag+stable-class / bare class — because those also tend to keep
  // matching across the site's other pages and survive markup changes. Falls back to an
  // exact structural path only when nothing readable is unique. Returns null if even that
  // can't round-trip (then we don't offer Save). Exposed for tests.
  function cssPathFor(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      const uniq = (sel) => {
        try { const m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; }
        catch (e) { return false; }
      };
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const cands = [];
      if (el.id) cands.push('#' + CSS.escape(el.id));
      if (tag === 'main' || tag === 'article') cands.push(tag);
      if (role) cands.push(tag + '[role="' + role + '"]', '[role="' + role + '"]');
      for (const cls of rankClasses(el)) cands.push(tag + '.' + CSS.escape(cls), '.' + CSS.escape(cls));
      for (const c of cands) if (uniq(c)) return c;
      return structuralPath(el);
    } catch (e) { return null; }
  }
  OBR._cssPathFor = cssPathFor;

  // Resolve a saved selector to an article. 0 matches → null (caller falls back to the
  // whole page); 1 → that block; N>1 → all matches MERGED in document order (so a
  // multi-matching selector like ".intro, .body" reads every region as one document).
  // This is what makes the editable selector flexible without a multi-select picker.
  function extractFromSelector(sel) {
    if (!sel) return null;
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch (e) { return null; }
    if (!nodes || !nodes.length) return null;
    if (nodes.length === 1) return extractFromNode(nodes[0]);
    const wrapper = document.createElement('div');
    nodes.forEach((n) => wrapper.appendChild(n.cloneNode(true)));
    return extractFromNode(wrapper);
  }
  OBR._extractFromSelector = extractFromSelector;

  // Transient one-line message in the hint banner (e.g. a save confirmation/error).
  function flashPickMsg(msg) {
    if (!pickHintEl) return;
    pickHintEl.innerHTML = `<span class="obr-pick-msg">${escapeHTML(msg)}</span>`
      + `<button class="obr-pick-x" data-pick="dismiss" title="${OBR.t('readerHintDismiss')}">✕</button>`;
    pickHintEl.querySelector('[data-pick]').addEventListener('click', () => pickHintEl.classList.remove('show'));
    pickHintEl.classList.add('show');
  }

  // Re-render with the whole-page extraction (the "Use full page" affordance). Does
  // NOT clear a saved pick — it's a one-shot escape for this session.
  function reExtractWholePage() {
    lastArticle = extractArticle();
    pickNode = null;
    contentSource = 'whole';
    extractionSuspect = false; // the user explicitly chose the full page — don't second-guess it
    posKey = OBR.positionKey ? OBR.positionKey() : '';
    restoreFraction = null;
    currentSpread = 0;
    renderContent(lastArticle);
    // renderContent zeroed the per-article time/finish state; re-fill it for the restored
    // whole-page key so the colophon shows the article's accumulated time, not just this
    // session's. (The finish COUNT is safe either way — the stored fin flag is authoritative.)
    if (posKey && OBR.loadPositionEntry) {
      OBR.loadPositionEntry(posKey).then((e) => {
        if (contentSource !== 'whole') return; // superseded by another content switch
        priorMs = e && typeof e.ms === 'number' ? e.ms : 0;
        priorFin = !!(e && e.fin);
      });
    }
    updatePickHint();
    requestAnimationFrame(() => layout(false));
    watchMedia();
  }

  function saveCurrentPick() {
    if (!pickNode) return;
    const sel = cssPathFor(pickNode);
    if (!sel) return flashPickMsg(OBR.t('readerPickSaveNoSelector'));
    if (!OBR.savePick) return;
    OBR.savePick(OBR.normalizeHost(location.href), sel).then((ok) => {
      if (ok === false) return flashPickMsg(OBR.t('readerPickSaveStorageFull'));
      contentSource = 'pick-saved'; // now the durable per-site pick
      updatePickHint();
    });
  }

  function clearCurrentPick() {
    if (OBR.clearPick) OBR.clearPick(OBR.normalizeHost(location.href));
    reExtractWholePage();
  }

  // "Article-ness" signal for the toolbar auto-mode (gallery.js `_autoToggle`): the
  // number of words that live in SUBSTANTIAL prose blocks on the page. The counting
  // itself (the CJK-aware tokenizer + leaf-block walk) lives in settings.js as
  // OBR._proseStats / OBR._countWords, so the auto-open sentinel — which loads only
  // settings.js + sentinel.js — shares the ONE implementation with the reader and
  // the gallery, and the verdicts always agree.
  function proseWordCount() { return OBR._proseStats().words; }
  OBR._articleWordCount = proseWordCount;

  // CJK-aware word count of a plain string — same TOKENIZATION as _proseStats (so the ratio
  // below isn't skewed by a Latin-vs-CJK scoring mismatch). Note it counts ALL of the extracted
  // text, whereas proseWordCount counts only substantial leaf p/blockquote/li blocks — a
  // deliberate asymmetry that inflates `kept`, biasing toward NOT flagging (fewer false nags).
  const countWords = (text) => OBR._countWords(text);
  // Does a whole-page extraction look wrong? True when it failed outright (placeholder showing),
  // or when it kept far less text than the live page actually has in prose — the "grabbed a
  // sidebar / related-list / truncated teaser" cases. A wrong block of SIMILAR size won't trip
  // this (the page's prose total includes it), so the ⌖ Pick button still covers that. It's a
  // HEURISTIC, not a guarantee: a short article on a comment-heavy page (Readability strips the
  // comments, proseWordCount counts them) can read as suspect and nag on a correct extraction —
  // acceptable, since the banner is non-blocking and the ⌖ Pick button is always there. Exposed
  // for tests.
  const SUSPECT_MIN_PROSE = 200;   // only judge pages with a substantial amount of real prose
  const SUSPECT_KEEP_RATIO = 0.5;  // kept < half the page's prose ⇒ probably the wrong block
  function wholeExtractionSuspect(article) {
    if (!article || !article.content) return true;
    let live = 0;
    try { live = proseWordCount(); } catch (e) { live = 0; }
    const kept = countWords(article.textContent);
    return live >= SUSPECT_MIN_PROSE && kept < live * SUSPECT_KEEP_RATIO;
  }
  OBR._wholeExtractionSuspect = wholeExtractionSuspect;

  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderContent(article) {
    const title = article ? article.title : document.title;
    const byline = article && article.byline ? article.byline : '';
    const body = article
      ? article.content
      : `<p>${OBR.t('readerNoArticleBody')}</p>`;
    titleEl.textContent = title || '';
    // Estimated reading time from the live-DOM prose word count (handles CJK too).
    const words = OBR._articleWordCount ? OBR._articleWordCount() : 0;
    const mins = OBR.readingTimeMin ? OBR.readingTimeMin(words) : 0;
    if (metaEl) metaEl.textContent = mins ? OBR.t('readerReadingTime', [String(mins)]) : '';
    pagesEl.style.fontFamily = FONT_STACKS[settings.fontFamily] || FONT_STACKS.serif;
    pagesEl.innerHTML =
      `<div class="obr-content">
         <h1 class="obr-doc-h1">${escapeHTML(title || '')}</h1>
         ${byline ? `<div class="obr-byline">${escapeHTML(byline)}</div>` : ''}
         ${body}
       </div>`;
    // Drop any image that survived extraction with only a placeholder/empty src and no way
    // to render (no srcset, not inside a <picture>) — otherwise it shows as a blank box.
    // Runs AFTER extraction (Readability's own lazy/noscript passes already had their turn).
    pagesEl.querySelectorAll('img').forEach((img) => {
      const s = (img.getAttribute('src') || '').trim();
      if ((s && !DECOY_URL.test(s)) || img.getAttribute('srcset') || img.closest('picture')) return;
      const fig = img.closest('figure');
      img.remove();
      if (fig && !fig.querySelector('img, picture, video, svg, iframe') && !fig.textContent.trim()) fig.remove();
    });
    // Colophon inputs reset with every content render: the word count is of the EXTRACTED
    // text (what the user actually reads — selections and picks count too); the cached
    // colophon element died with pagesEl.innerHTML above; per-article time/finish state
    // belongs to the previous content (open() re-fills it from the saved entry).
    articleWords = article ? countWords(article.textContent) : 0;
    colophonEl = null;
    finishedThisOpen = false;
    priorMs = 0;
    priorFin = false;
  }

  /* ------------------------------------------------------------ back-cover colophon
   * The reward page at an article's end: "The End", the article's words + this reader's
   * accumulated reading time, an optional per-device lifetime line, and the QUIETEST
   * possible rate/feedback ask (a footer line on the page — Rate and Feedback as equal
   * siblings, deliberately no "enjoying it? yes/no" pre-screen). layout() appends it
   * into the column flow so it fills the final spread's blank page when one exists, or
   * becomes its own back-cover spread one flip past the end — it never covers article
   * text, never auto-navigates, and fades in once when first seen.
   * Ask retirement: any interaction (Rate / Feedback / ✕) sets `done` in SYNCED engage
   * state — no surface asks again, on any device — and COLOPHON_ASK_SEEN_MAX unacted
   * impressions retire the ask by themselves. The stats page keeps appearing either way
   * (it's a reward, not an ask); the `colophon` setting turns the whole page off. */

  // Fold the time since the last activity into readMs (capped so a silent walk-away
  // doesn't count) and restart the clock. lastTick == 0 means paused (hidden/closed).
  function tickRead() {
    const now = Date.now();
    if (active && lastTick) readMs += Math.min(Math.max(0, now - lastTick), READ_GAP_CAP);
    lastTick = active && document.visibilityState !== 'hidden' ? now : 0;
  }

  function totalArticleMs() { tickRead(); return priorMs + readMs; }

  // Persist the session's reading time into the article's entry + the device lifetime
  // totals. Folds readMs into priorMs and zeroes it, so a double flush (visibility-hidden
  // then close) can't double-count while the on-screen stats stay monotonic.
  function flushReadingTime() {
    tickRead();
    const ms = readMs;
    if (ms < 1000) return;
    readMs = 0;
    priorMs += ms;
    if (lifetimeStats) lifetimeStats.ms = (lifetimeStats.ms || 0) + ms;
    if (posKey && OBR.addReadingTime) OBR.addReadingTime(posKey, ms);
    if (OBR.bumpLifetime) OBR.bumpLifetime({ ms });
  }

  function colophonAskVisible() {
    const eng = engageState || {};
    return !eng.done && (eng.colSeen || 0) < COLOPHON_ASK_SEEN_MAX;
  }

  // Any interaction with the ask — including dismissing it — means "stop asking",
  // everywhere, forever (synced). The stats page itself is unaffected.
  function recordAskDone() {
    engageState = Object.assign({}, engageState, { done: true });
    if (OBR.saveEngage) OBR.saveEngage({ done: true });
    if (colophonEl) {
      const a = colophonEl.querySelector('.obr-colo-ask');
      if (a) a.hidden = true;
    }
  }

  // Build the colophon element once per rendered content (renderContent resets the cache).
  function ensureColophonEl() {
    if (colophonEl) return colophonEl;
    const el = document.createElement('div');
    el.className = 'obr-colophon';
    const fin = document.createElement('div');
    fin.className = 'obr-colo-fin';
    fin.textContent = OBR.t('colophonTheEnd');
    const stats = document.createElement('div');
    stats.className = 'obr-colo-stats';
    const life = document.createElement('div');
    life.className = 'obr-colo-life';
    life.hidden = true;
    const lifeText = document.createElement('span');
    const lifeHide = document.createElement('button');
    lifeHide.className = 'obr-colo-hide';
    lifeHide.textContent = OBR.t('colophonLifeHide');
    lifeHide.addEventListener('click', () => {
      // The inline off switch the lifetime line carries — no options-hunting. Synced
      // like any other setting; the options checkbox reflects it.
      settings.colophonLifetime = false;
      OBR.saveSettings({ colophonLifetime: false });
      life.hidden = true;
    });
    life.append(lifeText, document.createTextNode(' '), lifeHide);
    const ask = document.createElement('div');
    ask.className = 'obr-colo-ask';
    ask.hidden = true;
    const q = document.createElement('span');
    q.textContent = OBR.t('colophonAsk');
    const rate = document.createElement('a');
    rate.href = OBR.STORE_REVIEWS_URL;
    rate.target = '_blank';
    rate.rel = 'noreferrer';
    rate.textContent = OBR.t('colophonRate');
    rate.addEventListener('click', recordAskDone); // the anchor itself opens the store tab
    const fb = document.createElement('button');
    fb.textContent = OBR.t('colophonFeedback');
    fb.addEventListener('click', () => {
      recordAskDone();
      if (OBR.reportBroken) OBR.reportBroken({ source: 'colophon', mode: 'text', proseWords: articleWords });
    });
    const x = document.createElement('button');
    x.className = 'obr-colo-x';
    x.textContent = '✕';
    x.title = OBR.t('colophonAskDismiss');
    x.addEventListener('click', recordAskDone);
    ask.append(q, rate, document.createTextNode('·'), fb, x);
    el.append(fin, stats, life, ask);
    colophonEl = el;
    return el;
  }

  function updateColophonContent() {
    if (!colophonEl) return;
    const ms = totalArticleMs(); // ticks first, so readMs below is current too
    const stats = colophonEl.querySelector('.obr-colo-stats');
    if (stats) {
      stats.textContent = OBR.t('colophonStats',
        [articleWords.toLocaleString(), OBR._formatReadingDuration(ms)]);
    }
    const life = colophonEl.querySelector('.obr-colo-life');
    if (life) {
      const lt = lifetimeStats || {};
      // The lifetime line earns its place only once there IS a lifetime (3rd article on);
      // readMs adds the not-yet-flushed session so the total never reads behind the clock.
      const show = settings.colophonLifetime !== false && (lt.articles || 0) >= LIFETIME_MIN_ARTICLES;
      life.hidden = !show;
      if (show) {
        life.querySelector('span').textContent = OBR.t('colophonLifeLine',
          [String(lt.articles || 0), OBR._formatReadingDuration((lt.ms || 0) + readMs)]);
      }
    }
    const ask = colophonEl.querySelector('.obr-colo-ask');
    if (ask) ask.hidden = !colophonAskVisible();
  }

  // Reached the last CONTENT spread of a qualifying article: count "articles finished"
  // exactly once per article. The STORED fin flag is authoritative — markPositionFinished
  // decides "newly finished" atomically inside its read-modify-write, so a stale in-memory
  // priorFin (e.g. after "Use full page" rebuilt the reader state) can't double-count;
  // priorFin here only skips a pointless storage roundtrip.
  function noteFinish() {
    if (finishedThisOpen || articleWords < COLOPHON_MIN_WORDS) return;
    if (Math.ceil(contentColumns / pagesPerSpread) < 2) return;
    finishedThisOpen = true;
    if (posKey && !priorFin && OBR.markPositionFinished) {
      priorFin = true;
      OBR.markPositionFinished(posKey).then((newlyFinished) => {
        if (!newlyFinished) return; // finished before, in some earlier session or path
        if (OBR.bumpLifetime) OBR.bumpLifetime({ articles: 1 });
        if (lifetimeStats) lifetimeStats.articles = (lifetimeStats.articles || 0) + 1;
        updateColophonContent(); // the lifetime line may already be on screen — refresh it
      });
    }
  }

  // Called from applySpread whenever the visible spread changes: refresh + fade in the
  // colophon when its spread is on screen, and count ONE ask impression per open (only
  // when the ask line actually rendered — a stats-only page is not an ask).
  function syncColophonView() {
    if (!colophonEl || !colophonEl.isConnected) return;
    if (currentSpread !== totalSpreads - 1) return; // the colophon column is always last
    updateColophonContent();
    if (flipSnapping) {
      // Arriving via an animated page turn: the turn overlay's clones render fully opaque,
      // so a mid-fade real colophon would "pop" dimmer when the layer lifts. Snap to
      // visible — the turn itself is the arrival motion; the fade stays for plain arrivals.
      colophonEl.style.transition = 'none';
      colophonEl.classList.add('obr-colo-in');
      const el = colophonEl;
      requestAnimationFrame(() => { el.style.transition = ''; });
    } else {
      colophonEl.classList.add('obr-colo-in');
    }
    if (!colSeenThisOpen && colophonAskVisible()) {
      colSeenThisOpen = true;
      engageState = Object.assign({}, engageState,
        { colSeen: ((engageState && engageState.colSeen) || 0) + 1 });
      // Function-form patch: increment against the STORED counter — obr_engage is synced,
      // and another device may have advanced it since this session's snapshot loaded.
      // PASSIVE impression counter, and a load-bearing one: a single colSeen permanently
      // retires the engagement chip (settings.js _shouldAskEngage) and obr_engage is SYNC, so
      // recording one incognito read would silently burn that channel on every device forever.
      if (OBR.saveEngage && !(OBR._skipPassiveWrite && OBR._skipPassiveWrite())) {
        OBR.saveEngage((p) => Object.assign({}, p, { colSeen: (p.colSeen || 0) + 1 }));
      }
    }
  }

  /* ------------------------------------------- per-figure shrink-to-slack
   * A tall figure carrying `break-inside: avoid` that doesn't fit the space left in its
   * column BUMPS to the next column, leaving the remainder blank (measured on a 5-tall-image
   * fixture: 53-57% of a page, WITH the CSS cap already active). That CSS max-height cap is a
   * GLOBAL proxy for a LOCAL collision — it shrinks every image, including ones that never
   * collide, and still can't fit a figure to the exact slack available. This pass fixes the
   * collision where it happens: for each figure that bumped, measure the slack it left behind
   * and shrink JUST that figure to fit it. That's what lets the CSS cap stay generous, so
   * non-colliding images render LARGER than under the old blanket cap.
   *
   * The constraints this is built around (each verified by a real-Chromium probe):
   *  - You cannot ask the multicol fragmenter for "space remaining before element X", so we
   *    measure post-layout rects instead.
   *  - A block fragmented across a column break has a USELESS union getBoundingClientRect
   *    (measured 1168px wide across a 544px column), so the end of the flow is found via a
   *    Range's per-fragment getClientRects() — its LAST rect is the true flow end.
   *  - All geometry is measured RELATIVE to pagesEl's rect, which cancels the horizontal
   *    translateX (verified identical at translateX(0) and translateX(-3744px)).
   *  - Shrinks are MONOTONE (only ever set, never grown or reverted mid-pass) and applied in
   *    document order in ONE forward sweep: a shrink can only pull later content earlier, so
   *    it may fix a later bump but can never un-fix an earlier one — hence it terminates with
   *    no convergence loop.
   *  - A readability FLOOR, not a ceiling: when the slack is too small to leave a usable
   *    image, the blank is left alone. A postage-stamp screenshot is worse than a blank half
   *    page. This is why the fix stays "partial by nature" — but on a principled floor.
   * Reworking this is layout-heavy: re-verify with real-Chromium screenshots AND rect
   * measurement (see the tall-images gotcha in docs/reader.md), never by eye alone. */
  const FIT_MIN_PX = 240;     // never leave an image shorter than this...
  const FIT_MIN_FRAC = 0.35;  // ...nor shorter than this fraction of the column
  const FIT_TOP_EPS = 40;     // "starts at the column top" tolerance == it bumped
  const FIT_MAX_ADJUST = 20;  // pathological-page guard (each adjustment costs one reflow)

  function fitTallFigures(colW, colGap, colH) {
    const contentRoot = pagesEl.querySelector('.obr-content');
    if (!contentRoot) return;
    // Idempotence first: drop the previous pass's overrides, which were computed against a
    // stale colH / font-size / column geometry. This is what lets the late-image settle
    // window simply re-run layout() with no extra bookkeeping or hooks.
    const prevFit = contentRoot.querySelectorAll('[data-obr-fit]');
    for (let i = 0; i < prevFit.length; i++) {
      // Restore whatever inline max-height the CONTENT author had (usually none). Blindly
      // clearing would permanently destroy an authored value, since rawFallback keeps inline
      // styles on the picked/selected path.
      prevFit[i].style.maxHeight = prevFit[i].getAttribute('data-obr-fit') || '';
      prevFit[i].removeAttribute('data-obr-fit');
    }
    // Seam checked AFTER the cleanup: bailing first would strand the previous pass's overrides.
    if (OBR._fitPass === false) { if (prevFit.length) void pagesEl.offsetWidth; return; }
    const media = contentRoot.querySelectorAll('img, svg');
    if (!media.length) return;
    if (prevFit.length) void pagesEl.offsetWidth; // re-measure from the un-overridden state

    // One entry per fragmenting BLOCK (the <figure> wrapper when there is one) — a figure
    // holding two images must not be visited twice, or the second visit would build a
    // backwards Range against itself.
    const blocks = [];
    const seen = new Set();
    for (let i = 0; i < media.length; i++) {
      const block = media[i].closest('figure') || media[i];
      if (seen.has(block)) continue;
      seen.add(block);
      blocks.push({ el: media[i], block });
    }

    const floor = Math.max(FIT_MIN_PX, colH * FIT_MIN_FRAC);
    // Counts ATTEMPTS, not successes: a failed attempt still costs two forced synchronous
    // layouts (the trial reflow + the revert reflow), and layout() re-runs for every late
    // image through the settle window — so an image-heavy page could otherwise thrash.
    let attempts = 0;
    let prevBlock = null;
    for (let i = 0; i < blocks.length && attempts < FIT_MAX_ADJUST; i++) {
      const el = blocks[i].el, block = blocks[i].block;
      const startAfter = prevBlock;
      prevBlock = block; // advances regardless of whether this one is adjusted
      const pr = pagesEl.getBoundingClientRect();
      const colOf = (x) => Math.round((x - pr.left) / (colW + colGap));
      const br = block.getBoundingClientRect();
      const figCol = colOf(br.left);
      if (figCol < 1) continue;                    // first column: nothing before it to fill
      if (br.top - pr.top > FIT_TOP_EPS) continue; // sits mid-column, so it never bumped
      // End of the flow immediately before this figure. Bounded to the content since the
      // PREVIOUS figure so the sweep stays O(content), not O(content x figures).
      let last = null;
      try {
        const range = document.createRange();
        if (startAfter) range.setStartAfter(startAfter);
        else range.setStart(contentRoot, 0);
        range.setEndBefore(block);
        const rects = range.getClientRects();
        for (let r = rects.length - 1; r >= 0; r--) {
          if (rects[r].width > 0.5 && rects[r].height > 0.5) { last = rects[r]; break; }
        }
      } catch (e) { continue; } // detached/backwards range — leave this figure alone
      if (!last || colOf(last.left) !== figCol - 1) continue; // flow didn't end in the prev column
      const slack = colH - (last.bottom - pr.top);
      if (slack < floor) continue;                 // too tight to leave a readable image
      const er = el.getBoundingClientRect();
      // Reserve everything that rides along with the image. getBoundingClientRect is the
      // BORDER box, so (block - image) covers <figcaption> and padding but NOT the figure's
      // `margin: 1em 0` — those must be added explicitly or we under-reserve by ~2em, the
      // figure still doesn't fit, and we'd have shrunk the image for nothing (measured: waste
      // went UP 1839->2183px while images got smaller — a pure loss).
      const bs = getComputedStyle(block);
      const margins = (parseFloat(bs.marginTop) || 0) + (parseFloat(bs.marginBottom) || 0);
      const overhead = Math.max(0, br.height - er.height) + margins;
      const target = Math.floor(slack - overhead - 4);     // 4px breathing room
      // Gate the FLOOR on `target` — the height the image will actually end up at — not on
      // `slack`. `target` is always smaller (it pays the figcaption + margins), so checking
      // slack alone let the fractional floor be violated on any column taller than ~686px,
      // i.e. an ordinary desktop window: a 312px slack minus 66px overhead yielded a 242px
      // image, 29% of the column, when FIT_MIN_FRAC promises 35%.
      if (target < floor || target >= er.height) continue; // unusable, or already fits
      attempts++;
      el.setAttribute('data-obr-fit', el.style.maxHeight || ''); // remember the author's value
      el.style.maxHeight = target + 'px';
      void pagesEl.offsetWidth; // reflow so the next figure measures against the new flow
      // VERIFY OR REVERT. A shrink is only worth it if the figure actually moved up into the
      // slack; subpixel/line-height rounding or a margin that didn't collapse as predicted can
      // leave it bumped anyway. Reverting then guarantees the pass is never a pure loss — it
      // either wins a page or changes nothing, and it can never silently shrink an image for
      // no benefit. This self-correction is what makes the whole sweep safe to run blind.
      const moved = Math.round((block.getBoundingClientRect().left - pagesEl.getBoundingClientRect().left)
        / (colW + colGap)) === figCol - 1;
      if (!moved) {
        el.style.maxHeight = el.getAttribute('data-obr-fit') || '';
        el.removeAttribute('data-obr-fit');
        void pagesEl.offsetWidth;
        continue;
      }
    }
  }

  /* ---------------------------------------------------------------- layout */
  function layout(keepSpread, anchorFraction) {
    endActiveFlip(); // abort any in-flight 3D turn and snap to its (already-correct) end
    const vw = window.innerWidth, vh = window.innerHeight;
    const cols = Math.max(2, Math.min(4, settings.columns || 2)); // 2, 3, or 4 per spread
    pagesPerSpread = vw < settings.singlePageBelow ? 1 : cols;

    const outerMargin = 24;  // gap from the window edge to the book
    // Fill the window by default; maxBookWidth (when set) is an optional readability cap.
    const fullW = vw - outerMargin;
    const bookW = settings.maxBookWidth ? Math.min(fullW, settings.maxBookWidth) : fullW;
    const sidePad = 44;
    const visibleW = bookW - sidePad * 2;
    colGap = settings.gutter;
    colW = pagesPerSpread === 1
      ? visibleW
      : Math.max(60, (visibleW - colGap * (pagesPerSpread - 1)) / pagesPerSpread);
    // Book now fills the full height; the topbar/footer float over it (auto-hidden).
    const colH = Math.max(200, vh - 52);

    paperEl.style.width = bookW + 'px';
    paperEl.style.height = colH + 28 + 'px';
    paperEl.style.padding = '14px ' + sidePad + 'px';

    viewportEl.style.width = visibleW + 'px';
    viewportEl.style.height = colH + 'px';

    pagesEl.style.width = visibleW + 'px';
    pagesEl.style.height = colH + 'px';
    // Expose the column height so over-tall media can be capped to fit a single
    // column instead of overflowing and getting clipped at the column boundary.
    pagesEl.style.setProperty('--obr-colh', colH + 'px');
    pagesEl.style.columnWidth = colW + 'px';
    pagesEl.style.columnGap = colGap + 'px';
    pagesEl.style.fontSize = settings.fontSize + 'px';
    pagesEl.style.transition = 'none';

    // Center spine only fits an even split (its 50% line lands on the middle gap).
    overlay.querySelector('.obr-spine').classList.toggle('hidden', pagesPerSpread % 2 !== 0);

    // Measure the CONTENT alone first — a colophon left attached by a previous pass
    // would distort the blank-page detection below.
    if (colophonEl && colophonEl.parentNode) colophonEl.remove();
    void pagesEl.offsetWidth; // force reflow before measuring
    // Shrink any figure that bumped to a new column back into the slack it left behind, so
    // the column count below (and the colophon fit, and the anchor restore) all measure the
    // CORRECTED flow. Runs after the colophon removal so a back-cover page never skews it.
    fitTallFigures(colW, colGap, colH);
    const total = pagesEl.scrollWidth;
    totalColumns = Math.max(1, Math.round((total + colGap) / (colW + colGap)));
    contentColumns = totalColumns;
    // Back-cover colophon: appended INTO the column flow (break-before → its own column,
    // sized to exactly one page), so it FILLS the final spread's already-blank page.
    // Gated to substantial articles with at least two content spreads: the moment must be
    // earned, and a one-spread piece would surface it with zero interaction.
    // ONLY append when it FITS the last content spread's already-blank page — never when it
    // would push onto a fresh spread with a blank facing page (the "546 words → blank right
    // page" report; see _colophonFitsLastSpread). When it's skipped, the engagement chip on
    // close still carries the ask (one channel at a time), so nothing is lost but the blank.
    const contentRoot = pagesEl.querySelector('.obr-content');
    if (contentRoot && settings.colophon !== false && articleWords >= COLOPHON_MIN_WORDS
        && Math.ceil(contentColumns / pagesPerSpread) >= 2
        && OBR._colophonFitsLastSpread(contentColumns, pagesPerSpread)) {
      const colo = ensureColophonEl();
      colo.style.height = colH + 'px';
      contentRoot.appendChild(colo);
      void pagesEl.offsetWidth;
      totalColumns = Math.max(1, Math.round((pagesEl.scrollWidth + colGap) / (colW + colGap)));
    }
    totalSpreads = Math.max(1, Math.ceil(totalColumns / pagesPerSpread));

    // An explicit anchor (font/column change) wins; otherwise, while a saved
    // position is pending (just opened), keep re-anchoring to it through the
    // late-image settle window so the resume survives re-pagination.
    const anchor = typeof anchorFraction === 'number' ? anchorFraction
      : (restoreFraction != null ? restoreFraction : null);
    if (anchor != null) {
      // Restore the reading position proportionally onto the new column count
      // (font-size / column changes reflow the article; a resume restores a
      // fraction saved in a possibly-different font/viewport).
      currentSpread = Math.round((anchor * totalColumns) / pagesPerSpread);
    } else if (!keepSpread) {
      currentSpread = 0;
    }
    currentSpread = Math.max(0, Math.min(currentSpread, totalSpreads - 1));

    requestAnimationFrame(() => { pagesEl.style.transition = ''; });
    applySpread();
  }

  function applySpread() {
    const stride = pagesPerSpread * (colW + colGap);
    pagesEl.style.transform = `translateX(${-currentSpread * stride}px)`;
    const left = currentSpread * pagesPerSpread + 1;
    const right = Math.min(left + pagesPerSpread - 1, totalColumns);
    const rangeStr = left === right ? `${left}` : `${left}–${right}`;
    indicatorEl.textContent = OBR.t('readerPageIndicator', [rangeStr, String(totalColumns)]);
    if (progressFillEl) {
      const pct = totalSpreads <= 1 ? 1 : currentSpread / (totalSpreads - 1);
      progressFillEl.style.width = Math.round(pct * 100) + '%';
    }
    // Colophon bookkeeping: "finished" = seeing the last CONTENT spread (the colophon
    // column, when present, is always the last column overall — possibly one spread later).
    if (currentSpread >= Math.max(0, Math.ceil(contentColumns / pagesPerSpread) - 1)) noteFinish();
    syncColophonView();
    persistPosition();
  }

  // Save the current reading position (debounced) so the reader can resume here.
  function persistPosition() {
    if (!posKey || totalColumns < 1 || !OBR.savePosition) return;
    const f = (currentSpread * pagesPerSpread) / totalColumns;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => OBR.savePosition(posKey, f), 400);
  }

  // Persist the position NOW, skipping the 400ms debounce. close() and the
  // page-hide handlers call this so a tab-close / in-page navigation / tab
  // backgrounding inside the debounce window doesn't drop the last page turn
  // (resume would otherwise land a page early).
  function flushPosition() {
    clearTimeout(saveTimer);
    if (active && posKey && totalColumns >= 1 && OBR.savePosition) {
      OBR.savePosition(posKey, (currentSpread * pagesPerSpread) / totalColumns);
    }
  }

  /* ------------------------------------------------- page-turn desync detector
   * A turn is drawn from CLONES of the strip, positioned by index math (column k sits at
   * k * stride). That is only true while the cached pagination still describes the live
   * strip and the clones paginate exactly like it — and both can silently stop being true.
   * These counters make that visible instead of leaving it as an unreproducible "the flip
   * sometimes shows the wrong page" report: read them from any console via
   * OBR._diagReader(), or turn on OBR.debugTiming(true) to get a console line at the
   * moment it happens. Purely local — a counter and a console warning, nothing is sent
   * anywhere (the "collects nothing" disclosure stays true). */
  let flipDesyncs = 0, lastFlipDesync = null;

  // What the strip's media looked like at the moment a desync fired — the difference between
  // "it happened again" and knowing WHY. These counts separate the causes we know of:
  // an image with no intrinsic size cannot be laid out by a CLONE before its bytes arrive
  // (buildFlipSnapshot's pin exists to make that irrelevant), and a FAILED one is worse still —
  // the live strip shows alt text or a broken-image icon while a fresh clone is still
  // re-fetching and reserves nothing, so the two disagree by exactly that box. Only ever
  // computed when a desync has already been detected, so it costs nothing in the normal path.
  function mediaCensus() {
    if (!pagesEl) return {};
    const imgs = pagesEl.querySelectorAll('img');
    let failed = 0;
    for (let i = 0; i < imgs.length; i++) if (imgs[i].complete && !imgs[i].naturalWidth) failed++;
    // `unpinned` is the count that can actually explain a desync now: replaced elements whose
    // box depends on load state, which buildFlipSnapshot does NOT pin and sanitizeContentHTML
    // does NOT strip. (It strips script/style/noscript/iframe/form, so those cannot appear —
    // an earlier draft of this line listed iframe, which could never have counted one.)
    return {
      imgs: imgs.length, failed: failed,
      vids: pagesEl.querySelectorAll('video').length,
      unpinned: pagesEl.querySelectorAll('object, embed, canvas, audio').length,
    };
  }

  function noteFlipDesync(kind, detail) {
    flipDesyncs++;
    lastFlipDesync = Object.assign({ kind: kind, spread: currentSpread, cols: totalColumns },
      mediaCensus(), detail || {});
    if (OBR._debug) {
      // Serialize INTO the message. A second console argument renders as "[object Object]" in
      // chrome://extensions' Errors page and in any copied console line — which threw away
      // every number this function had just collected, the one thing a field report needs.
      try { console.warn('[OBR reader] page-turn desync: ' + kind + ' ' + JSON.stringify(lastFlipDesync)); } catch (e) { /* console unavailable */ }
    }
  }

  // The column count the strip ACTUALLY has right now, measured off the live DOM. layout()
  // caches it in totalColumns, but the browser re-flows the multicol strip on its own
  // whenever the content changes size — a late image, a font face that swaps in AFTER
  // fonts.ready already resolved, the colophon rewriting its own text — and some of those
  // reflows arrive with no event we subscribe to. One scrollWidth read; the turn forces
  // layout in pageGeom() a moment later anyway, so on a settled strip this is ~free.
  function liveColumnCount() {
    if (!pagesEl || !(colW + colGap)) return totalColumns;
    return Math.max(1, Math.round((pagesEl.scrollWidth + colGap) / (colW + colGap)));
  }

  function flip(dir) {
    tickRead(); // a page turn is the strongest "still reading" signal for the time clock
    // Never turn from a STALE pagination. Two things desync the cached column count from the
    // live strip: a re-layout we queued but haven't run yet, and a reflow nothing told us
    // about. Either leaves totalColumns/totalSpreads (and so the target spread, and the
    // columns the turn clones) describing a layout the strip no longer has. Measuring the
    // live count catches BOTH, including the reflows we have no listener for.
    // endActiveFlip() runs before layout(true) on purpose: the old guard skipped the re-measure
    // whenever a turn was in flight, which made the SECOND tap of a fast double-flip the one
    // that went wrong. beginFlip would have aborted that turn a moment later regardless.
    const live = liveColumnCount();
    // Only count it when NOTHING told us — with a relayout already queued, the browser has
    // reflowed and we simply have not re-measured yet, which is routine for the whole 80ms
    // debounce and would drown the one signal this counter exists to carry.
    if (!mediaTimer && live !== totalColumns) noteFlipDesync('stale-pagination', { live: live });
    if (mediaTimer || live !== totalColumns) {
      clearTimeout(mediaTimer); mediaTimer = null;
      endActiveFlip();
      if (active && built) layout(true);   // the same guard runMediaRelayout applies
      // layout() parks the strip at `transition: none` until its own rAF restores it, so the
      // plain-slide path below would JUMP instead of sliding on every turn that re-measures.
      // Flush the re-anchored transform first, or restoring the transition here would animate
      // that re-anchor retroactively.
      if (pagesEl) { void pagesEl.offsetWidth; pagesEl.style.transition = ''; }
    }
    const next = currentSpread + dir;
    if (next < 0 || next >= totalSpreads) return;
    restoreFraction = null; // user is navigating — stop re-anchoring to the resume point
    // The realistic 3D book turn only makes sense when there is a center spine to hinge
    // on — i.e. an even number of columns per spread. Odd (3) / single-page layouts, the
    // 'slide'/'off' settings, and reduced-motion all take the plain translateX path, whose
    // final state (currentSpread + applySpread) is authoritative; 'book' is purely additive.
    const animated = !reduceMotion && pagesPerSpread % 2 === 0;
    if (animated && settings.pageTurn === 'book') { bookFlip(dir, currentSpread, next); return; }
    if (animated && settings.pageTurn === 'curl') { curlFlip(dir, currentSpread, next); return; }
    currentSpread = next; applySpread();
  }

  /* ----------------------------------------------- realistic 3D book page turn
     There are no per-page DOM nodes — "pages" are virtual CSS columns and the whole
     article is one strip (pagesEl). To turn a page like a real book we DON'T move the
     real strip through a 3D path; instead we snap it straight to the destination, then
     float a transient leaf — cloned column slices — that rotates about the center spine
     on top. So the engine's final state (currentSpread / translateX / indicator /
     progress) is identical to the plain slide, set synchronously; the 3D turn is purely
     additive and can be aborted at any instant without leaving the reader inconsistent.

     Forward turn k->k+1: the source's RIGHT page lifts at the spine and swings left; its
     back is the destination's LEFT page; the destination's RIGHT page is revealed beneath
     (already in the real strip); the source's LEFT page sits still until the back lands on
     it. Backward mirrors this. See the plan's geometry table for the clip/translateX math. */

  // Paper-relative page geometry shared by both turn styles. A "page" is the full PAPER
  // half the reader sees — the text column AND its surrounding white margins — so panels
  // sized to it match the laid page exactly (the turning leaf is NOT just the text area).
  function pageGeom() {
    const vp = viewportEl.getBoundingClientRect();
    const paper = paperEl.getBoundingClientRect();
    const stride = pagesPerSpread * (colW + colGap);
    const half = (stride - colGap) / 2;        // half the text area = column + half gutter
    const padX = vp.left - paper.left;          // outer side margin (paper padding)
    const padY = vp.top - paper.top;            // top / bottom margin
    const spineX = padX + half;                 // spine / page centre, in paper coords
    // Left page = [0, spineX]; right page = [spineX, paperW]; both spineX wide (symmetric).
    return { padX, padY, spineX, pageW: paper.width - spineX, paperW: paper.width, paperH: paper.height };
  }

  /* ONE snapshot of the strip per turn, with every replaced element PINNED to the box the
   * live strip is rendering; each panel is a copy of it (a curl turn needs 19).
   *
   *   A cloned <img> does NOT inherit the original's loaded state. It re-runs source
   *   selection, and unless the bytes are still in the browser's list of available images it
   *   lays out at 0 until they arrive. `.obr-pages img` is `height: auto` and `column-fill:
   *   auto`, so one collapsed image shortens its column and re-breaks every column after it:
   *   the clone paginates differently from the strip it impersonates, panel N stops being
   *   page N, and the turn animates a page the reader never asked for. That is the "the flip
   *   sometimes takes the wrong image" report, intermittent because it depends on whether a
   *   given image's bytes happen to still be available when the turn is built.
   *
   * The pin is an INLINE px box, and it has to be: width/height ATTRIBUTES do nothing here.
   * reader.style.js sets `width: auto` (:183, deliberately, to release legacy <img width>)
   * and `height: auto` (:173) as AUTHOR rules, which outrank the attributes' presentational
   * hint — leaving only `aspect-ratio`, and a ratio cannot size a replaced element when
   * neither side is definite. Measured in real Chromium: an un-loaded <img> under those exact
   * rules is 0x0 whether or not it carries width/height attributes. Inline styles DO outrank
   * them, so pinning is the mechanism that actually works, and it also leaves the live
   * strip's own rendering untouched — only the throwaway snapshot is pinned.
   * Read every box first, then write, so the pin costs one layout flush and not one per
   * element. box-sizing is border-box, so the rect IS the box to pin. A zero box (an image
   * still loading in the LIVE strip) is pinned as zero on purpose — the clone must match what
   * the reader is looking at, not what the image will eventually become.
   * This is also why the snapshot exists at all: it is the measure-once point. Cloning
   * pagesEl directly per panel would be equally coherent (a turn is one synchronous task, so
   * the tree cannot change mid-turn) but would re-measure for all 19. */
  let flipSnapshot = null;
  function buildFlipSnapshot() {
    const media = pagesEl.querySelectorAll('img, video');
    const boxes = [];
    for (let i = 0; i < media.length; i++) {
      const r = media[i].getBoundingClientRect();
      boxes.push({ w: r.width, h: r.height });
    }
    const snap = pagesEl.cloneNode(true);
    snap.classList.add('obr-leaf-pages');      // keep .obr-pages too (it carries the styling)
    snap.style.transition = 'none';
    snap.style.willChange = 'auto';            // don't spawn a compositor layer per clone
    // Seam (same shape as OBR._fitPass), and the reason it PINS TO ZERO rather than skipping:
    // merely omitting the pin does not reproduce the bug in a test, because the clone re-fetches
    // from the browser's available-images list and sizes itself perfectly well. Zero IS what a
    // clone lays out as when those bytes are NOT available — the real failure — so this is the
    // only way to drive flipOverlayValid deterministically. Two guards in a row shipped INERT
    // because nothing in the suite could reach them; now one does. It cannot be reached from the
    // page: content scripts run in an isolated world, so no site (or its devtools console) can see
    // OBR, and only the exact boolean false activates it. Worst case, a turn skips its animation.
    const collapse = OBR._pinPass === false;
    const cloned = snap.querySelectorAll('img, video');
    for (let i = 0; i < cloned.length && i < boxes.length; i++) {
      cloned[i].style.width = (collapse ? 0 : boxes[i].w) + 'px';
      cloned[i].style.height = (collapse ? 0 : boxes[i].h) + 'px';
    }
    return snap;
  }

  // A panel's copy of the turn's pinned snapshot, shifted so its clip window reveals chosen
  // columns. tx aligns the columns horizontally; ty pushes the text down by the page's top
  // margin so the panel (sized to the full paper page) shows the text with its margins.
  function makePagesClone(tx, ty) {
    if (!flipSnapshot) flipSnapshot = buildFlipSnapshot(); // beginFlip always takes it first
    const clone = flipSnapshot.cloneNode(true);
    clone.style.transform = `translateX(${tx}px)`;
    if (ty) clone.style.top = ty + 'px';
    return clone;
  }

  /* Do the columns this turn ANIMATES carry the same content in both flows?
   *
   * Note what is NOT asked: whether the flows agree everywhere. A divergence past the last
   * animated column cannot be put on screen by this turn, and treating it as a wrong page
   * costs the animation for nothing — observed in the field (one image, correctly sized,
   * nothing failed, and the curl silently stopped happening on that site).
   *
   * Note also what is NOT used: equal scrollWidth. It is tempting as an O(1) whole-flow test,
   * but it is NOT proof of equal column boundaries. scrollWidth is quantised to whole columns,
   * so a divergence smaller than the slack left in the final column shifts every subsequent
   * column's content while the column COUNT — and therefore scrollWidth — stays identical. In
   * a measured sweep, roughly 1 layout in 6 landed in that hole with 30-40 blocks displaced,
   * which is precisely the bug this guard exists to catch. The numbers are still reported for
   * diagnostics; they just do not get a vote.
   *
   * So: compare WHERE each leaf block actually sits, on both sides, directly. No inference —
   * "same column, same offset down the page" IS the property the panels depend on.
   *
   * Two traps this shape exists to avoid, both of which produced an inert guard before:
   *  - Do NOT walk `.obr-content > *`. Readability wraps the whole article in a single
   *    <div id="readability-page-1">, so that list is [h1, byline, wrapper, colophon] — and a
   *    block fragmented across columns has an offsetHeight that SATURATES at the fragmentainer
   *    height (measured: 748 against a clientHeight of 748, unchanged whether the clone
   *    paginates to 8 columns or 4). Comparing those compares three constants.
   *  - Do NOT infer boundaries from equal heights. Only blocks that fit inside one column
   *    report an honest height, and those carry the least pagination information.
   * Positions are measured relative to each strip's OWN rect, which cancels both the live
   * strip's translateX and the clone's translateX/top — the same trick fitTallFigures uses. */
  const FLOW_LEAVES = 'p, h1, h2, h3, h4, h5, h6, figure, img, li, blockquote, pre, table, hr';
  function flowMatchesThrough(clone, lastCol) {
    const a = pagesEl.querySelectorAll(FLOW_LEAVES);
    const b = clone.querySelectorAll(FLOW_LEAVES);
    if (!a.length || a.length !== b.length) {
      return { ok: false, why: 'leaves ' + a.length + 'vs' + b.length };
    }
    const pitch = colW + colGap;
    if (!(pitch > 0)) return { ok: false, why: 'no pitch' };
    const ao = pagesEl.getBoundingClientRect(), bo = clone.getBoundingClientRect();
    for (let i = 0; i < a.length; i++) {
      const ar = a[i].getBoundingClientRect();
      const ac = Math.round((ar.left - ao.left) / pitch);
      // Past the pages this turn can show — skip rather than stop, so one out-of-flow block
      // (the picker/selection path keeps authored inline styles) cannot end the walk early.
      if (ac > lastCol) continue;
      const br = b[i].getBoundingClientRect();
      const bc = Math.round((br.left - bo.left) / pitch);
      if (ac === bc && Math.abs((ar.top - ao.top) - (br.top - bo.top)) < 1) continue;
      const cls = String(a[i].className || '').split(' ')[0];
      return { ok: false, why: i + ':' + a[i].tagName.toLowerCase() + (cls ? '.' + cls : '')
        + ' col' + ac + 'vs' + bc + ' dy' + Math.round((br.top - bo.top) - (ar.top - ao.top)) };
    }
    return { ok: true };
  }

  // Drop the overlay when the snapshot cannot be trusted for the pages it is about to show,
  // and let the plain jump stand — the strip was already snapped to the destination, so the
  // turn simply becomes instant. A missing animation is a far smaller bug than a wrong page.
  function flipOverlayValid(layer, src, next) {
    const probe = layer.querySelector('.obr-leaf-pages');
    if (!probe) return true;
    const lastCol = (Math.max(src, next) + 1) * pagesPerSpread - 1;
    const m = flowMatchesThrough(probe, lastCol);
    if (m.ok) return true;
    noteFlipDesync('clone-repaginated',
      { lastCol: lastCol, why: m.why, liveW: pagesEl.scrollWidth, cloneW: probe.scrollWidth });
    return false;
  }

  // Drop an overlay we've decided not to animate. activeFlip was never set (the caller bails
  // before assigning it), so endActiveFlip() wouldn't run its tail — restore the strip's
  // transition here, or the plain slide stays frozen at `none` for the rest of the session.
  // The strip is already at the destination and the transform is already flushed (by
  // flipOverlayValid's scrollWidth read), so nothing animates retroactively.
  function abortFlipOverlay(layer) {
    layer.remove();
    flipSnapshot = null;
    // Flush the destination transform BEFORE restoring the transition, explicitly rather than
    // relying on the guard above having read layout — otherwise a future guard that
    // short-circuits without measuring would make this snap animate retroactively.
    if (pagesEl) { void pagesEl.offsetWidth; pagesEl.style.transition = ''; }
  }

  // One face of the turning leaf: a clipped clone plus a shading overlay (returned so its
  // opacity can be animated — the page darkens as it stands edge-on).
  function buildFace(kind, tx, ty) {
    const face = document.createElement('div');
    face.className = 'obr-leaf-face ' + kind;
    face.appendChild(makePagesClone(tx, ty));
    const shade = document.createElement('div');
    shade.className = 'obr-leaf-shade';
    face.appendChild(shade);
    return { face, shade };
  }

  // Shared prologue for both page-turn styles (book + curl). Snap the real strip to the
  // destination synchronously (final state == the plain-flip path, which keeps the sync-read
  // tests green), then build the flip overlay: a full-paper .obr-flip-layer with the
  // stationary source page (forward: LEFT; backward: RIGHT) already appended. The caller
  // builds + appends its own turning leaf, then paperEl.appendChild(layer). Returns the pieces.
  function beginFlip(dir, src, next) {
    endActiveFlip();                 // fast-forward any in-flight turn to its settled state
    const fwd = dir > 0;

    // Snap the real strip (+ indicator / progress / persist) straight to the destination with
    // no slide, so the final state matches the plain-flip path synchronously. flipSnapping
    // tells syncColophonView this arrival is animated (activeFlip isn't set yet here).
    pagesEl.style.transition = 'none';
    flipSnapping = true;
    currentSpread = next;
    applySpread();
    flipSnapping = false;

    // Geometry. A "page" is the full PAPER half — text column PLUS its white margins — not
    // just the text area, so the turning leaf matches the page the reader sees. pageGeom()
    // gives the paper-relative spine, page width/height, and the margins.
    const stride = pagesPerSpread * (colW + colGap);
    const g = pageGeom();

    // One frozen, media-pinned copy of the strip; every panel below is a copy of it, so the
    // whole turn is one coherent snapshot that cannot re-paginate under itself.
    flipSnapshot = buildFlipSnapshot();

    // The flip layer covers the WHOLE paper (margins included).
    const layer = document.createElement('div');
    layer.className = 'obr-flip-layer';
    layer.style.left = '0px';
    layer.style.top = '0px';
    layer.style.width = g.paperW + 'px';
    layer.style.height = g.paperH + 'px';

    // The destination page REVEALED as the leaf turns (forward: dest RIGHT; backward:
    // dest LEFT) — a frozen clone, so the whole turn is one coherent snapshot of exactly
    // what the reader sees and turns to. Without it, this half is drawn from the LIVE strip
    // and can visibly reflow mid-turn if a slow image finishes (and can disagree with the
    // leaf's already-frozen back face). It sits at the BOTTOM of the layer so the leaf lays
    // on top and sweeps it into view; the live strip (re-anchored by any deferred relayout)
    // reappears only once the turn ends and the layer is removed.
    const destLeft = fwd ? g.spineX : 0;
    const destBox = document.createElement('div');
    destBox.className = 'obr-flip-static';
    destBox.style.left = destLeft + 'px';
    destBox.style.width = g.pageW + 'px';
    destBox.style.height = g.paperH + 'px';
    destBox.appendChild(makePagesClone(g.padX - destLeft - next * stride, g.padY));
    layer.appendChild(destBox);      // bottom of the stack → revealed as the leaf lifts

    // The stationary page (forward: source LEFT page; backward: source RIGHT page) — a
    // full-page panel, opaque so the destination underneath doesn't bleed through.
    const staticLeft = fwd ? 0 : g.spineX;
    const staticBox = document.createElement('div');
    staticBox.className = 'obr-flip-static';
    staticBox.style.left = staticLeft + 'px';
    staticBox.style.width = g.pageW + 'px';
    staticBox.style.height = g.paperH + 'px';
    staticBox.appendChild(makePagesClone(g.padX - staticLeft - src * stride, g.padY));
    layer.appendChild(staticBox);    // staticBox next → the caller's leaf lays on top

    return { fwd, g, stride, layer, staticBox };
  }

  function bookFlip(dir, src, next) {
    // Snap the real strip to the destination, then build the flip overlay (full-paper layer
    // with the stationary source page already laid in). See beginFlip().
    const { fwd, g, stride, layer } = beginFlip(dir, src, next);

    // The turning leaf = the right page, hinged at the spine. Two full-page faces; the
    // back is pre-rotated 180deg about ITS OWN center (the double reflection lands it
    // un-mirrored on the opposite page when the leaf lays down).
    const sFront = fwd ? src : next;     // page shown on the front (toward the reader at rest)
    const sBack = fwd ? next : src;      // page shown on the back (after it lays down)
    const leaf = document.createElement('div');
    leaf.className = 'obr-leaf';
    leaf.style.left = g.spineX + 'px';
    leaf.style.width = g.pageW + 'px';
    leaf.style.height = g.paperH + 'px';
    const frontTx = g.padX - g.spineX - sFront * stride;
    const backTx = g.padX - sBack * stride;
    const front = buildFace('front', frontTx, g.padY);
    const back = buildFace('back', backTx, g.padY);
    leaf.appendChild(front.face);
    leaf.appendChild(back.face);

    const fromAngle = fwd ? 0 : -180;
    const toAngle = fwd ? -180 : 0;
    leaf.style.transform = `rotateY(${fromAngle}deg)`;

    layer.appendChild(leaf);         // staticBox already in layer (beginFlip); leaf lays on top
    paperEl.appendChild(layer);      // LAST child → real pagesEl stays first for querySelector
    // Bail to an instant turn rather than animate a page the reader never asked for.
    if (!flipOverlayValid(layer, src, next)) { abortFlipOverlay(layer); return; }

    // Animate (WAAPI — reliable finish hook + clean cancel for re-entrancy).
    const dur = settings.transitionMs;
    const easing = 'cubic-bezier(.22,.61,.36,1)';
    const anim = leaf.animate(
      [{ transform: `rotateY(${fromAngle}deg)` }, { transform: `rotateY(${toAngle}deg)` }],
      { duration: dur, easing, fill: 'forwards' }
    );
    // Each face dims as it stands edge-on (peak shading mid-turn), then lightens.
    const shadeFrames = [{ opacity: 0.05 }, { opacity: 0.5 }, { opacity: 0.05 }];
    const a2 = front.shade.animate(shadeFrames, { duration: dur, easing });
    const a3 = back.shade.animate(shadeFrames, { duration: dur, easing });

    activeFlip = { layer, anims: [anim, a2, a3] };
    anim.finished
      .then(() => { if (activeFlip && activeFlip.layer === layer) endActiveFlip(); })
      .catch(() => {});              // cancel() rejects with AbortError — already torn down
  }

  /* ------------------------------------------------- soft "curl" page turn -----
     Same additive model as bookFlip (snap the real strip to the destination, overlay a
     transient leaf), but the turning half-page BENDS like paper instead of staying rigid.
     The leaf rotates about the spine; inside it, the source's outer half is sliced into a
     nested chain of vertical strips, each rotated a little more than the last so the sheet
     curves into a smooth arc (uniform per-strip angle => circular bow). The bow grows to a
     peak early (while the page faces the reader) and relaxes back to FLAT by edge-on, so the
     curl only ever shows in the front half and the back half is a clean flat turn. A single
     flat back face shows the destination's inner page once the sheet passes edge-on. */
  const CURL_STRIPS = 16;     // slices across the turning half-page (more = smoother bend)
  const CURL_BEND = 6.5;      // peak degrees of bow added per strip. The invariant to respect
                              // is the free edge's NET rotation at the bow's peak: the leaf's own
                              // rotation there (~40deg) PLUS the cumulative bow (CURL_STRIPS *
                              // this ~= 104deg) must stay under 90 (here ~65deg). Past 90 the
                              // free-edge strips rotate beyond edge-on while the page still faces
                              // the reader, get back-culled, and expose the page behind them (a
                              // second page bleeding through). The bow also relaxes to flat by
                              // edge-on (see CURL_PEAK), so the back half is a clean flat turn.
  const CURL_PEAK = 0.32;     // when the bow is deepest (0..1): early, while the page faces
                              // the reader. The bow then relaxes to FLAT by edge-on (~0.5) and
                              // stays flat through the second half — so the curl is only ever
                              // shown while the page faces you, and the back-half is a clean
                              // rigid turn. (If the bow persisted past edge-on, heavily-bent
                              // free-edge strips would swing back to face the viewer and show
                              // the source page on top of the destination — a "page in the
                              // middle" double-image.)
  const CURL_OVERLAP = 1.0;   // px each strip is widened so neighbours overlap horizontally,
                              // hiding the sub-pixel hairline seams between strips as they bend.
  // The curl is a far richer motion than a flat slide, so it runs slower than the shared
  // transitionMs (otherwise the bend just flashes by). Still scales if the user raises it.
  const CURL_DURATION = (ms) => Math.max(760, Math.round(ms * 1.9));

  function curlFlip(dir, src, next) {
    // Snap the real strip to the destination, then build the flip overlay (full-paper layer
    // with the stationary source page already laid in). See beginFlip().
    const { fwd, g, stride, layer } = beginFlip(dir, src, next);

    // The curl leaf = the right page, hinged at the spine, rotates fromAngle -> toAngle.
    const sFront = fwd ? src : next;
    const sBack = fwd ? next : src;
    const leaf = document.createElement('div');
    leaf.className = 'obr-curl';
    leaf.style.left = g.spineX + 'px';
    leaf.style.width = g.pageW + 'px';
    leaf.style.height = g.paperH + 'px';

    // Single flat back face (the page shown after it lays down) — rigid-style 180 about the
    // leaf centre so its text reads correctly; only visible once the sheet passes edge-on.
    const back = document.createElement('div');
    back.className = 'obr-curl-back';
    back.appendChild(makePagesClone(g.padX - sBack * stride, g.padY));
    leaf.appendChild(back);

    // Nested front strips spanning the full page. Strip k shows the slice starting at
    // arc-length k*w (arc length is preserved along the bend, so the offset is exactly -k*w).
    const N = CURL_STRIPS;
    const w = g.pageW / N;
    const frontBaseTx = g.padX - g.spineX - sFront * stride;
    const segs = [];
    let parent = leaf;
    for (let k = 0; k < N; k++) {
      const seg = document.createElement('div');
      seg.className = 'obr-cseg' + (k === 0 ? '' : ' nested');
      seg.style.width = w + 'px';
      seg.style.height = g.paperH + 'px';
      const face = document.createElement('div');
      face.className = 'obr-cface';
      // Widen the clip window past the strip's slot so it overlaps the next strip and the
      // hairline seam disappears (horizontal only — strips are full-height vertical slices).
      face.style.width = (w + CURL_OVERLAP) + 'px';
      face.appendChild(makePagesClone(frontBaseTx - k * w, g.padY));
      const shade = document.createElement('div');
      shade.className = 'obr-leaf-shade';
      face.appendChild(shade);
      seg.appendChild(face);
      parent.appendChild(seg);
      parent = seg;          // nest the next strip at this one's right edge
      segs.push({ seg, shade });
    }

    layer.appendChild(leaf);         // staticBox already in layer (beginFlip); leaf lays on top
    paperEl.appendChild(layer);
    // Bail to an instant turn rather than animate a page the reader never asked for.
    if (!flipOverlayValid(layer, src, next)) { abortFlipOverlay(layer); return; }

    const dur = CURL_DURATION(settings.transitionMs);
    const fromA = fwd ? 0 : -180;
    const toA = fwd ? -180 : 0;
    const bend = CURL_BEND;     // both directions bow the same way (the free edge toward you)
    leaf.style.transform = `rotateY(${fromA}deg)`;
    const leafAnim = leaf.animate(
      [{ transform: `rotateY(${fromA}deg)` }, { transform: `rotateY(${toA}deg)` }],
      // Symmetric ease-in-out keeps the rotation EVEN, so edge-on lands at offset ~0.5 — the
      // bend (flat by 0.5) is then reliably gone before the back half. A fast-middle easing put
      // edge-on at ~0.33, leaving the page still bent past edge-on (the double-image).
      { duration: dur, easing: 'ease-in-out', fill: 'forwards' }
    );
    const anims = [leafAnim];
    // The bow lives ONLY in the half where the strips face the reader: the front half of a
    // forward turn (offset 0–0.5, leaf 0->-90) or the back half of a backward turn (0.5–1,
    // leaf -90->0). It peaks while the page is partway and is flat at edge-on (0.5) and when
    // laid flat — so the back-culled half never shows a bent page (no double-image), and a
    // backward turn curls just like a forward one. Shade darkens toward the free edge as it
    // bows, which reads as a rounded sheet rather than a flat board.
    const pkAt = fwd ? CURL_PEAK : 1 - CURL_PEAK;          // bow peak, in the front-facing half
    const flat = { transform: 'rotateY(0deg)' };
    const bowed = { transform: `rotateY(${bend}deg)` };
    const segFrames = fwd
      ? [{ ...flat, offset: 0 }, { ...bowed, offset: pkAt }, { ...flat, offset: 0.5 }, { ...flat, offset: 1 }]
      : [{ ...flat, offset: 0 }, { ...flat, offset: 0.5 }, { ...bowed, offset: pkAt }, { ...flat, offset: 1 }];
    segs.forEach(({ seg, shade }, k) => {
      anims.push(seg.animate(segFrames, { duration: dur, easing: 'ease-in-out', fill: 'forwards' }));
      const k01 = N > 1 ? k / (N - 1) : 0;       // 0 at the spine, 1 at the free edge
      const peak = 0.06 + 0.52 * k01;            // free edge curls into shadow
      const shadeFrames = fwd
        ? [{ opacity: peak * 0.12, offset: 0 }, { opacity: peak, offset: pkAt }, { opacity: 0, offset: 0.5 }, { opacity: 0, offset: 1 }]
        : [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: peak, offset: pkAt }, { opacity: peak * 0.12, offset: 1 }];
      anims.push(shade.animate(shadeFrames, { duration: dur, easing: 'ease-in-out' }));
    });

    activeFlip = { layer, anims };
    leafAnim.finished
      .then(() => { if (activeFlip && activeFlip.layer === layer) endActiveFlip(); })
      .catch(() => {});
  }

  // Tear down the current turn (idempotent). Safe at any instant: the real strip was moved
  // to the destination when the flip began, so there is nothing to re-settle — just remove
  // the transient overlay and restore the strip's normal transition.
  function endActiveFlip() {
    flipSnapshot = null;             // drop the frozen strip copy this turn was built from
    if (!activeFlip) return;
    const f = activeFlip;
    activeFlip = null;
    try { f.anims.forEach((a) => a.cancel()); } catch (e) { /* already finished */ }
    try { f.layer.remove(); } catch (e) { /* already detached */ }
    if (pagesEl) pagesEl.style.transition = '';
  }

  // Pagination is measured once from pagesEl.scrollWidth, but images inside the
  // article report height 0 until they load, and CJK/web fonts reflow on swap.
  // Either makes the first measurement too small — content collapses, the column
  // count comes out short, and the tail of the article becomes unreachable (a
  // blank spread you can't flip past). So re-measure (keeping the current spread)
  // whenever a still-loading image finishes or the fonts settle.
  // Run a queued late-media re-pagination — but NEVER on top of an in-flight page turn.
  // A turn is a static snapshot of the strip (cloned columns) animating for up to ~760ms;
  // re-paginating under it swaps the content out mid-swing (the turn lands on the wrong
  // page) and layout()'s endActiveFlip() would abort the animation partway. The real strip
  // is already snapped to the turn's destination, so deferring the re-measure until the
  // turn settles is invisible — just retry a beat later.
  function runMediaRelayout() {
    if (!active || !built) return;
    if (activeFlip) { scheduleMediaRelayout(); return; } // let the turn finish, then re-measure
    layout(true);
  }
  function scheduleMediaRelayout() {
    clearTimeout(mediaTimer);
    // Null the id when it fires so `mediaTimer` is a reliable "relayout pending" flag for
    // flip()'s flush (runMediaRelayout may re-arm it via this same path when it defers).
    mediaTimer = setTimeout(() => { mediaTimer = null; runMediaRelayout(); }, 80);
  }

  function onFontsLoadingDone() { if (active && built) scheduleMediaRelayout(); }

  function watchMedia() {
    pagesEl.querySelectorAll('img').forEach((img) => {
      if (img.complete && img.naturalHeight !== 0) return; // already sized
      img.addEventListener('load', scheduleMediaRelayout, { once: true });
      img.addEventListener('error', scheduleMediaRelayout, { once: true });
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (active && built) scheduleMediaRelayout(); });
      // fonts.ready resolves ONCE, for the faces pending at that moment. A face first
      // requested later — the bold or italic cut of the reader's stack, only fetched when a
      // glyph run needing it is laid out — swaps in afterwards and re-breaks every column
      // with no other signal, leaving totalColumns stale. `loadingdone` fires for EVERY
      // batch, so it covers those. It fires for the HOST page's fonts too, hence the
      // active/built gate — and it must stay a NAMED function, because the dedupe that makes
      // the repeated addEventListener across opens a no-op needs a stable reference (an
      // inline arrow would subscribe again on every open).
      try { document.fonts.addEventListener('loadingdone', onFontsLoadingDone); } catch (e) { /* older FontFaceSet */ }
    }
  }

  /* ---------------------------------------------------------------- controls */
  function changeFont(dir) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.fontSize + dir));
    if (next === settings.fontSize) return;
    // Capture reading position as a fraction BEFORE the font change reflows the
    // content (column count changes, so the spread index isn't portable — the
    // progress fraction is). Without this, re-paginating would snap back to p.1.
    const anchor = totalColumns > 0 ? (currentSpread * pagesPerSpread) / totalColumns : 0;
    restoreFraction = null; // live anchor supersedes any pending resume
    settings.fontSize = next;
    OBR.saveSettings({ fontSize: next });
    layout(true, anchor);
    showChrome();
  }

  function cycleTheme() {
    // Cycle the three concrete themes only (not 'auto'). Starting from the currently
    // *resolved* theme means each press changes the visible look, and pressing T while
    // on 'auto' exits it into an explicit choice rather than re-picking the same look.
    const idx = (THEMES.indexOf(resolveTheme()) + 1) % THEMES.length;
    settings.theme = THEMES[idx];
    overlay.className = 'obr-overlay ' + settings.theme;
    OBR.saveSettings({ theme: settings.theme });
    showChrome();
  }

  const COLUMN_OPTS = [2, 3, 4];
  function cycleColumns() {
    // Preserve reading position across the re-pagination (same fraction-anchor
    // trick as changeFont — the spread index isn't portable when the column
    // count changes, but the progress fraction is).
    const anchor = totalColumns > 0 ? (currentSpread * pagesPerSpread) / totalColumns : 0;
    restoreFraction = null; // live anchor supersedes any pending resume
    const idx = (COLUMN_OPTS.indexOf(settings.columns) + 1) % COLUMN_OPTS.length;
    settings.columns = COLUMN_OPTS[idx];
    OBR.saveSettings({ columns: settings.columns });
    updateColumnsBtn();
    layout(true, anchor);
    showChrome();
  }

  function updateColumnsBtn() {
    const btn = overlay && overlay.querySelector('[data-act="columns"]');
    if (btn) btn.textContent = '⊞ ' + Math.max(2, Math.min(4, settings.columns || 2));
  }

  // Advertise how many gallery-worthy images the page has, on the Images segment
  // (e.g. "🖼 Images · 42"), so the value of switching is visible before the jump.
  // Hidden when there are none, or if the gallery engine isn't loaded.
  function updateImagesBadge() {
    const badge = overlay && overlay.querySelector('.obr-seg-badge');
    if (!badge) return;
    let n = 0;
    try { n = (OBR._imageCount && OBR._imageCount()) || 0; } catch (e) { n = 0; }
    if (n > 0) { badge.textContent = ' · ' + n; badge.hidden = false; }
    else { badge.textContent = ''; badge.hidden = true; }
  }

  /* ---------------------------------------------------------------- open/close */
  // opts.trigger === 'auto': opened by the auto-open sentinel (no gesture) — show the
  // transient "Auto-opened" chip with its escape hatch.
  // RE-ENTRANCY GUARD. `active` is only set at the very END of openInner, after ~5 awaits
  // (settings, saved pick, position/engage/lifetime), so for that whole window `if (active)`
  // guards nothing. A second trigger in the window used to start a RIVAL open, and since each
  // open does `++openGen`, the newcomer CANCELLED the in-flight one at its next gen check. Mash
  // the shortcut because nothing has appeared yet and you cancel every attempt in turn — the
  // reader only opens once you stop pressing. That is the "shortcut sometimes doesn't work /
  // takes several tries" report; a debug-timing trace showed 4x "start" with a single completed
  // run. First trigger wins, extra triggers are ignored until it finishes. close() can still
  // cancel an in-flight open via openGen — that direction is deliberate and still works.
  let opening = false;
  async function open(opts) {
    if (active || opening) return;
    opening = true;
    try { await openInner(opts); } finally { opening = false; }
  }

  async function openInner(opts) {
    if (active) return;
    const trigger = opts && opts.trigger;
    // The page-turn diagnostics describe the article being read, and `why` carries tag/class
    // strings lifted from its DOM — leaving them set would report the PREVIOUS article (on a
    // different site) as if it were this one.
    flipDesyncs = 0; lastFlipDesync = null;
    const gen = ++openGen; // claim this open; abort below if a newer open()/close() supersedes us
    const t = OBR._timer ? OBR._timer('[OBR reader]') : null; // local debug timing (see settings.js)
    settings = await OBR.loadSettings();
    if (gen !== openGen) return;
    if (t) t.mark('settings');
    if (OBR.closeGallery) OBR.closeGallery({ suppress: false }); // ensure image mode isn't also showing (defensive — not a user dismissal)
    build();
    applyStylesheet();
    overlay.className = 'obr-overlay ' + resolveTheme();
    updateColumnsBtn();
    updateImagesBadge();
    if (t) t.mark('build');

    // Choose the content source. An explicit text selection wins — read EXACTLY
    // what's highlighted (gated by the readSelection setting). Otherwise the whole
    // page. (A saved per-site pick slots in between these in Phase 3.) An ad-hoc
    // selection is transient, so it doesn't resume or persist the whole-page
    // reading position (posKey stays empty → no load, no save).
    // currentSelection() is read SYNC first (before any await) so a later await can't
    // race the user's selection. A saved per-site pick is only consulted when there's
    // no live selection.
    const sel = settings.readSelection ? currentSelection() : null;
    let savedArticle = null;
    if (!sel && OBR.loadPick) {
      const savedSel = await OBR.loadPick(OBR.normalizeHost(location.href));
      if (gen !== openGen) return;
      // null if the saved selector matches nothing now (stale) → falls through to whole page.
      savedArticle = savedSel ? extractFromSelector(savedSel) : null;
    }
    extractionSuspect = false; // only the whole-page branch (below) may set it true
    if (sel) {
      lastArticle = extractFromSelection(sel);
      pickNode = null;
      contentSource = 'selection';
      posKey = '';
    } else if (savedArticle) {
      lastArticle = savedArticle;
      pickNode = null;
      contentSource = 'pick-saved';
      // Resume the picked-content reading independently of the whole-page position.
      posKey = OBR.positionKey ? OBR.positionKey() + '#pick' : '';
    } else {
      lastArticle = extractArticle();
      pickNode = null;
      contentSource = 'whole';
      posKey = OBR.positionKey ? OBR.positionKey() : '';
      extractionSuspect = wholeExtractionSuspect(lastArticle); // only auto-nag when it looks wrong
    }
    if (t) t.mark('extract'); // clone + Readability (+ loadPick storage read on the saved-pick path)
    renderContent(lastArticle);
    updatePickHint();
    if (t) t.mark('render');

    // Resume where the user last left off in this article (null if never read or
    // storage unavailable). Held as a fraction; layout() re-anchors it through the
    // late-image settle window until the user navigates. Deliberately awaited
    // BEFORE the first layout/show so the reader opens directly at the resumed
    // page — not flash page 1 then jump. (It also avoids a close()-before-resume
    // race that would flush spread 0 over the real saved position.) The read is a
    // few ms on a real storage backend. The WHOLE entry loads (not just the fraction):
    // the colophon needs the accumulated reading time + finished flag, and the
    // engagement/lifetime state rides the same parallel await.
    const [entry, engage, lifetime] = await Promise.all([
      posKey && OBR.loadPositionEntry ? OBR.loadPositionEntry(posKey) : null,
      OBR.loadEngage ? OBR.loadEngage() : {},
      OBR.loadLifetime ? OBR.loadLifetime() : {},
    ]);
    if (gen !== openGen) return;
    restoreFraction = entry && typeof entry.f === 'number' ? entry.f : null;
    priorMs = entry && typeof entry.ms === 'number' ? entry.ms : 0;
    priorFin = !!(entry && entry.fin);
    engageState = engage || {};
    lifetimeStats = lifetime || {};
    if (t) t.mark('resume'); // per-article position + engagement/lifetime storage reads

    savedScrollY = window.scrollY;
    host.style.display = '';
    document.documentElement.style.overflow = 'hidden';
    active = true;
    readMs = 0;
    lastTick = Date.now();
    colSeenThisOpen = false;
    openedByAuto = trigger === 'auto';
    if (OBR.bumpUsage) OBR.bumpUsage(); // engagement counters: opens + distinct days (local)
    showChrome(); // show controls briefly, then auto-hide
    requestAnimationFrame(() => { layout(false); if (t) { t.mark('layout'); t.flush('src=' + contentSource); } });
    watchMedia(); // re-paginate once late-loading images / fonts settle
    if (trigger === 'auto' && OBR._showAutoChip) OBR._showAutoChip('opened');
    OBR._opensCompleted = (OBR._opensCompleted || 0) + 1; // test hook: full inits that ran to completion
    schedulePaintCheck();
  }

  /* ------------------------------------------------- did the reader actually appear?
   * Every internal signal can say "opened" while the user sees nothing: the host can be
   * removed by a framework that rebuilds the document, and the overlay can be painted under a
   * site layer in the top layer (an open <dialog> or a fullscreen element beats any z-index).
   * `active` cannot see either. So verify against what is PAINTED — elementFromPoint at the
   * middle of the viewport, which returns the shadow HOST for anything inside our root.
   *
   * The verdict is kept on OBR._paintCheck and rides along in a report, so "it doesn't work on
   * this site" arrives naming the element that covered us instead of needing a reproduction. */
  let paintTimer = 0;
  let reattached = false;
  let hostWatch = null;
  function schedulePaintCheck() {
    clearTimeout(paintTimer);
    // One check, ~400ms after opening: late enough for layout and for a lazy cookie/chat widget
    // to have inserted itself, early enough that the user is still looking at the page.
    paintTimer = setTimeout(() => { try { paintCheck(); } catch (e) { /* never break an open */ } }, 400);
    // A timer alone cannot catch a re-render that lands LATER — and being deleted an hour into
    // a long read is the same failure as being deleted immediately. childList on
    // documentElement only (no subtree): our host is its direct child, so this fires on the one
    // mutation that can remove it and stays blind to everything the page does inside <body>.
    try {
      if (!hostWatch) {
        hostWatch = new MutationObserver(() => {
          if (active && host && !host.isConnected) paintCheck();
        });
      }
      hostWatch.observe(document.documentElement, { childList: true });
    } catch (e) { /* no observer — the timed check still runs */ }
  }

  function describeEl(el) {
    if (!el) return 'nothing';
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    let z = '';
    try { z = getComputedStyle(el).zIndex; } catch (e) { /* */ }
    return el.tagName.toLowerCase() + id + cls + (z && z !== 'auto' ? ' z=' + z : '');
  }

  function paintCheck() {
    if (!active || !host) return;
    // The host was deleted out from under us (a re-render of <html>). The shadow root and its
    // content live on in this reference, so putting the host back restores the whole reader.
    // Once only: a page that wipes on a schedule would otherwise get an endless duel.
    if (!host.isConnected) {
      if (reattached) return void verdict('host-removed', 'nothing');
      reattached = true;
      try { document.documentElement.appendChild(host); } catch (e) { return void verdict('host-removed', 'nothing'); }
    }
    const el = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    if (el === host || (el && host.contains(el))) return void verdict('ok', '');
    verdict('covered', describeEl(el));
  }

  function verdict(state, by) {
    OBR._paintCheck = { state: state, by: by };
    if (state === 'ok') return;
    // Console first, unconditionally — the same rule the worker's failure paths follow.
    try { console.warn('[OpenBookReader] the reader opened but is not what the page is showing: ' + state + (by ? ' (' + by + ')' : '')); } catch (e) { /* */ }
    if (OBR._notice) {
      OBR._notice({
        text: OBR.t(state === 'covered' ? 'noticeCovered' : 'noticeHostRemoved'),
        actions: [
          { label: OBR.t('noticeReport'), act: 'report' },
          { label: OBR.t('noticeDismiss'), act: 'dismiss' },
        ],
        source: 'paint-check',
      });
    }
  }

  // Records a USER-initiated dismissal (Esc, ✕, toolbar toggle-off) into the shared
  // suppression set so the auto-open sentinel never re-opens this page in the same page
  // session (SPA back/forward). Internal close paths — the in-overlay mode switch and
  // the gallery's defensive cross-close — pass { suppress: false }: the user is still
  // reading, not dismissing.
  function close(opts) {
    openGen++; // invalidate any in-flight open() (e.g. the gallery taking over mid-open)
    if (!active) return;
    if (!(opts && opts.suppress === false) && OBR._autoSuppress) OBR._autoSuppress();
    if (pickerActive) endPicker(null); // tear down picker listeners/scroll-unlock first
    clearTimeout(paintTimer); // a close before the check lands must not nag about a closed reader
    if (hostWatch) { try { hostWatch.disconnect(); } catch (e) { /* */ } }
    endActiveFlip(); // no orphaned leaf if the user closes mid-turn
    clearTimeout(mediaTimer); mediaTimer = null; // drop any pending late-image relayout for this open
    // Flush the reading position now (don't wait out the debounce — the tab may go away).
    flushPosition();
    flushReadingTime();
    host.style.display = 'none';
    document.documentElement.style.overflow = '';
    window.scrollTo(0, savedScrollY);
    active = false;
    // The one moment the engagement chip may appear: after a USER-initiated close — the
    // reading is over, nothing gets interrupted. Mode switches / cross-closes never ask.
    // Nor does dismissing an AUTO-opened session the user never finished: they may be
    // closing something they didn't want — the worst possible instant to ask for a rating.
    if (!(openedByAuto && !finishedThisOpen)
      && !(opts && opts.suppress === false) && OBR._maybeEngageAsk) OBR._maybeEngageAsk();
  }

  function toggle() { active ? close() : open(); }

  OBR.open = open;
  OBR.close = close;
  OBR.toggle = toggle;

  // Debug-mode state snapshot (see settings.js `debugTiming`). The SW reads this on every
  // trigger, which is what makes a FAILED trigger explainable instead of silent: `active` says
  // whether a toggle will open or close, `opening` catches a wedged in-flight open, and
  // `hostShown` catches "it opened but you can't see it" (the host hidden by a stale close).
  // flipDesyncs/lastFlipDesync answer the other unreproducible report — "the page turn
  // sometimes shows the wrong page" — with a number instead of a maybe (see noteFlipDesync).
  OBR._diagReader = function () {
    return {
      active: active, opening: opening, gen: openGen, built: built,
      spread: currentSpread, cols: totalColumns,
      hostShown: !!(host && host.style.display !== 'none'),
      flipDesyncs: flipDesyncs, lastFlipDesync: lastFlipDesync,
    };
  };

  /* ---------------------------------------------------------------- events */
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (!active || pickerActive) return; // don't relayout against the hidden overlay mid-pick
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!pickerActive) layout(true); }, 150);
  });

  document.addEventListener('keydown', (e) => {
    if (!active || pickerActive) return; // picker owns the keyboard while it's up
    tickRead(); // keyboard activity keeps the reading clock's gaps small
    // Let modifier combos fall through to the browser for zoom (Ctrl/Cmd+±) and new tab
    // (Cmd+T). Print is the deliberate exception: Cmd/Ctrl+P stays captured so it runs the
    // reader's CLEAN print (printReader) rather than the browser printing the clipped overlay
    // spread — the exact output that feature exists to replace.
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ':
        e.preventDefault(); e.stopPropagation(); flip(1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        e.preventDefault(); e.stopPropagation(); flip(-1); break;
      case 'Home': e.preventDefault(); endActiveFlip(); restoreFraction = null; currentSpread = 0; applySpread(); break;
      case 'End': e.preventDefault(); endActiveFlip(); restoreFraction = null; currentSpread = totalSpreads - 1; applySpread(); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
      case '+': case '=': if (mod) break; e.preventDefault(); changeFont(1); break;
      case '-': case '_': if (mod) break; e.preventDefault(); changeFont(-1); break;
      case 't': case 'T': if (mod) break; e.preventDefault(); cycleTheme(); break;
      case 'p': case 'P': e.preventDefault(); printReader(); break; // capture Cmd/Ctrl+P too — clean print, not the clipped native one
    }
  }, true);

  // A tab can go away — closed, navigated in-page, or discarded while backgrounded —
  // inside the 400ms persist debounce, which would lose the last page turn (resume
  // lands a page early). Flush synchronously on both MV3-safe signals: pagehide covers
  // unload / bfcache; visibilitychange -> hidden catches a backgrounded tab the browser
  // may discard without ever firing pagehide. (Deliberately NOT beforeunload — it is
  // unreliable and blocks bfcache under MV3.)
  window.addEventListener('pagehide', () => { flushPosition(); flushReadingTime(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushPosition(); flushReadingTime(); }
    else if (active) lastTick = Date.now(); // tab is back — resume the reading clock
  });

  // Live-apply settings changed elsewhere (e.g. the Options page) to an open reader.
  if (globalThis.chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !active || pickerActive || !built || !changes[OBR.STORAGE_KEY]) return;
      OBR.loadSettings().then((s) => {
        if (pickerActive) return; // overlay is hidden mid-pick; re-apply on the next open instead
        const wasHidden = overlay.classList.contains('obr-chrome-hidden');
        settings = s;
        overlay.className = 'obr-overlay ' + resolveTheme() + (wasHidden ? ' obr-chrome-hidden' : '');
        pagesEl.style.fontFamily = FONT_STACKS[settings.fontFamily] || FONT_STACKS.serif;
        updateColumnsBtn();
        applyStylesheet();
        layout(true);
      });
    });
  }

  // Follow the OS color scheme live while the 'auto' theme is selected — flip the overlay
  // between paper and dark as the system toggles (e.g. scheduled dark mode) without
  // disturbing the auto-hidden chrome state. Attaches once at injection (like keydown /
  // onChanged) and is inert unless 'auto' is the active preference on an open reader.
  try {
    systemDark.addEventListener('change', () => {
      if (!active || !built || settings.theme !== 'auto') return;
      const wasHidden = overlay.classList.contains('obr-chrome-hidden');
      overlay.className = 'obr-overlay ' + resolveTheme() + (wasHidden ? ' obr-chrome-hidden' : '');
    });
  } catch (e) { /* MediaQueryList.addEventListener unavailable */ }
})();
