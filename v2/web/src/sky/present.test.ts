// V19c (#3521): Eden's sky as soul.game draws it: the presentation date, the palette and the morning mist carried on
// the world node and drawn from the record; a world without them draws as V19b.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { F, readSky, skyFields, type SkyFields } from './record.ts';
import { WorldSky, skyState } from './sky.ts';
import { sunAt } from './sun.ts';

const HOUR = 3_600_000_000;
/** soul.game's Eden on 19 Nov 2026: a real-time world in New York's zone (5 hours behind UTC that day), world time 0 at
 *  local midnight; with Eden's settings as import-eden writes them (06-05, eden-summer, today's morning mist). */
const ORIGIN = Date.UTC(2026, 10, 19, 5) * 1000;
const EDEN = [[F.skyDate, [6, 5]], [F.palette, 'souls:eden-summer'], [F.mist, [6.5 * HOUR, 2.5 * HOUR, 100]]] as const;
const fields = (eden: boolean, weather = 'souls:clear', levels = [10, 0, 10]): SkyFields =>
  skyFields(new Map<number, unknown>([[F.dayS, 86_400], [F.origin, ORIGIN], [F.offsets, [[0, -5 * HOUR]]], [F.light, 'souls:day'], [F.lightNext, 18 * HOUR],
    [F.weather, weather], [F.cloud, levels[0]], [F.rain, levels[1]], [F.wind, levels[2]], [F.weatherNext, 2 * HOUR], ...(eden ? EDEN : [])]))!;

/** soul.game's Eden page read on 19 Nov 2026 (`/w/eden/?shot=1&atmos=1&hour=…`, its atmosphere's `inspect().sun`):
 *  the direction toward the sun at four local hours, north = −z. */
const SOUL_GAME: [number, [number, number, number]][] = [
  [8, [0.7962331471687202, 0.46939845009564224, -0.3816777048736331]],
  [10, [0.4551759829086606, 0.8043741380777801, -0.3818338258650785]],
  [12, [-0.007759643456245511, 0.9241340859107915, -0.3819895014149705]],
  [15, [-0.6586035349414054, 0.6481881387200066, -0.3822218211789832]],
];
const elAz = (d: readonly number[]) => [Math.asin(d[1]) * (180 / Math.PI), ((Math.atan2(d[0], -d[2]) * 180) / Math.PI + 360) % 360];

test('A1: the record reads the sky date, palette and mist; malformed ones read as none', () => {
  const r = readSky(fields(true))!;
  assert.deepEqual([r.skyDate, r.palette, r.mist], [[6, 5], 'souls:eden-summer', [6.5 * HOUR, 2.5 * HOUR, 100]]);
  const bad = readSky({ ...fields(false), [F.skyDate]: [2, 30], [F.mist]: [25 * HOUR, HOUR, 50] })!;
  assert.deepEqual([bad.skyDate, bad.palette, bad.mist], [null, null, null]);
});

test("A2: on Eden's date the sun in November is soul.game's within 0.1 degrees", () => {
  const r = readSky(fields(true))!;
  for (const [h, want] of SOUL_GAME) {
    const [el, az] = elAz(sunAt(r, h * HOUR).direction), [wel, waz] = elAz(want);
    console.log(`A2: 19 Nov ${h}:00 local: elevation ${el.toFixed(3)} (soul.game ${wel.toFixed(3)}), azimuth ${az.toFixed(3)} (soul.game ${waz.toFixed(3)})`);
    assert.ok(Math.abs(el - wel) <= 0.1 && Math.abs(az - waz) <= 0.1, `${h}:00: ${el}, ${az} against ${wel}, ${waz}`);
  }
  // Without the date the sun is November's (V19b's): it stands south at noon.
  assert.ok(Math.abs(elAz(sunAt(readSky(fields(false))!, 12 * HOUR).direction)[1] - 180) < 15);
});

test("A2: the morning mist is soul.game's (0.45 at 06:30 and 0.18 at 08:00 in clear weather, none by 10:00)", () => {
  const r = readSky(fields(true))!;
  for (const [h, want] of [[6.5, 0.45], [8, 0.18], [10, 0]]) assert.ok(Math.abs(skyState(r, h * HOUR).mist - want) < 1e-9, `${h}: ${skyState(r, h * HOUR).mist}`);
  assert.equal(skyState(readSky(fields(true, 'souls:fog', [60, 0, 5]))!, 12 * HOUR).fogLevel, 1);
});

const view = () => {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 300, 1200);
  return { scene, sky: new WorldSky(scene, new THREE.HemisphereLight(), new THREE.DirectionalLight(), false) };
};
const cam = new THREE.PerspectiveCamera();
const drawn = (eden: boolean, weather: string, levels: number[], h: number) => {
  const { scene, sky } = view();
  sky.apply([{ sky: fields(eden, weather, levels) }]);
  sky.update(h * HOUR, cam);
  const u = sky.dome.uniforms;
  return { fog: scene.fog, bg: sky.state.background.getHexString(), fogColour: scene.fog!.color.getHexString(), zenith: u.uZenith.value.getHexString(), horizon: u.uHorizon.value.getHexString(), sun: sky.state.sun };
};

test('A2: the palette moves the dome toward its colours by day, and the air takes its fog', () => {
  const plain = drawn(false, 'souls:clear', [10, 0, 10], 12), eden = drawn(true, 'souls:clear', [10, 0, 10], 12);
  assert.notEqual(eden.zenith, plain.zenith);
  const zen = new THREE.Color(`#${eden.zenith}`), pal = new THREE.Color('#5f95c8');
  assert.ok(Math.abs(zen.r - pal.r) + Math.abs(zen.g - pal.g) + Math.abs(zen.b - pal.b) < 0.15, `zenith ${eden.zenith} toward the palette's #5f95c8`);
  assert.ok(eden.fog instanceof THREE.FogExp2 && eden.fog.density < 0.0009, 'eden-summer thins the clear air');
});

/** What the page draws, as numbers: the scene's fog and background, the lights, the shadow's direction and every dome
 *  uniform, at twelve moments of a world without V19c's settings. */
function drawnAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const v = (x: any): unknown => (typeof x?.toArray === 'function' ? x.toArray().map((n: number) => +n.toFixed(6)) : JSON.parse(JSON.stringify(x ?? null), (_, n) => (typeof n === 'number' ? +n.toFixed(6) : n)));
  for (const [weather, levels] of [['souls:clear', [10, 0, 10]], ['souls:rain', [90, 60, 30]], ['souls:fog', [60, 0, 5]]] as const)
    for (const h of [6.5, 12, 19, 23]) {
      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0xffffff, 300, 1200);
      const hemi = new THREE.HemisphereLight(), sun = new THREE.DirectionalLight();
      const sky = new WorldSky(scene, hemi, sun, false), camera = new THREE.PerspectiveCamera();
      camera.position.set(0, 30, 0);
      sky.apply([{ sky: { 60: 86_400, 61: ORIGIN, 62: [[0, -5 * HOUR]], 70: 'souls:day', 71: 18 * HOUR, 75: weather, 76: levels[0], 77: levels[1], 78: levels[2], 79: 2 * HOUR } }]);
      const dir = sky.update(h * HOUR, camera);
      const u = sky.dome.uniforms as Record<string, { value: any }>;
      out[`${weather} ${h}`] = {
        fog: [scene.fog!.constructor.name, scene.fog!.color.getHexString()], bg: (scene.background as THREE.Color).getHexString(),
        sun: [sun.color.getHexString(), +sun.intensity.toFixed(6)], hemi: [hemi.color.getHexString(), +hemi.intensity.toFixed(6)], dir: v(dir),
        dome: Object.fromEntries(Object.entries(u).filter(([k]) => k !== 'uNoise').map(([k, x]) => [k, typeof x.value === 'number' ? +x.value.toFixed(6) : x.value.isColor ? x.value.getHexString() : x.value.elements ? Array.from(x.value.elements as number[]).map((n) => +n.toFixed(6)) : v(x.value)])),
      };
    }
  return out;
}

test("A3: a world without the settings draws as V19b: every drawn value at twelve moments equals V19b's (pinned)", () => {
  // `v19b-parity.json` is this function's output from V19b's sky modules (#3514's head): clear, rain and fog weather
  // at 06:30, 12:00, 19:00 and 23:00.
  assert.deepEqual(drawnAll(), JSON.parse(readFileSync(new URL('./v19b-parity.json', import.meta.url), 'utf8')));
});
