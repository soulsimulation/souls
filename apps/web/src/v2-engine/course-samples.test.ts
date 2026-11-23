// K4 (0.135): the places a worker posts for a node on a course, and the page's reading of them (course-samples.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coursePlaces, keepPlaces, placeAt, type CourseAt } from './course-samples.ts';

const up: CourseAt = (_f, t) => [0n, t / 1000n, 0n, 0n, 0n, 0n];   // rises 1 µm each ms of world time

test('a worker posts a node\'s places a step apart, both ends included; a node with no course, or a refused one, is left out', () => {
  const nodes = [{ id: 'a', course: new Uint8Array([1]) }, { id: 'b' }, { id: 'c', course: new Uint8Array([2]) }];
  const read: CourseAt = (f, t) => { if (f[0] === 2) throw new Error('course-bad'); return up(f, t); };
  const p = coursePlaces(read, nodes, 1_050_000, 1_300_000, 100_000);
  assert.deepEqual(Object.keys(p), ['a']);
  assert.deepEqual(p.a.filter((_, i) => i % 4 === 0), [1_000_000, 1_100_000, 1_200_000, 1_300_000]);
});

test('the page reads a place between two posted ones, and the first or last outside them', () => {
  const flat = [0, 0, 0, 0, 100, 10, 20, 30];
  assert.deepEqual(placeAt(flat, 50), [5, 10, 15]);
  assert.deepEqual(placeAt(flat, -5), [0, 0, 0]);
  assert.deepEqual(placeAt(flat, 500), [10, 20, 30]);
  assert.equal(placeAt(undefined, 5), null);
});

test('places are kept in time order across parts and dropped before the cut, the last before it kept', () => {
  const held = new Map<string, number[]>();
  keepPlaces(held, { a: [0, 0, 0, 0, 100, 1, 1, 1] });
  keepPlaces(held, { a: [100, 2, 2, 2, 200, 3, 3, 3] });
  assert.deepEqual(held.get('a')!.filter((_, i) => i % 4 === 0), [0, 100, 200], 'the later part\'s place at 100 replaces the earlier one');
  assert.deepEqual(placeAt(held.get('a'), 100), [2, 2, 2]);
  keepPlaces(held, undefined, 150);
  assert.deepEqual(held.get('a')!.filter((_, i) => i % 4 === 0), [100, 200]);
});
