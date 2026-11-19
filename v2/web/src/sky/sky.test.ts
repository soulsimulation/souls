// V19 (#2763): the sun against today's page, and the sky as a function of the record and the world time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { losAngelesUtcOffsetHours, solarPosition } from '../../../../mars/viewer/engine/env/sun.ts';
import { F, readSky, skyFields, type SkyFields } from './record.ts';
import { WorldSky } from './sky.ts';
import { NORTH, sunAt } from './sun.ts';

const HOUR = 3_600_000_000;
/** A real-time world whose world time 0 is local midnight of 18 Nov 2026 in a zone 8 hours behind UTC (Pacific
 *  standard time, today's page's zone that day), as the world node's fields hold it. */
const ORIGIN = Date.UTC(2026, 10, 18, 8) * 1000;
const fields = (weather: string, levels: [number, number, number], next: number): SkyFields =>
  skyFields(new Map<number, unknown>([[F.dayS, 86_400], [F.origin, ORIGIN], [F.offsets, [[0, -8 * HOUR]]], [F.light, 'souls:day'], [F.lightNext, 18 * HOUR],
    [F.weather, weather], [F.cloud, levels[0]], [F.rain, levels[1]], [F.wind, levels[2]], [F.weatherNext, next]]))!;

const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * (180 / Math.PI);

test('A1: the sun at four set hours is within one degree of today\'s page', () => {
  const r = readSky(fields('souls:clear', [10, 0, 10], 2 * HOUR))!;
  for (const h of [7, 10, 13, 16.5]) {
    // Today's page: its real-time world's equator sun on the world's local clock (`apps/web/src/sun-site.ts`).
    const iso = `2026-11-18T${String(Math.floor(h)).padStart(2, '0')}:${String((h % 1) * 60).padStart(2, '0')}:00`;
    const today = solarPosition(iso, 0, 15 * losAngelesUtcOffsetHours(2026, 11, 18, 12), NORTH);
    const ours = sunAt(r, h * HOUR);
    const off = angle(ours.direction, today.direction);
    console.log(`A1: ${iso} local: elevation ${ours.elevationDeg.toFixed(2)}° (today ${today.elevationDeg.toFixed(2)}°), azimuth ${ours.azimuthDeg.toFixed(2)}° (today ${today.azimuthDeg.toFixed(2)}°), apart ${off.toFixed(4)}°`);
    assert.ok(off <= 1, `${iso}: ${off}° from today's sun`);
  }
});

const view = () => {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 300, 1200);
  return new WorldSky(scene, new THREE.HemisphereLight(), new THREE.DirectionalLight(), false);
};
const cam = new THREE.PerspectiveCamera();
const drawn = (s: WorldSky, t: number) => (s.update(t, cam), { colour: s.state.background.getHexString(), rain: s.state.rain, rainOn: s.rain.mesh.visible });

test('A2: rain starts and stops at the world times of the weather effects, as parts arrive ahead of the drawing', () => {
  // The world: cloudy to 18:00, a shower 18:00 to 20:00, cloudy after. Parts are 1 s long and played 2 s ahead of the
  // time drawn, as the live page plays them.
  const s = view();
  s.apply([{ sky: fields('souls:cloudy', [75, 0, 20], 18 * HOUR) }], { from: 17.5 * HOUR, to: 17.5 * HOUR + 1e6 });
  s.apply([{ sky: fields('souls:rain', [90, 60, 30], 20 * HOUR) }], { from: 18 * HOUR - 1e6, to: 18 * HOUR });
  assert.equal(drawn(s, 18 * HOUR - 2e6).rain, 0, 'no rain before the effect, though its part is played');
  assert.equal(drawn(s, 18 * HOUR).rain, 1);
  assert.ok(drawn(s, 18 * HOUR).rainOn);
  s.apply([{ sky: fields('souls:cloudy', [75, 0, 20], 22 * HOUR) }], { from: 20 * HOUR - 0.5e6, to: 20 * HOUR + 0.5e6 });
  assert.equal(drawn(s, 20 * HOUR - 1).rain, 1, 'rain holds while the effect holds');
  assert.equal(drawn(s, 20 * HOUR).rain, 0, 'and stops with it');
  assert.equal(drawn(s, 20 * HOUR).rainOn, false);
  // A creator's weather (G5) is not the timer's: it holds from its part.
  s.apply([{ sky: fields('souls:storm', [100, 90, 80], 21 * HOUR) }], { from: 20.5 * HOUR, to: 20.5 * HOUR + 1e6 });
  assert.equal(drawn(s, 20.5 * HOUR - 1).rain, 0);
  assert.equal(drawn(s, 20.5 * HOUR).rain, 1);
});

test('A3: two seeks to one moment give the same sky colour and rain state, whatever was drawn before', () => {
  const at = 19.6 * HOUR; // dusk, in the shower
  const moment = [{ sky: fields('souls:rain', [90, 60, 30], 20 * HOUR) }];
  const a = view(), b = view();
  a.apply(moment);
  const first = drawn(a, at);
  // b plays the afternoon, draws noon and night, then seeks to the moment.
  b.apply([{ sky: fields('souls:clear', [10, 0, 10], 14 * HOUR) }], { from: 12 * HOUR, to: 12 * HOUR + 1e6 });
  drawn(b, 12 * HOUR);
  drawn(b, 23 * HOUR);
  b.apply(moment);
  const second = drawn(b, at);
  // and a seeks again after drawing elsewhere.
  drawn(a, 6 * HOUR);
  a.apply(moment);
  const third = drawn(a, at);
  console.log(`A3: at 19:36 local, sky #${first.colour}, rain ${first.rain}; seek 2 #${second.colour}, rain ${second.rain}; seek 3 #${third.colour}, rain ${third.rain}`);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.ok(first.rainOn);
});
