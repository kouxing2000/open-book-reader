/* The uninstall survey (site/uninstall.html) — the one page where an address the extension
 * stamped (background.js: uninstallSurveyUrl) can leave the device. What is under test is
 * exactly what the form POSTs: the page must send the stamped site only for a site-specific
 * reason, only with "Report the problem site" checked, and never on its own. */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect } from './fixtures.js';

const SURVEY = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'uninstall.html')).href;
const STAMPED = 'https://news.test/story/7';
const WRONG_TEXT = 'Picked the wrong text / looked broken';

// Open the survey, capture the Google Form POST instead of sending it, and return a submit
// helper that yields the posted [feedback-meta v1] body.
async function openSurvey(page, hash) {
  const posted = [];
  await page.route('https://docs.google.com/**', async (route) => {
    posted.push(new URLSearchParams(route.request().postData() || '').get('entry.913964143'));
    await route.fulfill({ status: 200, body: 'ok' });
  });
  await page.goto(SURVEY + (hash || ''));
  return {
    async submit(reason) {
      await page.locator(`input[name="reason"][value="${reason}"]`).check();
      await page.locator('#send').click();
      await expect.poll(() => posted.length).toBe(1);
      const body = posted[0];
      // A form POST normalizes every line break in a value to CRLF.
      return { body, meta: JSON.parse(body.split(/\[feedback-meta v1\]\r?\n/)[1]) };
    },
  };
}

test('a stamped page is shown checked and sent as pageUrl for a site reason', async ({ page }) => {
  const s = await openSurvey(page, '#url=' + encodeURIComponent(STAMPED));
  // Read once, then dropped from the address bar so a copied tab URL doesn't carry it.
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('#siteBox')).toBeHidden(); // no reason picked yet
  await page.locator(`input[name="reason"][value="${WRONG_TEXT}"]`).check();
  await expect(page.locator('#site')).toHaveValue(STAMPED);
  await expect(page.locator('#siteOn')).toBeChecked();
  const { body, meta } = await s.submit(WRONG_TEXT);
  expect(meta.pageUrl).toBe(STAMPED);
  expect(body).toContain('Page: ' + STAMPED);
});

test('unchecking "Report the problem site" sends no address', async ({ page }) => {
  const s = await openSurvey(page, '#url=' + encodeURIComponent(STAMPED));
  await page.locator(`input[name="reason"][value="${WRONG_TEXT}"]`).check();
  await page.locator('#siteOn').uncheck();
  await expect(page.locator('#site')).toBeDisabled();
  const { body, meta } = await s.submit(WRONG_TEXT);
  expect(meta).not.toHaveProperty('pageUrl');
  expect(body).not.toContain('news.test');
});

test('a reason that is not about a site never carries the stamped page', async ({ page }) => {
  const s = await openSurvey(page, '#url=' + encodeURIComponent(STAMPED));
  await page.locator('input[name="reason"][value="Just trying it out"]').check();
  await expect(page.locator('#siteBox')).toBeHidden();
  const { body, meta } = await s.submit('Just trying it out');
  expect(meta).not.toHaveProperty('pageUrl');
  expect(body).not.toContain('news.test');
});

test('without a stamp the field is a plain optional input, and a non-web stamp is ignored', async ({ page }) => {
  const s = await openSurvey(page, '#url=' + encodeURIComponent('javascript:alert(1)'));
  await page.locator(`input[name="reason"][value="Didn't work on the sites I read"]`).check();
  await expect(page.locator('#site')).toHaveValue('');
  await expect(page.locator('#siteShare')).toBeHidden(); // the checkbox exists only for a stamp
  await page.locator('#site').fill('example.com/some-article'); // no scheme — must not block Send
  const { meta } = await s.submit("Didn't work on the sites I read");
  expect(meta.pageUrl).toBe('example.com/some-article');
});
