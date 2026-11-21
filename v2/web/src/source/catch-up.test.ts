// #3822: a page that joins a world that has run a while catches up without playing every old part as it plays a new
// one. The page's worker (worker.ts) runs here on a stand-in for the replica WASM (the module `replica`, which records
// what the worker asked of it) and a stream of 1,000 parts served from memory: the parts older than the clock would
// ever show are played deferred and shown as one snapshot after one check of the state's digest; only the newest are
// posted as parts, and the parts are fetched several at a time, not one round trip each. No build needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { encode } from 'cborg';
import { BEHIND_US, CUT_US, PERIOD_US } from '../clock/clock.ts';
import type { PartRec } from './source.ts';

const PARTS = 1000;
const work = mkdtempSync(join(tmpdir(), 'v2-catch-up-'));
after(() => rmSync(work, { recursive: true, force: true }));

// The stand-in replica: part n's file holds the text `n`; it plays them in order and keeps count of what was asked.
const fake = join(work, 'replica.mjs');
writeFileSync(fake, `
const text = (b) => new TextDecoder().decode(b);
export const asked = { play: 0, deferred: 0, verify: 0, verifiedBeforeSnapshot: true };
globalThis.__replica = asked;
export default async function init() {}
export const readPointer = (b) => text(b);
export class StreamPlayer {
  static fromBaseline() { return new StreamPlayer(); }
  constructor() { this.n = 0; this.unverified = false; }
  next() { return BigInt(this.n); }
  played(b) {
    const k = Number(text(b));
    if (k !== this.n) throw new Error('stream-gap');
    this.n++;
    return JSON.stringify({ number: k, from: k * ${PERIOD_US}, to: (k + 1) * ${PERIOD_US}, version: k + 1, hash: true });
  }
  play(b) { asked.play++; this.unverified = false; return this.played(b); }
  playDeferred(b) { asked.deferred++; this.unverified = true; return this.played(b); }
  verify() { asked.verify++; this.unverified = false; }
  query() { return new Uint8Array([0x80]); }
  snapshot() { if (this.unverified) asked.verifiedBeforeSnapshot = false; return globalThis.__snapshot; }
  samples() { return '[]'; }
  events() { return new Uint8Array([0x80]); }
  publicHash() { return ''; }
  free() {}
}
`);
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: pathToFileURL(fake).href, shortCircuit: true } : next(s, c)) });

test('a joiner 1,000 parts behind plays the old ones deferred, shows one snapshot and posts only the newest parts', async () => {
  (globalThis as { __snapshot?: Uint8Array }).__snapshot = encode([new Map<number, unknown>([[1, [new Uint8Array(16).fill(7), 1]], [2, 'world']])]);
  const baseline = encode(new Map([[3, new Map([[1, 0]])]]));
  const generation = createHash('sha256').update(baseline).digest('hex');
  const pointer = JSON.stringify({
    newest: PARTS - 1, newestTo: PARTS * PERIOD_US, period: PERIOD_US, anchorWorld: PARTS * PERIOD_US, anchorWallMs: Date.now(),
    header: 'h', baseline: generation, generation,
  });
  const base = 'https://stream.example.invalid/a/b/c/d/';
  let inFlight = 0, most = 0;
  const files = (path: string): Uint8Array | string | null => {
    if (path === '/a/b/c/d/pointer') return pointer;
    if (path === '/a/headers/h') return 'header';
    const g = `/a/b/c/d/g/${generation}/`;
    if (path === `${g}baseline`) return baseline;
    const n = path.startsWith(g) ? path.slice(g.length) : '';
    return /^\d+$/.test(n) && Number(n) < PARTS ? n : null;
  };
  const parts: PartRec[] = [], errors: string[] = [], polls: (() => Promise<void>)[] = [];
  let snapshots = 0;
  const before = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, self: (globalThis as { self?: unknown }).self };
  try {
    globalThis.fetch = (async (input: string | URL) => {
      inFlight++, (most = Math.max(most, inFlight));
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const body = files(new URL(String(input)).pathname);
      return body === null ? new Response(null, { status: 404 }) : new Response(body);
    }) as typeof fetch;
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => (polls.push(fn), 1);
    (globalThis as { self?: unknown }).self = {
      onmessage: null as null | ((e: unknown) => void),
      postMessage: (m: { t: string; p: PartRec; message: string }) =>
        m.t === 'part' ? parts.push(m.p) : m.t === 'snapshot' ? snapshots++ : m.t === 'error' ? errors.push(m.message) : undefined,
    };
    await import(new URL('./worker.ts?catch-up', import.meta.url).href);
    (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self.onmessage({ data: { stream: base } });
    const until = Date.now() + 30_000;
    while (!polls.length && !errors.length && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    for (let seen = -1; seen !== parts.length && !errors.length && Date.now() < until; ) { seen = parts.length; await polls[0]?.(); }
  } finally {
    globalThis.fetch = before.fetch;
    globalThis.setInterval = before.setInterval;
    (globalThis as { self?: unknown }).self = before.self;
  }
  const asked = (globalThis as unknown as { __replica: { play: number; deferred: number; verify: number; verifiedBeforeSnapshot: boolean } }).__replica;
  assert.deepEqual(errors, []);
  const far = Math.ceil((BEHIND_US + CUT_US) / PERIOD_US);
  assert.equal(parts.at(-1)?.number, PARTS - 1, 'the newest part is played');
  assert.ok(parts.length <= far + 1, `only the parts the clock can show are posted (${parts.length}, at most ${far + 1})`);
  assert.ok(asked.deferred >= PARTS - far - 1, `the older parts are played deferred (${asked.deferred})`);
  assert.ok(asked.verify >= 1 && asked.verifiedBeforeSnapshot, 'the deferred state is checked before it is shown');
  assert.ok(snapshots >= 2, 'the baseline and the caught-up state are each shown as one snapshot');
  assert.ok(asked.play >= 1, 'the newest part is played with its digest worked out');
  assert.ok(most > 1, `parts are fetched several at a time (at most ${most} at once)`);
});
