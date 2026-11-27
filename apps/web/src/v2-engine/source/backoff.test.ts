// #5068 item 13: the page's stream reader backs off when its reads are refused. The page's worker (worker.ts) runs here
// on a stand-in for the replica WASM against a stream served from memory, the test calling its poll as its 250 ms
// timer would: while the edge answers 403, or does not answer, the reads thin out to one every 10 s at most;
// the first good read brings back the usual pace; and a 404 for a part not written yet never slows it. No build needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { encode } from 'cborg';
import { backoffMs } from './backoff.ts';
import { PERIOD_US } from './clock.ts';

test('the wait is a random time within a window that doubles from 250 ms to 10 s, and none after a good read', () => {
  assert.equal(backoffMs(0, () => 1), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffMs(n, () => 1)), [250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  assert.equal(backoffMs(7, () => 0), 0, 'full jitter: anywhere from no wait');
  assert.equal(backoffMs(7, () => 0.5), 5000, 'to the whole window');
  for (let k = 0; k < 100; k++) { const w = backoffMs(4); assert.ok(w >= 0 && w < 2000); }
});

const work = mkdtempSync(join(tmpdir(), 'v2-backoff-'));
after(() => rmSync(work, { recursive: true, force: true }));
// The stand-in replica: part n's file holds the text `n`, played in order.
const fake = join(work, 'replica.mjs');
writeFileSync(fake, `
const text = (b) => new TextDecoder().decode(b);
export default async function init() {}
export const readPointer = (b) => text(b);
export class StreamPlayer {
  static fromBaseline() { return new StreamPlayer(); }
  constructor() { this.n = 0; }
  next() { return BigInt(this.n); }
  play(b) {
    const k = Number(text(b));
    if (k !== this.n) throw new Error('stream-gap');
    this.n++;
    return JSON.stringify({ number: k, from: k * ${PERIOD_US}, to: (k + 1) * ${PERIOD_US}, version: k + 1, hash: true });
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

test('refused and unanswered reads thin out to the cap, a good read restores the pace, a 404 never slows it', async () => {
  (globalThis as { __snapshot?: Uint8Array }).__snapshot = encode([new Map<number, unknown>([[1, [new Uint8Array(16).fill(7), 1]], [2, 'world']])]);
  const baseline = encode(new Map([[3, new Map([[1, 0]])]]));
  const generation = createHash('sha256').update(baseline).digest('hex');
  const start = Date.now();
  let newest = 0, written = 0;
  let edge: 'ok' | 'refuses' | 'silent' = 'ok';
  const pointer = () => JSON.stringify({ newest, newestTo: (newest + 1) * PERIOD_US, period: PERIOD_US, anchorWorld: (newest + 1) * PERIOD_US, anchorWallMs: start, header: 'h', baseline: generation, generation });
  const base = 'https://stream.example.invalid/a/b/c/d/', g = `/a/b/c/d/g/${generation}/`;
  const files = (path: string): Uint8Array | string | null => {
    if (path === '/a/b/c/d/pointer') return pointer();
    if (path === '/a/headers/h') return 'header';
    if (path === `${g}baseline`) return baseline;
    const n = path.startsWith(g) ? path.slice(g.length) : '';
    return /^\d+$/.test(n) && Number(n) <= written ? n : null;
  };
  const errors: string[] = [], polls: (() => Promise<void>)[] = [];
  let pointers = 0, parts = 0;
  const before = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, self: (globalThis as { self?: unknown }).self, random: Math.random };
  /** `ticks` polls, each 250 ms of the reader's timer; how many of them read the pointer. */
  const run = async (ticks: number) => {
    const from = pointers;
    for (let k = 0; k < ticks; k++) await polls[0]();
    return pointers - from;
  };
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/pointer')) pointers++;
      await new Promise((r) => setTimeout(r, 1));
      if (edge === 'silent') throw new TypeError('fetch failed');
      if (edge === 'refuses') return new Response(null, { status: 403 });
      const body = files(path);
      if (body !== null && /\/\d+$/.test(path)) parts++;
      return body === null ? new Response(null, { status: 404 }) : new Response(body as BodyInit);
    }) as typeof fetch;
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => (polls.push(fn), 1);
    (globalThis as { self?: unknown }).self = {
      onmessage: null as null | ((e: unknown) => void),
      postMessage: (m: { t: string; message: string }) => { if (m.t === 'error') errors.push(m.message); },
    };
    await import(new URL('./worker.ts?backoff', import.meta.url).href);
    (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self.onmessage({ data: { stream: base } });
    const until = Date.now() + 30_000;
    while (!polls.length && !errors.length && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(errors, []);
    assert.equal(parts, 1, 'the first part is played');
    Math.random = () => 0.999; // the whole window each time: the slowest the reader may get

    assert.equal(await run(20), 20, 'a good stream is read at every poll');

    // The edge refuses every read (a 403, as Cloudflare answered the load test's machines): 40 s of polls.
    edge = 'refuses';
    const refused = await run(160);
    assert.ok(refused >= 8 && refused <= 10, `40 s of refusals are about nine reads, not 160 (${refused})`);
    assert.deepEqual(errors, [], 'a refused pointer is no error on the page, as before');
    // It stops answering at all: the same wait goes on, now at its cap, and each failed read is said as before.
    edge = 'silent';
    const silent = await run(160);
    assert.ok(silent >= 3 && silent <= 5, `40 s without an answer are about four reads (${silent})`);
    assert.equal(errors.length, silent, 'an unanswered read is still said to the page');

    // The first good read restores the pace: within the cap it is read, and from then on at every poll.
    edge = 'ok';
    assert.ok((await run(40)) >= 1, 'read again within 10 s');
    assert.equal(await run(20), 20, 'then at every poll again');

    // A part the pointer names that is not written yet (a 404) is read again at every poll, as before.
    newest = 1;
    const partsBefore = parts;
    assert.equal(await run(20), 20, 'a 404 for the next part never slows the reader');
    assert.equal(parts, partsBefore, 'the part is not there yet');
    written = 1;
    await run(1);
    assert.equal(parts, partsBefore + 1, 'and is played at the poll after it is written');
  } finally {
    globalThis.fetch = before.fetch;
    globalThis.setInterval = before.setInterval;
    (globalThis as { self?: unknown }).self = before.self;
    Math.random = before.random;
  }
});
