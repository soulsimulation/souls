// Phone arrival: the live view checks each take chunk once, not each time the v2 bridge hands it a new array of the
// same chunks (every half second; about 25 ms a frame in zod on a 4x phone).
//   node --test apps/web/src/WorldGeometry.chunks.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedTakeChunkSchema } from '@souls/protocol';
import { validChunks } from './WorldGeometry.ts';

const chunk = (fromTick: number, ticks = 10) => ({
  fromTick, toTick: fromTick + ticks,
  take: { schema: 'mars-take/4', id: `t${fromTick}`, baselineStateHash: 'a', finalStateHash: 'b', rulesVersion: 'r', dt: 0.05, startTick: fromTick, ticks,
    keyframeEvery: 5, tracks: { s1: [[0, 0, 0, 0, 0]] }, changes: [], events: [], finalState: { entities: {} } },
});

test('a chunk object is parsed once, however many arrays it comes in; the result is the same chunk each time', (t) => {
  const parse = recordedTakeChunkSchema.safeParse.bind(recordedTakeChunkSchema);
  let parses = 0;
  t.mock.method(recordedTakeChunkSchema, 'safeParse', (x: unknown) => { parses++; return parse(x); });
  const kept = [chunk(20), chunk(0), chunk(10)];
  const first = validChunks([...kept]);
  assert.deepEqual(first.map((c) => c.fromTick), [0, 10, 20], 'sorted by start tick');
  assert.equal(parses, 3);
  // the bridge's next half second: a new array of the same chunks and one new chunk
  const next = validChunks([...kept, chunk(30)]);
  assert.equal(parses, 4, 'only the new chunk is parsed');
  assert.deepEqual(next.slice(0, 3), first, 'the same checked chunks');
  assert.equal(next[0], first[0]);
  // checked chunks merged again (a rewind window) are not parsed again
  validChunks([...first, ...next]);
  assert.equal(parses, 4);
});

test('a malformed chunk is still dropped, and dropped again without a second parse', (t) => {
  const parse = recordedTakeChunkSchema.safeParse.bind(recordedTakeChunkSchema);
  let parses = 0;
  t.mock.method(recordedTakeChunkSchema, 'safeParse', (x: unknown) => { parses++; return parse(x); });
  const bad = { ...chunk(0), toTick: 99 }, good = chunk(10);
  assert.deepEqual(validChunks([bad, good, null, 7]).map((c) => c.fromTick), [10]);
  assert.deepEqual(validChunks([bad, good]).map((c) => c.fromTick), [10]);
  assert.equal(parses, 4, 'each of the four once: the second look at bad and good is not parsed');
});
