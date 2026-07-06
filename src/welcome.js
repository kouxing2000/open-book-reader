// Welcome page localization. MUST be an external file — MV3 extension pages block inline
// <script> (CSP script-src 'self'), so an inline version never runs and the page would show
// only the hardcoded English. See src/welcome.html.

// Fill each [data-i18n] from chrome.i18n; the hardcoded English in the HTML stays as a
// fallback (__MSG__ substitution doesn't work in HTML bodies, so we do it in JS).
document.querySelectorAll('[data-i18n]').forEach(function (el) {
  try {
    var m = globalThis.chrome && chrome.i18n && chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (m) el.textContent = m;
  } catch (e) { /* keep the English fallback */ }
});
try {
  var lang = globalThis.chrome && chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage();
  if (lang) document.documentElement.lang = lang;
} catch (e) { /* */ }
