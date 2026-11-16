import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { shotScore, walkingDrift } from '../src/shot-score.ts';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const base = { heading: v(0, 0, 1), held: null, asked: v(0, 2, 8), fov: 50 * Math.PI / 180 };

test('#2201 A4: face on beats profile beats the back of the head; unknown facing is neutral', () => {
  const at = (theta: number) => new THREE.Vector3().setFromSpherical(new THREE.Spherical(8.2, 1.33, theta));
  const front = shotScore(at(0), base).parts.face, side = shotScore(at(Math.PI / 2), base).parts.face, back = shotScore(at(Math.PI), base).parts.face;
  assert.equal(front, 1); assert.ok(Math.abs(side - .8) < 1e-9); assert.ok(back < 1e-9);
  assert.equal(shotScore(at(Math.PI), { ...base, heading: null }).parts.face, .5);
});

test('#2201 A4: sky behind the head by geometry from below it; above it the ray decides', () => {
  assert.equal(shotScore(v(0, .3, 6), base).parts.sky, 1, 'low and looking a little up');
  assert.equal(shotScore(v(0, 3, 8), { ...base, sky: true }).parts.sky, 1);
  assert.equal(shotScore(v(0, 3, 8), { ...base, sky: false }).parts.sky, 0);
  assert.equal(shotScore(v(0, 3, 8), base).parts.sky, .5, 'not cast: neutral');
});

test('#2201 A4: the sun lights the face from the camera side, never shines into the lens; night ignores it', () => {
  const eye = v(0, 2, 8), sunBehindCamera = v(0, 1, 1).normalize(), sunInLens = v(0, .5, -1).normalize();
  const lit = shotScore(eye, { ...base, sun: sunBehindCamera, daylight: 1 }), glare = shotScore(eye, { ...base, sun: sunInLens, daylight: 1 });
  assert.ok(lit.parts.sun > .9, `front lit ${lit.parts.sun}`); assert.equal(glare.parts.sun, 0);
  assert.ok(lit.total > glare.total);
  const night = shotScore(eye, { ...base, sun: sunInLens, daylight: .1 }), none = shotScore(eye, base);
  assert.equal(night.total, none.total, 'no sun weight at night');
  assert.equal(shotScore(eye, { ...base, sun: v(0, .05, -1).normalize(), daylight: 1 }).parts.sun, .5, 'golden hour: neutral');
});

test('#2201 A4: framing prefers a body filling 30-60 % of the frame, and looking down steeply costs at most half', () => {
  const near = shotScore(v(0, 1, 2.5), base).parts.framing, mid = shotScore(v(0, 1, 3), base).parts.framing, far = shotScore(v(0, 3, 30), base).parts.framing;
  assert.equal(mid, 1); assert.ok(far < mid && near <= mid);
  const steep = shotScore(v(0, 3.4, 1.2), base).parts.framing;
  assert.ok(steep >= .5 * shotScore(v(0, 1.2, 3.4), base).parts.framing - 1e-9 && steep < 1);
});

test('#2201 A4: stay and asked; forced drops stay and doubles asked', () => {
  const held = v(0, 6, 4), asked = v(0, 2, 8);
  const atHeld = { ...base, held, asked }, stayHeld = shotScore(held, atHeld).total, goAsked = shotScore(asked, atHeld).total;
  const forced = { ...atHeld, forced: true };
  assert.ok(shotScore(asked, forced).total - shotScore(held, forced).total > goAsked - stayHeld, 'forced, the asked-for view gains on the held one');
  assert.equal(shotScore(held, atHeld).parts.stay, 1);
});

test('#2201 A4: the walking drift sits about 110 degrees off the heading, on the nearer side', () => {
  const heading = v(0, 0, 1);  // walking toward +z: straight behind is theta = pi
  const left = walkingDrift(heading, 2), right = walkingDrift(heading, -2);
  assert.ok(Math.abs(left - 110 * Math.PI / 180) < 1e-9 && Math.abs(right + 110 * Math.PI / 180) < 1e-9);
  const face = shotScore(new THREE.Vector3().setFromSpherical(new THREE.Spherical(8, 1.3, left)), base).parts.face;
  assert.ok(face > .7, `the face in profile from the drift: ${face.toFixed(2)}`);
});
