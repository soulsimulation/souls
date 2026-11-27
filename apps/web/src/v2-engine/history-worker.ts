// R2 (0.133): the history worker the old page seeks a moved world's past with, copied from the v2 page's
// (v2/web/src/history/worker.ts, V9 #2719), not imported. A seek is V4's two requests, the day's bundle index and the
// bundle that holds the moment, inflated here and applied on R1's replica (WASM, `historyAt`), so the page's thread
// only turns the records into takes (history.ts). Only the WASM module, the header and the day indexes read are kept
// between seeks. The node records are read as the stream worker reads them, the fields the bridge reads.
import init, { historyAt } from 'replica';
import * as replica from 'replica';
import { decode, encode } from 'cborg';
import { coursePlaces, type CoursePlaces } from './course-samples.ts';
import { DAY_US, dayIndexKey, headerKey, walk, type DayIndex } from './history-keys.ts';

/** A node record, the fields the bridge reads (v2/web/src/source/source.ts NodeRec). */
export type HistoryNode = { id: string; kind: string; parent: string | null; slot: number | null; pos: [number, number, number];
  rot: [number, number, number, number]; at: number | null; origin?: string; slots?: number[][]; body?: string; sky?: Record<number, unknown>;
  /** K4 (0.135): a moving node's course (field 80), re-encoded canonically as the stream worker does. */
  course?: Uint8Array };
/** A body's motion sample `[body, frame, slot, at µs, x, y, z µm]` (source.ts SampleRec). */
export type HistorySample = [string, string, number | null, number, number, number, number];
/** What one seek gives the page: the moment's state, its bundle's samples, and where the next bundle starts. */
export type Seeked = { seq: number; at: number; start: number; length: number; next: number | null; nodes: HistoryNode[]; samples: HistorySample[];
  /** K4 (0.135): where each node on a course is over the bundle, worked out here so the page never loads the replica. */
  courses?: CoursePlaces };
export type HistoryMsg = { t: 'seeked'; s: Seeked } | { t: 'error'; seq: number; message: string };

const post = (m: HistoryMsg) => (self as unknown as Worker).postMessage(m);
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
type IdValue = [Uint8Array, number];
const key = (id: IdValue) => `${hex(id[0])}.${num(id[1])}`;
const rows = (v: unknown) => (v as unknown[][] | undefined)?.map((r) => r.map(num));
const text = new TextDecoder();

async function get(url: URL, signal?: AbortSignal): Promise<Uint8Array | null> {
  const res = await fetch(url, { signal });
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

let header: Promise<Uint8Array> | null = null;
const days = new Map<number, { p: Promise<DayIndex | null>; at: number }>();
const ready = init();

/** A day's bundle index, `[[start µs, key, SHA-256], ...]`, or null when the day has none. Kept while the worker
 *  lives, but `today`'s (the day of the world's now, still being written) only five seconds (#3358): a seek reads the
 *  bundles written since, and one just after a read ahead asks nothing again. */
function dayIndex(base: URL, day: number, today: number): Promise<DayIndex | null> {
  const kept = days.get(day);
  if (kept && (day < today || Date.now() - kept.at < 5000)) return kept.p;
  const p = get(new URL(dayIndexKey(day), base)).then((b) => {
    if (!b) return null;
    const m = decode(b, { useMaps: true }) as Map<number, unknown>;
    return (m.get(3) as unknown[][]).map((r) => [num(r[0]), text.decode(r[1] as Uint8Array), r[2] as Uint8Array] as [number, string, Uint8Array]);
  });
  days.set(day, { p, at: Date.now() });
  return p;
}
/** #3358: the stored bytes of the bundles read last (a bundle's key names it for good), so a bundle read ahead, or
 *  read by the seek before, is not fetched again. A failed or stopped read is not kept. */
const bundles = new Map<string, Promise<Uint8Array>>();
function bundle(base: URL, key: string, signal?: AbortSignal): Promise<Uint8Array> {
  let b = bundles.get(key);
  if (!b) {
    bundles.set(key, (b = get(new URL(key, base), signal).then((x) => x ?? Promise.reject(new Error(`no bundle ${key}`)))));
    b.catch(() => bundles.delete(key));
    while (bundles.size > 4) bundles.delete(bundles.keys().next().value!);
  }
  return b;
}
/** #3358: read aheads (history.ts prepare) fetch what a seek they foresee will read and keep the bundle, applying
 *  nothing, one at a time in the order asked (the first is the likelier). A seek drops those not begun (`round`) and
 *  stops the one under way when its bundle does not hold the seek's moment, so a guess never slows the seek chosen. */
let reading: Promise<unknown> = Promise.resolve(), round = 0;
let under: { from: number; to: number; stop: AbortController } | null = null;
function readAhead(base: URL, at: number, now: number, floor?: number) {
  const r = round, today = Math.floor(now / DAY_US);
  reading = reading.then(async () => {
    const f = r === round ? await walk(at, now, floor, (day) => dayIndex(base, day, today)) : null;
    const to = f && r === round ? await f.later() : null;
    if (!f || r !== round) return;
    const stop = new AbortController();
    under = { from: at, to: to ?? Infinity, stop };
    await bundle(base, f.key, stop.signal).finally(() => { under = null; });
  }).catch(() => null);
}

async function seek(base: URL, seq: number, at: number, now: number, floor?: number) {
  round++;
  if (under && !(under.from <= at && at < under.to)) under.stop.abort();
  header ??= get(new URL(headerKey(), base)).then((b) => b ?? Promise.reject(new Error('no header')));
  // V4's walk (history-keys.ts), no day after the world's own today (`now`, the page's world time) nor before `floor`
  const today = Math.floor(now / DAY_US), found = await walk(at, now, floor, (day) => dayIndex(base, day, today));
  if (!found) throw new Error(`no history in the year before ${at} µs`);
  const stored = await bundle(base, found.key);
  await ready;
  const out = decode(historyAt(await header, await inflate(stored), found.sha, BigInt(Math.round(at)), false), { useMaps: true }) as Map<number, unknown>;
  const nodes = (out.get(2) as Map<number, unknown>[]).map(nodeRec);
  const samples: HistorySample[] = (out.get(3) as Map<number, unknown>[]).map((s) => {
    const p = (s.get(5) as unknown[]).map(num);
    return [key(s.get(1) as IdValue), key(s.get(2) as IdValue), s.has(3) ? num(s.get(3)) : null, num(s.get(4)), p[0], p[1], p[2]];
  });
  const later = await found.later();
  const start = num(out.get(4)), length = num(out.get(5));
  const courses = replica.courseAt ? coursePlaces(replica.courseAt, nodes, Math.min(start, at), start + length) : {};
  post({ t: 'seeked', s: { seq, at, start, length, next: later, nodes, samples, ...(Object.keys(courses).length ? { courses } : {}) } });
}

self.onmessage = (e: MessageEvent<{ base: string; seq: number; at: number; now: number; floor?: number; ahead?: true }>) => {
  const { base, seq, at, now, floor, ahead } = e.data;
  if (ahead) return readAhead(new URL(base), at, now, floor);
  seek(new URL(base), seq, at, now, floor).catch((err) => post({ t: 'error', seq, message: String(err?.message ?? err) }));
};
