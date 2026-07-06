// Report page logic. MUST be an external file — MV3 extension pages run under a strict CSP
// (script-src 'self') that blocks inline <script>, so an inline version silently never runs
// (the Send button stays disabled, diagnostics stay empty). See src/report.html.

// ── CONFIG (report Google Form) ─────────────────────────────────────
// Create the report form with the feedback-form skill's create-form.gs (ONE paragraph
// question, e.g. "report"), then paste its formResponse URL + the single entry id here.
// Leave blank to use the email path only (works out of the box).
var GFORM_ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSe-dBYo1dGI_sDYqo9VInP7bgXXrV4KvxXILTCIkzW-rGT1AA/formResponse';
var GFORM_ENTRY_REPORT = 'entry.913964143';  // the single paragraph field (shared collector form)
var FEEDBACK_EMAIL = 'studio.peach.go+open-book-reader@gmail.com';
// ────────────────────────────────────────────────────────────────────

// Diagnostics ride the URL #fragment — first-party, never sent to any server on load.
var meta = {};
try { meta = JSON.parse(decodeURIComponent((location.hash || '').slice(1)) || '{}'); } catch (e) { meta = {}; }

var descEl = document.getElementById('desc');
var emailEl = document.getElementById('email');
var send = document.getElementById('send');

// Show exactly what will be included (transparency).
document.getElementById('diag').textContent = JSON.stringify(meta, null, 2);

function refresh() { send.disabled = !descEl.value.trim(); }
descEl.addEventListener('input', refresh);

// Build the [feedback-meta v1] body — mirrors settings.js _buildReportMailto EXACTLY so
// email + form reports ingest identically. `withReporter` adds reporterEmail to the JSON
// (the form path — the bridge's envelope From is the operator, so the reply address must
// travel in the marker); the email path omits it and ingest falls back to the real sender.
function buildBody(withReporter) {
  var m = {};
  for (var k in meta) if (Object.prototype.hasOwnProperty.call(meta, k)) m[k] = meta[k];
  var email = emailEl.value.trim();
  if (withReporter) m.reporterEmail = email || null;
  var lines = [
    descEl.value.trim() || '[No description provided]', '', '---',
    'App: ' + (m.app || 'open-book-reader'),
    'Version: ' + (m.version || '(unknown)'),
    'Platform: ' + (m.platform || 'chrome'),
    'Page: ' + (m.pageUrl || '(unknown)'),
    'Mode: ' + (m.mode || '(unknown)'),
  ];
  if (typeof m.imageCount === 'number') lines.push('Images detected: ' + m.imageCount);
  if (typeof m.proseWords === 'number') lines.push('Prose words: ' + m.proseWords);
  lines.push('', '[feedback-meta v1]', JSON.stringify(m));
  return lines.join('\n');
}

function subjectHost() {
  try { return ' on ' + new URL(meta.pageUrl).hostname; } catch (e) { return ''; }
}
function mailtoHref() {
  // Honor a typed reply address on the email path too: if the user filled #email, carry it as
  // reporterEmail so a reply goes THERE (not to whatever account their mail client sends from,
  // which may be a shared/family address). Empty #email → omit it → ingest falls back to From.
  var withReporter = !!emailEl.value.trim();
  return 'mailto:' + FEEDBACK_EMAIL +
    '?subject=' + encodeURIComponent('Open Book Reader — problem' + subjectHost()) +
    '&body=' + encodeURIComponent(buildBody(withReporter));
}

function done() {
  document.getElementById('form-wrap').classList.add('hidden');
  document.getElementById('thanks').classList.remove('hidden');
}

document.getElementById('mailLink').addEventListener('click', function (e) {
  e.preventDefault();
  window.location.href = mailtoHref();
  done();
});

send.addEventListener('click', function () {
  if (!descEl.value.trim()) return;
  if (GFORM_ACTION && GFORM_ENTRY_REPORT) {
    var f = document.createElement('form');
    f.action = GFORM_ACTION; f.method = 'POST'; f.target = 'gform_sink';
    var i = document.createElement('input');
    i.type = 'hidden'; i.name = GFORM_ENTRY_REPORT; i.value = buildBody(true); // form path carries reporterEmail
    f.appendChild(i);
    document.body.appendChild(f);
    f.submit();
    done();
  } else {
    // No form configured yet → fall back to the mail client.
    window.location.href = mailtoHref();
    done();
  }
});
