// The stream's worker (V5, #2714): fetches V1's pointer and parts, plays each part on R1's replica (WASM) in number
// order, and reads back the nodes the part changed, so the page's thread only draws. Started by `StreamSource`.
import init, { StreamPlayer, readPointer } from 'replica';
import { decode, encode } from 'cborg';
import type { NodeRec, PartRec, Pointer } from './source.ts';

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
  return { newest: p.newest, newestTo: p.newestTo ?? null, period: p.period, anchorWorld: p.anchorWorld, anchorWallMs: p.anchorWallMs, header: p.header };
}

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
  if (f.has(12)) rec.solids = rows(f.get(12));
  if (f.has(13)) rec.slots = rows(f.get(13));
  if (f.has(23)) rec.scale = num(f.get(23));
  if (f.has(24)) rec.tileSize = num(f.get(24));
  if (f.has(25)) rec.tiles = (f.get(25) as unknown[][]).map((t) => [num(t[0]), num(t[1]), t[2] as Uint8Array, t[3] as Uint8Array]);
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
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const b = await get(new URL('pointer', stream));
      if (b) ptr = readPtr(b);
      post({ t: 'pointer', p: ptr });
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
        post({ t: 'part', p: { number: played.number, from: played.from, to: played.to, nodes, removed, hash: played.hash } }, transfer);
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
