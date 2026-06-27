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

  // Mode-switch glyphs (shared shape with gallery.js): open book + framed picture.
  const ICON_BOOK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2H2z"/><path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2H22z"/></svg>';
  const ICON_IMAGES =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>';

  let settings = Object.assign({}, OBR.DEFAULTS);
  let host, root, overlay, pagesEl, viewportEl, indicatorEl, titleEl, paperEl, metaEl, progressFillEl;
  let active = false, built = false;
  let chromeTimer = null, overControls = false;
  let currentSpread = 0, totalSpreads = 1, totalColumns = 1;
  let colW = 0, colGap = 0, pagesPerSpread = 2;
  let savedScrollY = 0;
  let mediaTimer = null;
  // Per-article resume: posKey identifies the article; restoreFraction holds the
  // saved progress fraction until the first relayout positions us there (it keeps
  // re-anchoring through the late-image settle window, then a user nav clears it).
  let posKey = '', restoreFraction = null, saveTimer = null;
  // The article Readability last parsed (held so Print can reuse it without re-parsing).
  let lastArticle = null;
  let printing = false; // re-entrancy guard for printReader (the native print dialog is modal)

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
  function css() {
    const flip = reduceMotion ? 0 : settings.transitionMs;
    return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .obr-overlay {
      position: fixed; inset: 0; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: center;
      font-family: ${FONT_STACKS.sans}; animation: obr-fade .22s ease;
    }
    @keyframes obr-fade { from { opacity: 0 } to { opacity: 1 } }
    .obr-overlay.paper { background: #d9cdb8; color: #3a3122; --obr-bg: 217,205,184; }
    .obr-overlay.light { background: #c9ccd1; color: #1f2328; --obr-bg: 201,204,209; }
    .obr-overlay.dark  { background: #15161a; color: #d7d3c8; --obr-bg: 21,22,26; }

    /* Header & footer float over the book and auto-hide; they fade to transparent
       so the page reads through them, and slide away when the mouse is idle. */
    .obr-topbar {
      position: absolute; top: 0; left: 0; right: 0; z-index: 10;
      height: 52px; display: flex;
      align-items: center; justify-content: space-between; padding: 0 18px; gap: 12px;
      font-size: 13px;
      background: linear-gradient(to bottom, rgba(var(--obr-bg),.96) 38%, rgba(var(--obr-bg),0) 100%);
      transition: opacity .25s ease, transform .25s ease;
    }
    .obr-chrome-hidden .obr-topbar { opacity: 0; transform: translateY(-100%); pointer-events: none; }
    .obr-chrome-hidden .obr-footer { opacity: 0; transform: translateY(100%); pointer-events: none; }
    .obr-doc-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .6; max-width: 55%; }
    .obr-controls { display: flex; gap: 6px; }
    .obr-btn {
      border: none; cursor: pointer; padding: 6px 10px; border-radius: 6px;
      font-size: 13px; background: rgba(0,0,0,.10); color: inherit; font-family: inherit;
    }
    .obr-btn:hover { background: rgba(0,0,0,.22); }
    .obr-overlay.dark .obr-btn { background: rgba(255,255,255,.12); }
    .obr-overlay.dark .obr-btn:hover { background: rgba(255,255,255,.24); }
    /* Mode switch = an iOS-style segmented control: a recessed track holding a
       raised brand-accent "thumb" on the current side. The depth (inset track vs.
       lifted thumb) makes it read as a physical toggle — this side is selected,
       tap the other to switch — rather than two flat buttons. */
    .obr-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 9px;
      background: rgba(0,0,0,.12); border: 1px solid rgba(0,0,0,.08);
      box-shadow: inset 0 1px 2px rgba(0,0,0,.20); transition: opacity .25s ease; }
    .obr-overlay.dark .obr-seg { background: rgba(0,0,0,.38); border-color: rgba(255,255,255,.08);
      box-shadow: inset 0 1px 2px rgba(0,0,0,.55); }
    .obr-seg-btn {
      display: inline-flex; align-items: center; gap: 6px;
      border: none; cursor: pointer; padding: 5px 12px; border-radius: 7px;
      font-size: 13px; background: transparent; color: inherit; font-family: inherit;
      opacity: .72; white-space: nowrap;
      transition: background .15s ease, opacity .15s ease, box-shadow .15s ease;
    }
    .obr-seg-btn svg { width: 15px; height: 15px; flex: none; }
    .obr-seg-btn:not(.is-active):hover { opacity: 1; background: rgba(124,108,255,.16); }
    .obr-seg-btn.is-active { opacity: 1; cursor: default; font-weight: 600;
      background: #7c6cff; color: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,.28), 0 2px 6px rgba(124,108,255,.45); }
    .obr-seg-badge { opacity: .92; font-weight: 600; }

    .obr-book { position: relative; flex: 1 1 auto; display: flex; align-items: center; justify-content: center; width: 100%; min-height: 0; }
    .obr-paper { position: relative; border-radius: 6px; box-shadow: 0 18px 50px rgba(0,0,0,.40), 0 2px 6px rgba(0,0,0,.25); }
    .obr-overlay.paper .obr-paper { background: #f6efe0; }
    .obr-overlay.light .obr-paper { background: #fff; }
    .obr-overlay.dark  .obr-paper { background: #1f2024; }

    .obr-viewport { overflow: hidden; position: relative; }
    .obr-pages { column-fill: auto; transition: transform ${flip}ms cubic-bezier(.22,.61,.36,1); will-change: transform; }

    .obr-spine { position: absolute; top: 0; bottom: 0; width: 60px; left: 50%; transform: translateX(-50%); pointer-events: none;
      background: linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,.06) 45%, rgba(0,0,0,.12) 50%, rgba(0,0,0,.06) 55%, rgba(0,0,0,0) 100%); }
    .obr-overlay.dark .obr-spine { background: linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,.30) 45%, rgba(0,0,0,.55) 50%, rgba(0,0,0,.30) 55%, rgba(0,0,0,0) 100%); }
    .obr-spine.hidden { display: none; }

    .obr-zone { position: absolute; top: 0; bottom: 0; width: 28%; cursor: pointer; z-index: 2; }
    .obr-zone-left { left: 0; } .obr-zone-right { right: 0; }

    .obr-footer {
      position: absolute; bottom: 0; left: 0; right: 0; z-index: 10;
      height: 46px; display: flex; align-items: center; justify-content: center; gap: 18px;
      font-size: 12.5px;
      background: linear-gradient(to top, rgba(var(--obr-bg),.96) 38%, rgba(var(--obr-bg),0) 100%);
      transition: opacity .25s ease, transform .25s ease;
    }
    .obr-hint { opacity: .55; }
    .obr-doc-meta { opacity: .5; font-size: .92em; margin-left: 10px; white-space: nowrap; }

    /* Subtle reading-progress hairline pinned to the very bottom edge. Lives
       OUTSIDE the auto-hiding footer so it stays glanceable, but kept deliberately
       thin and low-contrast so it doesn't intrude on the page. */
    .obr-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
      background: rgba(127,127,127,.12); z-index: 11; pointer-events: none; }
    .obr-progress-fill { height: 100%; width: 0;
      background: currentColor; opacity: .32; transition: width .25s ease; }

    .obr-pages .obr-content { line-height: ${settings.lineHeight}; }
    .obr-pages h1 { font-size: 1.5em; line-height: 1.25; margin: 0 0 .6em; }
    .obr-pages h2 { font-size: 1.25em; margin: 1.2em 0 .5em; }
    .obr-pages h3 { font-size: 1.1em; margin: 1em 0 .4em; }
    .obr-pages p { margin: 0 0 1em; text-align: justify; hyphens: auto; }
    .obr-pages a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
    .obr-pages img, .obr-pages figure, .obr-pages video, .obr-pages svg, .obr-pages iframe, .obr-pages table { max-width: 100%; height: auto; break-inside: avoid; }
    .obr-pages figure { margin: 1em 0; }
    .obr-pages img { display: block; margin: 0 auto; border-radius: 4px; }
    /* Cap media to (just under) one column's height so a tall portrait image or
       embed scales down to fit a single page instead of being clipped at the
       column boundary. --obr-colh is set per layout(); the 3em leaves room for a
       figure caption so the whole figure stays on one page. */
    .obr-pages img, .obr-pages video, .obr-pages svg, .obr-pages iframe {
      max-height: calc(var(--obr-colh, 82vh) - 3em); object-fit: contain;
    }
    .obr-pages blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid rgba(127,127,127,.4); opacity: .85; font-style: italic; }
    .obr-pages pre, .obr-pages code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: .85em; }
    .obr-pages pre { white-space: pre-wrap; word-break: break-word; background: rgba(127,127,127,.12); padding: .7em; border-radius: 4px; break-inside: avoid; }
    .obr-doc-h1 { font-size: 1.7em; line-height: 1.2; margin: 0 0 .8em; }
    .obr-byline { opacity: .6; font-size: .85em; margin: 0 0 1.4em; }
    `;
  }

  function applyStylesheet() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css());
    root.adoptedStyleSheets = [sheet];
  }

  /* ---------------------------------------------------------------- build */
  function build() {
    if (built) return;
    host = document.createElement('div');
    host.id = 'obr-host';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });

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
          <button class="obr-btn" data-act="print" title="Print or save as PDF (P)">🖨️</button>
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
      <div class="obr-progress"><div class="obr-progress-fill"></div></div>`;
    root.appendChild(overlay);

    titleEl = overlay.querySelector('.obr-doc-title');
    metaEl = overlay.querySelector('.obr-doc-meta');
    viewportEl = overlay.querySelector('.obr-viewport');
    pagesEl = overlay.querySelector('.obr-pages');
    paperEl = overlay.querySelector('.obr-paper');
    indicatorEl = overlay.querySelector('.obr-indicator');
    progressFillEl = overlay.querySelector('.obr-progress-fill');

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
    if (act === 'settings') return OBR.openOptions && OBR.openOptions();
    if (act === 'theme') return cycleTheme();
    if (act === 'font+') return changeFont(1);
    if (act === 'font-') return changeFont(-1);
    if (act === 'columns') return cycleColumns();
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

  function extractArticle() {
    try {
      const base = document.cloneNode(true);
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
      return article;
    } catch (e) {
      console.warn('[OpenBookReader] Readability failed:', e);
    }
    return null;
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

  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderContent(article) {
    const title = article ? article.title : document.title;
    const byline = article && article.byline ? article.byline : '';
    const body = article
      ? article.content
      : '<p>Could not extract a readable article from this page. Try selecting the text first, or this page may not be article-shaped.</p>';
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
    currentSpread = next;
    applySpread();
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
    settings = await OBR.loadSettings();
    if (OBR.closeGallery) OBR.closeGallery(); // ensure image mode isn't also showing
    build();
    applyStylesheet();
    overlay.className = 'obr-overlay ' + resolveTheme();
    updateColumnsBtn();
    updateImagesBadge();
    lastArticle = extractArticle();
    renderContent(lastArticle);

    // Resume where the user last left off in this article (null if never read or
    // storage unavailable). Held as a fraction; layout() re-anchors it through the
    // late-image settle window until the user navigates. Deliberately awaited
    // BEFORE the first layout/show so the reader opens directly at the resumed
    // page — not flash page 1 then jump. (It also avoids a close()-before-resume
    // race that would flush spread 0 over the real saved position.) The read is a
    // few ms on a real storage backend.
    posKey = OBR.positionKey ? OBR.positionKey() : '';
    restoreFraction = posKey && OBR.loadPosition ? await OBR.loadPosition(posKey) : null;

    savedScrollY = window.scrollY;
    host.style.display = '';
    document.documentElement.style.overflow = 'hidden';
    active = true;
    showChrome(); // show controls briefly, then auto-hide
    requestAnimationFrame(() => layout(false));
    watchMedia(); // re-paginate once late-loading images / fonts settle

  }

  function close() {
    if (!active) return;
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
    if (!active) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layout(true), 150);
  });

  document.addEventListener('keydown', (e) => {
    if (!active) return;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ':
        e.preventDefault(); e.stopPropagation(); flip(1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        e.preventDefault(); e.stopPropagation(); flip(-1); break;
      case 'Home': e.preventDefault(); restoreFraction = null; currentSpread = 0; applySpread(); break;
      case 'End': e.preventDefault(); restoreFraction = null; currentSpread = totalSpreads - 1; applySpread(); break;
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
      if (area !== 'sync' || !active || !built || !changes[OBR.STORAGE_KEY]) return;
      OBR.loadSettings().then((s) => {
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
