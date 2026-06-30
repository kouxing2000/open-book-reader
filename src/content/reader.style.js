/* Open Book Reader — text-reader stylesheet (extracted from reader.js).
 * OBR._readerCSS(settings, reduceMotion, FONT_STACKS) -> the reader's full CSS string,
 * a pure function of its inputs (no shared mutable state). reader.js calls it from
 * applyStylesheet() and adopts it into the Shadow DOM. MUST load BEFORE reader.js in
 * every injection list (background.js FILES, tests/helpers.js, tests/manual-site-proxy.mjs,
 * the capture scripts, and package-extension.js REQUIRED_FILES).
 */
(function () {
  const OBR = (globalThis.OBR = globalThis.OBR || {});

  OBR._readerCSS = function (settings, reduceMotion, FONT_STACKS) {
    // 'off' (and reduced-motion) make the .obr-pages slide instant; 'slide'/'book' keep
    // the eased translateX. The 3D 'book' turn suppresses this transition per-flip anyway.
    const flip = (reduceMotion || settings.pageTurn === 'off') ? 0 : settings.transitionMs;
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

    /* Realistic 3D page turn (settings.pageTurn === 'book'): a transient leaf cloned from
       .obr-pages rotates about the center spine on top of the real strip. It lives in its
       OWN layer that is a sibling of .obr-viewport (not inside it) because the viewport's
       overflow:hidden would both clip and flatten the rotation. perspective is on the layer;
       preserve-3d on the leaf. z-index 4 sits above the page backdrop but below the chrome
       (10/11); pointer-events:none lets the click-zones keep receiving rapid flips. */
    .obr-flip-layer { position: absolute; z-index: 4; pointer-events: none;
      perspective: 5200px; perspective-origin: 50% 50%; }
    .obr-flip-static { position: absolute; top: 0; overflow: hidden; }
    .obr-leaf { position: absolute; top: 0; transform-origin: left center;
      transform-style: preserve-3d; will-change: transform;
      box-shadow: 0 6px 18px rgba(0,0,0,.28); }
    .obr-leaf-face { position: absolute; inset: 0; overflow: hidden;
      backface-visibility: hidden; -webkit-backface-visibility: hidden; }
    .obr-leaf-face.back { transform: rotateY(180deg); }
    .obr-leaf-pages { position: absolute; top: 0; left: 0; }
    .obr-leaf-shade { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
    .obr-leaf-face.front .obr-leaf-shade { background: linear-gradient(to right, rgba(0,0,0,.32), rgba(0,0,0,0) 60%); }
    .obr-leaf-face.back  .obr-leaf-shade { background: linear-gradient(to left,  rgba(0,0,0,.32), rgba(0,0,0,0) 60%); }

    /* Soft "curl" turn (settings.pageTurn === 'curl'): the turning half-page is sliced into
       a nested chain of vertical strips, each rotated a little more than the last, so the
       sheet BENDS like real paper instead of staying a rigid board. The whole chain also
       rotates about the spine. .obr-cseg is the 3D frame (preserve-3d, overflow visible);
       each nested seg sits at its parent's right edge (left:100%) and pivots at its own left
       edge, so the rotations accumulate into a smooth arc. .obr-cface is the flat content
       slice (overflow:hidden is fine — it has no 3D children). A single flat back face
       (.obr-curl-back, rigid-style, correct un-mirrored text) shows once past edge-on. */
    .obr-curl { position: absolute; top: 0; transform-origin: left center;
      transform-style: preserve-3d; will-change: transform; }
    .obr-curl-back { position: absolute; inset: 0; overflow: hidden; transform: rotateY(180deg);
      backface-visibility: hidden; -webkit-backface-visibility: hidden; }
    .obr-cseg { position: absolute; left: 0; top: 0; transform-origin: left center;
      transform-style: preserve-3d; }
    .obr-cseg.nested { left: 100%; }
    .obr-cface { position: absolute; inset: 0; overflow: hidden;
      backface-visibility: hidden; -webkit-backface-visibility: hidden; }
    .obr-cface .obr-leaf-shade { background: #000; }  /* opacity driven per-strip in JS */

    /* Faces and stationary halves need the paper's opaque background so the destination
       strip underneath doesn't bleed through (mirrors the .obr-paper theme colors). */
    .obr-overlay.paper .obr-leaf-face, .obr-overlay.paper .obr-flip-static,
    .obr-overlay.paper .obr-cface, .obr-overlay.paper .obr-curl-back { background: #f6efe0; }
    .obr-overlay.light .obr-leaf-face, .obr-overlay.light .obr-flip-static,
    .obr-overlay.light .obr-cface, .obr-overlay.light .obr-curl-back { background: #fff; }
    .obr-overlay.dark  .obr-leaf-face, .obr-overlay.dark  .obr-flip-static,
    .obr-overlay.dark  .obr-cface, .obr-overlay.dark  .obr-curl-back { background: #1f2024; }

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

    /* "Wrong content?" / saved-pick affordance — a small pill above the footer.
       Auto-hides with the chrome (shares .obr-chrome-hidden), dismissible. */
    .obr-pick-hint {
      position: absolute; left: 50%; bottom: 56px; transform: translateX(-50%);
      z-index: 12; display: none; align-items: center; gap: 9px;
      padding: 7px 9px 7px 13px; border-radius: 11px; font-size: 12.5px;
      background: rgba(var(--obr-bg),.98); color: inherit;
      border: 1px solid rgba(127,127,127,.28); box-shadow: 0 6px 20px rgba(0,0,0,.30);
      transition: opacity .25s ease, transform .25s ease; max-width: 92%;
    }
    .obr-pick-hint.show { display: flex; }
    .obr-chrome-hidden .obr-pick-hint { opacity: 0; pointer-events: none;
      transform: translateX(-50%) translateY(8px); }
    .obr-pick-msg { opacity: .82; }
    .obr-pick-hint .obr-btn { background: #7c6cff; color: #fff; padding: 5px 11px; }
    .obr-pick-hint .obr-btn:hover { background: #6a59f2; }
    .obr-pick-x {
      border: none; cursor: pointer; background: transparent; color: inherit;
      opacity: .55; font-size: 13px; padding: 4px 6px; border-radius: 6px; font-family: inherit;
    }
    .obr-pick-x:hover { opacity: 1; background: rgba(127,127,127,.18); }
    `;
  };
})();
