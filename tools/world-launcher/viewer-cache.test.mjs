// node --test tools/world-launcher/viewer-cache.test.mjs (#2308 follow-up; proxy and a fake world on a free block of ports)
// A viewer's arrival reads, /v1/config and the snapshot's parts /v1/world/part/<hash>, come from the launcher's
// micro-cache: a second viewer's do not reach the world. A part is kept for the world process's life, config for the
// C3 time; a restart (a new build) asks again; a caller's token keys its own entry; a private answer is never shared.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';
const P0 = await testPort(3);

const PORT = P0 + 2, RANGE = [P0, P0 + 1];
const dir = mkdtempSync(join(tmpdir(), 'launcher-viewer-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
const webDir = join(dir, 'web'); mkdirSync(webDir);
const hits = join(dir, 'hits.log');
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_HITS: hits } });
const L = await openLauncher({ port: PORT, range: RANGE, dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, log: () => {}, soulLimits: { c3CacheMs: 300 } });
after(async () => { await L.close(); });
const api = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reached = (p) => (existsSync(hits) ? readFileSync(hits, 'utf8') : '').split('\n').filter((l) => l === p).length;
const PART = '/v1/world/part/' + 'ab'.repeat(16), PRIVATE = '/v1/world/part/' + '0'.repeat(32);

test('a second viewer\'s part and config reads do not reach the world; a restart and the config time ask again', async () => {
  const made = await api('/__sim/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Viewer Town' }) });
  assert.equal(made.status, 201); const { slug } = await made.json(), w = `/w/${slug}`;
  const first = await Promise.all([api(w + PART), api(w + '/v1/config')]);
  assert.deepEqual(first.map((r) => r.status), [200, 200]);
  const { pid } = await first[0].json(); await first[1].arrayBuffer();
  for (let i = 0; i < 5; i++) {
    const [part, cfg] = await Promise.all([api(w + PART), api(w + '/v1/config')]);
    assert.equal(part.headers.get('x-sim-cache'), 'hit'); assert.equal((await part.json()).pid, pid);
    assert.equal(cfg.headers.get('x-sim-cache'), 'hit'); assert.equal((await cfg.json()).pid, pid);
  }
  assert.equal(reached(PART), 1, 'one part read reached the world for six viewers');
  assert.equal(reached('/v1/config'), 1, 'one config read reached the world for six viewers');
  // config is kept only the C3 time (300 ms here): a change to it is seen within that
  await sleep(400);
  assert.equal((await api(w + '/v1/config')).headers.get('x-sim-cache'), 'miss'); assert.equal(reached('/v1/config'), 2);
  // its URLs are made from the host the caller reached: another host is its own entry
  const other = await api(w + '/v1/config', { headers: { 'x-forwarded-host': 'other.example' } });
  assert.equal(other.headers.get('x-sim-cache'), 'miss'); assert.equal((await other.json()).host, 'other.example');
  // a part outlives the C3 time, but not the world process: a restart (a new build) asks again
  assert.equal((await api(w + PART)).headers.get('x-sim-cache'), 'hit');
  await api(w + '/crash');
  for (let i = 0; i < 100; i++) { const h = await api(w + '/healthz').then((r) => r.json()).catch(() => null); if (h?.pid && h.pid !== pid) break; await sleep(100); }
  const fresh = await api(w + PART);
  assert.equal(fresh.headers.get('x-sim-cache'), 'miss'); assert.notEqual((await fresh.json()).pid, pid, 'the restarted world answered');
  assert.equal(reached(PART), 2);
});

test('a caller\'s token keys its own entry, and a private answer is never kept', async () => {
  const w = '/w/viewer-town', P = '/v1/world/part/' + 'cd'.repeat(16);
  const anon = await (await api(w + P)).json();
  const alice = await api(w + P, { headers: { authorization: 'Bearer sim_alice' } });
  assert.equal(alice.headers.get('x-sim-cache'), 'miss', 'a token is not served the anonymous entry'); assert.equal((await alice.json()).who, 'Bearer sim_alice');
  const bob = await api(w + P, { headers: { authorization: 'Bearer sim_bob' } });
  assert.equal(bob.headers.get('x-sim-cache'), 'miss', 'nor another token\'s'); assert.equal((await bob.json()).who, 'Bearer sim_bob');
  assert.equal((await api(w + P, { headers: { authorization: 'Bearer sim_alice' } })).headers.get('x-sim-cache'), 'hit');
  assert.equal(anon.who, null);
  for (let i = 0; i < 3; i++) assert.equal((await api(w + PRIVATE)).headers.get('x-sim-cache'), 'miss');
  assert.equal(reached(PRIVATE), 3, 'an answer marked private or no-store reaches the world every time');
});
