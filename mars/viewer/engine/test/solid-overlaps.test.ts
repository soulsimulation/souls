// #1411 slice 1: the solid-in-solid reader. One fixture per kind reads exactly that one overlap; clean worlds read none; an
// item resting on a table is no overlap; the reader keeps no memory (twice in a row, the same answer, the same state).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime/runtime.ts';
import { DEFAULT_INVARIANTS } from '../runtime/invariants.ts';
import { solidOverlapsV1, newOverlapsV1 } from '../runtime/solid-overlaps.ts';
import { Spatial } from '../spatial/service.ts';
import { emptyWorld, human, addAll, component } from '../world/factory.ts';
import type { ActionDef } from '../actions/types.ts';
import type { Entity } from '../world/types.ts';
import type { SpatialScene } from '../spatial/types.ts';

const wall = { id: 'wall', obb: { c: [5, 0] as [number, number], half: [0.2, 3] as [number, number], yaw: 0 }, y0: 0, y1: 2.5, kind: 'wall' as const, label: 'a wall' };
const scene = (obstacles: SpatialScene['obstacles'] = [wall]): SpatialScene => ({
  bounds: [-20, -20, 20, 20],
  levels: [{ id: 0, y: 0, label: 'ground' }],
  surfaces: [{ id: 'ground', level: 0, y: 0, obb: { c: [0, 0], half: [20, 20], yaw: 0 } }],
  obstacles, links: [],
});
const setup = (sc: SpatialScene, ...es: Entity[]) => new Runtime(addAll(emptyWorld('solid-overlaps', sc), ...es), new Map<string, ActionDef>(), { spatial: new Spatial(sc) }, [...DEFAULT_INVARIANTS]);
const kinds = (rt: Runtime) => solidOverlapsV1(rt).map(o => `${o.kind}:${o.subjects.join('+')}`);

test('a clean world reads no overlap', () => {
  assert.deepEqual(kinds(setup(scene(), human('a', 0, 0), human('b', 2, 0), component('beam', 'beam-12ft', [-6, 0, 8], 0))), []);
});

test('body-static: a body inside the wall', () => {
  assert.deepEqual(kinds(setup(scene(), human('a', 5, 0), human('b', 0, 0))), ['body-static:a']);
});

test('body-body: two bodies 0.1 m apart', () => {
  assert.deepEqual(kinds(setup(scene(), human('a', 0, 0), human('b', 0.1, 0))), ['body-body:a+b']);
});

test('object-static: a beam laid through the wall, and only it', () => {
  assert.deepEqual(kinds(setup(scene(), component('beam', 'beam-12ft', [5, 0, 0], 0), human('a', -3, 0))), ['object-static:beam+wall']);
});

test('object-static: two loose things on the ground through each other are one pair, not two', () => {
  const rt = setup(scene([]), component('b1', 'beam-12ft', [0, 0, 0], 0), component('b2', 'beam-12ft', [0, 0, 0], Math.PI / 2));
  assert.deepEqual(kinds(rt), ['object-static:b1+b2']);
});

test('a thing on top of another (height ranges only touching) is no overlap', () => {
  const shelf = { id: 'shelf', obb: { c: [0, 0] as [number, number], half: [3, 1] as [number, number], yaw: 0 }, y0: 0, y1: 0, kind: 'wall' as const, label: 'a flat plate' };
  assert.deepEqual(kinds(setup(scene([shelf]), component('beam', 'beam-12ft', [0, 0, 0], 0))), []);
});

test('the objects filter reads only the named objects; bodies are always read', () => {
  const rt = setup(scene(), component('beam', 'beam-12ft', [5, 0, 0], 0), human('a', 5, 1));
  assert.deepEqual(solidOverlapsV1(rt, { objects: [] }).map(o => o.kind), ['body-static']);
  assert.deepEqual(solidOverlapsV1(rt, { objects: ['beam'] }).map(o => o.kind).sort(), ['body-static', 'object-static']);
});

test('a pure read: twice in a row, the same answer and the same state hash; newOverlapsV1 diffs by kind and subjects', () => {
  const rt = setup(scene(), human('a', 5, 0), human('b', 0, 0));
  const h0 = rt.stateHash(), one = solidOverlapsV1(rt), two = solidOverlapsV1(rt);
  assert.deepEqual(one, two); assert.equal(rt.stateHash(), h0);
  rt.world.entities.b.pose.p = [5, 0, 0.1];
  const created = newOverlapsV1(one, solidOverlapsV1(rt)).map(o => `${o.kind}:${o.subjects.join('+')}`).sort();
  assert.deepEqual(created, ['body-body:a+b', 'body-static:b']);
});
