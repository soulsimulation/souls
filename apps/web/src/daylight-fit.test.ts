// A scene change re-fits the light at the same clock and never lights it with a NaN colour (0.135: a past's first minute
// drew white). Offline: no browser, no renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

(globalThis as unknown as { location?: URL }).location ??= new URL('http://offline.invalid/w/fixture');
const { Daylight } = await import('./daylight.ts');
const { openGroundScene } = await import('./WorldBroadcast.ts');

const finite = (c: THREE.Color) => [c.r, c.g, c.b].every(Number.isFinite);

test('fit keeps the clock it had, and the no-clock midday after it is lit white, not NaN', () => {
  const light = new Daylight(new THREE.Scene());
  light.update('2026-11-24T19:51:14.269');
  const at = { sun: light.sun.position.clone(), daylight: light.daylight };
  light.fit([-100, -100, 100, 100]);
  assert.equal(light.clock, '2026-11-24T19:51:14.269');
  assert.ok(finite(light.hemi.color) && Number.isFinite(light.daylight), `hemisphere ${light.hemi.color.toArray()} daylight ${light.daylight}`);
  assert.equal(light.daylight, at.daylight);
  light.update(null);
  assert.ok(finite(light.hemi.color));
  assert.equal(light.hemi.color.getHex(), 0xffffff);
  assert.equal(light.hemi.intensity, 1.6);
});

test('a world drawn from its stream gives the broadcast camera its open ground as the scene', () => {
  assert.equal(openGroundScene(null), null);
  assert.equal(openGroundScene([10, 0, 10, 5]), null);
  const s = openGroundScene([-500, -400, 500, 400])!;
  assert.deepEqual(s.bounds, [-500, -400, 500, 400]);
  assert.deepEqual(s.levels.map((l) => [l.id, l.y]), [[0, 0]]);
  assert.equal(s.obstacles.length + s.surfaces.length + s.links.length, 0);
  assert.equal(openGroundScene([-500, -400, 500, 400]), s, 'the same rectangle is the same scene');
});
