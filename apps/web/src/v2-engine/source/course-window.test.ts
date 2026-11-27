// 27 Nov: a cold arrival reaches now in seconds. The page's worker (worker.ts) runs here on a stand-in for the replica
// WASM against a stream served from memory, as backoff.test.ts runs it: a cold arrival on an old checkpoint plays its
// last parts, some long (a quiet stretch), and the worker works out a balloon's course only over the time the page keeps.
// What the page holds of it then (bridge.ts: keepPlaces and its cut, the newest `leaves`) is exactly what the old worker
// gave it, the parts are played in their order with 64 read ahead, and a refused read still backs off: one part a poll,
// not 64 at once. No build needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { encode } from 'cborg';
import { BEHIND_US, CUT_US, PERIOD_US } from './clock.ts';
import { courseLeaves, coursePlaces, keepPlaces, type CourseAt } from '../course-samples.ts';

const S = 1_000_000;
/** The balloon's course: a minute round, flying 20 s at 1 m/s, then 40 s at its stop. */
const courseAt: CourseAt = (_field, t) => {
  const s = Number(t) / S, lap = Math.floor(s / 60), into = s - lap * 60, flying = into < 20;
  return [BigInt(Math.round((lap * 20 + Math.min(into, 20)) * S)), 0n, 0n, flying ? BigInt(S) : 0n, 0n, 0n];
};
(globalThis as { __courseAt?: CourseAt }).__courseAt = courseAt;
/** Part k's span, world µs (set by each test). */
let span: (k: number) => [number, number] = (k) => [k * PERIOD_US, (k + 1) * PERIOD_US];
(globalThis as { __span?: (k: number) => [number, number] }).__span = (k) => span(k);

const work = mkdtempSync(join(tmpdir(), 'v2-course-window-'));
after(() => rmSync(work, { recursive: true, force: true }));
const fake = join(work, 'replica.mjs');
writeFileSync(fake, `
const text = (b) => new TextDecoder().decode(b);
export default async function init() {}
export const readPointer = (b) => text(b);
export const courseAt = (f, t) => { globalThis.__courseCalls = (globalThis.__courseCalls ?? 0) + 1; return globalThis.__courseAt(f, t); };
export class StreamPlayer {
  static fromBaseline() { return new StreamPlayer(); }
  constructor() { this.n = 0; }
  next() { return BigInt(this.n); }
  play(b) {
    const k = Number(text(b));
    if (k !== this.n) throw new Error('stream-gap ' + k + ' at ' + this.n);
    this.n++;
    const [from, to] = globalThis.__span(k);
    return JSON.stringify({ number: k, from, to, version: k + 1, hash: true });
  }
  playDeferred(b) { return this.play(b); }
  verify() {}
  query() { return new Uint8Array([0x80]); }
  snapshot() { return globalThis.__snapshot; }
  samples() { return '[]'; }
  events() { return new Uint8Array([0x80]); }
  publicHash() { return ''; }
  free() {}
}
`);
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: pathToFileURL(fake).href, shortCircuit: true } : next(s, c)) });

const world = [new Uint8Array(16).fill(7), 1], balloon = [new Uint8Array(16).fill(9), 1];
(globalThis as { __snapshot?: Uint8Array }).__snapshot = encode([
  new Map<number, unknown>([[1, world], [2, 'world']]),
  new Map<number, unknown>([[1, balloon], [2, 'balloon'], [3, world], [6, new Map([[80, new Map([[1, 1]])]])]]),
]);
const balloonId = `${'09'.repeat(16)}.1`;

type Posted = { t: string; message?: string; p?: { number: number; from: number; to: number; courses?: Record<string, number[]>; leaves?: Record<string, number> } };
/** Starts a worker on a stream of `newest + 1` parts; `delay(path)` is how long each read takes, `edge()` how it answers. */
async function start(name: string, o: { newest: () => number; delay?: (path: string) => number; edge?: () => 'ok' | 'parts' }) {
  const baseline = encode(new Map([[3, new Map([[1, 0]])]]));
  const generation = createHash('sha256').update(baseline).digest('hex');
  const g = `/a/b/c/d/g/${generation}/`;
  const posted: Posted[] = [], polls: (() => Promise<void>)[] = [], reads: string[] = [];
  const pointer = () => JSON.stringify({ newest: o.newest(), newestTo: span(o.newest())[1], period: PERIOD_US, anchorWorld: span(o.newest())[1], anchorWallMs: Date.now(), header: 'h', baseline: generation, generation });
  globalThis.fetch = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    reads.push(path);
    await new Promise((r) => setTimeout(r, o.delay?.(path) ?? 1));
    if (path === '/a/b/c/d/pointer') return new Response(pointer());
    if (o.edge?.() === 'parts') return new Response(null, { status: 403 });
    if (path === '/a/headers/h') return new Response('header');
    if (path === `${g}baseline`) return new Response(baseline);
    const n = path.startsWith(g) ? path.slice(g.length) : '';
    return /^\d+$/.test(n) && Number(n) <= o.newest() ? new Response(n) : new Response(null, { status: 404 });
  }) as typeof fetch;
  (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => (polls.push(fn), 1);
  (globalThis as { self?: unknown }).self = { onmessage: null, postMessage: (m: Posted) => posted.push(m) };
  await import(new URL(`./worker.ts?${name}`, import.meta.url).href);
  (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self.onmessage({ data: { stream: 'https://stream.example.invalid/a/b/c/d/' } });
  const until = Date.now() + 30_000;
  while (!polls.length && !posted.some((m) => m.t === 'error') && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  return { posted, polls, reads, g };
}

const before = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, self: (globalThis as { self?: unknown }).self };
after(() => { globalThis.fetch = before.fetch; globalThis.setInterval = before.setInterval; (globalThis as { self?: unknown }).self = before.self; });

test('a cold arrival works out courses only over the kept time, and the page holds exactly what it held before', async () => {
  // 600 parts of half a second, then the last 44 the worker plays one by one (it plays those past BEHIND_US + CUT_US
  // deferred): a quiet stretch of ten minutes, then 5 s parts, so they span more than the 90 s the page keeps
  const far = Math.ceil((BEHIND_US + CUT_US) / PERIOD_US), newest = 600 + far, quiet = newest - far + 1;
  const ends: number[] = [];
  for (let k = 0, t = 0; k <= newest; k++) { t += k < quiet ? PERIOD_US : k === quiet ? 600 * S : 5 * S; ends.push(t); }
  span = (k) => [k ? ends[k - 1] : 0, ends[k]];
  const { posted } = await start('window', { newest: () => newest });
  assert.deepEqual(posted.filter((m) => m.t === 'error'), []);
  const parts = posted.filter((m) => m.t === 'part').map((m) => m.p!);
  assert.deepEqual(parts.map((p) => p.number), Array.from({ length: far }, (_, i) => newest - far + 1 + i), 'every part the worker plays, in order');

  // The old worker: every course over every part's whole span, and when each still thing moves on at each part's end.
  const oldHeld = new Map<string, number[]>(), newHeld = new Map<string, number[]>();
  const oldLeaves: Record<string, number> = {}, newLeaves: Record<string, number> = {};
  const node = [{ id: balloonId, course: new Uint8Array([1]) }];
  let oldCalls = 0;
  const counted: CourseAt = (f, t) => (oldCalls++, courseAt(f, t));
  for (const p of parts) {
    keepPlaces(oldHeld, coursePlaces(counted, node, p.from, p.to));
    Object.assign(oldLeaves, courseLeaves(counted, node, p.to));
    keepPlaces(newHeld, p.courses);
    Object.assign(newLeaves, p.leaves ?? {});
  }
  // The page keeps its places from a minute before its oldest chunk (bridge.ts publish): 84 s before the newest at most.
  const newestTo = ends[newest], cut = newestTo - 84 * S;
  keepPlaces(oldHeld, undefined, cut);
  keepPlaces(newHeld, undefined, cut);
  assert.ok((oldHeld.get(balloonId)?.length ?? 0) > 800 * 4, 'the page holds the balloon\'s places over its kept time');
  assert.deepEqual(newHeld, oldHeld, 'the same places, at the same times, for the time the page keeps');
  // `leaves` is read only for a time ahead of the moment drawn, which is never before the cut
  const ahead = (l: Record<string, number>) => Object.fromEntries(Object.entries(l).filter(([, at]) => at > cut));
  assert.deepEqual(ahead(newLeaves), ahead(oldLeaves), 'the same "takes off in" for every moment the page draws');
  const calls = (globalThis as { __courseCalls?: number }).__courseCalls ?? 0;
  assert.ok(calls * 5 < oldCalls, `the course is worked out far less often (${calls} times, not ${oldCalls})`);
});

test('64 read ahead are played in their order, and a refused read backs off to one a poll', async () => {
  let newest = 0, edge: 'ok' | 'parts' = 'ok';
  span = (k) => [k * PERIOD_US, (k + 1) * PERIOD_US];
  // a later part answers sooner than an earlier one
  const { posted, polls, reads, g } = await start('ahead', { newest: () => newest, edge: () => edge, delay: (p) => (p.startsWith('/a/b/c/d/g/') && /\/\d+$/.test(p) ? 1 + (1000 - Number(p.split('/').pop())) % 17 : 1) });
  const partReads = () => reads.filter((p) => p.startsWith(g) && /\/\d+$/.test(p)).length;
  newest = 200;
  await polls[0]();
  assert.deepEqual(posted.filter((m) => m.t === 'error'), []);
  assert.equal(Math.max(...posted.filter((m) => m.t === 'part').map((m) => m.p!.number)), 200, 'all played, in order (a gap would have thrown)');

  // The pointer names 100 more parts, which the edge refuses: the poll that finds it out has asked for 64, but from then
  // on no poll asks for more than one.
  newest = 300; edge = 'parts';
  await polls[0]();
  for (let k = 0; k < 40; k++) {
    const was = partReads();
    await polls[0]();
    assert.ok(partReads() - was <= 1, `a refused poll asks for one part at most, not 64 (${partReads() - was})`);
  }
  // It answers again (the pointer naming them all): within the cap it reads on, and a read ahead that failed is read
  // again, not kept as missing: all 100 are played within a few polls of the first good one.
  edge = 'ok';
  let k = 0;
  while (Math.max(...posted.filter((m) => m.t === 'part').map((m) => m.p!.number)) < 300 && k++ < 80) await polls[0]();
  assert.ok(k <= 45, `caught up within ${k} polls of the edge answering again (the wait is at most 10 s, 40 polls)`);
  assert.deepEqual(posted.filter((m) => m.t === 'error'), []);
});
