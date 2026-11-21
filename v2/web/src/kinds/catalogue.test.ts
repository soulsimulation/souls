// #3697: the page draws a creator's kind from its `souls:kind` record, and never the `souls:kind` node itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { STRUCTURE } from '../draw/world.ts';
import { indexOf } from '../things/models.ts';
import { ThingLayer } from '../things/things.ts';
import { boxOf, creatorThing } from '../things/page.ts';
import { KindCatalogue, isDefinition, partsOfKind, readRecord, shapeGeometry } from './catalogue.ts';

// The record `souls-god define-kit` writes for the skill's birdbath (keys sorted, as the world keeps it).
const BIRDBATH = { format: 'souls-entry/1', geometry: { bounds_mm: [1000, 1200, 1000], parts: [
  { at: [0, 400, 0], h: 800, kind: 'cyl', material: 'stone', r: 180 },
  { at: [0, 800, 0], kind: 'lathe', material: 'stone', profile: [[0, 0], [450, 50], [500, 150]] },
], palette: { stone: '#8a8f94' } }, kind: 'garden:birdbath', owner: 'thing', text: { name: 'birdbath' } };
const FULL = 'garden:birdbath@1220' + 'ab'.repeat(32);
const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const node = (id: string, kind: string, extra: Partial<NodeRec> = {}): NodeRec =>
  ({ id, kind, parent: 'root.0', slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...extra });
const definition = (id: string, full: string, record: unknown) => node(id, 'souls:kind@1220' + 'cd'.repeat(32), { defines: full, entry: bytes(record) });
// The solids the world gives a thing of this kind (its bounds' outline, `defined::solids_of`).
const SOLIDS = [[0, 0, 500, 500, 0, 0, 1200, 0, 0]];

test('the catalogue learns a creator kind from its souls:kind node and forgets it with the node', () => {
  const kinds = new KindCatalogue();
  assert.equal(kinds.apply([node('t.1', FULL), definition('k.1', FULL, BIRDBATH)], []), true);
  const k = kinds.of(FULL)!;
  assert.equal(k.name, 'garden:birdbath');
  assert.deepEqual(k.bounds, [1000, 1200, 1000]);
  assert.equal(k.shapes.length, 2);
  assert.equal(kinds.of('garden:birdbath'), null, 'a thing names its kind by the full name');
  assert.equal(kinds.apply([definition('k.1', FULL, BIRDBATH)], []), false, 'the same node again changes nothing');
  assert.equal(kinds.apply([], ['k.1']), true);
  assert.equal(kinds.of(FULL), null);
  assert.equal(readRecord(FULL, bytes({ format: 'def/1' })), null, 'only a souls-entry/1 record');
  assert.equal(readRecord(FULL, new Uint8Array([0xff])), null, 'bytes that are not JSON');
});

test('a kind\'s shapes are drawn where the record puts them, in its colours', () => {
  const k = readRecord(FULL, bytes(BIRDBATH))!;
  const parts = partsOfKind(k);
  assert.equal(parts.length, 2);
  const stem = parts[0].geometry;
  stem.computeBoundingBox();
  const b = stem.boundingBox!;
  assert.ok(Math.abs(b.min.y) < 1e-6 && Math.abs(b.max.y - 0.8) < 1e-6, `the 0.8 m stem stands on the ground: ${b.min.y}..${b.max.y}`);
  assert.ok(Math.abs(b.max.x - 0.18) < 1e-6, 'radius 180 mm');
  assert.equal((parts[0].material as THREE.MeshStandardMaterial).color.getHexString(), '8a8f94', 'the palette\'s stone');
  assert.equal(parts[0].material, parts[1].material, 'equal colours share a material, so they batch');
  for (const p of parts) for (const a of ['position', 'normal', 'color']) assert.ok(p.geometry.getAttribute(a), a);
  // A turned box: 90 degrees of yaw swaps its width and depth.
  const turned = shapeGeometry({ kind: 'box', at: [0, 500, 0], size: [2000, 1000, 400], yaw: 90_000 })!;
  turned.computeBoundingBox();
  assert.ok(Math.abs(turned.boundingBox!.max.x - 0.2) < 1e-6 && Math.abs(turned.boundingBox!.max.z - 1) < 1e-6);
  assert.equal(shapeGeometry({ kind: 'sweep', at: [0, 0, 0] }), null, 'a shape the page does not draw is left out');
});

test('a thing of a creator kind is drawn from its shapes, or from the model its record names, never as a box', () => {
  const kinds = new KindCatalogue();
  const plinth = { ...BIRDBATH, kind: 'garden:plinth', geometry: { bounds_mm: [600, 900, 600] } };
  const modelled = { ...BIRDBATH, kind: 'garden:statue', looks: { model: 'm-statue' } };
  const unknown = { ...BIRDBATH, kind: 'garden:urn', geometry: { bounds_mm: [500, 700, 500] }, looks: { model: 'not-in-the-index' } };
  kinds.apply([definition('k.1', FULL, BIRDBATH), definition('k.2', 'garden:plinth@1', plinth), definition('k.3', 'garden:statue@1', modelled), definition('k.4', 'garden:urn@1', unknown)], []);
  const asked: string[] = [];
  const layer = new ThingLayer({ index: indexOf({ kinds: [{ kind: 'statue', models: { a: 'm-statue' } }], things: {} }), detail: null, fetch: (h) => (asked.push(h), new Promise(() => {})) });
  const place = (id: string, kind: string, solids = SOLIDS) => {
    const n = node(id, kind, { solids });
    const made = creatorThing(n, kinds, layer)!;
    layer.set(id, null, new THREE.Matrix4(), made.box, made.model);
    return made;
  };
  place('t.1', FULL);
  const t = layer.things.get('t.1')!;
  assert.equal(t.slots.length, 2, 'one slot per shape');
  assert.ok(t.slots.every((s) => s.part), 'drawn from its shapes, not a box');
  place('t.2', FULL);
  assert.equal(layer.things.get('t.2')!.slots[0].part!.geometry, t.slots[0].part!.geometry, 'its shapes are built once per kind');
  // No shapes and no model: a box of its bounds; with no solids either, the bounds give it.
  const p = place('t.3', 'garden:plinth@1', []);
  assert.equal(layer.things.get('t.3')!.slots.length, 1);
  assert.equal(layer.waiting, 1);
  const e = p.box.elements;
  assert.deepEqual([e[0], e[5], e[10]], [0.6, 0.9, 0.6]);
  // A model the index knows is loaded; one it does not know falls back to the record's shapes (none here: its box).
  place('t.4', 'garden:statue@1');
  layer.update(new THREE.Vector3());
  assert.deepEqual(asked, ['m-statue']);
  place('t.5', 'garden:urn@1');
  assert.equal(layer.things.get('t.5')!.model, null);
  assert.deepEqual(boxOf(node('t.5', 'garden:urn@1', { solids: SOLIDS })).elements, place('t.5', 'garden:urn@1').box.elements, 'with solids, the box is theirs');
  // A boot kind is not the catalogue's.
  assert.equal(creatorThing(node('t.6', 'eden:bench@1'), kinds, layer), null);
});

test('a souls:kind node is never drawn', () => {
  const n = definition('k.1', FULL, BIRDBATH);
  assert.ok(isDefinition(n.kind));
  assert.ok(STRUCTURE.has(n.kind.split('@')[0]), 'the world view, the thing layer, support and the camera skip it');
  assert.equal(creatorThing(n, new KindCatalogue(), new ThingLayer({ index: indexOf({ kinds: [] }), detail: null, fetch: () => new Promise(() => {}) })), null);
});
