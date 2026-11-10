// #1523: a live host's hold of a body with no whole pose searches the arrival for a free spot. It used to take the body out of
// world.entities for that search and put it back, which moved it to the end of the live table; the replay, given the logged
// pose, never searches and keeps the canonical order. The search now skips the body by id, so live and replay iterate alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, MarsEngine } from './engine.ts';

const f = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
function world() {
  const e = f.create(f.genesis('hold-order')) as MarsEngine;
  for (const [id, x] of [['a', 0], ['b', 6], ['c', 12]] as const) e.spawnHuman({ id, label: id.toUpperCase(), soul: `s_${id}`, at: [x, 0] } as any);
  e.step();
  return e;
}

test('#1523 a live hold that searches for a spot leaves world.entities in its order, the order its replay keeps', () => {
  const live = world(), replay = world(), keys = (e: MarsEngine) => Object.keys(e.world.entities);
  assert.deepEqual(keys(live), keys(replay), 'the same world');
  const before = keys(live);
  assert.notEqual(before.at(-1), 'a', 'the held body is not already last, so a re-insertion would show');
  for (const e of [live, replay]) (e.world.entities.a as any).pose.p = [NaN, 0, 0];   // no whole pose: the arrival branch
  const at = live.holdBodyV1('a');   // live: no pose given, so it searches
  assert.ok(at && at.p.every(Number.isFinite), JSON.stringify(at));
  assert.deepEqual(keys(live), before, 'the live table keeps its order');
  replay.holdBodyV1('a', at!);   // replay: the logged pose, no search
  assert.deepEqual(keys(live), keys(replay), 'live and replay iterate the table alike');
  assert.deepEqual((live.world.entities.a as any).pose.p, (replay.world.entities.a as any).pose.p, 'and stand the body at the same place');
  assert.equal(live.stateHash(), replay.stateHash());
  // the search still keeps clear of the other bodies, as before
  for (const id of ['b', 'c']) { const q = (live.world.entities[id] as any).pose.p; assert.ok(Math.hypot(q[0] - at!.p[0], q[2] - at!.p[2]) >= .8, `clear of ${id}`); }
});

// #1523 review: on a ground world the spatial sync reads every level-0 body's pose.p, and the held body now stays in the table
// during the search; a body with no pose, or with pose.p null, got the bare arrival point (on top of whoever stood there) when that
// read threw. It now gets a provisional pose first, and the search finds the same free spot as for any other broken pose.
import { groundFact } from './ground-bridge.ts';
import { emptyGround } from '../../ground/src/index.ts';
import { MEAL_WORLD } from './engine.ts';
const meal = await marsFactory({ ...MEAL_WORLD, sharedCarryV1: true, soulsRepairV1: true });
const await_meal = () => meal;
function groundWorld(seed: string) {
  const e = f.create(f.genesis(seed)) as MarsEngine;
  e.installGroundV1(groundFact(emptyGround(128), 1));
  for (const [id, x] of [['a', 6], ['b', 12], ['c', 18]] as const) e.spawnHuman({ id, label: id.toUpperCase(), soul: `s_${id}`, at: [x, 0] } as any);
  e.step();
  const [ax, az] = (e as any).cfg.arrival ?? [0, 0];
  assert.ok(e.relocateHumanV1('b', [ax, az]), 'b stands at the arrival');
  return { e, arrival: [ax, az] as [number, number] };
}
const reference = (() => { const { e } = groundWorld('hold-ground-ref'); (e.world.entities.a as any).pose.p = [NaN, 0, 0]; return e.holdBodyV1('a')!.p; })();   // the spot the search finds for a NaN position (as on base)
for (const [shape, brk] of [['NaN position', (a: any) => { a.pose.p = [NaN, 0, 0]; }], ['no pose', (a: any) => { delete a.pose; }], ['pose.p null', (a: any) => { a.pose.p = null; }]] as const) {
  test(`#1523 on a ground world a body held with ${shape} gets a free spot clear of the body at the arrival, and its replay agrees`, () => {
    const { e: live } = groundWorld('hold-ground-ref'), { e: replay } = groundWorld('hold-ground-ref'), keys = (e: MarsEngine) => Object.keys(e.world.entities);
    const b = (live.world.entities.b as any).pose.p, before = keys(live);
    for (const e of [live, replay]) brk(e.world.entities.a);
    const search = (live as any).freeStandingNearV1.bind(live), calls: string[] = [];
    (live as any).freeStandingNearV1 = (...args: unknown[]) => { try { const r = search(...args); calls.push('found'); return r; } catch (err) { calls.push(`threw ${String(err).slice(0, 60)}`); throw err; } };
    const at = live.holdBodyV1('a');
    assert.deepEqual(calls, ['found'], 'the search ran to its end (before the fix the spatial sync threw on the broken pose and the hold fell back to the bare arrival point)');
    assert.ok(at && at.p.every(Number.isFinite), JSON.stringify(at));
    assert.ok(Math.hypot(at!.p[0] - b[0], at!.p[2] - b[2]) >= .8, `clear of b at the arrival: ${JSON.stringify(at)} vs ${JSON.stringify(b)}`);
    assert.deepEqual(at!.p, reference, 'the same spot the search finds for any broken pose: the search ran, it did not fall back to the arrival point');
    assert.deepEqual(keys(live), before, 'the live table keeps its order');
    replay.holdBodyV1('a', at!);
    assert.deepEqual((live.world.entities.a as any).pose.p, (replay.world.entities.a as any).pose.p);
    assert.equal(live.stateHash(), replay.stateHash());
  });
}

// #1523 review: #1509's nonfinite-hold/1 eject searched with the component taken out of the table and put back at the end; the
// live host plans it and the replay applies the logged patch without searching, so the restore now re-sorts the table.
test('#1523 a nonfinite-hold/1 eject to the arrival leaves world.entities in its canonical order', () => {
  const m = await_meal(), e = m.create(m.genesis('nonfinite-order')) as MarsEngine;
  e.step();
  const ids = Object.keys(e.world.entities), comp = ids.find((id) => (e.world.entities[id] as any).kind === 'component' && ['ground', 'resting-on'].includes((e.world.entities[id] as any).support?.kind) && id !== ids.at(-1));
  assert.ok(comp, 'a free component that is not already last');
  (e.world.entities[comp!] as any).pose.p[1] = NaN;
  const plan = e.planNonFiniteV1!(null);
  assert.ok(plan.some((p: any) => p.from === 'arrival' && p.path[1] === comp), JSON.stringify(plan).slice(0, 300));
  assert.deepEqual(Object.keys(e.world.entities), ids, 'the table keeps its order through the search');
});
