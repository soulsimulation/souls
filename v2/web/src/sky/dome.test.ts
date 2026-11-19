// V19b (#3508): the dome's moon and stars against today's page, and its uniforms as functions of the record.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { skyBodies } from './astro.ts';
import { SkyDome } from './dome.ts';
import { GRADE_A, GRADE_B, setGrade } from './grade.ts';
import { noiseBytes } from './noise.ts';
import { F, readSky, skyFields } from './record.ts';
import { WorldSky } from './sky.ts';

// Today's modules read the page's address when loaded: a world's page, as on soul.game. They are loaded by address, so
// this package's type check does not take in today's page.
Object.assign(globalThis, { location: new URL('http://localhost/w/eden/') });
const today = (path: string) => import(String(new URL(`../../../../apps/web/src/${path}`, import.meta.url)));
const { setEquatorSun } = await today('sun-site.ts');
const { setSiteNorthOffset } = await today('site-north.ts');
const { skyBodies: todayBodies } = await today('atmosphere/astro.ts');
const { makeAtmosphereNoise } = await today('atmosphere/chunks.ts');
const { SkyDome: TodayDome } = await today('atmosphere/sky.ts');
const todayGrade = await today('atmosphere/grade.ts');

const HOUR = 3_600_000_000;
const ORIGIN = Date.UTC(2026, 10, 18, 8) * 1000; // local midnight, 18 Nov 2026, a zone 8 hours behind UTC
const record = (weather: string, levels: [number, number, number]) => readSky(skyFields(new Map<number, unknown>([[F.dayS, 86_400], [F.origin, ORIGIN], [F.offsets, [[0, -8 * HOUR]]],
  [F.light, 'souls:day'], [F.lightNext, 18 * HOUR], [F.weather, weather], [F.cloud, levels[0]], [F.rain, levels[1]], [F.wind, levels[2]], [F.weatherNext, 30 * HOUR]]))!)!;
const deg = (a: THREE.Vector3, b: THREE.Vector3) => (a.angleTo(b) * 180) / Math.PI;

test('A1: the moon, its phase and the star field match today\'s page at the same local time', () => {
  // Today's real-time entity world: the equator sun on the local clock, north = -z.
  setEquatorSun(true);
  setSiteNorthOffset(0);
  const r = record('souls:clear', [10, 0, 10]);
  for (const h of [5.5, 12, 17.25, 22]) {
    const iso = `2026-11-18T${String(Math.floor(h)).padStart(2, '0')}:${String((h % 1) * 60).padStart(2, '0')}:00`;
    const today = todayBodies(iso)!, ours = skyBodies(r, h * HOUR);
    const star = new THREE.Vector3(0.3, 0.8, -0.5).normalize();
    const off = { sun: deg(ours.sun, today.sun), moon: deg(ours.moon, today.moon), stars: deg(star.clone().applyMatrix3(ours.starRotation), star.clone().applyMatrix3(today.starRotation)) };
    console.log(`A1: ${iso}: sun ${off.sun.toFixed(3)}°, moon ${off.moon.toFixed(3)}°, stars ${off.stars.toFixed(3)}° apart; lit ${ours.illumination.toFixed(3)} (today ${today.illumination.toFixed(3)})`);
    assert.ok(off.sun < 0.01 && off.moon < 0.01 && off.stars < 0.01, iso);
    assert.ok(Math.abs(ours.illumination - today.illumination) < 1e-9);
  }
});

test('A1: the dome is today\'s: the same shaders, uniforms and geometry', () => {
  const ours = new SkyDome().mesh, theirs = new TodayDome().mesh;
  assert.equal(ours.material.vertexShader, theirs.material.vertexShader);
  assert.equal(ours.material.fragmentShader, theirs.material.fragmentShader);
  assert.deepEqual(Object.keys(ours.material.uniforms).sort(), Object.keys(theirs.material.uniforms).sort());
  assert.deepEqual([ours.geometry.parameters.radius, ours.renderOrder, ours.material.side, ours.material.depthWrite], [theirs.geometry.parameters.radius, theirs.renderOrder, theirs.material.side, theirs.material.depthWrite]);
  console.log(`A1: the dome's fragment shader, ${ours.material.fragmentShader.length} characters, equals today's`);
});

test('A1: the colour grade is today\'s at noon, golden hour, the blue hour and night, clear and overcast', () => {
  for (const [day, warmth, blue, cloud] of [[1, 0, 0, 0.1], [0.5, 0.9, 0, 0.1], [0.1, 1, 0.8, 0.9], [0, 1, 0, 0.1]]) {
    setGrade(day, warmth, blue, cloud);
    todayGrade.setGrade(day, warmth, blue, cloud);
    assert.deepEqual([GRADE_A, GRADE_B], [todayGrade.GRADE_A, todayGrade.GRADE_B]);
  }
});

test('A1: the dome\'s noise is today\'s, byte for byte', () => {
  const today = makeAtmosphereNoise(128).image.data as Uint8Array;
  assert.deepEqual(noiseBytes(128), today);
});

test('A1: stars at a clear night, none by day or under rain cloud; the moon up at night; clouds follow the cover', () => {
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
