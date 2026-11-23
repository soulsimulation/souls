// S4p (#2731, #4264): a sleeping world's pointer says it is still until its next due change; the old page plays that as
// world time moving one second a second up to then, with no stall notice before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Bridge } from './bridge.ts';
import { streamNotice } from './stream-health.ts';
import { TICK_US, TICKS } from './takes.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000, W0 = 1_700_000_000_000, SETTLE_US = 250_000;
const world = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null };
const body = { id: 'b.1', kind: 'souls:body@1', parent: 'w.0', slot: null, pos: [3_000_000, 0, 4_000_000], rot: [Q, 0, 0, 0], at: T0, soul: 'soul-abc-1', name: 'Ada' };
const part = (n: number) => ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes: [], removed: [], samples: [] } as never });
/** The pointer a world leaves as it goes to sleep at T0 + 4 s (wall W0): quiet to then less the settle, still until `until`. */
const asleep = (until: number | null) => ({ t: 'pointer' as const, p: { newest: 7, newestTo: T0 + 4_000_000, period: 500_000, anchorWorld: T0 + 4_000_000, anchorWallMs: W0,
  quietUntil: T0 + 4_000_000 - SETTLE_US, asleep: true as const, stillUntil: until } });

/** Plays `b` on its pointer every 250 ms of wall time for `seconds`, as the hook steps (lastPartAt follows the world's
 *  time, use-v2-souls.ts): the world time it reached each second and whether the stall notice showed. */
function play(b: V2Bridge, until: number | null, seconds: number, from = W0) {
  const out: { t: number | null; notice: boolean }[] = [];
  let seen: number | null = null, lastPartAt: number | null = null;
  for (let ms = from; ms <= from + seconds * 1000; ms += 250) {
    b.wallNow = () => ms;
    b.receive(asleep(until));
    if (b.view.newestTo !== seen) { seen = b.view.newestTo; if (seen !== null) lastPartAt = ms; }
    if ((ms - from) % 1000 === 0) out.push({ t: b.view.newestTo, notice: !!streamNotice({ failed: false, error: null, errorAtParts: null, parts: b.view.parts, startedAt: from, lastPartAt, now: ms }) });
  }
  return out;
}

test('a viewer watching as the world falls asleep sees its time go on one second a second to its next due change, with no stall notice', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body], removed: [] } as never });
  for (let n = 0; n <= 7; n++) b.receive(part(n));
  const until = T0 + 34_000_000; // next due change 30 s after it fell asleep
  const s = play(b, until, 60);
  for (let k = 1; k <= 30; k++) assert.equal(s[k].t, T0 + 4_000_000 + k * 1_000_000, `one second a second (${k} s)`);
  assert.ok(s.slice(0, 31).every((x) => !x.notice), 'no stall notice before its next due change');
  assert.equal(s[40].t, until, 'held at the next due change: the world wakes for it, and plays on from its parts');
  assert.ok(s[50].notice, 'still nothing 15 s past it: the page says so');
  assert.ok(b.view.takes.serverTick >= Math.floor((until - 2_000_000) / TICK_US / TICKS) * TICKS - TICKS, 'its chunks are made as the time goes on');
});

test('a viewer who opens the page while the world sleeps, and gets no live part, sees its Souls and its time going on', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body], removed: [] } as never });
  // opened 10 minutes into the sleep, nothing due
  const s = play(b, null, 20, W0 + 600_000);
  assert.equal(s[0].t, T0 + 604_000_000, 'the world\'s time now, from the pointer\'s anchors');
  assert.ok(b.view.takes.chunks.length > 0 && [...b.view.souls.keys()].includes('s_abc-1'), 'its Souls drawn from the snapshot (B2-4)');
  assert.equal(s[20].t, T0 + 624_000_000, 'nothing due: the time goes on');
  assert.ok(s.every((x) => !x.notice), 'no stall notice');
});

test('an awake pointer is played as before: its quiet time only', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body], removed: [] } as never });
  for (let n = 0; n <= 7; n++) b.receive(part(n));
  b.wallNow = () => W0 + 30_000;
  const p = asleep(null).p, awake = { newest: p.newest, newestTo: p.newestTo, period: p.period, anchorWorld: p.anchorWorld, anchorWallMs: p.anchorWallMs, quietUntil: T0 + 5_000_000 };
  b.receive({ t: 'pointer', p: awake });
  assert.equal(b.view.newestTo, T0 + 5_000_000);
});
