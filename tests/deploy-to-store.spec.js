import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deployPackage } from '../scripts/lib/webstore-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ITEM = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PUBLISHER = 'publisher-fixture';
const NAME = `publishers/${PUBLISHER}/items/${ITEM}`;
const VERSION = '1.2.3';
const upload = (state = 'SUCCEEDED', extra = {}) => ({ name: NAME, itemId: ITEM, uploadState: state, crxVersion: VERSION, ...extra });
const publish = (state = 'PENDING_REVIEW', extra = {}) => ({ name: NAME, itemId: ITEM, state, ...extra });
let workDir;
let config;

test.beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obr-webstore-contract-'));
  const zipPath = path.join(workDir, 'dist.zip');
  await fs.writeFile(zipPath, Buffer.from('PK\x03\x04controlled package bytes'));
  config = { publisherId: PUBLISHER, extensionId: ITEM, accessToken: 'access-fixture', zipPath, version: VERSION, autoPublish: true };
});
test.afterAll(async () => { await fs.rm(workDir, { recursive: true, force: true }); });

function network(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (!replies.length) throw new Error('Unexpected request');
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status: reply.status || 200 });
  };
  return { calls, fetchImpl, wait: async () => {} };
}

test('V2 uploads the actual package before confirming a pending-review submission', async () => {
  const io = network([{ body: upload() }, { body: publish() }]);
  expect(await deployPackage(config, io)).toMatchObject({ uploadState: 'SUCCEEDED', submissionState: 'PENDING_REVIEW' });
  expect(io.calls.map((c) => [c.url, c.method])).toEqual([
    [`https://chromewebstore.googleapis.com/upload/v2/${NAME}:upload`, 'POST'],
    [`https://chromewebstore.googleapis.com/v2/${NAME}:publish`, 'POST'],
  ]);
  expect(Buffer.from(io.calls[0].body)).toEqual(await fs.readFile(config.zipPath));
  expect(io.calls[0].headers['Content-Type']).toBe('application/zip');
  for (const call of io.calls) {
    expect(call.headers.Authorization).toBe('Bearer access-fixture');
    expect(call.redirect).toBe('error');
    expect(call.signal).toBeInstanceOf(AbortSignal);
  }
  expect(JSON.parse(io.calls[1].body)).toEqual({ publishType: 'DEFAULT_PUBLISH' });
});

test('an asynchronous upload waits for its own completion, independent of older published versions', async () => {
  const io = network([
    { body: upload('IN_PROGRESS', { crxVersion: undefined }) },
    { body: { name: NAME, itemId: ITEM, lastAsyncUploadState: 'IN_PROGRESS', publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.1.0' }] } } },
    { body: { name: NAME, itemId: ITEM, lastAsyncUploadState: 'SUCCEEDED', publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.1.0' }] } } },
    { body: publish() },
  ]);
  expect((await deployPackage(config, io)).submissionState).toBe('PENDING_REVIEW');
  expect(io.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET', 'POST']);
  expect(io.calls[1].url).toBe(`https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`);
});

test('upload-only mode confirms the upload and never submits', async () => {
  const io = network([{ body: upload() }]);
  expect(await deployPackage({ ...config, autoPublish: false }, io)).toMatchObject({ uploadState: 'SUCCEEDED' });
  expect(io.calls).toHaveLength(1);
});

for (const state of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', 'unexpected']) {
  test(`upload state ${state} fails before submission`, async () => {
    const io = network([{ body: upload(state) }]);
    await expect(deployPackage(config, io)).rejects.toThrow(/upload/i);
    expect(io.calls).toHaveLength(1);
  });
}

for (const state of ['REJECTED', 'CANCELLED', 'ITEM_STATE_UNSPECIFIED', 'STAGED', 'PUBLISHED_TO_TESTERS', 'unexpected']) {
  test(`submission state ${state} cannot report deployment success`, async () => {
    const io = network([{ body: upload() }, { body: publish(state) }]);
    await expect(deployPackage(config, io)).rejects.toThrow(/submi|publish/i);
    expect(io.calls).toHaveLength(2);
  });
}

test('publicly published is a confirmed deployment outcome', async () => {
  const io = network([{ body: upload() }, { body: publish('PUBLISHED') }]);
  expect((await deployPackage(config, io)).submissionState).toBe('PUBLISHED');
});

test('an unfinished asynchronous upload is bounded and never submitted', async () => {
  const status = { name: NAME, itemId: ITEM, lastAsyncUploadState: 'IN_PROGRESS' };
  const io = network([{ body: upload('IN_PROGRESS', { crxVersion: undefined }) }, ...Array.from({ length: 40 }, () => ({ body: status }))]);
  await expect(deployPackage(config, io)).rejects.toThrow(/upload.*(pending|progress|tim|complete)/i);
  expect(io.calls.length).toBeLessThanOrEqual(31);
  expect(io.calls.filter((c) => c.url.endsWith(':publish'))).toHaveLength(0);
});

for (const [stage, changed] of [['upload', { name: 'publishers/other/items/other' }], ['status', { itemId: 'other' }], ['publish', { name: 'publishers/other/items/other' }]]) {
  test(`a mismatched ${stage} resource fails closed`, async () => {
    const replies = stage === 'upload' ? [{ body: upload('SUCCEEDED', changed) }, { body: publish() }]
      : stage === 'status' ? [{ body: upload('IN_PROGRESS', { crxVersion: undefined }) }, { body: { name: NAME, itemId: ITEM, lastAsyncUploadState: 'SUCCEEDED', ...changed } }, { body: publish() }]
        : [{ body: upload() }, { body: publish('PENDING_REVIEW', changed) }];
    const io = network(replies);
    await expect(deployPackage(config, io)).rejects.toThrow(/(item|resource|response)/i);
    expect(io.calls).toHaveLength(stage === 'upload' ? 1 : 2);
  });
}

test('a synchronous upload of a different version cannot be submitted', async () => {
  const io = network([{ body: upload('SUCCEEDED', { crxVersion: '0.0.1' }) }]);
  await expect(deployPackage(config, io)).rejects.toThrow(/version/i);
  expect(io.calls).toHaveLength(1);
});

for (const reply of [{ body: {} }, { body: 'not JSON' }, { body: { error: { message: 'permission refused' } }, status: 403 }]) {
  test(`an invalid API response ${JSON.stringify(reply)} fails closed`, async () => {
    const io = network([reply]);
    await expect(deployPackage(config, io)).rejects.toThrow();
    expect(io.calls).toHaveLength(1);
  });
}

test('a failed write request is never retried automatically', async () => {
  const io = network([new Error('connection interrupted'), { body: upload() }]);
  await expect(deployPackage(config, io)).rejects.toThrow();
  expect(io.calls).toHaveLength(1);
});

async function runCli(replies, { check = false, publisher = PUBLISHER, autoPublish = 'true' } = {}) {
  const dir = await fs.mkdtemp(path.join(workDir, 'cli-'));
  await fs.mkdir(path.join(dir, 'scripts/lib'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'scripts/deploy-to-store.js'), path.join(dir, 'scripts/deploy-to-store.js'));
  await fs.copyFile(path.join(ROOT, 'scripts/lib/webstore-client.mjs'), path.join(dir, 'scripts/lib/webstore-client.mjs'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: VERSION }));
  if (!check) await fs.copyFile(config.zipPath, path.join(dir, 'dist.zip'));
  const driver = `
    import fs from 'node:fs';
    const replies = JSON.parse(process.env.TEST_REPLIES);
    const calls=[];
    globalThis.fetch = async (url, init={}) => {
      calls.push({url,method:init.method || 'GET'});
      fs.writeFileSync(process.env.TEST_CALLS,JSON.stringify(calls));
      const allowed=url==='https://oauth2.googleapis.com/token'||url.startsWith('https://chromewebstore.googleapis.com/');
      if(!allowed || !replies.length) throw new Error('Unexpected network request');
      const reply=replies.shift();
      return new Response(typeof reply.body==='string'?reply.body:JSON.stringify(reply.body),{status:reply.status||200});
    };
  `;
  await fs.writeFile(path.join(dir, 'network.mjs'), driver);
  const result = spawnSync(process.execPath, ['--import', path.join(dir, 'network.mjs'), path.join(dir, 'scripts/deploy-to-store.js'), ...(check ? ['--check'] : [])], {
    encoding: 'utf8', timeout: 10000, cwd: dir,
    env: { ...process.env, CHROME_EXTENSION_ID: ITEM, CHROME_PUBLISHER_ID: publisher, CHROME_CLIENT_ID: 'client-fixture', CHROME_CLIENT_SECRET: 'secret-fixture', CHROME_REFRESH_TOKEN: 'refresh-fixture', AUTO_GET_TOKEN: 'false', AUTO_PUBLISH: autoPublish, TEST_REPLIES: JSON.stringify(replies), TEST_CALLS: path.join(dir, 'calls.json') },
  });
  const calls = JSON.parse(await fs.readFile(path.join(dir, 'calls.json'), 'utf8').catch(() => '[]'));
  return { ...result, calls, output: result.stdout + result.stderr };
}
const token = { body: { access_token: 'access-fixture', scope: 'https://www.googleapis.com/auth/chromewebstore' } };

test('the actual CLI exits zero for pending review and labels it as submitted', async () => {
  const result = await runCli([token, { body: upload() }, { body: publish() }]);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('submitted for review');
  expect(result.output).not.toContain('published successfully');
  expect(result.calls).toHaveLength(3);
  for (const secret of [PUBLISHER, 'secret-fixture', 'refresh-fixture', 'access-fixture']) expect(result.output).not.toContain(secret);
});

test('the actual CLI fails on rejected submission and redacts private response values', async () => {
  const result = await runCli([token, { body: upload() }, { status: 403, body: { error: { message: `Refused ${NAME}: secret-fixture refresh-fixture access-fixture client-fixture` } } }]);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('HTTP 403');
  for (const secret of [PUBLISHER, 'secret-fixture', 'refresh-fixture', 'access-fixture', 'client-fixture']) expect(result.output).not.toContain(secret);
});

test('the actual CLI fails on malformed submission without creating a success message', async () => {
  const result = await runCli([token, { body: upload() }, { body: {} }]);
  expect(result.status, result.output).toBe(1);
  expect(result.output).not.toContain('Deployment complete');
});

test('preflight requires the private publisher configuration before any network call', async () => {
  const result = await runCli([], { check: true, publisher: '' });
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('CHROME_PUBLISHER_ID');
  expect(result.calls).toHaveLength(0);
});

test('preflight exchanges only a token, without needing a package or making item writes', async () => {
  const result = await runCli([token], { check: true });
  expect(result.status, result.output).toBe(0);
  expect(result.calls).toEqual([{ url: 'https://oauth2.googleapis.com/token', method: 'POST' }]);
});
