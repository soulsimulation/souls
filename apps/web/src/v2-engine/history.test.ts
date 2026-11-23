// R2: the old page's rewind of a moved world: a window of past chunks made from history bundles (history.ts), each
// bundle's state and motion played through a bridge of its own, every chunk on the way and none past the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { historyBase, V2History } from './history.ts';
import { TICK_US, TICKS } from './takes.ts';
import { defaultLookOf, entityWithLook } from './take-bodies.ts';
import type { Seeked } from './history-worker.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000, BUNDLE = 60_000_000; // world µs; bundles of a minute
const E = entityWithLook('v2_b_7', defaultLookOf('b.7'));
const place = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0] as [number, number, number], rot: [Q, 0, 0, 0] as [number, number, number, number], at: null };
const body = (x: number) => ({ id: 'b.7', kind: 'souls:body@1', parent: 'w.0', slot: null, pos: [x, 0, 0] as [number, number, number], rot: [Q, 0, 0, 0] as [number, number, number, number], at: T0 });
/** A body that walks 1 m a second along +x for three minutes: each bundle's state at its moment, and its samples. */
function fakeWorker() {
  const asked: number[] = [];
  const w = { onmessage: null as null | ((e: MessageEvent) => void), postMessage(m: { seq: number; at: number }) {
    asked.push(m.at);
    const start = T0 + Math.floor((m.at - T0) / BUNDLE) * BUNDLE, x = (t: number) => (t - T0); // µs walked = µm
    const samples: Seeked['samples'] = [];
    for (let t = start; t < start + BUNDLE; t += 1_000_000) samples.push(['b.7', 'w.0', null, t, x(t), 0, 0]);
    const s: Seeked = { seq: m.seq, at: m.at, start, length: BUNDLE, next: start + BUNDLE < T0 + 3 * BUNDLE ? start + BUNDLE : null, nodes: [place, body(x(m.at))], samples };
    queueMicrotask(() => w.onmessage?.({ data: { t: 'seeked', s } } as MessageEvent));
  }, terminate() {} };
  return { w, asked };
}

test('a past window is every chunk of it, made from the bundles that hold it, the body where it walked', async () => {
  (globalThis as { location?: unknown }).location ??= { href: 'http://127.0.0.1/w/x/' };
  const { w, asked } = fakeWorker();
  const h = new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' });
  const from = (T0 + 30_000_000) / TICK_US, to = (T0 + 120_000_000) / TICK_US; // 0:30 to 2:00, across a bundle's edge
  const got = await h.chunks(from, to, 120);
  assert.equal(got.length, (to - from) / TICKS, 'every chunk from 0:30 to 2:00');
  got.forEach((c, i) => assert.equal(c.fromTick, from + i * TICKS));
  assert.deepEqual(asked, [T0 + 30_000_000, T0 + BUNDLE, T0 + 2 * BUNDLE], 'the moment, the next bundle, and the one after the window (the bridge makes a chunk once past it)');
  const at = (c: (typeof got)[number]) => sampleTake(c.take as unknown as Take, 0).entities[E].p[0];
  assert.ok(Math.abs(at(got[0]) - 30) < 0.01 && Math.abs(at(got.at(-1)!) - 119) < 0.01, `${at(got[0])} m at 0:30, ${at(got.at(-1)!)} m at 1:59`);
  assert.equal((await h.chunks(from, from + 10 * TICKS, 4)).length, 4, 'no more than asked');
});

test('the history export: the route\'s, else beside the stream\'s views', () => {
  assert.equal(historyBase('/s/w/eden/views/a/b/', { v2History: '/s/w/eden/history/' }), '/s/w/eden/history/');
  assert.equal(historyBase('/s/v2w/views/a/b/', {}), '/s/v2w/history/');
  assert.equal(historyBase('/s/eden/', {}), null);
  assert.equal(historyBase('/s/eden/', { v2History: 'https://elsewhere/h/' }), null);
});

test('K3: the first moment is the first bundle of the first day with public events, back through the years; none is null', async () => {
  const { encode } = await import('cborg');
  const DAY = 86_400_000_000, now = 20780 * DAY + 5_000_000; // a world day in year 56
  // year 55 holds days 55*365+300 (the world's first) and later; year 56 its newer days; nothing before year 55
  const files: Record<string, unknown> = {
    'history/everyone/counts/year/0056': new Map<number, unknown>([[1, 1], [2, 2], [3, 56], [5, [[340, 0, 12]]]]),
    'history/everyone/counts/year/0055': new Map<number, unknown>([[1, 1], [2, 2], [3, 55], [5, [[310, 1, 4], [300, 0, 0], [301, 0, 7]]]]),
    [`bundles/${String(55 * 365 + 301).padStart(8, '0')}/index`]: new Map<number, unknown>([[1, 1], [2, 55 * 365 + 301], [3, [[(55 * 365 + 301) * DAY + 120_000_000, 'k', new Uint8Array(32)], [(55 * 365 + 301) * DAY + 60_000_000, 'k', new Uint8Array(32)]]]]),
  };
  const asked: string[] = [];
  const realFetch = globalThis.fetch, realLocation = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { href: 'http://example.invalid/w/a/' };
  globalThis.fetch = (async (u: URL) => {
    const path = String(u).replace('http://example.invalid/s/x/history/', ''); asked.push(path);
    return files[path] ? new Response(encode(files[path])) : new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const h = new V2History('/s/x/history/', () => ({}) as Worker, { rulesVersion: 'test/1' });
    assert.equal(await h.first(now), (55 * 365 + 301) * DAY + 60_000_000, 'the first day with events (a slot with none is skipped), its first bundle');
    assert.ok(asked.includes('history/everyone/counts/year/0054'), 'read back past the first year to a missing one');
    files['history/everyone/counts/year/0056'] = new Map<number, unknown>([[1, 1], [5, []]]);
    delete files['history/everyone/counts/year/0055'];
    assert.equal(await new V2History('/s/x/history/', () => ({}) as Worker, { rulesVersion: 'test/1' }).first(now), null, 'no events: no first moment');
  } finally {
    globalThis.fetch = realFetch; (globalThis as { location?: unknown }).location = realLocation;
  }
});
