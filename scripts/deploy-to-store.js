#!/usr/bin/env node

/**
 * Deploy the Open Book Reader extension to the Chrome Web Store.
 *
 * Uploads dist.zip (produced by `npm run package`) via the Chrome Web Store API
 * and optionally publishes it for review.
 *
 * Required env (in .env.chrome-webstore):
 * - CHROME_EXTENSION_ID
 * - CHROME_CLIENT_ID
 * - CHROME_CLIENT_SECRET
 * - CHROME_REFRESH_TOKEN   (auto-generated via get-refresh-token.js if missing)
 *
 * Optional:
 * - AUTO_PUBLISH=false     upload only, publish manually from the dashboard
 * - AUTO_GET_TOKEN=false   do not auto-run the token generator
 *
 * Usage:
 *   npm run deploy
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import chromeWebstoreUpload from 'chrome-webstore-upload';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// `npm run deploy -- --check`: credential preflight only (no upload). CI runs this FIRST so a
// dead token fails fast instead of after the full test + package build. Also usable locally.
const CHECK_ONLY = process.argv.includes('--check');

const envPath = path.join(rootDir, '.env.chrome-webstore');
if (fs.existsSync(envPath)) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath });
  console.log('✓ Loaded environment variables from .env.chrome-webstore file');
} else {
  console.log('⚠️  No .env.chrome-webstore file found, using environment variables');
}

const CONFIG = {
  extensionId: process.env.CHROME_EXTENSION_ID,
  clientId: process.env.CHROME_CLIENT_ID,
  clientSecret: process.env.CHROME_CLIENT_SECRET,
  refreshToken: process.env.CHROME_REFRESH_TOKEN,
  autoPublish: process.env.AUTO_PUBLISH !== 'false',
  zipPath: path.join(rootDir, 'dist.zip'),
};

async function validateConfig() {
  const missing = [];
  if (!CONFIG.extensionId) missing.push('CHROME_EXTENSION_ID');
  if (!CONFIG.clientId) missing.push('CHROME_CLIENT_ID');
  if (!CONFIG.clientSecret) missing.push('CHROME_CLIENT_SECRET');

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach((key) => console.error(`   - ${key}`));
    console.error('\nPlease set these in your .env.chrome-webstore file.');
    console.error('See .env.chrome-webstore.example for reference.\n');
    process.exit(1);
  }

  // If refresh token is missing, offer to generate it automatically.
  if (!CONFIG.refreshToken) {
    const autoGetToken = process.env.AUTO_GET_TOKEN !== 'false';

    if (!autoGetToken) {
      console.error('❌ CHROME_REFRESH_TOKEN is not set.\n');
      console.error('Generate it by running:  npm run get-token\n');
      process.exit(1);
    }

    console.log('⚠️  CHROME_REFRESH_TOKEN is not set.\n');
    console.log('🔄 Attempting to generate refresh token automatically...\n');

    try {
      execSync('node scripts/get-refresh-token.js', { stdio: 'inherit', cwd: rootDir });

      const dotenv = await import('dotenv');
      const result = dotenv.config({ path: envPath, override: true });

      if (result.parsed && result.parsed.CHROME_REFRESH_TOKEN) {
        CONFIG.refreshToken = result.parsed.CHROME_REFRESH_TOKEN;
        console.log('✓ Refresh token loaded. Continuing with deployment...\n');
      } else {
        console.error('❌ Failed to load refresh token after generation.\n');
        process.exit(1);
      }
    } catch (error) {
      console.error('\n❌ Failed to generate refresh token automatically.');
      console.error('   Error:', error.message);
      console.error('\nTry manually:  npm run get-token\n');
      process.exit(1);
    }
  }

  if (!fs.existsSync(CONFIG.zipPath)) {
    console.error(`❌ Extension zip not found at: ${CONFIG.zipPath}`);
    console.error('Run "npm run package" first to create dist.zip.\n');
    process.exit(1);
  }

  console.log('✓ Configuration validated');
}

function getVersion() {
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.version;
}

// Exchange the refresh token for an access token — the single source of truth for "is our
// Web Store auth alive". Used by the fast preflight (--check) and by the post-failure
// diagnostic below. Never throws; returns a plain status object.
async function checkToken() {
  if (!CONFIG.refreshToken) return { ok: false, reason: 'CHROME_REFRESH_TOKEN is not set' };
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        refresh_token: CONFIG.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) return { ok: true, scope: j.scope || '?' };
    return { ok: false, error: j.error || '', reason: `HTTP ${r.status} ${j.error || ''} ${j.error_description || ''}`.trimEnd() };
  } catch (e) {
    return { ok: false, reason: `could not reach the OAuth endpoint (${e.message})` };
  }
}

// uploadExisting()/publish() refresh the OAuth token internally, so a DEAD refresh token
// surfaces as a bare "Bad Request" (Google's token endpoint returns HTTP 400 invalid_grant).
// On any deploy failure, probe the token directly so the real cause is unambiguous in CI logs:
// either "token OK -> it's the upload/publish API" or "invalid_grant -> re-mint the token".
async function reportTokenHealth() {
  if (!CONFIG.refreshToken) return;
  const t = await checkToken();
  if (t.ok) {
    console.error(`   ⮑ OAuth token OK (scope: ${t.scope}) — the failure is the upload/publish API, not auth.`);
  } else {
    console.error(`   ⮑ OAuth token check: ${t.reason}`);
    if (t.error === 'invalid_grant') {
      console.error('   ⮑ CHROME_REFRESH_TOKEN is expired/revoked. Re-mint it (npm run get-token), update the');
      console.error('     GitHub secret, and set the OAuth consent screen to "In production" so tokens stop');
      console.error('     expiring (~7-day limit while the consent screen is in "Testing").');
    }
  }
}

// Fast credential preflight for CI (`npm run deploy -- --check`): verify the required env is
// present and the refresh token still exchanges — WITHOUT uploading or needing dist.zip. Wired
// as the first release step so a dead/rotated token fails in seconds, not after the full build.
async function preflight() {
  console.log('\n🔐 Chrome Web Store credential preflight\n');
  const missing = ['CHROME_EXTENSION_ID', 'CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN'].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error('❌ Missing required credential(s):');
    missing.forEach((k) => console.error(`   - ${k}`));
    console.error('\n   In CI these come from repo secrets; locally from .env.chrome-webstore.\n');
    process.exit(1);
  }
  const t = await checkToken();
  if (t.ok) {
    console.log(`✓ OAuth token valid (scope: ${t.scope})`);
    console.log('✓ Preflight passed — safe to build and upload.\n');
    process.exit(0);
  }
  console.error(`❌ OAuth token invalid: ${t.reason}`);
  if (t.error === 'invalid_grant') {
    console.error('   ⮑ CHROME_REFRESH_TOKEN is expired/revoked. Re-mint it (npm run get-token), then sync the');
    console.error('     GitHub secret. The consent screen is "In production" so tokens should not expire on their');
    console.error('     own — a revoke or client-secret rotation is the likely cause.');
  }
  process.exit(1);
}

async function deploy() {
  console.log('\n🚀 Starting Chrome Web Store Deployment\n');

  await validateConfig();

  const version = getVersion();
  console.log(`📦 Extension version: ${version}`);
  console.log(`📁 Zip file size: ${(fs.statSync(CONFIG.zipPath).size / 1024 / 1024).toFixed(2)} MB`);

  try {
    const webStore = chromeWebstoreUpload({
      extensionId: CONFIG.extensionId,
      clientId: CONFIG.clientId,
      clientSecret: CONFIG.clientSecret,
      refreshToken: CONFIG.refreshToken,
    });

    console.log('\n📤 Uploading extension to Chrome Web Store...');
    const zipStream = fs.createReadStream(CONFIG.zipPath);
    const uploadResult = await webStore.uploadExisting(zipStream);

    if (uploadResult.uploadState === 'SUCCESS') {
      console.log('✓ Upload successful!');

      if (CONFIG.autoPublish) {
        console.log('\n📢 Publishing extension...');
        const publishResult = await webStore.publish();

        if (publishResult.status.includes('OK') || publishResult.status.includes('PUBLISHED')) {
          console.log('✓ Extension published successfully!');
          console.log('\n✅ Deployment complete!');
          console.log(`   Version ${version} is now submitted for review.`);
          console.log('   Check your Developer Dashboard for review status.');
        } else {
          console.log('⚠️  Publish status:', publishResult.status);
          console.log('   Please check the Developer Dashboard for details.');
        }
      } else {
        console.log('\n✅ Upload complete!');
        console.log('   Extension uploaded but not published (AUTO_PUBLISH=false).');
        console.log('   Publish manually from the Developer Dashboard.');
      }
    } else {
      console.error('❌ Upload failed:', uploadResult.uploadState);
      if (uploadResult.itemError) {
        console.error('   Error details:', uploadResult.itemError);
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Deployment failed:', error.message);
    // chrome-webstore-upload surfaces the real Web Store API body in different
    // places depending on the failure; print whatever we can find so CI logs are
    // actionable (e.g. the "Privacy practices tab" gate hides here, not in .message).
    const body =
      error.response?.body ??
      error.response?.data ??
      error.body ??
      (error.response && typeof error.response.text === 'function' ? await error.response.text().catch(() => undefined) : undefined);
    if (body !== undefined) {
      console.error('   API response:', typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
    // The most common silent cause is a dead refresh token (HTTP 400 invalid_grant, which looks
    // like a bare "Bad Request"). Probe it so CI logs say plainly whether it's auth or the API.
    await reportTokenHealth();
    process.exit(1);
  }

  console.log('\n');
}

const run = CHECK_ONLY ? preflight : deploy;
run().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
