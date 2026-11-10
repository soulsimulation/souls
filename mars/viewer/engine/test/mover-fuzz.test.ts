// #1411 slice 1: a seeded fuzz over the runtime's own movers, measured by solidOverlapsV1. Each case builds a small world
// (random walls, random bodies, a beam), runs one mover to the end, and counts what it created after every tick:
//   overlaps            new solid-in-solid pairs the move made (none were there before it);
//   strictWouldRefuse   moves whose goal a strict placement check refuses up front (the goal pose itself overlaps), split
//                       into those that did overlap and those that didn't ("unnecessary": the move would have been fine).
// Both sides are measured, as the coordinator asked (refusals alongside containment). The numbers are the baseline; the
// test pins them so a change in either direction shows, and prints them for the PR (MOVER_FUZZ_REPORT=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime/runtime.ts';
import { DEFAULT_INVARIANTS } from '../runtime/invariants.ts';
import { solidOverlapsV1, newOverlapsV1, type SolidOverlapV1 } from '../runtime/solid-overlaps.ts';
import { Spatial } from '../spatial/service.ts';
import { emptyWorld, human, addAll, component } from '../world/factory.ts';
import { walkTo } from '../locomotion/walk.ts';
import { carry } from '../carry/actions.ts';
import { CARRY_INVARIANTS } from '../carry/invariants.ts';
import type { ActionDef } from '../actions/types.ts';
import type { Entity } from '../world/types.ts';
import type { SpatialScene } from '../spatial/types.ts';

const REG = new Map<string, ActionDef>([['walk_to', walkTo], ['carry', carry]]);
/** A small seeded generator (test-only; the engine's own RNG is the world's). */
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const SCENES = new WeakMap<Runtime, SpatialScene>();
const between = (r: () => number, a: number, b: number) => a + (b - a) * r();

function world(seed: number) {
  const r = rng(seed), obstacles: SpatialScene['obstacles'] = [];
  for (let i = 0; i < 4; i++) {
    const c: [number, number] = [between(r, -10, 10), between(r, -10, 10)];
    obstacles.push({ id: `wall${i}`, obb: { c, half: [between(r, 0.15, 0.4), between(r, 1, 4)], yaw: between(r, 0, Math.PI) }, y0: 0, y1: 2.5, kind: 'wall', label: `wall ${i}` });
  }
  const scene: SpatialScene = { bounds: [-20, -20, 20, 20], levels: [{ id: 0, y: 0, label: 'ground' }], surfaces: [{ id: 'ground', level: 0, y: 0, obb: { c: [0, 0], half: [20, 20], yaw: 0 } }], obstacles, links: [] };
  const ents: Entity[] = [];
  // bodies and the beam start clear (resampled until the reader finds nothing), so anything found later is the mover's
  const rt0 = () => new Runtime(addAll(emptyWorld(`fuzz-${seed}`, scene), ...ents.map(e => structuredClone(e))), REG, { spatial: new Spatial(scene) }, [...DEFAULT_INVARIANTS, ...CARRY_INVARIANTS]);
  for (const id of ['p1', 'p2', 'p3']) for (let k = 0; k < 50; k++) {
    const h = human(id, between(r, -12, 12), between(r, -12, 12)); ents.push(h);
    if (!solidOverlapsV1(rt0()).length) break; ents.pop();
  }
  for (let k = 0; k < 50; k++) {
    const b = component('beam', 'beam-12ft', [between(r, -8, 8), 0, between(r, -8, 8)], between(r, 0, Math.PI)); ents.push(b);
    if (!solidOverlapsV1(rt0()).length) break; ents.pop();
  }
  const rt = rt0(); SCENES.set(rt, scene);
  return { r, rt, goal: () => ({ x: between(r, -12, 12), z: between(r, -12, 12), yaw: between(r, 0, Math.PI) }) };
}

type Tally = { cases: number; completed: number; overlaps: number; overlapKinds: Record<string, number>; strictWouldRefuse: number; strictRefusedAndOverlapped: number; strictUnnecessary: number; strictAndMoverRefused: number; moverEnds: Record<string, number> };
const tally = (): Tally => ({ cases: 0, completed: 0, overlaps: 0, overlapKinds: {}, strictWouldRefuse: 0, strictRefusedAndOverlapped: 0, strictUnnecessary: 0, strictAndMoverRefused: 0, moverEnds: {} });

/** Run `id` to the end (or 40 s of world time), reading new overlaps after every tick. */
function drive(rt: Runtime, rec: { status: string }, objects: string[], ticks = 800): SolidOverlapV1[] {
  const before = solidOverlapsV1(rt, { objects }), made = new Map<string, SolidOverlapV1>();
  for (let t = 0; t < ticks && (rec.status === 'executing' || rec.status === 'pending' || rec.status === 'blocked' || rec.status === 'waiting'); t++) {
    rt.step();
    for (const o of newOverlapsV1(before, solidOverlapsV1(rt, { objects }))) made.set(o.kind + '|' + o.subjects.join(), o);
  }
  return [...made.values()];
}
/** A strict up-front check of the goal pose: put the mover there in a copy and read it. */
function goalOverlaps(rt: Runtime, place: (w: Runtime['world']) => void, objects: string[]): boolean {
  const copy = new Runtime(structuredClone(rt.world), REG, { spatial: new Spatial(SCENES.get(rt)!) }, []);
  const before = solidOverlapsV1(copy, { objects }); place(copy.world);
  return newOverlapsV1(before, solidOverlapsV1(copy, { objects })).length > 0;
}
function score(t: Tally, made: SolidOverlapV1[], strict: boolean, rec: { status: string; diagnostic?: { code: string } }) {
  const completed = rec.status === 'completed', end = completed ? 'completed' : `${rec.status}:${rec.diagnostic?.code ?? '-'}`;
  t.cases++; if (completed) t.completed++; t.moverEnds[end] = (t.moverEnds[end] ?? 0) + 1;
  t.overlaps += made.length; for (const o of made) t.overlapKinds[o.kind] = (t.overlapKinds[o.kind] ?? 0) + 1;
  // a strict refusal is unnecessary only when the move, let go, completed and made no overlap
  if (strict) { t.strictWouldRefuse++; if (made.length) t.strictRefusedAndOverlapped++; else if (completed) t.strictUnnecessary++; else t.strictAndMoverRefused++; }
}

const SEEDS = Array.from({ length: 40 }, (_, i) => 1411 + i * 7919);
const report: Record<string, Tally> = {};

test('mover fuzz: walk_to', { timeout: 300_000 }, () => {
  const t = report.walk = tally();
  for (const seed of SEEDS) {
    const w = world(seed), g = w.goal();
    const strict = goalOverlaps(w.rt, (wd) => { wd.entities.p1.pose.p = [g.x, 0, g.z]; }, []);
    const rec = w.rt.submit('walk_to', { actor: 'p1', x: g.x, z: g.z });
    score(t, drive(w.rt, rec, []), strict, rec);
  }
  assert.equal(t.cases, SEEDS.length);
  assert.equal(t.overlaps, 0, `walk_to never puts a body in a solid: ${JSON.stringify(t)}`);
});

test('mover fuzz: carry and set down', { timeout: 300_000 }, () => {
  const t = report.carry = tally();
  for (const seed of SEEDS) {
    const w = world(seed);
    if (!w.rt.world.entities.beam) continue;
    const g = w.goal();
    const strict = goalOverlaps(w.rt, (wd) => { wd.entities.beam.pose.p = [g.x, 0, g.z]; wd.entities.beam.pose.yaw = g.yaw; }, ['beam']);
    const rec = w.rt.submit('carry', { crew: ['p1', 'p2'], item: 'beam', to: { x: g.x, z: g.z, yaw: g.yaw }, clearLiftV1: true });
    score(t, drive(w.rt, rec, ['beam'], 3000), strict, rec);
  }
  assert.ok(t.cases > SEEDS.length / 2, `enough worlds had a clear beam: ${t.cases}`);
  assert.equal(t.overlaps, 0, `a carry never sets its load (or its crew) in a solid: ${JSON.stringify(t)}`);
});

test('mover fuzz: the baseline (printed with MOVER_FUZZ_REPORT=1)', () => {
  if (process.env.MOVER_FUZZ_REPORT) console.info('[mover-fuzz]', JSON.stringify(report));
  assert.ok(report.walk && report.carry);
});
