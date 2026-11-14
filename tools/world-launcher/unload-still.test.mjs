// #2299 A7: a still world leaves memory and returns on a request or its alarm. Fake world processes (fake-world.mjs)
// that answer the still contract of #2241 (GET /__sim/still) from a file each test writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceClock, openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const BASE = await testPort(8);
const dir = mkdtempSync(join(tmpdir(), 'unload-still-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
writeFileSync(join(templatesDir, 'hello-hamlet.json'), JSON.stringify({ schema: 'genesis/1', name: 'Hello hamlet', description: 'a hamlet', batches: [] }));
const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Sim</title>');
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const stillFile = (slug) => join(dir, `still-${slug}.json`);
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1', FAKE_STILL_FILE: stillFile(w.slug) } });
const still = (slug, o = {}) => writeFileSync(stillFile(slug), JSON.stringify({ still: true, tick: 1, wallMs: Date.now(), untilTick: null, untilWallMs: null, moveTick: null, moveWallMs: null, ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const P = BASE, base = `http://127.0.0.1:${P}`, NEVER = 1_000_000;
const open = (o) => openLauncher({ port: P, range: [BASE + 1, BASE + 7], webDir, templatesDir, command, eager: 0, keepAlive: true, keepAliveMs: 100, log: () => {},
  unloadStill: true, stillServedMs: 0, stillHorizonMs: 0, stillQuietMs: 0, stillEveryMs: NEVER, stillAlarmMs: NEVER, ...o });
const status = (L, slug) => L.pool.status(slug).status;
const until = async (ok, what) => { for (let i = 0; i < 100; i++) { if (await ok()) return; await wait(50); } assert.fail(what); };
const create = async (name) => assert.equal((await fetch(`${base}/__sim/worlds`, { method: 'POST', body: JSON.stringify({ name }) })).status, 201);
const SOUL = { authorization: 'Bearer soul_test' };
const act = (slug) => fetch(`${base}/w/${slug}/v1/edge/act`, { method: 'POST', headers: { ...SOUL, 'content-type': 'application/json' }, body: '{}' });

test('unloaded on the rule; never with a connection open or an act in the quiet time; loaded by an act; no keep-alive boot', { timeout: 60_000 }, async () => {
  const L = await open({ dataDir: join(dir, 'rule'), stillQuietMs: 1500, stillHorizonMs: 600_000 });
  try {
    await create('One'); await create('Two');
    await until(() => status(L, 'one') === 'running' && status(L, 'two') === 'running', 'both run');
    still('one', { untilWallMs: Date.now() + 20 * 60_000 }); still('two', { untilWallMs: Date.now() + 5 * 60_000 });
    assert.deepEqual(await L.still.sweep(), ['one'], 'one: still, its horizon 20 min away; two: its horizon 5 min away');
    assert.equal(status(L, 'one'), 'stopped');
    assert.equal(L.still.horizons.get('one').still, true);
    assert.ok(L.still.horizons.get('one').untilWallMs > Date.now() + 19 * 60_000, 'the horizon is recorded');
    await wait(500);   // five keep-alive rounds (A5)
    assert.equal(status(L, 'one'), 'stopped', 'the keep-alive does not boot a world unloaded as still');
    // a visitor's connection open: never unloaded
    still('two', { untilWallMs: null });
    const sock = connect(P, '127.0.0.1'); sock.write('GET /w/two/ws HTTP/1.1\r\nHost: x\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
    await new Promise((r) => sock.once('data', r));
    assert.deepEqual(await L.still.sweep(), [], 'a connection is open');
    sock.destroy(); await wait(100);
    // an act within the quiet time: never unloaded
    assert.equal((await act('two')).status, 200);
    assert.deepEqual(await L.still.sweep(), [], 'an act 0 s ago');
    await wait(1600);
    assert.deepEqual(await L.still.sweep(), ['two'], 'quiet for the quiet time: unloaded');
    // an act loads an unloaded world, waits for it and runs
    const r = await act('one');
    assert.equal(r.status, 200); assert.equal((await r.json()).acted, true);
    assert.equal(status(L, 'one'), 'running');
    assert.equal(L.still.horizons.has('one'), false, 'a loaded world has no recorded horizon');
  } finally { await L.close(); }
});

test('resident reads to an unloaded world never answer 503: the kept picture with its clock moved on, "nothing new" at the deadline', { timeout: 60_000 }, async () => {
  const L = await open({ dataDir: join(dir, 'reads') });
  try {
    await create('One'); await until(() => status(L, 'one') === 'running', 'it runs');
    still('one');
    const live = () => fetch(`${base}/w/one/v1/edge/live`, { headers: SOUL });
    const kept = await (await live()).json();
    const inFlight = fetch(`${base}/w/one/v1/edge/wait?after=c_7&timeout=20`, { headers: SOUL });
    await wait(300);
    assert.deepEqual(await L.still.sweep(), ['one']);
    const a = await inFlight;
    assert.equal(a.status, 200, 'the wait in flight as its world unloaded');
    assert.equal(a.headers.get('x-sim-cache'), 'unloaded');
    assert.deepEqual(await a.json(), { events: [], cursor: 'c_7' });
    await wait(400);
    const t0 = Date.now(), b = await fetch(`${base}/w/one/v1/edge/wait?after=c_7&timeout=1`, { headers: SOUL });
    assert.equal(b.status, 200, 'the same ask again: held here, then nothing new');
    assert.ok(Date.now() - t0 >= 4500, 'held to its deadline (at least 5 s)');
    assert.deepEqual(await b.json(), { events: [], cursor: 'c_7' });
    const c = await live();
    assert.equal(c.status, 200); assert.equal(c.headers.get('x-sim-cache'), 'unloaded');
    const pic = await c.json();
    assert.ok(pic.clock.at > kept.clock.at && pic.clock.worldDateTime > kept.clock.worldDateTime, 'the clock moved on by wall time');
    assert.equal(status(L, 'one'), 'stopped', 'none of it loaded the world');
    // another cursor: the launcher cannot answer it truly, so it loads the world
    const d = await fetch(`${base}/w/one/v1/edge/wait?after=c_3&timeout=1`, { headers: SOUL });
    assert.equal(d.status, 200); assert.equal((await d.json()).cursor, 'c_1', 'answered by the world');
    assert.equal(status(L, 'one'), 'running');
  } finally { await L.close(); }
  const now = Date.parse('2026-11-14T00:00:00Z');
  const p = advanceClock({ at: now, clock: { worldDateTime: '2026-10-03T06:00:00.000Z', time: '06:00', minuteOfDay: 360, weekdayUTC: 6, paused: false, realMsPerWorldMinute: 2500, at: now } }, now + 25_000);
  assert.deepEqual([p.clock.worldDateTime, p.clock.time, p.clock.minuteOfDay, p.at], ['2026-10-03T06:10:00.000Z', '06:10', 370, now + 25_000]);
});

test('alarms: at moveWallMs always, at untilWallMs only with a listener; unloaded again after it served; kept across a restart', { timeout: 60_000 }, async () => {
  const dataDir = join(dir, 'alarms');
  let L = await open({ dataDir, stillServedMs: 1000 });
  try {
    await create('One'); await until(() => status(L, 'one') === 'running', 'it runs');
    await wait(1000);
    still('one', { untilWallMs: Date.now() + 500, moveWallMs: Date.now() + 1500 });
    assert.deepEqual(await L.still.sweep(), ['one']);
    assert.deepEqual(L.still.alarms(), [], 'nothing due');
    await wait(600);
    assert.deepEqual(L.still.alarms(), [], 'its next event is due, but nobody listens');
    await wait(1000);
    assert.deepEqual(L.still.alarms(), ['one'], 'a body is due to move: loaded with no listener');
    await until(() => status(L, 'one') === 'running', 'loaded by its alarm');
    // A6: unloaded again once the rule holds, and not sooner than it served (stillServedMs)
    still('one', { untilWallMs: Date.now() + 1500 });
    assert.deepEqual(await L.still.sweep(), [], 'it just served');
    await fetch(`${base}/w/one/v1/edge/live`, { headers: SOUL });   // a resident's poll (its picture kept)
    await wait(1000);
    assert.deepEqual(await L.still.sweep(), ['one']);
    assert.deepEqual(L.still.alarms(), [], 'its next event is not yet due');
    await wait(600);
    assert.deepEqual(L.still.alarms(), ['one'], 'its next event is due and a resident read it within stillListenerMs: loaded');
    await until(() => status(L, 'one') === 'running', 'loaded for its listener');
  } finally { await L.close(); }
  L = await open({ dataDir, stillListenerMs: 60_000 });
  try {
    assert.equal(L.still.horizons.get('one')?.still, true, 'the horizon is read back at start');
    await wait(400);
    assert.equal(status(L, 'one'), 'stopped', 'not booted at start nor by the keep-alive');
    assert.deepEqual(L.still.alarms(), [], 'no listener seen by this launcher');
    assert.equal((await fetch(`${base}/w/one/v1/edge/wait?after=c_1&timeout=1`, { headers: SOUL })).status, 200);   // a listener (another cursor: it loads)
    await until(() => status(L, 'one') === 'running', 'loaded');
    // a crash is still restarted
    const { pid } = L.pool.status('one'); process.kill(pid, 'SIGKILL');
    await until(() => status(L, 'one') === 'running' && L.pool.status('one').pid !== pid, 'restarted after a crash');
    // the alarm itself across a restart
    still('one', { moveWallMs: Date.now() + 1200 });
  } finally { await L.close(); }   // a release: the world's horizon is recorded on the way out
  L = await open({ dataDir });
  try {
    assert.equal(L.still.horizons.get('one')?.moveWallMs > Date.now(), true);
    assert.deepEqual(L.still.alarms(), []);
    await wait(1300);
    assert.deepEqual(L.still.alarms(), ['one'], 'the alarm fires after a restart of the launcher');
    await until(() => status(L, 'one') === 'running', 'loaded by its alarm');
  } finally { await L.close(); }
});

test('--unload-still 0 (the default): nothing is read, recorded or unloaded', { timeout: 30_000 }, async () => {
  const L = await open({ dataDir: join(dir, 'off'), unloadStill: undefined });
  try {
    await create('One'); await until(() => status(L, 'one') === 'running', 'it runs');
    still('one');
    assert.deepEqual(await L.still.sweep(), []);
    await L.pool.stop('one');
    assert.equal(L.still.horizons.size, 0);
  } finally { await L.close(); }
});
