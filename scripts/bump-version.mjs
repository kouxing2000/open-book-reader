#!/usr/bin/env node

/**
 * Bump the extension version in lock-step across manifest.json + package.json,
 * then commit + tag so a `git push --follow-tags` triggers the release workflow.
 *
 * The Chrome Web Store rejects any upload whose version is not strictly higher
 * than the live one, so every release MUST move this number. This script is the
 * single source of that bump — never edit the two files by hand and let them drift.
 *
 * Usage:
 *   npm run bump            # patch: 0.1.0 -> 0.1.1
 *   npm run bump -- minor   # 0.1.0 -> 0.2.0
 *   npm run bump -- major   # 0.1.0 -> 1.0.0
 *   npm run bump -- 0.4.2   # explicit version
 *   npm run bump -- minor --no-git   # edit files only, no commit/tag
 *
 * After it runs:  git push --follow-tags
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(rootDir, 'manifest.json');
const pkgPath = path.join(rootDir, 'package.json');

const args = process.argv.slice(2);
const noGit = args.includes('--no-git');
const bumpArg = args.find((a) => !a.startsWith('--')) || 'patch';

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`Cannot parse version "${v}" (expected X.Y.Z)`);
  return m.slice(1, 4).map(Number);
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind; // explicit version
  const [maj, min, pat] = parse(current);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Unknown bump "${kind}" (use patch|minor|major|X.Y.Z)`);
}

const manifestText = fs.readFileSync(manifestPath, 'utf8');
const pkgText = fs.readFileSync(pkgPath, 'utf8');
const manifest = JSON.parse(manifestText);
const current = manifest.version;
const next = nextVersion(current, bumpArg);

// Guard: must move strictly forward.
const cmp = (a, b) => {
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
};
if (cmp(next, current) <= 0) {
  console.error(`❌ New version ${next} is not greater than current ${current}. Aborting.`);
  process.exit(1);
}

const tag = `v${next}`;
if (!noGit) {
  const existing = execSync('git tag -l', { cwd: rootDir, encoding: 'utf8' }).split('\n');
  if (existing.includes(tag)) {
    console.error(`❌ Tag ${tag} already exists. Aborting.`);
    process.exit(1);
  }
}

// Replace ONLY the top-level "version" field so the files' hand-authored
// formatting (compact arrays etc.) is preserved — never re-serialize the whole JSON.
const bumpField = (text, file) => {
  const re = /("version"\s*:\s*)"\d+\.\d+\.\d+"/;
  if (!re.test(text)) throw new Error(`No "version" field found in ${file}`);
  return text.replace(re, `$1"${next}"`);
};
fs.writeFileSync(manifestPath, bumpField(manifestText, 'manifest.json'));
fs.writeFileSync(pkgPath, bumpField(pkgText, 'package.json'));
console.log(`✓ Version ${current} -> ${next}  (manifest.json + package.json)`);

// Roll CHANGELOG.md: the entries under "## [Unreleased]" become the new version's section.
// Leaves an empty [Unreleased] on top and updates the compare link to point at the new tag.
const changelogPath = path.join(rootDir, 'CHANGELOG.md');
let changelogStamped = false;
if (fs.existsSync(changelogPath)) {
  let cl = fs.readFileSync(changelogPath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  if (cl.includes(`## [${next}]`)) {
    console.warn(`⚠️  CHANGELOG.md already has a [${next}] section — leaving it untouched.`);
  } else if (/##\s*\[Unreleased\]/.test(cl)) {
    cl = cl.replace(/##\s*\[Unreleased\]/, `## [Unreleased]\n\n## [${next}] - ${today}`);
    // Re-point the [Unreleased] compare link and add a tag link for the new version.
    cl = cl.replace(
      /(\[Unreleased\]:\s*)(\S+?\/compare\/)v\d+\.\d+\.\d+(?:\.\.\.|\.\.\.)?HEAD/,
      (_m, label, base) =>
        `${label}${base}${tag}...HEAD\n[${next}]: ${base.replace(/\/compare\/$/, '/releases/tag/')}${tag}`
    );
    fs.writeFileSync(changelogPath, cl);
    changelogStamped = true;
    console.log(`✓ CHANGELOG.md: [Unreleased] -> [${next}] (${today})`);
  } else {
    console.warn('⚠️  CHANGELOG.md has no "## [Unreleased]" section — skipping changelog roll.');
  }
}

if (noGit) {
  console.log('ℹ️  --no-git: files edited, no commit/tag created.');
  process.exit(0);
}

execSync(`git add manifest.json package.json${changelogStamped ? ' CHANGELOG.md' : ''}`, {
  cwd: rootDir,
  stdio: 'inherit',
});
execSync(`git commit -m "chore(release): ${tag}"`, { cwd: rootDir, stdio: 'inherit' });
execSync(`git tag -a ${tag} -m "Open Book Reader ${tag}"`, { cwd: rootDir, stdio: 'inherit' });

console.log(`\n✓ Committed and tagged ${tag}.`);
console.log(`\nNext step — push to trigger the release workflow:`);
console.log(`   git push --follow-tags\n`);
