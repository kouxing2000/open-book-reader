#!/usr/bin/env node

/**
 * Package the Open Book Reader extension into a Chrome Web Store-ready ZIP.
 *
 * Zero-build extension: the source files ARE the shippable artifact. There is no
 * compile/bundle step. This script zips an explicit ALLOWLIST of shippable paths
 * (manifest.json, icons/, src/) so dev files (package.json, scripts/, node_modules/,
 * docs, .env) can never leak into the store package.
 *
 * Outputs:
 *   - dist.zip                              (repo root; what `npm run deploy` uploads)
 *   - package/<name>-v<version>.zip         (versioned archive copy)
 *   - package/SUBMISSION_CHECKLIST.md       (manual submission checklist)
 *
 * Usage:
 *   npm run package
 */

import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Files that must exist in a valid package. Paths are relative to repo root and
// mirror what manifest.json references.
const REQUIRED_FILES = [
  'manifest.json',
  'src/background.js',
  'src/content/settings.js',
  'src/content/readability.js',
  'src/content/reader.style.js',
  'src/content/reader.js',
  'src/content/zip.js',
  'src/content/gallery.js',
  'src/permission.html',
  'src/permission.js',
  'src/options/options.html',
  'src/options/options.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// Top-level entries to include in the ZIP. Everything else (package.json, scripts/,
// node_modules/, *.md, .env*, .git) is excluded by simply not being listed here.
const SHIP_FILES = ['manifest.json'];
const SHIP_DIRS = ['icons', 'src'];

async function packageExtension() {
  const packageDir = path.join(rootDir, 'package');

  log('\n📦 Packaging Open Book Reader (zero-build)...', 'cyan');

  // Step 1: Prepare package directory
  log('\n1️⃣  Preparing package directory...', 'blue');
  if (fs.existsSync(packageDir)) {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
  fs.mkdirSync(packageDir, { recursive: true });

  // Step 2: Verify required files exist
  log('\n2️⃣  Verifying required files...', 'blue');
  const missingFiles = REQUIRED_FILES.filter(
    (f) => !fs.existsSync(path.join(rootDir, f))
  );
  if (missingFiles.length > 0) {
    log('❌ Missing required files:', 'red');
    missingFiles.forEach((file) => log(`   - ${file}`, 'red'));
    process.exit(1);
  }
  log('✅ All required files present', 'green');

  // Step 3: Validate manifest
  log('\n3️⃣  Validating manifest...', 'blue');
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.manifest_version !== 3) {
    log('❌ Error: manifest_version must be 3', 'red');
    process.exit(1);
  }
  if (manifest.homepage_url && manifest.homepage_url.includes('github.com/steven/')) {
    log('⚠️  manifest.homepage_url still uses the placeholder "github.com/steven/..."', 'yellow');
    log('   Update it before a real store submission (see CLAUDE.md).', 'yellow');
  }
  log(`📌 Extension: ${manifest.name} v${manifest.version}`, 'cyan');
  log(`📝 Description: ${manifest.description}`, 'cyan');
  log(`🔒 Permissions: ${(manifest.permissions || []).join(', ') || '(none)'}`, 'cyan');
  const optionalPerms = [
    ...(manifest.optional_permissions || []),
    ...(manifest.optional_host_permissions || []),
  ];
  if (optionalPerms.length) {
    log(`🔓 Optional (opt-in): ${optionalPerms.join(', ')}`, 'cyan');
  }

  // Step 4: Create ZIP archives (root dist.zip + versioned copy)
  log('\n4️⃣  Creating ZIP archive...', 'blue');
  const zipFileName = `${manifest.name.replace(/\s+/g, '-').toLowerCase()}-v${manifest.version}.zip`;
  const versionedZipPath = path.join(packageDir, zipFileName);
  const distZipPath = path.join(rootDir, 'dist.zip');

  const sizeKB = await createZip(versionedZipPath);
  // Copy the freshly-built archive to dist.zip for the deploy script.
  fs.copyFileSync(versionedZipPath, distZipPath);
  log(`✅ ZIP created: ${zipFileName} (${sizeKB} KB)`, 'green');
  log(`✅ Copied to dist.zip (for npm run deploy)`, 'green');

  // Step 5: Generate submission checklist
  log('\n5️⃣  Generating submission checklist...', 'blue');
  const checklistPath = path.join(packageDir, 'SUBMISSION_CHECKLIST.md');
  fs.writeFileSync(checklistPath, buildChecklist(manifest, zipFileName));
  log('✅ Submission checklist created', 'green');

  // Step 6: Summary
  log('\n' + '='.repeat(60), 'cyan');
  log('🎉 PACKAGING COMPLETE!', 'green');
  log('='.repeat(60), 'cyan');
  log(`\n📦 Upload artifact: ${colors.yellow}${distZipPath}${colors.reset}`);
  log(`📦 Versioned copy:  ${colors.yellow}${versionedZipPath}${colors.reset}`);
  log(`📋 Checklist:       ${colors.yellow}${checklistPath}${colors.reset}`);
  log(`\n💡 Next: ${colors.cyan}npm run deploy${colors.reset} (uploads dist.zip to the Chrome Web Store)\n`);
}

function createZip(zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } }); // max compression

    output.on('close', () => resolve((archive.pointer() / 1024).toFixed(2)));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);

    // Add allowlisted top-level files at the ZIP root (manifest.json must be at root).
    for (const file of SHIP_FILES) {
      archive.file(path.join(rootDir, file), { name: file });
    }
    // Add allowlisted directories, preserving their relative paths so manifest
    // references (src/background.js, icons/icon16.png) resolve correctly.
    for (const dir of SHIP_DIRS) {
      archive.directory(path.join(rootDir, dir), dir);
    }

    archive.finalize();
  });
}

function buildChecklist(manifest, zipFileName) {
  const permissionNotes = {
    activeTab:
      'Granted when the user clicks the toolbar icon or presses Alt+B; lets the extension read the current tab to render the reader.',
    scripting: 'Inject the reader/gallery engine on user gesture.',
    storage: 'Persist user reading preferences (theme, font size, spreads, gallery column) via chrome.storage.sync.',
    downloads: 'Save images the user explicitly downloads from the image-gallery mode.',
  };

  const optionalNote = (p) =>
    `${permissionNotes[p] || 'TODO: justify this permission.'} (OPTIONAL — requested on first download, not at install.)`;

  const permLines = [
    ...(manifest.permissions || []).map(
      (p) => `  - **${p}:** ${permissionNotes[p] || 'TODO: justify this permission.'}`
    ),
    ...(manifest.optional_permissions || []).map((p) => `  - **${p}:** ${optionalNote(p)}`),
  ].join('\n');

  const hostLines = (manifest.optional_host_permissions || manifest.host_permissions || [])
    .map((h) => `  - **${h}:** Fetch image bytes cross-origin to bundle a user-requested ZIP download (image-gallery mode). Requested on first ZIP download, not at install. No data is sent anywhere.`)
    .join('\n');

  return `# Chrome Web Store Submission Checklist

## Extension Details
- **Name:** ${manifest.name}
- **Version:** ${manifest.version}
- **Package:** ${zipFileName}

## Pre-submission Checklist

### Package Contents
- [ ] Manifest V3 verified
- [ ] All icons present (16, 32, 48, 128)
- [ ] No dev files in the zip (package.json, scripts/, node_modules/, docs, .env)
- [ ] manifest.homepage_url no longer the "github.com/steven/..." placeholder

### Store Listing Assets
- [ ] Screenshots (1280x800 or 640x400) — reader view, options page, in action
- [ ] Promo tile 440x280 (small), optional 920x680 / 1400x560

### Store Listing Information
- [ ] Short description (132 chars max)
- [ ] Detailed description (up to 16,000 chars)
- [ ] Category: Productivity
- [ ] Languages / regions

### Privacy & Permissions
- [ ] Privacy policy URL hosted publicly (see PRIVACY.md)
- [ ] Data-disclosure: no data collected/sent. Network requests happen ONLY when the user
      downloads images (chrome.downloads + cross-origin fetch for ZIP). Disclose accordingly.
- [ ] Permission justifications:
${permLines}
- [ ] Optional host permission justification (requested on first download — install asks for none):
${hostLines}

### Final Checks
- [ ] Loaded unpacked and tested on several real articles
- [ ] No console errors
- [ ] Works on strict-CSP sites (Shadow DOM + adoptedStyleSheets)

## Submission Steps
1. [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Upload ${zipFileName} (or run \`npm run deploy\`)
3. Fill listing details, add screenshots
4. Submit for review (typically 1-3 business days)
`;
}

packageExtension().catch((error) => {
  log(`\n❌ Packaging failed: ${error.message}`, 'red');
  process.exit(1);
});
