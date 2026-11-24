// 0.133 V1: kinds that exist only in the new format, drawn on the old page by its own kind layer. A creator's kind is a
// `souls:kind` node of the v2 world (replica::kinds::defined): its full name `ns:name@<hash>` (field 1) and its
// canonical `souls-entry/1` record (field 2), which the stream reader hands on as `defines` and `entry`. This module
// reads that record into the old page's own def (def/1: today's kit/2 shapes, or a mesh by its model's hash), and each
// thing of such a kind into an old entity at its world pose, and sends both to the entity layer as one `world-diff`, as
// world-state.ts sends doors and lamps. Nothing here draws: the layer draws the def as it draws any other.
//
// 0.133 V2: what a creator adds and removes. A thing of a kind the world already has (a bench beside the world's own
// benches) is drawn with the old def the world's own things of that kind have (learned from them: a node's `origin` is
// its old entity), and a thing of the world's own scene a creator removes leaves the layer. A thing moved (the world's
// own, B2-2's path in world-state.ts, or a creator's, here) moves as the layer eases any moved thing.
//
// The record's look, read as #3945 reads it for the v2 page (v2/web/src/kinds/catalogue.ts `recordEntry`, copied, not
// imported): `geometry.parts` (kit shapes in mm, millidegrees and permille, as `souls-god define-kit` writes them) and
// `geometry.palette`. A model (K3, #3725's design: an allowed upload named by its hash, `1220` and the SHA-256 in hex)
// is `looks.model: "upload:<hash>"`; the old page fetches it from where the world serves uploads (`/v2/uploads/<hash>`,
// gatewayd #3930). A record with neither draws its bounds as one box, so the thing is never invisible.
import { defSchema, hashOf, type StoredDef } from '@souls/world-compiler';
import { placedOf, tintState, turnOf, type LayerLike, type WorldDiff } from './world-state.ts';
import { placedDef, shapeOf } from './source/stream-scene.ts';

/** The reader's node record, the fields read here (v2/web/src/source/source.ts NodeRec). */
type NodeLike = { id: string; kind: string; parent: string | null; pos?: [number, number, number]; rot?: [number, number, number, number];
  slot?: number | null; slots?: number[][]; soul?: string | null; origin?: string; defines?: string; entry?: Uint8Array; tint?: [string, number][];
  line?: number[][]; lineWidth?: number; outline?: number[][] };
type Msg = { t: 'part'; p: { nodes: NodeLike[]; removed: string[] } } | { t: 'snapshot'; s: { nodes: NodeLike[]; removed: string[] } } | { t: string };
type Json = Record<string, unknown>;

/** The engine's generic kind a creator's definition is a node of. */
export const DEFINITION = 'souls:kind';
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const point = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const UPLOAD = /^upload:(1220([0-9a-f]{64}))$/;
/** A body (bridge.ts isBody): the bodies' adapter draws it. */
const isBody = (n: NodeLike) => !!n.soul || /:(humanoid|body)$/.test(plain(n.kind));
/** A kind's plain name: `ns:name`, without its revision. */
const plain = (k: string) => k.split('@')[0];

/** Entry shape lengths in mm (kit/2: metres); angles in millidegrees (kit/2: radians); `scale` and `glow` in permille. */
const LENGTH = new Set(['r', 'r2', 'h', 'round', 'width', 'depth', 'thickness', 'tube']);
const POINTS = new Set(['path', 'profile', 'polygon']);
const ANGLE = new Set(['pitch', 'yaw', 'roll']);
const mm = (v: number) => v / 1000;

/** One record part as a kit/2 shape: a part written `from`/`to` stands at their middle, turned along them (#3945). */
export function kitShape(p: Json): Json | null {
  if (typeof p.kind !== 'string') return null;
  let s: Json = p;
  if (!point(p.at)) {
    if (!point(p.from) || !point(p.to)) return null;
    const a = p.from, b = p.to, d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(d[0], d[1], d[2]);
    const { from: _f, to: _t, ...rest } = p;
    s = { ...rest, at: a.map((x, i) => x + d[i] / 2) };
    // YXZ: the pitch tips +y towards +z, then the yaw turns it about +y, so +y runs from `from` to `to`
    if (len > 0) s = { ...s, pitch: (Math.acos(d[1] / len) * 180_000) / Math.PI, yaw: (Math.atan2(d[0], d[2]) * 180_000) / Math.PI, h: typeof p.h === 'number' ? p.h : len };
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'at' || k === 'size' || k === 'pivot') out[k] = Array.isArray(v) ? v.map((x) => mm(Number(x))) : v;
    else if (POINTS.has(k) && Array.isArray(v)) out[k] = v.map((q) => (Array.isArray(q) ? q.map((x) => mm(Number(x))) : q));
    else if (LENGTH.has(k) && typeof v === 'number') out[k] = mm(v);
    else if (ANGLE.has(k) && typeof v === 'number') out[k] = (v / 1000) * (Math.PI / 180);
    else if ((k === 'scale' || k === 'glow') && (typeof v === 'number' || Array.isArray(v))) out[k] = Array.isArray(v) ? v.map((x) => Number(x) / 1000) : v / 1000;
    else if (k !== 'role') out[k] = v;
  }
  return out;
}

/** A creator's kind's record (its bytes) as the old page's def, with the model's hash when it names one; null when it is
 *  not a `souls-entry/1` record. The def's name is the kind's, with its revision's hash, so a changed definition is a
 *  new def and the things placed from the old one keep theirs. */
export function kindDef(full: string, bytes: Uint8Array): { def: StoredDef; model: string | null } | null {
  let entry: Json | null;
  try { entry = obj(JSON.parse(new TextDecoder().decode(bytes))); } catch { return null; }
  if (!entry || entry.format !== 'souls-entry/1') return null;
  const m = /^([a-z0-9_-]+):([a-z0-9_-]+)@([0-9a-f]+)/i.exec(full);
  if (!m) return null;
  const name = `v2-${m[1]}-${m[2]}-${m[3].slice(-12)}`.toLowerCase().replace(/_/g, '-');
  const g = obj(entry.geometry) ?? {}, b = Array.isArray(g.bounds_mm) && point(g.bounds_mm) ? g.bounds_mm : [1000, 1000, 1000];
  const box = b.map((x) => Math.max(0.01, mm(x))) as [number, number, number];
  const palette = Object.fromEntries(Object.entries(obj(g.palette) ?? {}).filter(([, v]) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)));
  const shapes = (Array.isArray(g.parts) ? g.parts : []).map((p) => (obj(p) ? kitShape(p as Json) : null)).filter((s): s is Json => !!s);
  const upload = UPLOAD.exec(String(obj(entry.looks)?.model ?? ''));
  const make = upload ? { kind: 'mesh' as const, asset: upload[2] }
    : { kind: 'gen' as const, gen: 'kit/2', args: { shapes: shapes.length ? shapes : [{ kind: 'box', at: [0, box[1] / 2, 0], size: box, color: '#b8a58a' }] } };
  const card = obj(entry.text)?.card;
  let def;
  try {
    def = defSchema.parse({ schema: 'def/1', name, version: 1, description: typeof card === 'string' ? card.slice(0, 4000) : '', form: 'point', make,
      size: { box }, ...(Object.keys(palette).length ? { palette } : {}) });
  } catch { return null; }
  const { budget: _b, ...hashable } = def;
  return { def: { ...def, budget: { tris: 0, bytes: 0, textures: 0 }, hash: hashOf(hashable), ref: `${name}@1`, by: 'v2', born: 0 }, model: upload ? upload[1] : null };
}

/** The old page's entity id for a v2 node (`[eh]_` and 4 to 12 of [a-z0-9]): the node's own id when it is one already
 *  (an imported thing), else one made from it. */
export function entityId(node: string): string {
  if (/^[eh]_[a-z0-9]{4,12}$/.test(node)) return node;
  let h = 2166136261;
  for (let i = 0; i < node.length; i++) h = Math.imul(h ^ node.charCodeAt(i), 16777619);
  let h2 = h ^ 0x9e3779b9;
  for (let i = node.length - 1; i >= 0; i--) h2 = Math.imul(h2 ^ node.charCodeAt(i), 16777619);
  return `e_v${((h >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 11)}`;
}

/** What the stream says of the creator's kinds and the things of them, kept as parts arrive; `next` makes the diff. */
export class CreatorKinds {
  private nodes = new Map<string, NodeLike>();
  /** Defs by the full kind name they draw, and each definition node's full name. */
  private defs = new Map<string, { def: StoredDef; model: string | null }>();
  private definers = new Map<string, string>();
  /** What the layer was last sent: each thing's def and place. */
  private sent = new Map<string, string>();
  /** K5: the things last sent tilted. */
  private readonly tilted = new Set<string>();
  /** V2: the old def each kind's own things have in the layer (its plain name → the def's ref), and the old entities
   *  whose nodes a creator removed. */
  private oldDefs = new Map<string, string>();
  private gone = new Set<string>();
  /** W2: content kinds' own shapes (take-parts.ts), by full and plain name: after the old and library defs. */
  private shapes = new Map<string, { def: StoredDef; model: string | null }>();
  /** Where a model's bytes are, by its upload hash (gatewayd's `/v2/uploads/<hash>`, same origin). */
  private readonly uploadUrl: (hash: string) => string;
  private readonly onModel: (sha: string, url: string) => void;
  constructor(uploadUrl: (hash: string) => string = (h) => `/v2/uploads/${h}`, onModel: (sha: string, url: string) => void = () => {}) {
    this.uploadUrl = uploadUrl;
    this.onModel = onModel;
  }

  /** Every node the stream has shown, by id (read only: the panel's Build picks and places from it). */
  get seen(): ReadonlyMap<string, NodeLike> { return this.nodes; }

  apply(nodes: NodeLike[], removed: string[]): void {
    for (const id of removed) {
      const o = this.nodes.get(id)?.origin;
      if (o && !o.includes('/')) this.gone.add(o);
      this.nodes.delete(id);
      const full = this.definers.get(id);
      if (full === undefined) continue;
      this.definers.delete(id);
      if (![...this.definers.values()].includes(full)) this.defs.delete(full);
      if (![...this.definers.values()].some((f) => f.split('@')[0] === full.split('@')[0])) this.defs.delete(full.split('@')[0]);
    }
    for (const n of nodes) {
      this.nodes.set(n.id, n);
      if (n.kind.split('@')[0] !== DEFINITION || !n.defines || !n.entry || this.definers.get(n.id) === n.defines) continue;
      const d = kindDef(n.defines, n.entry);
      if (!d) continue;
      this.definers.set(n.id, n.defines);
      // a thing names its kind by the full name, or (as the creator places it) by the plain one: the newest definition.
      // W2: a content kind's own shape (take-parts.ts, `entry:` definers) is kept apart: it draws only what nothing else does
      const into = n.id.startsWith('entry:') ? this.shapes : this.defs;
      into.set(n.defines, d);
      into.set(n.defines.split('@')[0], d);
      if (d.model && d.def.make.kind === 'mesh') this.onModel(d.def.make.asset, this.uploadUrl(d.model));
    }
  }

  /** Listens to the reader's worker, as WorldState.watch does; returns it. */
  watch<W extends { addEventListener(type: 'message', fn: (e: MessageEvent) => void): void }>(w: W): W {
    w.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as Msg;
      if (m.t === 'part' && 'p' in m) this.apply(m.p.nodes, m.p.removed);
      else if (m.t === 'snapshot' && 's' in m) this.apply(m.s.nodes, m.s.removed);
    });
    return w;
  }

  /** The things of a creator's kind the layer does not draw as v2 has them yet, as one diff after sequence `after` (the
   *  layer's, or a diff already made this turn); null when there is nothing to send or no layer yet. */
  next(layer: LayerLike | null | undefined, at: number, after?: number): WorldDiff | null {
    const m = layer?.model, seq = layer?.seq;
    if (!m || typeof seq !== 'number') return null;
    const defs: StoredDef[] = [], upserts: unknown[] = [], removes: string[] = [];
    // a def goes with each diff while the layer does not hold it (a resync takes the world's own defs again)
    const held = (m as { defs?: { has(k: string): boolean } }).defs, need = (d: StoredDef) => !held?.has(d.ref) && !defs.includes(d);
    // V2: the old def of each kind the world's own things show (a node's origin is its entity in the layer)
    for (const n of this.nodes.values()) {
      const e = n.origin && !n.origin.includes('/') ? (m.entities.get(n.origin) as { def?: string } | undefined) : undefined;
      if (e?.def && !this.oldDefs.has(plain(n.kind))) this.oldDefs.set(plain(n.kind), e.def);
    }
    const live = new Set<string>();
    for (const [id, n] of this.nodes) {
      if (n.origin) continue; // the world's own scene: the layer has it, and world-state.ts moves it
      // W2 (0.135): a kind neither defined by a creator nor shown by the world's own things draws by its library def,
      // else by its content entry's own shape
      const own = this.defs.get(n.kind), old = own ? undefined : this.oldDefs.get(plain(n.kind));
      const tint = tintState(n.tint); // R4: a creator's tint, as world-state.ts gives the world's own things theirs
      const eid = entityId(id);
      // a road or an area a creator lays (`place --path | --area`): world-frame geometry along its line or outline, as an
      // imported one is (stream-scene.ts), with no pose of its own; by the world's own roads' def, else the library's
      const shaped = own || isBody(n) ? undefined : placedDef(n.kind, n), shape = shaped ? shapeOf(shaped, n) : null;
      if (shaped && shape) {
        const ref = old ?? shaped.ref, key = JSON.stringify([ref, shape, tint ?? null]), send = !old && need(shaped);
        live.add(eid);
        if (this.sent.get(eid) === key && m.entities.has(eid) && !send) continue;
        if (send) defs.push(shaped);
        upserts.push({ id: eid, def: ref, in: { parent: 'world' }, shape, ...(tint !== undefined ? { state: { tint } } : {}) });
        this.sent.set(eid, key);
        continue;
      }
      const lib = own || old || isBody(n) ? undefined : placedDef(n.kind);
      const d = own ?? (lib ? { def: lib, model: null } : old ? undefined : this.shapes.get(n.kind));
      if (!d && !old) continue;
      const to = placedOf(this.nodes, id);
      if (!to) continue;
      const ref = d ? d.def.ref : old!, key = JSON.stringify([ref, to.p.map((v) => Math.round(v * 1000)), [to.yaw, ...(to.tilt ?? [])].map((v) => Math.round(v * 1000)), tint ?? null]);
      live.add(eid);
      if (this.sent.get(eid) === key && m.entities.has(eid) && !(d && need(d.def))) continue;
      if (d && need(d.def)) defs.push(d.def);
      // K5: a part carried laid flat is drawn so (the layer's `r: [yaw, x, z]`), and stood up again once set down so
      const r = turnOf(to, this.tilted.has(eid));
      if (to.tilt) this.tilted.add(eid); else this.tilted.delete(eid);
      upserts.push({ id: eid, def: ref, in: { parent: 'world' }, p: [...to.p], r, ...(tint !== undefined ? { state: { tint } } : {}) });
      this.sent.set(eid, key);
    }
    // sent again with each diff until the layer has dropped it (a diff it did not apply loses nothing)
    for (const o of this.gone) { if (m.entities.has(o)) removes.push(o); else this.gone.delete(o); }
    for (const eid of [...this.sent.keys()]) {
      if (live.has(eid)) continue;
      this.sent.delete(eid);
      if (m.entities.has(eid)) removes.push(eid);
    }
    if (!upserts.length && !removes.length) return null;
    return { type: 'edge', kind: 'world-diff', seq: Math.max(seq, after ?? seq) + 1, at, by: 'engine', diff: { upserts, removes, defs, tiles: [] } };
  }
}
