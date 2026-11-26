import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveResolution, MIN_PIXEL_RATIO, softwareRenderer, worldResolution } from '../src/adaptive-resolution.ts';

const fakeRenderer = () => { const r = { ratio: 0, setPixelRatio(v: number) { r.ratio = v; } }; return r; };
/** Frames every `ms` (with a little jitter) for `seconds`, from performance.now() as the controller's own clock. */
function run(a: AdaptiveResolution, ms: number | ((t: number) => number), seconds: number) {
  let t = performance.now();
  const end = t + seconds * 1000;
  for (let i = 0; t < end; i++) { a.frame(t); t += (typeof ms === 'number' ? ms : ms(t)) + (i % 3) * 0.1; }
}

// fill-bound: the frame time goes with the drawn pixels, so each step down helps
const fillBound = (a: AdaptiveResolution, msAt1: number) => () => msAt1 * a.pixelRatio ** 2;

test('a renderer slow from its first frame (2 fps) steps down below 1, to the floor', () => {
  const r = fakeRenderer();
  const a = worldResolution(r as never, 2, true, false)!;
  run(a, fillBound(a, 500 / 4), 120);
  assert.ok(a.log.some((e) => e.ratio < 1), `stepped below 1: ${JSON.stringify(a.log)}`);
  assert.equal(a.pixelRatio, MIN_PIXEL_RATIO);
  assert.equal(r.ratio, MIN_PIXEL_RATIO);
});

test('a renderer at 1 fps is judged too (a window waits for 3 frames)', () => {
  const a = worldResolution(fakeRenderer() as never, 1, true, false)!;
  run(a, fillBound(a, 1000), 90);
  assert.ok(a.pixelRatio < 1, `ratio ${a.pixelRatio}`);
});

test('a fast renderer never leaves its device ratio, stalls included', () => {
  const a = worldResolution(fakeRenderer() as never, 2, true, false)!;
  // 60 fps with a 600 ms hitch every 5 s
  let next = performance.now() + 5000;
  run(a, (t) => (t > next ? (next = t + 5000, 600) : 16.7), 120);
  assert.deepEqual(a.log, []);
  assert.equal(a.pixelRatio, 2);
});

test('a step down that does not help (CPU-bound) is undone', () => {
  const a = worldResolution(fakeRenderer() as never, 2, true, false)!;
  run(a, 500, 60);
  assert.equal(a.pixelRatio, 2);
  assert.deepEqual(a.log.map((e) => e.ratio), [1.7, 2]);
});

test('nothing adapts in the first 8 s', () => {
  const a = worldResolution(fakeRenderer() as never, 2, true, false)!;
  run(a, 500, 7.5);
  assert.deepEqual(a.log, []);
});

test('a software renderer starts at the floor; shot mode stays at 1', () => {
  const r = fakeRenderer();
  const a = worldResolution(r as never, 2, true, false, true)!;
  assert.equal(r.ratio, MIN_PIXEL_RATIO);
  assert.equal(a.pixelRatio, MIN_PIXEL_RATIO);
  assert.equal(worldResolution(r as never, 2, false, false, true), null);
  assert.equal(r.ratio, MIN_PIXEL_RATIO);
  worldResolution(r as never, 2, true, true, true);
  assert.equal(r.ratio, 1);
});

test('software renderer strings', () => {
  for (const s of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Google SwiftShader', 'Software Rasterizer'])
    assert.equal(softwareRenderer(s), true, s);
  for (const s of ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)', 'NVIDIA GeForce RTX 3080/PCIe/SSE2', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', '', null])
    assert.equal(softwareRenderer(s), false, String(s));
});
