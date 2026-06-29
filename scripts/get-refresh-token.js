#!/usr/bin/env node

/**
 * Interactive Refresh Token Generator for the Chrome Web Store API.
 *
 * One-time setup: given your OAuth Client ID + Secret, this spins up a localhost
 * server, opens the browser for consent, exchanges the auth code for a refresh
 * token, and writes it into .env.chrome-webstore.
 *
 * Usage:
 *   npm run get-token
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIRECT_URI = 'http://localhost:8123/oauth2callback';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const PORT = 8123;

// Load credentials from .env.chrome-webstore (falls back to process.env).
const envPath = path.join(__dirname, '..', '.env.chrome-webstore');
let clientId = process.env.CHROME_CLIENT_ID;
let clientSecret = process.env.CHROME_CLIENT_SECRET;

if (fs.existsSync(envPath)) {
  const dotenv = await import('dotenv');
  const result = dotenv.config({ path: envPath });
  if (result.parsed) {
    clientId = result.parsed.CHROME_CLIENT_ID || clientId;
    clientSecret = result.parsed.CHROME_CLIENT_SECRET || clientSecret;
  }
}

console.log('\n🔐 Chrome Web Store API - Refresh Token Generator\n');

if (!clientId || clientId === 'your-client-id.apps.googleusercontent.com') {
  console.error('❌ CHROME_CLIENT_ID not found or not set!');
  console.error('   Please set it in .env.chrome-webstore file\n');
  process.exit(1);
}

if (!clientSecret || clientSecret === 'your-client-secret') {
  console.error('❌ CHROME_CLIENT_SECRET not found or not set!');
  console.error('   Please set it in .env.chrome-webstore file\n');
  process.exit(1);
}

console.log('✓ Found Client ID:', clientId.substring(0, 20) + '...');
console.log('✓ Found Client Secret:', clientSecret.substring(0, 10) + '...\n');

// Exchange the authorization code for tokens (uses Node's global fetch).
async function getTokens(code) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

function updateEnvFile(refreshToken) {
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env.chrome-webstore file not found!');
    return false;
  }

  let content = fs.readFileSync(envPath, 'utf8');

  if (content.includes('CHROME_REFRESH_TOKEN=')) {
    content = content.replace(
      /^#?\s*CHROME_REFRESH_TOKEN=.*/m,
      `CHROME_REFRESH_TOKEN=${refreshToken}`
    );
  } else {
    content += `\nCHROME_REFRESH_TOKEN=${refreshToken}\n`;
  }

  fs.writeFileSync(envPath, content);
  return true;
}

function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.error('   Could not open browser automatically. Please open this URL manually:');
      console.error(`   ${url}\n`);
    }
  });
}

async function main() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname === '/oauth2callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #d32f2f;">❌ Authorization Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error(`Authorization failed: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #d32f2f;">❌ No Authorization Code</h1>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          console.log('✓ Authorization code received');
          console.log('📡 Exchanging code for refresh token...\n');

          const tokens = await getTokens(code);

          if (tokens.refresh_token) {
            console.log('✅ SUCCESS! Refresh token obtained!\n');
            console.log('🔑 Refresh Token:', tokens.refresh_token.substring(0, 30) + '...\n');

            if (updateEnvFile(tokens.refresh_token)) {
              console.log('✓ Updated .env.chrome-webstore file\n');
              console.log('🎉 Setup complete! You can now run: npm run deploy\n');
            } else {
              console.log('⚠️  Could not update .env.chrome-webstore file automatically');
              console.log('   Please add this line manually:');
              console.log(`   CHROME_REFRESH_TOKEN=${tokens.refresh_token}\n`);
            }

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                  <h1 style="color: #4caf50;">✅ Success!</h1>
                  <p style="font-size: 18px;">Refresh token has been generated and saved.</p>
                  <p>You can close this window and return to your terminal.</p>
                  <p style="margin-top: 40px; color: #666;">Next step: <code>npm run deploy</code></p>
                </body>
              </html>
            `);

            server.close();
            resolve(tokens.refresh_token);
          } else {
            throw new Error('No refresh token in response');
          }
        } catch (err) {
          console.error('❌ Error exchanging code for token:', err.message);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #d32f2f;">❌ Token Exchange Failed</h1>
                <p>${err.message}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(err);
        }
      }
    });

    server.listen(PORT, () => {
      console.log('🌐 Starting local OAuth server...\n');
      console.log('📋 IMPORTANT: Make sure you added this redirect URI to your OAuth client:');
      console.log(`   ${REDIRECT_URI}\n`);
      console.log('💡 Opening browser for authorization...\n');

      const authUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(SCOPE)}` +
        `&access_type=offline` +
        // Force the account chooser every time — minting with the wrong Google account yields a
        // token that authenticates fine but 403s on upload (it doesn't own the extension).
        `&prompt=${encodeURIComponent('select_account consent')}`;

      setTimeout(() => openBrowser(authUrl), 1000);
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Please close other applications using this port.\n`);
      } else {
        console.error('❌ Server error:', error.message);
      }
      reject(error);
    });
  });
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('\n❌ Failed to get refresh token:', error.message);
  console.error('\nPlease check:');
  console.error('  1. Your Client ID and Secret are correct');
  console.error('  2. You added the redirect URI to your OAuth client');
  console.error(`     Redirect URI: ${REDIRECT_URI}`);
  console.error('  3. Chrome Web Store API is enabled in Google Cloud Console\n');
  process.exit(1);
});
