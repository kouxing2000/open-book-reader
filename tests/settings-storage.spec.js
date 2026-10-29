/* Stored maps and objects survive a failed storage read.
 *
 * settings.js runs in a VM realm with a synthetic chrome.storage, so a read can fail with a
 * callback-scoped runtime.lastError exactly as Chrome reports it. */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/content/settings.js', import.meta.url), 'utf8');

// The first read of the seeded key fails once; later reads and every write succeed.
function settingsRealm(seed) {
  const data = structuredClone(seed);
  const runtime = { lastError: null };
  let rejectRead = true;
  let writes = 0;
  const area = {
    get(keys, callback) {
      const snapshot = structuredClone(data);
      const failed = rejectRead && (Array.isArray(keys) ? keys : [keys]).includes(Object.keys(seed)[0]);
      queueMicrotask(() => {
        runtime.lastError = failed ? { message: 'Synthetic storage read failure' } : null;
        try { callback(failed ? undefined : snapshot); }
        finally { runtime.lastError = null; if (failed) rejectRead = false; }
      });
    },
    set(values, callback) {
      writes++;
      Object.assign(data, structuredClone(values));
      queueMicrotask(() => callback());
    },
  };
  const realm = vm.createContext({
    chrome: { runtime, storage: { sync: area, local: area } },
    URL, console, setTimeout, clearTimeout,
  });
  new vm.Script(source, { filename: 'settings.js' }).runInContext(realm);
  return { OBR: realm.OBR, data, get writes() { return writes; } };
}

const cases = [
  {
    name: 'saved picks (map replacement)',
    seed: { obr_picks: { 'kept.example': { sel: '#kept', t: 1 } } },
    mutate: (obr) => obr.savePick('added.example', '#new', 2),
    failure: false,
  },
  {
    name: 'reading positions (map merge update)',
    seed: { obr_positions: { 'https://kept.example/article': { f: 0.5, ms: 300, t: 1 } } },
    mutate: (obr) => obr.savePosition('https://added.example/article', 0.2, 2),
    failure: false,
  },
  {
    name: 'lifetime totals (object patch)',
    seed: { obr_lifetime: { articles: 9, ms: 500 } },
    mutate: (obr) => obr.bumpLifetime({ articles: 1 }),
    failure: null,
  },
];

for (const { name, seed, mutate, failure } of cases) {
  test(`${name}: a failed read keeps the stored records and the next save still works`, async () => {
    const realm = settingsRealm(seed);
    expect(await mutate(realm.OBR)).toBe(failure);
    expect(realm.writes).toBe(0);
    expect(realm.data).toEqual(seed);

    const success = await mutate(realm.OBR);
    expect(success).not.toBe(false);
    expect(success).not.toBeNull();
    expect(realm.writes).toBe(1);
    if (seed.obr_picks) expect(realm.data.obr_picks['kept.example']).toEqual(seed.obr_picks['kept.example']);
    if (seed.obr_positions) expect(realm.data.obr_positions['https://kept.example/article']).toEqual(seed.obr_positions['https://kept.example/article']);
    if (seed.obr_lifetime) expect(realm.data.obr_lifetime).toEqual({ articles: 10, ms: 500 });
  });
}
