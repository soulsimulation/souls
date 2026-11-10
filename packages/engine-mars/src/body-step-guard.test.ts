// #1332: one step guard for every body step. The walker's hard static layer, an action-owned step (staticStepClear) and,
// under the logged rule body-step-guard/1, every placement the engine writes (relocation, restore, stall release) read what
// `collision.human-static` reads, so none of them writes a pose the invariant would reject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import { groundFact } from './ground-bridge.ts';
import { emptyGround } from '../../ground/src/index.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import { guardBodyStep, staticStepClear, bodyStandsClear } from '../../../mars/viewer/engine/runtime/static-step.ts';
import { clearanceAt } from '../../../mars/viewer/engine/spatial/grid.ts';
import type { Spatial } from '../../../mars/viewer/engine/spatial/service.ts';
import type { Obstacle } from '../../../mars/viewer/engine/spatial/types.ts';

const factory = await marsFactory(GREEN_FIELD_WORLD);
type Prog = { id: string; kind: string; code?: string; message?: string };
const FLOATER = { family: 'floater', model: 'verdelis', radius: .35, hoverHeight: 1.45 };

function world(seed: string): MarsEngine {
  const e = factory.create(factory.genesis(seed)) as MarsEngine;
  e.installGroundV1(groundFact(emptyGround(256), 1, { paged: true }));
  return e;
}
let seq = 0;
function build(e: MarsEngine, set: WorldEditV1['set']) {
  const ev: WorldEditV1 = { contract: 'world-edit/1', seq: ++seq, hash: '', levels: [], set };
  ev.hash = nextEntityPhysics((e.world as { entityPhysicsV1?: Parameters<typeof nextEntityPhysics>[0] }).entityPhysicsV1, ev).hash;
  e.applyWorldEditV1(ev);
}
const wall = (id: string, c: [number, number], half: [number, number]): Obstacle => ({ id, kind: 'wall', obb: { c, half, yaw: 0 }, y0: 0, y1: 3, raster: 'centre' });
const rt = (e: MarsEngine) => (e as unknown as { rt: Parameters<typeof guardBodyStep>[0] }).rt;
const clearance = (e: MarsEngine, p: [number, number]) => { const sp = rt(e).services.spatial as Spatial; sp.sync(rt(e).world); return clearanceAt(sp.levelAt(0, p)!, p); };
const statics = (e: MarsEngine) => (e.runtime.violations as { code: string }[]).filter(v => v.code === 'collision.human-static');

test('guardBodyStep holds a step into a wall and names it, lets a squeezed body step out, and is what staticStepClear answers', () => {
  const e = world('guard-unit');
  e.spawnHuman({ id: 'h', label: 'Ada', soul: 's_h' });
  const b = e.world.entities.h, [x, , z] = b.pose.p;
  build(e, { e_wall: { solids: [wall('e_wall', [x + 1, z], [.2, 3])] } });
  const into = guardBodyStep(rt(e), b, [x + .45, z], [x + .7, z]);
  assert.equal(into.held, true); assert.deepEqual(into.to, [x + .45, z]); assert.equal(into.blocker, 'e_wall');
  const out = guardBodyStep(rt(e), b, [x + .78, z], [x + .68, z]);
  assert.equal(out.held, false, 'a body already inside the radius may step to where it is less squeezed');
  const along = guardBodyStep(rt(e), b, [x, z], [x, z + .07]);
  assert.equal(along.held, false);
  b.pose.p = [x + .45, b.pose.p[1], z];
  assert.equal(staticStepClear(rt(e), b, [x + .7, z]), false);
  assert.equal(staticStepClear(rt(e), b, [x + .4, z]), true);
  assert.equal(bodyStandsClear(rt(e), b, [x + .7, z], 0), false);
  assert.equal(bodyStandsClear(rt(e), b, [x, z], 0), true);
});

test('a wall built across a walk 0.6 m ahead of the walker: it never steps inside the invariant\'s limit, walks round, and the invariant never fires', () => {
  const e = world('guard-walk');
  e.spawnHuman({ id: 'h', label: 'Ada', soul: 's_h' });
  const b = e.world.entities.h, [x, , z] = b.pose.p;
  const adm = e.perform({ actor: 'h', label: 'walk', steps: [{ verb: 'walk_to', params: { to: [x + 16, z] } }] });
  assert.ok(adm.ok, JSON.stringify(adm));
  let end: Prog | undefined, built = false, minGap = Infinity;
  for (let n = 0; n < 20 * 120 && !end; n++) {
    const out = e.step() as { programs: Prog[] };
    end = out.programs.find(p => p.id === adm.id && ['completed', 'failed', 'cancelled'].includes(p.kind));
    // once it is under way, a wall 0.6 m ahead of it, 10 m long across the way
    if (!built && b.pose.p[0] > x + 2) { build(e, { e_wall: { solids: [wall('e_wall', [b.pose.p[0] + .62, z], [.15, 5])] } }); built = true; }
    if (built) minGap = Math.min(minGap, clearance(e, [b.pose.p[0], b.pose.p[2]]));
  }
  assert.ok(built);
  assert.equal(end?.kind, 'completed', JSON.stringify(end));
  assert.deepEqual(statics(e), [], 'no collision.human-static in the run');
  assert.ok(minGap >= .28 - .03, `the body never stood inside the invariant's limit (min clearance ${minGap.toFixed(3)})`);
  assert.ok(Math.abs(b.pose.p[0] - (x + 16)) < .6, `arrived round the wall: ${b.pose.p}`);
});

/** A spot by a wall whose clearance the old 0.28 m ring check accepts and a 0.35 m floater's invariant does not (0.28 to 0.32). */
function squeeze(e: MarsEngine, z = 0): [number, number] {
  build(e, { e_wall: { solids: [wall('e_wall', [20, z], [.2, 3])] } });
  // the raster's clearance is a distance between 0.1 m cells: off a wall's corner it takes values in between (0.283 = 0.1 x sqrt 8)
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { const p: [number, number] = [+(20.2 + i * .05).toFixed(3), +(z + 3 + j * .05).toFixed(3)]; const c = clearance(e, p); if (c >= .28 && c < .315) return p; }
  throw new Error('no squeeze spot');
}
for (const guarded of [false, true]) test(`relocating a 0.35 m floater to a spot the 0.28 m check accepts: ${guarded ? 'body-step-guard/1 stands it clear' : 'the old rule writes a pose the invariant rejects'}`, () => {
  const e = world(`guard-relocate-${guarded}`);
  if (guarded) e.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true } as never);
  e.spawnHuman({ id: 'h', label: 'Ada', soul: 's_h' });
  (e.world.entities.h as { body?: unknown }).body = FLOATER;
  const to = squeeze(e);
  assert.equal(e.relocateHumanV1('h', to), true);
  const p = e.world.entities.h.pose.p;
  e.step();
  if (guarded) {
    assert.deepEqual(statics(e), []);
    assert.ok(clearance(e, [p[0], p[2]]) >= .35 - .03, `stood clear: ${p}`);
  } else {
    assert.deepEqual([p[0], p[2]], to, 'the old ring search took the squeezed spot');
    assert.equal(statics(e).length, 1, 'and the invariant rejects it');
  }
});

test('body-step-guard/1: a restore keeps a floater clear and apart, the rule is in the state hash only when on, and a snapshot keeps it', () => {
  const off = world('guard-hash'), on = world('guard-hash');
  assert.equal(on.stateHash(), off.stateHash());
  on.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true } as never);
  off.configureRuntimePolicy({ sleepBlockTicks: 1200 } as never);
  assert.notEqual(on.stateHash(), off.stateHash(), 'the rule shows in the hash');
  on.spawnHuman({ id: 'h', label: 'Ada', soul: 's_h' }); on.spawnHuman({ id: 'g', label: 'Bo', soul: 's_g' });
  (on.world.entities.h as { body?: unknown }).body = FLOATER; (on.world.entities.g as { body?: unknown }).body = FLOATER;
  const to = squeeze(on, 6);
  const restored = factory.restore(on.snapshot()) as MarsEngine;
  assert.equal(restored.stateHash(), on.stateHash());
  for (const e of [on, restored]) {
    assert.equal(e.restoreHumanPoseV1('h', { p: [to[0], 0, to[1]], level: 0 }, .28), true, 'a caller passing the old radius');
    const p = e.world.entities.h.pose.p;
    assert.ok(clearance(e, [p[0], p[2]]) >= .32, `restored clear of the wall: ${p}`);
    // the second body is restored next to the first: kept apart by both radii
    assert.equal(e.restoreHumanPoseV1('g', { p: [p[0], 0, p[2]], level: 0 }, .28), true);
    const q = e.world.entities.g.pose.p;
    assert.ok(Math.hypot(q[0] - p[0], q[2] - p[2]) >= .7 - 1e-9, `apart: ${p} ${q}`);
    e.step();
    assert.deepEqual((e.runtime.violations as { code: string }[]).filter(v => v.code.startsWith('collision.')), []);
  }
  assert.equal(restored.stateHash(), on.stateHash());
});

const BIG = { family: 'floater', model: 'verdelis', radius: .45, hoverHeight: 1.45 };
for (const guarded of [false, true]) test(`relocating beside a body when both radii exceed the old 0.8 m gap: ${guarded ? 'body-step-guard/1 keeps them apart' : 'the old rule writes an overlap'}`, () => {
  const e = world(`guard-apart-${guarded}`);
  if (guarded) e.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true } as never);
  e.spawnHuman({ id: 'h', label: 'Ada', soul: 's_h' }); e.spawnHuman({ id: 'g', label: 'Bo', soul: 's_g' });
  (e.world.entities.h as { body?: unknown }).body = BIG; (e.world.entities.g as { body?: unknown }).body = BIG;
  const to: [number, number] = [30, 10], gp = e.world.entities.g.pose.p;
  e.world.entities.g.pose.p = [to[0] + .81, gp[1], to[1]];
  e.step();
  assert.equal(e.relocateHumanV1('h', to), true);
  const p = e.world.entities.h.pose.p, q = e.world.entities.g.pose.p;
  e.step();
  const overlaps = (e.runtime.violations as { code: string }[]).filter(v => v.code === 'collision.human-human');
  if (guarded) { assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) >= .9 - 1e-9, `apart: ${p} ${q}`); assert.deepEqual(overlaps, []); }
  else { assert.deepEqual([p[0], p[2]], to); assert.equal(overlaps.length, 1); }
});

test('body-step-guard/1: a stall release stands a held floater only where the invariant passes it and apart from others', () => {
  const e = world('guard-stall');
  e.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true } as never);
  e.spawnHuman({ id: 'h', label: 'Ada', soul: 's_h' }); e.spawnHuman({ id: 'g', label: 'Bo', soul: 's_g' });
  (e.world.entities.h as { body?: unknown }).body = BIG; (e.world.entities.g as { body?: unknown }).body = BIG;
  const at = squeeze(e, 12), hp = e.world.entities.h.pose.p;
  e.world.entities.h.pose.p = [at[0], hp[1], at[1]];
  e.world.entities.g.pose.p = [at[0] - .95, hp[1], at[1] + .2];
  const adm = e.perform({ actor: 'h', label: 'walk', steps: [{ verb: 'walk_to', params: { to: [at[0] - 20, at[1]] } }] });
  assert.ok(adm.ok, JSON.stringify(adm));
  e.step();
  const r = e.stallReleaseV1('h', { code: 'stall.test', message: 'released by the test' });
  assert.ok(r, 'released');
  const p = e.world.entities.h.pose.p, q = e.world.entities.g.pose.p;
  assert.ok(clearance(e, [p[0], p[2]]) >= .45 - .03, `clear of the wall: ${p}`);
  assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) >= .9 - 1e-9, `apart: ${p} ${q}`);
  // (the body was put in the squeeze by hand, so the ticks before the release record it there; none after)
  const seen = e.runtime.violations.length;
  e.step();
  assert.deepEqual((e.runtime.violations as { code: string }[]).slice(seen).filter(v => v.code.startsWith('collision.')), []);
});
