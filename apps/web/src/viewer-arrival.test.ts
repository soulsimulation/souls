// node --test apps/web/src/viewer-arrival.test.ts — #1266: one arrival progress for the bar and the light.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_SHARE, FIRST_FRAME, STARTED, WORLD_DATA, arrivalFraction, reasonDelayMs } from './viewer-arrival.ts';
import { ARRIVAL_CATCH_MS, ARRIVAL_NOW_MS, ARRIVAL_STALE_MS, arrivalCatching } from './arrival-catching.ts';
import { STREAM_CATCHING, STREAM_NOTICE } from './v2-engine/stream-health.ts';
import type { InitialWorldProgress } from './InitialWorldReadiness.ts';

const bytes = (loaded: number, total: number, known = true) => ({ loaded, total, known });
const gate = (stage: InitialWorldProgress['stage'], completed = 0, required = 0): InitialWorldProgress => ({ generation: 1, stage, required, completed, failed: [], bytesLoaded: 0, bytesTotal: null });
const at = (o: Partial<Parameters<typeof arrivalFraction>[0]>) => arrivalFraction({ card: true, bytes: bytes(0, 0, false), initial: null, arriving: true, ...o });

test('before any bytes: the steps that have happened, the code running, then the world data', () => {
  assert.equal(at({}), STARTED);
  assert.equal(at({ bytes: bytes(0, 4e6, false) }), STARTED, 'sizes only of files already started are not a total');
  assert.equal(at({ initial: gate('waiting') }), WORLD_DATA);
});

test('the download is the first share, in bytes, and moves with them', () => {
  const share = (d: number) => WORLD_DATA + (BYTES_SHARE - WORLD_DATA) * d;
  assert.equal(at({ bytes: bytes(0, 8e6) }), WORLD_DATA);
  assert.equal(at({ bytes: bytes(2e6, 8e6) }), share(0.25));
  assert.ok(Math.abs(at({ bytes: bytes(8e6, 8e6) }) - BYTES_SHARE) < 1e-9);
  assert.equal(at({ initial: gate('downloading', 3, 4) }), share(0.75), 'world parts when bytes are not known');
});

test('preparing is never 100%: it goes past the download share and stops short of the first frame', () => {
  const prep = [at({ bytes: bytes(8e6, 8e6), initial: gate('preparing', 4, 4) }), at({ bytes: bytes(1e6, 8e6), initial: gate('preparing', 4, 4) })];
  assert.ok(prep.every(f => f > BYTES_SHARE && f < FIRST_FRAME), JSON.stringify(prep));
  assert.equal(at({ initial: gate('first-frame', 4, 4) }), FIRST_FRAME);
  assert.ok(at({ initial: gate('first-frame', 4, 4) })! < 1);
});

test('100% only once the world is drawn', () => {
  assert.equal(arrivalFraction({ card: false, bytes: bytes(1, 2), initial: gate('preparing'), arriving: false }), 1);
  for (const f of [at({ bytes: bytes(9e6, 8e6) }), at({ initial: gate('preparing', 9, 4) })]) assert.ok(f! < 1, String(f));
});

test('#4691: a reader catching up replaces a showing "not available" at once; otherwise a reason waits 4 s', () => {
  // the status line's settle as ViewerFrame runs it: a reason shows reasonDelayMs after it came, given the line shown then
  const blocked = (r: string) => /stream is not available/.test(r);
  const run = (steps: [number, string | null][]) => {
    let shown: string | null = null, due: { at: number; reason: string } | null = null;
    const seen: [number, string | null][] = [[0, null]];
    for (let t = 0, i = 0; t <= 20_000; t += 100) {
      while (i < steps.length && steps[i][0] <= t) {
        const r = steps[i++][1];
        if (!r) { shown = null; due = null; } else due = { at: t + reasonDelayMs(r, shown, blocked(r)), reason: r };
      }
      if (due && t >= due.at) { shown = due.reason; due = null; }
      if (seen.at(-1)![1] !== shown) seen.push([t, shown]);
    }
    return seen;
  };
  // the notice, then the catch-up's words: "Catching up" at once, then live
  assert.deepEqual(run([[1000, STREAM_NOTICE], [5000, STREAM_CATCHING], [8700, null]]), [[0, null], [1000, STREAM_NOTICE], [5000, STREAM_CATCHING], [8700, null]]);
  // a catch-up with nothing showing still waits its 4 s: a short one never flashes, a long one shows
  assert.deepEqual(run([[1000, STREAM_CATCHING], [3000, null]]), [[0, null]]);
  assert.deepEqual(run([[1000, STREAM_CATCHING], [9000, null]]), [[0, null], [5000, STREAM_CATCHING], [9000, null]]);
  assert.equal(reasonDelayMs(STREAM_NOTICE, null, true), 0);
  assert.equal(reasonDelayMs('Reconnecting; displaying the last recorded frame.', STREAM_NOTICE, false), 4000);
});

test('27 Nov: a cold arrival over an old checkpoint is catching up until it is within a few seconds of now, never for good', () => {
  const now = 1_800_000_000_000;
  assert.equal(arrivalCatching(now - 3600_000, now, 1000), true, 'an hour-old checkpoint is not Live');
  assert.equal(arrivalCatching(now - 22_000, now, 4000), true, 'nor the last 22 s it plays on through');
  assert.equal(arrivalCatching(now - ARRIVAL_NOW_MS, now, 5000), false, 'within a few seconds it is now');
  assert.equal(arrivalCatching(now - 2500, now, 5000), false, 'the page plays a little behind the world: that is Live');
  assert.equal(arrivalCatching(now - ARRIVAL_STALE_MS - 1, now, 1000), false, 'a clock far off is no catch-up');
  assert.equal(arrivalCatching(now - 3600_000, now, ARRIVAL_CATCH_MS), false, 'and the arrival is over after a minute');
});
