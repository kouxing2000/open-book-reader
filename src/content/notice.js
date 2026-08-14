/* Open Book Reader — the page-level notice banner.
 *
 * The one feedback surface that works when the READER's own UI cannot be trusted: the overlay
 * is covered by a site layer, its host was deleted by a framework re-render, or the engine on
 * the page is a corpse from a previous extension instance. Those are exactly the failures where
 * an in-overlay message is unreachable and a toolbar badge is invisible (an unpinned icon lives
 * behind the puzzle menu).
 *
 * CONSTRAINTS, both load-bearing:
 *   1. NO chrome.* at load, and none on the reload path. The service worker injects this file
 *      into pages whose isolated world is ORPHANED — every chrome.* call there throws
 *      "Extension context invalidated" — so the banner must be pure DOM. Only the 'report'
 *      action touches chrome, and it degrades to a mailto: when that throws.
 *   2. NO i18n here. chrome.i18n is part of the same dead context, so every string arrives
 *      pre-resolved from the caller (the worker resolves them SW-side; the engine via OBR.t).
 */
(function () {
  const OBR = (globalThis.OBR = globalThis.OBR || {});
  if (OBR._noticeLoaded) return; // double-injection guard, same shape as the engines'
  OBR._noticeLoaded = true;

  const HOST_ID = 'obr-notice';

  // z-index is the CSS maximum, and the host is appended LAST, so at an equal z-index this
  // banner still wins the paint — which matters, because "a site layer is on top of us" is one
  // of the very conditions it exists to report. (Nothing beats the top layer: a site's open
  // <dialog> or a fullscreen element paints above any z-index. In that case the report path
  // from the context menu is the only one left, which is why that entry point exists.)
  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; gap: 12px; padding: 11px 14px;
      background: #5b4cd6; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.28); }
    .ico { font-size: 16px; line-height: 1; }
    .msg { flex: 1; min-width: 0; }
    button { font: inherit; font-weight: 600; font-size: 13px; cursor: pointer;
      border: 0; border-radius: 6px; padding: 6px 12px; background: #fff; color: #3a2fb0; }
    button:hover { background: #efecff; }
    button.x { background: transparent; color: #fff; opacity: .8; padding: 6px 8px; font-weight: 400; }
    button.x:hover { background: rgba(255,255,255,.16); }
    @media (prefers-reduced-motion: no-preference) { .wrap { animation: drop .18s ease-out; } }
    @keyframes drop { from { transform: translateY(-100%); } to { transform: none; } }
  `;

  function remove() {
    const old = document.getElementById(HOST_ID);
    if (old) old.remove();
  }

  /* Show the banner. opts:
   *   text     pre-resolved sentence (required)
   *   actions  [{ label, act }] — act is 'reload' | 'report' | 'dismiss'
   *   source   report source tag, when an action is 'report'
   * Returns true if it drew. Replaces any banner already up, so repeated triggers can't stack. */
  OBR._notice = function (opts) {
    const o = opts || {};
    if (!o.text) return false;
    try {
      remove();
      const host = document.createElement('div');
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.setAttribute('role', 'status');
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = '📖';
      const msg = document.createElement('span');
      msg.className = 'msg';
      msg.textContent = o.text; // textContent, never innerHTML — callers pass plain sentences
      wrap.appendChild(ico);
      wrap.appendChild(msg);
      (o.actions || []).forEach((a) => {
        if (!a || !a.label) return;
        const b = document.createElement('button');
        b.textContent = a.label;
        if (a.act === 'dismiss') { b.className = 'x'; b.setAttribute('aria-label', a.label); }
        b.addEventListener('click', () => run(a.act, o));
        wrap.appendChild(b);
      });
      root.appendChild(style);
      root.appendChild(wrap);
      // documentElement, not body: a framework that rebuilds <body> leaves this alone, and it
      // is also the only parent guaranteed to exist during an early injection.
      document.documentElement.appendChild(host);
      return true;
    } catch (e) { return false; }
  };

  OBR._noticeClose = remove;

  function run(act, o) {
    if (act === 'reload') { remove(); try { location.reload(); } catch (e) { /* */ } return; }
    if (act === 'report') {
      remove();
      // Live context: the shared report path (worker opens the bundled report page). Orphaned
      // context: reportBroken's own mailto: fallback fires, which needs no chrome.* at all.
      try { if (OBR.reportBroken) return void OBR.reportBroken({ source: o.source || 'notice', mode: 'none' }); } catch (e) { /* */ }
      try { if (OBR._buildReportMailto) globalThis.open(OBR._buildReportMailto({ source: o.source || 'notice', mode: 'none' })); } catch (e) { /* */ }
      return;
    }
    remove();
  }
}());
