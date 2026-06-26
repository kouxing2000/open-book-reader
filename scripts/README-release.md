# Release tooling

Chrome Web Store publishing automation for Open Book Reader. The shipped extension is
zero-dependency vanilla JS — this tooling is dev-time only (see `package.json` devDependencies).

## Scripts

| Command | Script | What it does |
| --- | --- | --- |
| `npm run package` | `package-extension.js` | Zips the allowlist (`manifest.json`, `icons/`, `src/`) → `dist.zip` + `package/<name>-v<ver>.zip` + `SUBMISSION_CHECKLIST.md`. No build step. |
| `npm run get-token` | `get-refresh-token.js` | One-time OAuth: spins up `localhost:8123`, opens browser for consent, writes `CHROME_REFRESH_TOKEN` into `.env.chrome-webstore`. |
| `npm run deploy` | `deploy-to-store.js` | Uploads `dist.zip` via the Chrome Web Store API. Publishes unless `AUTO_PUBLISH=false`. Auto-runs `get-token` if the refresh token is missing. |
| `npm run release` | — | `package` then `deploy`. |

## First-time setup

1. `cp .env.chrome-webstore.example .env.chrome-webstore` (gitignored).
2. Google Cloud Console → new project → enable **Chrome Web Store API** → create an **OAuth 2.0
   Client ID**. For a Web application client, add redirect URI `http://localhost:8123/oauth2callback`.
3. Fill `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` in `.env.chrome-webstore`.
4. Do the **first** upload manually in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   to mint the extension ID, then set `CHROME_EXTENSION_ID`.
5. `npm run get-token`.

After that: `npm run package && npm run deploy`.

## Notes

- `deploy` is an outward publish action — confirm each release explicitly.
- Permissions to justify in the listing: `activeTab`, `scripting`, `storage` (no host permissions,
  no network, no data collection).
