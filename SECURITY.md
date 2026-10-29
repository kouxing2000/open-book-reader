# Security Policy

Open Book Reader is a Chrome MV3 extension. It runs when you invoke it (toolbar click,
`Alt+B`, `Alt+Shift+B`, or the right-click menu), and otherwise only where access you granted
allows it: on sites you turned auto-open on for, and on a shared article you open from a share
link when Open Book already has access to that article's site (the opt-in to open shared links
in reading mode, auto-open there, or access you gave that site for a ZIP download). It reads
entirely locally, with no telemetry, and sends nothing on its own: network requests happen only
when you explicitly download gallery images, and a problem report reaches the developer only
when you choose to send one. Even so, because the extension injects scripts into the pages you
read and can hold `<all_urls>` host access (optional, granted only through an explicit choice:
a ZIP prompt's "Allow all sites instead" or the opt-in to open shared links in reading mode),
security reports matter to us. The README's Permissions section lists every permission and
what uses it.

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
