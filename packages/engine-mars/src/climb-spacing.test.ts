// #1530 climb-spacing/1: on a steep flight a climber following one that waits ahead closed to 1.0 m in height at ~0.2 m across
// (stairBlocker's ellipsoid let it), collision.human-human flagged the pair, and hold-settle/1 settled the follower off the flight.
// Under the policy stairBlocker also refuses a step the separation invariant would flag, so the follower waits behind on the
// stair, and its walk ends by the existing blocked-walk bound (route.blocked, back to its entry floor) if the way never clears.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import { groundFact } from './ground-bridge.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import { emptyGround } from '../../ground/src/index.ts';
import { stairBlocker } from '../../../mars/viewer/engine/locomotion/walk.ts';

const factory = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
const cx = 20, cz = 20, RUN = 0.8;   // a steep flight: 2.85 m up over 0.8 m
/** A two-storey house with one steep flight; `head` stands idle at its stair head (level 1), so a climber waits below it. */
function house(seed: string, policy: boolean, width = 1.1) {
  const set = { e_house: { surfaces: [{ id: 'h:ground', level: 0, y: 0, obb: { c: [cx, cz], half: [3.9, 2.9], yaw: 0 } }, { id: 'h:floor-1', level: 1, y: 2.85, obb: { c: [cx, cz], half: [3.9, 2.9], yaw: 0 } }], solids: [],
    links: [{ id: 'h:stairs', kind: 'stairs', from: { level: 0, p: [cx + 1.5, cz + RUN / 2], y: 0 }, to: { level: 1, p: [cx + 1.5, cz - RUN / 2], y: 2.85 }, width, heading: -Math.PI / 2,
      path: Array.from({ length: 17 }, (_, i) => [cx + 1.5, (2.85 * i) / 16, cz + RUN / 2 - (RUN * i) / 16]), usable: true }] } } as unknown as WorldEditV1['set'];
  const g = emptyGround(2000); g.extent = [-200, -1000, 1800, 1000];
  const e = factory.create(factory.genesis(seed)) as any;
  e.installGroundV1(groundFact(g, 1, { paged: true }));
  const ev: WorldEditV1 = { contract: 'world-edit/1', seq: 1, hash: '', levels: [{ id: 1, y: 2.85, label: 'floor' }], set, assets: {} } as never; ev.hash = nextEntityPhysics(undefined, ev).hash; e.applyWorldEditV1(ev);
  e.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true, refusalSettleV1: true, ...(policy ? { climbSpacingV1: true } : {}) } as never);
  return e;
}
const walk = (e: any, id: string, x: number, z: number, level: number) => { const r = e.perform({ actor: id, label: 'walk', steps: [{ verb: 'mars:walk_to', params: { x, z, level } }] }); assert.ok(r.ok, JSON.stringify(r)); return r.id as string; };
function queue(seed: string, policy: boolean) {
  const e = house(seed, policy);
  for (const [id, z] of [['h_head', 3.3], ['h_lead', 2], ['h_foll', 2.8]] as const) { e.spawnHuman({ id, label: id, soul: `s_${id}` }); assert.ok(e.relocateHumanV1(id, [cx + 1.5, cz + z])); }
  walk(e, 'h_head', cx + 1.5, cz - RUN / 2 - 0.05, 1); for (let k = 0; k < 900 && e.programOf('h_head'); k++) e.step();
  assert.equal(e.world.entities.h_head.human.level, 1, 'an idle body at the stair head');
  walk(e, 'h_lead', cx - 2, cz, 1); for (let k = 0; k < 600 && e.world.entities.h_lead.human.activity !== 'climb-wait'; k++) e.step();
  assert.equal(e.world.entities.h_lead.human.activity, 'climb-wait', 'the leader waits on the flight below it');
  const foll = walk(e, 'h_foll', cx - 2, cz + 1, 1);
  return { e, foll, F: e.world.entities.h_foll as any, L: e.world.entities.h_lead as any };
}
const hh = (e: any) => e.runtime.violations.filter((d: any) => d.code === 'collision.human-human');

test('#1530 without climb-spacing/1 the follower closes under the waiting leader, is flagged, and is settled off the flight (the fault)', () => {
  const { e, foll } = queue('climb-off', false);
  let end: any = null;
  for (let t = 0; t < 400 && !end; t++) end = e.step().programs.find((p: any) => p.id === foll && p.kind !== 'step') ?? null;
  assert.match(JSON.stringify(end), /world\.settled:collision\.human-human/);
});

test('#1530 under climb-spacing/1 the follower waits behind on the stair, never flagged; a leader that never moves ends the walk by the blocked-walk bound', () => {
  const { e, foll, F } = queue('climb-on-stuck', true), copy = factory.restore(e.snapshot());
  let end: any = null, t = 0, waited = 0;
  for (; t < 2000 && !end; t++) {
    const before = [...F.pose.p];
    end = e.step().programs.find((p: any) => p.id === foll && p.kind !== 'step') ?? null; copy.step();
    assert.deepEqual(hh(e).map((d: any) => d.message), [], `tick ${t}`);
    assert.ok(Math.hypot(F.pose.p[0] - before[0], F.pose.p[1] - before[1], F.pose.p[2] - before[2]) <= .2, `no jump at ${t}`);
    if (F.human.activity === 'climb-wait') waited++;
  }
  assert.ok(waited > 100, 'it waited behind on the stair');
  assert.equal(copy.stateHash(), e.stateHash(), 'a restored snapshot continues alike');
  // the existing bound for a climber whose way never clears: the walk fails route.blocked and the body is back on its entry floor
  assert.ok(end && t < 1600, `ended within the bound: ${t} ${JSON.stringify(end)}`);
  assert.equal(end.kind, 'failed'); assert.match(JSON.stringify(end), /route\.blocked/);
  // the cancelled climb finishes down to its supported entry on the next ticks (never dropped), then stands there free
  for (let k = 0; k < 200 && F.human.activity !== 'idle'; k++) { const b = [...F.pose.p]; e.step(); assert.deepEqual(hh(e), []); assert.ok(Math.hypot(F.pose.p[0] - b[0], F.pose.p[1] - b[1], F.pose.p[2] - b[2]) <= .2); }
  assert.equal(F.human.level, 0); assert.ok(Math.abs(F.pose.p[1]) < .01, `on its entry floor: ${F.pose.p} ${F.human.activity}`);
  assert.deepEqual(e.runtime.violations, []);
});

test('#1530 under climb-spacing/1 once the stair head clears, the leader and the follower both climb on and arrive', () => {
  const { e, foll, F, L } = queue('climb-on-clears', true);
  for (let t = 0; t < 200; t++) { e.step(); assert.deepEqual(hh(e), [], `tick ${t}`); }
  assert.equal(F.human.activity, 'climb-wait', 'the follower waits behind');
  walk(e, 'h_head', cx - 3, cz - 2, 1);   // the stair head clears
  let done = false;
  for (let t = 0; t < 1500 && !done; t++) { e.step(); assert.deepEqual(hh(e), [], `tick ${t}`); done = !e.programOf('h_foll') && !e.programOf('h_lead'); }
  assert.ok(done, 'both walks ended'); assert.equal(L.human.level, 1); assert.equal(F.human.level, 1); assert.ok(Math.abs(F.pose.p[1] - 2.85) < .01);
  assert.deepEqual(e.runtime.violations, []); void foll;
});

test('#1530 under climb-spacing/1 two climbers going opposite ways on one narrow flight end as they did without it (single file), never flagged', () => {
  const run = (policy: boolean) => {
    const e = house(`climb-opposite-${policy}`, policy, 0.7);
    e.spawnHuman({ id: 'h_up', label: 'up', soul: 's_up' }); assert.ok(e.relocateHumanV1('h_up', [cx + 1.5, cz + 2]));
    e.spawnHuman({ id: 'h_down', label: 'down', soul: 's_down' }); assert.ok(e.relocateHumanV1('h_down', [cx - 2, cz + 1]));
    walk(e, 'h_down', cx + 1.5, cz - RUN / 2 - 0.3, 1); for (let k = 0; k < 900 && e.programOf('h_down'); k++) e.step();
    walk(e, 'h_up', cx - 2, cz, 1); walk(e, 'h_down', cx + 1.5, cz + 2.5, 0);
    let t = 0, flagged = 0; for (; t < 2000 && (e.programOf('h_up') || e.programOf('h_down')); t++) { e.step(); flagged += hh(e).length; }
    const U = e.world.entities.h_up as any, D = e.world.entities.h_down as any;
    return { t, flagged, up: [U.human.level, +U.pose.p[1].toFixed(2)], down: [D.human.level, +D.pose.p[1].toFixed(2)] };
  };
  const off = run(false), on = run(true);
  assert.ok(on.t < 2000, `both walks ended within the bound: ${JSON.stringify(on)}`);
  assert.equal(on.flagged, 0, 'never flagged');
  assert.deepEqual(on, off, 'the flight is single file: the policy changes nothing here');
});

test('#1530 the spacing check reads the invariant: side by side beyond both radii passes, a step apart passes, a step closer under 1 m is refused', () => {
  const e = house('climb-unit', true), rt = (e as any).rt;
  e.spawnHuman({ id: 'h_a', label: 'a', soul: 's_a' }); e.spawnHuman({ id: 'h_b', label: 'b', soul: 's_b' });
  const A = e.world.entities.h_a as any, B = e.world.entities.h_b as any; A.human.level = B.human.level = 0;
  B.pose.p = [0, 1.0, 0];
  const r = 0.28, at = (x: number, y: number) => [x, y, 0];
  A.pose.p = at(0.55, 0.3);
  assert.equal(stairBlocker(rt, A, A.pose.p, at(0.55, 0.32), r), null, 'side by side, 0.55 m apart horizontally (beyond 0.28 + 0.28 - 0.08 + 0.02): passes');
  A.pose.p = at(0.3, 0.05);
  assert.equal(stairBlocker(rt, A, A.pose.p, at(0.3, 0.07), r), 'h_b', 'a step up to within 1 m in height at 0.3 m across: refused');
  A.pose.p = at(0.3, 0.2);
  assert.equal(stairBlocker(rt, A, A.pose.p, at(0.36, 0.2), r), null, 'already within: a step that widens the horizontal gap passes');
  rt.services.climbSpacingV1 = false;
  A.pose.p = at(0.3, 0.05);
  assert.equal(stairBlocker(rt, A, A.pose.p, at(0.3, 0.07), r), null, 'without the policy the ellipsoid alone passes that step (the recorded behaviour)');
});
