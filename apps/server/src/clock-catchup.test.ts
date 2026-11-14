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
async function world(t: test.TestContext, dir: string, ambient: boolean, anchors = false) {
  const f = fixture(join(dir, 'world.db'), await factory(), { durableClockV1: true }); f.souls.enableLifecycle(); f.brain.quiesce();
  t.after(() => { f.host.stop(); f.db.close(); });
  await accept<unknown>(f.host, new LivingWorld(f.host).install(['Owners drive their Souls.'])); for (let i = 0; i < 4; i++) f.host.tickOnce();
  await accept(f.host, f.host.installCommonsProvisionsV1()); await accept(f.host, f.host.installRetainedCommonsShoreV1());
  for (const p of [f.host.enableYieldTimeoutV1(), f.host.enableSpreadV2(), f.host.enableReflexTimeoutV1(), f.host.enableContinuousDayV1()]) await accept<unknown>(f.host, p);
  await accept(f.host, f.host.enqueue('rules', 'world', { dayConfig: { origin: 0, dayTicks: 2400, customs: ['Owners drive their Souls.'] }, why: 'test: a 2-minute day, so the gap crosses its moments and a day turn' }));
  for (const n of ['ana', 'ben', 'cy']) { await invite(f, n); await accept(f.host, f.souls.create('dev:' + n, { name: n, description: 'idle' })); }
  if (ambient) new EdgeLedger(f.host, f.db, undefined, { ambient: true });
  // #2296: need-anchor/1 adopted halfway, 50 ticks after a snapshot, so a boot from it replays the old reader, then the adoption
  for (let i = 0; i < 200; i++) { if (anchors && i === 50) f.host.saveSnapshot(true); if (anchors && i === 100) await accept<unknown>(f.host, f.host.enableNeedAnchorsV1()); f.host.tickOnce(); await turn(); }
  return f;
}
/** The process comes back: the world boots from the database it left and gets the same listeners main.ts gives it. */
async function reboot(t: test.TestContext, path: string, ambient: boolean) {
  const f = fixture(path, await factory(), { durableClockV1: true }); f.souls.enableLifecycle(); f.brain.quiesce();
  t.after(() => { f.host.stop(); f.db.close(); });
  new LivingWorld(f.host); if (ambient) new EdgeLedger(f.host, f.db, undefined, { ambient: true });
  return f;
}

// #2294 A4: a held read keeps its end tick in snapshotted state and in the state hash, so a world stopped halfway through
// it and caught up by ticking ends it on the control's tick.
test('held-activity/1: a world cold-booted halfway through a 3,600 s read ends it on the control\'s tick, hashes equal', { timeout: 900_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catchup-held-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const boot = (path: string) => { const f = fixture(path, undefined, { durableClockV1: true }); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); }); return f; };
  const control = boot(join(dir, 'world.db')), copy = join(dir, 'away.db');
  await accept<unknown>(control.host, control.host.enableHeldActivitiesV1());
  await invite(control, 'ana'); await accept(control.host, control.souls.create('dev:ana', { name: 'ana', description: 'a reader' }));
  for (let i = 0; i < 20; i++) { control.host.tickOnce(); await turn(); }
  const m = [...control.host.minds.values()][0], body = (f: F) => f.host.engine.world.entities[m.entityId]?.human?.activity;
  const engine = (f: F) => f.host.engine as unknown as { stillnessV1(): { still: boolean; untilTick: number | null } };
  await accept(control.host, control.host.enqueue('decision', 'fixture', { soulId: m.soulId, entityId: m.entityId, option: 'rest', card: 'rest', target: null, label: 'Read a book',
    steps: [{ verb: 'mars:pose_v1', params: { activity: 'read', prop: 'book', seconds: 3600 } }], approachLen: 0, reevalTicks: 1e9, fallback: true, trigger: 'fixture' }));
  for (let i = 0; i < 5; i++) { control.host.tickOnce(); await turn(); }
  const { still, untilTick: end } = engine(control).stillnessV1();
  assert.equal(body(control), 'read'); assert.equal(still, true, 'a reading Soul alone: the world is still');
  const left = end! - control.host.engine.world.tick; assert.ok(left > 72_000 - 10 && left < 72_000, 'the read ends an hour after it started');
  for (let i = 0; control.host.engine.world.tick < end! - 36_000; i++) { control.host.tickOnce(); if (i % 500 === 0) await turn(); }
  control.host.saveSnapshot(true); control.db.db.exec(`VACUUM INTO '${copy}'`);
  const away = control.host.engine.world.tick;
  for (let i = 0; control.host.engine.world.tick < end! - 1; i++) { control.host.tickOnce(); if (i % 500 === 0) await turn(); }
  assert.equal(body(control), 'read', 'still reading the tick before its end');
  control.host.tickOnce(); await turn();
  assert.equal(body(control), 'idle', 'the control stood up by itself at the end tick');
  const after = boot(copy);
  assert.equal(after.host.engine.world.tick, away, 'booted halfway through the read');
  assert.equal(engine(after).stillnessV1().untilTick, end, 'the end tick came back with the snapshot');
  await after.host.catchUp(end! - 1 - away, turn);
  assert.equal(body(after), 'read');
  await after.host.catchUp(1, turn);
  assert.equal(after.host.engine.world.tick, end);
  assert.equal(body(after), 'idle', 'the rebooted world ends the read on the same tick');
  assert.equal(after.host.engine.stateHash(), control.host.engine.stateHash(), 'equal hashes at the end tick');
});

for (const how of ['restart', 'crash'] as const) for (const [ambient, anchors] of [[false, false], [true, false], [false, true]]) {
  const what = `${how === 'restart' ? 'stopped and cold-booted' : 'that crashed and cold-booted'}, ${ambient ? 'idle Souls with the edge ambient-life reflex' : anchors ? 'idle Souls whose needs are anchors (need-anchor/1, adopted mid-history)' : 'idle Souls, needs and day moving'}`;
  // #2236: the ambient-life reflex keeps its idle clock in memory, so a reboot shifts the idle Souls' next acts: unproved
  test(`equivalence: a world ${what}, caught up by ticking, matches one ticked straight through`, { timeout: 600_000, ...(ambient ? { todo: '#2236: the ambient-life idle clock is lost on reboot' } : {}) }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), `catchup-${how}-`)); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const control = await world(t, dir, ambient, anchors), gap = 2400, copy = join(dir, 'away.db');
    if (how === 'restart') control.host.saveSnapshot(true);                    // a clean stop saves its head
    else for (let i = 0; i < 300; i++) { control.host.tickOnce(); await turn(); }   // a crash: the last snapshot is older than the head
    control.db.db.exec(`VACUUM INTO '${copy}'`);                                 // what the stopped process left on disk
    const away = state(control), needs = (f: F) => hashOf([...f.host.minds.values()].map((m) => f.host.needsOf(m))), awayNeeds = needs(control);
    for (let i = 0; i < gap; i++) { control.host.tickOnce(); await turn(); }    // the control never stopped
    const after = await reboot(t, copy, ambient);
    assert.equal(after.host.engine.world.tick, away.tick, 'booted to where it stopped');
    if (anchors && how === 'crash') { const adopted = after.db.events(after.host.worldId).find((e) => (e.payload as {runtimePolicy?: {needAnchorsV1?: boolean}})?.runtimePolicy?.needAnchorsV1)!;
      assert.ok(after.db.latestSnapshot(after.host.worldId)!.tick < adopted.tick, 'the boot replayed the old reader\'s ticks and the adoption from an older snapshot'); }
    const ran = await after.host.catchUp(control.host.engine.world.tick - after.host.engine.world.tick, turn);
    assert.equal(ran, gap);
    const inGap = control.db.events(control.host.worldId).filter((e) => e.tick > away.tick && e.tick < away.tick + gap);
    const acts = inGap.filter((e) => (e.payload as { trigger?: string })?.trigger === 'edge-ambient').length;
    const day = inGap.filter((e) => e.kind === 'rules' && e.author === 'world').map((e) => Object.keys(e.payload as object).filter((k) => k !== 'why').join('+'));
    t.diagnostic(JSON.stringify({ how, ambient, gap, acts, day }));
    assert.ok(day.length > 0, 'the day turned in the gap (LivingWorld logged its events)');
    assert.notEqual(needs(control), awayNeeds, 'needs moved in the gap');
    if (anchors) assert.ok([...control.host.minds.values()].every((m) => m.life!.anchor), 'every Soul\'s needs are an anchor');
    if (ambient) assert.ok(acts > 0, 'the idle Souls lived in the gap (ambient acts were logged)');
    assert.deepEqual(state(after), state(control));
  });
}

// #2295 A5: two Souls taken from their agents' last acts to both asleep by the wind-down (short knobs), once ticked
// straight through and once stopped and cold-booted twice on the way (the second boot without the rule's cache):
// the same state hash and the same log.
test('wind-down/1: a world stopped and cold-booted twice between the last agent act and both asleep matches one ticked straight through', { timeout: 900_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'catchup-winddown-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const knobs = { wanderTicks: 400, zombieTicks: 600, legMinTicks: 100, legMaxTicks: 200, boundTicks: 1500 };
  const boot = (path: string) => {
    const f = fixture(path, undefined, { durableClockV1: true }); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
    const ledger = new EdgeLedger(f.host, f.db); return { f, rule: ledger.startBodyRule(knobs)! };
  };
  const control = boot(join(dir, 'world.db'));
  await accept<unknown>(control.f.host, control.f.host.enableHeldActivitiesV1());
  for (const n of ['ana', 'ben']) { await invite(control.f, n); await accept(control.f.host, control.f.souls.create('dev:' + n, { name: n, description: 'quiet' })); }
  for (const m of control.f.host.minds.values()) await accept(control.f.host, control.f.host.enqueue('decision', `edge:${m.soulId}`, { soulId: m.soulId, entityId: m.entityId, option: 'rest', label: 'Read a book',
    steps: [{ verb: 'mars:pose_v1', params: { activity: 'read', prop: 'book', seconds: 10 } }], reevalTicks: 1e9, fallback: false, trigger: 'edge-act:r_last' }));
  const run = async (w: ReturnType<typeof boot>, to: number) => { for (let i = 0; w.f.host.engine.world.tick < to; i++) { w.f.host.tickOnce(); if (i % 200 === 0) await turn(); } };
  const start = control.f.host.engine.world.tick, end = start + knobs.wanderTicks + knobs.boundTicks + 40;
  const save = (w: ReturnType<typeof boot>, name: string) => { w.f.host.saveSnapshot(true); const p = join(dir, name); w.f.db.db.exec(`VACUUM INTO '${p}'`); return p; };
  await run(control, start + knobs.wanderTicks + 250); const first = save(control, 'first.db');
  await run(control, end);
  const asleep = () => [...control.f.host.minds.values()].map((m) => control.rule.view(m.soulId)?.state);
  assert.deepEqual(asleep(), ['asleep', 'asleep'], 'the control put both to sleep');
  assert.deepEqual([...control.f.host.minds.values()].map((m) => control.f.host.engine.world.entities[m.entityId]?.human?.activity), ['nap', 'nap'], 'lying in the held sleep');
  const still = () => (control.f.host.engine as unknown as { stillnessV1(): { still: boolean; untilTick: number | null } }).stillnessV1();
  assert.deepEqual(still(), { still: true, untilTick: null }, 'a held sleep with no end');
  assert.equal(control.rule.nextMoveTick(), null, 'and the rule has nothing due');
  // from a still tick, one more step changes no body and no live action
  const bodies = () => JSON.stringify([...control.f.host.minds.values()].map((m) => control.f.host.engine.world.entities[m.entityId]));
  const before = bodies(); control.f.host.tickOnce(); control.f.host.tickOnce();
  assert.equal(bodies(), before, 'one more step changes nothing'); assert.deepEqual(still(), { still: true, untilTick: null });
  assert.ok(control.f.db.events(control.f.host.worldId).filter((e) => (e.payload as { trigger?: string })?.trigger === 'edge-body').length >= 6, 'the wind-down moved them');
  const a = boot(first); assert.equal(a.f.host.engine.world.tick, start + knobs.wanderTicks + 250);
  await a.f.host.catchUp(250, turn);   // partway through Wander: a second stop before the walk out
  const second = save(a, 'second.db');
  const b0 = new (await import('node:sqlite')).DatabaseSync(second); b0.exec('DELETE FROM edge_body_v1'); b0.close();   // A3: the cache is lost
  const b = boot(second);
  await b.f.host.catchUp(control.f.host.engine.world.tick - b.f.host.engine.world.tick, turn);
  assert.equal(b.f.host.engine.world.tick, end + 2);
  assert.equal(b.rule.nextMoveTick(), null, 'nothing more is due');
  assert.deepEqual(state(b.f), state(control.f));
});
