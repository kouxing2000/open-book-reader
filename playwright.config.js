import { defineConfig } from '@playwright/test';

/* Integration tests for the Open Book Reader extension.
 * Browser tests load the unpacked extension via a custom fixture (tests/fixtures.js).
 * A tiny static server (tests/server.js) serves the fixture article. */
export default defineConfig({
  testDir: './tests',
  // Pin the Chrome-for-Testing UI locale to English on macOS so extension-page tests are
  // deterministic regardless of the dev's OS language (see tests/mac-locale.js). No-op on Linux.
  globalSetup: './tests/global-setup.js',
  globalTeardown: './tests/global-teardown.js',
  fullyParallel: false,
  workers: 1, // extension tests share a persistent profile pattern; keep it serial
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: [['list']],
  webServer: {
    command: 'node tests/server.js',
    port: 5099,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  use: {
    baseURL: 'http://localhost:5099',
  },
});
