// Hover (N-V20, #3677): the body and box picks, names, and which of a Soul or a thing a ray meets first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { containingPlace, hoverPlaces, pickAt, pickPlace, rayBody, thingName, tooltipText, type HoverOptions, type HoverPlace } from './hover.ts';
import { ThingLayer, rayUnitBox } from '../things/things.ts';
import type { NodeRec } from '../source/source.ts';

const node = (id: string, kind: string, extra: Partial<NodeRec> = {}): NodeRec => ({ id, kind, parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...extra });

test('a ray meets a standing body from the side and from above, and misses beside or over it', () => {
  const foot = new THREE.Vector3(0, 0, 0);
  assert.ok(Math.abs(rayBody(new THREE.Vector3(-10, 1, 0), new THREE.Vector3(1, 0, 0), foot)! - 9.55) < 1e-9);
  assert.ok(Math.abs(rayBody(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0), foot)! - 8.1) < 1e-9);
  assert.equal(rayBody(new THREE.Vector3(-10, 1, 1), new THREE.Vector3(1, 0, 0), foot), null);
  assert.equal(rayBody(new THREE.Vector3(-10, 2.5, 0), new THREE.Vector3(1, 0, 0), foot), null);
  assert.equal(rayBody(new THREE.Vector3(-10, 1, 0), new THREE.Vector3(-1, 0, 0), foot), null, 'behind the eye');
});

test('a ray meets the unit box', () => {
  assert.equal(rayUnitBox(new THREE.Vector3(-5, 0.5, 0), new THREE.Vector3(1, 0, 0)), 4.5);
  assert.equal(rayUnitBox(new THREE.Vector3(-5, 1.5, 0), new THREE.Vector3(1, 0, 0)), null);
});

test('names: a Soul by its public name, a thing by its name or its kind in plain words, long ones cut', () => {
  assert.equal(thingName(node('1', 'eden:park-bench@2')), 'park bench');
  assert.equal(thingName(node('1', 'eden:lamp', { name: 'The Old Lamp' })), 'The Old Lamp');
  assert.equal(tooltipText('x'.repeat(80)).length, 54);
});

test('the nearer of a Soul and a thing is hovered; nothing beyond reach', () => {
  const layer = new ThingLayer({ index: { things: {}, states: new Map() } as any, fetch: async () => new ArrayBuffer(0) });
  // a 2 m box standing at x = 10
  layer.set('box', null, new THREE.Matrix4().makeTranslation(10, 0, 0), new THREE.Matrix4().makeScale(2, 2, 2));
  const nodes = new Map<string, NodeRec>([['box', node('box', 'eden:market-stall')], ['soul', node('soul', 'souls:body', { at: 0 })]]);
  const at = new Map<string, [number, number, number]>([['soul', [5e6, 0, 0]]]);
  const opts: HoverOptions = {
    world: { nodes, tracks: new Map([['soul', { at: () => at.get('soul')! }]]), frame: () => new THREE.Matrix4() },
    things: () => layer, name: (id) => (id === 'soul' ? 'Oriel' : null), chipShown: () => false,
  };
  const o = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(1, 0, 0);
  const soul = pickAt(o, d, 0, opts)!;
  assert.deepEqual([soul.kind, soul.name], ['soul', 'Oriel']);
  assert.deepEqual(soul.foot.toArray(), [5, 0, 0]);
  at.set('soul', [20e6, 0, 0]);
  const thing = pickAt(o, d, 0, opts)!;
  assert.deepEqual([thing.kind, thing.id, thing.name], ['thing', 'box', 'market stall']);
  assert.deepEqual(thing.foot.toArray(), [10, 0, 0]);
  assert.ok(Math.abs(thing.radius - Math.SQRT2) < 1e-9);
  assert.equal(pickAt(o, d, 0, opts, 8), null, 'beyond reach');
  assert.equal(pickAt(o, new THREE.Vector3(-1, 0, 0), 0, opts), null);
  layer.set('box', null, new THREE.Matrix4().makeTranslation(30, 0, 0), new THREE.Matrix4().makeScale(2, 2, 2));
  assert.equal(pickAt(o, d, 0, opts)!.kind, 'soul', 'a moved thing is picked where it now stands');
});

test('with no thing layer, a thing is picked from the boxes the world view draws for it', () => {
  // a stall 2 m wide and deep, 3 m tall, standing at x = 10 (its solid in mm, in its own frame)
  const stall = node('stall', 'eden:market-stall', { solids: [[0, 0, 1000, 1000, 0, 0, 3000]] });
  const opts: HoverOptions = {
    world: { nodes: new Map([['stall', stall]]), tracks: new Map(), frame: () => new THREE.Matrix4().makeTranslation(10, 0, 0) },
    things: () => null, name: () => null, chipShown: () => false,
  };
  const hit = pickAt(new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(1, 0, 0), 0, opts)!;
  assert.deepEqual([hit.kind, hit.name], ['thing', 'market stall']);
  assert.equal(pickAt(new THREE.Vector3(0, 3.5, 0), new THREE.Vector3(1, 0, 0), 0, opts), null, 'over its roof');
});

// #3779: a named place under the pointer, as today's `containingPlace`.
const sq = (x: number, z: number, side: number): [number, number][] => [[x, z], [x + side, z], [x + side, z + side], [x, z + side]];

test('#3779 the innermost place holding the point wins, and a raised place claims only its own level', () => {
  const park: HoverPlace = { id: 'park', name: 'park', outline: sq(0, 0, 100), level: null };
  const pond: HoverPlace = { id: 'pond', name: 'pond', outline: sq(40, 40, 20), level: null };
  const upstairs: HoverPlace = { id: 'loft', name: 'loft', outline: sq(45, 45, 5), level: 6 };
  const at = (x: number, y: number, z: number) => containingPlace(new THREE.Vector3(x, y, z), [park, pond, upstairs])?.id ?? null;
  assert.equal(at(10, 0, 10), 'park');
  assert.equal(at(50, 0, 50), 'pond', 'nested: the smaller place inside wins, in any order');
  assert.equal(containingPlace(new THREE.Vector3(50, 0, 50), [pond, park])?.id, 'pond');
  assert.equal(at(47, 0, 47), 'pond', 'on the ground under the loft, the loft is not where the pointer rests');
  assert.equal(at(47, 6.5, 47), 'loft', 'on its own floor the loft wins');
  assert.equal(at(47, 9, 47), 'pond', 'more than 2 m off its level it does not');
  assert.equal(at(150, 0, 10), null);
});

test('#3779 resting on the ground in a named place shows its name and a ring scaled to it; a Soul or thing comes first', () => {
  const layer = new ThingLayer({ index: { things: {}, states: new Map() } as any, fetch: async () => new ArrayBuffer(0) });
  const mm = (p: [number, number][]) => p.map(([x, z]) => [x * 1000, z * 1000]);
  const nodes = new Map<string, NodeRec>([
    ['square', node('square', 'eden:place', { placeName: 'place-market-square', outline: mm(sq(-20, -20, 40)) })],
    ['well', node('well', 'eden:place', { placeName: 'old well', outline: mm(sq(-2, -2, 4)) })],
    ['soul', node('soul', 'souls:body', { at: 0 })],
  ]);
  const at = new Map<string, [number, number, number]>([['soul', [100e6, 0, 0]]]);
  const opts: HoverOptions = {
    world: { nodes, tracks: new Map([['soul', { at: () => at.get('soul')! }]]), frame: () => new THREE.Matrix4(), heightAt: () => 0 },
    things: () => layer, name: () => 'Oriel', chipShown: () => false,
  };
  const eye = new THREE.Vector3(-10, 20, 10), down = (x: number, z: number) => new THREE.Vector3(x, 0, z).sub(eye).normalize();
  const sqHit = pickAt(eye, down(10, 10), 0, opts)!;
  assert.deepEqual([sqHit.kind, sqHit.id, sqHit.name], ['place', 'square', 'market square'], "named in plain words, without the data's place- prefix");
  assert.deepEqual(sqHit.foot.toArray(), [0, 0, 0], 'the ring stands at the middle of the place');
  assert.ok(Math.abs(sqHit.radius - Math.hypot(20, 20)) < 1e-9, 'scaled to reach its farthest corner');
  assert.equal(pickAt(eye, down(0.5, 0.5), 0, opts)!.id, 'well', 'the innermost place');
  assert.equal(pickAt(eye, down(30, 30), 0, opts), null, 'outside every place');
  assert.equal(pickAt(eye, new THREE.Vector3(1, 0.1, 0).normalize(), 0, opts), null, 'looking up meets no ground');
  at.set('soul', [10e6, 0, 10e6]);
  assert.equal(pickAt(eye, down(10, 10), 0, opts)!.kind, 'soul', 'a Soul standing there comes first');
  layer.set('box', null, new THREE.Matrix4().makeTranslation(0.5, 0, 0.5), new THREE.Matrix4().makeScale(1, 1, 1));
  nodes.set('box', node('box', 'eden:lamp'));
  assert.equal(pickAt(eye, down(0.5, 0.5), 0, opts)!.kind, 'thing', 'and a thing');
  assert.equal(tooltipText('market square', 'open 8:00 to 18:00'), 'market square · open 8:00 to 18:00');
});

test('#3779 a sunken place (a pond, its middle below its frame) is ground level, not an upper floor', () => {
  const mm = (p: [number, number][]) => p.map(([x, z]) => [x * 1000, z * 1000]);
  const nodes = new Map<string, NodeRec>([['pond', node('pond', 'eden:pond', { placeName: 'reeds', outline: mm(sq(-10, -10, 20)) })]]);
  const world = { nodes, tracks: new Map(), frame: () => new THREE.Matrix4(), heightAt: (x: number, z: number) => (Math.hypot(x, z) < 8 ? -3.5 : 0) };
  assert.equal([...hoverPlaces(world)][0].level, null);
  const eye = new THREE.Vector3(-10, 20, 10);
  assert.equal(pickPlace(eye, new THREE.Vector3(0, -3.5, 0).sub(eye).normalize(), world)?.id, 'pond', 'its sunken middle is in it');
});
