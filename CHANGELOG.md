# Changelog

All notable changes to **Open Book Reader** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> History note: this public repository was started at the open-source release. Tags for
> `v0.2.0` and `v0.3.0` were cut in the original (private) development repo, so those entries
> below are documented for completeness but have no compare links here.

## [Unreleased]

## [1.7.0] - 2026-07-20

### Added
- **See and manage which sites the extension can access.** Settings now has a **Site access**
  section listing every site you've granted — for auto-open or for image downloads — each with a
  one-tap **Revoke** (and **Grant** to restore one). It says plainly what each grant is for, and
  flags any that are redundant or no longer used, so nothing lingers without your knowing.
- **Articles now end like a book — with a back cover.** Finish a long read and a quiet closing
  page appears: "The End", the article's length and your reading time, and — from your third
  finished article — your running totals (articles finished, hours read) with an inline "hide"
  link. Both the totals line and the whole page have Settings toggles. Reading time only counts
  while you're actually there, everything stays on your device, and nothing is ever sent.
- **A small, rare "Enjoying it?" note.** The back cover carries a quiet rate/feedback line, and
  regular readers may once see the same question as a small chip after closing the reader. It
  asks at most twice ever, months apart — and rating, sending feedback, or dismissing it
  silences every ask, on every synced device.

### Changed
- **Downloading images now asks only for the sites those images come from** — no longer for access
  to every site you visit. The prompt lists exactly which sites it needs. If you download from many
  sites and would rather not be asked each time, an **Allow all sites instead** option sits right
  there and explains the trade-off — broad access stays a deliberate choice, never the default.
- **Turning auto-open off now hands the site's permission back.** Whether you uncheck it in
  Settings, delete the rule, choose **Stop auto-opening**, or **Reset to defaults**, the extension
  no longer keeps access to a site it has stopped using — and a shared grant is kept only while
  another rule on the same site still needs it.

### Fixed
- **Auto-open now shows when it's paused.** If you revoke a site's access from Chrome's own
  extensions page, that site's rule stays listed but is clearly marked paused, with a one-click way
  to re-grant — instead of the checkbox looking on while auto-open quietly does nothing.

## [1.6.0] - 2026-07-19

### Added
- **Auto-open — reading mode with zero clicks, per site.** Turn it on for a site (right-click →
  **Auto-open on this site**) and its content pages open in the reader or gallery by themselves,
  while list, search, and index pages stay untouched — and **Esc** always closes. It's strictly
  opt-in and asks once for permission to run on that site. An **Auto-open on pages like this…**
  option scopes it to just one section (a single forum, a manga series) instead of the whole site.
- **A QR / branding footer on printed pages.** When you 🖨 Print / Save as PDF, the saved copy can
  carry a small "Open Book Reader" footer with a QR code back to the extension — so a shared PDF
  can lead readers to it. Fully local (nothing is sent); turn it off under Settings.

### Changed
- **Redesigned settings page.** Groups are now collapsible sections instead of one long scroll, and
  everything specific to a site — per-site rules, saved content picks, and hidden-image filters —
  lives together under one **Per-site data** section (with a count of how many sites you've
  customized). It remembers which sections you left open.
- **Clearer right-click menu.** Immediate actions are now prefixed **Open now:**, a site's default
  view lives in a **Configure Default** submenu that also shows the current selection, and the
  smart auto-pick is now labelled **Smart pick** (it was "Auto", which clashed with Auto-open).
- **Editable per-site rules.** Each rule now describes in plain language what it does, its URL
  pattern is editable in place with live validation, and a **Focus on a site** filter scopes the
  lists to one site.
- All of the new menu, settings, and print options are translated in every supported language.

### Fixed
- Your reading position is now saved when you switch tabs or navigate away — not only when you
  close the reader — so you resume in the right spot more reliably.

### Security
- Hardened the reader's content sanitization (strips `<iframe>` / `<form>` and other injection
  vectors from extracted page content) and the gallery's image-download fetch (guards against
  server-side request forgery).

## [1.5.0] - 2026-07-16

### Added
- **Ordered gallery layout — read images in sequence.** The masonry Wall scrambles reading
  order by design, so the gallery now has a **Wall / Ordered** toggle: Ordered lays images out
  row by row in page order, and the Size slider goes all the way down to a single centered
  page — a hands-free webtoon/manga reader when combined with Auto-scroll. Each site remembers
  the layout and size you left it in.
- **Fit-width lightbox reading.** A ⟷ toggle (or the `F` key) in the full-screen view fits a
  tall page to the width and lets you scroll down it — for reading one comic/scan page at a
  time — instead of shrinking the whole page to fit.
- **Image filter — hide avatars and repeated noise.** Forums flood the gallery with profile
  pics; a new automatic filter drops avatars/emoji/badges (detected by their markup, never by
  size, so album art and product shots stay — and it's recoverable: filtered images ride the
  "N hidden · Show" toggle, where Unhide whitelists one for good). A ⊘ **Hide** button on every
  tile adds precise per-site rules: this image, its folder, the whole site, or **images in this
  spot** (by page structure, for noise a URL can't distinguish) — hovering an option previews
  exactly which images would disappear. Hidden rules are editable on the options page.

### Changed
- The options-page guide, README, and site now describe the new gallery features.

## [1.4.0] - 2026-07-06

### Added
- **Now available in Simplified Chinese (简体中文)** — 8 languages in total. The reader, gallery,
  right-click menu, and the Chrome Web Store title and summary all follow your browser's language
  automatically (English stays the default).

### Changed
- **More of the extension now follows your browser's language, not just the reader.** The settings
  page (including the full "How to use & shortcuts" guide), the "Report a problem" page, and the
  optional-permission prompt are now translated in every supported language — previously they stayed
  English.

## [1.3.1] - 2026-07-04

### Added
- **Now available in 6 more languages** — Spanish, Portuguese (Brazil), German, Japanese, French,
  and Russian. The reader and gallery, the right-click menu, and the Chrome Web Store title and
  summary all follow your browser's language automatically (English stays the default).

### Changed
- Renamed to **"Open Book — Reader View"** — the same extension, with a clearer name that says what
  it does and is easier to find in Chrome Web Store search.

## [1.2.1] - 2026-07-01

### Changed
- Gallery: the **Size slider now picks a column count**, not a pixel width — every notch changes
  the layout, and "biggest" is a 2-up grid on any screen (never a single full-width image; that is
  what the lightbox is for).

### Fixed
- Gallery: closing the lightbox now **returns the grid to the image you were viewing** instead of
  jumping back to the top.
- Reader: **toolbar buttons no longer wrap their labels** letter-by-letter on some pages. On a
  narrow / split / zoomed window the controls now flow onto their own row so **Settings and Close
  stay reachable** instead of sliding off the edge.
- Reader: a **slow-loading image no longer disrupts a page-turn.** The turn is now a coherent
  snapshot of the page you are on and the one you are turning to, and a late re-pagination waits for
  the turn to finish rather than aborting it mid-swing or landing on the wrong page.

## [1.2.0] - 2026-06-30

### Added
- Reader: **content override** for when extraction grabs the wrong block — three escalating,
  zero-new-permission ways to fix it. Read your **text selection**; **⌖ Pick** the exact block on
  the page (uBlock-style hover-highlight, click to read it); or **save a per-site** choice that
  auto-applies when you return. A "Wrong content?" hint now appears **only when the parse looks
  suspect** (it failed, or kept less than half of a content-rich page) rather than on every page;
  the ⌖ Pick button is always available. Options lists, edits, and removes saved picks.

### Changed
- Reader: **page text is fully selectable everywhere.** The click-to-flip page edges no longer sit
  over the text and block selection — edge-clicks still turn the page, but a drag or double-click
  selection near the edge no longer flips it.

### Fixed
- Reader: opening no longer leaves an **unclosable overlay** if it is interrupted mid-init
  (e.g. the gallery takes over during load).
- Reader: guard `open()` against **concurrent re-initialization** (rapid double-trigger / mode switch).
- Options: clicking ⚙ now **reuses the existing options tab** instead of opening a new one each time.
- Gallery: hands-free auto-scroll now **stops on infinite-scroll pages** that keep growing without
  surfacing new images (and self-heals when images later arrive).
- Gallery: the column-width slider no longer **spams `storage.sync`** on every drag (debounced).

### Security
- Reader: harden the **HTML sanitizer** — close gaps found in the content-override review and
  **normalize control/whitespace characters** in URL schemes, so an obfuscated `javascript:` URL
  (control or tab characters hidden inside the scheme) can no longer slip the filter.

## [1.1.0] - 2026-06-29

### Added
- Reader: realistic **page-turn animations** for the two-page text reader — a soft paper
  **curl** (default) and a rigid **book** 3D flip, alongside plain **slide** and instant
  **off**, selectable under Options - Reader - Page turn. Respects your OS "reduce motion"
  setting and adds no new permission.

### Changed
- Reader: the toolbar's Print button now shows a "Print" label, matching Report / Settings / Close.

## [1.0.0] - 2026-06-27

First stable release — Open Book Reader graduates from the 0.x series.

### Added
- Reader: print / save the cleaned article as a **PDF** — the 🖨 toolbar button (or the `P` key)
  reuses the already-parsed article, flows it vertically onto white paper, and hands it to the
  browser's print dialog (where "Save as PDF" lives). Fully local, no new permission.
- Reader: **auto theme** that follows your OS light/dark mode.
- Gallery: hands-free **auto-scroll** with adjustable speed.
- Gallery: **thumbnail filmstrip** + autoplay **slideshow** in the lightbox.
- Options: toggle for the print source-URL footer; settings reorganized into grouped cards.

### Fixed
- Gallery: auto-scroll speed now persists when edited via the typed field or the spinner.

## [0.3.1] - 2026-06-26

### Fixed
- Gallery: keep the toolbar labels on one line in a narrow window.

## [0.3.0] - 2026-06-23

### Added
- Reader: **resume your reading position** when you reopen an article, with a slim progress bar
  and an estimated reading time.

### Fixed
- Reader: reading progress is preserved across font-size and column-count changes — position is
  stored as a fraction of the article, not a page index, so re-pagination no longer loses your place.

## [0.2.0] - 2026-06-22

First public release on the Chrome Web Store.

### Added
- Two-page open-book **text reader**: Mozilla Readability extraction → Shadow-DOM render →
  CSS-column pagination, keyboard page-flipping, paper / light / dark themes, adjustable
  font / width / line-height, synced via `chrome.storage.sync`.
- **Image-gallery** mode: JS masonry wall + lightbox, progressive / lazy image loading,
  "Load all", and explicit image downloads (single image + ZIP of the set).
- **Smart auto-mode**: the toolbar icon picks reader vs gallery based on article prose vs
  image density (a substantial article always wins).
- **Per-site rules**: right-click menu to always open a site as Reader or Gallery
  (path + wildcard globs, most-specific wins).
- In-extension quick guide and an options page.
- **Report a problem**: opens a prefilled email in your own mail client — the extension
  transmits nothing itself, so the privacy posture holds.
- Privacy-clean optional permissions (`downloads` + `<all_urls>`) requested only at first
  image download, never at install.

_Earlier 0.1.x builds were internal and never released._

[Unreleased]: https://github.com/kouxing2000/open-book-reader/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.7.0
[1.6.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.6.0
[1.5.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.5.0
[1.4.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.4.0
[1.3.1]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.3.1
[1.2.1]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.2.1
[1.2.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.2.0
[1.1.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.1.0
[1.0.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.0.0
[0.3.1]: https://github.com/kouxing2000/open-book-reader/releases/tag/v0.3.1
