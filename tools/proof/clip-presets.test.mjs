// #1644: proof-video presets. pr-proof alone is today's output; the others record at their own aspect, never cropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_NAMES, VIEWPORTS, parseSize, resolvePlan } from './clip-presets.mjs';
import { parseArgs } from '../../.claude/skills/proof/record.mjs';

test('pr-proof is the default and is today\'s output: same viewport, size, no fps filter, crf 23, no panel', () => {
  for (const viewport of ['desktop', 'phone']) {
    const p = resolvePlan({ viewport });
    assert.equal(p.preset, 'pr-proof');
    assert.deepEqual(p.context, VIEWPORTS[viewport]);
    assert.deepEqual(p.world, VIEWPORTS[viewport].viewport); assert.deepEqual(p.out, p.world);
    assert.equal(p.fps, null); assert.equal(p.crf, 23); assert.equal(p.panel, null); assert.equal(p.scale, 1);
  }
  assert.deepEqual(resolvePlan(parseArgs(['--url', 'x', '--out', 'y'])).out, { width: 1280, height: 720 }, 'no flags at all');
});

test('the four presets and their sizes; the page keeps the output aspect', () => {
  assert.deepEqual(PRESET_NAMES, ['pr-proof', 'social-landscape', 'social-portrait', 'highlight']);
  const L = resolvePlan({ preset: 'social-landscape' }), P = resolvePlan({ preset: 'social-portrait' }), H = resolvePlan({ preset: 'highlight' });
  assert.deepEqual([L.out, L.fps, L.context.viewport, L.context.deviceScaleFactor], [{ width: 1920, height: 1080 }, 30, { width: 1280, height: 720 }, 1.5]);
  assert.deepEqual([P.out, P.fps, P.context.viewport, P.context.isMobile], [{ width: 1080, height: 1920 }, 30, { width: 405, height: 720 }, true]);
  assert.deepEqual([H.out, H.fps, H.context.deviceScaleFactor], [{ width: 1280, height: 720 }, 30, 1]);
  for (const p of [L, P, H]) assert.ok(Math.abs(p.world.width / p.world.height - p.context.viewport.width / p.context.viewport.height) < 0.01, `${p.preset}: page and output share an aspect`);
});

test('overrides sit on top of a preset: fps, quality, size, aspect', () => {
  assert.equal(resolvePlan({ preset: 'social-landscape', fps: 60 }).fps, 60);
  assert.deepEqual(resolvePlan({ preset: 'social-portrait', quality: 'low' }).out, { width: 720, height: 1280 });
  assert.deepEqual(resolvePlan({ preset: 'highlight', aspect: 'portrait' }).out, { width: 720, height: 1280 });
  const s = resolvePlan({ size: '1440x1080' });
  assert.deepEqual([s.out, s.aspect, s.context.viewport], [{ width: 1440, height: 1080 }, 'landscape', { width: 960, height: 720 }]);
  assert.equal(resolvePlan({ fps: 15 }).fps, 15, 'pr-proof at a lower frame rate');
  assert.throws(() => resolvePlan({ preset: 'tiktok' }), /--preset must be one of/);
  assert.throws(() => resolvePlan({ fps: 120 }), /--fps/);
  assert.throws(() => parseSize('big'), /--size/);
});

test('the panel is on the side in landscape and at the bottom in portrait, inside the same output size', () => {
  const L = resolvePlan({ preset: 'social-landscape', panel: 'on' }), P = resolvePlan({ preset: 'social-portrait', panel: 'on' });
  assert.equal(L.panel.side, 'right'); assert.equal(L.world.width + L.panel.width, 1920); assert.equal(L.world.height, 1080);
  assert.equal(P.panel.side, 'bottom'); assert.equal(P.world.height + P.panel.height, 1920); assert.equal(P.world.width, 1080);
  assert.equal(resolvePlan({ preset: 'social-landscape' }).panel, null, 'off by default');
  assert.equal(resolvePlan({}).panel, null, 'off for PR proofs');
  const pr = resolvePlan({ panel: 'on' });
  assert.deepEqual([pr.out, pr.panel.side], [{ width: 1280, height: 720 }, 'right'], 'pr-proof can have one when asked');
});

test('a scaled preset launches its browser at that scale (sharp capture); pr-proof never does', () => {
  assert.equal(resolvePlan({ viewport: 'phone' }).forceScale, undefined);
  assert.equal(resolvePlan({ preset: 'social-landscape' }).forceScale, 1.5);
  assert.equal(resolvePlan({ preset: 'social-portrait' }).forceScale, 2.6667);
  assert.equal(resolvePlan({ preset: 'highlight' }).forceScale, null);
});
