# Feedback-form backend (Google Apps Script)

Source of truth for Open Book Reader's **zero-backend feedback form**. Not part of the
extension — **not shipped** (excluded from the packaging allowlist), so it never bloats the
build. It runs in Google Apps Script under the feedback account.

## What it does

A user who has no configured mail client can't use a `mailto:` — their feedback is lost. So
the in-app **⚠ Report** (`src/report.html`) and the **uninstall survey** (`site/uninstall.html`)
also offer a web form. Both pages build the full `[feedback-meta v1]` body client-side and POST
it to **one** Google "collector" form (single field). `onFeedbackSubmit` (`feedback-form.gs`)
then emails each submission **verbatim** to the developer's feedback inbox (address in
`.meta/feedback.json`), so a form report lands in the same inbox as a `mailto:` report. The raw
response also stays in the form's Responses tab — **private to the form owner** (a redundant copy;
the developer works from the inbox, not from there). Bulk-clear it any time via
**Responses → ⋮ → Delete all responses**.

```
report.html / uninstall.html  --POST body-->  collector form  --onFeedbackSubmit-->  developer's inbox
                                                               (Apps Script)
```

## Setup

1. Open [script.google.com](https://script.google.com), new project, paste `feedback-form.gs`.
2. Run `migrate()` once; approve the Forms + Triggers + Drive + Send-email scopes. It creates the
   collector form, installs the `onFeedbackSubmit` trigger, and trashes the old 2-field uninstall
   form (recoverable from Drive Trash for 30 days).
3. Copy the logged `GFORM_ACTION` + `GFORM_ENTRY_REPORT` into the `CONFIG` blocks of
   `src/report.html` and `site/uninstall.html`.

`migrate()` is one-time; `onFeedbackSubmit` is the ongoing trigger. To change the form or bridge
later, edit here and re-run.

## Notes

- **RULE #1:** only the **public** feedback alias (`studio.peach.go+open-book-reader@gmail.com`,
  the app's sanctioned public contact) and **public form IDs** (already present in
  `site/uninstall.html`) live here — never a secret, token, or the publishing/owning account.
- **ASCII-only:** keep every string ASCII or `\uXXXX`-escaped. A raw multi-byte char (em dash,
  curly quote, CJK) gets mangled to `â??` mojibake when pasted into the Apps Script editor.
