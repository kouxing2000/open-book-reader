# Contributing to Open Book Reader

Thanks for your interest! This is a small, zero-dependency, zero-build Chrome MV3 extension —
contributing is deliberately low-ceremony.

## Project philosophy

- **No build, no bundler, no runtime deps.** Chrome loads `manifest.json` + `src/` + `icons/`
  directly. The `package.json` devDependencies are release/test tooling only — they are never
  bundled into the shipped extension. Keep it that way: new shipped code is plain ES (IIFE
  modules), and all shared state hangs off `globalThis.OBR`.
- **Privacy is a feature.** No telemetry, nothing sent to the developer. Reading is fully local.
  The only network call is a user-triggered image download. Any change that would weaken this
  (new tracking, a new always-on permission) is very unlikely to be accepted.
- **Minimal permissions.** Don't add a manifest permission unless it's genuinely required, and
  prefer optional permissions requested at first use. (For example, do **not** add the `tabs`
  permission — the restricted-page guard works via `activeTab` already.)

## Develop locally

1. Clone the repo.
2. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select
   the repo folder.
3. On any article, click the toolbar 📖 icon or press **Alt+B** (text) / **Alt+Shift+B** (gallery).

### The reload gotcha

After editing:

- **`background.js` changes** → reload the extension card on `chrome://extensions`.
- **content-script changes** (`settings.js` / `reader.js` / `gallery.js`) → reload the
  extension card **and** reload the web page. Reloading the extension does **not** re-inject
  into already-open tabs, and the `_engineLoaded` guard skips re-injection — stale content
  scripts are the usual "my change didn't apply" cause.

## Tests

Playwright loads the unpacked extension into real Chromium and drives it against local fixtures.

```bash
npx playwright install chromium      # first run only
npm test                             # all integration + packaging tests (headless)
npm run test:headed                  # visible browser
npx playwright test reader.spec.js -g "flips"   # a subset
```

`npm run test:manual` runs the real engine against a server-side snapshot of a real site
(see `tests/manual-site-proxy.mjs`). Please run `npm test` before opening a PR, and add or
update a test when you change engine behavior.

## Commits & pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(reader): …`,
  `fix(gallery): …`, `chore(release): …`, `test: …`, `docs: …`.
- Keep PRs focused; describe the user-visible change and how you verified it (UI changes need a
  screenshot or a clear repro).
- Add a bullet under **`## [Unreleased]`** in [`CHANGELOG.md`](CHANGELOG.md) for any
  user-facing change. (Maintainers: `npm run bump` rolls the Unreleased section into the new
  version automatically.)
- Don't edit `src/content/readability.js` — it's vendored Mozilla Readability (Apache-2.0);
  fixes go upstream.
- Don't bump the version or commit `dist.zip`/generated assets in a feature PR — releases are
  tag-driven and handled by maintainers.

## Security

Found a vulnerability? Please report it privately — see [`SECURITY.md`](SECURITY.md), not a
public issue.

## Architecture

For a deeper map of how injection, the two modes, pagination, and downloads work, see the
**Architecture** section of [`README.md`](README.md) and the project notes in `CLAUDE.md`.
