// #3825: the public stream starts a new generation from a fresh baseline every few minutes. The page's worker
// (worker.ts) runs here on a stand-in for the replica WASM against streams served from memory: a new viewer fetches
// only the newest generation; a live viewer drains the old generation to the handoff's end, checks its version and
// digest, and plays on in the new one with no gap, no snapshot and no `stream-generation-gap`; a viewer more than one
// generation behind starts again from the newest baseline. No build needed.
// A live viewer crosses without fetching the new baseline: its state is the baseline's, the digest checked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { encode } from 'cborg';
import { PERIOD_US } from '../clock/clock.ts';
import type { PartRec } from './source.ts';

const work = mkdtempSync(join(tmpdir(), 'v2-generations-'));
after(() => rmSync(work, { recursive: true, force: true }));

// The stand-in replica: a part's file holds `n:version`; a baseline's version is its fifth byte (cbor {3: {1: v}}),
// and the public digest is `d<version>`. It refuses a part out of order as the real one does.
const fake = join(work, 'replica.mjs');
writeFileSync(fake, `
const text = (b) => new TextDecoder().decode(b);
export default async function init() {}
export const readPointer = (b) => text(b);
export class StreamPlayer {
  static fromBaseline(h, b) { const p = new StreamPlayer(); p.v = b[4]; return p; }
  constructor() { this.n = 0; this.v = 0; }
  next() { return BigInt(this.n); }
  played(b) {
    const [k, v] = text(b).split(':').map(Number);
    if (k !== this.n) throw new Error('stream-gap');
    this.n++; this.v = v;
    return JSON.stringify({ number: k, from: k * ${PERIOD_US}, to: (k + 1) * ${PERIOD_US}, version: v, hash: true });
  }
  play(b) { return this.played(b); }
  playDeferred(b) { return this.played(b); }
  verify() {}
  query() { return new Uint8Array([0x80]); }
  snapshot() { return new Uint8Array([0x80]); }
  samples() { return '[]'; }
  events() { return new Uint8Array([0x80]); }
  publicHash() { return 'd' + this.v; }
  cross(g, d) { if (!/^[0-9a-f]{64}$/.test(g) || d !== 'd' + this.v) throw new Error('stream-handoff-state'); this.n = 0; }
  free() {}
}
`);
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: pathToFileURL(fake).href, shortCircuit: true } : next(s, c)) });

// Generation g begins at public version `first` and holds parts 0..count-1, part n at version first+n+1. Its id is its
// baseline's SHA-256, as the writer names it.
type Gen = { id: string; first: number; count: number };
const baselineOf = (first: number) => encode(new Map([[3, new Map([[1, first]])]]));
const gen = (first: number, count: number): Gen => ({ id: createHash('sha256').update(baselineOf(first)).digest('hex'), first, count });
const base = 'https://stream.example.invalid/a/b/c/d/';
const pointerOf = (g: Gen, newest: number, from?: Gen) => JSON.stringify({
  newest, newestTo: (newest + 1) * PERIOD_US, period: PERIOD_US, anchorWorld: (newest + 1) * PERIOD_US, anchorWallMs: Date.now(),
  header: 'h', baseline: g.id, generation: g.id,
  ...(from ? { legacyVersion: from.first + from.count, legacyNext: from.count, legacyHash: `d${from.first + from.count}`, handoffFrom: from.id } : {}),
});

async function viewer(gens: Gen[], steps: string[]) {
  const fetched: string[] = [], parts: PartRec[] = [], errors: string[] = [], polls: (() => Promise<void>)[] = [];
  let snapshots = 0, pointer = steps[0];
  const files = (path: string): Uint8Array | string | null => {
    if (path === '/a/b/c/d/pointer') return pointer;
    if (path === '/a/headers/h') return 'header';
    for (const g of gens) {
      const dir = `/a/b/c/d/g/${g.id}/`;
      if (!path.startsWith(dir)) continue;
      const file = path.slice(dir.length);
      if (file === 'baseline') return baselineOf(g.first);
      if (/^\d+$/.test(file) && Number(file) < g.count) return `${file}:${g.first + Number(file) + 1}`;
    }
    return null;
  };
  const before = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, self: (globalThis as { self?: unknown }).self };
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      fetched.push(path);
      const body = files(path);
      return body === null ? new Response(null, { status: 404 }) : new Response(body as BodyInit);
    }) as typeof fetch;
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => (polls.push(fn), 1);
    (globalThis as { self?: unknown }).self = {
      onmessage: null as null | ((e: unknown) => void),
      postMessage: (m: { t: string; p: PartRec; message: string }) =>
        m.t === 'part' ? parts.push(m.p) : m.t === 'snapshot' ? snapshots++ : m.t === 'error' ? errors.push(m.message) : undefined,
    };
    await import(new URL(`./worker.ts?generations-${Math.random()}`, import.meta.url).href);
    (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self.onmessage({ data: { stream: base } });
    const until = Date.now() + 10_000;
    while (!polls.length && !errors.length && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    for (const step of steps.slice(1)) {
      pointer = step;
      await polls[0]?.();
    }
  } finally {
    globalThis.fetch = before.fetch;
    globalThis.setInterval = before.setInterval;
    (globalThis as { self?: unknown }).self = before.self;
  }
  return { fetched, parts, errors, snapshots };
}

test('a new viewer fetches only the newest generation', async () => {
  const a = gen(0, 20), b = gen(20, 4);
  const { fetched, parts, errors } = await viewer([a, b], [pointerOf(b, 3, a)]);
  assert.deepEqual(errors, []);
  assert.deepEqual(parts.map((p) => p.number), [0, 1, 2, 3]);
  assert.ok(!fetched.some((f) => f.includes(`/g/${a.id}/`)), 'nothing of the old generation is fetched');
});

test('a live viewer drains the old generation and crosses to the new one with no gap and no snapshot', async () => {
  const a = gen(0, 5), b = gen(5, 3);
  // On A at part 2; the writer finishes A (parts 3, 4) and rolls over to B, whose parts 0 and 1 are out.
  const { parts, errors, snapshots, fetched } = await viewer([a, b], [pointerOf(a, 2), pointerOf(b, 1, a), pointerOf(b, 2, a)]);
  assert.deepEqual(errors, [], 'no stream-generation-gap and no handoff refusal');
  assert.ok(!fetched.includes(`/a/b/c/d/g/${b.id}/baseline`), 'the new baseline is not fetched');
  assert.deepEqual(parts.map((p) => p.number), [0, 1, 2, 3, 4, 0, 1, 2], 'every part of A, then B from its first');
  assert.deepEqual(parts.map((p) => p.to), [1, 2, 3, 4, 5, 1, 2, 3].map((n) => n * PERIOD_US));
  assert.equal(snapshots, 1, 'only the first baseline is shown whole; the crossing shows nothing new');
});

test('a viewer more than one generation behind starts again from the newest baseline', async () => {
  const a = gen(0, 3), b = gen(3, 3), c = gen(6, 2);
  const { parts, errors, snapshots } = await viewer([a, b, c], [pointerOf(a, 2), pointerOf(c, 1, b)]);
  assert.deepEqual(errors, []);
  assert.deepEqual(parts.map((p) => p.number), [0, 1, 2, 0, 1]);
  assert.equal(snapshots, 2, 'the newest baseline is shown whole');
});

test('a live viewer whose old generation was pruned starts again from the newest baseline', async () => {
  const a = gen(0, 3), b = gen(5, 2);
  // A really had 5 parts, but 3 and 4 are gone from the disk.
  const { parts, errors, snapshots } = await viewer([a, b], [pointerOf(a, 2), pointerOf(b, 1, { ...a, count: 5 })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(parts.map((p) => p.number), [0, 1, 2, 0, 1]);
  assert.equal(snapshots, 2);
});
