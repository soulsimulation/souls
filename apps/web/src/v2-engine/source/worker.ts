// X1 (0.134): copied from v2/web/src/source/worker.ts, so the old page's stream reader needs nothing from v2/web.
// The stream's worker (V5, #2714): fetches V1's pointer and parts, plays each part on R1's replica (WASM) in number
// order, and reads back the nodes the part changed, so the page's thread only draws. Started by `StreamSource`.
// The words path (V1b, #3361): it hands on each part's `souls:said` events (replica's event query) and a body's name
// and description (fields 30, 31), each with its words from the part's text file `<n>.text` (`[[reference, words],
// ...]`, the public audience's, written by V1's writer beside the part), kept by reference across parts. A named
// place's name (import-eden's field 4, a SHA-256 of its words) is a `[hash, words]` row of the same files (#3574).
import init, { StreamPlayer, readPointer } from 'replica';
import * as replica from 'replica';
import { decode } from 'cborg';
import { encode } from './profile.ts';
import { publicSoul, type MoveRec, type RunEndRec, type NodeRec, type PartRec, type Pointer, type SaidRec, type SnapshotRec } from './source.ts';
import { happenedInPart } from './sound-record.ts';
import { readChanged } from './changed.ts';
import { skyFields } from './sky-record.ts';
import { BEHIND_US, CUT_US } from './clock.ts';
import { fieldsOf } from './kinds-state.ts';
import { courseLeaves, coursePlaces, type CoursePlaces } from '../course-samples.ts';
import { unreadFormat } from '../stream-format.ts';
import {nativeId as key,carryFields,carryChangesInPart} from './carry-record.ts';
import { moveRec } from './move-record.ts';
import { backoffMs } from './backoff.ts';

/** Parts fetched at once from the one played (#3822): a joiner far behind is not one round trip a part. 64 (#4898):
 *  a cold arrival on an hour-old checkpoint reads some 7,000 small part files. Only while no read is refused (#5068). */
const AHEAD = 64;
/** How often a catch-up says how far behind it is (#4684). */
const CATCHING_MS = 1000;
/** The existing live pointer cadence, also used while a starting world has no pointer yet. */
const POLL_MS = 250;
/** How far back from the stream's newest time a course's places are worked out: the page keeps them only for its newest
 *  84 s (bridge.ts publish: 12 s of chunks and a minute before them). A part that ends before that (every part of a cold
 *  arrival's catch-up but the last few) is given no places; one that spans it, only from there. Working out every
 *  course over every old part was 5 of the 5.7 s a cold Eden took to reach now (27 Nov). */
const COURSE_KEEP_US = 90_000_000;

type Msg = { t: 'snapshot'; s: SnapshotRec } | { t: 'pointer'; p: Pointer } | { t: 'part'; p: PartRec } | { t: 'error'; message: string } | { t: 'format'; format: number }
  | { t: 'catching'; behind: number };
// This worker's own scope, taken once: a test harness that loads several workers in one process gives each its own.
const scope = self as unknown as Worker;
const post = (m: Msg, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
type IdValue = [Uint8Array, number];
const rows = (v: unknown) => (v as unknown[][] | undefined)?.map((r) => r.map(num));

/** How long a pointer or part read may take before it is given up (25 Nov): a read that never answers would hold the
 *  poll, which waits for it, for good; given up, it is an error like a failed read, and the next poll reads again. */
const READ_MS = 5000;

/** #5068 item 13: whether a read was refused (any answer but a 2xx or a 404) or did not answer since this was last
 *  cleared, and how many polls in a row had one. A 404 is a file not written yet (the next part, a starting world's
 *  pointer): read again at the usual pace, as before. */
let refused = false;
let fails = 0;

/** `timed`: given up after READ_MS. Baselines are not: a slow viewer's 9 MB baseline may well take longer. */
async function get(url: URL, timed = false, onRefused?: () => void): Promise<Uint8Array | null> {
  const res = await fetch(url, { cache: 'no-store', ...(timed ? { signal: AbortSignal.timeout(READ_MS) } : {}) }).catch((e) => { refused = true; onRefused?.(); throw e; });
  if (!res.ok && res.status !== 404) { refused = true; onRefused?.(); }
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

function readPtr(bytes: Uint8Array): StreamPointer {
  const p = JSON.parse(readPointer(bytes));
  return { newest: p.newest, newestTo: p.newestTo ?? null, period: p.period, anchorWorld: p.anchorWorld, anchorWallMs: p.anchorWallMs, quietUntil: p.quietUntil ?? null, header: p.header, ...(p.baseline ? { baseline: p.baseline, generation: p.generation } : {}), ...(p.legacyHash ? { legacyVersion: p.legacyVersion, legacyNext: p.legacyNext, legacyHash: p.legacyHash } : {}), ...(p.handoffFrom ? { handoffFrom: p.handoffFrom } : {}), ...(p.asleep ? { asleep: true, stillUntil: p.stillUntil ?? null } : {}) };
}

/** The reference in a `{21: id}` value, as the page keys it, or null. */
const refOf = (v: unknown): string | null => {
  const id = v instanceof Map ? (v.get(21) as IdValue | undefined) : undefined;
  return id ? key(id) : null;
};
/** The key of a name's hash (field 4), kept apart from `{21: id}` references. */
const nameKey = (b: Uint8Array) => `n:${hex(b)}`;
const SAID = 'souls:said';
const SAID_PRIVATELY = 'souls:said-privately'; // #3775: who spoke in a private conversation, and when; no words
const PLACE_NAME = 4;
const MOVED = 'souls:form-move', RUN_ENDED = 'souls:form-ended';
const NAME = 30;
const DESCRIPTION = 31;
const COURSE = 80; // a moving node's course (#3603)
const SEATS = 88; // N14: the courses of a ride's seats that move with their cabins, by slot

function nodeRec(v: Map<number, unknown>): NodeRec {
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
    soul: publicSoul(v.get(9)),
  };
  // The importer's fields share numbers with a kind's own state fields (a fridge's `open` is field 1): each is read
  // only in the shape the importer writes it.
  const o = f.get(1);
  if (o instanceof Uint8Array) {
    rec.origin = new TextDecoder().decode(o);
    // W2 (0.135): the def it was imported from (import-eden's field 2), which the old page draws it by
    const d = f.get(2);
    if (d instanceof Uint8Array || typeof d === 'string') rec.def = typeof d === 'string' ? d : new TextDecoder().decode(d);
    // W3: its def's params (import-eden's field 19, today's JSON text)
    const p = f.get(19);
    if (p instanceof Uint8Array) try { const v = JSON.parse(new TextDecoder().decode(p)); if (v && typeof v === 'object' && !Array.isArray(v)) rec.params = v; } catch { /* drawn with the def's defaults */ }
  } else if (typeof o === 'string' && f.get(2) instanceof Uint8Array) (rec.defines = o), (rec.entry = f.get(2) as Uint8Array); // #3697: a creator's kind
  // the defs the world defines itself, on the open ground (import-eden's field 102: [[ref, today's JSON text] …])
  const own = f.get(102);
  if (Array.isArray(own)) rec.defBodies = own.flatMap((r) => (Array.isArray(r) && r[0] instanceof Uint8Array && r[1] instanceof Uint8Array
    ? [[new TextDecoder().decode(r[0]), new TextDecoder().decode(r[1])] as [string, string]] : []));
  // the open ground's palette (import-eden's field 103, `souls:<palette>`), which the page colours its ground by
  const palette = f.get(103);
  if (typeof palette === 'string' && f.has(25)) rec.groundPalette = palette;
  if (Array.isArray(f.get(11))) rec.outline = rows(f.get(11));
  if (Array.isArray(f.get(12))) rec.solids = rows(f.get(12));
  if (Array.isArray(f.get(13))) rec.slots = rows(f.get(13));
  if (f.has(14)) rec.surfaces = (f.get(14) as unknown[][]).map((r) => [num(r[0]), rows(r[1])!]);
  if (Array.isArray(f.get(16))) rec.line = rows(f.get(16));
  if (f.has(17)) rec.lineWidth = num(f.get(17));
  if (f.has(18)) rec.waterLevel = num(f.get(18));
  if (f.has(23)) rec.scale = num(f.get(23));
  if (f.has(24)) rec.tileSize = num(f.get(24));
  if (f.has(25)) rec.tiles = (f.get(25) as unknown[][]).map((t) => [num(t[0]), num(t[1]), t[2] as Uint8Array, t[3] as Uint8Array]);
  if (f.has(NAME)) rec.name = refOf(f.get(NAME));
  if (f.has(DESCRIPTION)) rec.description = refOf(f.get(DESCRIPTION));
  if (f.has(COURSE)) rec.course = encode(f.get(COURSE)); // #3603: re-encoded canonically, as the record holds it
  const seats = f.get(SEATS);
  if (seats instanceof Map) rec.seats = Object.fromEntries([...seats].map(([k, c]) => [num(k), encode(c)]));
  if (f.has(32)) rec.body = hex(f.get(32) as Uint8Array);
  if (f.get(33) instanceof Uint8Array) (rec as NodeRec & { look?: string }).look = new TextDecoder().decode(f.get(33) as Uint8Array); // V3: a Soul's own look's params (G2)
  const placeName = f.get(PLACE_NAME);
  if (placeName instanceof Uint8Array && placeName.length === 32) rec.placeName = nameKey(placeName);
  // R4 (0.134): a creator's tint, `[part, rgb]` rows (field 145)
  const tint = f.get(145);
  const text = (t: unknown) => (typeof t === 'string' ? t : t instanceof Uint8Array ? new TextDecoder().decode(t) : null);
  if (Array.isArray(tint)) rec.tint = tint.flatMap((r) => (Array.isArray(r) && r.length === 2 && text(r[0]) !== null ? [[text(r[0])!, num(r[1])] as [string, number]] : []));
  carryFields(rec,f); // membership, holds and (#5134) where an activity's node holds its slots' riders
  const fields = fieldsOf(f); // #3871: its kind's state, by field number
  if (fields) rec.fields = fields;
  const sky = skyFields(f); // V19: the world node's day, night and weather
  if (sky) rec.sky = sky;
  return rec;
}

function runKey(run: unknown): string | undefined {
  return run === undefined ? undefined : typeof run === 'number' || typeof run === 'bigint' ? String(run) : key(run as IdValue);
}

type StreamPointer = Pointer & { header: string; baseline?: string; generation?: string; legacyVersion?: number; legacyNext?: number; legacyHash?: string; handoffFrom?: string };

async function run(stream: URL) {
  await init();
  // A starting/restarting world may not have published its pointer yet. Keep one bounded read in flight;
  // parse only after it answers, outside the retry catch, so invalid pointer bytes remain a visible error.
  let first: Uint8Array | null = null;
  while (!first) {
    refused = false;
    first = await get(new URL('pointer', stream), true).catch(() => null);
    fails = refused ? fails + 1 : 0;
    if (!first) await new Promise((resolve) => setTimeout(resolve, Math.max(POLL_MS, backoffMs(fails))));
  }
  let ptr = readPtr(first) as StreamPointer;
  let player: StreamPlayer;
  let active: string | undefined;
  let version = 0;
  let busy = false;
  let quiet: number | null = null;
  /** Up to when the courses' places are posted (K4): a still world writes no part, yet its rides go on moving. */
  let coursedTo = -Infinity;
  const words = new Map<string, string>();
  const known = new Map<string, NodeRec>();
  let drawn = new Set<string>();
  const text = new TextDecoder();
  const path = (p: StreamPointer, file: string) => p.generation ? `g/${p.generation}/${file}` : file;
  const addWords = (b: Uint8Array | null) => {
    if (!b) return;
    for (const [id, w] of decode(b, { useMaps: true }) as [IdValue | Uint8Array, Uint8Array][]) words.set(id instanceof Uint8Array ? nameKey(id) : key(id), text.decode(w));
  };
  const readText = async (file: string, p = ptr) => addWords(await get(new URL(path(p, file), stream)));
  // A part's file (`suffix` '') or its words ('.text'), with the next AHEAD the pointer names already asked for.
  const fetching = new Map<string, Promise<Uint8Array | null>>();
  // While reads are refused (#5068 item 13), and after they were until a part is read again, only the part played is asked
  // for, never AHEAD at once; and a read ahead that was refused is not kept for its part's turn, which reads it again (it
  // used to leave one part a poll after an outage). A file that is not there (404: a part with no words) is kept, as
  // before, so it is asked for once, not again with every later part's read ahead.
  let partRead = false;
  const partFile = (p: StreamPointer, n: number, suffix: string): Promise<Uint8Array | null> => {
    const ahead = refused || (fails > 0 && !partRead) ? 1 : AHEAD;
    for (let k = n; k < n + ahead && k <= (p.newest ?? n); k++) {
      const file = path(p, `${k}${suffix}`);
      if (fetching.has(file)) continue;
      let lost = false;
      const read = get(new URL(file, stream), true, () => { lost = true; }).catch(() => null);
      fetching.set(file, read);
      void read.then((b) => { if (b) partRead = true; else if (lost && fetching.get(file) === read) fetching.delete(file); });
    }
    const file = path(p, `${n}${suffix}`);
    const bytes = fetching.get(file) ?? get(new URL(file, stream), true);
    fetching.delete(file);
    return bytes;
  };
  const query = (q: Map<number, unknown>) => decode(player.query(encode(q)), { useMaps: true });
  // #4684: the changed nodes in one query (7), read at the part's size; null once a replica refuses it (an older one).
  let manyOk = true;
  const many = (ids: readonly IdValue[]): Map<string, Map<number, unknown>> | null => {
    if (!manyOk) return null;
    try {
      return new Map((query(new Map<number, unknown>([[1, 7], [2, ids]])) as Map<number, unknown>[]).map(v => [key(v.get(1) as IdValue), v]));
    } catch { manyOk = false; return null; }
  };
  const resolveWords = (nodes: NodeRec[]) => {
    for (const r of nodes) {
      if (r.name) r.name = words.get(r.name) ?? null;
      if (r.description) r.description = words.get(r.description) ?? null;
      if (r.placeName) r.placeName = words.get(r.placeName) ?? null;
    }
  };
  // Preserve opaque local records in the WASM/public copy and here. Drawing may only observe a complete actual
  // public frame chain; a missing private frame is never an identity/world transform. Its depth from the root, or -1.
  const depthOf = (id: string): number => {
    const seen = new Set<string>();
    for (let depth = 0; depth <= 32; depth++) {
      if (seen.has(id)) return -1;
      seen.add(id);
      const n = known.get(id);
      if (!n) return -1;
      if (n.parent === null) return depth;
      id = n.parent;
    }
    return -1;
  };
  // #4684: what a part changes is worked out from the nodes it changed and the nodes under them, not the whole world:
  // the records by their frame (kept whether or not the frame is known), and the nodes on a course.
  const under = new Map<string, Set<string>>();
  const coursed = new Set<string>();
  const unhang = (n: NodeRec | undefined) => {
    if (n?.parent == null) return;
    const s = under.get(n.parent);
    if (s?.delete(n.id) && !s.size) under.delete(n.parent);
  };
  const onCourse = () => [...coursed].filter(id => drawn.has(id)).map(id => known.get(id)!);
  const observe = (nodes: NodeRec[], removed: string[], samples: PartRec['samples'], rest?: Omit<PartRec, 'nodes' | 'removed' | 'samples'>) => {
    for (const id of removed) { unhang(known.get(id)); known.delete(id); coursed.delete(id); }
    for (const node of nodes) {
      unhang(known.get(node.id));
      known.set(node.id, node);
      if (node.parent !== null) { let s = under.get(node.parent); if (!s) under.set(node.parent, s = new Set()); s.add(node.id); }
      if (node.course || node.seats) coursed.add(node.id); else coursed.delete(node.id);
    }
    // Only a changed or removed node, or one under it, can become drawable or stop being: every other one stays as it was.
    const touched = new Set<string>([...removed, ...nodes.map(n => n.id)]);
    for (const id of touched) for (const k of under.get(id) ?? []) touched.add(k);
    const changed = new Set(nodes.map(n => n.id));
    const shown: [number, string][] = [], gone: string[] = [];
    for (const id of touched) {
      const d = depthOf(id);
      if (d < 0) { if (drawn.delete(id)) gone.push(id); continue; }
      if (changed.has(id) || !drawn.has(id)) shown.push([d, id]);
      drawn.add(id);
    }
    shown.sort((a, b) => a[0] - b[0]); // a frame before what is in it
    const visible = shown.map(([, id]) => {
      const n = known.get(id)!;
      return { ...n, ...(n.tiles ? { tiles: n.tiles.map(t => [t[0], t[1], t[2].slice(), t[3].slice()] as NonNullable<NodeRec['tiles']>[number]) } : {}) };
    });
    const transfer: Transferable[] = [];
    // A retained unresolved record may become drawable later; transfer fresh buffers, retaining its exact bytes.
    for (const n of visible) for (const t of n.tiles ?? []) transfer.push(t[2].buffer as ArrayBuffer, t[3].buffer as ArrayBuffer);
    // K4 (0.135): where each node on a course is over the part, so the page never loads the replica (course-samples.ts)
    // Only over the time the page keeps (COURSE_KEEP_US): the places it is given for that time are the same as before.
    const keepFrom = (ptr.newestTo ?? rest?.to ?? 0) - COURSE_KEEP_US, kept = !!rest && rest.to >= keepFrom && !!replica.courseAt;
    const courses = kept ? coursePlaces(replica.courseAt, onCourse(), Math.max(rest.from, keepFrom), rest.to) : {};
    if (rest) coursedTo = Math.max(coursedTo, rest.to);
    // First-day round 4: when each still thing on a course moves on (a balloon at its stop takes off). A part that spans
    // the kept time's start also says it as of that start, as the parts before it, which are given none, would have.
    const leaves = kept ? { ...(rest.from < keepFrom ? courseLeaves(replica.courseAt, onCourse(), keepFrom) : {}), ...courseLeaves(replica.courseAt, onCourse(), rest.to) } : {};
    if (rest) post({ t: 'part', p: { ...rest, nodes: visible, removed: gone, samples: samples.filter(s => drawn.has(s[0])), ...(Object.keys(courses).length ? { courses } : {}), ...(Object.keys(leaves).length ? { leaves } : {}) } }, transfer);
    else post({ t: 'snapshot', s: { nodes: visible, removed: gone } }, transfer);
  };
  // #4535: a baseline in a format this page's bundle cannot read is never played: the page reloads for the new one
  // (stream-format.ts) instead of sitting frozen.
  const refuseFormat = (b: Uint8Array) => {
    const unread = unreadFormat(b);
    if (unread !== null) { post({ t: 'format', format: unread }); throw new Error(`stream-format ${unread}`); }
  };
  const install = async (p: StreamPointer) => {
    const header = await get(new URL(`../../../headers/${p.header}`, stream));
    if (!header) throw new Error('no header');
    if (!p.generation) { player = new StreamPlayer(header); active = undefined; return; }
    if (!/^[0-9a-f]{64}$/.test(p.generation) || p.baseline !== p.generation) throw new Error('stream-generation-record');
    const baseline = await get(new URL(path(p, 'baseline'), stream));
    if (!baseline || hex(new Uint8Array(await crypto.subtle.digest('SHA-256', baseline as BufferSource))) !== p.baseline) throw new Error('stream-baseline-hash');
    refuseFormat(baseline);
    const nextPlayer = StreamPlayer.fromBaseline(header, baseline);
    let nodes: NodeRec[], nextVersion: number;
    try {
      const baselineRecord = decode(baseline, { useMaps: true }) as Map<number, unknown>;
      nextVersion = num((baselineRecord.get(3) as Map<number, unknown>).get(1));
      if (p.legacyHash && nextPlayer.publicHash() !== p.legacyHash) throw new Error('stream-handoff-baseline');
      await readText('baseline.text', p);
      nodes = (decode(nextPlayer.snapshot(), { useMaps: true }) as Map<number, unknown>[]).map(nodeRec);
    } catch (error) { nextPlayer.free(); throw error; }
    const previous = player;
    player = nextPlayer; version = nextVersion; active = p.generation;
    previous?.free();
    resolveWords(nodes);
    showAll(nodes);
  };
  // The whole public copy as one snapshot: what a baseline or a catch-up shows.
  const showAll = (nodes: NodeRec[]) => {
    const present = new Set(nodes.map(n => n.id));
    observe(nodes, [...known.keys()].filter(id => !present.has(id)), []);
  };
  // #3822: a joiner far behind plays the parts the clock would cut past anyway (more than BEHIND_US + CUT_US before
  // the newest) deferred: no digest each, nothing read back or posted. The state they make is then checked against
  // the newest claimed digest once and shown as one snapshot; the parts after it play as before.
  // #4684: it says how far behind it is as it goes (at most every CATCHING_MS, across polls), so a page whose reader is
  // catching up says so rather than that the stream is not there; only for a part it played, so a reader whose parts
  // stop coming says nothing and the page's silence notice still shows.
  let saidAt = -Infinity;
  const catchUp = async (p: StreamPointer, last: number): Promise<boolean> => {
    let any = false;
    while (Number(player.next()) <= last) {
      const n = Number(player.next());
      const [bytes, said] = await Promise.all([partFile(p, n, ''), partFile(p, n, '.text')]);
      if (!bytes) break;
      version = JSON.parse(player.playDeferred(bytes)).version;
      addWords(said);
      any = true;
      if (performance.now() - saidAt >= CATCHING_MS) { saidAt = performance.now(); post({ t: 'catching', behind: (p.newest ?? n) - n }); }
    }
    if (!any) return false;
    player.verify();
    const nodes = (decode(player.snapshot(), { useMaps: true }) as Map<number, unknown>[]).map(nodeRec);
    resolveWords(nodes);
    showAll(nodes);
    return true;
  };
  const playOne = async (p: StreamPointer): Promise<boolean> => {
    const n = Number(player.next());
    const bytes = await partFile(p, n, '');
    if (!bytes) return false;
    // #3822: the state's digest is worked out once a batch, at the newest part, not at each one before it.
    const played = JSON.parse(n < (p.newest ?? n) ? player.playDeferred(bytes) : player.play(bytes));
    const changed = query(new Map<number, unknown>([[1, 5], [2, version]])) as [IdValue, number][];
    version = played.version;
    const { nodes, removed } = readChanged(
      changed.map(([id]) => id), key,
      (id) => query(new Map<number, unknown>([[1, 1], [2, id]])) as Map<number, unknown>,
      () => new Map((decode(player.snapshot(), { useMaps: true }) as Map<number, unknown>[]).map(v => [key(v.get(1) as IdValue), v])),
      nodeRec,
      many,
    );
    const samples = JSON.parse(player.samples());
    let happened: PartRec['happened'] = [];
    try { happened = happenedInPart(bytes); } catch { /* sound observes only a successfully played part */ }
    const events = decode(player.events(), { useMaps: true }) as Map<number, unknown>[];
    const said: SaidRec[] = [], moves: MoveRec[] = [], runEnds: RunEndRec[] = [];
    for (const e of events) {
      if (e.get(1) === SAID_PRIVATELY) {
        const f = e.get(2) as Map<number, unknown>, conv = f.get(1) as IdValue | undefined;
        if (conv) said.push({ speaker: key(e.get(3) as IdValue), at: num(e.get(4)), length: 0, reach: 0, ref: `private:${key(conv)}`, words: null,
          private: { conversation: key(conv), members: ((f.get(3) ?? []) as IdValue[]).map(key) } });
        continue;
      }
      if (e.get(1) === MOVED || e.get(1) === RUN_ENDED) {
        const f = e.get(2) as Map<number, unknown>;
        try {
          if (e.get(1) === RUN_ENDED) runEnds.push({ body: key(f.get(2) as IdValue), at: num(e.get(4)), how: text.decode(f.get(3) as Uint8Array), ...(f.has(1) ? { run: runKey(f.get(1)) } : {}) });
          else moves.push(moveRec(f.get(3) as Map<number, unknown>, f.get(1)));
        } catch { /* a record the page cannot read is not drawn */ }
        continue;
      }
      if (e.get(1) !== SAID) continue;
      const f = e.get(2) as Map<number, unknown>, ref = refOf(f.get(1));
      if (ref) said.push({ speaker: key(e.get(3) as IdValue), at: num(e.get(4)), length: num(f.get(4)), reach: num(f.get(2)), ref, words: null });
    }
    const refs = [...said.filter(x => !x.private).map(x => x.ref), ...nodes.flatMap(r => [r.name, r.description, r.placeName])].filter((r): r is string => !!r);
    // N8 (28 Nov): its words through the read ahead, as a catch-up's are: read one part at a time, they were 4.8 of the
    // 10 to 12 s a cold Verdelis Eden took to reach now (44 parts, each naming a word none had given). Not needed, the
    // read ahead's is let go.
    if (refs.some(r => !words.has(r))) addWords(await partFile(p, n, '.text'));
    else fetching.delete(path(p, `${n}.text`));
    for (const x of said) if (!x.private) x.words = words.get(x.ref) ?? null;
    resolveWords(nodes);
    let carryChanges:PartRec['carryChanges']=[],carryError:string|undefined;
    try{carryChanges=carryChangesInPart(bytes);}catch(error){carryError=String(error);}
    observe(nodes, removed, samples, { number: played.number, from: played.from, to: played.to, hash: played.hash, said, happened, moves, runEnds, carryChanges, ...(carryError?{carryError}:{}) });
    return true;
  };
  const tell = () => {
    const q = ptr.quietUntil;
    if (q !== null && (ptr.newest === null || Number(player.next()) > ptr.newest)) quiet = Math.max(quiet ?? q, q);
    // N14: a still or sleeping world writes no part, but a balloon and a ride's seats go on along their courses: their
    // places up to the time it is still to come with its pointer (the bridge's stillTo), else they stand at the last.
    const now = ptr.anchorWorld + (Date.now() - ptr.anchorWallMs) * 1000;
    const sleep = ptr as StreamPointer & { asleep?: true; stillUntil?: number | null };
    const to = sleep.asleep ? Math.max(quiet ?? -Infinity, sleep.stillUntil == null ? now : Math.min(now, sleep.stillUntil)) : quiet;
    let courses: CoursePlaces = {}, leaves: Record<string, number> = {};
    if (to !== null && to > coursedTo && Number.isFinite(coursedTo) && replica.courseAt) {
      courses = coursePlaces(replica.courseAt, onCourse(), Math.max(coursedTo, to - COURSE_KEEP_US), to);
      leaves = courseLeaves(replica.courseAt, onCourse(), to);
      coursedTo = to;
    }
    post({ t: 'pointer', p: { ...ptr, quietUntil: quiet, ...(Object.keys(courses).length ? { courses } : {}), ...(Object.keys(leaves).length ? { leaves } : {}) } });
  };
  await install(ptr);
  // #5068 item 13: a poll with a refused or unanswered read is followed by a wait that grows (backoffMs), counted in
  // polls passed over; the first poll whose reads are all good goes back to the usual pace.
  let wait = 0;
  const poll = async () => {
    if (busy) return;
    if (wait > 0) return void wait--;
    busy = true;
    refused = false;
    partRead = false;
    try {
      const b = await get(new URL('pointer', stream), true);
      const latest = b ? readPtr(b) as StreamPointer : ptr;
      if (latest.generation !== active) {
        // #3825: the handoff names the generation it closes (none for the legacy stream). A viewer on it drains it and
        // crosses over; one further behind starts again from the newest baseline, as a new viewer does.
        const handoff = latest.legacyNext !== undefined && latest.legacyVersion !== undefined && !!latest.legacyHash && latest.handoffFrom === active;
        if (handoff) {
          // Drain exactly the old published bytes, even when its public terminal lies within a source Part. All of
          // them were written before the pointer named the next generation, so a missing one has been pruned.
          let drained = true;
          while (drained && Number(player.next()) < latest.legacyNext!) drained = await playOne(ptr);
          if (drained && (version !== latest.legacyVersion || player.publicHash() !== latest.legacyHash)) throw new Error('stream-handoff-state');
          if (!drained && active === undefined) return;
          // A live viewer on a generation holds the state the new baseline holds (the digest just checked): it goes on
          // in the new generation without fetching that baseline, and nothing on the page moves. #4535: but its format
          // first, from the baseline's first bytes only (a release may raise it at a rollover); a head that cannot be
          // had says nothing, and the crossing goes on.
          if (drained && active !== undefined) {
            const head = await fetch(new URL(path(latest, 'baseline'), stream), { headers: { Range: 'bytes=0-15' }, cache: 'no-store' }).then((r) => (r.ok ? r.arrayBuffer() : null), () => null);
            if (head) refuseFormat(new Uint8Array(head));
            player.cross(latest.generation!, latest.legacyHash!); active = latest.generation;
          } else await install(latest);
        } else if (!latest.generation) throw new Error('stream-generation-gap');
        else await install(latest);
      }
      ptr = latest;
      tell();
      const far = Math.ceil((BEHIND_US + CUT_US) / ptr.period);
      while (ptr.newest !== null && Number(player.next()) <= ptr.newest) {
        if (ptr.newest - Number(player.next()) > far) {
          if (!(await catchUp(ptr, ptr.newest - far))) break;
          continue;
        }
        if (!(await playOne(ptr))) break;
        if (Number(player.next()) > (ptr.newest ?? -1)) tell();
      }
    } catch (e) { post({ t: 'error', message: String((e as Error)?.stack ?? e) }); }
    finally {
      busy = false;
      fails = refused ? fails + 1 : 0;
      wait = Math.floor(backoffMs(fails) / POLL_MS);
    }
  };
  await poll();
  setInterval(poll, POLL_MS);
}

scope.onmessage = (e: MessageEvent<{ stream: string }>) => {
  run(new URL(e.data.stream)).catch((err) => post({ t: 'error', message: String(err?.stack ?? err) }));
};
