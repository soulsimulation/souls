// #1326: a stalled clock is visible. The tick's wall age and `stalled` in live.json and /healthz, edge reads that say so
// instead of a plain 200 with the old tick, acts refused before they write, long-polls that end early, and no stall
// while paused, asleep at a reduced pace or with the rate at 0 (a dilated clock is `slowed`, not stalled).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {testPort} from '../test/test-port.ts';
import {LoadMonitor, STALL_MIN_MS, stallMsOf} from './load/monitor.ts';
import {clockOf, liveOf, newSharedLoad, S} from './load/shared.ts';
import {attachBootSlots, bootPhase, bootSlots} from './load/boot-progress.ts';
import {setClockSource} from './load/clock-source.ts';
const TEST_PORT = await testPort();

test('S6: the threshold: 2 s at full speed, 10 expected ticks at a reduced pace or a dilated rate; none while paused, stopped, halted or at rate 0', () => {
  const h = {running: true, paused: false, clockAvailable: true, pace: 1, clockRate: 1, baseRate: 1};
  assert.equal(stallMsOf(h), STALL_MIN_MS);
  assert.equal(stallMsOf({...h, pace: 0.05}), 10_000, 'asleep at a twentieth of the pace: 10 of its 500 ms ticks');
  assert.equal(stallMsOf({...h, clockRate: 0.25}), STALL_MIN_MS, 'a quarter rate (the most dilation does): still 2 s');
  assert.equal(stallMsOf({...h, clockRate: 0.1, baseRate: 0.1}), 5000);
  for (const off of [{paused: true}, {running: false}, {clockAvailable: false}, {clockRate: 0, baseRate: 0}]) assert.equal(stallMsOf({...h, ...off}), 0, JSON.stringify(off));
});

test('S1, S2, S6: the monitor publishes the tick age and `stalled`; a completed tick clears it at once; paused, a slow pace and dilation are not stalls', () => {
  let now = 1000;
  const listeners: {afterTickComplete?(tick: number): void}[] = [];
  const host = {engine: {world: {tick: 0}}, tickMs: [] as number[], paused: false, pace: 1, baseRate: 1, clockRate: 1, running: true, clockAvailable: true, listeners};
  const shared = newSharedLoad(), m = new LoadMonitor({host, now: () => now, shared, sampleMs: 3_600_000});
  const before = bootSlots(); attachBootSlots(shared, S.boot); bootPhase('serving', 0);
  try {
    m.start(); assert.equal(listeners.length, 1, 'the monitor notes each completed tick');
    assert.deepEqual(clockOf(shared, now), {tickAgeMs: 0, stalled: false, clockRate: 1, baseRate: 1, slowed: false});
    now = 2500; m.sample(); assert.equal(m.clock().stalled, false); assert.equal(liveOf(shared, 1, now).tick!.ageMs, 1500);
    now = 4000; m.sample();
    let live = liveOf(shared, 1, now); assert.equal(live.stalled, true); assert.equal(live.tick!.ageMs, 3000);
    assert.equal(liveOf(shared, 1, 9000).tick!.ageMs, 8000, 'the watchdog thread ages it with no main-thread turn');
    // S2: the next completed tick clears it, before any sample
    now = 4100; host.engine.world.tick = 1; listeners[0].afterTickComplete!(1);
    assert.equal(liveOf(shared, 1, now).stalled, undefined); assert.equal(m.clock().tickAgeMs, 0);
    // paused: owes nothing, however long
    host.paused = true; m.sample(); now = 60_000; m.sample(); assert.equal(m.clock().stalled, false); assert.equal(liveOf(shared, 1, now).stalled, undefined);
    // unpaused: the age counts from now, not from before the pause
    host.paused = false; m.sample(); assert.equal(m.clock().stalled, false); assert.equal(m.clock().tickAgeMs, 0);
    // asleep at a twentieth of the pace: 5 s without a tick is fine, 11 s is a stall
    host.pace = 0.05; now += 5000; m.sample(); assert.equal(m.clock().stalled, false);
    now += 6000; m.sample(); assert.equal(m.clock().stalled, true);
    // a dilated clock that ticks is `slowed`, never stalled
    host.pace = 1; host.clockRate = 0.5; now += 50; listeners[0].afterTickComplete!(2); m.sample();
    live = liveOf(shared, 1, now); assert.equal(live.stalled, undefined); assert.deepEqual(live.slowed, {clockRate: 0.5, baseRate: 1});
    m.stop(); assert.equal(listeners.length, 0, 'stop removes the tick listener');
  } finally { attachBootSlots(before.view as Float64Array, before.offset); m.stop(); }
});

test('S1, S4, S5: /healthz says stalled; edge reads carry world.stalled; an act is refused 503 world.stalled and writes no receipt; a long-poll ends early', async t => {
  const f = fixture(':memory:'); f.brain.quiesce();
  let stalled = false, slowed = false;
  const clock = () => ({tickAgeMs: stalled ? 7000 : 10, stalled, clockRate: slowed ? 0.5 : 1, baseRate: 1, slowed});
  const monitor = {clock, health: () => ({}), tickStats: {avg: 1, max: 1, n: 1, p99: 1}, level: 'green', register() {}};
  t.after(() => { setClockSource(null); f.host.stop(); f.db.close(); });
  await invite(f, 'alice');
  const a = await accept(f.host, f.souls.create('dev:alice', {name: 'Avery', description: 'Stall fixture'}));
  const token = f.souls.pairExchange(f.souls.pairCode(a, `http://127.0.0.1:${TEST_PORT}`).code, 'scripted').token;
  const app = buildApp({cfg: {...config, port: TEST_PORT, worldPath: '/w/eden', publicUrl: `http://127.0.0.1:${TEST_PORT}/w/eden`, accountAuthRequired: false, webDir: '/nonexistent-stall-fixture', marsWebDir: '/nonexistent-stall-fixture'}, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge: new EdgeLedger(f.host, f.db), hub: {clients: new Map(), refreshMe() {}} as never, load: {monitor} as never});
  const req = async (path: string, body?: unknown) => {
    const r = await app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: r.status, retry: r.headers.get('retry-after'), data: await r.json() as any};
  };
  const receipts = () => (f.db.db.prepare('SELECT COUNT(*) AS n FROM edge_receipts_v1').get() as {n: number}).n;

  // running: nothing is added
  let h = await req('/healthz'); assert.equal(h.data.stalled, false); assert.equal(h.data.tickAgeMs, 10); assert.equal(h.data.baseRate, 1);
  const ok = await req('/v1/edge/observe'); assert.equal(ok.status, 200); assert.equal(ok.data.world?.stalled, undefined);
  const cursor = ok.data.cursor ?? 'c_0';

  // stalled
  stalled = true;
  h = await req('/healthz'); assert.equal(h.data.stalled, true); assert.equal(h.data.tickAgeMs, 7000);
  for (const path of ['/v1/edge/observe', '/v1/edge/here', '/v1/edge/capabilities', '/v1/edge/self/link']) {
    const r = await req(path); assert.equal(r.status, 200, path);
    assert.equal(r.data.world?.stalled, true, path); assert.equal(r.data.world?.tick_age_ms, 7000, path); assert.match(r.data.world?.note, /clock has not moved/, path);
  }
  const n = receipts();
  const act = await req('/v1/edge/act', {capability: 'stand:here'});
  assert.equal(act.status, 503); assert.equal(act.data.error.code, 'world.stalled'); assert.equal(act.retry, '5'); assert.equal(act.data.world.stalled, true);
  assert.equal(receipts(), n, 'nothing written');
  // a long-poll already stalled holds at most 5 s, then answers with the block
  let begun = performance.now();
  const w = await req(`/v1/edge/wait?after=${cursor}&timeout=30`);
  assert.equal(w.status, 200); assert.equal(w.data.world.stalled, true); assert.ok(performance.now() - begun < 8000, 'not its 30 s timeout');
  begun = performance.now();
  const l = await req('/v1/edge/inbox/listen?timeoutMs=30000');
  assert.equal(l.status, 200); assert.equal(l.data.world.stalled, true); assert.ok(performance.now() - begun < 8000, 'not its 30 s timeout');

  // a wait under way ends when the clock stalls, not at its timeout
  stalled = false; begun = performance.now();
  const waiting = req(`/v1/edge/wait?after=${cursor}&timeout=30`);
  setTimeout(() => { stalled = true; }, 300);
  const ended = await waiting;
  assert.equal(ended.data.world.stalled, true); assert.ok(performance.now() - begun < 3000, `ended after ${Math.round(performance.now() - begun)} ms`);

  // running again: acts go through; a dilated clock says `slowed` with its speed
  stalled = false; slowed = true;
  const act2 = await req('/v1/edge/act', {capability: 'stand:here'}); assert.notEqual(act2.status, 503);
  const o = await req('/v1/edge/observe'); assert.equal(o.data.world?.stalled, undefined);
  h = await req('/healthz'); assert.equal(h.data.slowed, true); assert.equal(h.data.stalled, false);
  const caps = await req('/v1/edge/capabilities'); assert.deepEqual(caps.data.world, {load: 'slowed', slowed: true, speed: 0.5});
});
