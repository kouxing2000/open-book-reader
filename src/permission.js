/* Open Book Reader — optional-permission prompt.
 *
 * Opened in a popup window by the service worker when a download needs a permission
 * the extension doesn't yet hold. A content script can't call permissions.request,
 * and a message to the SW loses the user gesture — but the click on "Allow" here is a
 * genuine gesture, so this page can request the permission, then report back. */
(function () {
  const params = new URLSearchParams(location.search);
  const perms = (params.get('perms') || '').split(',').filter(Boolean);
  const origins = (params.get('origins') || '').split(',').filter(Boolean);

  const request = {};
  if (perms.length) request.permissions = perms;
  if (origins.length) request.origins = origins;

  // Localize the static UI (title + buttons) from chrome.i18n; the hardcoded English in the
  // HTML is the fallback. This is an extension page, so chrome.i18n is available.
  const msg = (k, fb, subs) => { try { const m = chrome.i18n && chrome.i18n.getMessage(k, subs); return m || fb; } catch (e) { return fb; } };
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const m = msg(el.getAttribute('data-i18n'), ''); if (m) el.textContent = m;
  });
  try { const lang = chrome.i18n.getUILanguage && chrome.i18n.getUILanguage(); if (lang) document.documentElement.lang = lang; } catch (e) { /* */ }

  // Explain in plain language what's being asked and why. `reason=auto-open` marks the
  // per-site auto-open flow (an origin request for just that site); a plain origins
  // request is the ZIP download's cross-origin fetch.
  const reason = params.get('reason') || '';
  const host = params.get('host') || '';
  document.getElementById('why').textContent =
    reason === 'auto-open' && origins.length
      ? msg('permWhyAutoOpen', 'To open reading mode automatically on ' + (host || 'this site') + ', Open Book Reader needs permission to check that site’s pages when they load. Everything stays on your device — nothing is collected or sent anywhere.', [host || 'this site'])
      : origins.length
        ? msg('permWhyZip', 'To bundle a ZIP, Open Book Reader needs permission to fetch the selected images from the sites they live on. The files are saved only to your device — nothing is sent anywhere else.')
        : msg('permWhyDownloads', 'Open Book Reader needs permission to save files to your Downloads folder.');

  function finish(granted) {
    chrome.runtime.sendMessage({ type: 'obr-perms-result', granted: !!granted }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  }

  // The ZIP fetch asks for the origins its images actually live on (background.js permsFor),
  // so LIST them — "Allow" should be an informed click, not a leap of faith. The auto-open
  // flow names its one site in the `why` text already, so it skips the list.
  const isZip = origins.length && reason !== 'auto-open';
  if (isZip) {
    const list = document.getElementById('origins');
    origins.forEach((o) => {
      const li = document.createElement('li');
      // '*://host/*' -> 'host'. Show the host, not the match-pattern syntax.
      li.textContent = o.replace(/^\*:\/\//, '').replace(/\/\*$/, '');
      list.appendChild(li);
    });
    list.hidden = false;
    document.getElementById('sitesIntro').hidden = false;
  }

  function requestAndFinish(req) {
    try {
      chrome.permissions.request(req, (granted) => { void chrome.runtime.lastError; finish(granted); });
    } catch (e) {
      finish(false);
    }
  }

  document.getElementById('allow').addEventListener('click', () => requestAndFinish(request));

  // The escape hatch for people who download a lot: one broad grant instead of a prompt per
  // new CDN. Deliberately styled as a quiet secondary link — broad access stays available but
  // never the path of least resistance, and it's now an explicit choice rather than (as it was)
  // what every ZIP download silently asked for.
  if (isZip) {
    const all = document.getElementById('allowAll');
    all.hidden = false;
    all.addEventListener('click', () => requestAndFinish({ origins: ['<all_urls>'] }));
  }

  document.getElementById('cancel').addEventListener('click', () => finish(false));
})();
