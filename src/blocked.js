/* Open Book Reader — "not available on this page".
 *
 * Two entry points, one page. As the ACTION POPUP it is armed for a single restricted tab by the
 * service worker, so clicking the toolbar icon there answers instead of doing nothing. As a TAB
 * (?first=1) it is opened once per profile, the first time a trigger is ever blocked — the badge
 * is invisible to anyone who has not pinned the icon, so something has to say this out loud once.
 *
 * Static content only: the page has nothing to ask the browser and nothing to report. */
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
}());
