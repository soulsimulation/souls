// Construction parts retain their native frame, slot, position and complete orientation at the depicted body clock.
// CreatorKinds still supplies missing canonical looks; this adapter never owns movement or infers rotation from travel.

import {RecordedCarry} from './recorded-carry.ts';
import type {NodeRec,PartRec,SnapshotRec} from './source/source.ts';
import { layerDraws, OLD_ENTITY } from './layer-draws.ts';

/** A node record, the fields read here (the reader's NodeRec). */
export type PartNode = { id: string; kind: string; parent: string | null; slot?: number | null; pos?: [number, number, number];
  rot?: [number, number, number, number]; slots?: number[][]; soul?: string | null; origin?: string; defines?: string; entry?: Uint8Array };
/** Native sample prefix plus full Q30 orientation. Legacy position-only samples cannot authorize a new pose. */
type SampleRec = [string, string, number | null, number, number, number, number, [number,number,number,number]?];
type Msg = { t: 'part'; p: { nodes: PartNode[]; removed: string[]; samples: SampleRec[] } } | { t: 'snapshot'; s: { nodes: PartNode[]; removed: string[] } } | { t: string };
type Sample = { at: number; frame: string; slot: number | null; p: [number, number, number] };

const Q = 2 ** 30;
const plain = (k: string) => k.split('@')[0];
const isBody = (n: PartNode) => !!n.soul || /:(humanoid|body)$/.test(plain(n.kind));
/** Whether an entry is a part's: it names the points it joins by. */
const isPart = (entry: Uint8Array | undefined) => {
  if (!entry) return false;
  try { return !!(JSON.parse(new TextDecoder().decode(entry)) as { points?: unknown }).points; } catch { return false; }
};

/** An entry's JSON, or null. */
const read = (entry: Uint8Array) => { try { return JSON.parse(new TextDecoder().decode(entry)) as Record<string, unknown>; } catch { return null; } };
/** An edge of a frame, in mm (kitShape's box). */
const FRAME_MM = 30;

/** A holder's entry with its frame as its look: `geometry.parts`, the twelve edges of its bounds, when it has no parts of
 *  its own and a part it admits (`partBounds`, by plain kind) is no taller than it is (it stands inside); else null. */
export function holderFrame(entry: Uint8Array, partBounds: ReadonlyMap<string, number[]>): Uint8Array | null {
  const e = read(entry), g = e?.geometry as { bounds_mm?: unknown; parts?: unknown } | undefined;
  const b = g?.bounds_mm;
  if (!e || !g || g.parts || !Array.isArray(b) || b.length !== 3 || !b.every((v) => typeof v === 'number' && v > 0)) return null;
  const admits = Object.values((e.slots ?? {}) as Record<string, { kinds?: unknown }>).flatMap((s) => (Array.isArray(s?.kinds) ? s.kinds : []));
  if (!admits.some((k) => typeof k === 'string' && (partBounds.get(k)?.[1] ?? Infinity) <= b[1])) return null;
  const [w, h, d] = b as number[], t = FRAME_MM, x = w / 2 - t / 2, z = d / 2 - t / 2, low = t / 2, high = h - t / 2;
  const edge = (at: number[], size: number[]) => ({ kind: 'box', at, size, color: '#8a8f96' });
  const parts = [
    ...[[-x, -z], [x, -z], [-x, z], [x, z]].map(([ex, ez]) => edge([ex, h / 2, ez], [t, h, t])),
    ...[low, high].flatMap((y) => [edge([0, y, -z], [w, t, t]), edge([0, y, z], [w, t, t]), edge([-x, y, 0], [t, t, d]), edge([x, y, 0], [t, t, d])]),
  ];
  return new TextEncoder().encode(JSON.stringify({ ...e, geometry: { ...g, parts } }));
}

/** A holder's slot points as a node record carries them (`[slot, x, y, z]`, mm), from its entry's slots in the order
 *  the entry gives them, numbered from 1 as the world numbers them; null without any. */
export function slotPoints(entry: Uint8Array): number[][] | null {
  const slots = read(entry)?.slots;
  if (!slots || typeof slots !== 'object') return null;
  const out = Object.values(slots as Record<string, { at_mm?: unknown }>).flatMap((s, i) => {
    const at = s?.at_mm;
    return Array.isArray(at) && at.length === 3 && at.every((v) => typeof v === 'number') ? [[i + 1, ...(at as number[])]] : [];
  });
  return out.length ? out : null;
}

/** The place at world time `at` along `s` (sorted by time): between the two around it, else the nearest end. */
export function sampleAt(s: readonly Sample[], at: number): Sample | null {
  if (!s.length) return null;
  if (at <= s[0].at) return s[0];
  for (let i = 1; i < s.length; i++) {
    if (s[i].at < at) continue;
    const a = s[i - 1], b = s[i], f = b.at === a.at ? 1 : (at - a.at) / (b.at - a.at);
    return { at, frame: b.frame, slot: b.slot, p: [0, 1, 2].map((k) => Math.round(a.p[k] + (b.p[k] - a.p[k]) * f)) as [number, number, number] };
  }
  return s[s.length - 1];
}

export class CarriedParts {
  readonly recorded=new RecordedCarry();
  isLoadKind(kind:string){return this.partKinds.has(plain(kind));}
  private readonly nodes = new Map<string, PartNode>();
  private readonly defined = new Set<string>();
  /** Parts with an origin the layer has no entity for (an import's own ids), by id. */
  private readonly unheld = new Set<string>();
  /** The parts' entries, by plain name (read over every entry: the map answers `get` only for kinds the library does
   *  not draw, stream-scene.ts UnlessLibrary, and the library has rack defs). */
  private readonly partKinds = new Map<string, Uint8Array>();
  /** W4: the holders its parts stand inside, their entries with their frame as their look, by plain name. */
  private readonly holders = new Map<string, Uint8Array>();
  /** W4: each holder kind's slot points (`slotPoints`), by plain name. */
  private readonly points = new Map<string, number[][]>();
  /** K5: a load's record before it was lifted or set down, drawn until the time drawn reaches the end of that part. */
  private readonly prior = new Map<string, { until: number; record: PartNode }>();
  private readonly kinds: { apply(nodes: PartNode[], removed: string[]): void };
  private readonly entries: ReadonlyMap<string, Uint8Array>;
  /** Content kinds' whole entries (their own shapes), by plain name, once the page has them (`addLooks`). */
  private readonly looks = new Map<string, Uint8Array>();
  /** `kinds`: the page's CreatorKinds; `entries`: kind entries by plain name (a part drawn from its own shape). */
  constructor(kinds: { apply(nodes: PartNode[], removed: string[]): void }, entries: ReadonlyMap<string, Uint8Array> = new Map()) {
    this.kinds = kinds; this.entries = entries;
    for (const [k, v] of entries) if (isPart(v)) this.partKinds.set(k, v);
    const partBounds = new Map([...this.partKinds].map(([k, v]) => [k, (read(v)?.geometry as { bounds_mm?: number[] } | undefined)?.bounds_mm ?? []]));
    for (const [k, v] of entries) {
      if (isPart(v)) continue;
      const f = holderFrame(v, partBounds), at = slotPoints(v);
      if (f) this.holders.set(k, f);
      if (at) this.points.set(k, at);
    }
  }

  fork(){const out=new CarriedParts({apply:()=>{}},this.entries);out.addLooks(this.looks);return out;}

  receive(m: Msg): void {
    if(m.t==='snapshot'){this.nodes.clear();this.unheld.clear();this.prior.clear();}
    const definitions=m.t==='part'&&'p'in m?m.p.nodes:m.t==='snapshot'&&'s'in m?m.s.nodes:[];
    for(const n of definitions)if(n.defines&&n.entry){const kind=plain(n.defines),slots=slotPoints(n.entry);if(slots)this.points.set(kind,slots);if(isPart(n.entry))this.partKinds.set(kind,n.entry);}
    const raw=m as unknown as {t:'part';p:PartRec}|{t:'snapshot';s:SnapshotRec};
    if(raw.t==='part'||raw.t==='snapshot'){
      const p=raw.t==='part'?raw.p:raw.s;
      const nodes=p.nodes.map(n=>{const slots=n.slots??this.points.get(plain(n.kind));return slots?{...n,slots}:n;});
      this.recorded.receive(raw.t==='part'?{t:'part',p:{...raw.p,nodes}}:{t:'snapshot',s:{...raw.s,nodes}});
    }
    const nodes = m.t === 'part' && 'p' in m ? m.p.nodes : m.t === 'snapshot' && 's' in m ? m.s.nodes : [];
    const removed = m.t === 'part' && 'p' in m ? m.p.removed : m.t === 'snapshot' && 's' in m ? m.s.removed : [];
    for (const id of removed) { this.nodes.delete(id); this.unheld.delete(id); this.prior.delete(id); }
    const before = new Map<string, PartNode>();
    for (const n of nodes) {
      const old = this.nodes.get(n.id);
      if (old) before.set(n.id, old);
      this.nodes.set(n.id, n);
      const k = plain(n.kind);
      if (n.origin && !OLD_ENTITY.test(n.origin) && this.partKinds.has(k)) this.unheld.add(n.id); else this.unheld.delete(n.id);
      // a part of a kind the layer has no def for: its own entry, as the definition CreatorKinds reads. A part's entry
      // is its look before the library's (`part:`, kept with the kinds' own defs): the library's rack defs are another
      // frame (core-rack-upright lies flat along x, 3.66 m; the kind's upright stands 2.44 m along y). Any thing the
      // layer does not draw itself is CreatorKinds' (a furnished piece named `e_…/bedroom-bed` too), so its kind's too.
      if (layerDraws(n)) continue;
      const own = this.partKinds.get(k), seen = own ? undefined : this.entries.get(k), entry = own ?? (seen && (this.holders.get(k) ?? this.looks.get(k) ?? seen));
      if (entry && !this.defined.has(n.kind)) {
        this.defined.add(n.kind);
        this.kinds.apply([{ id: `${own ? 'part' : 'entry'}:${n.kind}`, kind: 'souls:kind', parent: null, defines: n.kind, entry }], []);
      }
    }
    if (m.t !== 'part' || !('p' in m)) return;
    // K5: a load lifted into a moving frame or set down from one changes when the part ends, as world-state.ts has a
    // change; the page draws its carriers a little behind the newest part, so until then it is drawn as it was
    const to = (m.p as { to?: number }).to;
    if (typeof to !== 'number') return;
    for (const n of m.p.nodes) {
      const was = before.get(n.id);
      if (!was || was.parent === n.parent) continue;
      if ((was.parent && this.recorded.hasSamples(was.parent)) || (n.parent && this.recorded.hasSamples(n.parent))) this.prior.set(n.id, { until: (raw.t==='part'?raw.p.carryChanges?.find(c=>c.node===n.id&&c.pose)?.at:undefined)??to, record: this.prior.get(n.id)?.record ?? was });
    }
  }

  /** Content kinds' whole entries, by plain name, that reach the page after the stream (use-v2-souls.ts: the build's
   *  looks file): a kind drawn so far from its bounds alone is defined again from its own shape. A part's or a holder's
   *  look stays its own. */
  addLooks(more: ReadonlyMap<string, Uint8Array>): void {
    for (const [k, v] of more) if (!this.partKinds.has(k) && !this.holders.has(k)) this.looks.set(k, v);
    const again: PartNode[] = [];
    for (const kind of this.defined) {
      const k = plain(kind), v = this.looks.get(k);
      if (v && more.has(k) && this.entries.get(k)) again.push({ id: `entry:${kind}`, kind: 'souls:kind', parent: null, defines: kind, entry: v });
    }
    if (again.length) this.kinds.apply(again, []);
  }

  /** Listens to the reader's worker, as WorldState.watch does; returns it. */
  watch<W extends { addEventListener(type: 'message', fn: (e: MessageEvent) => void): void }>(w: W): W {
    w.addEventListener('message', (e: MessageEvent) => this.receive(e.data as Msg));
    return w;
  }

  /** The records of the moving frames that carry something, as they stand at world time `at` (µs): each its samples'
   *  place there and its record's turn, turned as its way has turned since that record. Then the parts the layer holds
   *  no entity for, without their origin, wherever the stream has them (on a stand, in a crew's slot, in a bay's). Then
   *  W4: each holder whose record has no slot points (placed live), with its kind's. */
  frames(at: number): PartNode[] {
    const out: PartNode[] = [], carrying = new Set<string>();
    // K5: a load lifted or set down after `at` is still as it was; one whose change the time drawn has reached is handed
    // on as it is now, once (the layer's own things then rest where world-state.ts has them)
    const held = new Map<string, PartNode>();
    for (const [id, p] of this.prior) {
      if (at < p.until) { held.set(id, p.record); continue; }
      this.prior.delete(id);
      const n = this.nodes.get(id);
      if (n && !this.unheld.has(id)) out.push(n);
    }
    for (const [id, n] of held) if (!this.unheld.has(id)) out.push(n);
    for (const id of this.unheld) { const n = held.get(id) ?? this.nodes.get(id); if (n) out.push({ ...n, origin: undefined }); }
    for (const n of this.nodes.values()) {
      const p = n.slots?.length ? undefined : this.points.get(plain(n.kind));
      if (p) out.push({ ...n, slots: p });
    }
    for (const r of this.nodes.values()) { const n = held.get(r.id) ?? r; if (n.parent && this.recorded.hasSamples(n.parent)) carrying.add(n.parent); }
    for (const id of carrying) {
      const n=this.nodes.get(id),here=this.recorded.localPose(id,at);if(!n||!here)continue;
      out.push({...n,parent:here.parent,slot:here.slot,pos:here.p.map(x=>Math.round(x*1e6))as[number,number,number],rot:here.q.map(x=>Math.round(x*Q))as[number,number,number,number]});
    }
    return out;
  }
}

/** The construction kinds' entries, bundled with the page (their parts draw from their own shapes), by plain name. */
export function bundledEntries(files: Record<string, unknown>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>(), enc = new TextEncoder();
  for (const v of Object.values(files)) {
    const e = (v as { default?: unknown }).default ?? v;
    if (e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string') out.set((e as { kind: string }).kind, enc.encode(JSON.stringify(e)));
  }
  return out;
}
