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

// Geometry is exact on every engine; the animation texture is compared by its sums and samples, since the rig's
// trig may differ in the last bit between Node versions (bit-identical to the mars-based build on one machine).
const RECORDED = {
  duck: { geometry: '41eebf9308f73195', height: 0.722471801822207, length: 18720, sum: 4615.675, sq: 4694.2182, weighted: 226219.1, picks: [0, 0, 0, 0, 0, 0, 0, 0, -0.201088, 0.024919, -0.290457, -0.005434, 0.521762, -0.019757, -0.343446, 0.026013] },
  snail: { geometry: '1930d9ca0835d720', height: 0.5644856960452764, length: 14400, sum: 3585.889, sq: 3605.082, weighted: 175519.849, picks: [0, 0.050051, 0, 0.109327, 0, 0.150196, 0, 0.167181, 0, 0.0381, 0, 0.155347, 0, 0.120438, 0, 0.148849] },
  dog: { geometry: '7c3bd7d5c956b5f0', height: 0.6582908492417704, length: 33120, sum: 8159.239, sq: 8328.7011, weighted: 399477.218, picks: [0, 0, 0, 0, 0, 0, 0, 0, 0, -0.028085, 0, 0.04936, 0, -0.04238, 0, 0.013807] },
} as const;

const near = (a: number, b: number, tolerance: number, what: string) => assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} vs ${b}`);

test('each creature bakes the same meshes and animation texture as the mars-based build', () => {
  for (const [species, want] of Object.entries(RECORDED)) {
    const m = bakeCreature(species as keyof typeof RECORDED);
    const geometry = m.lods.flatMap((g) => [g.getAttribute('position').array, g.index!.array]);
    assert.equal(hash(...geometry), want.geometry, `${species} geometry`);
    assert.equal(m.height, want.height, `${species} height`);
    assert.deepEqual(m.clips.map((c) => `${c.name}:${c.frames}`), ['Idle:60', 'Walk:60'], `${species} clips`);
    const d = m.bake.image.data as Float32Array;
    assert.equal(d.length, want.length, `${species} bake size`);
    let sum = 0, sq = 0, weighted = 0;
    for (let i = 0; i < d.length; i++) { sum += d[i]; sq += d[i] * d[i]; weighted += d[i] * ((i % 97) + 1); }
    near(sum, want.sum, 1e-3, `${species} bake sum`);
    near(sq, want.sq, 1e-3, `${species} bake squares`);
    near(weighted, want.weighted, 1e-2, `${species} bake order`);
    want.picks.forEach((v, i) => near(d[Math.floor((i + 0.5) * d.length / 16)], v, 1e-5, `${species} bake sample ${i}`));
  }
});

test('the floater pose, plain and authored, matches the mars-based build', () => {
  const motion: BodyMotion = { contract: 'body-motion/1', idle: { period: 3, bob: 0.02, pitch: 0.05, roll: 0.03, yaw: 0.04 }, move: { period: 1, bob: 0.04, pitch: 0.1, roll: 0.05, yaw: 0.02 }, rest: { period: 5, bob: 0.01, pitch: 0.02, roll: 0.01, yaw: 0.01 } };
  const poses = [];
  for (const f of [0, 7, 33]) for (const m of [undefined, motion]) poses.push(floaterPose('pip', { p: [0, 0, 0], yaw: 0 }, { family: 'floater', type: 'ceramic', radius: 0.35, hoverHeight: 0, motion: m }, f, 1 / 30, 0.4));
  assert.equal(createHash('sha256').update(JSON.stringify(poses)).digest('hex').slice(0, 16), '7bbbbabc8f08db40');
});
