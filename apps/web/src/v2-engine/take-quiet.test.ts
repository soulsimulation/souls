// B2-3: a Soul's last line, said just before the world goes still, reaches the old page. A still world writes no part;
// worldd's pointer says it is quiet up to a time (view_out `idle`: settled = now - SETTLE_US, every QUIET_EVERY_US),
// which the reader worker posts as the pointer's `quietUntil` (polled every 250 ms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Bridge } from './bridge.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000, SETTLE_US = 250_000, QUIET_EVERY_US = 500_000, POLL_US = 250_000;
const world = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null };
const body = { id: 'b.1', kind: 'souls:body@1', parent: 'w.0', slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: T0, soul: 'soul-abc-1', name: 'Ada' };
const part = (n: number, said: object[] = []) => ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes: [], removed: [], samples: [], said } as never });
const pointer = (quietUntil: number | null) => ({ t: 'pointer' as const, p: { newest: 7, newestTo: T0 + 4_000_000, period: 500_000, anchorWorld: T0, anchorWallMs: 0, quietUntil } });
const NAP = { speaker: 'b.1', at: T0 + 3_800_000, length: 2e6, reach: 10_000, ref: 'rnap', words: 'Time for a nap.' };

/** World time (µs) at which the line is first in the page's speech, the world going still after part `last`, with the
 *  pointer read every POLL_US of wall time (world time runs at one second a second). */
function shownAt(quiet: boolean): number | null {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body], removed: [] } as never });
  for (let n = 0; n <= 7; n++) b.receive(part(n, n === 7 ? [NAP] : []));
  // the last part (to T0 + 4 s) is written once its time and the settle have passed
  let q: number | null = null;
  for (let now = T0 + 4_000_000 + SETTLE_US; now <= T0 + 30_000_000; now += POLL_US) {
    if (quiet) {
      const settled = now - SETTLE_US;
      if (q === null ? settled > T0 + 4_000_000 : settled >= q + QUIET_EVERY_US) q = settled;
      b.receive(pointer(q));
    }
    if (b.view.speech.some((l) => l.text === NAP.words)) return now;
  }
  return null;
}

test('a line said just before the world goes still is shown within 2 s, as if the world had kept writing', () => {
  // a world that keeps writing parts: the chunk holding the line is made once the parts are BEHIND_US past its end
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body], removed: [] } as never });
  let flowing: number | null = null;
  for (let n = 0; n < 40 && flowing === null; n++) {
    b.receive(part(n, n === 7 ? [NAP] : []));
    if (b.view.speech.some((l) => l.text === NAP.words)) flowing = T0 + (n + 1) * 500_000 + SETTLE_US;
  }
  assert.ok(flowing !== null);
  const still = shownAt(true);
  assert.ok(still !== null, 'shown on a still world');
  assert.ok(still - flowing <= 2_000_000, `within 2 s of when a moving world shows it: ${(still - flowing) / 1e6} s later`);
  assert.equal(shownAt(false), null, 'with no pointer moving on (the fault: pointers ignored), never shown');
});

test('a pointer moving the world\'s time on keeps the chunks coming and does not step the time back', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive(pointer(T0 + 9_000_000));
  assert.equal(b.view.newestTo, null, 'before any part is played live, a pointer makes no chunk (the reader is catching up)');
  b.receive({ t: 'snapshot', s: { nodes: [world, body], removed: [] } as never });
  for (let n = 0; n <= 7; n++) b.receive(part(n));
  const tick = b.view.takes.serverTick;
  b.receive(pointer(T0 + 9_000_000));
  assert.equal(b.view.newestTo, T0 + 9_000_000);
  assert.ok(b.view.takes.serverTick > tick, 'the quiet time completes chunks');
  b.receive(pointer(T0 + 6_000_000));
  assert.equal(b.view.newestTo, T0 + 9_000_000, 'never back');
  b.receive(pointer(null));
  assert.equal(b.view.newestTo, T0 + 9_000_000);
});

