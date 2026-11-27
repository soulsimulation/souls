// node --test tools/world-launcher/world-covers.test.mjs — the launcher's own pictures of worlds for the home page (27 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverFraming, coverKeeper, makeCover, worldCovers } from './world-covers.mjs';

const scratch = new URL('../../.local/', import.meta.url);
mkdirSync(scratch, { recursive: true });
const browser = (bytes) => ({ launch: async () => ({ close: async () => {}, newPage: async () => ({ goto: async () => {}, waitForFunction: async () => {}, waitForTimeout: async () => {}, screenshot: async () => bytes }) }) });

test('framing: above and south-west of the places, far enough back to hold them; the origin when none is known', () => {
  assert.deepEqual(coverFraming([]), { eye: [-60.5, 41.3, 60.5], at: [0, 0, 0] });
  // Verdelis Eden's two places (soul.game, 27 Nov): the dome (radius 129 m) and the tree inside it
  const f = coverFraming([{ point: [0, 26.9, 0], radius: 128.8 }, { point: [30, 16.4, -3], radius: 24 }]);
  assert.deepEqual(f.at, [0, 0, 0]); assert.deepEqual(f.eye, [-141.7, 96.6, 141.7]);
  assert.deepEqual(coverFraming([{ point: [100, 0, 50], radius: 5 }]), { eye: [56, 30, 94], at: [100, 0, 50] }, 'never closer than 40 m');
});

test('kept: one picture per world, the older removed; only the kept one is served; due when missing, old or reframed', async () => {
  const dir = mkdtempSync(new URL('covers-', scratch).pathname), covers = worldCovers({ dir });
  assert.equal(covers.current('mars-lab'), null);
  assert.equal(covers.due('mars-lab', { maxAgeMs: 1000, eye: [1, 2, 3], look: [0, 0, 0] }), true);
  const a = await makeCover({ page: 'http://x/w/mars-lab/', out: join(dir, 'mars-lab'), eye: [1, 2, 3], at: [0, 0, 0], chromium: browser(Buffer.from('first')) });
  const b = await makeCover({ page: 'http://x/w/mars-lab/', out: join(dir, 'mars-lab'), eye: [1, 2, 3], at: [0, 0, 0], chromium: browser(Buffer.from('second')) });
  assert.deepEqual(readdirSync(join(dir, 'mars-lab')).filter((f) => f.endsWith('.jpg')), [`${b.sha}.jpg`]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(covers.current('mars-lab').sha, b.sha);
  assert.equal(covers.file('mars-lab', a.sha), null); assert.ok(existsSync(covers.file('mars-lab', b.sha)));
  assert.equal(covers.due('mars-lab', { maxAgeMs: 60_000, eye: [1, 2, 3], look: [0, 0, 0] }), false);
  assert.equal(covers.due('mars-lab', { maxAgeMs: 60_000, eye: [9, 2, 3], look: [0, 0, 0] }), true, 'the places moved: drawn again');
  assert.equal(covers.due('mars-lab', { maxAgeMs: 60_000, eye: [1, 2, 3], look: [0, 0, 0], now: Date.now() + 61_000 }), true, 'a day old: drawn again');
  assert.equal(covers.current('../etc'), null);
});

test('the keeper: one world at a time, none while busy or short of memory, a failed world not retried at once', async () => {
  const dir = mkdtempSync(new URL('covers-keep-', scratch).pathname), covers = worldCovers({ dir });
  let busy = false, mem = true; const runs = [];
  const run = async ({ slug, out, eye, at, page }) => { runs.push([slug, page]); if (slug === 'broken') return { code: 1 }; await makeCover({ page, out, eye, at, chromium: browser(Buffer.from(slug)) }); return { code: 0 }; };
  const k = coverKeeper({ covers, dir, run, worlds: () => [{ slug: 'broken', targets: [] }, { slug: 'mars-lab', targets: [] }], page: (s) => `http://x/w/${s}/`, busy: () => busy, canStart: () => mem, firstMs: 1e9, everyMs: 1e9 });
  try {
    busy = true; assert.equal(k.check(), null); assert.equal(runs.length, 0, 'another drawing on the host: wait');
    busy = false; mem = false; assert.equal(k.check(), null); assert.equal(runs.length, 0, 'short of memory: wait');
    mem = true; await k.check();
    assert.deepEqual(runs[0], ['broken', 'http://x/w/broken/']); assert.equal(k.status().last.kept, false);
    await new Promise((r) => setTimeout(r, 50));   // the next world follows at once
    assert.deepEqual(runs.map((r) => r[0]), ['broken', 'mars-lab']); assert.equal(k.status().last.kept, true);
    await new Promise((r) => setTimeout(r, 1100));
    runs.length = 0; assert.equal(k.check(), null); assert.equal(runs.length, 0, 'drawn, and the failed one waits for its retry');
  } finally { k.close(); }
});
