/* Guards the release artifact: `npm run package` must zip exactly the shippable
 * files and never leak dev files (package.json, scripts/, node_modules, .env).
 * No browser — runs the real packaging script and inspects the resulting zip. */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
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
  expect(entries).toContain('icons/icon128.png');

  // Dev / secret files must NOT be in the package.
  const forbidden = ['package.json', 'package-lock.json', '.env', 'node_modules', 'scripts', 'tests'];
  for (const bad of forbidden) {
    const leaked = entries.filter((e) => e === bad || e.startsWith(bad + '/'));
    expect(leaked, `dev file leaked into package: ${leaked.join(', ')}`).toEqual([]);
  }
});
