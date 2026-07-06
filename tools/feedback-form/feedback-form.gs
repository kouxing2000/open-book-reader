/**
 * Open Book Reader - feedback-form backend (Google Apps Script).
 *
 * This is the TRACKED source of truth for the zero-backend feedback form. It is NOT part of
 * the extension (not shipped) - it runs in Google Apps Script under the feedback account and
 * bridges the one "feedback collector" Google Form into the Gmail feedback inbox declared in
 * .meta/feedback.json. See README.md here, and the `feedback-form` skill for the general pattern.
 *
 * Two functions:
 *   - migrate()          ONE-TIME setup: create the collector form, install the bridge, and
 *                        retire the old 2-field uninstall form (trash, recoverable 30 days).
 *   - onFeedbackSubmit() ONGOING: the installed trigger. Forwards each submission verbatim.
 *
 * ASCII-ONLY: every string here is ASCII (raw multi-byte chars mangle to "a??" on paste).
 * RULE #1: only the PUBLIC feedback alias + form IDs live here - never a secret or the
 * publishing/owning account.
 */
var CONFIG = {
  feedbackEmail: 'studio.peach.go+open-book-reader@gmail.com', // from .meta/feedback.json
  formTitle: 'Open Book Reader feedback',
  subject: 'Open Book Reader - feedback',
  oldFormId: '1jTfCH0rdznbkWiUQ8zOSLWEqIKQweus4g3wwkgxVV0Q',   // the 2-field uninstall form to retire
};

/** ONE-TIME. Creates the collector form, installs the bridge, retires the old form. */
function migrate() {
  // Idempotency guard: if a collector bridge is already installed, BAIL. Re-running would create
  // a NEW form (new entry IDs) and move the trigger to it, orphaning the live form that
  // report.html / uninstall.html hardcode — submissions would still return 200 and show
  // "Thank you" but never reach the inbox. To truly recreate, delete the onFeedbackSubmit
  // trigger by hand first. (Guard is per-project — it only sees this project's triggers.)
  var already = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'onFeedbackSubmit'; });
  if (already) {
    Logger.log('ABORT: an onFeedbackSubmit trigger already exists — migration already ran. Nothing changed.');
    return;
  }

  // 1. Create the ONE collector form (single field; the page posts a pre-built body into it).
  var form = FormApp.create(CONFIG.formTitle);
  form.setDescription('Submitted from the Open Book Reader extension. You do not need to fill this in directly.');
  var field = form.addParagraphTextItem().setTitle('report');
  try { form.setRequireLogin(false); } catch (e) { /* personal Gmail: already public */ }
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false);

  var ids = form.createResponse().withItemResponse(field.createResponse('x'))
    .toPrefilledUrl().match(/entry\.\d+/g) || [];

  // 2. Install the bridge trigger on the new form (idempotent).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onFeedbackSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFeedbackSubmit').forForm(form).onFormSubmit().create();

  // 3. Retire the OLD uninstall form: remove its old trigger, then trash the form (last, so a
  //    failure here can't undo the working new setup).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onUninstallSubmit') ScriptApp.deleteTrigger(t);
  });
  var trashed = false;
  try { DriveApp.getFileById(CONFIG.oldFormId).setTrashed(true); trashed = true; }
  catch (e) { Logger.log('Old form not trashed (already gone, or lives in another account): ' + e); }

  // 4. Report.
  Logger.log('---- paste into BOTH site/uninstall.html and src/report.html ----');
  Logger.log('GFORM_ACTION       = ' + form.getPublishedUrl().replace('/viewform', '/formResponse'));
  Logger.log('GFORM_ENTRY_REPORT = ' + (ids[0] || '??'));
  Logger.log('New collector form (edit): ' + form.getEditUrl());
  Logger.log('Old uninstall form trashed: ' + trashed + ' (recoverable from Drive Trash for 30 days)');
}

/**
 * ONGOING trigger. uninstall.html / report.html already built the full [feedback-meta v1] body
 * (with reportSource, and reporterEmail for repliable reports) and posted it as the single
 * field, so forward it verbatim - email + form reports become byte-identical to the
 * /feedback-ingest parser.
 */
function onFeedbackSubmit(e) {
  var body = '';
  e.response.getItemResponses().forEach(function (r) { body = r.getResponse(); });
  if (body) MailApp.sendEmail({
    to: CONFIG.feedbackEmail, subject: CONFIG.subject, body: body, name: 'Open Book Reader Feedback',
  });
}
