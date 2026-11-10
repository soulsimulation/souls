// node --test apps/web/src/viewer-arrival.test.ts — #1266: one arrival progress for the bar and the light.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_SHARE, FIRST_FRAME, STARTED, WORLD_DATA, arrivalFraction } from './viewer-arrival.ts';
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
