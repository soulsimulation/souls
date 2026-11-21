// #3795: `?hour=HH:MM` draws the sky at a chosen local hour; `?shot` gives today's ready signal.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { shotSignal } from '../capture/capture.ts';
import { hourTime, parseHour } from './hour.ts';
import { F, localAt, readSky, skyFields } from './record.ts';
import { WorldSky } from './sky.ts';

const HOUR = 3_600_000_000;
/** A real-time world in New York's zone, world time 0 at local midnight on 19 Nov 2026 (as present.test.ts). */
const ORIGIN = Date.UTC(2026, 10, 19, 5) * 1000;
const fields = (dayS = 86_400) => skyFields(new Map<number, unknown>([[F.dayS, dayS], [F.origin, ORIGIN], [F.offsets, [[0, -5 * HOUR]]], [F.light, 'souls:day'],
  [F.lightNext, 18 * HOUR], [F.weather, 'souls:clear'], [F.cloud, 10], [F.rain, 0], [F.wind, 10], [F.weatherNext, 2 * HOUR]]))!;
const timeOfDay = (local: number) => ((local % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR);

test('A1: the address names an hour as HH:MM; anything else is none', () => {
  assert.equal(parseHour('?shot=1&hour=21:30'), 21 * 60 + 30);
  assert.equal(parseHour('?hour=00:00'), 0);
  for (const bad of ['', '?hour=', '?hour=24:00', '?hour=9:30', '?hour=21:60', '?hour=dusk']) assert.equal(parseHour(bad), null, bad);
});

test('A1: the hour keeps the local day and replaces the time of day, on a 24-hour and a shorter day', () => {
  for (const dayS of [86_400, 3_600]) {
    const r = readSky(fields(dayS))!;
    for (const t of [0, 13 * HOUR + 1234, 40 * HOUR]) {
      const local = localAt(r, t), at = localAt(r, hourTime(r, t, 21 * 60 + 30));
      assert.equal(Math.floor(at / (24 * HOUR)), Math.floor(local / (24 * HOUR)), `same day, ${dayS} ${t}`);
      assert.ok(Math.abs(timeOfDay(at) - 21.5 * HOUR) < 60_000_000, `21:30, ${dayS} ${t}: ${timeOfDay(at) / HOUR}`);
    }
  }
});

test('A1: the sky draws night at noon with ?hour=23:00, and the world time it is given is not changed', () => {
  const scene = new THREE.Scene(), sky = new WorldSky(scene, new THREE.HemisphereLight(), new THREE.DirectionalLight(), false), cam = new THREE.PerspectiveCamera();
  sky.apply([{ sky: fields() }]);
  const noon = 12 * HOUR;
  sky.update(noon, cam);
  const day = sky.state.daylight;
  sky.hour = 23 * 60;
  sky.update(noon, cam);
  assert.ok(day > 0.9 && sky.state.daylight < 0.05, `day ${day}, at 23:00 ${sky.state.daylight}`);
  assert.equal(sky.recordAt(noon), sky.recordAt(noon + 1), 'the record in force is read at world time');
  sky.hour = null;
  sky.update(noon, cam);
  assert.equal(sky.state.daylight, day);
});

test("A1: ?shot titles the page 'loading', then 'ready' two frames after it is ready, once, with today's signal", () => {
  const events: string[] = [];
  const win = { document: { title: '' }, dispatchEvent: (e: Event) => (events.push(e.type), true) } as { document: { title: string }; dispatchEvent(e: Event): boolean; __shotReady?: boolean };
  const s = shotSignal(new URLSearchParams('shot=1&hour=21:00'), win as never);
  assert.equal(win.document.title, 'loading');
  s.frame(false); s.frame(true); s.frame(false);
  assert.equal(win.document.title, 'loading');
  s.frame(false);
  assert.deepEqual([win.document.title, win.__shotReady, events], ['ready', true, ['sim-shot-ready']]);
  s.frame(true); s.frame(true); s.frame(true);
  assert.deepEqual(events, ['sim-shot-ready']);
  const plain = { document: { title: 'Souls' }, dispatchEvent: () => true };
  shotSignal(new URLSearchParams('hour=21:00'), plain as never).frame(true);
  assert.equal(plain.document.title, 'Souls');
});
