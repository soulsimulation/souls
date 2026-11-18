// soul-live/1 changes (#1755): what changed between two builds of the live picture, as one frame every client shares, and
// the picture's hash a client compares with its own copy. Pure: the client (tools/world-launcher/soul/live.mjs) applies
// the same frames and hashes its copy the same way.
import {createHash} from 'node:crypto';

type Row = {id: string};
type Line = {id: string};
/** One built live picture, as GET /v1/edge/live answers it (without epoch and seq). */
export type LivePicture = {catalog: string | null; tick: number; at: number; souls: Row[]; speech: Line[]; things?: Record<string, unknown>; thingsMore?: number} & Record<string, unknown>;
/** The change from one picture to the next. `base` is the seq it applies on; a client with any other seq takes the whole picture. */
export type LiveDelta = {seq: number; base: number; tick: number; at: number; catalog?: string | null; souls?: {set: Row[]; del: string[]}; things?: {set: Record<string, unknown>; del: string[]}; thingsMore?: number; speech?: Line[]};

/** JSON with object keys sorted, arrays in order: the bytes a hash is taken over, on both sides. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}
/** What a client's copy must agree on: every Soul's row, the things' states and the catalog version. Speech is kept by id
 *  and a client keeps more of it than the world sends, so it is not part of the hash. */
export function liveHash(p: {catalog?: string | null; souls?: Row[]; things?: Record<string, unknown>}): string {
  const souls = [...(p.souls ?? [])].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return createHash('sha256').update(canon({catalog: p.catalog ?? null, souls, things: p.things ?? {}})).digest('hex').slice(0, 16);
}

/** The change from `a` to `b`, or null when nothing a client keeps changed (the clock moving on alone is not sent). */
export function liveDelta(a: LivePicture, b: LivePicture, seq: number): LiveDelta | null {
  const d: LiveDelta = {seq, base: seq - 1, tick: b.tick, at: b.at};
  let changed = false;
  if (a.catalog !== b.catalog) { d.catalog = b.catalog; changed = true; }
  const before = new Map(a.souls.map(r => [r.id, JSON.stringify(r)])), setS: Row[] = [];
  for (const r of b.souls) { if (before.get(r.id) !== JSON.stringify(r)) setS.push(r); before.delete(r.id); }
  if (setS.length || before.size) { d.souls = {set: setS, del: [...before.keys()]}; changed = true; }
  if (a.things || b.things) {
    const ta = a.things ?? {}, tb = b.things ?? {}, setT: Record<string, unknown> = {}, del: string[] = [];
    for (const [id, v] of Object.entries(tb)) if (JSON.stringify(ta[id]) !== JSON.stringify(v)) setT[id] = v;
    for (const id of Object.keys(ta)) if (!(id in tb)) del.push(id);
    if (Object.keys(setT).length || del.length) { d.things = {set: setT, del}; changed = true; }
  }
  if ((a.thingsMore ?? 0) !== (b.thingsMore ?? 0)) { d.thingsMore = b.thingsMore ?? 0; changed = true; }
  const said = new Set(a.speech.map(l => l.id)), fresh = b.speech.filter(l => !said.has(l.id));
  if (fresh.length) { d.speech = fresh; changed = true; }
  return changed ? d : null;
}
