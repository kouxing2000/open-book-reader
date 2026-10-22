#!/usr/bin/env node
/* Tiny static file server for Playwright integration-test fixtures.
 * Serves tests/fixtures/ on PORT (default 5099). Started by playwright.config.js. */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'fixtures');
const PORT = Number(process.env.FIXTURE_PORT) || 5099;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml', // without this an .svg fixture is served as text/plain and never renders
  '.webm': 'video/webm',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const query = new URLSearchParams((req.url || '').split('?')[1] || '');
    const rel = urlPath === '/' ? 'article.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(DIR, rel);

    // Prevent path traversal outside the fixtures dir.
    if (!file.startsWith(DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    // ?delay=ms lets a fixture defer a response (used to test that the reader
    // re-paginates after an image finishes loading later than the first layout).
    const delay = Number(query.get('delay')) || 0;
    // Byte ranges, as any real file host answers them: without them Chrome cannot seek a video.
    const send = () => {
      const type = TYPES[path.extname(file)] || 'text/plain';
      const size = fs.statSync(file).size;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    };
    delay > 0 ? setTimeout(send, delay) : send();
  })
  .listen(PORT, () => console.log(`[fixture-server] serving ${DIR} on http://localhost:${PORT}`));
