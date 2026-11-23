// R2 (0.133): the history worker the old page seeks a moved world's past with, copied from the v2 page's
// (v2/web/src/history/worker.ts, V9 #2719), not imported. A seek is V4's two requests, the day's bundle index and the
// bundle that holds the moment, inflated here and applied on R1's replica (WASM, `historyAt`), so the page's thread
// only turns the records into takes (history.ts). Only the WASM module, the header and the day indexes read are kept
// between seeks. The node records are read as the stream worker reads them, the fields the bridge reads.
import init, { historyAt } from 'replica';
import { decode, encode } from 'cborg';

/** A node record, the fields the bridge reads (v2/web/src/source/source.ts NodeRec). */
export type HistoryNode = { id: string; kind: string; parent: string | null; slot: number | null; pos: [number, number, number];
  rot: [number, number, number, number]; at: number | null; origin?: string; slots?: number[][]; body?: string; sky?: Record<number, unknown>;
  /** K4 (0.135): a moving node's course (field 80), re-encoded canonically as the stream worker does. */
  course?: Uint8Array };
/** A body's motion sample `[body, frame, slot, at µs, x, y, z µm]` (source.ts SampleRec). */
export type HistorySample = [string, string, number | null, number, number, number, number];
/** What one seek gives the page: the moment's state, its bundle's samples, and where the next bundle starts. */
export type Seeked = { seq: number; at: number; start: number; length: number; next: number | null; nodes: HistoryNode[]; samples: HistorySample[] };
export type HistoryMsg = { t: 'seeked'; s: Seeked } | { t: 'error'; seq: number; message: string };

const DAY_US = 86_400_000_000;
const post = (m: HistoryMsg) => (self as unknown as Worker).postMessage(m);
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
type IdValue = [Uint8Array, number];
const key = (id: IdValue) => `${hex(id[0])}.${num(id[1])}`;
const rows = (v: unknown) => (v as unknown[][] | undefined)?.map((r) => r.map(num));
const text = new TextDecoder();

async function get(url: URL): Promise<Uint8Array | null> {
  const res = await fetch(url);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function nodeRec(v: Map<number, unknown>): HistoryNode {
  const pose = v.get(7) as Map<number, unknown> | undefined;
  const moved = v.get(8) as Map<number, unknown> | undefined;
  const f = (v.get(6) as Map<number, unknown>) ?? new Map();
  const rec: HistoryNode = {
    id: key(v.get(1) as IdValue),
    kind: v.get(2) as string,
    parent: v.has(3) ? key(v.get(3) as IdValue) : null,
    slot: v.has(4) ? num(v.get(4)) : null,
    pos: ((pose?.get(2) as unknown[]) ?? [0, 0, 0]).map(num) as HistoryNode['pos'],
    rot: ((pose?.get(3) as unknown[]) ?? [1 << 30, 0, 0, 0]).map(num) as HistoryNode['rot'],
    at: moved ? num(moved.get(1)) : null,
  };
  if (f.get(1) instanceof Uint8Array) rec.origin = text.decode(f.get(1) as Uint8Array);
  if (f.has(13)) rec.slots = rows(f.get(13));
  if (f.has(32)) rec.body = hex(f.get(32) as Uint8Array);
  if (f.has(80)) rec.course = encode(f.get(80));
  // the world node's calendar (fields 60, 61), which dates each take as the live bridge dates it
  if (f.has(60) && f.has(61)) rec.sky = { 60: num(f.get(60)), 61: num(f.get(61)) };
  return rec;
}

type Index = [number, string, Uint8Array][];
let header: Promise<Uint8Array> | null = null;
const days = new Map<number, Promise<Index | null>>();
const ready = init();

/** A day's bundle index, `[[start µs, key, SHA-256], ...]`, or null when the day has none. */
function dayIndex(base: URL, day: number): Promise<Index | null> {
  if (!days.has(day)) days.set(day, get(new URL(`bundles/${String(day).padStart(8, '0')}/index`, base)).then((b) => {
    if (!b) return null;
    const m = decode(b, { useMaps: true }) as Map<number, unknown>;
    return (m.get(3) as unknown[][]).map((r) => [num(r[0]), text.decode(r[1] as Uint8Array), r[2] as Uint8Array] as [number, string, Uint8Array]);
  }));
  return days.get(day)!;
}

async function seek(base: URL, seq: number, at: number) {
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
    await ready;
    const out = decode(historyAt(await header, await inflate(stored), sha, BigInt(Math.round(at)), false), { useMaps: true }) as Map<number, unknown>;
    const nodes = (out.get(2) as Map<number, unknown>[]).map(nodeRec);
    const samples: HistorySample[] = (out.get(3) as Map<number, unknown>[]).map((s) => {
      const p = (s.get(5) as unknown[]).map(num);
      return [key(s.get(1) as IdValue), key(s.get(2) as IdValue), s.has(3) ? num(s.get(3)) : null, num(s.get(4)), p[0], p[1], p[2]];
    });
    const later = ix[i + 1]?.[0] ?? (await dayIndex(base, day + 1))?.[0]?.[0] ?? null;
    post({ t: 'seeked', s: { seq, at, start: num(out.get(4)), length: num(out.get(5)), next: later, nodes, samples } });
    return;
  }
  throw new Error(`no history in the year before ${at} µs`);
}

self.onmessage = (e: MessageEvent<{ base: string; seq: number; at: number }>) => {
  const { base, seq, at } = e.data;
  seek(new URL(base), seq, at).catch((err) => post({ t: 'error', seq, message: String(err?.message ?? err) }));
};
