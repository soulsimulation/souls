// #3639: actual shared WASM observer + page worker. These are projection/consumer fixtures, not a native
// authority or real-URL walk; the worldd tests independently derive contexts from whole canonical source parts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, encode } from 'cborg';
import type { PartRec, SnapshotRec } from './source.ts';
const m = (rows: [number, unknown][]) => new Map<number, unknown>(rows);
const sha = (v: Uint8Array) => new Uint8Array(createHash('sha256').update(v).digest());
const id = (n: number) => [new Uint8Array(16).fill(n), 0] as const;
const hash = (label: string, bytes: Uint8Array) => new Uint8Array([18, 32, ...sha(new Uint8Array([...encode(label), ...bytes]))]);
const root = id(11), hidden = id(12), child = id(13), transfer = id(14);
const publicAudience = m([[1, 1]]);
const rootKind = 'eden:world@1220e1771ee3471091196ed3afb3796e05602c106a5e95aae791d1d5ba0ba5c01b86';
const childKind = 'souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2';
const pose = (parent: unknown) => m([[1, [parent]], [2, [123, 0, 456]], [3, [1 << 30, 0, 0, 0]], [4, m([[1, 1], [2, parent], [3, 0]])]]);
const local = (parent: unknown) => { const p = pose(parent); p.delete(1); return p; };
const node = (parent: unknown) => m([[1, childKind], [2, parent], [4, publicAudience], [5, m([])], [6, local(parent)]]);
const rootNode = m([[1, rootKind], [4, publicAudience], [5, m([])]]);
const state = (next: number, parent: unknown) => m([[1, next], [2, [[root, rootNode], [child, node(parent)]]], [3, []], [4, []], [6, []], [7, []], [8, []], [9, []]]);
// Use the current canonical fixture's schema; a stand-in build hash is sufficient for this consumer unit case.
const schemaHex = readFileSync(new URL('../../../crates/replica/fixtures/effects/header.diag', import.meta.url), 'utf8').match(/^\s*2: h'([0-9a-f]+)'/m)?.[1];
assert.ok(schemaHex, 'the authoritative effects fixture names its schema');
const schema = new Uint8Array(Buffer.from(schemaHex, 'hex'));
const header = encode(m([[1, new Uint8Array([18, 32, ...new Uint8Array(32)])], [2, schema], [3, root[0]], [4, root], [5, 1], [6, [rootKind, childKind]], [7, []]]));
const headerHash = hash('souls/header/1', header);
const before = state(10, hidden), after = state(12, root);
const baseline = encode(m([[1, 1], [2, headerHash], [3, before], [4, 4]]));
const baselineHash = sha(baseline), generation = Buffer.from(baselineHash).toString('hex');
const effect = (seq: number, at: number, owner: unknown, body: unknown) => m([[1, seq], [2, at], [3, m([[1, 3]])], [4, m([[1, 3]])], [5, publicAudience], [6, owner], [9, body]]);
const raw = encode(m([[1, headerHash], [2, [
  effect(10, 0, hidden, m([[1, 1], [2, transfer], [3, child], [4, root[0]], [5, root], [6, pose(root)]])),
  effect(11, 1, root, m([[1, 2], [2, transfer]])),
]]]));
const variable = (n: number) => { const out: number[] = []; do { const b = n & 127; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while (n); return out; };
const packed = new Uint8Array([...variable(raw.length), ...variable(raw.length), ...raw, 0]);
const context = encode(m([[1, 1], [2, baselineHash], [3, sha(encode(before))], [4, sha(encode(after))], [5, m([[1, 12], [2, [[child, node(root)]]]])], [6, 5], [7, []], [8, [[root, 12], [child, 12]]]]));
const part = encode(m([[1, 0], [2, 0], [3, 500_000], [4, 10], [5, 2], [6, packed], [7, sha(encode(after))], [10, context]]));
const pointer = (newest: boolean) => encode(m([...(newest ? [[1, 0] as [number, unknown]] : []), [2, 500_000], [3, headerHash], ...(newest ? [[4, 500_000] as [number, unknown]] : []), [5, 0], [6, 0], [8, baselineHash]]));
const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = resolve(v2, process.env.V2_REPLICA_PKG ?? 'target/wasm-load/pkg');
const replicaUrl = pathToFileURL(join(pkg, 'replica.js')).href;
registerHooks({ resolve: (s, c, next) => s === 'replica' ? { url: replicaUrl, shortCircuit: true } : next(s, c) });
const replica = await import(replicaUrl);
replica.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });

test('public WASM keeps an opaque frame queryable; worker draws it only after the real transfer resolves its frame', async () => {
  const player = replica.StreamPlayer.fromBaseline(header, baseline);
  const query = (which: number, arg: unknown) => decode(player.query(encode(m([[1, which], [2, arg]]))), { useMaps: true });
  assert.deepEqual((query(1, child) as Map<number, unknown>).get(3), hidden);
  assert.throws(() => query(1, hidden), /node-missing/);
  assert.throws(() => query(4, child), /frame-unavailable/);
  for (const [which, arg] of [[2, root], [3, root], [5, 0], [6, root]] as const) query(which, arg);
  assert.equal(JSON.parse(player.play(part)).version, 12);
  assert.deepEqual((query(1, child) as Map<number, unknown>).get(3), root);
  assert.deepEqual(query(4, child), [child, root]);
  const fetchBefore = globalThis.fetch, intervalBefore = globalThis.setInterval;
  const selfBefore = (globalThis as { self?: unknown }).self;
  const polls: (() => Promise<void>)[] = [], parts: PartRec[] = [], snapshots: SnapshotRec[] = [], errors: string[] = [];
  let newest = true; // Baseline version10 is earlier than this pointer's already-published terminal version12.
  const worker = { onmessage: null as null | ((e: unknown) => void), postMessage: (message: { t: string; p: PartRec; s: SnapshotRec; message: string }) => message.t === 'part' ? parts.push(message.p) : message.t === 'snapshot' ? snapshots.push(message.s) : message.t === 'error' ? errors.push(message.message) : undefined };
  const base = 'https://stream.example.invalid/root/';
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
      if (url.href === new URL('pointer', base).href) return new Response(pointer(newest));
      if (url.pathname.endsWith(`/headers/${Buffer.from(headerHash).toString('hex')}`)) return new Response(header);
      if (url.href === new URL(`g/${generation}/baseline`, base).href) return new Response(baseline);
      if (url.href === new URL(`g/${generation}/baseline.text`, base).href || url.href === new URL(`g/${generation}/0.text`, base).href) return new Response(encode([]));
      if (newest && url.href === new URL(`g/${generation}/0`, base).href) return new Response(part);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => { polls.push(fn); return 1; };
    (globalThis as { self?: unknown }).self = worker;
    await import(new URL('./worker.ts?continuity-public', import.meta.url).href);
    worker.onmessage!({ data: { stream: base } });
    const until = Date.now() + 2000;
    while (!polls.length && !errors.length && Date.now() < until) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []); assert.equal(polls.length, 1);
    const childKey = `${Buffer.from(child[0]).toString('hex')}.0`;
    assert.equal(snapshots.length, 1); assert.ok(!('from' in snapshots[0]) && !('to' in snapshots[0]), 'baseline cannot fabricate a time from the latest pointer');
    assert.ok(snapshots.every(p => !p.nodes.some(n => n.id === childKey)), 'opaque baseline child never uses an invented world frame');
    assert.equal(parts.length, 1); assert.equal(parts[0].from, 0); assert.equal(parts[0].to, 500_000, 'only the actual part advances time');
    newest = true; await polls[0]();
    assert.deepEqual(errors, []);
    assert.ok(parts.at(-1)!.nodes.some(n => n.id === childKey && n.parent === `${Buffer.from(root[0]).toString('hex')}.0`));
    assert.equal(parts.at(-1)!.hash, true);
  } finally {
    globalThis.fetch = fetchBefore;
    globalThis.setInterval = intervalBefore;
    (globalThis as { self?: unknown }).self = selfBefore;
    player.free();
  }
});

test('an open legacy worker drains the immutable terminal once before installing a matching public baseline', async () => {
  const placeKind = 'souls:place@122000b30799a02576f5eb1e24e91387f425ab9cb7b479f02e700e76e6bf620baa63';
  const h = decode(header, { useMaps: true }) as Map<number, unknown>;
  h.set(6, [placeKind]); const oldHeader = encode(h), oldHash = hash('souls/header/1', oldHeader);
  const change = m([[1, 4], [2, root], [3, 77], [4, 7]]);
  const e = effect(0, 0, root, m([])); e.delete(9); e.set(7, [change]);
  const source = encode(m([[1, oldHash], [2, [e]]]));
  const oldPart = encode(m([[1, 0], [2, 0], [3, 500_000], [4, 0], [5, 1], [6, new Uint8Array([...variable(source.length), ...variable(source.length), ...source, 0])]]));
  const projected = m([[1, 1], [2, [[root, m([[1, placeKind], [4, publicAudience], [5, m([[77, 7]])]])]]], [3, []], [4, []], [6, []], [7, []], [8, []], [9, []]]);
  const baseBytes = encode(m([[1, 1], [2, oldHash], [3, projected], [4, 0]]));
  const baseHash = sha(baseBytes), gen = Buffer.from(baseHash).toString('hex');
  const legacy = new replica.StreamPlayer(oldHeader); legacy.play(oldPart);
  assert.equal(legacy.publicHash(), Buffer.from(sha(encode(projected))).toString('hex'));
  const initial = encode(m([[2, 500_000], [3, oldHash], [5, 0], [6, 0]]));
  const successor = encode(m([[2, 500_000], [3, oldHash], [5, 0], [6, 0], [8, baseHash], [9, [1, 1, sha(encode(projected))]]]));
  const fetchBefore = globalThis.fetch, intervalBefore = globalThis.setInterval, selfBefore = (globalThis as { self?: unknown }).self;
  const polls: (() => Promise<void>)[] = [], parts: PartRec[] = [], snapshots: SnapshotRec[] = [], errors: string[] = []; let pointers = 0, oldReads = 0;
  const worker = { onmessage: null as null | ((e: unknown) => void), postMessage: (message: { t: string; p: PartRec; s: SnapshotRec; message: string }) => message.t === 'part' ? parts.push(message.p) : message.t === 'snapshot' ? snapshots.push(message.s) : message.t === 'error' ? errors.push(message.message) : undefined };
  const base = 'https://stream.example.invalid/legacy/';
  try {
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
      if (url.href === new URL('pointer', base).href) return new Response(++pointers === 1 ? initial : successor);
      if (url.pathname.endsWith(`/headers/${Buffer.from(oldHash).toString('hex')}`)) return new Response(oldHeader);
      if (url.href === new URL('0', base).href) { oldReads++; return new Response(oldPart); }
      if (url.href === new URL(`g/${gen}/baseline`, base).href) return new Response(baseBytes);
      if (url.pathname.endsWith('.text')) return new Response(encode([]));
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    (globalThis as { setInterval: unknown }).setInterval = (fn: () => Promise<void>) => { polls.push(fn); return 1; };
    (globalThis as { self?: unknown }).self = worker;
    await import(new URL('./worker.ts?continuity-legacy', import.meta.url).href);
    worker.onmessage!({ data: { stream: base } });
    const until = Date.now() + 2000;
    while (!polls.length && !errors.length && Date.now() < until) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []); assert.equal(polls.length, 1); assert.equal(oldReads, 1);
    assert.equal(parts.length, 1); assert.equal(snapshots.length, 1);
    assert.ok(!('from' in snapshots[0]) && !('to' in snapshots[0]) && !('samples' in snapshots[0]), 'snapshot does not advance part time or invent motion');
    await polls[0](); assert.deepEqual(errors, []); assert.equal(oldReads, 1); assert.equal(parts.length, 1); assert.equal(snapshots.length, 1, 'no effect or baseline replay');
  } finally {
    globalThis.fetch = fetchBefore; globalThis.setInterval = intervalBefore; (globalThis as { self?: unknown }).self = selfBefore; legacy.free();
  }
});
