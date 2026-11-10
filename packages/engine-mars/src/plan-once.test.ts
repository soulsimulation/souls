// #1770 plan-once: an act's route searches are kept per navigation epoch (Spatial.routeMemo), so the admission check, the
// tick's perform and the walk's start search a leg once. Reuse is exact: every test here runs the oracle (each reuse is
// compared with a fresh search), and a change between admission and perform (an edit, another body) is planned afresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetFromDef, assetIdFor, type DefFacts } from './catalog-adapter.ts';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import type { Spatial } from '../../../mars/viewer/engine/spatial/service.ts';

const factory = await marsFactory(GREEN_FIELD_WORLD);
const memoOf = (e: MarsEngine) => {
  const sp = (e as unknown as { rt: { services: { spatial: Spatial } } }).rt.services.spatial, m = sp.routeMemo;
  assert.ok(m, 'the server engine keeps routes (SIM_PLAN_ONCE is not 0)');
  m.oracle = true;
  return { sp, m };
};
const done = (e: MarsEngine, actor: string, activity: string) => { for (let i = 0; i < 3000 && e.world.entities[actor].human?.activity !== activity; i++) e.step(); };

const bench: DefFacts = { ref: 'plan-once-bench@1', hash: 'c'.repeat(64), name: 'plan-once-bench', tags: [], layer: 'solid',
  components: { seat: { height: 0.45 } }, box: [2.4, 0.45, 0.45],
  slots: [{ id: 'left', kind: 'seat', p: [-0.6, 0.45, 0], yaw: 0 }, { id: 'right', kind: 'seat', p: [0.6, 0.45, 0], yaw: 0 }] };
const chair: DefFacts = { ref: 'plan-once-chair@1', hash: 'd'.repeat(64), name: 'plan-once-chair', tags: [], layer: 'solid',
  components: { seat: { height: 0.45 } }, box: [0.6, 0.45, 0.6], slots: [{ id: 'seat', kind: 'seat', p: [0, 0.45, 0], yaw: 0 }] };

/** A world with a two-seat bench and a one-seat chair a few metres from the arrival, and two bodies. */
function world(name: string) {
  const e = factory.create(factory.genesis(name)) as unknown as MarsEngine;
  e.spawnHuman({ id: 'h_once00001', label: 'Ada', soul: 's_once00001' });
  e.spawnHuman({ id: 'h_once00002', label: 'Bo', soul: 's_once00002' });
  const at = e.world.entities.h_once00001.pose.p, c: [number, number] = [at[0] + 3, at[2] - 2];
  const b = assetIdFor(bench, '{}'), ch = assetIdFor(chair, '{}');
  const edit: WorldEditV1 = { contract: 'world-edit/1', seq: 1, hash: '', levels: [], assets: { [b]: assetFromDef(b, bench), [ch]: assetFromDef(ch, chair) }, set: {
    bench: { fixture: { def: b, kind: 'fixture', label: 'bench', p: [c[0], 0, c[1]], yaw: 0 } },
    chair: { fixture: { def: ch, kind: 'fixture', label: 'chair', p: [c[0] - 3, 0, c[1] - 3], yaw: 0 } },
  } } as unknown as WorldEditV1;
  edit.hash = nextEntityPhysics(undefined, edit).hash;
  e.applyWorldEditV1(edit);
  return { e, c, edit };
}
const sit = (actor: string, on: string) => ({ actor, label: `sit on the ${on}`, steps: [{ verb: 'sit', params: { on, seconds: 1 } }] });

test('one route search per leg: a second admission check and the perform reuse the first check\'s searches', () => {
  const { e } = world('once-reuse'), { m } = memoOf(e), p = sit('h_once00001', 'bench');
  assert.equal(e.canPerform(p), null);
  const searched = m.misses;
  assert.ok(searched > 0, 'the first check searched');
  assert.equal(e.canPerform(p), null);
  assert.equal(m.misses, searched, 'the same check again searches nothing');
  assert.equal(e.perform(p).ok, true);
  assert.ok(m.hits > 0, 'perform reused the kept searches');
  done(e, 'h_once00001', 'sit');
  assert.equal(e.world.entities.h_once00001.human?.activity, 'sit');
  assert.equal(m.oracleMisses, 0, 'every reuse equals a fresh search');
  assert.deepEqual((e as unknown as { rt: { violations: unknown[] } }).rt.violations, []);
});

test('a god edit between admission and perform moves the epoch: the kept routes are dropped and the seat is planned afresh', () => {
  const { e, c, edit } = world('once-edit'), { sp, m } = memoOf(e), p = sit('h_once00001', 'bench');
  assert.equal(e.canPerform(p), null);
  assert.ok(m.map.size > 0);
  const epoch = sp.epoch;
  // wall the nearer (left) seat in on all four sides
  const wall = (k: string, x: number, z: number, hx: number, hz: number) => ({ id: k, obb: { c: [c[0] + x, c[1] + z], half: [hx, hz], yaw: 0 }, y0: 0, y1: 2, kind: 'fixture' });
  const pen: WorldEditV1 = { contract: 'world-edit/1', seq: 2, hash: '', levels: [], assets: {}, set: {
    pen: { solids: [wall('pen-front', -0.75, 0.55, 0.65, 0.05), wall('pen-back', -0.75, -0.55, 0.65, 0.05), wall('pen-left', -1.45, 0, 0.05, 0.6), wall('pen-right', -0.05, 0, 0.05, 0.6)] },
  } } as unknown as WorldEditV1;
  pen.hash = nextEntityPhysics({ hash: edit.hash } as never, pen).hash;
  e.applyWorldEditV1(pen);
  assert.equal(e.perform(p).ok, true);
  assert.notEqual(sp.epoch, epoch, 'the edit moved the navigation epoch');
  assert.equal(m.epoch, sp.epoch, 'the memo follows the epoch');
  done(e, 'h_once00001', 'sit');
  const x = e.world.entities.h_once00001.pose.p[0] - c[0];
  assert.ok(x > 0.3, `she sits on the right seat, the left one walled in since her admission (x ${x.toFixed(2)})`);
  assert.equal(m.oracleMisses, 0);
  assert.deepEqual((e as unknown as { rt: { violations: unknown[] } }).rt.violations, []);
});

test('another body takes the one seat between admission and perform: the perform is refused with the seat\'s reason', () => {
  const { e } = world('once-taken'), { m } = memoOf(e), mine = sit('h_once00001', 'chair');
  assert.equal(e.canPerform(mine), null, 'admitted while the chair is free');
  assert.equal(e.perform(sit('h_once00002', 'chair')).ok, true);
  done(e, 'h_once00002', 'sit');
  assert.equal(e.world.entities.h_once00002.human?.activity, 'sit');
  const r = e.perform(mine);
  assert.equal(r.ok, false, 'never walked to a taken seat on a kept plan');
  assert.match(String(r.diagnostic?.code), /^(slot|seat|reservation)\./);
  assert.equal(m.oracleMisses, 0);
  assert.deepEqual((e as unknown as { rt: { violations: unknown[] } }).rt.violations, []);
});

test('the memo is bounded, least recently used first out; a search with a predicate option is never kept', () => {
  const { e } = world('once-bound'), { sp, m } = memoOf(e), w = e.world as never, from = e.world.entities.h_once00001.pose.p;
  sp.enableRouteMemo(2, true);
  const m2 = sp.routeMemo!, profile = { id: 'human', radius: 0.28, height: 1.8, speed: 1.35, turnRate: 4, stepHeight: 0.22 };
  const go = (dx: number, opts?: object) => sp.route(w, profile, { level: 0, p: [from[0], from[2]] }, { level: 0, p: [from[0] + dx, from[2] + 6] }, opts as never);
  go(2); go(3); go(2); go(4);   // 3 is the least recently used when 4 comes in
  assert.equal(m2.map.size, 2);
  const before = m2.misses; go(2); assert.equal(m2.misses, before, '2 is kept'); go(3); assert.equal(m2.misses, before + 1, '3 was dropped');
  const size = m2.map.size, misses = m2.misses;
  go(5, { nameObstacles: () => false });
  assert.equal(m2.map.size, size, 'a predicate option is not kept');
  assert.equal(m2.misses, misses, 'and is not counted as a kept search');
  assert.equal(m2.oracleMisses, 0);
  void m;
});
