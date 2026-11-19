// V9 (#2719): the link to a moment and the history clock's way back to live.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { cameraAt, placeCamera, readCamera } from '../camera/link.ts';
import { BEHIND_US } from '../clock/clock.ts';
import { FAR_US, FAST, HistoryClock } from './clock.ts';
import { readMoment, writeMoment } from './link.ts';

test('A4: the link carries world, lineage, world time in µs and a camera in its fragment, and nothing else', () => {
  const m = { world: 'cd5c-0', lineage: 'cd5c', at: 90_000_000, camera: { node: 'cd5c.0', eye: [-6_505_317, 30_000_000, 136_763_564] as [number, number, number], target: [33_494_683, 0, 96_763_564] as [number, number, number] } };
  const frag = writeMoment(m);
  assert.ok(frag.startsWith('#'));
  assert.deepEqual([...new URLSearchParams(frag.slice(1)).keys()], ['w', 'l', 't', 'c']);
  assert.deepEqual(readMoment(frag), m);
  assert.equal(readMoment('#w=a&t=5'), null, 'no lineage: not a moment (a fork is another lineage)');
});

test('a camera framed on a moving node keeps its place in that frame', () => {
  const boat = new THREE.Matrix4().compose(new THREE.Vector3(10, 0, -4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7), new THREE.Vector3(1, 1, 1));
  const c = cameraAt('boat.7', boat, new THREE.Vector3(12, 5, 3), new THREE.Vector3(10, 1, -4));
  assert.deepEqual(readCamera(`${c.node}~${c.eye.join(',')}~${c.target.join(',')}`), c);
  const p = placeCamera(c, boat);
  assert.ok(p.eye.distanceTo(new THREE.Vector3(12, 5, 3)) < 1e-5 && p.target.distanceTo(new THREE.Vector3(10, 1, -4)) < 1e-5);
});

test('history plays at its speed, never past what is loaded, and holds when paused', () => {
  const c = new HistoryClock(1_000_000);
  assert.equal(c.step(500, 10_000_000).t, 1_500_000);
  c.speed = 4;
  assert.equal(c.step(1000, 10_000_000).t, 5_500_000);
  assert.equal(c.step(5000, 10_000_000).t, 10_000_000);
  assert.equal(c.state, 'holding: loading');
  c.paused = true;
  assert.equal(c.step(1000, 99_000_000).t, 10_000_000);
});

test('A3: back to live from near plays fast with no jump and hands over at the live point', () => {
  const live = 600_000_000, c = new HistoryClock(live - BEHIND_US - 60_000_000);
  c.returning = true;
  let last = c.t, frames = 0, r = { t: c.t, live: false };
  while (!r.live && frames < 10_000) {
    r = c.step(1000 / 60, last + 10_000_000, live + frames * 16_667, live + frames * 16_667);
    // Each frame moves at most FAST times real time: no jump.
    assert.ok(r.t - last <= (1000 / 60) * 1000 * FAST + 1);
    last = r.t;
    frames++;
  }
  assert.ok(r.live && !c.cut);
  assert.ok(Math.abs(r.t - (live + (frames - 1) * 16_667 - BEHIND_US)) <= 1000);
});

test('A3: back to live from far is one visible cut, once the live stream reaches the live point', () => {
  const live = 3_600_000_000, c = new HistoryClock(60_000_000);
  c.returning = true;
  assert.deepEqual(c.step(16, 70_000_000, live, null), { t: 60_000_000, live: false });
  assert.equal(c.state, 'waiting for live');
  const r = c.step(16, 70_000_000, live, live);
  assert.deepEqual(r, { t: live - BEHIND_US, live: true });
  assert.ok(c.cut && live - BEHIND_US - 60_000_000 > FAR_US);
});
