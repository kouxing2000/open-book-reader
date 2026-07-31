#!/usr/bin/env node
// Where does this extension rank in Chrome Web Store search, per keyword and locale?
//
// Sibling to track-metrics.mjs: same posture — scrapes the PUBLIC store, no login,
// no secrets, no API key (there is no CWS search or stats API of any kind). Appends
// a dated row per keyword to metrics/store-ranking.csv (gitignored, RULE #1) so a
// title/ASO change can be measured as a rank delta instead of a guess.
//
// ── THE TRAP THIS SCRIPT EXISTS TO NOT REPEAT ──────────────────────────────────
// A throwaway version of this once read results with:
//
//     /detail/([a-z0-9-]+)/([a-p]{32})
//
// The store renders our own result as:
//
//     ./detail/open-book-%E2%80%94-reader-view/kmcomogkbbdjhfocbncljmgcnfmaljca
//
// `%E2%80%94` is the percent-encoded em dash from the store title, and `[a-z0-9-]`
// cannot match `%`. So the pattern silently skipped EVERY em-dash-titled extension —
// this one included — and reported a confident "absent from search" instead of an
// error. That false negative survived 15+ queries and nine controls (all of which
// had ASCII slugs, so none could ever exercise the failing path) and came within one
// step of a bogus bug report to Google. The extension in fact ranks #1 for its name.
//
// Two rules encoded below, both load-bearing:
//   1. Anchor on `data-item-id`, which sits on the result container in rank order
//      and contains no slug at all. Never parse rank out of a URL.
//   2. ALWAYS cross-check the raw body (`html.includes(id)`) against the parsed
//      list. Raw-present + parse-absent == a parser bug, not an absence, and the
//      script says so loudly rather than reporting a clean zero. A parse that
//      yields empty on a shape it cannot match is indistinguishable from a true
//      negative unless you check.
//
// Usage:
//   node scripts/check-store-ranking.mjs            # all locales, append CSV
//   node scripts/check-store-ranking.mjs --no-save  # print only
//   node scripts/check-store-ranking.mjs en         # one locale
//
// NOTE: the store returns at most ~10 results per query, so a "competitors" count of
// 10 means "capped", NOT "exactly 10". Only counts below 10 are a real measurement.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portfolio = JSON.parse(readFileSync(resolve(ROOT, '.meta/portfolio.json'), 'utf8'));
const EXT_ID = portfolio.chrome?.extensionId;
if (!EXT_ID) {
  console.error('No chrome.extensionId in .meta/portfolio.json');
  process.exit(1);
}

const OUT = resolve(ROOT, 'metrics/store-ranking.csv');
const SAVE = !process.argv.includes('--no-save');
const ONLY = process.argv.slice(2).find((a) => !a.startsWith('--'));
const PAGE_CAP = 10; // observed result-page size; see NOTE above

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Keywords worth tracking per locale: the terms in our title, plus the category
// head terms we do NOT hold, so a title change shows up as movement either way.
//
// KEEP THE BETS IN HERE. The 2026-07-29 retitle was placed on three specific
// uncontested terms — de `Leseansicht`, pt-BR `leitura sem distração`, ja `縦読み` —
// and two of them were missing from this list, so the before/after diff could not
// see the very outcome the change was made for. If you tune the listing for a term,
// add it here in the same edit or the experiment is unmeasurable.
const KEYWORDS = {
  en: ['open book reader', 'reader view', 'reader mode', 'reading mode', 'two page reader', 'book reader', 'image gallery'],
  de: ['Lesemodus', 'Leseansicht', 'Bildergalerie'],
  es: ['Modo Lectura', 'Vista de Lectura', 'Galería de Imágenes'],
  fr: ['Mode Lecture', 'Lecture Simplifiée', "Galerie d'Images"],
  'pt-BR': ['Modo de Leitura', 'Modo Leitor', 'Galeria de Imagens', 'leitura sem distração'],
  ru: ['Режим чтения', 'читалка', 'галерея изображений'],
  ja: ['リーダーモード', 'リーダービュー', '画像ギャラリー', '縦読み'],
  'zh-CN': ['阅读模式', '阅读器', '阅读视图', '图片画廊'],
};

async function probe(keyword, hl) {
  const url = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${hl}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();

  const ids = [];
  const seen = new Set();
  for (const m of html.matchAll(/data-item-id="([a-p]{32})"/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    ids.push(m[1]);
  }

  const rank = ids.indexOf(EXT_ID);
  // Rule 2: the guard. Our id in the body but not in the parsed list can only mean
  // the parser missed a result shape — report it as a defect, never as "absent".
  if (html.includes(EXT_ID) && rank < 0) {
    return { error: 'PARSER BUG: id present in body but not parsed — fix the extractor, do NOT read this as absent' };
  }
  return { n: ids.length, rank: rank >= 0 ? rank + 1 : null };
}

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const date = new Date().toISOString().slice(0, 10);
const rows = [];
let bugs = 0;

for (const [hl, terms] of Object.entries(KEYWORDS)) {
  if (ONLY && hl !== ONLY) continue;
  console.log(`\n=== ${hl} ===`);
  console.log('  keyword                      results   our rank');
  for (const kw of terms) {
    let p;
    try { p = await probe(kw, hl); } catch (e) { p = { error: e.message }; }
    if (p.error) {
      if (p.error.startsWith('PARSER BUG')) bugs++;
      console.log(`  ${kw.padEnd(28)} ⚠️  ${p.error}`);
      continue;
    }
    const capped = p.n >= PAGE_CAP ? '+' : ' ';
    console.log(`  ${kw.padEnd(28)} ${String(p.n).padStart(4)}${capped}     ${p.rank ? '#' + p.rank : '—'}`);
    rows.push([date, hl, kw, p.rank ?? '', p.n]);
  }
}

if (bugs) {
  console.error(`\n✗ ${bugs} parser bug(s) — the extractor missed a result shape. Nothing here is a valid "absent".`);
  process.exit(1);
}

if (SAVE && rows.length) {
  const header = 'date,locale,keyword,rank,results';
  let lines = existsSync(OUT) ? readFileSync(OUT, 'utf8').trim().split('\n') : [header];
  if (lines[0] !== header) lines = [header, ...lines.filter(Boolean)];
  // Reruns replace today's rows rather than duplicating them.
  lines = lines.filter((l, i) => i === 0 || !l.startsWith(date + ','));
  for (const r of rows) lines.push(r.map(csv).join(','));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`\n[check-store-ranking] ${date} — ${rows.length} rows → metrics/store-ranking.csv`);
}
