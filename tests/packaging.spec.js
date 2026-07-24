/* Guards the release artifact: `npm run package` must zip exactly the shippable
 * files and never leak dev files (package.json, scripts/, node_modules, .env).
 * No browser — runs the real packaging script and inspects the resulting zip. */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package-extension.js produces a clean, complete zip', () => {
  execSync('node scripts/package-extension.js', { cwd: ROOT, stdio: 'ignore' });

  const entries = execSync('unzip -Z1 dist.zip', { cwd: ROOT })
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // Shippable files present, manifest at the zip root.
  expect(entries).toContain('manifest.json');
  expect(entries).toContain('src/background.js');
  expect(entries).toContain('src/content/reader.style.js');
  expect(entries).toContain('src/content/reader.js');
  expect(entries).toContain('src/content/sentinel.js'); // auto-open registers this at runtime — a miss ships a dead feature
  expect(entries).toContain('icons/icon128.png');
  // Localization must ship: the default locale is load-bearing (manifest declares
  // default_locale), and the translated locales are the whole point of shipping them.
  expect(entries).toContain('_locales/en/messages.json');
  expect(entries).toContain('_locales/ru/messages.json');

  // Dev / secret files must NOT be in the package.
  const forbidden = ['package.json', 'package-lock.json', '.env', 'node_modules', 'scripts', 'tests'];
  for (const bad of forbidden) {
    const leaked = entries.filter((e) => e === bad || e.startsWith(bad + '/'));
    expect(leaked, `dev file leaked into package: ${leaked.join(', ')}`).toEqual([]);
  }
});

/* Every shipped script must PARSE, AS A CLASSIC SCRIPT. Cheap, browserless guard against a bug
 * class that has bitten this repo three times: reader.style.js returns the whole reader stylesheet
 * as a JS TEMPLATE LITERAL, so a stray backtick inside a CSS comment closes the string early and
 * the file dies with "Invalid or unexpected token". The symptom is remote from the cause — the
 * reader just throws "OBR._readerCSS is not a function" at runtime — and nothing else in the suite
 * fails fast on it, since a broken content script only surfaces once a test opens the reader.
 *
 * Uses `new vm.Script(...)`, NOT `node --check`: package.json sets "type": "module", so
 * `node --check foo.js` parses with the ESM goal, while these files are injected (and
 * importScripts'd) as CLASSIC scripts. Wrong goal = wrong answer in both directions — a stray
 * top-level import/await would pass --check yet be fatal when injected. Walks the filesystem
 * rather than `git ls-files`, so a newly added, not-yet-staged script is covered too — exactly
 * when a syntax slip is most likely. */
test('every shipped script parses as a classic script (no stray backticks in CSS template literals)', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
  });
  const files = walk(path.join(ROOT, 'src'));
  expect(files.length).toBeGreaterThan(5); // sanity: we really found the shipped set
  const broken = [];
  for (const f of files) {
    try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); }
    catch (e) { broken.push(path.relative(ROOT, f) + ': ' + e.message); }
  }
  expect(broken).toEqual([]);
});
