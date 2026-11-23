// K1 (0.135): group work's parts on the old page, read from the stream. A load two Souls carry rides its carry's node
// (`sim::activity::carry`: the board is the rider of the activity's node, in its slot), and that node moves by motion
// samples, as a body does, not by new records. The page places things from their records (creator-kinds.ts,
// world-state.ts `placedOf`), so a carried load would stay where it was lifted until it is set down. This keeps each
// moving frame's samples and hands CreatorKinds its record as it stands at the time the page draws: the samples'
// place there, its record's turn turned by as much as its way has turned since that record. A part whose kind the layer has no
// def for is drawn from its own shape: its entry (content/kinds/construction, bundled) as a definition CreatorKinds
// reads (kindDef: its geometry's box). Nothing here draws.

/** A node record, the fields read here (the reader's NodeRec). */
export type PartNode = { id: string; kind: string; parent: string | null; slot?: number | null; pos?: [number, number, number];
  rot?: [number, number, number, number]; soul?: string | null; origin?: string; defines?: string; entry?: Uint8Array };
/** A motion sample as the reader posts it: id, frame, slot, world time µs, x, y, z (µm). */
type SampleRec = [string, string, number | null, number, number, number, number];
type Msg = { t: 'part'; p: { nodes: PartNode[]; removed: string[]; samples: SampleRec[] } } | { t: 'snapshot'; s: { nodes: PartNode[]; removed: string[] } } | { t: string };
type Sample = { at: number; frame: string; slot: number | null; p: [number, number, number] };

const Q = 2 ** 30;
/** How long a moving frame's samples are kept: the page draws at most a few seconds behind the newest. */
const KEEP_US = 30_000_000;
const plain = (k: string) => k.split('@')[0];
const isBody = (n: PartNode) => !!n.soul || /:(humanoid|body)$/.test(plain(n.kind));

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

/** The way a frame faces as it moves (radians about +y, as the old page's yaw), over the samples up to `at`; null still. */
export function headingAt(s: readonly Sample[], at: number): number | null {
  let last: Sample | null = null;
  for (const x of s) if (x.at <= at) last = x;
  for (let i = s.indexOf(last!) - 1; last && i >= 0; i--) {
    const dx = last.p[0] - s[i].p[0], dz = last.p[2] - s[i].p[2];
    if (Math.hypot(dx, dz) > 50_000) return Math.atan2(-dz, dx); // 5 cm or more: a direction, not jitter
  }
  return null;
}

/** A turn about +y by `yaw` applied to a record's turn `[w, x, y, z]` (×2^30). */
function turned(rot: [number, number, number, number], yaw: number): [number, number, number, number] {
  const c = Math.cos(yaw / 2), s = Math.sin(yaw / 2), [w, x, y, z] = rot.map((v) => v / Q);
  // (c + s·j) · (w + x·i + y·j + z·k)
  return [c * w - s * y, c * x + s * z, c * y + s * w, c * z - s * x].map((v) => Math.round(v * Q)) as [number, number, number, number];
}

export class CarriedParts {
  private readonly nodes = new Map<string, PartNode>();
  private readonly tracks = new Map<string, Sample[]>();
  private readonly defined = new Set<string>();
  /** Each moving frame's heading when its record last changed (its record's turn is the turn at that heading). */
  private readonly base = new Map<string, number>();
  private readonly kinds: { apply(nodes: PartNode[], removed: string[]): void };
  private readonly entries: ReadonlyMap<string, Uint8Array>;
  /** `kinds`: the page's CreatorKinds; `entries`: kind entries by plain name (a part drawn from its own shape). */
  constructor(kinds: { apply(nodes: PartNode[], removed: string[]): void }, entries: ReadonlyMap<string, Uint8Array> = new Map()) {
    this.kinds = kinds; this.entries = entries;
  }

  receive(m: Msg): void {
    const nodes = m.t === 'part' && 'p' in m ? m.p.nodes : m.t === 'snapshot' && 's' in m ? m.s.nodes : [];
    const removed = m.t === 'part' && 'p' in m ? m.p.removed : m.t === 'snapshot' && 's' in m ? m.s.removed : [];
    for (const id of removed) { this.nodes.delete(id); this.tracks.delete(id); }
    for (const n of nodes) {
      this.nodes.set(n.id, n);
      this.base.delete(n.id);
      // a part of a kind the layer has no def for: its own entry, as the definition CreatorKinds reads
      const entry = n.origin ? undefined : this.entries.get(plain(n.kind));
      if (entry && !this.defined.has(n.kind)) {
        this.defined.add(n.kind);
        this.kinds.apply([{ id: `entry:${n.kind}`, kind: 'souls:kind', parent: null, defines: n.kind, entry }], []);
      }
    }
    if (m.t !== 'part' || !('p' in m)) return;
    for (const [id, frame, slot, at, x, y, z] of m.p.samples) {
      const n = this.nodes.get(id);
      if (n && isBody(n)) continue; // bodies are the bridge's
      const t = this.tracks.get(id) ?? this.tracks.set(id, []).get(id)!;
      if (t.length && at <= t[t.length - 1].at) continue;
      t.push({ at, frame, slot, p: [x, y, z] });
      while (t.length > 2 && t[1].at < at - KEEP_US) t.shift();
    }
  }

  /** Listens to the reader's worker, as WorldState.watch does; returns it. */
  watch<W extends { addEventListener(type: 'message', fn: (e: MessageEvent) => void): void }>(w: W): W {
    w.addEventListener('message', (e: MessageEvent) => this.receive(e.data as Msg));
    return w;
  }

  /** The records of the moving frames that carry something, as they stand at world time `at` (µs): each its samples'
   *  place there and its record's turn, turned as its way has turned since that record. */
  frames(at: number): PartNode[] {
    const out: PartNode[] = [], carrying = new Set<string>();
    for (const n of this.nodes.values()) if (n.parent && this.tracks.has(n.parent)) carrying.add(n.parent);
    for (const id of carrying) {
      const n = this.nodes.get(id), s = this.tracks.get(id)!, here = sampleAt(s, at);
      if (!n || !here || !n.rot) continue;
      const now = headingAt(s, at);
      if (now !== null && !this.base.has(id)) this.base.set(id, now);
      const first = this.base.get(id);
      const rot = now !== null && first !== undefined ? turned(n.rot, now - first) : n.rot;
      out.push({ ...n, parent: here.frame, slot: here.slot, pos: here.p, rot });
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
