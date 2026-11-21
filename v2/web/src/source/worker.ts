// The stream's worker (V5, #2714): fetches V1's pointer and parts, plays each part on R1's replica (WASM) in number
// order, and reads back the nodes the part changed, so the page's thread only draws. Started by `StreamSource`.
// The words path (V1b, #3361): it hands on each part's `souls:said` events (replica's event query) and a body's name
// and description (fields 30, 31), each with its words from the part's text file `<n>.text` (`[[reference, words],
// ...]`, the public audience's, written by V1's writer beside the part), kept by reference across parts. A named
// place's name (import-eden's field 4, a SHA-256 of its words) is a `[hash, words]` row of the same files (#3574).
import init, { StreamPlayer, readPointer } from 'replica';
import { decode, encode } from 'cborg';
import { publicSoul, type NodeRec, type PartRec, type Pointer, type SaidRec, type SnapshotRec } from './source.ts';
import { happenedInPart } from '../sound/record.ts';
import { readChanged } from './changed.ts';
import { skyFields } from '../sky/record.ts';

type Msg = { t: 'snapshot'; s: SnapshotRec } | { t: 'pointer'; p: Pointer } | { t: 'part'; p: PartRec } | { t: 'error'; message: string };
const post = (m: Msg, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
type IdValue = [Uint8Array, number];
const key = (id: IdValue) => `${hex(id[0])}.${num(id[1])}`;
const rows = (v: unknown) => (v as unknown[][] | undefined)?.map((r) => r.map(num));

async function get(url: URL): Promise<Uint8Array | null> {
  const res = await fetch(url, { cache: 'no-store' });
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

function readPtr(bytes: Uint8Array): StreamPointer {
  const p = JSON.parse(readPointer(bytes));
  return { newest: p.newest, newestTo: p.newestTo ?? null, period: p.period, anchorWorld: p.anchorWorld, anchorWallMs: p.anchorWallMs, quietUntil: p.quietUntil ?? null, header: p.header, ...(p.baseline ? { baseline: p.baseline, generation: p.generation } : {}), ...(p.legacyHash ? { legacyVersion: p.legacyVersion, legacyNext: p.legacyNext, legacyHash: p.legacyHash } : {}) };
}

/** The reference in a `{21: id}` value, as the page keys it, or null. */
const refOf = (v: unknown): string | null => {
  const id = v instanceof Map ? (v.get(21) as IdValue | undefined) : undefined;
  return id ? key(id) : null;
};
/** The key of a name's hash (field 4), kept apart from `{21: id}` references. */
const nameKey = (b: Uint8Array) => `n:${hex(b)}`;
const SAID = 'souls:said';
const PLACE_NAME = 4;
const NAME = 30;
const DESCRIPTION = 31;
const COURSE = 80; // a moving node's course (#3603)

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
  if (f.has(1)) rec.origin = new TextDecoder().decode(f.get(1) as Uint8Array);
  if (f.has(11)) rec.outline = rows(f.get(11));
  if (f.has(12)) rec.solids = rows(f.get(12));
  if (f.has(13)) rec.slots = rows(f.get(13));
  if (f.has(14)) rec.surfaces = (f.get(14) as unknown[][]).map((r) => [num(r[0]), rows(r[1])!]);
  if (f.has(18)) rec.waterLevel = num(f.get(18));
  if (f.has(23)) rec.scale = num(f.get(23));
  if (f.has(24)) rec.tileSize = num(f.get(24));
  if (f.has(25)) rec.tiles = (f.get(25) as unknown[][]).map((t) => [num(t[0]), num(t[1]), t[2] as Uint8Array, t[3] as Uint8Array]);
  if (f.has(NAME)) rec.name = refOf(f.get(NAME));
  if (f.has(DESCRIPTION)) rec.description = refOf(f.get(DESCRIPTION));
  if (f.has(COURSE)) rec.course = encode(f.get(COURSE)); // #3603: re-encoded canonically, as the record holds it
  if (f.has(32)) rec.body = hex(f.get(32) as Uint8Array);
  const placeName = f.get(PLACE_NAME);
  if (placeName instanceof Uint8Array && placeName.length === 32) rec.placeName = nameKey(placeName);
  const sky = skyFields(f); // V19: the world node's day, night and weather
  if (sky) rec.sky = sky;
  return rec;
}

type StreamPointer = Pointer & { header: string; baseline?: string; generation?: string; legacyVersion?: number; legacyNext?: number; legacyHash?: string };

async function run(stream: URL) {
  await init();
  let ptr = readPtr((await get(new URL('pointer', stream)))!) as StreamPointer;
  let player: StreamPlayer;
  let active: string | undefined;
  let version = 0;
  let busy = false;
  let quiet: number | null = null;
  const words = new Map<string, string>();
  const known = new Map<string, NodeRec>();
  let drawn = new Set<string>();
  const text = new TextDecoder();
  const path = (p: StreamPointer, file: string) => p.generation ? `g/${p.generation}/${file}` : file;
  const readText = async (file: string, p = ptr) => {
    const b = await get(new URL(path(p, file), stream));
    if (!b) return;
    for (const [id, w] of decode(b, { useMaps: true }) as [IdValue | Uint8Array, Uint8Array][]) words.set(id instanceof Uint8Array ? nameKey(id) : key(id), text.decode(w));
  };
  const query = (q: Map<number, unknown>) => decode(player.query(encode(q)), { useMaps: true });
  const resolveWords = (nodes: NodeRec[]) => {
    for (const r of nodes) {
      if (r.name) r.name = words.get(r.name) ?? null;
      if (r.description) r.description = words.get(r.description) ?? null;
      if (r.placeName) r.placeName = words.get(r.placeName) ?? null;
    }
  };
  // Preserve opaque local records in the WASM/public copy and here. Drawing may only observe a complete actual
  // public frame chain; a missing private frame is never an identity/world transform.
  const drawable = (id: string): boolean => {
    const seen = new Set<string>();
    for (let depth = 0; depth <= 32; depth++) {
      if (seen.has(id)) return false;
      seen.add(id);
      const n = known.get(id);
      if (!n) return false;
      if (n.parent === null) return true;
      id = n.parent;
    }
    return false;
  };
  const observe = (nodes: NodeRec[], removed: string[], samples: PartRec['samples'], rest?: Omit<PartRec, 'nodes' | 'removed' | 'samples'>) => {
    for (const id of removed) known.delete(id);
    for (const node of nodes) known.set(node.id, node);
    const next = new Set([...known.keys()].filter(drawable));
    const changed = new Set(nodes.map(n => n.id));
    const visible = [...next].filter(id => changed.has(id) || !drawn.has(id)).map(id => {
      const n = known.get(id)!;
      return { ...n, ...(n.tiles ? { tiles: n.tiles.map(t => [t[0], t[1], t[2].slice(), t[3].slice()] as NonNullable<NodeRec['tiles']>[number]) } : {}) };
    });
    const gone = [...drawn].filter(id => !next.has(id));
    drawn = next;
    const transfer: Transferable[] = [];
    // A retained unresolved record may become drawable later; transfer fresh buffers, retaining its exact bytes.
    for (const n of visible) for (const t of n.tiles ?? []) transfer.push(t[2].buffer as ArrayBuffer, t[3].buffer as ArrayBuffer);
    if (rest) post({ t: 'part', p: { ...rest, nodes: visible, removed: gone, samples: samples.filter(s => next.has(s[0])) } }, transfer);
    else post({ t: 'snapshot', s: { nodes: visible, removed: gone } }, transfer);
  };
  const install = async (p: StreamPointer) => {
    const header = await get(new URL(`../../../headers/${p.header}`, stream));
    if (!header) throw new Error('no header');
    if (!p.generation) { player = new StreamPlayer(header); active = undefined; return; }
    if (!/^[0-9a-f]{64}$/.test(p.generation) || p.baseline !== p.generation) throw new Error('stream-generation-record');
    const baseline = await get(new URL(path(p, 'baseline'), stream));
    if (!baseline || hex(new Uint8Array(await crypto.subtle.digest('SHA-256', baseline as BufferSource))) !== p.baseline) throw new Error('stream-baseline-hash');
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
    const removed = [...known.keys()].filter(id => !nodes.some(n => n.id === id));
    observe(nodes, removed, []);
  };
  const playOne = async (p: StreamPointer): Promise<boolean> => {
    const n = Number(player.next());
    const bytes = await get(new URL(path(p, String(n)), stream));
    if (!bytes) return false;
    const played = JSON.parse(player.play(bytes));
    const changed = query(new Map<number, unknown>([[1, 5], [2, version]])) as [IdValue, number][];
    version = played.version;
    const { nodes, removed } = readChanged(
      changed.map(([id]) => id), key,
      (id) => query(new Map<number, unknown>([[1, 1], [2, id]])) as Map<number, unknown>,
      () => new Map((decode(player.snapshot(), { useMaps: true }) as Map<number, unknown>[]).map(v => [key(v.get(1) as IdValue), v])),
      nodeRec,
    );
    const samples = JSON.parse(player.samples());
    let happened: PartRec['happened'] = [];
    try { happened = happenedInPart(bytes); } catch { /* sound observes only a successfully played part */ }
    const events = decode(player.events(), { useMaps: true }) as Map<number, unknown>[];
    const said: SaidRec[] = [];
    for (const e of events) {
      if (e.get(1) !== SAID) continue;
      const f = e.get(2) as Map<number, unknown>, ref = refOf(f.get(1));
      if (ref) said.push({ speaker: key(e.get(3) as IdValue), at: num(e.get(4)), length: num(f.get(4)), reach: num(f.get(2)), ref, words: null });
    }
    const refs = [...said.map(x => x.ref), ...nodes.flatMap(r => [r.name, r.description, r.placeName])].filter((r): r is string => !!r);
    if (refs.some(r => !words.has(r))) await readText(`${n}.text`, p);
    for (const x of said) x.words = words.get(x.ref) ?? null;
    resolveWords(nodes);
    observe(nodes, removed, samples, { number: played.number, from: played.from, to: played.to, hash: played.hash, said, happened });
    return true;
  };
  const tell = () => {
    const q = ptr.quietUntil;
    if (q !== null && (ptr.newest === null || Number(player.next()) > ptr.newest)) quiet = Math.max(quiet ?? q, q);
    post({ t: 'pointer', p: { ...ptr, quietUntil: quiet } });
  };
  await install(ptr);
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const b = await get(new URL('pointer', stream));
      const latest = b ? readPtr(b) as StreamPointer : ptr;
      if (latest.generation !== active) {
        if (active !== undefined || latest.legacyNext === undefined || latest.legacyVersion === undefined || !latest.legacyHash) throw new Error('stream-generation-gap');
        // Drain exactly the old published bytes, even when its public terminal lies within a source Part.
        while (Number(player.next()) < latest.legacyNext) if (!(await playOne(ptr))) return;
        if (version !== latest.legacyVersion || player.publicHash() !== latest.legacyHash) throw new Error('stream-handoff-state');
        await install(latest);
      }
      ptr = latest;
      tell();
      while (ptr.newest !== null && Number(player.next()) <= ptr.newest) {
        if (!(await playOne(ptr))) break;
        if (Number(player.next()) > (ptr.newest ?? -1)) tell();
      }
    } catch (e) { post({ t: 'error', message: String((e as Error)?.message ?? e) }); }
    finally { busy = false; }
  };
  await poll();
  setInterval(poll, 250);
}

self.onmessage = (e: MessageEvent<{ stream: string }>) => {
  run(new URL(e.data.stream)).catch((err) => post({ t: 'error', message: String(err?.stack ?? err) }));
};
