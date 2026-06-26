# Chrome Web Store — listing (source of truth)

Everything needed to fill or re-fill the Web Store listing for **Open Book Reader**.
Open this when submitting a new version; copy each field into the dashboard.

- **Item (extension) ID:** `kmcomogkbbdjhfocbncljmgcnfmaljca` — public; goes in
  `.env.chrome-webstore` as `CHROME_EXTENSION_ID` for `npm run deploy`.
- **Edit listing:** open the item in the
  [Developer Dashboard](https://chrome.google.com/webstore/devconsole) (sign in as the owner).
- **Public store URL:** https://chromewebstore.google.com/detail/kmcomogkbbdjhfocbncljmgcnfmaljca
- **Listing fields are dashboard-only** — the Web Store API (`npm run deploy`) uploads/publishes
  the *package* but cannot set any of the copy/assets below. This doc is the durable copy.

> The actual credentials — `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` /
> `CHROME_REFRESH_TOKEN` — live ONLY in the gitignored `.env.chrome-webstore`, never here.

---

## Graphic assets

Screenshots + promo tile are **regenerated** (not committed — they live in gitignored
`store-assets/`). Refresh after any UI change:

```
npm run screenshots
```

| Store slot | Spec | File |
|---|---|---|
| Store icon | 128×128 | `icons/icon128.png` (tracked; master in `store/assets/icon-master-1024.png`) |
| Screenshot 1 | 1280×800 | `store-assets/00-before-after.png` — **text hero**: cluttered article → open book |
| Screenshot 2 | 1280×800 | `store-assets/00b-gallery-before-after.png` — **gallery hero**: cluttered image page → masonry wall |
| Screenshot 3 | 1280×800 | `store-assets/02-reader-dark-3col.png` — dark theme, 3 columns |
| Screenshot 4 | 1280×800 | `store-assets/04-gallery-lightbox.png` — lightbox |
| Screenshot 5 | 1280×800 | `store-assets/01-reader-paper.png` — text reader, paper theme (full-size open-book beauty shot) |
| _(unused)_ | 1280×800 | `store-assets/03-gallery-masonry.png` (redundant with the gallery hero), `store-assets/05-options.png` (options) |
| Small promo tile | 440×280 | `store-assets/promo-440x280.png` |
| Marquee promo tile | 1400×560 | `store/assets/marquee-1400x560.png` (tracked) |

The store accepts **PNG/JPEG only — no GIF/animation**; the two before/after heroes are therefore static (the
highest-converting tiles, shown first — one per mode). The only motion slot is the optional **YouTube promo
video** field. Each hero is composited from two full-viewport shots by `capture-screenshots.mjs`; the "before"
fixtures are the no-network `tests/fixtures/demo-cluttered.html` (text) and `demo-gallery-cluttered.html`
(images), each reusing the same content as its clean `demo-*.html` counterpart so the transform is honest.

Screenshots are rendered against the no-network demo fixtures in `tests/fixtures/demo-*.html`
by `scripts/capture-screenshots.mjs`. The **icon** (dual-page book: text + image, amber) and the
**marquee** are tracked one-offs in `store/assets/` — to revise the icon, edit/regenerate the
1024 master there and re-run the resize into `icons/icon{16,32,48,128}.png`.
(`store/assets/marquee-art-source.png` is the square hero art the marquee is composed from.)

---

## Listing tab

**Category:** Productivity → **Tools** (the store nests categories now: "Productivity" is a
group header, "Tools" is the selectable item. Alt within the group is "Education", but this is
a reading utility, not educational content — Tools fits.)
**Language:** English (United States)
**Homepage URL:** https://kouxing2000.github.io/open-book-reader/
**Support URL:** https://kouxing2000.github.io/open-book-reader/
**Official URL:** leave **None** (requires Search Console domain verification — not worth it).

**Short description** (132 char max; 130 chars — keep `manifest.json` `description` in sync):

> Read any article as a calm two-page open book — flip with the arrow keys. Plus an image-gallery mode. Private, local, open source.

**Description** (plain text — the store field does NOT render markdown):

```
Open Book Reader turns any long web article into a calm, two-page reading experience — like an open book, right on top of the page.

Click the toolbar icon and it picks the right view for the page automatically: the two-page reader for articles, the image gallery for picture-heavy pages. Or go straight to one — Alt+B always opens the reader, Alt+Shift+B always opens the gallery.

In the reader, it extracts the text with Mozilla Readability, strips away ads, sidebars, and clutter, and lays the story out as two facing pages you flip with the arrow keys.

READING THAT FEELS LIKE A BOOK
• Two-page open-book spread with a center spine — or switch to 3 or 4 columns per view
• Flip with the arrow keys, Space, or PageUp/PageDown — or click the left/right page edges
• Jump to the start or end with Home / End
• Resumes right where you left off — reopen an article and you're back on the same page
• A slim progress bar and an estimated reading time show how far you've come
• Paper, Light, and Dark themes
• Adjustable font size and line height; serif or sans-serif
• Fills the window by default, with an optional max width for a comfortable line length
• Print the clean article — or save it as a tidy PDF — in one click (or press P)
• Controls auto-hide while you read and reappear when you move the mouse

A SECOND MODE: IMAGE GALLERY
• Press Alt+Shift+B to see every image on the page as a Pinterest-style masonry wall
• Lazy-loaded images hydrate progressively as you scroll, so long pages fill in fully
• Click any image for a full-screen lightbox with arrow-key navigation
• Optionally download a single image — or select several and save them as a ZIP

PRIVATE BY DESIGN
• No accounts, no tracking, no analytics — nothing is ever sent to the developer
• Article reading and extraction happen entirely in your browser
• The only time it touches the network is when you click to download images from the gallery
• Your settings sync across your own signed-in devices via Chrome's storage
• Open source — don't take our word for it; read every line and verify the privacy claims yourself at https://github.com/kouxing2000/open-book-reader

Your reading, your pages. Slow down and enjoy the long form.
```

---

## Privacy tab

**Single purpose:**

> An on-demand reading view for the current page: reformat the article into a two-page book, or browse the page's images as a gallery. It runs only when the user invokes it.

**Permission justifications** (one box per permission):

| Permission | Justification |
|---|---|
| `activeTab` | Granted when the user clicks the toolbar icon or presses Alt+B; lets the extension read the current tab to render the reading view. |
| `scripting` | Inject the reader/gallery engine into the page on user gesture. |
| `storage` | Persist the user's reading preferences (theme, font size, columns, gallery column width). |
| `downloads` (optional) | Save images the user explicitly downloads from the image-gallery mode. |
| Host `<all_urls>` (optional) | Fetch image bytes cross-origin to bundle a user-requested ZIP of selected gallery images. Nothing is sent anywhere. |

**Remote code:** No — all code (including the Readability library) is bundled in the package.

**Data usage:** tick **does NOT collect** for every category, then check the certification box.
- Collects/uses personal or sensitive data? **No.**
- Sold to third parties / used for unrelated purposes / used for creditworthiness? **No to all.**
- Network requests occur only on a user-initiated image download (`chrome.downloads` + a
  cross-origin fetch to bundle a ZIP). Bytes go only to the user's device.

**Privacy policy URL:** https://kouxing2000.github.io/open-book-reader/privacy.html

---

## Distribution tab

- **Visibility:** Public
- **Regions:** all
- **Pricing:** Free

---

## Access → Test instructions (optional, pre-empts reviewer confusion)

```
No login required. Open any article and press Alt+B for the two-page reader, or Alt+Shift+B for the image gallery (or use the toolbar icon).
```

---

## Maintenance — updating a published listing

1. Bump `version` in `manifest.json`.
2. `npm run package` → `dist.zip` (+ `package/SUBMISSION_CHECKLIST.md`, auto-generated).
3. Upload: dashboard, or `npm run deploy` once `.env.chrome-webstore` is configured
   (CHROME_EXTENSION_ID = the Item ID above; see `scripts/README-release.md`).
4. If the UI changed: `npm run screenshots`, then re-upload the slots in the table above.
5. Re-paste any copy that changed from this doc. Keep `manifest.json` `description` ==
   the short description here.
6. After the listing is live, point the "Add to Chrome" button in `site/index.html` at the
   public store URL above (the `site/` changes auto-deploy to GitHub Pages on push to `master`).
