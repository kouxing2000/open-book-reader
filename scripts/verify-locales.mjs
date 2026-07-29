#!/usr/bin/env node
// verify-locales.mjs — guard the _locales catalogs against drift.
//
// Run after adding/editing any locale (or automatically before `npm test`, wired
// as the `pretest` script). Exits non-zero on any problem so CI catches it.
//
// Checks, against the default-locale (en) catalog as source of truth:
//   1. Every locale has EXACTLY en's key set (no missing / no extra keys).
//   2. Each entry's `placeholders` block matches en's for that key (same shape).
//   3. Every $TOKEN$ in en's message appears in each translation (no dropped slot).
//   4. extName present and <= 75 chars (the manifest `name` hard limit, which is what the
//      Web Store enforces); extSummary <= 132 chars (the Web Store summary hard limit).
//   5. Coverage: every key REFERENCED anywhere in src/ exists in the en catalog, so it can't
//      render as a raw key / blank. References checked: OBR.t('key') and
//      chrome.i18n.getMessage('key') in .js, the data-i18n / data-i18n-placeholder /
//      data-i18n-title attributes in .html (the extension-page localization pattern), and
//      every __MSG_key__ in manifest.json.
//
// Usage: node scripts/verify-locales.mjs   (or: npm run verify:locales)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, '_locales');
const SUMMARY_MAX = 132;
// Chrome's manifest `name` limit, enforced by the Web Store at upload. Titles here are
// ASO-tuned and get longer over time (keywords earn their place by measurement — see
// `npm run ranking`), so the ceiling needs a guard rather than a habit of staying short.
const TITLE_MAX = 75;
const problems = [];
const fail = (m) => problems.push(m);

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const len = (s) => [...s].length; // count code points, matching the store's char count

// --- Source of truth: en ---
const enPath = join(LOCALES, 'en', 'messages.json');
if (!existsSync(enPath)) { console.error('FATAL: _locales/en/messages.json missing'); process.exit(1); }
let en;
try { en = read(enPath); }
catch (e) { console.error(`FATAL: _locales/en/messages.json is invalid JSON: ${e.message}`); process.exit(1); }
const enKeys = Object.keys(en).sort();
// Compare placeholder blocks by MEANING, not raw text: lowercase the names (Chrome
// placeholder names are case-insensitive), keep only the `content` mapping ($1/$2),
// drop the docs-only `example`, and sort — so a valid reorder or a localized example
// isn't flagged as drift, while a changed name or slot still is.
const phOf = (cat, k) => {
  const ph = cat[k]?.placeholders;
  if (!ph) return 'null';
  return JSON.stringify(
    Object.entries(ph).map(([name, def]) => [name.toLowerCase(), def && def.content]).sort()
  );
};
const tokensOf = (msg) => msg.match(/\$[A-Za-z0-9_]+\$/g) ?? [];

// --- 1-4: per-locale catalog checks ---
const locales = readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const loc of locales) {
  let cat;
  try { cat = read(join(LOCALES, loc, 'messages.json')); }
  catch (e) { fail(`[${loc}] invalid JSON: ${e.message}`); continue; }
  const keys = Object.keys(cat).sort();

  for (const k of enKeys) if (!(k in cat)) fail(`[${loc}] missing key: ${k}`);
  for (const k of keys) if (!(k in en)) fail(`[${loc}] extra key not in en: ${k}`);

  for (const k of enKeys) {
    if (!(k in cat)) continue;
    const msg = cat[k].message;
    if (typeof msg !== 'string' || msg.trim() === '') {
      fail(`[${loc}] "${k}" has an empty or missing message`);
      continue; // nothing more to check on a blank entry (also guards the token check below)
    }
    if (phOf(cat, k) !== phOf(en, k)) fail(`[${loc}] placeholders block for "${k}" differs from en`);
    for (const t of tokensOf(en[k].message)) {
      // Chrome placeholder tokens are case-insensitive, so match them that way.
      if (!msg.toLowerCase().includes(t.toLowerCase())) fail(`[${loc}] "${k}" dropped placeholder token ${t}`);
    }
  }
  if (!cat.extName?.message) fail(`[${loc}] extName missing/empty`);
  if (cat.extName?.message && len(cat.extName.message) > TITLE_MAX) {
    fail(`[${loc}] extName is ${len(cat.extName.message)} chars (max ${TITLE_MAX})`);
  }
  if (cat.extSummary?.message && len(cat.extSummary.message) > SUMMARY_MAX) {
    fail(`[${loc}] extSummary is ${len(cat.extSummary.message)} chars (max ${SUMMARY_MAX})`);
  }
}

// --- 5: coverage — used keys must exist in en ---
// Scan EVERY .js AND .html under src/ (not a hardcoded list) so a new file that references a
// message can't slip its keys past the guard. Only string-literal keys are checked —
// OBR.t(dynamicVar) can't be resolved statically (none exist today).
const keySet = new Set(enKeys);
const srcDir = join(ROOT, 'src');
const srcFiles = readdirSync(srcDir, { recursive: true }).filter((f) => typeof f === 'string');
const readSrc = (ext) => srcFiles.filter((f) => f.endsWith(ext)).map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n');
const SRC_JS = readSrc('.js');
const SRC_HTML = readSrc('.html');
// .js: the two runtime lookups — OBR.t('key') (content scripts) and chrome.i18n.getMessage('key')
// (extension pages: welcome / report / permission).
for (const m of SRC_JS.matchAll(/OBR\.t\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
  if (!keySet.has(m[1])) fail(`[src] OBR.t('${m[1]}') has no key in en catalog`);
}
for (const m of SRC_JS.matchAll(/chrome\.i18n\.getMessage\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
  if (!keySet.has(m[1])) fail(`[src] chrome.i18n.getMessage('${m[1]}') has no key in en catalog`);
}
// .html: the extension-page localization attributes filled by each page's small i18n pass.
for (const m of SRC_HTML.matchAll(/data-i18n(?:-html|-placeholder|-title)?="([A-Za-z0-9_]+)"/g)) {
  if (!keySet.has(m[1])) fail(`[src] data-i18n="${m[1]}" has no key in en catalog`);
}
const manifest = readFileSync(join(ROOT, 'manifest.json'), 'utf8');
for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
  if (!keySet.has(m[1])) fail(`[manifest] __MSG_${m[1]}__ has no key in en catalog`);
}

// --- report ---
if (problems.length) {
  console.error(`✗ verify-locales: ${problems.length} problem(s)`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`✓ verify-locales: ${locales.length} locales, ${enKeys.length} keys each — parity, placeholders, tokens, limits, and src/manifest coverage all OK`);
