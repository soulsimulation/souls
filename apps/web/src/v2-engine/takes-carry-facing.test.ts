// A carrier is drawn turned the way the world has it, not the way it walks: the world keeps a body holding a carried
// load turned to its hold. Seen on the served page (carry proof, attempt 9): walking, each carrier turned the way it
// walked and a hand left its contact (worst 0.56 and 0.88 m).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { chunkOf, motionAt, setCarryHeading, TICK_US, type Body } from './takes.ts';

const FROM = 1000, t0 = FROM * TICK_US;
/** Walks +x at 1 m/s for 2 s, then stands. Travel heading 0. */
const walker = (entity: string): Body => ({ entity, soul: 'soul-' + entity, name: entity, heading: 1,
  samples: Array.from({ length: 11 }, (_, i) => ({ at: t0 + i * 200_000, p: [10_000 + i * 200, 0, 5_000] as [number, number, number] })) });
const frame = { rulesVersion: 'test/1', datetime: '2026-06-01T12:00:00.000Z' };
const HOLD = Math.PI / 2; // the world has the carrier turned to its hold, square to the way it walks

test('a body holding a native carry keeps the world\'s turn while it walks and after it stops; another body, and the same body before and after the carry, face their travel', () => {
  const ada = walker('v2_a_1'), bo = walker('v2_a_2');
  // Ada holds a load from 0.5 s to 3 s; Bo never does.
  setCarryHeading((entity, t) => entity === 'v2_a_1' && t >= t0 + 500_000 && t < t0 + 3_000_000 ? HOLD : null);
  try {
    const take = chunkOf([ada, bo], FROM, frame).take as unknown as Take;
    const yaw = (id: string, secs: number) => sampleTake(take, secs).entities[id];
    assert.ok(Math.abs(yaw('v2_a_1', 0.25).yaw) < 0.002, 'before the carry it faces the way it walks');
    for (const secs of [0.5, 0.75, 0.95]) {
      const a = yaw('v2_a_1', secs);
      assert.ok(Math.abs(a.yaw - HOLD) < 0.002, `carrying at ${secs} s: yaw ${a.yaw}`);
      assert.equal(a.activity, 'walk', 'it still walks');
      assert.ok(Math.abs((a.speed ?? 0) - 1) < 0.03, 'at its own speed');
      assert.ok(Math.abs(yaw('v2_a_2', secs).yaw) < 0.002, 'a body that holds nothing faces the way it walks');
    }
    const later = chunkOf([ada, bo], FROM + 50, frame).take as unknown as Take; // 2.5 s on: both stopped, Ada still holds
    assert.ok(Math.abs(sampleTake(later, 0.2).entities.v2_a_1.yaw - HOLD) < 0.002, 'standing with the load it keeps the world\'s turn');
    assert.ok(Math.abs(sampleTake(later, 0.2).entities.v2_a_2.yaw) < 0.002);
    assert.ok(Math.abs(sampleTake(later, 0.8).entities.v2_a_1.yaw) < 0.002, 'the load let go, it is the way it last walked again');
  } finally { setCarryHeading(null); }
  const unset = chunkOf([ada], FROM, frame).take as unknown as Take;
  assert.ok(Math.abs(sampleTake(unset, 0.75).entities.v2_a_1.yaw) < 0.002, 'no carry feed: every body as before');
});

test('motionAt: the carried heading replaces only the heading; a seated body keeps its seat\'s', () => {
  const s = walker('x').samples;
  assert.deepEqual(motionAt(s, t0 + 300_000, 1, [], HOLD), { speed: motionAt(s, t0 + 300_000, 1).speed, heading: HOLD });
  assert.equal(motionAt(s, t0 + 300_000, 1, [], null).heading, 0);
  assert.equal(motionAt(s, t0 + 9_000_000, 1, [], HOLD).heading, HOLD);
  const seated = [{ at: t0, p: [0, 0, 0] as [number, number, number], seat: { height: 450, heading: 2 } as never }];
  assert.equal(motionAt(seated, t0 + 1, 1, [], HOLD).heading, 2);
});
