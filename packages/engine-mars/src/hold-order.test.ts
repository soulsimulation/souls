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
