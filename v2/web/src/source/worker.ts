// The stream's worker (V5, #2714): fetches V1's pointer and parts, plays each part on R1's replica (WASM) in number
// order, and reads back the nodes the part changed, so the page's thread only draws. Started by `StreamSource`.
// The words path (V1b, #3361): it hands on each part's `souls:said` events (replica's event query) and a body's name
// and description (fields 30, 31), each with its words from the part's text file `<n>.text` (`[[reference, words],
// ...]`, the public audience's, written by V1's writer beside the part), kept by reference across parts.
import init, { StreamPlayer, readPointer } from 'replica';
import { decode, encode } from 'cborg';
import type { NodeRec, PartRec, Pointer, SaidRec } from './source.ts';
import { happenedInPart } from '../sound/record.ts';

type Msg = { t: 'pointer'; p: Pointer } | { t: 'part'; p: PartRec } | { t: 'error'; message: string };
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

function readPtr(bytes: Uint8Array): Pointer & { header: string } {
  const p = JSON.parse(readPointer(bytes));
  return { newest: p.newest, newestTo: p.newestTo ?? null, period: p.period, anchorWorld: p.anchorWorld, anchorWallMs: p.anchorWallMs, quietUntil: p.quietUntil ?? null, header: p.header };
}

/** The reference in a `{21: id}` value, as the page keys it, or null. */
const refOf = (v: unknown): string | null => {
  const id = v instanceof Map ? (v.get(21) as IdValue | undefined) : undefined;
  return id ? key(id) : null;
};
const SAID = 'souls:said';
const NAME = 30;
const DESCRIPTION = 31;

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
  return rec;
}

async function run(stream: URL) {
  await init();
  let ptr = readPtr((await get(new URL('pointer', stream)))!);
  const header = await get(new URL(`../../../headers/${ptr.header}`, stream));
  if (!header) throw new Error('no header');
  const player = new StreamPlayer(header);
  const query = (q: Map<number, unknown>) => decode(player.query(encode(q)), { useMaps: true });
  let version = 0;
  let busy = false;
  // Words by reference, from every text file read so far.
  const words = new Map<string, string>();
  const text = new TextDecoder();
  const readText = async (n: number) => {
    const b = await get(new URL(`${n}.text`, stream));
    if (!b) return;
    for (const [id, w] of decode(b, { useMaps: true }) as [IdValue, Uint8Array][]) words.set(key(id), text.decode(w));
  };
  // A still world's "quiet until" (V5b) holds once every part before it is played, and goes on holding when a part
  // is written after it (the writer then drops it from the pointer): the page's caught-up time never steps back.
  let quiet: number | null = null;
  const tell = () => {
    const q = ptr.quietUntil;
    if (q !== null && (ptr.newest === null || Number(player.next()) > ptr.newest)) quiet = Math.max(quiet ?? q, q);
    post({ t: 'pointer', p: { ...ptr, quietUntil: quiet } });
  };
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const b = await get(new URL('pointer', stream));
      if (b) ptr = readPtr(b);
      tell();
      while (ptr.newest !== null && Number(player.next()) <= ptr.newest) {
        const n = Number(player.next());
        const bytes = await get(new URL(String(n), stream));
        if (!bytes) break;
        const played = JSON.parse(player.play(bytes));
        const changed = query(new Map<number, unknown>([[1, 5], [2, version]])) as [IdValue, number][];
        version = played.version;
        const nodes: NodeRec[] = [];
        const removed: string[] = [];
        const transfer: Transferable[] = [];
        for (const [id] of changed) {
          try {
            const rec = nodeRec(query(new Map<number, unknown>([[1, 1], [2, id]])) as Map<number, unknown>);
            for (const t of rec.tiles ?? []) transfer.push(t[2].buffer as ArrayBuffer, t[3].buffer as ArrayBuffer);
            nodes.push(rec);
          } catch {
            removed.push(key(id));
          }
        }
        const samples = JSON.parse(player.samples());
        let happened: PartRec['happened'] = [];
        try { happened = happenedInPart(bytes); } catch { /* sounds only: the part played */ }
        const events = decode(player.events(), { useMaps: true }) as Map<number, unknown>[];
        const said: SaidRec[] = [];
        for (const e of events) {
          if (e.get(1) !== SAID) continue;
          const f = e.get(2) as Map<number, unknown>;
          const ref = refOf(f.get(1));
          if (!ref) continue;
          said.push({ speaker: key(e.get(3) as IdValue), at: num(e.get(4)), length: num(f.get(4)), reach: num(f.get(2)), ref, words: null });
        }
        // Names and descriptions are references until their words are known.
        const refs = [...said.map((x) => x.ref), ...nodes.flatMap((r) => [r.name, r.description])].filter((r): r is string => !!r);
        if (refs.some((r) => !words.has(r))) await readText(n);
        for (const x of said) x.words = words.get(x.ref) ?? null;
        for (const r of nodes) {
          if (r.name) r.name = words.get(r.name) ?? null;
          if (r.description) r.description = words.get(r.description) ?? null;
        }
        post({ t: 'part', p: { number: played.number, from: played.from, to: played.to, nodes, removed, samples, hash: played.hash, said, happened } }, transfer);
        if (Number(player.next()) > (ptr.newest ?? -1)) tell();
      }
    } catch (e) {
      post({ t: 'error', message: String((e as Error)?.message ?? e) });
    }
    busy = false;
  };
  await poll();
  setInterval(poll, 250);
}

self.onmessage = (e: MessageEvent<{ stream: string }>) => {
  run(new URL(e.data.stream)).catch((err) => post({ t: 'error', message: String(err?.stack ?? err) }));
};
