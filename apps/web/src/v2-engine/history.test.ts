// R2: the old page's rewind of a moved world: a window of past chunks made from history bundles (history.ts), each
// bundle's state and motion played through a bridge of its own, every chunk on the way and none past the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { historyBase, V2History } from './history.ts';
import { dayIndexKey, headerKey, walk, yearCountsKey, type DayIndex } from './history-keys.ts';
import { TICK_US, TICKS } from './takes.ts';
import { defaultLookOf, entityWithLook } from './take-bodies.ts';
import type { Seeked } from './history-worker.ts';
import { solarPosition } from '../../../../mars/viewer/engine/env/sun.ts';
import { setEquatorSun, sunSite } from '../sun-site.ts';

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

test('a window past the newest bundle (a quiet minute writes none) is played from where that bundle left the world', async () => {
  (globalThis as { location?: unknown }).location ??= { href: 'http://127.0.0.1/w/x/' };
  // one bundle, 0:00 to 1:00, nothing after it yet: "Back 1 min" at 2:30 asks for 1:30 on
  const w = { onmessage: null as null | ((e: MessageEvent) => void), postMessage(m: { seq: number; at: number }) {
    const samples: Seeked['samples'] = [];
    for (let t = T0; t < T0 + BUNDLE; t += 1_000_000) samples.push(['b.7', 'w.0', null, t, Math.min(t - T0, 20_000_000), 0, 0]);
    const s: Seeked = { seq: m.seq, at: m.at, start: T0, length: BUNDLE, next: null, nodes: [place, body(20_000_000)], samples };
    queueMicrotask(() => w.onmessage?.({ data: { t: 'seeked', s } } as MessageEvent));
  }, terminate() {} };
  const h = new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' });
  const from = (T0 + 90_000_000) / TICK_US, to = (T0 + 100_000_000) / TICK_US;
  const got = await h.chunks(from, to, 120);
  assert.equal(got.length, (to - from) / TICKS, 'every chunk of the quiet window');
  const at = (c: (typeof got)[number]) => sampleTake(c.take as unknown as Take, 0).entities[E].p[0];
  assert.ok(Math.abs(at(got[0]) - 20) < 0.01 && Math.abs(at(got.at(-1)!) - 20) < 0.01, `${at(got[0])} m: where it stopped`);
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
  // year 55 holds days 55*365+300 (the world's first) and later; year 56 its newer days, from its day 0 (the world ran
  // across the new year); nothing before year 55
  const files: Record<string, unknown> = {
    'history/everyone/counts/year/0056': new Map<number, unknown>([[1, 1], [2, 2], [3, 56], [5, [[0, 0, 2], [340, 0, 12]]]]),
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
    assert.deepEqual(asked.filter((p) => p.includes('/counts/')), ['history/everyone/counts/year/0056', 'history/everyone/counts/year/0055'],
      'year 55 began the record (its first day with events is not its day 0), so year 54, which the origin has not, is never asked');
    files['history/everyone/counts/year/0056'] = new Map<number, unknown>([[1, 1], [5, []]]);
    delete files['history/everyone/counts/year/0055'];
    assert.equal(await new V2History('/s/x/history/', () => ({}) as Worker, { rulesVersion: 'test/1' }).first(now), null, 'no events: no first moment');
  } finally {
    globalThis.fetch = realFetch; (globalThis as { location?: unknown }).location = realLocation;
  }
});

test('a young world: every seek names the world\'s first moment as its floor, so its walk asks no day before it', async () => {
  const { encode } = await import('cborg');
  const DAY = 86_400_000_000, day = 20781, first = day * DAY + 50_000_000_000; // the world began this day
  const files: Record<string, unknown> = {
    'history/everyone/counts/year/0056': new Map<number, unknown>([[1, 1], [5, [[day - 56 * 365, 0, 3]]]]),
    [`bundles/000${day}/index`]: new Map<number, unknown>([[1, 1], [2, day], [3, [[first, 'k', new Uint8Array(32)]]]]),
  };
  const realFetch = globalThis.fetch, realLocation = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { href: 'http://example.invalid/w/a/' };
  globalThis.fetch = (async (u: URL) => {
    const path = String(u).replace('http://example.invalid/s/x/history/', '');
    return files[path] ? new Response(encode(files[path])) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const posted: { at: number; floor?: number }[] = [];
  const w = { onmessage: null as null | ((e: MessageEvent) => void), postMessage(m: { seq: number; at: number; floor?: number }) {
    posted.push(m);
    const s: Seeked = { seq: m.seq, at: m.at, start: first, length: BUNDLE, next: null, nodes: [place, body(0)], samples: [] };
    queueMicrotask(() => w.onmessage?.({ data: { t: 'seeked', s } } as MessageEvent));
  }, terminate() {} };
  try {
    const h = new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' });
    // "Back 1 min" a minute after the world began asks for a moment before its first bundle
    const from = Math.floor((first - 30_000_000) / TICK_US);
    await h.chunks(from, from + 60 * TICKS, 10);
    assert.ok(posted.length > 0 && posted.every((m) => m.floor === first && m.at >= first), JSON.stringify(posted));
  } finally {
    globalThis.fetch = realFetch; (globalThis as { location?: unknown }).location = realLocation;
  }
});

test('the history export\'s paths are the ones the origin serves: the counts under a second history/, the bundles not', () => {
  // the shapes soul.game answered 200 on 24 Nov (read-only curl of a moved world's export)
  const base = 'https://soul.game/s/w/a-a-0/history/', at = (k: string) => new URL(k, base).href;
  assert.equal(at(headerKey()), 'https://soul.game/s/w/a-a-0/history/header');
  assert.equal(at(dayIndexKey(20781)), 'https://soul.game/s/w/a-a-0/history/bundles/00020781/index');
  assert.equal(at(dayIndexKey(0)), 'https://soul.game/s/w/a-a-0/history/bundles/00000000/index');
  assert.equal(at(yearCountsKey(56)), 'https://soul.game/s/w/a-a-0/history/history/everyone/counts/year/0056');
  assert.equal(historyBase('/s/w/a-a-0/views/a/a-0/0/a-0/1/everyone/', {}), '/s/w/a-a-0/history/', 'the export beside the stream\'s views');
});

test('a world made through New world (its clock from 0): every history file the page asks of it is one its export serves', async () => {
  // my-mars-lab-2 on soul.game, 26 Nov (read-only curl): its export in bundles/00000000/ (200), the wall's day 20783
  // (bundles/00020783/index: 404), the page's live head 6 h 38 min of world time in, its newest bundle 8 min back
  const DAY = 86_400_000_000, nowUs = 23_916_000_000, first = 4_115_192_082, newest = 23_435_192_082;
  const served = (indexes: Map<number, DayIndex>) => {
    const asked: string[] = [];
    return { asked, get: async (day: number) => { asked.push(dayIndexKey(day)); return indexes.get(day) ?? null; } };
  };
  const created = new Map<number, DayIndex>([[0, [[first, 'bundles/00000000/a', new Uint8Array(32)], [newest, 'bundles/00000000/b', new Uint8Array(32)]]]]);
  for (const at of [nowUs - 60_000_000, nowUs, first]) { // Back 1 min, Pause, From the start
    const o = served(created), got = await walk(at, nowUs, first, o.get);
    assert.equal(got?.key, at === first ? 'bundles/00000000/a' : 'bundles/00000000/b');
    assert.equal(await got!.later(), at === first ? newest : null);
    assert.deepEqual(o.asked, [dayIndexKey(0)], `at ${at} µs: day 0's index only, never day 1's, which the world has not reached`);
  }
  // an imported world (Eden: its clock reads as the wall's): yesterday's newest bundle is followed into today's index
  const today = 20783, eden = new Map<number, DayIndex>([[today - 1, [[(today - 1) * DAY + 5e9, 'y', new Uint8Array(32)]]], [today, [[today * DAY + 7e9, 't', new Uint8Array(32)]]]]);
  const o = served(eden), y = await walk(today * DAY - 60_000_000, today * DAY + 60e9, undefined, o.get);
  assert.equal(await y!.later(), today * DAY + 7e9);
  assert.deepEqual(o.asked, [dayIndexKey(today - 1), dayIndexKey(today)]);
  const t = served(eden); await (await walk(today * DAY + 30e9, today * DAY + 60e9, undefined, t.get))!.later();
  assert.deepEqual(t.asked, [dayIndexKey(today)], 'today\'s newest bundle: no index of tomorrow');
  // the page's live head reaches the worker as the world's now; unknown (the first motion fetch), the window's end
  (globalThis as { location?: unknown }).location ??= { href: 'http://127.0.0.1/w/x/' };
  const { w } = fakeWorker(), posts: { seq: number; at: number; now?: number }[] = [], post = w.postMessage.bind(w);
  w.postMessage = (m) => { posts.push(m); post(m); };
  const h = new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' });
  const from = (T0 + 30_000_000) / TICK_US, to = from + 4 * TICKS;
  await h.chunks(from, to, 4, undefined, to + 100);
  assert.ok(posts.length && posts.every((m) => m.now === (to + 100) * TICK_US), JSON.stringify(posts.map((m) => m.now)));
  posts.length = 0; await h.chunks(from, to, 4);
  assert.ok(posts.length && posts.every((m) => m.now === to * TICK_US), JSON.stringify(posts.map((m) => m.now)));
});

test('a world busy on day 0 and still for three days: Back 1 min and Pause in day 3 walk back over the days with no index', async () => {
  // the archiver wrote day 0's index and day 1's, empty, ahead of it (v2/docs/archive.md); days 2 and 3 have none
  const DAY = 86_400_000_000, first = 60_000_000, last = 660_000_000;
  const indexes = new Map<number, DayIndex>([[0, [[first, 'a', new Uint8Array(32)], [last, 'b', new Uint8Array(32)]]], [1, []]]);
  const served = () => {
    const asked = new Set<number>();
    return { asked, get: async (day: number) => { asked.add(day); return indexes.get(day) ?? null; } };
  };
  let now = 3 * DAY + 30_000_000;
  for (const at of [now - 60_000_000, now]) { // Back 1 min (day 2) and Pause (day 3), 30 s into day 3
    const o = served(), got = await walk(at, now, first, o.get);
    assert.equal(got?.key, 'b', `at ${at} µs: day 0's last bundle`);
    assert.equal(await got!.later(), null, 'nothing written since');
    assert.deepEqual([...o.asked].sort(), [0, 1, 2, 3], 'from now\'s day back to the world\'s first, none after or before');
  }
  // the world wakes on day 4: a replay from day 3 goes on to day 4's first bundle, over the days with no index
  indexes.set(4, [[4 * DAY + 10_000_000, 'c', new Uint8Array(32)]]);
  now = 4 * DAY + 30_000_000;
  const back = await walk(now - 60_000_000, now, first, served().get);
  assert.equal(back?.key, 'b');
  assert.equal(await back!.later(), 4 * DAY + 10_000_000);
  // the world's first moment not known: no day before day 0
  const o = served();
  indexes.clear();
  assert.equal(await walk(2 * DAY, 2 * DAY, undefined, o.get), null);
  assert.deepEqual([...o.asked].sort(), [0, 1, 2]);
});

test('K3: the first moment asks only for years that can hold it: back past a year that has its day 0, at most two when there are none', async () => {
  const { encode } = await import('cborg');
  const DAY = 86_400_000_000, now = 56 * 365 * DAY + 20 * DAY;
  const counts = (y: number, days: number[]) => new Map<number, unknown>([[1, 1], [2, 2], [3, y], [5, days.map((d) => [d, 0, 3])]]);
  const run = async (files: Record<string, unknown>) => {
    const asked: string[] = [];
    const realFetch = globalThis.fetch, realLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { href: 'http://example.invalid/w/a/' };
    globalThis.fetch = (async (u: URL) => {
      const path = String(u).replace('http://example.invalid/s/x/history/', ''); asked.push(path);
      return files[path] ? new Response(encode(files[path])) : new Response(null, { status: 404 });
    }) as typeof fetch;
    try { return { first: await new V2History('/s/x/history/', () => ({}) as Worker, { rulesVersion: 'test/1' }).first(now), asked }; }
    finally { globalThis.fetch = realFetch; (globalThis as { location?: unknown }).location = realLocation; }
  };
  const day = 55 * 365 + 360, idx = new Map<number, unknown>([[1, 1], [2, day], [3, [[day * DAY + 5, 'k', new Uint8Array(32)]]]]);
  // the world ran across the new year: year 56 has its day 0, so year 55 is read, and it began the record
  const across = await run({ [yearCountsKey(56)]: counts(56, [0, 1]), [yearCountsKey(55)]: counts(55, [360, 364]), [dayIndexKey(day)]: idx });
  assert.equal(across.first, day * DAY + 5);
  assert.deepEqual(across.asked, [yearCountsKey(56), yearCountsKey(55), dayIndexKey(day)]);
  // no events yet this year: last year's counts, and nothing before it
  const quiet = await run({ [yearCountsKey(55)]: counts(55, [360]), [dayIndexKey(day)]: idx });
  assert.equal(quiet.first, day * DAY + 5);
  assert.deepEqual(quiet.asked, [yearCountsKey(56), yearCountsKey(55), dayIndexKey(day)]);
  // none at all: two asks, not fifty
  const none = await run({});
  assert.equal(none.first, null);
  assert.deepEqual(none.asked, [yearCountsKey(56), yearCountsKey(55)]);
});

test('V6: hour=HH:MM draws the past in that light, as live: the chunks\' clock at that hour, its day the world\'s', async () => {
  (globalThis as { location?: unknown }).location ??= { href: 'http://127.0.0.1/w/x/' };
  // the world's calendar (its own node's sky: a 24 h day from 2026-06-21 10:30 UTC), so its chunks carry a clock
  const origin = Date.UTC(2026, 5, 21, 10, 30) * 1000, sky = { 60: 86_400, 61: origin };
  const sun = (hour?: string) => {
    const { w } = fakeWorker(), post = w.postMessage.bind(w);
    w.postMessage = (m) => { post(m); const on = w.onmessage!; w.onmessage = (e) => { (e.data.s.nodes[0] as { sky?: unknown }).sky = sky; on(e); w.onmessage = on; }; };
    return new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' }, hour);
  };
  const from = (T0 + 30_000_000) / TICK_US, to = from + 4 * TICKS;
  const at = (c: { take: unknown }) => (c.take as { finalState: { env: { datetime: string | null } } }).finalState.env.datetime;
  const recorded = (await sun().chunks(from, to, 4)).map(at), lit = (await sun('21:30').chunks(from, to, 4)).map(at);
  assert.ok(recorded.every((d) => d && !d.includes('T21:30')), `the recorded clock without hour=: ${recorded[0]}`);
  assert.ok(lit.every((d, i) => d === `${recorded[i]!.slice(0, 11)}21:30${recorded[i]!.slice(16)}`), `with hour=21:30: ${lit[0]}`);
});

test('Eden daylight: a world at 15:25 in New York in late November draws daylight, its clock local (the zone\'s offset, field 62)', async () => {
  (globalThis as { location?: unknown }).location ??= { href: 'http://127.0.0.1/w/x/' };
  // Eden's calendar as worldd serves it (serve.rs eden_sky): a 24 h day, America/New_York's offset in force (EST, -5 h),
  // its origin set so the window opens at 2026-11-25 20:25 UTC, 15:25 in New York
  const EST = -5 * 3_600_000_000, origin = Date.UTC(2026, 10, 25, 20, 25) * 1000 - (T0 + 30_000_000);
  const sky = { 60: 86_400, 61: origin, 62: [[0, EST]] };
  const { w } = fakeWorker(), post = w.postMessage.bind(w);
  w.postMessage = (m) => { post(m); const on = w.onmessage!; w.onmessage = (e) => { (e.data.s.nodes[0] as { sky?: unknown }).sky = sky; on(e); w.onmessage = on; }; };
  const from = (T0 + 30_000_000) / TICK_US, got = await new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' }).chunks(from, from + TICKS, 1);
  const clock = (got[0].take as { finalState: { env: { datetime: string | null } } }).finalState.env.datetime!;
  assert.match(clock, /^2026-11-25T15:25:\d\d\.\d{3}$/, `the chunk's clock is New York's, naive local: ${clock}`);
  // as LiveWorld lights it (a naive local clock, as shiftIso reads it), with a real-time world's equator sun (sun-site.ts)
  setEquatorSun(true);
  try {
    const { elevationDeg } = solarPosition(clock, ...sunSite(clock));
    assert.ok(elevationDeg > 10, `the sun is up at 15:25 local: ${elevationDeg.toFixed(1)}°`);
  } finally { setEquatorSun(false); }
});

test('#3358: a read ahead asks the worker for the window\'s first bundle, from the world\'s first moment on, and waits for no answer', async () => {
  const { encode } = await import('cborg');
  const DAY = 86_400_000_000, day = 20781, first = day * DAY + 50_000_000_000;
  const files: Record<string, unknown> = {
    'history/everyone/counts/year/0056': new Map<number, unknown>([[1, 1], [5, [[day - 56 * 365, 0, 3]]]]),
    [`bundles/000${day}/index`]: new Map<number, unknown>([[1, 1], [2, day], [3, [[first, 'k', new Uint8Array(32)]]]]),
  };
  const realFetch = globalThis.fetch, realLocation = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { href: 'http://example.invalid/w/a/' };
  globalThis.fetch = (async (u: URL) => {
    const path = String(u).replace('http://example.invalid/s/x/history/', '');
    asked.push(path);
    return files[path] ? new Response(encode(files[path])) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const asked: string[] = [];
  const posted: { seq: number; at: number; now: number; floor?: number; ahead?: true; base: string }[] = [];
  const w = { onmessage: null as null | ((e: MessageEvent) => void), postMessage(m: (typeof posted)[number]) { posted.push(m); }, terminate() {} };
  try {
    const h = new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' });
    const now = first + 3_600_000_000, back = (now - 60_000_000) / TICK_US; // Back 1 min, an hour after the world began
    await h.prepare(back, now / TICK_US);
    assert.deepEqual(posted, [{ base: 'http://example.invalid/s/x/history/', seq: 0, at: back * TICK_US - 10_000_000, now, ahead: true, floor: first }],
      'the window\'s start (10 s before the moment, as LiveWorld asks), the world\'s now and first moment');
    await h.prepare(first / TICK_US, now / TICK_US); // From the start: no earlier than the world's first moment
    assert.equal(posted[1].at, first);
    await h.prepare(back); // a moment link, now not known yet: the moment is taken as now
    assert.equal(posted[2].now, back * TICK_US);
    assert.ok(posted.every((m) => m.ahead && m.seq === 0), 'a read ahead is never a seek the page waits on');
    assert.equal(asked.filter((x) => x === 'header').length, 1, 'the immutable header is asked for once, ahead of the worker\'s first seek');
    // a link's moment, as the page starts: the worker is asked at once, for the moment's own day only, and not again
    // unless the world's first moment moves the window
    const link = new V2History('/s/x/history/', () => w as unknown as Worker, { rulesVersion: 'test/1' }), n = posted.length, wanted = back * TICK_US - 10_000_000;
    asked.length = 0;
    const reading = link.prepare(back, null, true);
    assert.deepEqual(posted.slice(n), [{ base: 'http://example.invalid/s/x/history/', seq: 0, at: wanted, now: back * TICK_US, ahead: true, floor: day * DAY }],
      'asked before any of the world\'s first moment is read');
    await reading;
    assert.equal(posted.length, n + 1, 'the same window is not asked for twice');
    await link.prepare(first / TICK_US - 100, null, true); // a link to before the world began: its day at once, then from the first moment
    assert.deepEqual(posted.slice(n + 1).map((m) => [m.at, m.floor]), [[first - 100 * TICK_US - 10_000_000, day * DAY], [first, first]]);
  } finally {
    globalThis.fetch = realFetch; (globalThis as { location?: unknown }).location = realLocation;
  }
});
