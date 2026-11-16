// #2299 A7: a still world leaves memory and returns on a request or its alarm. Fake world processes (fake-world.mjs)
// that answer the still contract of #2241 (GET /__sim/still) from a file each test writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceClock, launcherSettings, openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const BASE = await testPort(8);
const dir = mkdtempSync(join(tmpdir(), 'unload-still-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
writeFileSync(join(templatesDir, 'hello-hamlet.json'), JSON.stringify({ schema: 'genesis/1', name: 'Hello hamlet', description: 'a hamlet', batches: [] }));
const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Sim</title>');
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const stillFile = (slug) => join(dir, `still-${slug}.json`);
const dueFile = (slug) => join(dir, `due-${slug}.json`);
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1', FAKE_STILL_FILE: stillFile(w.slug), FAKE_DUE_FILE: dueFile(w.slug) } });
const still = (slug, o = {}) => writeFileSync(stillFile(slug), JSON.stringify({ still: true, tick: 1, wallMs: Date.now(), untilTick: null, untilWallMs: null, moveTick: null, moveWallMs: null, ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const P = BASE, base = `http://127.0.0.1:${P}`, NEVER = 1_000_000;
const open = (o) => openLauncher({ port: P, range: [BASE + 1, BASE + 7], webDir, templatesDir, command, eager: 0, keepAlive: true, keepAliveMs: 100, log: () => {},
  unloadStill: true, stillServedMs: 0, stillHorizonMs: 0, stillQuietMs: 0, stillEveryMs: NEVER, stillAlarmMs: NEVER, stillLeadMs: 0, ...o });
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
    await wait(1600);   // the quiet time since the launcher started (its start counts as the last use)
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

test('alarms: at moveWallMs and at untilWallMs, listener or not (#2367); unloaded again after it served; kept across a restart', { timeout: 60_000 }, async () => {
  const dataDir = join(dir, 'alarms');
  let L = await open({ dataDir, stillServedMs: 1000 });
  try {
    await create('One'); await until(() => status(L, 'one') === 'running', 'it runs');
    await wait(1000);
    still('one', { untilWallMs: Date.now() + 500, moveWallMs: Date.now() + 1500 });
    assert.deepEqual(await L.still.sweep(), ['one']);
    assert.deepEqual(L.still.alarms(), [], 'nothing due');
    await wait(600);
    assert.deepEqual(L.still.alarms(), ['one'], '#2367 A1: its next deadline is due: loaded with nobody listening');
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
    assert.deepEqual(L.still.alarms(), ['one'], '#2367 A1: its deadline passed while no launcher ran: loaded at once, no listener needed');
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

// #2367 A1: a reminder is a deadline in the world's horizon (apps/server/src/edge/reminders/routes.ts: edge.reminder.*, so
// untilWallMs). The fake world delivers it at its due time while it runs (FAKE_DUE_FILE), as the reminders' pump does.
test('#2367 A1: a reminder due on a world that unloads is delivered within 5 s of its due time, with nobody listening', { timeout: 60_000 }, async (t) => {
  const L = await open({ dataDir: join(dir, 'reminder'), stillAlarmMs: 100, stillLeadMs: 2000 });
  try {
    await create('Rem'); await until(() => status(L, 'rem') === 'running', 'it runs');
    const out = join(dir, 'delivered-rem.txt'), dueAt = Date.now() + 6000;
    writeFileSync(dueFile('rem'), JSON.stringify({ dueAt, out }));   // read when the world next loads
    still('rem', { untilWallMs: dueAt });
    assert.deepEqual(await L.still.sweep(), ['rem']);
    assert.equal(status(L, 'rem'), 'stopped', 'unloaded with the reminder ahead');
    let at = null;
    for (let i = 0; i < 200 && at === null; i++) { try { at = Number(readFileSync(out, 'utf8').trim().split('\n')[0]); } catch { await wait(50); } }
    assert.ok(at !== null, 'the reminder was delivered');
    assert.ok(at >= dueAt && at - dueAt <= 5000, `delivered ${at - dueAt} ms after its due time`);
    t.diagnostic(`delivered ${at - dueAt} ms after its due time`);
    await until(() => status(L, 'rem') === 'running', 'loaded by its alarm');
  } finally { await L.close(); }
});

// #2367 A2: one small world fits the memory figure (LOAD_MB.small 310 of 400 MB; no Pss off Linux: the estimate)
test('#2367 A2: a load with no room waits, then answers world.waking with a retry hint (never failed); a still world is unloaded to make room', { timeout: 60_000 }, async () => {
  const L = await open({ dataDir: join(dir, 'room'), roomWaitMs: 1500 });
  try {
    await create('Aaa'); await create('Bbb'); await until(() => status(L, 'aaa') === 'running' && status(L, 'bbb') === 'running', 'both run');
    L.pool.o.pss = () => 300; L.pool.state('aaa').pssAt = 0; L.pool.o.worldsMemMb = 400; await L.pool.stop('bbb'); await wait(400);   // (a fake's Pss on Linux is tiny: a fixed 300 MB)
    assert.equal(status(L, 'bbb'), 'stopped', 'no room: the keep-alive does not load it');
    assert.equal((await act('aaa')).status, 200);   // aaa: just used and not still, so it cannot go
    const t0 = Date.now(), r = await act('bbb'), body = await r.json();
    assert.ok(Date.now() - t0 >= 1400, 'it waited for room first');
    assert.equal(r.status, 503); assert.equal(body.code, 'world.waking'); assert.equal(r.headers.get('retry-after'), '15'); assert.equal(body.retryAfterMs, 15_000);
    assert.notEqual(status(L, 'bbb'), 'failed'); assert.equal(L.still.stateOf('bbb'), 'unloaded');
    // aaa turns still: the wait reads the still answers afresh and unloads it to make room
    still('aaa');
    const r2 = await act('bbb');
    assert.equal(r2.status, 200); assert.equal((await r2.json()).acted, true);
    assert.equal(status(L, 'bbb'), 'running'); assert.equal(L.still.stateOf('aaa'), 'unloaded');
    assert.equal(L.still.horizons.get('aaa')?.still, true, 'unloaded as still: its alarm loads it');
  } finally { await L.close(); }
});

// The 0.130 switch: deploy/install.sh unload-still writes <data>/launcher-settings.json; every launcher reads it once at
// its start. A reload is a new launcher process (keeper.mjs forks launcher.mjs from the stage link with the same args), so
// opening a launcher again on the same data dir is what a reload does.
test('launcher-settings.json: absent is the default, 1 turns unloading on, an explicit --unload-still wins, a bad value is the default, a reload reads a new value', { timeout: 30_000 }, async () => {
  const dataDir = join(dir, 'settings'), file = join(dataDir, 'launcher-settings.json'); mkdirSync(dataDir, { recursive: true });
  const said = async (o) => { const lines = []; const L = await open({ dataDir, unloadStill: undefined, log: (s) => lines.push(String(s)), ...o }); await L.close(); return lines.filter((l) => /^(unload-still |launcher-settings)/.test(l)); };
  assert.deepEqual(launcherSettings(dataDir), {}, 'absent');
  assert.deepEqual(await said(), ['unload-still 0 (the default)']);
  writeFileSync(file, '{"unloadStill":1}\n');
  assert.deepEqual(launcherSettings(dataDir), { unloadStill: true });
  assert.deepEqual(await said(), ['launcher-settings.json: unloadStill 1', 'unload-still 1 (launcher-settings.json)'], 'a new launcher (a reload) reads it');
  assert.deepEqual(await said({ unloadStill: false }), ['unload-still 0 (the --unload-still arg)'], '--unload-still 0 wins over the file');
  writeFileSync(file, '{"unloadStill":"yes"}');
  assert.deepEqual(await said(), ['launcher-settings.json: unloadStill must be 0 or 1 (got "yes"); the args\' defaults apply', 'unload-still 0 (the default)']);
  writeFileSync(file, '{not json');
  assert.match((await said())[0], /launcher-settings\.json unreadable/);
  writeFileSync(file, '{"unloadStill":0}');
  assert.deepEqual(await said(), ['launcher-settings.json: unloadStill 0', 'unload-still 0 (launcher-settings.json)']);
  rmSync(file);
  assert.deepEqual(await said(), ['unload-still 0 (the default)'], 'removed: the default again');
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
