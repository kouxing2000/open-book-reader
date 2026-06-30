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

    overlay = document.createElement('div');
    overlay.className = 'obr-overlay ' + resolveTheme();
    overlay.innerHTML = `
      <div class="obr-topbar">
        <span class="obr-doc-title"></span>
        <span class="obr-doc-meta"></span>
        <span class="obr-controls">
          <button class="obr-btn" data-act="font-" title="Smaller font (−)">A−</button>
          <button class="obr-btn" data-act="font+" title="Larger font (+)">A+</button>
          <button class="obr-btn" data-act="theme" title="Cycle paper / light / dark (T)">Theme</button>
          <button class="obr-btn" data-act="columns" title="Columns per spread (2 / 3 / 4)">⊞ 2</button>
          <span class="obr-seg" role="group" aria-label="Reading mode">
            <button class="obr-seg-btn is-active" data-act="text" aria-current="true" title="You are in text reader">${ICON_BOOK}<span>Text</span></button>
            <button class="obr-seg-btn" data-act="images" title="Switch to image gallery">${ICON_IMAGES}<span>Images</span><span class="obr-seg-badge" hidden></span></button>
          </span>
          <button class="obr-btn" data-act="pick" title="Wrong content? Pick the block on the page">⌖ Pick</button>
          <button class="obr-btn" data-act="print" title="Print or save as PDF (P)">🖨 Print</button>
          <button class="obr-btn" data-act="report" title="Report a problem on this page (opens an email)">⚠ Report</button>
          <button class="obr-btn" data-act="settings" title="Open settings">⚙ Settings</button>
          <button class="obr-btn" data-act="close" title="Close reader (Esc)">✕ Close</button>
        </span>
      </div>
      <div class="obr-book">
        <div class="obr-paper">
          <div class="obr-viewport"><div class="obr-pages"></div></div>
          <div class="obr-spine"></div>
          <div class="obr-zone obr-zone-left"></div>
          <div class="obr-zone obr-zone-right"></div>
        </div>
      </div>
      <div class="obr-footer">
        <span class="obr-indicator"></span>
        <span class="obr-hint">← / → flip · ↑↓ / Space · +/− font · T theme · P print · Esc exit</span>
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

    overlay.querySelector('.obr-zone-left').addEventListener('click', () => flip(-1));
    overlay.querySelector('.obr-zone-right').addEventListener('click', () => flip(1));
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
    if (act === 'images') { close(); if (OBR.openGallery) OBR.openGallery(); return; }
  }

  /* ----------------------------------------------------- print / save as PDF */
  // Pure: build a complete standalone print document from the cleaned article.
  // Deliberately a flat, vertically-flowing page (no columns / transform / fixed
  // height / overflow clip) so the browser paginates it onto paper — the screen
  // reader's layout would otherwise print as a single clipped horizontal spread.
  // Always a white paper theme (printing the dark/sepia screen theme wastes ink);
  // honors the reader's font family + line-height, but sizes in paper points since
  // screen px don't map to paper. Exposed for unit testing, like _buildReportMailto.
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
      .obr-print-source { margin-top: 2em; padding-top: .8em; border-top: 1px solid #ddd; font-size: .8em; color: #777; word-break: break-all; }`;
  }
  function buildPrintDoc({ title, byline, content, fontFamily, lineHeight, url }) {
    const t = escapeHTML(title || '');
    return '<!doctype html><html><head><meta charset="utf-8">'
      + `<title>${t || 'Article'}</title><style>${printCSS({ fontFamily, lineHeight })}</style></head>`
      + `<body><h1>${t}</h1>`
      + (byline ? `<div class="obr-print-byline">${escapeHTML(byline)}</div>` : '')
      + (content || '<p>Could not extract a readable article from this page.</p>')
      + (url ? `<div class="obr-print-source">${escapeHTML(url)}</div>` : '')
      + '</body></html>';
  }
  OBR._buildPrintDoc = buildPrintDoc;

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

    const docHtml = buildPrintDoc({
      title, byline, content,
      fontFamily: settings.fontFamily, lineHeight: settings.lineHeight, url,
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
  // Strip live-script vectors from an extracted-content HTML string: <script>/<style>/
  // <noscript>, every inline on* handler, and javascript: URLs. Vendored Readability is NOT
  // a sanitizer (it keeps e.g. <img onerror>), and we inject content via innerHTML into the
  // reader's Shadow DOM and the print iframe — so EVERY content path (Readability and the
  // rawFallback) runs through this, making the "no live handlers" trust model actually true.
  // innerHTML never executes <script> or fires handlers on insertion; we remove on* before any
  // later event (e.g. an <img onerror> after hydrateLazyImages rewrites its src) can fire.
  function sanitizeContentHTML(html) {
    try {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
      doc.querySelectorAll('*').forEach((n) => {
        for (const a of Array.from(n.attributes)) {
          const name = a.name.toLowerCase();
          // srcdoc carries inline HTML that an <iframe> runs in THIS page's origin —
          // a path our <script>/on* stripping above never sees. Drop it (src-based
          // embeds like videos still work). Keep no equivalent for <iframe src> so
          // legit https embeds survive.
          if (name.startsWith('on') || name === 'srcdoc') n.removeAttribute(a.name);
          else if ((name === 'href' || name === 'src' || name === 'xlink:href'
            || name === 'action' || name === 'formaction') // form*action can also carry javascript:
            && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
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
      const loose = new Readability(base.cloneNode(true));
      // Disable conditional cleaning by clearing its flag. Reaches into the
      // vendored Readability's internals (_flags / FLAG_CLEAN_CONDITIONALLY,
      // present as of the bundled version); guard so a future upstream rename
      // degrades to a normal parse instead of silently NaN-ing the flag.
      if (typeof loose._flags === 'number' && loose.FLAG_CLEAN_CONDITIONALLY) {
        loose._flags &= ~loose.FLAG_CLEAN_CONDITIONALLY;
      }
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
         <span><b>Pick the content</b> — hover a block, click to read it. <b>↑</b> widen · <b>↓</b> narrow · <b>Esc</b> cancel</span>
         <button class="obr-pickcancel">Cancel</button>
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
        html = `<span class="obr-pick-msg">Wrong content?</span>
          <button class="obr-btn" data-pick="start">⌖ Pick the block</button>`;
      }
    } else if (contentSource === 'pick-manual') {
      html = `<span class="obr-pick-msg">Reading the block you picked.</span>
        <button class="obr-btn" data-pick="save">Save for this site</button>`;
    } else if (contentSource === 'pick-saved') {
      html = `<span class="obr-pick-msg">Auto-picked content for this site.</span>
        <button class="obr-btn" data-pick="fullpage">Use full page</button>
        <button class="obr-btn" data-pick="clear">Clear pick</button>`;
    }
    if (!html) { pickHintEl.classList.remove('show'); pickHintEl.innerHTML = ''; return; }
    html += `<button class="obr-pick-x" data-pick="dismiss" title="Dismiss">✕</button>`;
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
      + `<button class="obr-pick-x" data-pick="dismiss" title="Dismiss">✕</button>`;
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
    updatePickHint();
    requestAnimationFrame(() => layout(false));
    watchMedia();
  }

  function saveCurrentPick() {
    if (!pickNode) return;
    const sel = cssPathFor(pickNode);
    if (!sel) return flashPickMsg('Could not save - this block has no stable selector. Re-pick a parent block.');
    if (!OBR.savePick) return;
    OBR.savePick(OBR.normalizeHost(location.href), sel).then((ok) => {
      if (ok === false) return flashPickMsg('Could not save - storage is full. Remove some saved picks in Options.');
      contentSource = 'pick-saved'; // now the durable per-site pick
      updatePickHint();
    });
  }

  function clearCurrentPick() {
    if (OBR.clearPick) OBR.clearPick(OBR.normalizeHost(location.href));
    reExtractWholePage();
  }

  // "Article-ness" signal for the toolbar auto-mode (gallery.js `_autoToggle`): the
  // number of words that live in SUBSTANTIAL prose blocks on the page. We count a
  // block (<p>/<blockquote>/<li>) only when it holds >= MIN_PARA_WORDS itself — a real
  // article is carried by big paragraphs, whereas captions, nav, tags and one-line
  // snippets (an image board's "text") are short and don't count. Read straight off
  // the live DOM rather than Readability's extraction, so it still scores a real
  // article even when extraction undercounts, and it's far cheaper than a full parse.
  // (Our own UI is in Shadow DOM, so querySelectorAll never sees it.)
  const MIN_PARA_WORDS = 20;
  // CJK (incl. compatibility ideographs), kana, and hangul write without spaces, so a
  // whole Chinese/Japanese/Korean paragraph is ONE whitespace token — it would never
  // clear MIN_PARA_WORDS and proseWordCount would read ~0 on a real CJK article. That
  // mis-scores the toolbar auto-mode: an image-rich Chinese page (forum, blog) looks
  // text-less and opens the gallery instead of the reader. Count each CJK/kana/hangul
  // glyph as its own word, plus the space-delimited tokens of whatever's left (Latin,
  // digits, punctuation). Pure-Latin text is unaffected (the class matches nothing).
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\uff66-\uff9f]/g;
  function wordsIn(el) {
    const t = el.textContent.trim();
    if (!t) return 0;
    const cjk = (t.match(CJK_RE) || []).length;
    return cjk + (t.replace(CJK_RE, ' ').match(/\S+/g) || []).length;
  }
  function proseWordCount() {
    let total = 0;
    document.querySelectorAll('p, blockquote, li').forEach((el) => {
      if (el.querySelector('p, blockquote, li')) return; // count leaf blocks, no nesting double-count
      const w = wordsIn(el);
      if (w >= MIN_PARA_WORDS) total += w;
    });
    return total;
  }
  OBR._articleWordCount = proseWordCount;

  // CJK-aware word count of a plain string — same TOKENIZATION as wordsIn (so the ratio below
  // isn't skewed by a Latin-vs-CJK scoring mismatch). Note it counts ALL of the extracted text,
  // whereas proseWordCount counts only substantial leaf p/blockquote/li blocks — a deliberate
  // asymmetry that inflates `kept`, biasing toward NOT flagging (fewer false nags).
  function countWords(text) {
    const t = (text || '').trim();
    if (!t) return 0;
    return (t.match(CJK_RE) || []).length + (t.replace(CJK_RE, ' ').match(/\S+/g) || []).length;
  }
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
      : '<p>Could not extract a readable article from this page. Select the text and reopen, or use the ⌖ Pick button to choose the content block yourself.</p>';
    titleEl.textContent = title || '';
    // Estimated reading time from the live-DOM prose word count (handles CJK too).
    const words = OBR._articleWordCount ? OBR._articleWordCount() : 0;
    const mins = OBR.readingTimeMin ? OBR.readingTimeMin(words) : 0;
    if (metaEl) metaEl.textContent = mins ? `~${mins} min` : '';
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

    void pagesEl.offsetWidth; // force reflow before measuring
    const total = pagesEl.scrollWidth;
    totalColumns = Math.max(1, Math.round((total + colGap) / (colW + colGap)));
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
    indicatorEl.textContent =
      (left === right ? `${left}` : `${left}–${right}`) + `  /  ${totalColumns} pages`;
    if (progressFillEl) {
      const pct = totalSpreads <= 1 ? 1 : currentSpread / (totalSpreads - 1);
      progressFillEl.style.width = Math.round(pct * 100) + '%';
    }
    persistPosition();
  }

  // Save the current reading position (debounced) so the reader can resume here.
  function persistPosition() {
    if (!posKey || totalColumns < 1 || !OBR.savePosition) return;
    const f = (currentSpread * pagesPerSpread) / totalColumns;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => OBR.savePosition(posKey, f), 400);
  }

  function flip(dir) {
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

  // A clone of the real strip, frozen and shifted so a clip window reveals chosen columns.
  // tx aligns the columns horizontally; ty pushes the text down by the page's top margin so
  // the panel (sized to the full paper page) shows the text with its margins, like a real page.
  function makePagesClone(tx, ty) {
    const clone = pagesEl.cloneNode(true);
    clone.classList.add('obr-leaf-pages');     // keep .obr-pages too (it carries the styling)
    clone.style.transition = 'none';
    clone.style.willChange = 'auto';           // don't spawn a compositor layer per clone
    clone.style.transform = `translateX(${tx}px)`;
    if (ty) clone.style.top = ty + 'px';
    return clone;
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
    // no slide, so the final state matches the plain-flip path synchronously.
    pagesEl.style.transition = 'none';
    currentSpread = next;
    applySpread();

    // Geometry. A "page" is the full PAPER half — text column PLUS its white margins — not
    // just the text area, so the turning leaf matches the page the reader sees. pageGeom()
    // gives the paper-relative spine, page width/height, and the margins.
    const stride = pagesPerSpread * (colW + colGap);
    const g = pageGeom();

    // The flip layer covers the WHOLE paper (margins included).
    const layer = document.createElement('div');
    layer.className = 'obr-flip-layer';
    layer.style.left = '0px';
    layer.style.top = '0px';
    layer.style.width = g.paperW + 'px';
    layer.style.height = g.paperH + 'px';

    // The stationary page (forward: source LEFT page; backward: source RIGHT page) — a
    // full-page panel, opaque so the destination underneath doesn't bleed through.
    const staticLeft = fwd ? 0 : g.spineX;
    const staticBox = document.createElement('div');
    staticBox.className = 'obr-flip-static';
    staticBox.style.left = staticLeft + 'px';
    staticBox.style.width = g.pageW + 'px';
    staticBox.style.height = g.paperH + 'px';
    staticBox.appendChild(makePagesClone(g.padX - staticLeft - src * stride, g.padY));
    layer.appendChild(staticBox);    // staticBox first → the caller's leaf lays on top

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
  function scheduleMediaRelayout() {
    clearTimeout(mediaTimer);
    mediaTimer = setTimeout(() => { if (active && built) layout(true); }, 80);
  }

  function watchMedia() {
    pagesEl.querySelectorAll('img').forEach((img) => {
      if (img.complete && img.naturalHeight !== 0) return; // already sized
      img.addEventListener('load', scheduleMediaRelayout, { once: true });
      img.addEventListener('error', scheduleMediaRelayout, { once: true });
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (active && built) scheduleMediaRelayout(); });
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
  async function open() {
    if (active) return;
    const gen = ++openGen; // claim this open; abort below if a newer open()/close() supersedes us
    settings = await OBR.loadSettings();
    if (gen !== openGen) return;
    if (OBR.closeGallery) OBR.closeGallery(); // ensure image mode isn't also showing
    build();
    applyStylesheet();
    overlay.className = 'obr-overlay ' + resolveTheme();
    updateColumnsBtn();
    updateImagesBadge();

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
    renderContent(lastArticle);
    updatePickHint();

    // Resume where the user last left off in this article (null if never read or
    // storage unavailable). Held as a fraction; layout() re-anchors it through the
    // late-image settle window until the user navigates. Deliberately awaited
    // BEFORE the first layout/show so the reader opens directly at the resumed
    // page — not flash page 1 then jump. (It also avoids a close()-before-resume
    // race that would flush spread 0 over the real saved position.) The read is a
    // few ms on a real storage backend.
    restoreFraction = posKey && OBR.loadPosition ? await OBR.loadPosition(posKey) : null;
    if (gen !== openGen) return;

    savedScrollY = window.scrollY;
    host.style.display = '';
    document.documentElement.style.overflow = 'hidden';
    active = true;
    showChrome(); // show controls briefly, then auto-hide
    requestAnimationFrame(() => layout(false));
    watchMedia(); // re-paginate once late-loading images / fonts settle
    OBR._opensCompleted = (OBR._opensCompleted || 0) + 1; // test hook: full inits that ran to completion
  }

  function close() {
    openGen++; // invalidate any in-flight open() (e.g. the gallery taking over mid-open)
    if (!active) return;
    if (pickerActive) endPicker(null); // tear down picker listeners/scroll-unlock first
    endActiveFlip(); // no orphaned leaf if the user closes mid-turn
    clearTimeout(mediaTimer); // drop any pending late-image relayout for this open
    // Flush the reading position now (don't wait out the debounce — the tab may go away).
    clearTimeout(saveTimer);
    if (posKey && totalColumns >= 1 && OBR.savePosition) {
      OBR.savePosition(posKey, (currentSpread * pagesPerSpread) / totalColumns);
    }
    host.style.display = 'none';
    document.documentElement.style.overflow = '';
    window.scrollTo(0, savedScrollY);
    active = false;
  }

  function toggle() { active ? close() : open(); }

  OBR.open = open;
  OBR.close = close;
  OBR.toggle = toggle;

  /* ---------------------------------------------------------------- events */
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (!active || pickerActive) return; // don't relayout against the hidden overlay mid-pick
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!pickerActive) layout(true); }, 150);
  });

  document.addEventListener('keydown', (e) => {
    if (!active || pickerActive) return; // picker owns the keyboard while it's up
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ':
        e.preventDefault(); e.stopPropagation(); flip(1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        e.preventDefault(); e.stopPropagation(); flip(-1); break;
      case 'Home': e.preventDefault(); endActiveFlip(); restoreFraction = null; currentSpread = 0; applySpread(); break;
      case 'End': e.preventDefault(); endActiveFlip(); restoreFraction = null; currentSpread = totalSpreads - 1; applySpread(); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
      case '+': case '=': e.preventDefault(); changeFont(1); break;
      case '-': case '_': e.preventDefault(); changeFont(-1); break;
      case 't': case 'T': e.preventDefault(); cycleTheme(); break;
      case 'p': case 'P': e.preventDefault(); printReader(); break;
    }
  }, true);

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
