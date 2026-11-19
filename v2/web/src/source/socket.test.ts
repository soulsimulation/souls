// V13 (#2745): the owner's socket source and its clock. A3: when the socket drops, the page falls back to the files
// by slowing its clock and never jumps back. A4 (the page's half): the socket source keeps nothing it is sent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decode, encode } from 'cborg';
import { FILES_US, NEAR_US, NearClock, SLOW_RATE } from './near.ts';
import { ENTRY, GRANT, ITEM, SUBSCRIBE, frames, idValue, key, readItem } from './socket.ts';

const M = (pairs: [number, unknown][]) => new Map<number, unknown>(pairs);
const id = (b: number, n: number) => [new Uint8Array(16).fill(b), n];

test('an entry item gives its motion samples, its time and its audience; a grant item its levels', () => {
  const body = id(7, 10), hall = id(7, 1), soul = id(1, 1);
  const handoff = M([[1, body], [2, 1_250_000], [3, M([[1, 2]])], [4, M([[1, 2]])],
    [5, M([[1, [hall]], [2, [1_000_000, 0, -2_000]], [3, [1 << 30, 0, 0, 0]], [4, M([[1, 1]])]])], [6, [0, 0, 0]], [7, [0, 0, 0]]]);
  const entry = M([[1, 4], [2, 1_250_000], [3, M([[1, 1]])], [4, M([[1, 1]])], [5, M([[1, 2], [2, soul]])], [6, body], [7, [M([[1, 7], [2, handoff]])]]]);
  const item = readItem(encode(M([[1, ENTRY], [2, entry]])));
  assert.deepEqual(item, { t: 'entry', e: { at: 1_250_000, audience: key(soul as never), samples: [[key(body as never), key(hall as never), null, 1_250_000, 1_000_000, 0, -2_000]] } });
  const grant = readItem(encode(M([[1, GRANT], [2, M([[1, 3], [2, 1], [3, 'souls:over-budget']])]])));
  assert.deepEqual(grant, { t: 'grant', g: { level: 'outline', asked: 'full', reason: 'souls:over-budget' } });
});

test('the subscribe frame follows a body by its id, as gatewayd reads it', () => {
  const k = '07070707070707070707070707070707.10';
  assert.deepEqual(key(idValue(k)), k);
  const f = decode(frames.subscribe(k, 1, 16_000), { useMaps: true }) as Map<number, Map<number, unknown>>;
  const r = f.get(SUBSCRIBE)!;
  assert.deepEqual([(r.get(1) as Map<number, unknown>[])[0].get(2), r.get(2), r.get(3)], [idValue(k), 1, 16_000]);
  assert.equal(ITEM, 31);
});

test('A3: live at 150 ms behind; on a drop it slows to the files, two seconds behind, and never goes back', () => {
  const c = new NearClock();
  const dt = 1000 / 60;
  let wall = 0, t = 0, prev = -Infinity;
  const world = () => 10_000_000 + wall * 1000; // world time now, µs
  const step = (live: boolean) => {
    wall += dt;
    // The files' newest part ends 1.5 s behind the world; the socket's newest entry is 20 ms old.
    t = c.step(dt, live ? world() - 20_000 : null, world(), world() - 1_500_000)!;
    assert.ok(t >= prev, `never back: ${t} after ${prev}`);
    prev = t;
  };
  for (let i = 0; i < 300; i++) step(true);
  assert.equal(c.state, 'live');
  assert.ok(Math.abs(world() - t - (NEAR_US + 20_000)) < 20_000, `live: ${(world() - t) / 1000} ms behind`);
  // The socket drops.
  let slowed = false;
  for (let i = 0; i < 600; i++) {
    step(false);
    if (c.rate < 1 && c.rate >= SLOW_RATE - 1e-9) slowed = true;
    assert.ok(c.rate >= SLOW_RATE - 1e-9 || (c.state as string) === 'holding: no parts', `rate ${c.rate} in ${c.state}`);
  }
  assert.ok(slowed, 'it slowed');
  assert.equal(c.state, 'files');
  assert.ok(Math.abs(world() - t - FILES_US) < 40_000, `on the files: ${(world() - t) / 1000} ms behind`);
  // The socket is back: it catches up, never jumping.
  for (let i = 0; i < 60 * 30; i++) step(true);
  assert.equal(c.state, 'live');
});

test('A4: the socket source keeps nothing it is sent: no storage, no cache, no file, no fetch', () => {
  const src = readFileSync(new URL('./socket.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'fetch(', 'writeFile', 'console.'])
    assert.ok(!src.includes(api), `socket.ts uses ${api}`);
});
