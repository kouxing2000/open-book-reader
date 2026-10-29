# Release tooling

Chrome Web Store publishing automation for Open Book Reader. The shipped extension is
zero-dependency vanilla JS — this tooling is dev-time only (see `package.json` devDependencies).

## Scripts

| Command | Script | What it does |
| --- | --- | --- |
| `npm run package` | `package-extension.js` | Zips the allowlist (`manifest.json`, `icons/`, `src/`) → `dist.zip` + `package/<name>-v<ver>.zip` + `SUBMISSION_CHECKLIST.md`. No build step. |
| `npm run get-token` | `get-refresh-token.js` | One-time OAuth: spins up `localhost:8123`, opens browser for consent, writes `CHROME_REFRESH_TOKEN` into `.env.chrome-webstore`. |
| `npm run deploy` | `deploy-to-store.js` | Uploads `dist.zip` via the Chrome Web Store V2 API, waits for processing, and submits for review unless `AUTO_PUBLISH=false`. Auto-runs `get-token` if the refresh token is missing. |
| `npm run release` | — | `package` then `deploy`. |

## First-time setup

1. `cp .env.chrome-webstore.example .env.chrome-webstore` (gitignored).
2. Google Cloud Console → new project → enable **Chrome Web Store API** → create an **OAuth 2.0
   Client ID**. For a Web application client, add redirect URI `http://localhost:8123/oauth2callback`.
3. Fill `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` in `.env.chrome-webstore`.
4. Do the **first** upload manually in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   to mint the extension ID, then set `CHROME_EXTENSION_ID`. Set `CHROME_PUBLISHER_ID` from
   the dashboard's Publisher > Settings section. Both belong in the ignored environment file; CI also
   needs the corresponding Actions secrets.
5. `npm run get-token`.

After that: `npm run package && npm run deploy`.

## Notes

- `deploy` is an outward publish action — confirm each release explicitly.
- A confirmed `PENDING_REVIEW` submission exits successfully and is labelled submitted for
  review. It does not mean the extension is public yet. Failed, malformed, or unconfirmed
  upload/submission results fail the command so CI cannot create a successful release.
- Upload processing is polled for a bounded interval. A pending timeout or a lost write
  response fails without replaying the upload/submission; inspect the dashboard before
  retrying. Avoid concurrent local/dashboard uploads while the release job is running.
- CI serializes tag releases for this store item with cancellation disabled. This does not
  coordinate separate dashboard sessions or locally invoked deploys.
- Permissions to justify in the listing: every entry in `manifest.json`'s `permissions`,
  `optional_permissions` and `optional_host_permissions`; the README's Permissions section
  says what uses each. No data collection.
