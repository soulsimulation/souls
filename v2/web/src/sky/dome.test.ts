// V19b (#3508) A1: the dome, its noise, the grade, the moon and the stars against today's page (`today-parity.json`:
// today's outputs pinned at the port), and the dome's uniforms as functions of the record.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { skyBodies } from './astro.ts';
import { SkyDome } from './dome.ts';
import { GRADE_A, GRADE_B, setGrade } from './grade.ts';
import { noiseBytes } from './noise.ts';
import { F, readSky, skyFields } from './record.ts';
import { WorldSky } from './sky.ts';

const TODAY = JSON.parse(readFileSync(new URL('./today-parity.json', import.meta.url), 'utf8'));
const sha = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex');
const HOUR = 3_600_000_000;
const ORIGIN = Date.UTC(2026, 10, 18, 8) * 1000; // local midnight, 18 Nov 2026, a zone 8 hours behind UTC
const record = (weather: string, levels: [number, number, number]) => readSky(skyFields(new Map<number, unknown>([[F.dayS, 86_400], [F.origin, ORIGIN], [F.offsets, [[0, -8 * HOUR]]],
  [F.light, 'souls:day'], [F.lightNext, 18 * HOUR], [F.weather, weather], [F.cloud, levels[0]], [F.rain, levels[1]], [F.wind, levels[2]], [F.weatherNext, 30 * HOUR]]))!)!;
const deg = (a: THREE.Vector3, b: number[]) => (a.angleTo(new THREE.Vector3(...b)) * 180) / Math.PI;

test('A1: the moon, its phase and the star field match today\'s page at the same local time', () => {
  // Today's real-time entity world (the equator sun on the local clock, north = -z) on 18 Nov 2026.
  const r = record('souls:clear', [10, 0, 10]);
  for (const [hm, today] of Object.entries(TODAY.bodies) as [string, { sun: number[]; moon: number[]; star: number[]; illumination: number }][]) {
    const [h, m] = hm.split(':').map(Number), ours = skyBodies(r, (h + m / 60) * HOUR);
    const star = new THREE.Vector3(0.3, 0.8, -0.5).normalize().applyMatrix3(ours.starRotation);
    const off = { sun: deg(ours.sun, today.sun), moon: deg(ours.moon, today.moon), stars: deg(star, today.star) };
    console.log(`A1: 2026-11-18 ${hm}: sun ${off.sun.toFixed(3)}°, moon ${off.moon.toFixed(3)}°, stars ${off.stars.toFixed(3)}° from today's; lit ${ours.illumination.toFixed(3)} (today ${today.illumination.toFixed(3)})`);
    assert.ok(off.sun < 0.01 && off.moon < 0.01 && off.stars < 0.01, hm);
    assert.ok(Math.abs(ours.illumination - today.illumination) < 1e-9);
  }
});

test('A1: the dome is today\'s: the same shaders and uniforms', () => {
  const m = new SkyDome().mesh.material;
  assert.equal(sha(m.vertexShader), TODAY.dome.vertex);
  assert.equal(sha(m.fragmentShader), TODAY.dome.fragment);
  assert.deepEqual(Object.keys(m.uniforms).sort(), TODAY.dome.uniforms);
  console.log(`A1: the dome's fragment shader, ${m.fragmentShader.length} characters, equals today's`);
});

test('A1: the colour grade is today\'s at noon, golden hour, the blue hour and night, clear and overcast', () => {
  for (const [i, [day, warmth, blue, cloud]] of [[1, 0, 0, 0.1], [0.5, 0.9, 0, 0.1], [0.1, 1, 0.8, 0.9], [0, 1, 0, 0.1]].entries()) {
    setGrade(day, warmth, blue, cloud);
    assert.deepEqual(JSON.parse(JSON.stringify([GRADE_A, GRADE_B])), TODAY.grade[i]); // as pinned (JSON has no -0)
  }
});

test('A1: the dome\'s noise is today\'s, byte for byte', () => {
  assert.equal(sha(noiseBytes(128)), TODAY.noise);
});

test('A1: stars at a clear night, none by day or under rain cloud; the sun\'s disc by day; clouds follow the cover', () => {
  const sky = (weather: string, levels: [number, number, number], h: number) => {
    const s = new WorldSky(new THREE.Scene(), new THREE.HemisphereLight(), new THREE.DirectionalLight(), false);
    s.apply([{ sky: skyFields(new Map<number, unknown>([[F.dayS, 86_400], [F.origin, ORIGIN], [F.offsets, [[0, -8 * HOUR]]], [F.weather, weather], [F.cloud, levels[0]], [F.rain, levels[1]], [F.wind, levels[2]]])) }]);
    s.update(h * HOUR, new THREE.PerspectiveCamera());
    return s.dome.uniforms;
  };
  const night = sky('souls:clear', [10, 0, 10], 23), noon = sky('souls:clear', [10, 0, 10], 12), wet = sky('souls:rain', [90, 60, 30], 23);
  console.log(`A1: stars clear night ${night.uBow.value.y.toFixed(3)}, noon ${noon.uBow.value.y.toFixed(3)}, rain night ${wet.uBow.value.y.toFixed(3)}; cover clear ${night.uCloud.value.x.toFixed(2)}, rain ${wet.uCloud.value.x.toFixed(2)}; sun disc noon ${noon.uSun.value.w.toFixed(2)}`);
  assert.ok(night.uBow.value.y > 0.3 && noon.uBow.value.y === 0 && wet.uBow.value.y === 0);
  assert.ok(noon.uSun.value.w === 1 && night.uSun.value.w === 0);
  assert.ok(wet.uCloud.value.x > 0.9 && night.uCloud.value.x < 0.3);
});
