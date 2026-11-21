// #3799 A4: the page's Track places a body at changing positions from a real served world's public stream, not from a
// fixture. Set V2_STREAM_DIR to the `views/` folder `worldd serve` wrote (worldd's eden test
// `i3799_a4_the_public_stream_carries_a_soul_walking_sitting_and_rising` keeps one with V2_KEEP_STREAM); the page's
// own worker plays it on the replica WASM (V2_REPLICA_PKG, default target/wasm-load/pkg), and the samples of the parts
// it posts go into the page's Track as `draw/world.ts` adds them. Skipped without V2_STREAM_DIR.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PartRec } from '../source/source.ts';
import { Track } from './samples.ts';

const views = process.env.V2_STREAM_DIR;

test('the page Track draws a served Soul at changing positions from the real public stream', { skip: !views && 'V2_STREAM_DIR is not set' }, async () => {
  const dir = resolve(views!);
  const { encode } = await import('cborg');
  const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const pkg = resolve(v2, process.env.V2_REPLICA_PKG ?? 'target/wasm-load/pkg');
  const replicaUrl = pathToFileURL(join(pkg, 'replica.js')).href;
  registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: replicaUrl, shortCircuit: true } : next(s, c)) });
  // world.json names the stream from the world's folder (`views/…`); V2_STREAM_DIR is the `views/` folder itself.
  const stream = (JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')).stream as string).replace(/^views\//, '');
  const base = `https://stream.example.invalid/${stream.replace(/^\/+|\/+$/g, '')}/`;
  const parts: PartRec[] = [], errors: string[] = [], polls: (() => Promise<void>)[] = [], stamps: number[] = [];
  const fetchBefore = globalThis.fetch, intervalBefore = globalThis.setInterval, selfBefore = (globalThis as { self?: unknown }).self;
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
      const file = normalize(join(dir, decodeURIComponent(url.pathname)));
      if (file.startsWith(dir) && existsSync(file)) return new Response(readFileSync(file));
      if (url.pathname.endsWith('.text')) return new Response(encode([]));
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => { polls.push(fn); return 1; };
    (globalThis as { self?: unknown }).self = {
      onmessage: null as null | ((e: unknown) => void),
      postMessage: (m: { t: string; p: PartRec; message: string }) => (m.t === 'part' ? (parts.push(m.p), stamps.push(performance.now())) : m.t === 'error' ? errors.push(m.message) : undefined),
    };
    await import(new URL('../source/worker.ts?stream-track', import.meta.url).href);
    (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self.onmessage({ data: { stream: base } });
    const began = performance.now();
    const until = Date.now() + 10_000;
    while (!polls.length && !errors.length && Date.now() < until) await new Promise((r) => setImmediate(r));
    for (let seen = -1; seen !== parts.length && !errors.length; ) { seen = parts.length; await polls[0]?.(); }
    // Each part's time in the worker, the later half of the stream (walking, after the joins).
    const each = stamps.slice(1).map((t, i) => t - stamps[i]).slice(Math.floor(stamps.length / 2)).sort((a, b) => a - b);
    if (each.length) console.log(`the worker's later half: median ${each[each.length >> 1].toFixed(1)} ms a part, 90th ${each[Math.floor(each.length * 0.9)].toFixed(1)} ms`);
    console.log(`the page's worker played ${parts.length} parts in ${((performance.now() - began) / 1000).toFixed(1)} s (${((performance.now() - began) / Math.max(1, parts.length)).toFixed(1)} ms a part)`);
  } finally {
    globalThis.fetch = fetchBefore;
    globalThis.setInterval = intervalBefore;
    (globalThis as { self?: unknown }).self = selfBefore;
  }
  assert.deepEqual(errors, []);
  // Every sample the parts carried for each body, in order, as `draw/world.ts` adds them to its Track; a sample in
  // another frame starts the Track again (a transfer), so the body's longest stretch in one frame is read back.
  const runs = new Map<string, { frame: string; samples: [number, [number, number, number]][] }[]>();
  for (const p of parts) {
    for (const [id, parent, slot, at, x, y, z] of p.samples) {
      const frame = `${parent}/${slot}`;
      const r = runs.get(id) ?? runs.set(id, []).get(id)!;
      if (r.at(-1)?.frame !== frame) r.push({ frame, samples: [] });
      r.at(-1)!.samples.push([at, [x, y, z]]);
    }
  }
  const [body, run] = [...runs]
    .map(([id, r]) => [id, r.reduce((a, b) => (b.samples.length > a.samples.length ? b : a))] as const)
    .sort((a, b) => b[1].samples.length - a[1].samples.length)[0] ?? [];
  assert.ok(body && run, `the parts carry a body's samples (${parts.length} parts)`);
  // A fresh Track fed that stretch, as the page feeds it, read at five times across it.
  const t = new Track();
  for (const [at, pos] of run.samples) t.add(at, pos, run.frame);
  const [t0, t1] = [run.samples[0][0], run.samples.at(-1)![0]];
  const seen = new Set<string>();
  for (let k = 0; k <= 4; k++) {
    const pos = t.at(t0 + ((t1 - t0) * k) / 4);
    assert.ok(pos);
    seen.add(pos.map((v) => Math.round(v / 1000)).join(','));
  }
  console.log(`${parts.length} parts; body ${body}: ${run.samples.length} samples in frame ${run.frame} over ${((t1 - t0) / 1e6).toFixed(1)} s; Track positions at five times: ${[...seen].join(' | ')} (mm)`);
  assert.ok(seen.size >= 3, 'the Track places the body at changing positions');
});
