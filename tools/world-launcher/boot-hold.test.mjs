// node --test tools/world-launcher/boot-hold.test.mjs (#2231; fake worlds that take 2.5 s to listen, and a launcher)
// A Soul API call to a booting world waits at the launcher for it, up to the call's own deadline, and is then answered
// by the world; past its deadline it is refused world.starting naming the boot; at most bootHoldMax wait per world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPort } from '../../apps/server/test/test-port.ts';
import { openLauncher } from './launcher.mjs';
const P0 = await testPort(12);

const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, what) => { const t0 = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t0 > ms) throw new Error(`not within ${ms} ms: ${what}`); await sleep(10); } };

/** A launcher on its own ports with one fake world `slug` made, then stopped (its process gone, as an idle world's is). */
async function launcherWithStoppedWorld(n, slug, o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-hold-'));
  const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
  const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
  const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), DATA_DIR: w.dataDir, FAKE_BOOT_MS: '2500', FAKE_ACT: '1' } });
  const P = P0 + n * 4, base = `http://127.0.0.1:${P}`;
  const L = await openLauncher({ port: P, range: [P + 1, P + 3], dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, log: () => {}, prewarm: false, publicOrigin: 'http://sim.test', devAuth: true, ...o });
  const made = await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: slug }) });
  assert.equal(made.status, 201);
  await L.pool.stop(slug);
  assert.equal(L.pool.status(slug).status, 'stopped');
  const call = (i, path, { method = 'GET', signal } = {}) => { const t0 = performance.now(); return fetch(`${base}/w/${slug}${path}`, { method, signal, headers: { authorization: `Bearer sim_s_soul${i}_secret`, 'x-forwarded-for': `198.51.100.${i}` }, ...(method === 'POST' ? { body: '{}' } : {}) }).then(async (r) => ({ status: r.status, ms: performance.now() - t0, retry: r.headers.get('retry-after'), body: await r.json().catch(() => null) })); };
  // the act that wakes it (it boots the world and waits on ensure() as before); the calls under test go while it boots
  const booting = async () => { const first = call(0, '/v1/edge/act', { method: 'POST' }); await until(() => L.pool.status(slug).status === 'starting', 2000, 'booting'); return { first, began: Date.now() }; };
  return { L, call, booting };
}

test('A1/A2: an act and a wait sent while the world cold-boots are held and answered by the world, never world.starting', async () => {
  const { L, call, booting } = await launcherWithStoppedWorld(0, 'boots');
  try {
    const { first, began } = await booting();
    const sent = Date.now();
    const [act, wait] = await Promise.all([call(1, '/v1/edge/act', { method: 'POST' }), call(2, '/v1/edge/wait?timeout=6')]);
    const st = L.pool.status('boots');
    assert.equal(act.status, 200, JSON.stringify(act.body)); assert.equal(act.body.acted, true, 'answered by the world');
    assert.equal(wait.status, 200, JSON.stringify(wait.body)); assert.deepEqual(wait.body, { events: [], cursor: 'c_1' });
    assert.ok(wait.ms < 6500, `the wait went on with what was left of its own 6 s (${wait.ms.toFixed(0)} ms)`);
    assert.equal((await first).status, 200, 'the act that woke it is answered too');
    assert.ok(act.ms >= 1000, `the act was held for the boot (${act.ms.toFixed(0)} ms)`);
    assert.equal(st.status, 'running');
    console.log(`# A2: an act sent ${sent - began} ms into the boot was answered ${act.status} in ${act.ms.toFixed(0)} ms; the boot took ${st.lastBootMs} ms; wait answered ${wait.status} in ${wait.ms.toFixed(0)} ms`);
  } finally { await L.close(); }
});

test('A1: a call whose own deadline passes before the world listens is refused world.starting, naming the boot', async () => {
  const { L, call, booting } = await launcherWithStoppedWorld(1, 'late', { bootHoldMs: 600 });
  try {
    const { first } = await booting();
    const [act, wait] = await Promise.all([call(1, '/v1/edge/act', { method: 'POST' }), call(2, '/v1/edge/wait?timeout=1')]);
    for (const [r, ms] of [[act, 600], [wait, 1000]]) {
      assert.equal(r.status, 503); assert.equal(r.body.code, 'world.waking'); assert.equal(r.retry, '5'); assert.equal(r.body.limit.scope, 'boot');
      assert.match(r.body.message, /still loading \(for \d+ s\); this call waited \d+ s for it, its own limit/);
      assert.ok(r.ms >= ms - 50 && r.ms < ms + 1000, `refused at its deadline (${r.ms.toFixed(0)} ms, deadline ${ms} ms)`);
    }
    assert.equal(L.pool.status('late').status, 'starting', 'refused while it still boots; the boot goes on');
    assert.equal((await first).body.code, 'world.waking', '#2304: the call that started the load is held to the same limit');
    console.log(`# A1: past their deadlines: act refused at ${act.ms.toFixed(0)} ms, wait at ${wait.ms.toFixed(0)} ms: "${act.body.message}"`);
  } finally { await L.close(); }
});

test('A3: at most bootHoldMax calls wait per world; the next is refused world.busy at once; a caller that leaves frees its place', async () => {
  const { L, call, booting } = await launcherWithStoppedWorld(2, 'full', { bootHoldMax: 3 });
  try {
    const { first } = await booting();
    const gone = new AbortController();
    const leaver = call(9, '/v1/edge/act', { method: 'POST', signal: gone.signal }).catch((e) => e.name);
    const held = [1, 2].map((i) => call(i, '/v1/edge/act', { method: 'POST' }));
    await sleep(200);
    const over = await call(3, '/v1/edge/act', { method: 'POST' });
    assert.equal(over.status, 503); assert.equal(over.body.code, 'world.busy'); assert.equal(over.body.limit.scope, 'boot'); assert.equal(over.retry, '5');
    assert.match(over.body.message, /3 calls are already waiting/);
    assert.ok(over.ms < 200, `refused at once (${over.ms.toFixed(0)} ms)`);
    gone.abort(); assert.equal(await leaver, 'AbortError'); await sleep(100);
    const again = call(4, '/v1/edge/act', { method: 'POST' });
    const rs = await Promise.all([...held, again, first]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200], 'the held calls, and the one that took the leaver\'s place, are answered');
    console.log(`# A3: cap 3: the 4th refused world.busy in ${over.ms.toFixed(0)} ms; after one caller left, a new call was held and answered`);
  } finally { await L.close(); }
});
