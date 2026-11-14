// #2264 link-lease/1 (docs/design/stair-traffic.md §2): a single-file flight is leased one direction at a time; walkers
// queue at holding spots off its ends; the lease turns fairly; a stalled holder backs down. A green-field world with one
// 0.9 m flight from the ground to a floor 1.2 m up.
import test from 'node:test';
import assert from 'node:assert/strict';
import type {ProgramEvent} from '@souls/engine-contract';
import {marsFactory, GREEN_FIELD_WORLD, type MarsEngine} from './engine.ts';
import {nextEntityPhysics, type WorldEditV1} from './entity-physics.ts';
import {CLIMB_SPEED} from '../../../mars/viewer/engine/locomotion/walk.ts';
import {LEASE_TURN_ADMITS} from '../../../mars/viewer/engine/runtime/lease.ts';
import {HUMAN_PROFILE} from '../../../mars/viewer/engine/spatial/types.ts';

const factory = await marsFactory(GREEN_FIELD_WORLD);
const X = 1, FOOT: [number, number] = [X, -4], HEAD: [number, number] = [X, -1], RISE = 1.2;
const FLIGHT_M = Math.hypot(HEAD[1] - FOOT[1], RISE);

type Ended = {actor: string; kind: string; code?: string; reason?: string; tick: number};
type Run = {e: MarsEngine; ended: Ended[]; log: string[]};
const internals = (e: MarsEngine) => e as unknown as {rt: {tick: number; services: Record<string, unknown>; world: MarsEngine['world']}};

function world(name: string): MarsEngine {
  const e = factory.create(factory.genesis(name)) as MarsEngine;
  const edit: WorldEditV1 = {contract: 'world-edit/1', seq: 1, hash: '', levels: [{id: 1, y: RISE, label: 'upper'}], assets: {}, set: {
    upper: {surfaces: [{id: 'upper-floor', level: 1, y: RISE, obb: {c: [X, 1.5], half: [5, 3.5], yaw: 0}}]},
    flights: {links: [{id: 'flight', kind: 'stairs', from: {level: 0, p: FOOT, y: 0}, to: {level: 1, p: HEAD, y: RISE}, heading: Math.PI / 2, width: .9, usable: true,
      path: [[X, 0, FOOT[1]], [X, RISE, HEAD[1]]]}]},
  }};
  edit.hash = nextEntityPhysics(undefined, edit).hash;
  e.applyWorldEditV1(edit);
  return e;
}

/** Walkers: [id, start (x, z, level), goal (x, z, level)]. Each starts on its level and walks to its goal. */
type Walker = [string, [number, number, number], [number, number, number]];
function start(e: MarsEngine, walkers: Walker[]) {
  for (const [id, [x, z, level]] of walkers) {
    // a walker that starts upstairs is born on the ground beside the foot and climbs there first, by its own walk
    e.spawnHuman({id, soul: `s_${id}`, label: id, near: {at: level === 1 ? [x + 2, -6] : [x, z], first: true}});
    if (level === 1) {
      const p = e.perform({actor: id, label: 'up', steps: [{verb: 'mars:walk_to', params: {x, z, level: 1}}]});
      assert.equal(p.ok, true, JSON.stringify(p));
      for (let i = 0; i < 1200 && e.programOf(id); i++) e.step();
      assert.equal(e.world.entities[id].human!.level, 1, `${id} upstairs`);
    }
  }
}
function send(run: Run, walkers: Walker[]) {
  for (const [id, , [x, z, level]] of walkers) {
    const p = run.e.perform({actor: id, label: 'cross', steps: [{verb: 'mars:walk_to', params: {x, z, level}}]});
    assert.equal(p.ok, true, JSON.stringify(p));
  }
}
function step(run: Run) {
  // a program's end carries its last step's code and message; a lease timeout names itself in the message
  const out = run.e.step() as unknown as {programs: ProgramEvent[]};
  for (const p of out.programs) if (p.kind !== 'step')
    run.ended.push({actor: p.actor, kind: p.kind, code: p.code, reason: /traffic\.lease-timeout/.test(p.message ?? '') ? 'traffic.lease-timeout' : undefined, tick: p.tick});
}
const leases = (e: MarsEngine) => internals(e).rt.services.linkLeases as Map<string, {dir: string; holders: {id: string; dir: string}[]; queue: {up: unknown[]; down: unknown[]}}> | undefined;

// three up from the ground to the floor and three down from the floor to the ground, sent together
const UP: Walker[] = [['h_up_a', [X - 1, -7, 0], [X, 3, 1]], ['h_up_b', [X, -8, 0], [X + 1.5, 3.5, 1]], ['h_up_c', [X + 1, -7.5, 0], [X - 1.5, 3, 1]]];
const DOWN: Walker[] = [['h_dn_a', [X - 1, 2.5, 1], [X, -8, 0]], ['h_dn_b', [X + 1, 3, 1], [X + 1.5, -8.5, 0]], ['h_dn_c', [X, 4, 1], [X - 1.5, -8, 0]]];

function crossing(policy: boolean, name = 'link-lease'): Run {
  const run: Run = {e: world(name), ended: [], log: []};
  start(run.e, [...UP, ...DOWN]);
  // stair-way/1, as every world adopts at boot (#1428): without it a make-way clear-of test throws reading a climber's way
  run.e.configureRuntimePolicy({sleepBlockTicks: 1200, stairWayV1: true, ...(policy ? {linkLeaseV1: true} : {})});
  send(run, [...UP, ...DOWN]);
  return run;
}

// The bound: each walker's own walk (≤ 12 m on the floors at walking pace, plus its flight), and before its turn every
// other walker's flight in a single file, each with a walk from a holding spot (≤ 4 m) and a hand-over; at most one turn
// of the lease per LEASE_TURN_ADMITS walkers.
const traverse = FLIGHT_M / CLIMB_SPEED, fromSpot = 4 / HUMAN_PROFILE.speed;
const BOUND_S = 12 / HUMAN_PROFILE.speed + 6 * (traverse + fromSpot) + Math.ceil(6 / LEASE_TURN_ADMITS) * 10;

test('#2264 three up and three down cross a single-file flight within the computed bound, one direction at a time', () => {
  const run = crossing(true);
  const t0 = internals(run.e).rt.tick, all = [...UP, ...DOWN].map(w => w[0]);
  let both = 0, waited = false;
  for (let i = 0; i < BOUND_S * 20 && all.some(id => run.e.programOf(id)); i++) {
    step(run);
    const onFlight = all.filter(id => { const p = run.e.world.entities[id].pose.p; return p[1] > .05 && p[1] < RISE - .05; });
    const dirs = new Set(leases(run.e)?.get('flight')?.holders.map(h => h.dir) ?? []);
    if (dirs.size > 1) both++;
    // nobody waits in the doorway: a walker waiting for the lease stands a body width off both entry points
    for (const id of all) {
      const e = run.e.world.entities[id], wait = e.human!.activity === 'wait' && leases(run.e)?.get('flight')?.queue && [...(leases(run.e)!.get('flight')!.queue.up as {id: string}[]), ...(leases(run.e)!.get('flight')!.queue.down as {id: string}[])].some(r => r.id === id);
      if (wait) waited = true;
      if (wait && onFlight.length) for (const end of [FOOT, HEAD]) assert.ok(Math.hypot(e.pose.p[0] - end[0], e.pose.p[2] - end[1]) >= 2 * HUMAN_PROFILE.radius - 1e-6, `${id} waits in the doorway at ${e.pose.p}`);
    }
  }
  const secs = (internals(run.e).rt.tick - t0) / 20;
  assert.deepEqual(all.filter(id => run.e.programOf(id)), [], `everyone crossed within ${BOUND_S.toFixed(0)} s (took ${secs} s)`);
  assert.deepEqual(run.ended.filter(x => x.kind !== 'completed'), [], 'every walk completed');
  for (const [id, , [, , level]] of [...UP, ...DOWN]) assert.equal(run.e.world.entities[id].human!.level, level, `${id} arrived on its level`);
  assert.equal(both, 0, 'the lease never held both directions');
  assert.ok(waited, 'someone queued for the lease');
  assert.equal(leases(run.e)?.size ?? 0, 0, 'the lease is released when nobody uses it');
  assert.deepEqual(run.e.runtime.violations, []);
});

test('#2264 the a-1 cycle completes: an ascender at the foot, a descender at the head and one on the flight', () => {
  // #1367 a-1: Eli going up stands aligned at the foot, Fin going down at the head, Gus on the flight coming down.
  const e = world('link-lease-a1'), run: Run = {e, ended: [], log: []};
  const cast: Walker[] = [['h_eli', [X, -5.2, 0], [X, 3, 1]], ['h_fin', [X, 0.2, 1], [X + 1, -8, 0]], ['h_gus', [X - 1, 1.5, 1], [X - 1, -8, 0]]];
  start(e, cast);
  e.configureRuntimePolicy({sleepBlockTicks: 1200, stairWayV1: true, linkLeaseV1: true});
  send(run, [cast[2]]);
  for (let i = 0; i < 400 && !(e.world.entities.h_gus.pose.p[1] < RISE - .2 && e.world.entities.h_gus.pose.p[1] > .2); i++) step(run);
  assert.ok(e.world.entities.h_gus.pose.p[1] > .2, 'Gus is on the flight');
  send(run, [cast[0], cast[1]]);
  for (let i = 0; i < 90 * 20 && cast.some(([id]) => e.programOf(id)); i++) step(run);
  assert.deepEqual(cast.filter(([id]) => e.programOf(id)).map(([id]) => id), [], 'all three walks end');
  assert.deepEqual(run.ended.filter(x => x.kind !== 'completed'), [], 'and each arrives');
  for (const [id, , [, , level]] of cast) assert.equal(e.world.entities[id].human!.level, level, id);
  assert.deepEqual(e.runtime.violations, []);
});

test('#2264 a holder with no progress for 60 s backs down its flight; walks waiting on it end route.blocked, traffic.lease-timeout', () => {
  // a body standing idle on the flight's head: the climbers reach it and can go no further
  const e = world('link-lease-stall'), run: Run = {e, ended: [], log: []};
  const idle: Walker = ['h_idle', [X, HEAD[1], 1], [X, HEAD[1], 1]], down: Walker = ['h_dn_a', [X - 2, 3, 1], [X, -8, 0]];
  start(e, [down, UP[0], UP[1], idle]);
  e.configureRuntimePolicy({sleepBlockTicks: 1200, stairWayV1: true, linkLeaseV1: true});
  send(run, [UP[0], UP[1], down]);
  const cast = [UP[0][0], UP[1][0], down[0]], busy = (id: string) => !!e.programOf(id) || !!e.world.entities[id].human!.task;
  for (let i = 0; i < 160 * 20 && cast.some(busy); i++) step(run);
  assert.deepEqual(cast.filter(busy), [], 'every walk ends');
  const timeouts = run.ended.filter(x => x.reason === 'traffic.lease-timeout');
  assert.deepEqual(timeouts.map(x => x.actor).sort(), [...cast].sort(), 'each walk ends traffic.lease-timeout');
  for (const t of timeouts) assert.equal(t.code, 'route.blocked', JSON.stringify(t));
  // the climbers backed down to the foot through the cancel, never a jump, and stepped off it; each walk ended off both
  // ends of the flight, so the next one down had its exit
  for (const [id] of [UP[0], UP[1]]) { const p = e.world.entities[id].pose.p; assert.equal(e.world.entities[id].human!.level, 0, id); assert.ok(Math.abs(p[1]) < .01, `${id} on the ground: ${p}`); }
  for (const id of cast) { const w = e.world.entities[id].pose.p; for (const end of [FOOT, HEAD]) assert.ok(Math.hypot(w[0] - end[0], w[2] - end[1]) >= 2 * HUMAN_PROFILE.radius, `${id} ended off the flight's ends: ${w}`); }
  assert.equal(leases(e)?.size ?? 0, 0, 'the lease is released');
  assert.deepEqual(e.runtime.violations, []);
});

test('#2264 replay from the log and from a snapshot keep the same state hash; a history without the rules event replays as recorded', () => {
  const a = crossing(true, 'link-lease-replay'), b = crossing(true, 'link-lease-replay');
  const off1 = crossing(false, 'link-lease-replay'), off2 = crossing(false, 'link-lease-replay');
  let copy: MarsEngine | undefined;
  for (let i = 0; i < 1600; i++) {
    step(a); step(b); off1.e.step(); off2.e.step();
    assert.equal(b.e.stateHash(), a.e.stateHash(), `the log replays the same at tick ${i}`);
    assert.equal(off2.e.stateHash(), off1.e.stateHash(), `history without the event replays the same at tick ${i}`);
    if (!copy && (leases(a.e)?.get('flight')?.queue.up.length || leases(a.e)?.get('flight')?.queue.down.length)) copy = factory.restore(a.e.snapshot()) as MarsEngine;
    else if (copy) { copy.step(); assert.equal(copy.stateHash(), a.e.stateHash(), `the restored snapshot steps the same at tick ${i}`); }
  }
  assert.ok(copy, 'a snapshot was taken while walkers queued');
  assert.equal(internals(off1.e).rt.services.linkLeases, undefined, 'without the rule no lease is kept');
  assert.equal(internals(off1.e).rt.services.linkLeaseV1, undefined);
  assert.notEqual(a.e.stateHash(), off1.e.stateHash());
  // the lease is a state-hash input: the same world with and without the rule diverges at its adoption
  const on = world('link-lease-hash'), off = world('link-lease-hash');
  assert.equal(on.stateHash(), off.stateHash());
  on.configureRuntimePolicy({sleepBlockTicks: 1200, linkLeaseV1: true}); off.configureRuntimePolicy({sleepBlockTicks: 1200});
  assert.notEqual(on.stateHash(), off.stateHash());
});

test('#2264 a holder whose walk is force-ended (stall release, repair) no longer holds the flight; the other end is admitted', () => {
  // one up, one down; the climber's walk is force-ended mid-flight, as quiet stall release and repair abandon do (no cancel)
  const e = world('link-lease-force'), run: Run = {e, ended: [], log: []};
  start(e, [UP[0], DOWN[0]]);
  e.configureRuntimePolicy({sleepBlockTicks: 1200, stairWayV1: true, linkLeaseV1: true});
  send(run, [UP[0], DOWN[0]]);
  const rt = internals(e).rt as unknown as {services: {walkExecs: Map<string, {id: string; actor: string; climbT: number; phase: string}>}; forceCancel(id: string, d: {code: string; message: string}): boolean};
  let ex: {id: string; actor: string} | undefined;
  for (let i = 0; i < 1200 && !ex; i++) { step(run); ex = [...rt.services.walkExecs.values()].find(x => x.actor === UP[0][0] && x.phase === 'climb' && x.climbT > .5); }
  assert.ok(ex, 'the climber is on the flight');
  assert.equal(leases(e)?.get('flight')?.holders[0]?.id, UP[0][0]);
  assert.equal(rt.forceCancel(ex.id, {code: 'test.force', message: 'force-ended as a stall release does'}), true);
  let down = false;
  for (let i = 0; i < 5 * 20 && !down; i++) { step(run); down = !!leases(e)?.get('flight')?.holders.some(h => h.id === DOWN[0][0]); }
  assert.ok(!leases(e)?.get('flight')?.holders.some(h => h.id === UP[0][0]), 'the force-ended walk no longer holds the flight');
  assert.ok(down, 'the walker at the other end is admitted');
});
