# Privacy Policy — Open Book Reader

_Last updated: 2026-06-15_

Open Book Reader is designed to be completely private.

## What we collect

**Nothing.** The extension does not collect, store, or transmit any personal data,
browsing history, or page content to us or any third party.

## Network activity

Core reading is fully local: article extraction and pagination (and the image-gallery
layout) happen entirely in your browser, and the Mozilla Readability library is bundled
inside the extension — nothing is fetched from external servers for reading.

The extension makes network requests in **one case only: when you explicitly download
images** from the image-gallery mode. To save an image, or to bundle several into a ZIP,
your browser fetches those image URLs (the same images the page already shows). This
happens only on your action (clicking a download / ZIP button), the bytes go only to your
device, and **nothing is ever sent to the developer or any third party.**

## Reporting a problem

The reader and image-gallery toolbars have a **⚠ Report** button. Clicking it opens **your
own email client** with a pre-filled message so you can tell the developer a page didn't
work. The draft includes the address of the page you were on (path only — any `?query`
string is stripped), the mode you were using, and the extension version, so the bug can be
reproduced. **The extension itself sends nothing** — it only prepares the draft; you review
it and decide whether to send it from your own email account. If you don't click Send,
nothing leaves your device.

## Data stored on your device

Your reading preferences (font size, theme, book width, spine width, line height) are
stored using Chrome's `storage.sync` API. This data stays within your own browser profile
and may sync across your signed-in devices via Google's account sync. It is never sent to
the developer.

## Permissions

Requested at install (the minimal set):

- **activeTab / scripting** — used only to render the reading view (text or image gallery)
  on the page you explicitly activate it on.
- **storage** — used only to remember your preferences.

Optional — requested only the first time you download an image, never at install:

- **downloads** — used only to save images you explicitly download from the image gallery.
- **host access (`<all_urls>`)** — used only to fetch image bytes when you ask to download a
  ZIP of selected images. It is never used to read, monitor, or transmit page content.

The extension only runs when you click its icon or press its keyboard shortcut. It does
not run in the background or on pages you have not activated it on.

## Contact

For questions about this policy, open an issue at the project's repository.
