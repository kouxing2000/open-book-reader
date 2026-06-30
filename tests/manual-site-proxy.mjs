// Manual real-site test proxy for Open Book Reader.
//
// WHY THIS EXISTS
// The reader/gallery only inject on a user gesture (toolbar icon / Alt+B / Alt+Shift+B).
// Browser automation can't click the real toolbar icon (it's browser chrome) and can't
// fire the Alt+B *command* (a CDP-synthesized key event doesn't reach chrome.commands),
// and injecting the engine straight into a live HTTPS page is blocked by mixed-content
// (https page -> http://localhost). So to exercise the REAL engine against REAL-site DOM
// this proxy:
//   1. fetches the target page server-side (no CORS / mixed-content in the browser),
//   2. strips its CSP <meta> and ALL of its own <script> tags. Stripping scripts freezes
//      the server-rendered DOM: SPA sites (Substack, Medium, ...) otherwise re-hydrate on
//      the 127.0.0.1 origin, fail an origin check, and wipe the article before we read it.
//      The frozen SSR DOM is a faithful static snapshot of what the extension extracts on
//      a properly-rendered page.
//   3. injects <base href> so the page's own CSS/images still resolve cross-origin, and
//   4. appends the four content scripts (same order as background.js) as ONE same-origin
//      bundle, so globalThis.OBR is set up exactly as in the shipped extension.
//
// The browser then visits http://127.0.0.1:<port>/read?u=<encoded-url> directly — no
// gesture, no CSP, no mixed-content. Open the reader from the page console / automation:
//     OBR.toggle()          // text mode
//     OBR.toggleGallery()   // image-gallery mode
//
// LIMITATIONS (test-method, not product):
//   - Scripts are stripped, so this does NOT drive the gallery's live lazy-hydration path
//     (hydratePage scrolling the real page) — that path is covered by the Playwright tests.
//   - Paywalled (NYT) or pure-client-rendered-with-no-SSR pages return a login/empty
//     snapshot to a server-side fetch; nothing to extract. Not an extension bug.
//
//   Usage:  npm run test:manual        (then open the printed URL form in the browser)
//           node tests/manual-site-proxy.mjs [port]
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(HERE, '..', 'src', 'content');
// Same order as background.js FILES (settings defines OBR; reader.style defines
// OBR._readerCSS; reader needs DEFAULTS + Readability before it runs). zip.js is omitted
// — the proxy has no ZIP-download path.
const FILES = ['settings.js', 'readability.js', 'reader.style.js', 'reader.js', 'gallery.js'];

// A real page has no `chrome.storage`, so without this the engine's settings,
// site rules, and per-article reading position (resume) all silently no-op.
// Provide a localStorage-backed sync+local shim so those features are testable
// here too. Installed only if chrome.storage is absent (never shadows a real
// extension context). Mirrors tests/helpers.js storageShim.
const STORAGE_SHIM = `
/* ==== manual-proxy chrome.storage shim ==== */
(function () {
  try { if (globalThis.chrome && chrome.storage && chrome.storage.sync) return; } catch (e) {}
  var listeners = [];
  function area(backingKey, name) {
    var read = function () { try { return JSON.parse(localStorage.getItem(backingKey) || '{}'); } catch (e) { return {}; } };
    var write = function (all) { try { localStorage.setItem(backingKey, JSON.stringify(all)); } catch (e) {} };
    return {
      get: function (keys, cb) {
        var all = read();
        var list = keys == null ? Object.keys(all) : Array.isArray(keys) ? keys : [keys];
        var out = {}; for (var i = 0; i < list.length; i++) if (list[i] in all) out[list[i]] = all[list[i]];
        cb(out);
      },
      set: function (items, cb) {
        var before = read(); write(Object.assign({}, before, items));
        var changes = {}; Object.keys(items).forEach(function (k) { changes[k] = { oldValue: before[k], newValue: items[k] }; });
        listeners.forEach(function (fn) { fn(changes, name); });
        if (cb) cb();
      },
    };
  }
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.storage = {
    sync: area('__obr_proxy_sync', 'sync'),
    local: area('__obr_proxy_local', 'local'),
    onChanged: { addListener: function (fn) { listeners.push(fn); } },
  };
})();
`;
const bundle = () => STORAGE_SHIM + '\n;\n' +
  FILES.map((f) => `\n/* ==== ${f} ==== */\n` + readFileSync(path.join(CONTENT, f), 'utf8')).join('\n;\n');

const PORT = Number(process.argv[2]) || 8347;
const ENGINE_URL = `http://127.0.0.1:${PORT}/engine.js`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function inject(html, baseUrl) {
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''); // freeze the SSR DOM (see header)
  const head = `<base href="${baseUrl}">`;
  const tail = `<script src="${ENGINE_URL}"></script>`; // absolute: <base> would hijack a relative src
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${head}`) : head + html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tail}</body>`) : html + tail;
  return html;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === '/engine.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    return res.end(bundle());
  }
  if (u.pathname === '/read') {
    const target = u.searchParams.get('u');
    if (!target) { res.statusCode = 400; return res.end('usage: /read?u=<encoded URL>'); }
    try {
      const r = await fetch(target, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000), // don't hang forever on a slow/dead origin
      });
      const ctype = r.headers.get('content-type') || '';
      if (!/html/i.test(ctype)) { // only HTML is safe to rewrite; don't mangle JSON/images/etc.
        res.statusCode = 415;
        return res.end(`refusing to inject into non-HTML response (content-type: ${ctype || 'unknown'})`);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); // deliberately no CSP header
      return res.end(inject(await r.text(), r.url || target));
    } catch (e) {
      res.statusCode = 502;
      return res.end('fetch failed: ' + String(e));
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<h1>Open Book Reader — manual site proxy</h1>
    <p>Open a real page through the engine:</p>
    <pre>${ENGINE_URL.replace('/engine.js', '')}/read?u=&lt;url-encoded page URL&gt;</pre>
    <p>Then in the page console: <code>OBR.toggle()</code> (text) or <code>OBR.toggleGallery()</code> (images).</p>`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`manual-site-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  open: http://127.0.0.1:${PORT}/read?u=<url-encoded page URL>`);
  console.log(`  then: OBR.toggle()  /  OBR.toggleGallery()  in the page console`);
});
