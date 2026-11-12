// #2235: world time never stops. A world that had no process for a while (restart, deploy, eviction, crash) is caught up
// by ticking every tick it missed, so it reaches exactly the state a world ticked straight through would have reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { hashOf } from '@souls/engine-contract';
import { kernelHash } from '@souls/kernel';
import { retainedCommonsShoreFactory, nativeSleepSnapshotFactoryV1 } from '@souls/engine-mars';
import { fixture, invite, accept } from '../test/native-owner-fixture.ts';
import { owedTicks, WallClock } from './clock-catchup.ts';
import { LivingWorld } from './living.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';

const HOUR = 3_600_000;

test('ticks owed: the wall time since the anchor at the world rate, less the ticks logged after it', () => {
  const a = { worldId: 'w', wall: 1_000_000, tick: 5000 };
  assert.equal(owedTicks(a, 5000, 1_000_000 + 3 * HOUR), 216_000, 'away 3 h at 20 ticks/s');
  assert.equal(owedTicks(a, 5600, 1_000_000 + 3 * HOUR), 215_400, 'a crash replayed 600 ticks of its log tail after the anchor');
  assert.equal(owedTicks(a, 5000, 1_000_000 + 3 * HOUR, 2), 432_000, 'a world whose admin rate is 2');
  assert.equal(owedTicks(a, 5000, 1_000_000 + 49), 0, 'less than a tick');
  assert.equal(owedTicks({ ...a, paused: true }, 5000, 1_000_000 + 3 * HOUR), 0, 'paused by an admin: no time passes');
  assert.equal(owedTicks(null, 5000, 1_000_000 + 3 * HOUR), 0, 'no anchor (a first boot)');
  assert.equal(owedTicks(a, 9_999_999, 1_000_000 + HOUR), 0, 'never negative');
});

test('the wall anchor: saved while running and once as the clock stops, read back only by the same world', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wall-')); let now = 1_000_000;
  try {
    const host = { worldId: 'w-1', engine: { world: { tick: 100 } }, baseRate: 1, paused: false };
    const w = new WallClock(host, dir, { now: () => now }).start(60_000);
    now += 10_000; host.engine.world.tick = 300; w.stop();
    now += 5_000; w.stop();   // only the first stop records: the wall time after the clock stopped is owed
    assert.deepEqual(w.read(), { contract: 'wall-anchor/1', worldId: 'w-1', wall: 1_010_000, tick: 300 });
    now += 3 * HOUR;
    assert.equal(new WallClock(host, dir, { now: () => now }).owed(), (5_000 + 3 * HOUR) / 50);
    assert.equal(new WallClock({ ...host, worldId: 'other' }, dir, { now: () => now }).owed(), 0, 'another world\'s anchor');
    writeFileSync(w.file, JSON.stringify({ worldId: 'w-1', wall: 1_000, tick: 0 }));   // the pre-#2235 unwatched anchor
    assert.equal(new WallClock(host, dir, { now: () => now }).owed(), 0, 'an anchor without the contract is not read');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A5′: the same seeded world for the same span, once ticked straight through and once stopped, cold-booted from its
// snapshot (or, for a crash, from an older snapshot and its log) and caught up by WorldHost.catchUp. Three Souls stand
// idle and their needs move every tick. The day is 2400 ticks long, so the gap crosses LivingWorld's moments and a day
// turn. With ambient on, the edge ambient-life reflex also acts on them (#2236).
const factory = () => retainedCommonsShoreFactory().then(nativeSleepSnapshotFactoryV1);
const turn = () => setImmediate();
type F = ReturnType<typeof fixture>;
const state = (f: F) => ({ tick: f.host.engine.world.tick, seq: f.host.seq, engine: f.host.engine.stateHash(), kernel: kernelHash(f.host.kernel),
  lives: hashOf([...f.host.minds.values()].map((m) => [m.soulId, m.life])), events: hashOf(f.db.events(f.host.worldId).map((e) => [e.seq, e.tick, e.kind, e.author, e.payload])) });
async function world(t: test.TestContext, dir: string, ambient: boolean) {
  const f = fixture(join(dir, 'world.db'), await factory(), { durableClockV1: true }); f.souls.enableLifecycle(); f.brain.quiesce();
  t.after(() => { f.host.stop(); f.db.close(); });
  await accept<unknown>(f.host, new LivingWorld(f.host).install(['Owners drive their Souls.'])); for (let i = 0; i < 4; i++) f.host.tickOnce();
  await accept(f.host, f.host.installCommonsProvisionsV1()); await accept(f.host, f.host.installRetainedCommonsShoreV1());
  for (const p of [f.host.enableYieldTimeoutV1(), f.host.enableSpreadV2(), f.host.enableReflexTimeoutV1(), f.host.enableContinuousDayV1()]) await accept<unknown>(f.host, p);
  await accept(f.host, f.host.enqueue('rules', 'world', { dayConfig: { origin: 0, dayTicks: 2400, customs: ['Owners drive their Souls.'] }, why: 'test: a 2-minute day, so the gap crosses its moments and a day turn' }));
  for (const n of ['ana', 'ben', 'cy']) { await invite(f, n); await accept(f.host, f.souls.create('dev:' + n, { name: n, description: 'idle' })); }
  if (ambient) new EdgeLedger(f.host, f.db, undefined, { ambient: true });
  for (let i = 0; i < 200; i++) { f.host.tickOnce(); await turn(); }
  return f;
}
/** The process comes back: the world boots from the database it left and gets the same listeners main.ts gives it. */
async function reboot(t: test.TestContext, path: string, ambient: boolean) {
  const f = fixture(path, await factory(), { durableClockV1: true }); f.souls.enableLifecycle(); f.brain.quiesce();
  t.after(() => { f.host.stop(); f.db.close(); });
  new LivingWorld(f.host); if (ambient) new EdgeLedger(f.host, f.db, undefined, { ambient: true });
  return f;
}

for (const how of ['restart', 'crash'] as const) for (const ambient of [false, true]) {
  const what = `${how === 'restart' ? 'stopped and cold-booted' : 'that crashed and cold-booted'}, ${ambient ? 'idle Souls with the edge ambient-life reflex' : 'idle Souls, needs and day moving'}`;
  // #2236: the ambient-life reflex keeps its idle clock in memory, so a reboot shifts the idle Souls' next acts: unproved
  test(`equivalence: a world ${what}, caught up by ticking, matches one ticked straight through`, { timeout: 600_000, ...(ambient ? { todo: '#2236: the ambient-life idle clock is lost on reboot' } : {}) }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), `catchup-${how}-`)); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const control = await world(t, dir, ambient), gap = 2400, copy = join(dir, 'away.db');
    if (how === 'restart') control.host.saveSnapshot(true);                    // a clean stop saves its head
    else for (let i = 0; i < 300; i++) { control.host.tickOnce(); await turn(); }   // a crash: the last snapshot is older than the head
    control.db.db.exec(`VACUUM INTO '${copy}'`);                                 // what the stopped process left on disk
    const away = state(control);
    for (let i = 0; i < gap; i++) { control.host.tickOnce(); await turn(); }    // the control never stopped
    const after = await reboot(t, copy, ambient);
    assert.equal(after.host.engine.world.tick, away.tick, 'booted to where it stopped');
    // an input that arrives while the world is booting is held through the catch-up and lands at the first tick after it
    const probe = { why: 'test: an input queued before the catch-up' };
    void after.host.enqueue('rules', 'test', probe);
    const ran = await after.host.catchUp(control.host.engine.world.tick - after.host.engine.world.tick, turn);
    assert.equal(ran, gap);
    void control.host.enqueue('rules', 'test', probe);
    for (const f of [control, after]) { f.host.tickOnce(); await turn(); }
    const landed = after.db.events(after.host.worldId).find((e) => e.author === 'test');
    assert.equal(landed?.tick, away.tick + gap, 'the held input is logged at the first tick after the catch-up');
    const inGap = control.db.events(control.host.worldId).filter((e) => e.tick > away.tick && e.tick < away.tick + gap);
    const acts = inGap.filter((e) => (e.payload as { trigger?: string })?.trigger === 'edge-ambient').length;
    const day = inGap.filter((e) => e.kind === 'rules' && e.author === 'world').map((e) => Object.keys(e.payload as object).filter((k) => k !== 'why').join('+'));
    t.diagnostic(JSON.stringify({ how, ambient, gap, acts, day }));
    assert.ok(day.length > 0, 'the day turned in the gap (LivingWorld logged its events)');
    assert.notEqual(state(control).lives, away.lives, 'needs moved in the gap');
    if (ambient) assert.ok(acts > 0, 'the idle Souls lived in the gap (ambient acts were logged)');
    assert.deepEqual(state(after), state(control));
  });
}
