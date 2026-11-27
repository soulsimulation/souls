// R2 (0.133): the history worker the old page seeks a moved world's past with, copied from the v2 page's
// (v2/web/src/history/worker.ts, V9 #2719), not imported. A seek is V4's two requests, the day's bundle index and the
// bundle that holds the moment, inflated here and applied on R1's replica (WASM, `historyAt`), so the page's thread
// only turns the records into takes (history.ts). Only the WASM module, the header and the day indexes read are kept
// between seeks. The node records are read as the stream worker reads them, the fields the bridge reads.
import init, { historyTimeline } from 'replica';
import * as replica from 'replica';
import { decode, encode } from 'cborg';
import { coursePlaces, type CoursePlaces } from './course-samples.ts';
import {carryGrips,crewMembers,carryChangesInBundle,type CarryChange,type CarryGrips,type CrewMember} from './source/carry-record.ts';
import {fieldsOf} from './source/kinds-state.ts';
import type {NodeRec} from './source/source.ts';
import { DAY_US, dayIndexKey, headerKey, walk, type DayIndex } from './history-keys.ts';

/** A node record, the fields the bridge reads (v2/web/src/source/source.ts NodeRec). */
export type HistoryNode = NodeRec;
export type HistoryTransition = {at:number;nodes:HistoryNode[];removed:string[];samples:HistorySample[]};
/** A body's motion sample `[body, frame, slot, at µs, x, y, z µm]` (source.ts SampleRec). */
export type HistorySample = [string, string, number | null, number, number, number, number, [number,number,number,number]?];
/** What one seek gives the page: the moment's state, its bundle's samples, and where the next bundle starts. */
export type Seeked = { seq: number; at: number; start: number; length: number; next: number | null; nodes: HistoryNode[]; samples: HistorySample[]; carryChanges?:CarryChange[]; timeline?:{from:number;transitions:HistoryTransition[]};
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
  rec.crewMembers=crewMembers(f.get(4));rec.carryGrips=carryGrips(f.get(6));
  rec.fields=fieldsOf(f);
  const origin=f.get(1),definition=f.get(2);
  if(typeof origin==='string'&&definition instanceof Uint8Array){rec.defines=origin;rec.entry=definition;}
  if(origin instanceof Uint8Array&&(typeof definition==='string'||definition instanceof Uint8Array))rec.def=typeof definition==='string'?definition:text.decode(definition);
  if(f.get(19) instanceof Uint8Array)try{rec.params=JSON.parse(text.decode(f.get(19) as Uint8Array));}catch{ /* retained canonical defaults */ }
  if(Array.isArray(f.get(102)))rec.defBodies=(f.get(102) as unknown[][]).flatMap(r=>r[0] instanceof Uint8Array&&r[1] instanceof Uint8Array?[[text.decode(r[0]),text.decode(r[1])] as [string,string]]:[]);
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
 *  read by the seek before, is not fetched again. A failed read is not kept. */
const bundles = new Map<string, Promise<Uint8Array>>();
function bundle(base: URL, key: string, load = () => get(new URL(key, base))): Promise<Uint8Array> {
  let b = bundles.get(key);
  if (!b) {
    bundles.set(key, (b = load().then((x) => x ?? Promise.reject(new Error(`no bundle ${key}`)))));
    b.catch(() => bundles.delete(key));
    while (bundles.size > 4) bundles.delete(bundles.keys().next().value!);
  }
  return b;
}
/** #3358: read aheads (history.ts prepare) fetch what a seek they foresee will read and keep the bundle, applying
 *  nothing, one at a time in the order asked. A seek drops those not begun (`round`); the one under way it either
 *  wants (its bundle holds the seek's moment: the rest comes in one request) or stops after the part it is reading.
 *  It reads in parts because a stopped fetch does not free the line: measured on soul.game, the bytes of a 1.8 MB
 *  bundle already sent drained first and held a seek's 9 KB index 1.2 to 1.8 s. */
const PART = 512 * 1024;
type Under = { key: string; from: number; to: number; wanted: boolean; stopped: boolean };
let reading: Promise<unknown> = Promise.resolve(), round = 0, under: Under | null = null;
async function parts(url: URL, u: Under): Promise<Uint8Array> {
  const got: Uint8Array[] = [];
  let have = 0, total = Infinity;
  while (have < total) {
    if (u.stopped) throw new Error('read ahead stopped');
    const res = await fetch(url, { headers: { Range: `bytes=${have}-${u.wanted ? '' : have + PART - 1}` } });
    if (res.status === 200 && !have) return new Uint8Array(await res.arrayBuffer()); // no parts served: the whole
    const size = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1], b = new Uint8Array(await res.arrayBuffer());
    if (res.status !== 206 || !size || !b.length) throw new Error(`no bundle ${u.key}`);
    total = Number(size); got.push(b); have += b.length;
  }
  const out = new Uint8Array(have);
  got.reduce((o, b) => (out.set(b, o), o + b.length), 0);
  return out;
}
function readAhead(base: URL, at: number, now: number, floor?: number) {
  const r = round, today = Math.floor(now / DAY_US);
  reading = reading.then(async () => {
    const f = r === round ? await walk(at, now, floor, (day) => dayIndex(base, day, today)) : null;
    const to = f && r === round ? await f.later() : null;
    if (!f || r !== round) return;
    const u: Under = (under = { key: f.key, from: at, to: to ?? Infinity, wanted: false, stopped: false });
    await bundle(base, f.key, () => parts(new URL(f.key, base), u)).finally(() => { under = null; });
  }).catch(() => null);
}

async function seek(base: URL, seq: number, at: number, now: number, floor?: number) {
  round++;
  if (under && under.from <= at && at < under.to) under.wanted = true;
  else if (under) under.stopped = true;
  header ??= get(new URL(headerKey(), base)).then((b) => b ?? Promise.reject(new Error('no header')));
  // V4's walk (history-keys.ts): back over days with no index (a still world's) to the newest that has one, asking for
  // no day after the world's own today (`now`, the page's world time) nor before its first (`floor`)
  const today = Math.floor(now / DAY_US), found = await walk(at, now, floor, (day) => dayIndex(base, day, today));
  if (!found) throw new Error(`no history in the year before ${at} µs`);
  if (under?.key === found.key) Object.assign(under, { stopped: false, wanted: true });
  // a read ahead stopped before the seek knew it wanted that bundle: read it again
  const stored = await bundle(base, found.key).catch(() => bundle(base, found.key));
  await ready;
  const inflated=await inflate(stored);
  // Read the extent only to request the validated API. No node/effect is exposed before it validates the entire batch.
  const extent=decode(inflated,{useMaps:true}) as Map<number,unknown>,from=num(extent.get(3)),to=from+num(extent.get(4));
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<from)throw Error('history: invalid bundle extent');
  if(typeof historyTimeline!=='function')throw Error('history: served replica lacks validated node timeline');
  const out=decode(historyTimeline(await header,inflated,found.sha,BigInt(from),BigInt(to)),{useMaps:true}) as Map<number,unknown>;
  const nodes=(out.get(2) as Map<number,unknown>[]).map(nodeRec);
  const motion=(nodes:HistoryNode[],at:number):HistorySample[]=>nodes.flatMap(n=>n.parent&&n.at===at?[[n.id,n.parent,n.slot,at,...n.pos,n.rot] as HistorySample]:[]);
  const transitions:HistoryTransition[]=(out.get(3) as Map<number,unknown>[]).map(t=>{const at=num(t.get(1)),nodes=(t.get(2) as Map<number,unknown>[]).map(nodeRec);return{at,nodes,removed:(t.get(3) as IdValue[]).map(key),samples:motion(nodes,at)};});
  const samples=motion(nodes,from),later=await found.later(),start=num(out.get(4)),length=num(out.get(5));
  const courses=replica.courseAt?coursePlaces(replica.courseAt,nodes,start,start+length):{};
  post({t:'seeked',s:{seq,at,start,length,next:later,nodes,samples,timeline:{from:num(out.get(1)),transitions},carryChanges:carryChangesInBundle(inflated),...(Object.keys(courses).length?{courses}:{})}});
}

self.onmessage = (e: MessageEvent<{ base: string; seq: number; at: number; now: number; floor?: number; ahead?: true }>) => {
  const { base, seq, at, now, floor, ahead } = e.data;
  if (ahead) return readAhead(new URL(base), at, now, floor);
  seek(new URL(base), seq, at, now, floor).catch((err) => post({ t: 'error', seq, message: String(err?.message ?? err) }));
};
