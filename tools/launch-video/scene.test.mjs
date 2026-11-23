// 0.135 P3: a staged scene's file, its camera as a live track, and its words bound in a Soul's own copy. The scene
// itself runs end to end with `node tools/launch-video/scene.mjs tools/launch-video/scenes/hamlet-stroll.json`.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bind, cameraShot, checkScene, momentOf, rangeShot } from './scene.mjs';
import { capture, takeSeconds, takeUrl } from './capture.mjs';

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

test('a span is named by moments as the page names them, and its camera is a range of take ticks', async () => {
  assert.equal(momentOf('1795452630320000'), 1795452630320000);
  assert.equal(momentOf('http://127.0.0.1:1/w/a/#t=1795452630320000'), 1795452630320000);
  assert.equal(momentOf('2026-11-23T16:00:00Z'), Date.parse('2026-11-23T16:00:00Z') * 1000);
  const dir = mkdtempSync(join(tmpdir(), 'span-'));
  try {
    for (const [day, f] of [['00000000', '00000000000000000000-aa'], ['00020780', '00001795452600000000-bb'], ['00020780', '00001795452540000000-cc']]) { mkdirSync(join(dir, 'history/bundles', day), { recursive: true }); writeFileSync(join(dir, 'history/bundles', day, f), ''); }
    assert.equal(momentOf('first', { worldDir: dir }), 1795452540000000, 'the first bundle after the seeded record at 0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => momentOf('first'), /world-dir/); assert.throws(() => momentOf('soon'), /not a moment/);
  const s = rangeShot({ path: [{ at: 0, position: [0, 5, 0], target: [1, 0, 0] }, { at: 4, position: [4, 5, 0], target: [1, 0, 0] }] }, { fromUs: 1_000_000_000, toUs: 1_004_000_000, aspect: 1.6 });
  assert.equal(s.live, undefined); assert.equal(s.fromTick, 20_000); assert.equal(s.toTick, 20_080); assert.equal(s.dt, 0.05);
  await assert.rejects(capture({ url: 'http://127.0.0.1:1/w/a/', out: join(tmpdir(), 'x.mp4'), speed: 3, shot: s }), /--speed/);
  await assert.rejects(capture({ url: 'http://127.0.0.1:1/w/a/', out: join(tmpdir(), 'x.mp4'), speed: 2 }), /for a range of history/);
});
