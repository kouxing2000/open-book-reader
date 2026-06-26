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

  // Explain in plain language what's being asked and why.
  document.getElementById('why').textContent = origins.length
    ? 'To bundle a ZIP, Open Book Reader needs permission to fetch the selected images from the sites they live on. The files are saved only to your device — nothing is sent anywhere else.'
    : 'Open Book Reader needs permission to save files to your Downloads folder.';

  function finish(granted) {
    chrome.runtime.sendMessage({ type: 'obr-perms-result', granted: !!granted }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  }

  document.getElementById('allow').addEventListener('click', () => {
    try {
      chrome.permissions.request(request, (granted) => { void chrome.runtime.lastError; finish(granted); });
    } catch (e) {
      finish(false);
    }
  });
  document.getElementById('cancel').addEventListener('click', () => finish(false));
})();
