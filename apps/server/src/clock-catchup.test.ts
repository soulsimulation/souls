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
    const ran = await after.host.catchUp(control.host.engine.world.tick - after.host.engine.world.tick, turn);
    assert.equal(ran, gap);
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

// #2298: a still world's clock is jumped, not stepped (WorldHost.advanceStep, the engine's skipToV1). The same god world,
// once ticked straight through and once brought forward by the boot catch-up, which jumps where the world is still, reaches
// the same state hash and the same log; again when the jumping run is stopped and cold-booted halfway. JUMP_FULL=1: three
// real days (1,728,000 ticks each, about an hour of ticking per case); otherwise three 24,000-tick days (the same deadlines
// and day turns at a smaller scale). The Souls here have no needs (a Soul whose needs add up every tick keeps the world
// ticking until #2296's need-anchor/1 is adopted).
const JUMP_FULL = process.env.JUMP_FULL === '1';
const JUMP_DAY = JUMP_FULL ? 1_728_000 : 24_000;
const KNOBS = { wanderTicks: 400, zombieTicks: 600, legMinTicks: 100, legMaxTicks: 200, boundTicks: 1500 };
async function godWorld(t: test.TestContext, path: string, souls: number | null) {
  const { Hono } = await import('hono'), { mountEdgeRoutes } = await import('./edge/routes.ts'), { GodMode } = await import('./god/god.ts'), { installEngineBridge } = await import('./god/engine-bridge.ts');
  const f = fixture(path, undefined, { durableClockV1: true }); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  const ledger = new EdgeLedger(f.host, f.db), rule = ledger.startBodyRule(KNOBS)!;
  const comms = mountEdgeRoutes(new Hono(), { host: f.host, db: f.db, souls: f.souls, ledger, soul: () => { throw new Error('no requests'); } } as never);
  t.after(() => comms.close());
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  installEngineBridge({ host: f.host, god, edge: ledger, log: () => {}, worldLore: false, worldClock: false });
  new LivingWorld(f.host);
  if (souls !== null) {   // a fresh world: a day, held activities, the Souls and each one's last act (a ten-second read)
    await accept(f.host, f.host.enqueue('rules', 'world', { dayConfig: { origin: f.host.engine.world.tick, dayTicks: JUMP_DAY, customs: [], zone: 'UTC' }, why: 'test: a day' }));
    await accept<unknown>(f.host, f.host.enableHeldActivitiesV1());
    for (const n of ['ana', 'ben'].slice(0, souls)) { await invite(f, n); await accept(f.host, f.souls.create('dev:' + n, { name: n, description: 'quiet' })); }
    for (const m of f.host.minds.values()) await accept(f.host, f.host.enqueue('decision', `edge:${m.soulId}`, { soulId: m.soulId, entityId: m.entityId, option: 'rest', label: 'Read a book',
      steps: [{ verb: 'mars:pose_v1', params: { activity: 'read', prop: 'book', seconds: 10 } }], reevalTicks: 1e9, fallback: false, trigger: 'edge-act:r_last' }));
  }
  return { f, rule };
}
const tickTo = async (f: F, to: number) => { for (let i = 0; f.host.engine.world.tick < to; i++) { f.host.tickOnce(); if (i % 2000 === 0) await turn(); } };
const copyOf = (f: F, dir: string, name: string) => { f.host.saveSnapshot(true); const p = join(dir, name); f.db.db.exec(`VACUUM INTO '${p}'`); return p; };
type Skip = { skipToV1(t: number): { ok: true; from: number; to: number } | { ok: false; reason: string } };

test('#2298 A1: skipToV1 leaves what ticking leaves; refused while not still or at the horizon', { timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jump-a1-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { f } = await godWorld(t, join(dir, 'world.db'), 2), skip = (g: F) => g.host.engine as unknown as Skip;
  assert.deepEqual(skip(f).skipToV1(f.host.engine.world.tick + 5), { ok: false, reason: 'skip.not-still' }, 'two Souls starting a read');
  await tickTo(f, f.host.engine.world.tick + 5);   // both are reading, held until the read's end
  const eng = (f.host.engine as unknown as { stillnessV1(): { still: boolean; untilTick: number | null } }).stillnessV1();
  assert.equal(eng.still, true); assert.ok(eng.untilTick! > f.host.engine.world.tick + 150, JSON.stringify(eng));
  const copy = copyOf(f, dir, 'a1.db'), from = f.host.engine.world.tick;
  assert.deepEqual(skip(f).skipToV1(eng.untilTick!), { ok: false, reason: 'skip.past-horizon' }, 'the step that ends the read is not skipped');
  assert.deepEqual(skip(f).skipToV1(from), { ok: false, reason: 'skip.not-ahead' });
  const b = await godWorld(t, copy, null), to = eng.untilTick! - 1;
  await tickTo(f, to);
  assert.deepEqual(skip(b.f).skipToV1(to), { ok: true, from, to });
  assert.equal(b.f.host.engine.world.env.datetime, f.host.engine.world.env.datetime, 'the time of day');
  assert.equal(b.f.host.engine.stateHash(), f.host.engine.stateHash(), 'the state hash: clock, attention and every other field');
  for (let i = 0; i < 3; i++) { f.host.tickOnce(); b.f.host.tickOnce(); }
  assert.deepEqual(state(b.f), state(f), 'and the ordinary ticks after it agree, the log included');
});

const asleep = (w: { f: F; rule: { view(id: string): { state?: string } | null | undefined } }) => [...w.f.host.minds.values()].map((m) => w.rule.view(m.soulId)?.state);
for (const [name, souls, settle, span] of [
  ['an empty world over 3 days', 0, 0, 3 * JUMP_DAY],
  ['two Souls asleep over 3 days', 2, 4_000, 3 * JUMP_DAY],
  ['two Souls from the last agent act through the wind-down and one day more', 2, 0, 4_000 + JUMP_DAY],
] as const) for (const how of ['straight', 'stopped and cold-booted halfway'] as const) {
  test(`#2298 A3: ${name}, jumped (${how}), equals ticked straight through`, { timeout: JUMP_FULL ? 14_400_000 : 900_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jump-a3-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const control = await godWorld(t, join(dir, 'world.db'), souls);
    if (settle) { await tickTo(control.f, control.f.host.engine.world.tick + settle); assert.deepEqual(asleep(control), ['asleep', 'asleep'], 'both asleep'); }
    const start = control.f.host.engine.world.tick, end = start + span, copy = copyOf(control.f, dir, 'start.db');
    const at = performance.now(); await tickTo(control.f, end); const tickedMs = performance.now() - at;
    let run = await godWorld(t, copy, null), jumped = 0, computed = 0;
    const go = async (to: number) => { const k = run.f.host.skipStats, j = k.ticksJumped, c = k.ticksComputed; await run.f.host.catchUp(to - run.f.host.engine.world.tick, turn); jumped += k.ticksJumped - j; computed += k.ticksComputed - c; };
    const jt = performance.now();
    if (how === 'straight') await go(end);
    else { await go(start + Math.floor(span / 2)); run = await godWorld(t, copyOf(run.f, dir, 'half.db'), null); await go(end); }
    const jumpedMs = performance.now() - jt;
    t.diagnostic(JSON.stringify({ name, how, span, jumped, computed, tickedMs: Math.round(tickedMs), jumpedMs: Math.round(jumpedMs) }));
    assert.equal(run.f.host.engine.world.tick, end);
    assert.ok(jumped > span * 0.8, `most of the span was jumped (${jumped} of ${span})`);
    if (souls) assert.deepEqual(asleep(run), asleep(control));
    assert.deepEqual(state(run.f), state(control.f), 'state hash and full log equal');
  });
}

// #2298 A4/A4a/A4b: on the live clock a still world counts what it owes per frame and jumps once a second at most, so the
// tick's age (what /healthz, live.json, the load monitor and the launcher's stall test read) stays under a second and the
// tick service stays whole; an hour away is caught up in a few ordinary ticks, and an input after it is accepted at once.
test('#2298 A4a: a jumping world never reads as stalled, and an input right after a jump is accepted', { timeout: 120_000 }, async (t) => {
  const { STALL_MIN_MS } = await import('./load/monitor.ts');
  const dir = mkdtempSync(join(tmpdir(), 'jump-a4-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { f } = await godWorld(t, join(dir, 'world.db'), 0), h = f.host;
  const hour = 72_000, c0 = h.skipStats.ticksComputed;
  await h.catchUp(hour, turn);
  assert.ok(h.skipStats.ticksComputed - c0 < 200, `an hour away took ${h.skipStats.ticksComputed - c0} ordinary ticks`);
  const done: number[] = []; h.listeners.push({ afterTickComplete: () => { done.push(performance.now()); } });
  const t0 = performance.now(), tick0 = h.engine.world.tick, j0 = h.skipStats.ticksJumped;
  h.start(); await new Promise((r) => setTimeout(r, 2500));
  const e = await h.enqueue('rules', 'world', { why: 'test: an input after a jump' });
  assert.ok(Math.abs(e.tick - (tick0 + (performance.now() - t0) / 50)) <= 25, `the input landed at now (tick ${e.tick})`);
  await new Promise((r) => setTimeout(r, 1500)); h.stop();
  const wall = performance.now() - t0, ran = h.engine.world.tick - tick0;
  let gap = done[0] - t0; for (let i = 1; i < done.length; i++) gap = Math.max(gap, done[i] - done[i - 1]);
  t.diagnostic(JSON.stringify({ wallMs: Math.round(wall), ran, jumped: h.skipStats.ticksJumped - j0, completed: done.length, maxGapMs: Math.round(gap) }));
  assert.ok(gap < Math.min(STALL_MIN_MS, 1500), `the longest gap between completed ticks was ${Math.round(gap)} ms`);
  assert.ok(ran >= wall / 50 - 25, `the clock kept wall pace (${ran} ticks in ${Math.round(wall)} ms)`);
  assert.ok(h.skipStats.ticksJumped - j0 > ran * 0.8 && done.length < ran * 0.2, 'most of it was jumped');
});
