// G10 (#2800): the page names what it draws and puts a shot's camera on one of them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { EYE_UP, aimAt, installCapture, resolveSpot, spots } from './capture.ts';
import type { NodeRec } from '../source/source.ts';

const node = (id: string, kind: string, parent: string | null, pos: [number, number, number], more: Partial<NodeRec> = {}): NodeRec =>
  ({ id, kind, parent, slot: null, pos: pos.map((v) => v * 1e6) as NodeRec['pos'], rot: [1 << 30, 0, 0, 0], at: null, ...more });
const room = node('ab.1', 'eden:room@12', null, [10, 0, 0]);
const lamp = node('ab.7', 'eden:lamp@34', 'ab.1', [2, 0, 0], { origin: 'library-lamp' });
const cup = node('ab.8', 'eden:cup@56', 'ab.1', [-2, 0, 0]);
const body = node('ab.9', 'souls:body@78', 'ab.1', [0, 0, 3], { name: 'Oriel' });
const nodes = [room, lamp, cup, body];
const isBody = (n: NodeRec) => n.kind.startsWith('souls:body');

/** A world as `aimAt` reads it: frames from positions alone, no tracks (nothing has moved). */
function world(): Parameters<typeof aimAt>[0] {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const frame = (id: string | null): THREE.Matrix4 => {
    const n = id ? by.get(id) : undefined;
    if (!n) return new THREE.Matrix4();
    return frame(n.parent).clone().multiply(new THREE.Matrix4().makeTranslation(n.pos[0] / 1e6, n.pos[1] / 1e6, n.pos[2] / 1e6));
  };
  return { nodes: by, tracks: new Map(), frame } as unknown as Parameters<typeof aimAt>[0];
}

test('places, Souls and things are named as the client names them', () => {
  const all = spots(nodes, isBody, (id) => (id === 'ab.9' ? 'Oriel' : null));
  assert.deepEqual(all.map((s) => [s.name, s.role]), [['room 1', 'place'], ['lamp 7', 'thing'], ['cup 8', 'thing'], ['Oriel', 'soul']]);
  assert.equal(resolveSpot(all, 'oriel')?.id, 'ab.9');
  assert.equal(resolveSpot(all, 'ab-8')?.id, 'ab.8', "the client's id form");
  assert.equal(resolveSpot(all, 'library')?.id, 'ab.7', "an imported thing by today's id");
  assert.equal(resolveSpot(all, 'room')?.role, 'place');
  assert.equal(resolveSpot(all, 'nothing here'), null);
});

test('a place is shot from above, a thing from beside, a Soul from its own eyes', () => {
  const w = world(), all = spots(nodes, isBody, () => 'Oriel');
  const place = aimAt(w, resolveSpot(all, 'room 1')!, 0)!;
  assert.deepEqual(place.target, [10, 0, 1.5], 'the middle of what the room holds');
  assert.ok(place.eye[1] > 5, 'from above');
  const thing = aimAt(w, resolveSpot(all, 'lamp 7')!, 0)!;
  assert.deepEqual(thing.target, [12, 0.8, 0]);
  const eyes = aimAt(w, resolveSpot(all, 'Oriel')!, 0, true)!;
  assert.equal(eyes.eye[1], EYE_UP, 'at eye height');
  assert.ok(eyes.target[2] < eyes.eye[2], 'still, it faces what its room holds');
});

test('?shot hides everything over the world but canvases, and aim moves only the camera', () => {
  const appended: { textContent: string }[] = [];
  const doc = { createElement: () => ({ textContent: '' }), head: { append: (s: { textContent: string }) => appended.push(s) } } as unknown as Document;
  const cam = { camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), update() {} } };
  let freed = 0;
  const g: Record<string, any> = { v2: { world: world(), cam, director: { t: 5, free: () => freed++ }, souls: { copy: { souls: new Map([['ab.9', { name: 'Oriel' }]]) } } } };
  installCapture(g, new URLSearchParams('shot=1'), doc);
  assert.match(appended[0].textContent, /body > :not\(canvas\)/);
  assert.equal(g.v2.capture.ready(), true);
  const shot = g.v2.capture.aim('cup');
  assert.equal(shot.spot.name, 'cup 8');
  assert.deepEqual(cam.controls.target.toArray(), shot.aim.target);
  assert.equal(freed, 1, 'the director hands the camera over');
  assert.equal(g.v2.capture.aim('nobody'), null);
});
