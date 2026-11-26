import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode } from 'cborg';
import { moveRec } from './move-record.ts';
import { endGesture, gestureFrom } from '../take-gestures.ts';
import { chunkOf, TICK_US, type Body } from '../takes.ts';
import { sampleTake } from '../../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../../mars/viewer/engine/take/types.ts';

// Recorded two-member hold: preserve its actual start, phase boundary, open end and release time/reason.
// Scope bytes are neutral fixtures; neither the decoder nor release matching may depend on a world's identity.
const scope = new Uint8Array(16).fill(0x31), activity = [new Uint8Array(16).fill(0x72), 15];
const start = 1795671550600000n, released = 1795671552650000n;
const id = (n: number) => [scope, n];
const key = (n: number) => `${'31'.repeat(16)}.${n}`;
const text = (s: string) => new TextEncoder().encode(s);
const record = (n: number, end?: unknown): Map<number, unknown> => new Map<number, unknown>([
  [1, id(n)], [2, text('souls:hold_hand')], [3, 1], [4, [text('souls:hand-left')]],
  [5, id(n === 0 ? 2 : 0)], [6, text('souls:hand-left')], [7, start],
  [8, [1795671551200000n, 9223372036854775807n]], ...(end === undefined ? [] : [[9, end] as [number, unknown]]),
]);
const throughCBOR = (m: Map<number, unknown>) => moveRec(decode(encode(m), { useMaps: true }) as Map<number, unknown>, activity);

test('both recorded held-move releases survive decoding and end the matching drawn hold', () => {
  const bodies: Body[] = [0, 2].map((n) => {
    const opened = throughCBOR(record(n));
    assert.equal(opened.ended, undefined, 'an open hold has no fabricated release');
    const ended = throughCBOR(record(n, new Map<number, unknown>([[1, released], [2, text('released')]])));
    assert.deepEqual(ended.ended, { at: Number(released), how: 'released' });
    assert.equal(ended.run, `${'72'.repeat(16)}.15`);
    assert.equal(ended.target, key(n === 0 ? 2 : 0));
    const gestures = [gestureFrom(opened)!];
    assert.ok(gestures[0]);
    endGesture(gestures, ended.start, ended.ended!.at, ended.run);
    assert.equal(gestures[0].end, Number(released));
    return { entity: `v2_${n}`, node: key(n), soul: `soul-${n}`, name: `Actor${n}`, heading: 0,
      samples: [{ at: Number(start) - 1000000, p: [0, 0, n * 300] }], gestures };
  });
  const from = Math.floor(Number(start) / TICK_US), offset = Number(start) / 1000000 - from * TICK_US / 1000000;
  const take = chunkOf(bodies, from, { rulesVersion: 'test/1', datetime: null }, 120).take as unknown as Take;
  for (const n of [0, 2]) {
    assert.ok(sampleTake(take, offset + 1).entities[`v2_${n}`].state.handHold, 'held before recorded release');
    const tail = sampleTake(take, offset + 2.2).entities[`v2_${n}`].state.handHold as { release?: number };
    assert.equal(tail.release, Number(released) / TICK_US, 'existing adapter receives exact native release');
    assert.equal(sampleTake(take, offset + 5).entities[`v2_${n}`].state.handHold, null, 'hold is gone beyond its existing tail');
  }
});

test('absent ends stay absent; malformed release records cannot silently become perpetual holds', () => {
  assert.equal(throughCBOR(record(0)).ended, undefined);
  for (const end of [null, [], new Map(), new Map<number, unknown>([[1, released]]), new Map<number, unknown>([[1, 'later'], [2, 'released']]),
    new Map<number, unknown>([[1, start - 1n], [2, 'released']]), new Map<number, unknown>([[1, released], [2, '']])]) {
    assert.throws(() => throughCBOR(record(0, end)), /not a move end/);
  }
  const numericRun = moveRec(record(0, new Map<number, unknown>([[1, released], [2, 'released']])), 4n);
  assert.equal(numericRun.run, '4');
  assert.deepEqual(numericRun.ended, { at: Number(released), how: 'released' });
});
