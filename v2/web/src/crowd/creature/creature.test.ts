// The vendored creature builder bakes what mars/viewer's did (#2750 B15): fingerprints recorded from the mars-based
// build before the switch. A change here is a change to what the page draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bakeCreature } from '../bake.ts';
import { floaterPose } from './pose.ts';
import type { BodyMotion } from './motion.ts';

const hash = (...arrays: ArrayLike<number>[]) => {
  const h = createHash('sha256');
  for (const a of arrays as unknown as ArrayBufferView[]) h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  return h.digest('hex').slice(0, 16);
};

const RECORDED = {
  duck: { bake: '01695ff355ab9442', geometry: '41eebf9308f73195', height: 0.722471801822207 },
  snail: { bake: '4d1302dccc4756f4', geometry: '1930d9ca0835d720', height: 0.5644856960452764 },
  dog: { bake: 'f2b526b731d97f1a', geometry: '7c3bd7d5c956b5f0', height: 0.6582908492417704 },
} as const;

test('each creature bakes the same meshes and animation texture as the mars-based build', () => {
  for (const [species, want] of Object.entries(RECORDED)) {
    const m = bakeCreature(species as keyof typeof RECORDED);
    const geometry = m.lods.flatMap((g) => [g.getAttribute('position').array, g.index!.array]);
    assert.deepEqual(
      { bake: hash(m.bake.image.data as Float32Array), geometry: hash(...geometry), height: m.height, clips: m.clips.map((c) => `${c.name}:${c.frames}`) },
      { ...want, clips: ['Idle:60', 'Walk:60'] },
      species,
    );
  }
});

test('the floater pose, plain and authored, matches the mars-based build', () => {
  const motion: BodyMotion = { contract: 'body-motion/1', idle: { period: 3, bob: 0.02, pitch: 0.05, roll: 0.03, yaw: 0.04 }, move: { period: 1, bob: 0.04, pitch: 0.1, roll: 0.05, yaw: 0.02 }, rest: { period: 5, bob: 0.01, pitch: 0.02, roll: 0.01, yaw: 0.01 } };
  const poses = [];
  for (const f of [0, 7, 33]) for (const m of [undefined, motion]) poses.push(floaterPose('pip', { p: [0, 0, 0], yaw: 0 }, { family: 'floater', type: 'ceramic', radius: 0.35, hoverHeight: 0, motion: m }, f, 1 / 30, 0.4));
  assert.equal(createHash('sha256').update(JSON.stringify(poses)).digest('hex').slice(0, 16), '7bbbbabc8f08db40');
});
