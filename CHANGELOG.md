# Changelog

All notable changes to **Open Book Reader** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> History note: this public repository was started at the open-source release. Tags for
> `v0.2.0` and `v0.3.0` were cut in the original (private) development repo, so those entries
> below are documented for completeness but have no compare links here.

## [Unreleased]

### Added
- Reader: realistic **page-turn animations** for the two-page text reader — a soft paper
  **curl** (default) and a rigid **book** 3D flip, alongside plain **slide** and instant
  **off**, selectable under Options - Reader - Page turn. Respects your OS "reduce motion"
  setting and adds no new permission.

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

[Unreleased]: https://github.com/kouxing2000/open-book-reader/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kouxing2000/open-book-reader/releases/tag/v1.0.0
[0.3.1]: https://github.com/kouxing2000/open-book-reader/releases/tag/v0.3.1
