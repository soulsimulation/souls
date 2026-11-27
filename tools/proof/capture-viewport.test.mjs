import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDeficit, checkCapturePixels } from './capture-viewport.mjs';
test('correction is measured from actual capture dimensions rather than a fixed browser decoration offset', () => {
  assert.deepEqual(captureDeficit({ width: 640, height: 360 }, { deviceWidth: 640, deviceHeight: 273 }), { width: 0, height: 87 });
  assert.deepEqual(captureDeficit({ width: 390, height: 844 }, { deviceWidth: 370, deviceHeight: 800 }), { width: 20, height: 44 });
  assert.deepEqual(captureDeficit({ width: 390, height: 844 }, { deviceWidth: 390, deviceHeight: 844 }), { width: 0, height: 0 });
  assert.throws(() => captureDeficit({ width: 640, height: 360 }, { deviceWidth: NaN, deviceHeight: 360 }), /geometry-invalid/);
});
test('encoded qualification rejects cropping, upscaling dimensions and gray right or bottom padding', () => {
  const size = { width: 64, height: 96 }, bytes = Buffer.alloc(64 * 96 * 3, 100);
  for (const [x, y, color] of [[8, 8, [255, 0, 0]], [55, 8, [0, 255, 0]], [8, 87, [0, 0, 255]], [55, 87, [255, 255, 0]]])
    bytes.set(color, (y * 64 + x) * 3);
  assert.equal(checkCapturePixels(bytes, size, size), true);
  assert.throws(() => checkCapturePixels(bytes, { width: 64, height: 72 }, size), /resolution-mismatch/);
  assert.throws(() => checkCapturePixels(bytes, { width: 128, height: 192 }, size), /resolution-mismatch/);
  for (const [x, y] of [[55, 8], [8, 87], [55, 87]]) {
    const padded = Buffer.from(bytes); padded.set([128, 128, 128], (y * 64 + x) * 3);
    assert.throws(() => checkCapturePixels(padded, size, size), /edge-pixels-mismatch/);
  }
});
