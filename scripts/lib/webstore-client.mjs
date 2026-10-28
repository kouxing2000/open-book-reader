import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://chromewebstore.googleapis.com';
const MAX_STATUS_CHECKS = 30;

// Only the transport and poll wait are replaceable: the state transitions stay real in tests.
export async function deployPackage(config, { fetchImpl = fetch, wait = delay } = {}) {
  for (const key of ['publisherId', 'extensionId', 'accessToken', 'zipPath', 'version']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Missing ${key} for deployment`);
  }
  const name = `publishers/${encodeURIComponent(config.publisherId)}/items/${encodeURIComponent(config.extensionId)}`;
  const headers = { Authorization: `Bearer ${config.accessToken}` };

  async function request(operation, url, init = {}, timeout = 30000) {
    let response;
    let body;
    try {
      response = await fetchImpl(url, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      body = await response.json();
    } catch {
      // A write may have reached the store even when its response was lost. Never replay it.
      throw new Error(`${operation} response unavailable; check the Developer Dashboard before retrying`);
    }
    if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status}): ${body?.error?.message || 'API request refused'}`);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.name !== name || body.itemId !== config.extensionId) {
      throw new Error(`${operation} returned an invalid item response`);
    }
    return body;
  }

  const uploaded = await request('Upload', `${API}/upload/v2/${name}:upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await readFile(config.zipPath),
  });
  let uploadState = uploaded.uploadState;
  if ((uploadState === 'SUCCEEDED' || uploaded.crxVersion !== undefined) && uploaded.crxVersion !== config.version) {
    throw new Error('Upload returned a different extension version');
  }
  // fetchStatus describes older published/submitted revisions, not the just-uploaded draft.
  // Only lastAsyncUploadState answers whether this asynchronous upload finished processing.
  const deadline = Date.now() + 60000;
  for (let attempt = 0; uploadState === 'IN_PROGRESS' && attempt < MAX_STATUS_CHECKS; attempt++) {
    if (Date.now() >= deadline) break;
    await wait(1000);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const status = await request('Upload status', `${API}/v2/${name}:fetchStatus`, { method: 'GET' }, Math.min(30000, remaining));
    uploadState = status.lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') {
    throw new Error(uploadState === 'IN_PROGRESS' ? 'Upload is still in progress; completion was not confirmed' : `Upload did not succeed (${uploadState || 'missing state'})`);
  }
  if (!config.autoPublish) return { uploadState };

  const submitted = await request('Submission', `${API}/v2/${name}:publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  });
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(submitted.state)) {
    throw new Error(`Submission was not confirmed (${submitted.state || 'missing state'})`);
  }
  return { uploadState, submissionState: submitted.state };
}
