// 0.135 P3: a staged scene's file, its camera as a live track, and its words bound in a Soul's own copy. The scene
// itself runs end to end with `node tools/launch-video/scene.mjs tools/launch-video/scenes/hamlet-stroll.json`.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bind, cameraShot, checkScene } from './scene.mjs';
import { takeSeconds, takeUrl } from './capture.mjs';

const scene = (over = {}) => ({ name: 'a', seconds: 10, world: { template: 'worlds/templates/hello-hamlet.json' }, souls: [{ id: 'ada' }, { id: 'bo' }],
  beats: [{ at: 0, souls: ['ada'], do: ['say', 'hi'] }], ...over });

test('the committed scenes are valid, and a bad one is refused with its reasons', () => {
  for (const f of ['hamlet-stroll', 'hamlet-cottage-dolly', 'hamlet-planned']) assert.deepEqual(checkScene(JSON.parse(readFileSync(new URL(`./scenes/${f}.json`, import.meta.url), 'utf8'))), [], f);
  assert.deepEqual(checkScene(scene()), []);
  const errs = checkScene(scene({ name: 'A B', beats: [{ at: -1, souls: ['cy'], do: [] }], camera: { follow: 'cy' } }));
  for (const w of ['name', 'beats[0].souls', 'beats[0].do', 'beats[0].at', 'camera']) assert.ok(errs.some((e) => e.startsWith(w)), `${w}: ${errs}`);
});

test('a fixed camera holds one pose; a path eases between its keyframes and holds the last', () => {
  const fixed = cameraShot({ fixed: { position: [1, 2, 3], target: [0, 0, 0], fov: 40 } }, 2, 16 / 9);
  assert.equal(fixed.live, true); assert.equal(fixed.seconds, 2); assert.equal(fixed.track.hz, 30);
  assert.ok(fixed.track.samples.every((s) => s.position.join() === '1,2,3' && s.fov === 40));
  const path = cameraShot({ path: [{ at: 2, position: [10, 0, 0], target: [0, 0, 0] }, { at: 0, position: [0, 0, 0], target: [0, 0, 0] }] }, 3, 1);
  const at = (t) => path.track.samples[Math.round(t * 30)];
  assert.deepEqual(at(0).position, [0, 0, 0]); assert.deepEqual(at(1).position, [5, 0, 0], 'eased: half way at half time');
  assert.ok(at(0.5).position[0] < 2.5, 'eased: slow out of the first key'); assert.deepEqual(at(3).position, [10, 0, 0], 'the last held');
});

test("words are bound in the Soul's own copy: ?<words> is the first thing found, @<soul> a body", async () => {
  const asked = [];
  const seat = { cli: async (...w) => { asked.push(w); return { found: [{ id: 'b-1', kind: 'souls:body@1' }, { id: 't-9', kind: 'eden:bench' }] }; } };
  assert.deepEqual(await bind(seat, ['act', '?the bench', '@bo', '--wait'], { bo: 'b-2' }), ['act', 't-9', 'b-2', '--wait']);
  assert.deepEqual(asked, [['find', 'the', 'bench']]);
  await assert.rejects(bind({ cli: async () => ({ found: [] }) }, ['act', '?nothing'], {}), /nothing found/);
});

test('a take is as long as its range, its live track or its seconds, and its address carries the hour and track', () => {
  assert.equal(takeSeconds({ fromTick: 100, toTick: 300, dt: 0.05 }, 9), 10);
  assert.equal(takeSeconds({ live: true, seconds: 4 }, 9), 4);
  assert.equal(takeSeconds(null, 9), 9);
  assert.equal(takeUrl('http://127.0.0.1:1/w/a/', { hour: '17:30', shot: true }), 'http://127.0.0.1:1/w/a/?hour=17%3A30&track=%2F__lv%2Fshot.json');
});
