// #2294 held-activity/1: an activity in place is held from a start tick to an end tick, writes nothing in between, and a
// world whose bodies all stand or hold is still until the earliest end.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,GREEN_FIELD_WORLD,MarsEngine,heldActionsV1} from './engine.ts';
import {provingGround} from '../../../mars/viewer/engine/scenes/proving-ground.ts';
import {emptyWorld, human, addAll, FIXTURE} from '../../../mars/viewer/engine/world/factory.ts';
import {Spatial} from '../../../mars/viewer/engine/spatial/service.ts';
import {DEFAULT_INVARIANTS} from '../../../mars/viewer/engine/runtime/invariants.ts';
import {Runtime} from '../../../mars/viewer/engine/runtime/runtime.ts';
import {createRegistry, servicesFor, ENGINE_INVARIANTS} from '../../../mars/viewer/engine/api/registry.ts';
import {groundSleepFixture} from '../../../mars/viewer/engine/scenarios/sleep.ts';
import {readSleep, sleepHoldHeldV1, sleepPurposeHeldV1} from '../../../mars/viewer/engine/activities/sleep.ts';

async function world(held: boolean) {
  const f = await marsFactory(GREEN_FIELD_WORLD), e = f.create(f.genesis('held')) as MarsEngine;
  if (held) e.configureRuntimePolicy({sleepBlockTicks: 1200, heldActivitiesV1: true});
  e.spawnHuman({id: 'h', label: 'Reader', soul: 's'});
  for (let i = 0; i < 3; i++) e.step();
  return {f, e};
}
const read = (e: MarsEngine, seconds: number) => { const r = e.perform({actor: 'h', label: 'read', steps: [{verb: 'mars:pose_v1', params: {activity: 'read', prop: 'book', seconds}}]}); assert.ok(r.ok, JSON.stringify(r)); return r; };
const body = (e: MarsEngine) => JSON.stringify(e.world.entities.h);
const execs = (e: MarsEngine) => JSON.stringify((e as any).rt.activeIds().map((id: string) => (e as any).rt.execOf(id)));

test('a held read: one start and one end tick, nothing written between them, the world still until the end', async () => {
  const {e} = await world(true);
  assert.deepEqual(e.stillnessV1(), {still: true, untilTick: null}, 'a standing body alone: still, nothing due');
  read(e, 10);
  e.step(); e.step();
  const s = e.stillnessV1();
  assert.equal(s.still, true, 'reading is held');
  assert.equal(typeof s.untilTick, 'number');
  assert.equal(e.world.entities.h.human?.activity, 'read');
  const b = body(e), x = execs(e), hash = (e as any).stateHashInputs('').held;
  while (e.world.tick < s.untilTick! - 1) e.step();
  assert.equal(body(e), b, 'the body is not written while the read is held');
  assert.equal(execs(e), x, 'the pose keeps no running sum');
  assert.deepEqual((e as any).stateHashInputs('').held, hash, 'the end tick is in the state hash, unchanged');
  e.step();
  assert.equal(e.world.tick, s.untilTick);
  assert.equal(e.world.entities.h.human?.activity, 'idle', 'stood up by itself at its end tick');
  assert.deepEqual(e.stillnessV1(), {still: true, untilTick: null});
});

test('a walk under way is never still; without the policy no world is still and a pose adds up its time as before', async () => {
  const {e} = await world(true);
  const p = e.world.entities.h.pose.p;
  assert.ok(e.perform({actor: 'h', label: 'walk', steps: [{verb: 'walk_to', params: {to: [p[0] + 4, p[2]]}}]}).ok);
  for (let i = 0; i < 5; i++) { e.step(); assert.equal(e.stillnessV1().still, false, 'walking'); }
  const old = await world(false);
  read(old.e, 2); old.e.step(); old.e.step();
  assert.deepEqual(old.e.stillnessV1(), {still: false, untilTick: null});
  assert.equal('held' in (old.e as any).stateHashInputs(''), false, 'the hash of a world without the policy is unchanged');
  const ex = (old.e as any).rt.execOf((old.e as any).rt.activeIds()[0]);
  assert.ok(ex.t > 0 && ex.heldEnd === undefined, 'the historical running sum');
});

test('a programme rest waits to a known tick', async () => {
  const {e} = await world(true);
  assert.ok(e.perform({actor: 'h', label: 'rest', steps: [{verb: 'rest', params: {seconds: 30}}]}).ok);
  e.step(); e.step();
  const s = e.stillnessV1();
  assert.equal(s.still, true); assert.ok(s.untilTick! > e.world.tick && s.untilTick! <= e.world.tick + 30 * 20);
});

test('a world stopped halfway through a held read and restored from its snapshot ends it on the same tick, with equal hashes', async () => {
  const {f, e} = await world(true);
  read(e, 60); e.step(); e.step();
  const end = e.stillnessV1().untilTick!;
  while (e.world.tick < end - 600) e.step();
  const copy = f.restore(e.snapshot()) as MarsEngine;
  assert.equal(copy.stillnessV1().untilTick, end, 'the end tick survives the snapshot');
  while (e.world.tick < end) { e.step(); copy.step(); }
  assert.equal(copy.world.entities.h.human?.activity, 'idle');
  assert.equal(copy.stateHash(), e.stateHash());
});

test('a mat sleep is held from the tick it falls asleep to a known end; its elapsed time is read from the ticks', () => {
  const run = (held: boolean) => {
    const fixture = groundSleepFixture([0, 0], 0), rt = new Runtime(fixture.world, createRegistry(), servicesFor({'ground-sleep': fixture.scene})(fixture.world), ENGINE_INVARIANTS);
    if (held) rt.services.heldActivitiesV1 = true;
    const rec = rt.submit('sleep', {...fixture.p, duration: 20}, {preempt: false}), holds = () => Object.values((rt.services.sleeps as {holds: Record<string, {phase: string}>}).holds);
    for (let n = 0; n < 2000 && !holds().some((h) => h.phase === 'sleeping'); n++) rt.step();
    const hold = holds().find((h) => h.phase === 'sleeping')!, end = sleepHoldHeldV1(hold), at = rt.tick;
    assert.equal(sleepPurposeHeldV1(rt, rt.execOf(rec.id)), false, 'the purpose follows its mat sleep a tick later');
    rt.step(); const whole = sleepPurposeHeldV1(rt, rt.execOf(rec.id)), before = JSON.stringify(hold);
    for (let n = 0; n < 99; n++) rt.step();
    const elapsed = readSleep(rt, rec.id)!.elapsed;
    if (held) assert.equal(JSON.stringify(hold), before, 'nothing of the sleep is written while it is held');
    for (let n = 0; n < 2000 && hold.phase === 'sleeping'; n++) rt.step();
    return {end, whole, at, woke: rt.tick, elapsed};
  };
  const legacy = run(false), held = run(true);
  assert.equal(legacy.end, false, 'without the policy a sleep is not held');
  assert.equal(held.end, held.at + 400, 'held for exactly its 20 s');
  assert.equal(held.whole, held.end, 'the sleep purpose is held to the same tick');
  assert.equal(held.woke, held.end); assert.equal(held.woke, legacy.woke, 'it wakes on the tick it always did');
  assert.ok(Math.abs(held.elapsed - legacy.elapsed) < 1e-9 && held.elapsed > 4.9, 'readSleep reports the same elapsed time');
});

// review of #2315: held only in a steady state. From any tick at which every live action reads as held (the world still,
// for these actions), one more step changes no body and no record, unless a held end falls on that tick.
function steadyAfterStill(rt: Runtime, ticks: number, act: (tick: number) => void) {
  const view = () => JSON.stringify([Object.values(rt.world.entities).filter((e) => e.kind === 'human').map((e) => [e.id, e.pose, e.human]),
    [...rt.records.values()].map((r) => [r.id, r.status, r.phase])]);
  let stills = 0;
  for (let n = 0; n < ticks; n++) {
    act(rt.tick);
    const held = heldActionsV1(rt), still = held.length > 0 && held.every(([, end]) => end !== false), ends = held.map(([, end]) => end).filter((e): e is number => typeof e === 'number');
    const before = view(); rt.step();
    if (still && !ends.includes(rt.tick)) { stills++; assert.equal(view(), before, `held at tick ${rt.tick - 1}, yet the next step changed something`); }
  }
  return stills;
}
test('from every tick that reads still, one more step changes nothing: pose, mat sleep, a circle whose members all leave', () => {
  const base = provingGround(), w = addAll(emptyWorld('proving-ground', base), { id: 'fire', def: 'campfire', kind: 'fixture', pose: { p: [-5, 0, 4], yaw: 0 }, provenance: FIXTURE, phase: 'installed', support: { kind: 'ground' } } as any, human('f0', -9.5, -1), human('f1', -8.5, -1));
  const rt = new Runtime(w, createRegistry(), { spatial: new Spatial(base), heldActivitiesV1: true }, DEFAULT_INVARIANTS);
  let circle: string | undefined, stood = false;
  const stills = steadyAfterStill(rt, 1500, (tick) => {
    if (tick === 1) circle = rt.submit('campfire_circle', { actors: ['f0', 'f1'], fire: 'fire' }).id;
    const kids = [...rt.records.values()].filter((r) => r.parent === circle && rt.isActive(r.id));
    if (!stood && circle && rt.records.get(circle)?.phase === 'gathered' && tick > 400) { stood = true; for (const k of kids) rt.cancel(k.id); }
  });
  assert.ok(stood && stills > 100, 'the circle was held a while: ' + stills);
  assert.equal(rt.records.get(circle!)?.status, 'completed', 'with every member gone it completed, and was never read as held meanwhile');
  const fx = groundSleepFixture([0, 0], 0), sr = new Runtime(fx.world, createRegistry(), servicesFor({'ground-sleep': fx.scene})(fx.world), ENGINE_INVARIANTS);
  sr.services.heldActivitiesV1 = true;
  assert.ok(steadyAfterStill(sr, 1200, (tick) => { if (tick === 0) sr.submit('sleep', {...fx.p, duration: 20}, {preempt: false}); }) > 300, 'the mat sleep was held');
});

test('a pose reads as held only once it is posing, not on the tick its programme starts it', async () => {
  const {e} = await world(true);
  read(e, 10);
  let first: number | null = null;
  for (let n = 0; n < 220; n++) {
    const s = e.stillnessV1(), body = JSON.stringify(e.world.entities.h); e.step();
    if (s.still && s.untilTick !== e.world.tick && s.untilTick !== null) { first ??= e.world.tick; assert.equal(JSON.stringify(e.world.entities.h), body, 'still, yet the body changed'); }
  }
  assert.ok(first !== null);
});
