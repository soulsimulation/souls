// C2 (#3674): the guided Eden tour's flights and holds, the welcome card's remembered dismissal, and which world gets
// the tour. The tour is camera poses only; nothing here touches a world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PoseFlight, flightSeconds } from './flight.ts';
import { HOLD_S, PUSH, Tour } from '../welcome/tour.ts';
import { EDEN_STOPS, type Stop } from '../welcome/stops.ts';
import { SEEN_KEY, remember, seen, worldOf } from '../welcome/welcome.ts';

const v = (a: readonly number[]) => new THREE.Vector3(...a);
const near = (a: THREE.Vector3, b: THREE.Vector3, m = 1e-6) => assert.ok(a.distanceTo(b) < m, `${a.toArray()} vs ${b.toArray()}`);

test('A2: a pose flight starts at the camera, ends at the view, and is timed as a flight to a Soul', () => {
  const f = new PoseFlight(v([0, 10, 0]), v([0, 0, -10]), v([60, 10, 0]), v([60, 0, -10]));
  assert.equal(f.seconds, flightSeconds(60, 0));
  const first = f.step(0);
  near(first.eye, v([0, 10, 0]));
  assert.equal(first.done, false);
  const mid = f.step(f.seconds / 2);
  near(mid.eye, v([30, 10, 0]));
  const end = f.step(f.seconds);
  assert.equal(end.done, true);
  near(end.eye, v([60, 10, 0]));
  near(end.target, v([60, 0, -10]));
});

const stops: Stop[] = [
  { id: 'a', label: 'A', p: [0, 20, 40], target: [0, 0, 0] },
  { id: 'b', label: 'B', p: [100, 20, 40], target: [100, 0, 0] },
];

test('A2: the tour flies to each stop from where the camera is, holds, drifts in along the sightline, then ends', () => {
  const tour = new Tour(stops, v([-50, 30, 0]), v([0, 0, 0]));
  let pose = tour.step(0);
  near(pose.eye, v([-50, 30, 0]));
  assert.equal(pose.stop.id, 'a');
  // Through the first flight to the stop's own view.
  for (let i = 0; i < 300 && pose.eye.distanceTo(v(stops[0].p)) > 1e-6; i++) pose = tour.step(1 / 60);
  near(pose.eye, v(stops[0].p));
  // The hold drifts PUSH of the way along the sightline and keeps looking at the stop.
  for (let s = 0; s < HOLD_S - 0.05; s += 0.05) pose = tour.step(0.05);
  assert.equal(pose.stop.id, 'a');
  near(pose.target, v(stops[0].target));
  near(pose.eye, v(stops[0].p).lerp(v(stops[0].target), PUSH), 0.01);
  // Then on to the next stop, from where the camera is: no jump.
  const before = pose.eye.clone();
  pose = tour.step(0.1);
  pose = tour.step(0);
  assert.equal(pose.stop.id, 'b');
  assert.ok(pose.eye.distanceTo(before) < 1, 'the flight on starts where the hold ended');
  let done = false;
  for (let i = 0; i < 2000 && !done; i++) done = tour.step(1 / 30).done;
  assert.equal(done, true, 'the tour ends after the last stop');
});

test('A2: Next skips to the following stop at once; after the last stop it says no', () => {
  const tour = new Tour(stops, v([0, 0, 0]), v([0, 0, -1]));
  assert.equal(tour.next(), true);
  assert.equal(tour.step(0).stop.id, 'b');
  assert.equal(tour.next(), false);
});

test('A2: the Eden tour carries today\'s Explore views of Eden outside, starting with all of Eden', () => {
  assert.equal(EDEN_STOPS[0].id, 'overview');
  assert.equal(new Set(EDEN_STOPS.map((s) => s.id)).size, EDEN_STOPS.length);
  assert.equal(EDEN_STOPS.length, 31);
  for (const s of EDEN_STOPS) assert.ok(v(s.p).distanceTo(v(s.target)) > 1, s.id);
  for (const inside of ['gallery', 'libraryroom', 'homecourtyard']) assert.ok(!EDEN_STOPS.some((s) => s.id === inside));
});

test('A1: the card is remembered as dismissed; a storage that fails shows it again instead of failing', () => {
  const box = new Map<string, string>();
  const store = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, val: string) => void box.set(k, val) };
  assert.equal(seen(() => store), false);
  remember(() => store);
  assert.equal(box.get(SEEN_KEY), '1');
  assert.equal(seen(() => store), true);
  const broken = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(seen(() => broken), false);
  assert.doesNotThrow(() => remember(() => broken));
  assert.equal(seen(() => { throw new Error('no storage'); }), false);
  assert.equal(seen(() => null), false);
});

test('A1: the world named on the card, and Eden found by its imported things on a local stream', () => {
  const none = () => [] as string[];
  assert.equal(worldOf('/w/eden/', new URLSearchParams(), none), 'eden');
  assert.equal(worldOf('/preview/w/mars-college/', new URLSearchParams(), () => ['eden:hill@1']), 'mars-college');
  assert.equal(worldOf('/', new URLSearchParams('world=rna-studio'), none), 'rna-studio');
  assert.equal(worldOf('/', new URLSearchParams('stream=/s/x/'), () => ['souls:place@1', 'eden:hill@2']), 'eden');
  assert.equal(worldOf('/', new URLSearchParams('stream=/s/x/'), () => ['test:wall']), null);
});
