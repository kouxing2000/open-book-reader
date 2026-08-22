/* Open Book Reader — "not available on this page".
 *
 * Two entry points, one page. As the ACTION POPUP it is armed for a single restricted tab by the
 * service worker, so clicking the toolbar icon there answers instead of doing nothing. As a TAB
 * (?first=1) it is opened once per profile, the first time a trigger is ever blocked — the badge
 * is invisible to anyone who has not pinned the icon, so something has to say this out loud once.
 *
 * Mostly static: on a HARD block the page has nothing to ask the browser. On a SOFT block
 * (?soft=1&u=<page url>) it also offers a Report link — the worker only sets that when the page
 * was NOT a scheme Chrome blocks, i.e. when the failed injection is our fault. */
(function () {
  // Same localization pass as permission.js — an extension page, so chrome.i18n is available;
  // the English in the HTML is the fallback when a key is missing.
  const msg = (k, fb) => { try { const m = chrome.i18n && chrome.i18n.getMessage(k); return m || fb; } catch (e) { return fb; } };
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const m = msg(el.getAttribute('data-i18n'), '');
    if (m) el.textContent = m;
  });
  try {
    const lang = chrome.i18n.getUILanguage && chrome.i18n.getUILanguage();
    if (lang) document.documentElement.lang = lang;
  } catch (e) { /* */ }

  // The Report link, on a soft block only. The worker owns that verdict (it holds the URL and
  // the scheme test); this page just honors the flag it was armed with.
  const q = new URLSearchParams(location.search);
  const link = document.getElementById('report');
  if (!link || q.get('soft') !== '1') return;
  link.hidden = false;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    // A ctx, not a built meta — the worker builds it, the same way the context-menu entry does.
    // pageUrl is passed explicitly: this page's own location is the extension's, not the tab's.
    try {
      chrome.runtime.sendMessage({
        type: 'obr-open-report',
        // Never '' — _buildReportMeta reads a falsy pageUrl as "use location.href", and in the
        // worker that is the worker's own chrome-extension:// URL, which would mislabel the report.
        meta: { source: 'blocked-popup', mode: 'none', pageUrl: q.get('u') || '(unknown)',
                failure: { state: 'inject-failed', by: '' } },
      }, () => { void chrome.runtime.lastError; window.close(); });
    } catch (err) { /* the popup closes with the click anyway */ }
  });
}());
