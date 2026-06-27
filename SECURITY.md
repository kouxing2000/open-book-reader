# Security Policy

Open Book Reader is a Chrome MV3 extension. It runs **only when you invoke it** (toolbar
click, `Alt+B`, or `Alt+Shift+B`) and reads entirely locally — no telemetry, nothing sent to
the developer. The one network case is when you explicitly download gallery images. Even so,
because the extension injects scripts into the page you're reading and can hold `<all_urls>`
host access (optional, granted only at first image download), security reports matter to us.

## Supported versions

Only the latest released version on the Chrome Web Store is supported. Please make sure you're
on the current version before reporting.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue for an
exploitable vulnerability.

Preferred channels:

- **GitHub** → the repository's **Security** tab → **Report a vulnerability** (private advisory).
- **Email**: `studio.peach.go+open-book-reader@gmail.com` (the same address the in-app
  "Report a problem" button uses).

Please include:

- The extension version (`manifest.json` `version`, shown on `chrome://extensions`).
- Your Chrome version and OS.
- Steps to reproduce, and the impact you believe it has.
- A proof-of-concept page or URL if one is relevant.

## What to expect

- We aim to acknowledge a report within **7 days**.
- We'll confirm the issue, agree on a fix and a disclosure timeline with you, and credit you
  in the release notes unless you'd prefer to stay anonymous.
- Fixes ship through the normal tag-driven Chrome Web Store release; the rollout then depends
  on Google's review queue.

## Scope

In scope: anything in this repository that ships in the extension package — `manifest.json`,
`src/`, and the vendored `src/content/readability.js`. Issues in the bundled Mozilla Readability
that originate upstream should also be reported to the
[Readability project](https://github.com/mozilla/readability).

Out of scope: the developer's release tooling (`scripts/`, CI), and content fetched from the
pages you choose to read (the extension renders that content; it does not vet it).
