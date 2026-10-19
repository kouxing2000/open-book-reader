/* The uninstall survey (site/uninstall.html) — the one page where an address the extension
 * stamped (background.js: uninstallSurveyUrl) can leave the device. What is under test is
 * exactly what the form POSTs: the page must send the stamped site only for a site-specific
 * reason, only with "Report the problem site" checked, and never on its own. */

import fs from 'node:fs';
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

// The welcome page's "Try it on a sample article" button. A user who only ever tried the
// reader there gets it stamped, and sending it back as "the problem site" names no site they
// read. Read from the extension's own page, never typed here: the survey keeps its own copy,
// and this is what fails when the two drift.
const WELCOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'welcome.html');
function welcomeSample() {
  const html = fs.readFileSync(WELCOME, 'utf8');
  const tag = html.match(/<a\b[^>]*data-i18n="welcomeCta"[^>]*>/);
  const href = tag && tag[0].match(/\bhref="([^"]+)"/);
  if (!href || !/^https:\/\/[^/]+\//.test(href[1])) throw new Error('welcome.html: no https sample-article href on the welcomeCta link');
  return href[1];
}
const SAMPLE = welcomeSample();
const NOT_ON_MY_SITES = "Didn't work on the sites I read";
const SAMPLE_NOTE = "You've only opened the sample article in Open Book Reader so far. If another site didn't work, type it here.";

// Variants a stamp can differ by and still be the sample.
function sampleVariants() {
  const u = new URL(SAMPLE);
  const mobile = new URL(SAMPLE);
  mobile.hostname = u.hostname.replace(/^([^.]+)\./, '$1.m.');
  return {
    exact: SAMPLE,
    http: SAMPLE.replace(/^https:/, 'http:'),
    'trailing slash': SAMPLE + '/',
    fragment: SAMPLE + '#History',
    mobile: mobile.href,
  };
}

for (const [variant, stamp] of Object.entries(sampleVariants())) {
  test(`a stamp of the welcome sample (${variant}) leaves the box empty and sends sampleOnly`, async ({ page }) => {
    const s = await openSurvey(page, '#url=' + encodeURIComponent(stamp));
    expect(new URL(page.url()).hash).toBe('');
    await page.locator(`input[name="reason"][value="${NOT_ON_MY_SITES}"]`).check();
    await expect(page.locator('#site')).toHaveValue('');
    await expect(page.locator('#site')).toHaveAttribute('placeholder', 'example.com/the-article');
    await expect(page.locator('#siteShare')).toBeHidden();
    await expect(page.locator('#siteNote')).toBeHidden();
    await expect(page.locator('#sampleNote')).toBeVisible();
    await expect(page.locator('#sampleNote')).toHaveText(SAMPLE_NOTE);
    const { body, meta } = await s.submit(NOT_ON_MY_SITES);
    expect(meta.sampleOnly).toBe(true);
    expect(meta).not.toHaveProperty('pageUrl');
    expect(body).not.toContain(new URL(SAMPLE).pathname);
  });
}

test('a site typed over a sample stamp is sent, still marked sampleOnly', async ({ page }) => {
  const s = await openSurvey(page, '#url=' + encodeURIComponent(SAMPLE));
  await page.locator(`input[name="reason"][value="${WRONG_TEXT}"]`).check();
  await page.locator('#site').fill('blog.test/post');
  const { body, meta } = await s.submit(WRONG_TEXT);
  expect(meta.pageUrl).toBe('blog.test/post');
  expect(meta.sampleOnly).toBe(true);
  expect(body).toContain('Page: blog.test/post');
});

test('a sample stamp says nothing for a reason that is not about a site', async ({ page }) => {
  const s = await openSurvey(page, '#url=' + encodeURIComponent(SAMPLE));
  const { meta } = await s.submit('Just trying it out');
  expect(meta).not.toHaveProperty('sampleOnly');
  expect(meta).not.toHaveProperty('pageUrl');
});

// Only the sample itself: another article on the same wiki (even one whose path merely starts
// with the sample's), or the same title on another language's wiki, is a real report and keeps
// the stamped behaviour.
for (const stamp of [STAMPED, new URL(new URL(SAMPLE).pathname + '_(disambiguation)', SAMPLE).href, SAMPLE.replace(/^https:\/\/[^.]+\./, 'https://de.')]) {
  test(`a real-site stamp is prefilled as before, with no sampleOnly: ${stamp}`, async ({ page }) => {
    const s = await openSurvey(page, '#url=' + encodeURIComponent(stamp));
    await page.locator(`input[name="reason"][value="${NOT_ON_MY_SITES}"]`).check();
    await expect(page.locator('#site')).toHaveValue(stamp);
    await expect(page.locator('#siteOn')).toBeChecked();
    await expect(page.locator('#siteNote')).toBeVisible();
    await expect(page.locator('#sampleNote')).toBeHidden();
    const { meta } = await s.submit(NOT_ON_MY_SITES);
    expect(meta.pageUrl).toBe(stamp);
    expect(meta).not.toHaveProperty('sampleOnly');
  });
}
