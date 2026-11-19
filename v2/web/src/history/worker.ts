// The history worker (V9, #2719): a seek is V4's two requests, the day's bundle index and the bundle that holds the
// moment, inflated here and applied on R1's replica (WASM, V4's `state_at`), so the page's thread only draws. Only the
// WASM module, the header and the day indexes read are kept between seeks. The node records are read as V5's stream
// worker reads them (`source/worker.ts`).
import init, { historyAt } from 'replica';
import { decode } from 'cborg';
import type { NodeRec, SampleRec } from '../source/source.ts';
import { happenedInBundle, type Happened } from '../sound/record.ts';
import { skyFields } from '../sky/record.ts';

/** What one seek gives the page. */
export type Seeked = {
  seq: number; at: number; start: number; length: number; next: number | null;
  hash: string; nodes: NodeRec[]; samples: SampleRec[]; bytes: number; happened: Happened[];
  /** ms: fetched, inflated, applied (WASM), read into records. */
  ms: number[];
};
export type HistoryMsg = { t: 'seeked'; s: Seeked } | { t: 'counts'; day: number; rows: number[][] } | { t: 'error'; seq: number; message: string };

const DAY_US = 86_400_000_000;
const post = (m: HistoryMsg, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
type IdValue = [Uint8Array, number];
const key = (id: IdValue) => `${hex(id[0])}.${num(id[1])}`;
const rows = (v: unknown) => (v as unknown[][] | undefined)?.map((r) => r.map(num));
const text = new TextDecoder();

let bytes = 0;
async function get(url: URL): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const b = new Uint8Array(await res.arrayBuffer());
  bytes += b.length;
  return b;
}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export function nodeRec(v: Map<number, unknown>): NodeRec {
  const pose = v.get(7) as Map<number, unknown> | undefined;
  const moved = v.get(8) as Map<number, unknown> | undefined;
  const f = (v.get(6) as Map<number, unknown>) ?? new Map();
  const rec: NodeRec = {
    id: key(v.get(1) as IdValue),
    kind: v.get(2) as string,
    parent: v.has(3) ? key(v.get(3) as IdValue) : null,
    slot: v.has(4) ? num(v.get(4)) : null,
    pos: ((pose?.get(2) as unknown[]) ?? [0, 0, 0]).map(num) as NodeRec['pos'],
    rot: ((pose?.get(3) as unknown[]) ?? [1 << 30, 0, 0, 0]).map(num) as NodeRec['rot'],
    at: moved ? num(moved.get(1)) : null,
  };
  if (f.has(1)) rec.origin = text.decode(f.get(1) as Uint8Array);
  if (f.has(11)) rec.outline = rows(f.get(11));
  if (f.has(12)) rec.solids = rows(f.get(12));
  if (f.has(13)) rec.slots = rows(f.get(13));
  if (f.has(14)) rec.surfaces = (f.get(14) as unknown[][]).map((r) => [num(r[0]), rows(r[1])!]);
  if (f.has(18)) rec.waterLevel = num(f.get(18));
  if (f.has(23)) rec.scale = num(f.get(23));
  if (f.has(24)) rec.tileSize = num(f.get(24));
  if (f.has(25)) rec.tiles = (f.get(25) as unknown[][]).map((t) => [num(t[0]), num(t[1]), t[2] as Uint8Array, t[3] as Uint8Array]);
  if (f.has(32)) rec.body = hex(f.get(32) as Uint8Array); // the body worn (B15a), as of this moment
  const sky = skyFields(f); // V19: the world node's day, night and weather
  if (sky) rec.sky = sky;
  return rec;
}

type Index = [number, string, Uint8Array][];
let header: Promise<Uint8Array> | null = null;
const days = new Map<number, Promise<Index | null>>();

/** A day's bundle index, `[[start µs, key, SHA-256], ...]`, or null when the day has none. */
function dayIndex(base: URL, day: number): Promise<Index | null> {
  if (!days.has(day)) days.set(day, get(new URL(`bundles/${String(day).padStart(8, '0')}/index`, base)).then((b) => {
    if (!b) return null;
    const m = decode(b, { useMaps: true }) as Map<number, unknown>;
    return (m.get(3) as unknown[][]).map((r) => [num(r[0]), text.decode(r[1] as Uint8Array), r[2] as Uint8Array] as [number, string, Uint8Array]);
  }));
  return days.get(day)!;
}

async function seek(base: URL, seq: number, at: number, withHash: boolean) {
  bytes = 0;
  const began = performance.now();
  header ??= get(new URL('header', base)).then((b) => b ?? Promise.reject(new Error('no header')));
  // V4's walk: the last bundle that starts at or before the moment, back through earlier days to a year.
  for (let day = Math.floor(at / DAY_US); day > Math.floor(at / DAY_US) - 366; day--) {
    const ix = await dayIndex(base, day);
    let i = ix ? ix.length - 1 : -1;
    while (i >= 0 && ix![i][0] > at) i--;
    if (!ix || i < 0) continue;
    const [, k, sha] = ix[i];
    const stored = await get(new URL(k, base));
    if (!stored) throw new Error(`no bundle ${k}`);
    const t0 = performance.now(), body = await inflate(stored), t1 = performance.now();
    const out = decode((await ready, historyAt)(await header, body, sha, BigInt(Math.round(at)), withHash), { useMaps: true }) as Map<number, unknown>;
    const t2 = performance.now();
    const nodes = (out.get(2) as Map<number, unknown>[]).map(nodeRec);
    const samples: SampleRec[] = (out.get(3) as Map<number, unknown>[]).map((s) => {
      const p = (s.get(5) as unknown[]).map(num);
      return [key(s.get(1) as IdValue), key(s.get(2) as IdValue), s.has(3) ? num(s.get(3)) : null, num(s.get(4)), p[0], p[1], p[2]];
    });
    const start = num(out.get(4)), length = num(out.get(5)), ms = [t0 - began, t1 - t0, t2 - t1, performance.now() - t2].map(Math.round);
    const later = ix[i + 1]?.[0] ?? (await dayIndex(base, day + 1))?.[0]?.[0] ?? null;
    const transfer: Transferable[] = [];
    for (const n of nodes) for (const t of n.tiles ?? []) transfer.push(t[2].buffer as ArrayBuffer, t[3].buffer as ArrayBuffer);
    let happened: Happened[] = [];
    try { happened = happenedInBundle(body); } catch { /* sounds only: the moment opened */ }
    post({ t: 'seeked', s: { seq, at, start, length, next: later, hash: hex(out.get(1) as Uint8Array), nodes, samples, bytes, ms, happened } }, transfer);
    return;
  }
  throw new Error(`no history in the year before ${at} µs`);
}

/** V4's coarse level for the scrub bar: a day's counts by kind per ten minutes, `[[slot, kind, count], ...]`. */
async function counts(base: URL, day: number) {
  const b = await get(new URL(`history/everyone/counts/day/${String(day).padStart(8, '0')}`, base));
  const m = b ? (decode(b, { useMaps: true }) as Map<number, unknown>) : null;
  post({ t: 'counts', day, rows: ((m?.get(5) as unknown[][]) ?? []).map((r) => r.map(num)) });
}

const ready = init();
self.onmessage = (e: MessageEvent<{ base: string; seq: number; at: number; hash: boolean } | { base: string; counts: number }>) => {
  const m = e.data, base = new URL(m.base);
  if ('counts' in m) return void counts(base, m.counts).catch(() => post({ t: 'counts', day: m.counts, rows: [] }));
  // The fetches start while the WASM module loads; the apply waits for it.
  seek(base, m.seq, m.at, m.hash).catch((err) => post({ t: 'error', seq: m.seq, message: String(err?.message ?? err) }));
};
