// #3697: the page draws a creator's kind from its `souls:kind` record, and never the `souls:kind` node itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { STRUCTURE } from '../draw/world.ts';
import { Catalogue, recordEntry } from './catalogue.ts';
import { KindLayer } from './layer.ts';

// The record `souls-god define-kit` writes for the skill's birdbath (keys sorted, as the world keeps it).
const BIRDBATH = { format: 'souls-entry/1', geometry: { bounds_mm: [1000, 1200, 1000], parts: [
  { at: [0, 400, 0], h: 800, kind: 'cyl', material: 'stone', r: 180 },
  { at: [0, 800, 0], kind: 'lathe', profile: [[0, 0], [450, 50], [500, 150]], tint: 'basin' },
], palette: { basin: '#8a8f94' } }, kind: 'garden:birdbath', owner: 'thing', text: { name: 'birdbath' } };
const FULL = 'garden:birdbath@1220' + 'ab'.repeat(32);
const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const node = (id: string, kind: string, extra: Partial<NodeRec> = {}): NodeRec =>
  ({ id, kind, parent: 'root.0', slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...extra });
const definition = (id: string, full: string, record: unknown) => node(id, 'souls:kind@1220' + 'cd'.repeat(32), { defines: full, entry: bytes(record) });

test('the catalogue answers a creator kind from its souls:kind node, with no fetch, and forgets it with the node', async () => {
  const asked: string[] = [];
  const cat = new Catalogue('https://example.test/', async (url) => (asked.push(url), null));
  cat.learn([node('t.1', FULL), definition('k.1', FULL, BIRDBATH)], []);
  const e = (await cat.entry(FULL))!;
  assert.equal(e.kind, FULL);
  assert.equal(e.looks!.shape!.shapes.length, 2);
  assert.deepEqual(e.looks!.shape!.palette, { basin: '#8a8f94' });
  assert.deepEqual(asked, [], 'a creator kind is never fetched');
  cat.learn([], ['k.1']);
  assert.equal(await cat.entry(FULL), null);
  assert.equal(recordEntry(FULL, bytes({ format: 'def/1' })), null, 'only a souls-entry/1 record');
  assert.equal(recordEntry(FULL, new Uint8Array([0xff])), null, 'bytes that are not JSON');
  assert.deepEqual(recordEntry(FULL, bytes({ format: 'souls-entry/1', geometry: { bounds_mm: [600, 900, 600] } }))!.looks, {}, 'no parts: nothing to draw from');
});

test('a part written from and to stands at their middle, turned along them, as long', () => {
  const e = recordEntry(FULL, bytes({ format: 'souls-entry/1', geometry: { parts: [{ kind: 'cyl', from: [0, 0, 0], to: [1000, 0, 0], r: 50 }] } }))!;
  const s = e.looks!.shape!.shapes[0];
  assert.deepEqual(s.at, [500, 0, 0]);
  assert.equal(s.h, 1000);
  assert.deepEqual([s.pitch, s.yaw], [90_000, 90_000], '+y laid along +x');
});

test('a thing of a creator kind is drawn from its record\'s shapes by the kind layer', async () => {
  const cat = new Catalogue('https://example.test/', async () => null);
  const told: string[] = [];
  const layer = new KindLayer(cat, (id) => told.push(id));
  cat.learn([definition('k.1', FULL, BIRDBATH)], []);
  layer.set(node('t.1', FULL), new THREE.Matrix4().makeTranslation(3, 0, 4));
  await cat.entry(FULL);
  await Promise.resolve();
  assert.deepEqual(told, ['t.1'], 'drawn here, so its stand-in box goes');
  const box = new THREE.Box3().setFromObject(layer.picture('t.1')!);
  assert.ok(Math.abs(box.min.y) < 1e-3 && box.max.y > 0.8, `stands on the ground, the stem and the basin: ${box.min.y}..${box.max.y}`);
});

test('a souls:kind node is never drawn', () => {
  assert.ok(STRUCTURE.has('souls:kind'), 'the world view, the thing layer, support and the camera skip it');
});
