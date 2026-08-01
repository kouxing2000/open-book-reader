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
//   node scripts/track-metrics.mjs --debug  # also print the scoped text corpus

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

// The listing is SERVER-RENDERED: users, version, rating and the ratings count are all in
// the raw HTML, which is why check-store-ranking.mjs reads the same store with plain fetch.
// This used to boot headless Chromium for a pure data-read — seconds of browser startup per
// run, on a script meant to be run repeatedly.
//
// Read by STABLE TEXT anchors ("N users", "x out of 5", "N ratings"), never by class name:
// the markup is obfuscated and its class names rotate on every Google rebuild.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Node's fetch has no body timeout, so a stalled store response would hang this forever.
const res = await fetch(`${STORE_URL}?hl=en`, {
  headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(60_000),
});
if (!res.ok) {
  console.error(`[track-metrics] store page returned HTTP ${res.status} — not writing a row`);
  process.exit(1);
}
const html = await res.text();

// LIVENESS GUARD — the check that makes an empty parse honest.
// The store answers HTTP 200 for a nonexistent or delisted ID: a bogus 32-char ID returns
// 200 and a ~510KB page redirected to /detail/empty-title/<id>. Without a guard every
// extract comes back empty and we append `<date>,,,,<ver>,not-shown-yet` — BYTE-IDENTICAL
// to the legitimate "below the display threshold" row already in this CSV. A takedown, a
// suspension, an ID typo, or an interstitial would record "still below threshold" forever,
// flatlining the trend at the exact moment it should scream.
//
// NOT `html.includes(EXT_ID)` — measured, that passes on the bogus page too (the id is
// echoed in the redirected URL). The VERSION FIELD is the real discriminator: absent on
// the empty-title page, present on any live listing. Same marker chrome-public.mjs uses
// for exactly this decision.
const liveVersion = (html.match(/>Version<\/div>\s*<div[^>]*>\s*([^<]+?)\s*</i) || [])[1]?.trim();
if (!liveVersion) {
  console.error(`[track-metrics] no Version field for ${EXT_ID} — delisted, wrong ID, or an interstitial. Not writing a row.`);
  process.exit(1);
}

// Strip <script> AND <style> before the tags: innerText excluded both, and this page
// carries ~450KB of CSS — leaving it in makes the searched corpus ~40x larger than the
// visible text and lets declarations like `user-select:none` match /users?\b/.
//
// Then cut at the first boundary marker between the main item and the "Related" carousel.
// The carousel renders ~20 more "out of 5" scores belonging to OTHER extensions; a sibling
// script recorded a neighbour's rating for weeks exactly this way. Scoping the corpus makes
// that structural rather than a first-match race we happen to keep winning.
const stripped = html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');
const bounds = [/Learn more about results and reviews/i, /\bRelated\b/]
  .map((re) => stripped.search(re))
  .filter((i) => i >= 0);
const t = bounds.length ? stripped.slice(0, Math.min(...bounds)) : stripped;

if (DEBUG) {
  console.log(`--- scoped corpus (${t.length} of ${stripped.length} chars) ---\n`
    + t.slice(0, 1200) + '\n----------------------------');
}

{
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
    version: liveVersion || manifest.version || '', // the LIVE one — local may be ahead of review
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
}
