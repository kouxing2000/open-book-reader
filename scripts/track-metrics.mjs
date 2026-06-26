#!/usr/bin/env node
// Privacy-clean usage tracker for Open Book Reader.
//
// Scrapes the PUBLIC Chrome Web Store listing (no login, no secrets, no API key)
// and appends a dated row to metrics/store-metrics.csv. This is the only source of
// usage data that does NOT require in-extension telemetry, so the "collects no data /
// sends nothing to the developer" posture (see CLAUDE.md) stays intact.
//
// There is NO Chrome Web Store stats API. The Developer Dashboard has precise
// install / weekly-active / by-country numbers, but only behind an authenticated
// session. The public page shows a rounded user count + rating, and only once the
// extension crosses a display threshold — until then `users` is recorded empty.
//
// Usage:
//   node scripts/track-metrics.mjs          # scrape + append today's row
//   node scripts/track-metrics.mjs --debug  # also print the rendered header text

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Extension identity lives in .meta/portfolio.json (single source of truth).
const portfolio = JSON.parse(readFileSync(resolve(ROOT, '.meta/portfolio.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const EXT_ID = portfolio.chrome?.extensionId;
if (!EXT_ID) {
  console.error('No chrome.extensionId in .meta/portfolio.json');
  process.exit(1);
}
const STORE_URL = `https://chromewebstore.google.com/detail/${EXT_ID}`;
const OUT = resolve(ROOT, 'metrics/store-metrics.csv');
const DEBUG = process.argv.includes('--debug');

// CSV-quote a field that may contain a comma (e.g. "1,000 users"), quote, or newline.
const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// Parse "1,000 users" / "10K users" -> 1000 / 10000 (null if absent).
function parseCount(s) {
  if (!s) return null;
  const m = s.match(/([\d.,]+)\s*([KMB]?)/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] || 1;
  return Math.round(n * mult);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(STORE_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Scope to the listing header so we don't pick up "related extensions" stats.
  // The DOM uses hashed class names, so we read by structure: the first heading
  // matching the extension name, then the surrounding header block's text.
  const header = await page.evaluate(() => {
    const name = document.querySelector('h1')?.innerText || '';
    // The header section contains the rating + user count near the H1.
    const h1 = document.querySelector('h1');
    let scope = h1;
    for (let i = 0; i < 6 && scope?.parentElement; i++) scope = scope.parentElement;
    return { name, text: (scope || document.body).innerText };
  });

  if (DEBUG) {
    console.log('--- header text ---\n' + header.text + '\n-------------------');
  }

  const t = header.text;
  // "No ratings" means the listing shows a placeholder "0 out of 5" — record it as
  // empty (no rating yet), not a literal 0/5 score.
  const hasRatings = !/No ratings/i.test(t);
  const usersRaw = (t.match(/([\d.,]+\s*[KMB]?)\s*users?/i) || [])[1]?.trim() || '';
  const ratingRaw = hasRatings ? ((t.match(/([\d.]+)\s*out of\s*5/i) || [])[1] || '') : '';
  const ratingCountRaw = hasRatings ? ((t.match(/([\d.,]+[KMB]?)\s*ratings?/i) || [])[1] || '') : '';

  const date = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const row = {
    date,
    users: parseCount(usersRaw) ?? '',
    rating: ratingRaw || '',
    ratingCount: parseCount(ratingCountRaw) ?? '',
    version: manifest.version || '',
    usersRaw: usersRaw || 'not-shown-yet', // empty user count = below store display threshold
  };

  // Append (dedupe today's row so reruns overwrite rather than duplicate).
  const header_csv = 'date,users,rating,ratingCount,version,usersRaw';
  let lines = existsSync(OUT)
    ? readFileSync(OUT, 'utf8').trim().split('\n')
    : [header_csv];
  if (lines[0] !== header_csv) lines = [header_csv, ...lines.filter(Boolean)];
  lines = lines.filter((l, i) => i === 0 || !l.startsWith(date + ','));
  lines.push([row.date, row.users, row.rating, row.ratingCount, row.version, row.usersRaw].map(csv).join(','));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, lines.join('\n') + '\n');

  console.log(`[track-metrics] ${date}  users=${row.users || '(not shown yet)'}  rating=${row.rating || 'n/a'}  ratings=${row.ratingCount || 0}`);
} finally {
  await browser.close();
}
