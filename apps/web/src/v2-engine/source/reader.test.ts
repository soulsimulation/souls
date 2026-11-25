// #4684 review: the page's worker (worker.ts) on a stand-in replica whose world the test scripts part by part. It checks
// what the page draws from the worker's snapshots and parts against the drawable set worked out from the whole world
// after every part (a frame arriving after its children, a frame removed with its children, moves between frames, a
// cycle), with the replica's query 7 and with a replica that refuses it; and that a reader whose parts stop coming in
// the middle of a catch-up lets the page's silence notice show after 15 s, instead of saying it is catching up for ever.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decode, encode } from 'cborg';
import { PERIOD_US } from './clock.ts';
import type { PartRec, SnapshotRec } from './source.ts';
import { V2Bridge } from '../bridge.ts';
import { STREAM_NOTICE, STREAM_SILENCE_MS, StreamLife, streamNotice } from '../stream-health.ts';

const work = mkdtempSync(join(tmpdir(), 'v2-reader-'));
after(() => rmSync(work, { recursive: true, force: true }));
// The stand-in replica: part n's file holds the text `n`; the world it plays is the test's (`globalThis.__world`).
const fake = join(work, 'replica.mjs');
writeFileSync(fake, `
const text = (b) => new TextDecoder().decode(b);
const w = () => globalThis.__world;
export default async function init() {}
export const readPointer = (b) => text(b);
export class StreamPlayer {
  static fromBaseline() { return new StreamPlayer(); }
  constructor() { this.n = 0; }
  next() { return BigInt(this.n); }
  played(b) {
    const k = Number(text(b));
    if (k !== this.n) throw new Error('stream-gap');
    w().play(k); this.n++;
    return JSON.stringify({ number: k, from: k * ${PERIOD_US}, to: (k + 1) * ${PERIOD_US}, version: w().version, hash: true });
  }
  play(b) { return this.played(b); }
  playDeferred(b) { return this.played(b); }
  verify() {}
  query(q) { return w().query(q); }
  snapshot() { return w().snapshot(); }
  samples() { return '[]'; }
  events() { return new Uint8Array([0x80]); }
  publicHash() { return ''; }
  free() {}
}
`);
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: pathToFileURL(fake).href, shortCircuit: true } : next(s, c)) });

const SCOPE = new Uint8Array(16).fill(0x11);
const HEX = '11'.repeat(16);
const idv = (n: number) => [SCOPE, n];
const keyOf = (n: number) => `${HEX}.${n}`;
const numOf = (v: unknown) => Number((v as [Uint8Array, number | bigint])[1]);
type Step = { set?: [number, number | null][]; remove?: number[] };

/** The world the stand-in plays: nodes by id with their frame, each one's version, and part n's step. */
class World {
  readonly nodes = new Map<number, number | null>();
  readonly changed = new Map<number, number>();
  version = 0;
  asked7 = 0;
  drawableAfter: Set<string>[] = [];
  readonly steps: Step[];
  readonly refuse7: boolean;
  constructor(start: [number, number | null][], steps: Step[], refuse7 = false) {
    this.steps = steps; this.refuse7 = refuse7;
    for (const [id, parent] of start) this.nodes.set(id, parent);
  }
  play(k: number) {
    const s = this.steps[k] ?? {};
    this.version++;
    for (const [id, parent] of s.set ?? []) { this.nodes.set(id, parent); this.changed.set(id, this.version); }
    for (const id of s.remove ?? []) { this.nodes.delete(id); this.changed.set(id, this.version); }
    this.drawableAfter[k] = this.drawable();
  }
  /** Drawable: its chain of frames reaches the root (no frame) through known nodes, no cycle, at most 32 deep. */
  drawable(): Set<string> {
    const out = new Set<string>();
    for (const start of this.nodes.keys()) {
      let id: number | null = start;
      for (let d = 0, seen = new Set<number>(); d <= 32; d++) {
        if (id === null || seen.has(id) || !this.nodes.has(id)) break;
        seen.add(id);
        const p: number | null = this.nodes.get(id)!;
        if (p === null) { out.add(keyOf(start)); break; }
        id = p;
      }
    }
    return out;
  }
  rec(id: number) {
    const p = this.nodes.get(id);
    return new Map<number, unknown>([[1, idv(id)], [2, 'test:thing'], ...(p != null ? [[3, idv(p)] as [number, unknown]] : [])]);
  }
  query(bytes: Uint8Array): Uint8Array {
    const q = decode(bytes, { useMaps: true }) as Map<number, unknown>, arg = q.get(2);
    if (q.get(1) === 5) return encode([...this.changed].filter(([, v]) => v > Number(arg)).sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([id, v]) => [idv(id), v]));
    if (q.get(1) === 7) {
      this.asked7++;
      if (this.refuse7) throw new Error('query is 1 through 6');
      return encode((arg as unknown[]).map(numOf).filter((id) => this.nodes.has(id)).map((id) => this.rec(id)));
    }
    if (q.get(1) === 1) { const id = numOf(arg); if (!this.nodes.has(id)) throw new Error('node-missing'); return encode(this.rec(id)); }
    throw new Error('not asked here');
  }
  snapshot() { return encode([...this.nodes.keys()].map((id) => this.rec(id))); }
}

type Msg = { t: 'snapshot'; s: SnapshotRec } | { t: 'part'; p: PartRec } | { t: 'catching'; behind: number } | { t: 'error'; message: string } | { t: string };

/** Runs the worker on `world` (newest part `newest`, parts up to `served` served, the rest 404): its first poll, then
 *  `polls` more, each followed by `each(messages of that poll, poll index)`. */
async function run(world: World, newest: number, served: number, polls: number, each: (m: Msg[], i: number) => void, tag: string,
  still?: { quietAt: (i: number) => number; fails: (path: string, i: number) => boolean; hangs?: (path: string, i: number) => boolean }) {
  (globalThis as { __world?: World }).__world = world;
  const baseline = encode(new Map([[3, new Map([[1, 0]])]]));
  const generation = createHash('sha256').update(baseline).digest('hex');
  const pointer = JSON.stringify({ newest, newestTo: (newest + 1) * PERIOD_US, period: PERIOD_US, anchorWorld: (newest + 1) * PERIOD_US, anchorWallMs: Date.now(), header: 'h', baseline: generation, generation });
  // `still`: the pointer of a world writing no part, its quiet time moving on at each poll, and reads that fail.
  let poll = 0;
  const files = (path: string): Uint8Array | string | null => {
    if (path === '/a/b/c/d/pointer') return still ? JSON.stringify({ ...JSON.parse(pointer), quietUntil: still.quietAt(poll) }) : pointer;
    if (path === '/a/headers/h') return 'header';
    const g = `/a/b/c/d/g/${generation}/`;
    if (path === `${g}baseline`) return baseline;
    const n = path.startsWith(g) ? path.slice(g.length) : '';
    return /^\d+$/.test(n) && Number(n) <= served ? n : null;
  };
  const got: Msg[] = [], ticks: (() => Promise<void>)[] = [];
  const before = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, self: (globalThis as { self?: unknown }).self };
  try {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (still?.fails(new URL(String(input)).pathname, poll)) throw new TypeError('Failed to fetch');
      // A read that never answers: only its signal, if it has one, ends it.
      if (still?.hangs?.(new URL(String(input)).pathname, poll)) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      }
      const body = files(new URL(String(input)).pathname);
      return body === null ? new Response(null, { status: 404 }) : new Response(body as BodyInit);
    }) as typeof fetch;
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => (ticks.push(fn), 1);
    (globalThis as { self?: unknown }).self = { onmessage: null, postMessage: (m: Msg) => got.push(m) };
    await import(new URL(`./worker.ts?${tag}`, import.meta.url).href);
    (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self.onmessage({ data: { stream: 'https://stream.example.invalid/a/b/c/d/' } });
    const until = Date.now() + 30_000;
    while (!ticks.length && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.ok(ticks.length, 'the first poll ends');
    each(got.splice(0), 0);
    for (let i = 1; i <= polls; i++) { poll = i; await ticks[0](); each(got.splice(0), i); }
  } finally {
    globalThis.fetch = before.fetch;
    globalThis.setInterval = before.setInterval;
    (globalThis as { self?: unknown }).self = before.self;
  }
}

// root 1, ground 2 under it; then each part's step
const START: [number, number | null][] = [[1, null], [2, 1]];
const STEPS: Step[] = [
  { set: [[10, 3]] },              // 0: a thing in frame 3, which is not here yet
  { set: [[3, 1]] },               // 1: frame 3 arrives after its child: both drawn
  { set: [[11, 3]] },              // 2: a second child of 3
  { set: [[10, 2]] },              // 3: 10 moves from frame 3 to frame 2
  { set: [[10, 99]] },             // 4: 10 moves into frame 99, not here: not drawn
  { remove: [3] },                 // 5: frame 3 removed with its child 11
  { set: [[20, 21], [21, 20]] },   // 6: a cycle: neither drawn
  { set: [[99, 2]] },              // 7: frame 99 arrives: 10 drawn again
  { set: [[21, 1]] },              // 8: the cycle broken: 21 and 20 drawn
  { set: [[3, 2]] },               // 9: frame 3 back: its child 11 drawn again
  { remove: [11, 10] },            // 10: removed
];

for (const refuse7 of [false, true]) {
  test(`what the page draws is the world's drawable set after every part${refuse7 ? ', on a replica that refuses query 7' : ''}`, async () => {
    const world = new World(START, STEPS, refuse7);
    const drawn = new Set<string>(), errors: string[] = [];
    let checked = 0;
    await run(world, STEPS.length - 1, STEPS.length - 1, 1, (msgs) => {
      for (const m of msgs) {
        if (m.t === 'error') errors.push((m as { message: string }).message);
        const c = m.t === 'snapshot' ? (m as { s: SnapshotRec }).s : m.t === 'part' ? (m as { p: PartRec }).p : null;
        if (!c) continue;
        for (const id of c.removed) drawn.delete(id);
        for (const n of c.nodes) drawn.add(n.id);
        const want = m.t === 'part' ? world.drawableAfter[(m as { p: PartRec }).p.number] : new Set([keyOf(1), keyOf(2)]);
        assert.deepEqual([...drawn].sort(), [...want].sort(), m.t === 'part' ? `after part ${(m as { p: PartRec }).p.number}` : 'the baseline');
        if (m.t === 'part') checked++;
      }
    }, `draw-${refuse7}`);
    assert.deepEqual(errors, []);
    assert.equal(checked, STEPS.length, 'every part posted');
    // query 7 answers every part; a replica that refuses it is asked once, and the reader reads as before
    assert.equal(world.asked7, refuse7 ? 1 : STEPS.length);
  });
}

test('a reader whose parts stop coming in a catch-up says nothing more, and the page shows the notice after 15 s', async () => {
  const PARTS = 1000, SERVED = 59, POLL_MS = 250;
  const world = new World(START, []);
  const bridge = new V2Bridge({ rulesVersion: 'test/1' }), life = new StreamLife();
  let catching = 0, partsSeen = 0, lastLife = 0;
  const notices: [number, string | null][] = [];
  await run(world, PARTS - 1, SERVED, 120, (msgs, i) => {
    const now = i * POLL_MS;
    for (const m of msgs) {
      if (m.t === 'catching') catching++;
      if (m.t === 'part') partsSeen++;
      bridge.receive(m as Parameters<V2Bridge['receive']>[0]);
    }
    const had = life.lastPartAt;
    life.see(bridge.view, now);
    if (life.lastPartAt !== had) lastLife = now;
    notices.push([now, streamNotice({ failed: false, error: bridge.view.error, errorAtParts: null, parts: life.parts, startedAt: 0, lastPartAt: life.lastPartAt, now, catching: !!bridge.view.catching })]);
  }, 'stuck');
  assert.equal(partsSeen, 0, 'nothing past the catch-up comes');
  assert.ok(catching >= 1 && catching <= 2, `a word for the parts played, none for the polls that played nothing (${catching})`);
  assert.equal(world.version, SERVED + 1, 'the parts there were are played');
  const shown = notices.filter(([, n]) => n === STREAM_NOTICE).map(([t]) => t);
  assert.equal(shown[0], lastLife + STREAM_SILENCE_MS, 'the notice shows 15 s after the last sign of life');
  assert.ok(notices.every(([t, n]) => (t < lastLife + STREAM_SILENCE_MS) === (n !== STREAM_NOTICE)), 'and not before');
});

test('25 Nov: in a still world one failed read of the pointer never shows the notice once its pointer moves on again', async () => {
  // Eden on soul.game: no part for 10 minutes, and the page said the stream was not available until the next part.
  const POLL_MS = 250, POLLS = 2 * 60 * 4, NEWEST = 3;
  const world = new World(START, [{}, {}, {}, {}]);
  const bridge = new V2Bridge({ rulesVersion: 'test/1' }), life = new StreamLife();
  // As use-v2-souls.ts keeps them: the error first seen, by parts and by time.
  let lastError: string | null = null, errorAtParts: number | null = null, errorAt: number | null = null;
  const notices: number[] = [], errors: string[] = [];
  await run(world, NEWEST, NEWEST, POLLS, (msgs, i) => {
    const now = i * POLL_MS;
    for (const m of msgs) {
      if (m.t === 'error') errors.push((m as { message: string }).message);
      bridge.receive(m as Parameters<V2Bridge['receive']>[0]);
    }
    const v = bridge.view;
    if (v.error && v.error !== lastError) { lastError = v.error; errorAtParts = life.parts; errorAt = now; }
    life.see(v, now);
    if (streamNotice({ failed: false, error: v.error, errorAtParts, errorAt, parts: life.parts, startedAt: 0, lastPartAt: life.lastPartAt, now })) notices.push(now);
  }, 'still', { quietAt: (i) => (NEWEST + 1) * PERIOD_US + i * POLL_MS * 1000, fails: (path, i) => i === 40 && path.endsWith('/pointer') });
  assert.equal(errors.length, 1, 'the one failed read is an error');
  // At most the failed poll's own 250 ms (the status line waits 4 s before it shows a passing reason); none after it.
  assert.ok(notices.length <= 1 && notices.every((t) => t === 40 * POLL_MS), `no notice through two still minutes: ${notices}`);
});

test('25 Nov: a pointer read that never answers is given up, and the next poll reads the pointer again', { timeout: 10_000 }, async () => {
  // The reader's read timeout, cut to 50 ms here so the test runs at its own pace.
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = () => timeout.call(AbortSignal, 50);
  // AbortSignal.timeout's timer does not hold the event loop open: while the hung read waits on it alone, a ref'd timer
  // keeps the test from being cancelled with its promise still pending (CI).
  const awake = setInterval(() => {}, 1000);
  try {
    const POLL_MS = 250, POLLS = 80, NEWEST = 3;
    const world = new World(START, [{}, {}, {}, {}]);
    const bridge = new V2Bridge({ rulesVersion: 'test/1' });
    const errors: string[] = [], seen = new Map<number, number | null>();
    await run(world, NEWEST, NEWEST, POLLS, (msgs, i) => {
      for (const m of msgs) {
        if (m.t === 'error') errors.push((m as { message: string }).message);
        bridge.receive(m as Parameters<V2Bridge['receive']>[0]);
      }
      seen.set(i, bridge.view.newestTo);
    }, 'hung', { quietAt: (i) => (NEWEST + 1) * PERIOD_US + i * POLL_MS * 1000, fails: () => false, hangs: (path, i) => i === 40 && path.endsWith('/pointer') });
    assert.equal(errors.length, 1, `the hung read is given up as an error: ${errors}`);
    assert.ok((seen.get(POLLS) ?? 0) > (seen.get(40) ?? Infinity), `and the polls after it read the pointer again: ${seen.get(40)} then ${seen.get(POLLS)}`);
  } finally { AbortSignal.timeout = timeout; clearInterval(awake); }
});
