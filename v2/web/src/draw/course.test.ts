// #3603: a node on a course (a rowing punt) drawn where the replica's `courseAt` has it at world time, its riders and
// what it carries with it, and standing where it was placed when the course throws. The replica is the WASM build
// v2/tools/ci.sh makes (target/wasm-load/pkg), as the page loads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { encode } from 'cborg';
import type { NodeRec } from '../source/source.ts';
import { WorldView } from './world.ts';
import { CoursePlace, facing, yawOf, type CourseAt } from './course.ts';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = resolve(v2, process.env.V2_REPLICA_PKG ?? 'target/wasm-load/pkg');
assert.ok(existsSync(join(pkg, 'replica.js')), `${pkg}: run v2/tools/ci.sh's wasm steps`);
const replica = await import(pathToFileURL(join(pkg, 'replica.js')).href);
replica.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
const courseAt: CourseAt = replica.courseAt;

const S = 1_000_000, M = 1_000_000;
/** A loop on the water: 2 s at the landing (0, 0, 0), then 10 m east at 1 m/s and back; it starts at world 100 s. */
const loop = encode(new Map<number, unknown>([
  [1, [[[0, 0, 0], 2 * S], [[10 * M, 0, 0], 0]]],
  [2, 1],
  [3, 1 * M],
  [4, 100 * S],
  [5, 30 * S],
]));
const ROT: NodeRec['rot'] = [1 << 30, 0, 0, 0];
const node = (id: string, parent: string | null, extra: Partial<NodeRec> = {}): NodeRec =>
  ({ id, kind: 'souls:item@x', parent, slot: null, pos: [0, 0, 0], rot: ROT, at: null, ...extra });

test('courseAt gives the place and velocity on the course at a world time', () => {
  const p = courseAt(loop, BigInt(107 * S)); // 2 s at the landing, then 5 s rowed east
  assert.deepEqual([...p], [5 * M, 0, 0, 1 * M, 0, 0]);
  const back = courseAt(loop, BigInt(117 * S)); // 2 + 10 out, 5 back
  assert.deepEqual([...back], [5 * M, 0, 0, -1 * M, 0, 0]);
  assert.throws(() => courseAt(loop, BigInt(50 * S)), /before-track-start/);
  assert.throws(() => courseAt(encode(7), 0n), /schedule-malformed/);
});

test('a punt on a course moves at world time, and its rider and what it carries move with it', () => {
  const w = new WorldView();
  w.courseAt = courseAt;
  let asked = 0;
  w.onCourse = () => void asked++;
  w.apply([
    node('root', null, { kind: 'souls:place@x' }),
    node('punt', 'root', { pos: [-3 * M, 0, 4 * M], course: loop }),
    node('oar', 'punt', { pos: [500_000, 0, 0] }),
    node('rider', 'punt', { kind: 'souls:body@x', pos: [0, 300_000, 0], at: 1 }),
    node('bench', 'root', { pos: [20 * M, 0, 0] }),
  ], []);
  assert.equal(asked, 1, 'the page loads courseAt once, when the first course arrives');
  assert.deepEqual(w.moving().sort(), ['oar', 'punt']);
  w.draw(107 * S);
  const at = (id: string) => new THREE.Vector3().setFromMatrixPosition(w.frame(id)).toArray().map((v) => +v.toFixed(6));
  assert.deepEqual(at('punt'), [5, 0, 0]);
  assert.deepEqual(at('oar'), [5.5, 0, 0]);
  assert.deepEqual(at('bench'), [20, 0, 0], 'what is not on the course stays');
  assert.deepEqual(w.crowd(107 * S)!.toArray().map((v) => +v.toFixed(6)), [5, 0.3, 0], 'the rider sits in the punt');
  w.draw(109 * S);
  assert.deepEqual(at('punt'), [7, 0, 0]);
  assert.deepEqual(w.crowd(109 * S)!.toArray().map((v) => +v.toFixed(6)), [7, 0.3, 0]);
});

test('a course that throws leaves the punt and its rider where they were placed', () => {
  const w = new WorldView();
  w.courseAt = courseAt;
  w.apply([
    node('root', null, { kind: 'souls:place@x' }),
    node('punt', 'root', { pos: [-3 * M, 0, 4 * M], course: loop }),
    node('rider', 'punt', { kind: 'souls:body@x', pos: [0, 300_000, 0], at: 1 }),
  ], []);
  w.draw(50 * S); // before the track starts
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(w.frame('punt')).toArray(), [-3, 0, 4]);
  assert.deepEqual(w.crowd(50 * S)!.toArray().map((v) => +v.toFixed(6)), [-3, 0.3, 4]);
  w.apply([node('punt', 'root', { pos: [-3 * M, 0, 4 * M], course: new Uint8Array([0xff]) })], []);
  w.draw(107 * S); // a field that is not a course
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(w.frame('punt')).toArray(), [-3, 0, 4]);
  w.apply([node('punt', 'root', { pos: [-3 * M, 0, 4 * M], course: loop })], []);
  w.courseAt = null; // not loaded yet
  w.draw(107 * S);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(w.frame('punt')).toArray(), [-3, 0, 4]);
});

test('a punt turns to face its way at most 0.5 rad a second, and back to its own way when it stops', () => {
  const placed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1);
  const c = new CoursePlace();
  c.at(courseAt, loop, 107 * S, [0, 0, 0], placed);
  assert.ok(Math.abs(yawOf(c.rot) - facing(1, 0)) < 1e-9, 'first seen moving: faces its way');
  c.at(courseAt, loop, 101 * S, [0, 0, 0], placed); // 6 s earlier: a cut, so it turns at once
  assert.ok(Math.abs(yawOf(c.rot) - 1) < 1e-9, 'at the landing: its own way');
  c.at(courseAt, loop, 101.5 * S, [0, 0, 0], placed);
  assert.ok(Math.abs(yawOf(c.rot) - 1) < 1e-9);
  c.at(courseAt, loop, 102.5 * S, [0, 0, 0], placed); // rowing east now; 1 s of turning
  assert.ok(Math.abs(yawOf(c.rot) - 0.5) < 1e-9, `turned half a radian, ${yawOf(c.rot)}`);
});
