// #1770 plan-once: an act's route searches are kept per navigation epoch (Spatial.routeMemo), so the admission check, the
// tick's perform and the walk's start search a leg once. Reuse is exact: every test here runs the oracle (each reuse is
// compared with a fresh search), and a change between admission and perform (an edit, another body) is planned afresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetFromDef, assetIdFor, type DefFacts } from './catalog-adapter.ts';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import type { Spatial } from '../../../mars/viewer/engine/spatial/service.ts';
import { groundFact } from './ground-bridge.ts';
import { emptyGround } from '../../ground/src/index.ts';

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
const HUMAN = { id: 'human', radius: 0.28, height: 1.8, speed: 1.35, turnRate: 4, stepHeight: 0.22 };
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
  const epoch = sp.epoch, from = e.world.entities.h_once00001.pose.p;
  // a walk to open ground the same edit covers with a block: kept before the edit, never answered from the kept result after it
  const g: [number, number] = [from[0] - 4, from[2] + 4];
  const into = () => sp.route(e.world as never, HUMAN, { level: 0, p: [from[0], from[2]] }, { level: 0, p: g });
  assert.equal(into().ok, true, 'before the edit that ground is reachable');
  assert.equal(into().ok, true); assert.ok(m.hits > 0, 'and the second search is the kept one');
  // wall the nearer (left) seat in on all four sides
  const wall = (k: string, x: number, z: number, hx: number, hz: number) => ({ id: k, obb: { c: [c[0] + x, c[1] + z], half: [hx, hz], yaw: 0 }, y0: 0, y1: 2, kind: 'fixture' });
  const pen: WorldEditV1 = { contract: 'world-edit/1', seq: 2, hash: '', levels: [], assets: {}, set: {
    pen: { solids: [wall('pen-front', -0.75, 0.55, 0.65, 0.05), wall('pen-back', -0.75, -0.55, 0.65, 0.05), wall('pen-left', -1.45, 0, 0.05, 0.6), wall('pen-right', -0.05, 0, 0.05, 0.6)] },
    block: { solids: [{ id: 'block', obb: { c: g, half: [1, 1], yaw: 0 }, y0: 0, y1: 2, kind: 'fixture' }] },
  } } as unknown as WorldEditV1;
  pen.hash = nextEntityPhysics({ hash: edit.hash } as never, pen).hash;
  e.applyWorldEditV1(pen);
  const misses = m.misses, after = into();
  assert.equal(after.ok, false, `after the edit the covered ground is refused, not walked on the kept route (${JSON.stringify(after).slice(0, 160)})`);
  assert.equal(m.misses, misses + 1, 'searched afresh');
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

// Ground worlds (the server's entity worlds): a route is still a function of the epoch and its inputs while ground windows
// move with a walker (paged) or grow (one window). The oracle checks every reuse while a body walks 260 m.
for (const paged of [false, true]) test(`${paged ? 'paged ground' : 'ground'}: kept routes equal fresh ones while the windows follow a long walk`, () => {
  const g = emptyGround(2000);
  g.extent = [-200, -1000, 1800, 1000];
  g.landforms.push({ id: 'pond', kind: 'carve', area: [[60, 20], [90, 20], [90, 50], [60, 50]], bed: -1.5, edge: 2 });
  g.waters.push({ id: 'pond', area: [[60, 20], [90, 20], [90, 50], [60, 50]], level: 0 });
  const e = factory.create(factory.genesis(`once-ground-${paged}`)) as unknown as MarsEngine & { installGroundV1(f: unknown): unknown };
  e.installGroundV1(groundFact(g, 1, { paged }));
  e.spawnHuman({ id: 'h_onceg0001', label: 'Walker', soul: 's_onceg0001' });
  const { sp, m } = memoOf(e), b = e.world.entities.h_onceg0001, from = [...b.pose.p];
  const P: [number, number] = [from[0] + 5, from[2]], G: [number, number] = [from[0] + 140, from[2] + 60];
  const fixed = () => sp.route(e.world as never, HUMAN, { level: 0, p: P }, { level: 0, p: G });
  const first = fixed(); assert.equal(first.ok, true, JSON.stringify(first).slice(0, 200));
  const adm = e.perform({ actor: 'h_onceg0001', label: 'walk', steps: [{ verb: 'walk_to', params: { to: [from[0] + 260, from[2]] } }] });
  assert.equal(adm.ok, true, JSON.stringify(adm));
  let end;
  for (let n = 0; n < 20 * 400 && !end; n++) {
    end = (e.step().programs as { id: string; kind: string }[]).find((p) => p.id === adm.id && ['completed', 'failed', 'cancelled'].includes(p.kind));
    if (n % 100 === 0) { assert.equal(fixed().ok, true); e.canPerform({ actor: 'h_onceg0001', label: 'to G', steps: [{ verb: 'walk_to', params: { to: G } }] }); }
  }
  assert.equal(end?.kind, 'completed', JSON.stringify(end));
  assert.ok(m.hits > 5, `kept routes were reused (${m.hits} hits, ${m.misses} searches)`);
  assert.equal(m.oracleMisses, 0, 'every reuse equals a fresh search');
  assert.deepEqual((e as unknown as { rt: { violations: unknown[] } }).rt.violations, []);
});
