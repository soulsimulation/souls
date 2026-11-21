// Hover (N-V20, #3677): the body and box picks, names, and which of a Soul or a thing a ray meets first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { pickAt, rayBody, thingName, tooltipText, type HoverOptions } from './hover.ts';
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
