// W2 (0.135): the old page's first picture of a world from the new engine's stream alone, for a world with no old twin
// (one made on the new engine, W1), or any v2 world opened with `?scene=stream`. The entity layer (WorldEntityLayer)
// draws a world from a snapshot: its ground recipe, its defs and its entities. This builds that snapshot from the
// stream's nodes, as import-eden wrote them:
//
// - the ground: the open ground's terrain tiles (fields 24, 25: heights in mm), drawn as the stream has them; the
//   terrain keeps them instead of baking its recipe (`fixTerrain`);
// - water: each thing with a water level (field 18) and an outline (11) or a line (16, 17) is one of the recipe's waters;
// - things, buildings, paths and areas: every node that is an imported thing (its `origin`, today's id, with no `/` or
//   `.`: a building's floors, rooms and windows and a place derived from a thing are drawn by the thing), at its world
//   pose, with its shape (an area's outline, a path's line and width) and the def it was imported from (field 2) out of
//   the core library the page already carries (`coreLibrary`), or, for a def the world defines itself, the def the open
//   ground keeps (field 102), with its def's params (field 19, W3); from a world imported before W3, a building's size
//   and storeys from its floors' surfaces. A thing on a course no def draws (a punt) is the takes' (takes.ts).
//
// What the stream does not carry is drawn plain and named in `plain` (the hatch): a def the library does not have is
// drawn from the thing's own solids (field 12) as boxes; from a world imported before W3, a def's other params (colours,
// roof, a door's size) are the def's defaults. Things a creator places later are not here: creator-kinds.ts sends them as the stream shows them.
// The snapshot reaches the layer through scene-offer.ts.
import { coreLibrary, defSchema, type Entity, type StoredDef } from '@souls/world-compiler';
import { TILE_M, TILE_N, tileKey, type Ground } from '@souls/ground';
import { placedOf } from '../world-state.ts';
import { kindDef } from '../creator-kinds.ts';
import type { NodeRec } from './source.ts';
import { offerScene } from './scene-offer.ts';

type Lib = { get(key: string): StoredDef | undefined; all(): readonly StoredDef[] };
/** The snapshot the entity layer draws (WorldEntityLayer's EntitySnapshot), and the terrain's heights by tile. */
export type StreamSnapshot = { contract: 'world/1'; worldId: string; seq: number; counter: number; seed: string; constants: { extent: number; ground: 'land'; base: number };
  state: Record<string, unknown>; ground: Ground; defs: StoredDef[]; entities: Entity[]; tiles: Record<string, string>; heights: Map<string, Float32Array>; plain: string[] };

const plainKind = (k: string) => k.split('@')[0];
/** Nodes the page draws as part of a thing, or as no thing at all: the world, the ground, a building's parts, places. */
const NOT_THINGS = new Set(['world', 'ground', 'floor', 'room', 'window', 'place']);
const isBody = (n: NodeRec) => !!n.soul || /:(humanoid|body)$/.test(plainKind(n.kind));
const m = (v: number) => Math.round(v) / 1000;

/** Each library's newest def by name. */
const newest = new WeakMap<Lib, Map<string, StoredDef>>();
/** The library def a kind draws by: its imported def ref when the library has it, else the newest def named like the
 *  kind (import-eden's `core-x` is `eden:x`: `eden:rowing_punt` -> `core-rowing-punt`), else undefined. */
export function libraryDef(kind: string, ref?: string, lib: Lib = coreLibrary()): StoredDef | undefined {
  const byRef = ref ? lib.get(ref) : undefined;
  if (byRef) return byRef;
  let ix = newest.get(lib);
  if (!ix) {
    ix = new Map();
    for (const d of lib.all()) { const was = ix.get(d.name); if (!was || d.version > was.version) ix.set(d.name, d); }
    newest.set(lib, ix);
  }
  const name = (plainKind(kind).split(':').pop() ?? '').replace(/_/g, '-');
  return ix.get(`core-${name}`) ?? ix.get(name);
}

/** The defs the world defines itself (a template's `define`, which no page's library has), as the stream carries them:
 *  once each, on the open ground (import-eden's field 102, `NodeRec.defBodies`), so removing a thing of one never loses
 *  it; by the ref it is kept under and by its own `name@version` (a thing may name it either way). A body that is not a
 *  def is left out. */
export function worldDefs(nodes: readonly NodeRec[]): Map<string, StoredDef> {
  const out = new Map<string, StoredDef>();
  for (const n of nodes) {
    for (const [ref, body] of n.defBodies ?? []) {
      try {
        const d = JSON.parse(body) as Partial<StoredDef>, def = defSchema.parse(d);
        if (typeof d.hash !== 'string') continue;
        const stored: StoredDef = { ...def, ref: typeof d.ref === 'string' ? d.ref : ref, hash: d.hash, by: typeof d.by === 'string' ? d.by : 'v2', born: 0 };
        out.set(ref, stored);
        out.set(`${def.name}@${def.version}`, stored);
      } catch { /* drawn from its solids */ }
    }
  }
  return out;
}

/** The library def a thing placed while the world runs draws by (creator-kinds.ts): a point thing's, or, given the
 *  node's shape (a creator's `place --path | --area`: its line, field 16, or its outline, field 11), a path's or an
 *  area's; none for a building's parts, places or the engine's own kinds. */
export function placedDef(kind: string, shape?: { line?: number[][]; outline?: number[][] }): StoredDef | undefined {
  if (kind.startsWith('souls:') || NOT_THINGS.has(plainKind(kind).split(':').pop() ?? '')) return undefined;
  const d = libraryDef(kind);
  if (d?.form === 'point') return d;
  if (d?.form === 'path' && (shape?.line?.length ?? 0) >= 2) return d;
  if (d?.form === 'area' && (shape?.outline?.length ?? 0) >= 3) return d;
  return undefined;
}

/** A shaped thing's shape as the layer's entity holds it (metres, world: a path's line and width, an area's outline),
 *  or null for a point def or a node without its shape. */
export function shapeOf(def: StoredDef, n: { line?: number[][]; lineWidth?: number; outline?: number[][] }): Entity['shape'] | null {
  if (def.form === 'area' && n.outline && n.outline.length >= 3) return { area: n.outline.map(([x, z]) => [m(x), m(z)] as [number, number]) };
  if (def.form === 'path' && n.line && n.line.length >= 2) return { path: n.line.map(([x, z]) => [m(x), m(z)] as [number, number]), ...(n.lineWidth ? { width: m(n.lineWidth) } : {}) };
  return null;
}

/** The content kinds' entries as CarriedParts draws a part from its own shape (take-parts.ts): `souls-entry/1` with the
 *  kind's bounds (drawn as one box: the hatch), by plain kind name, for each kind no library def draws. `bounds`: each
 *  thing kind's `geometry.bounds_mm` (kind-bounds.ts, which the build fills). */
export function entryLooks(bounds: Record<string, number[]>): Map<string, Uint8Array> {
  const out = new UnlessLibrary(), enc = new TextEncoder();
  for (const [kind, b] of Object.entries(bounds)) out.set(kind, enc.encode(JSON.stringify({ format: 'souls-entry/1', kind, geometry: { bounds_mm: b } })));
  return out;
}
/** A map of entries that answers only for kinds the library does not draw (a library def looks like the thing). */
export class UnlessLibrary extends Map<string, Uint8Array> {
  get(kind: string): Uint8Array | undefined { return placedDef(kind) ? undefined : super.get(kind); }
}

/** A thing's own solids (`[cx, cz, hx, hz, yaw mdeg, y0, y1, …]` mm in its frame) as a plain def of boxes, or null. */
export function solidsDef(kind: string, solids: number[][] | undefined): StoredDef | null {
  if (!solids?.length || !/@[0-9a-f]+$/.test(kind)) return null;
  const parts = solids.map(([cx, cz, hx, hz, yaw, y0, y1]) => ({ kind: 'box', at: [cx, (y0 + y1) / 2, cz], size: [2 * hx, Math.max(10, y1 - y0), 2 * hz], yaw, color: '#b8a58a' }));
  const lo = solids.reduce((a, s) => [Math.min(a[0], s[0] - s[2]), Math.min(a[1], s[5]), Math.min(a[2], s[1] - s[3])], [Infinity, Infinity, Infinity]);
  const hi = solids.reduce((a, s) => [Math.max(a[0], s[0] + s[2]), Math.max(a[1], s[6]), Math.max(a[2], s[1] + s[3])], [-Infinity, -Infinity, -Infinity]);
  const entry = { format: 'souls-entry/1', geometry: { bounds_mm: [0, 1, 2].map((k) => Math.max(10, hi[k] - lo[k])), parts } };
  return kindDef(kind, new TextEncoder().encode(JSON.stringify(entry)))?.def ?? null;
}

/** A building's size and storeys from its floors' surfaces (the walls stand around the floor: today's building/1 puts the
 *  floor inside walls 0.22 m thick). */
function buildingParams(origin: string, nodes: readonly NodeRec[]): Record<string, number> | null {
  const floors = nodes.filter((n) => n.origin?.startsWith(`${origin}/floor-`) && n.surfaces?.length);
  if (!floors.length) return null;
  const pts = floors[0].surfaces!.flatMap(([, ring]) => ring);
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  return { w: m(Math.max(...xs) - Math.min(...xs) + 440), d: m(Math.max(...zs) - Math.min(...zs) + 440), floors: floors.length };
}

/** The open ground's heights by tile (`tx,tz` -> TILE_N² metres), when its tiles are the page's own size. */
export function tileHeights(ground: NodeRec | undefined): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!ground?.tiles || ground.tileSize !== TILE_M * 1000) return out;
  for (const [tx, tz, bytes] of ground.tiles) {
    if (bytes.byteLength !== TILE_N * TILE_N * 4) continue;
    const mm = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), h = new Float32Array(TILE_N * TILE_N);
    for (let i = 0; i < h.length; i++) h[i] = mm.getInt32(i * 4, true) / 1000;
    out.set(tileKey(tx, tz), h);
  }
  return out;
}

/** The snapshot of the world the stream's nodes hold. */
export function streamSnapshot(nodes: readonly NodeRec[], worldId: string, lib: Lib = coreLibrary()): StreamSnapshot {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ground = nodes.find((n) => plainKind(n.kind).endsWith(':ground') && n.tiles);
  const heights = tileHeights(ground);
  const keys = [...heights.keys()].map((k) => k.split(',').map(Number));
  // the world's extent: today's worlds are whole hundreds of metres, and their tiles cover them to the next tile edge
  const toward0 = (v: number) => Math.sign(v) * Math.floor(Math.abs(v) / 100) * 100;
  const covered = keys.length
    ? [Math.min(...keys.map((k) => k[0])) * TILE_M, Math.min(...keys.map((k) => k[1])) * TILE_M, (Math.max(...keys.map((k) => k[0])) + 1) * TILE_M, (Math.max(...keys.map((k) => k[1])) + 1) * TILE_M]
    : [-500, -500, 500, 500];
  const hundreds = covered.map(toward0);
  const ext = (hundreds[2] > hundreds[0] && hundreds[3] > hundreds[1] ? hundreds : covered) as [number, number, number, number];
  const defs = new Map<string, StoredDef>(), entities: Entity[] = [], waters: Ground['waters'] = [], plain = new Set<string>();
  const own = worldDefs(nodes);
  for (const n of nodes) {
    const o = n.origin;
    if (!o || o.includes('/') || o.includes('.') || isBody(n) || NOT_THINGS.has(plainKind(n.kind).split(':').pop() ?? '')) continue;
    if (!/^[eh]_[a-z0-9]{4,12}$/.test(o)) continue;
    // water: the recipe's, as the old world kept it (an area or a path, its level)
    if (n.waterLevel !== undefined && n.outline && n.outline.length >= 3) waters.push({ id: o, area: n.outline.map(([x, z]) => [m(x), m(z)] as [number, number]), level: m(n.waterLevel) });
    else if (n.waterLevel !== undefined && n.line && n.line.length >= 2) waters.push({ id: o, path: n.line.map(([x, z]) => [m(x), m(z)] as [number, number]), w: m(n.lineWidth ?? 4000), level: m(n.waterLevel) });
    let def = (n.def ? own.get(n.def) : undefined) ?? libraryDef(n.kind, n.def, lib) ?? null;
    // a thing on a course no library def draws (a punt) is drawn by the takes, where its course has it (takes.ts)
    if (!def && n.course) continue;
    if (!def) { def = solidsDef(n.kind, n.solids); plain.add(`${plainKind(n.kind)}: ${def ? 'its solids as boxes' : 'not drawn (no def, no solids)'}`); }
    if (!def) continue;
    defs.set(def.ref, def);
    const e: Entity = { id: o, def: def.ref, in: { parent: 'world' }, by: 'v2', born: 0, v: 1 };
    const shape = shapeOf(def, n);
    if (shape) e.shape = shape;
    else {
      const at = placedOf(byId, n.id);
      if (!at) continue; // in a hand: the bodies' adapter draws it
      e.p = at.p; e.r = at.yaw;
      if (n.scale && n.scale !== 1_000_000) e.s = n.scale / 1e6;
    }
    // its recorded params (W3) by the def it was imported from; else, from an older import, a building's size from its floors
    if (n.params && !def.name.startsWith('v2-')) e.params = n.params as Entity['params'];
    else if (def.make.kind === 'gen' && def.make.gen === 'building/1') { const bp = buildingParams(o, nodes); if (bp) e.params = bp; }
    entities.push(e);
  }
  if (entities.length && !nodes.some((n) => n.params)) plain.add("params this world's import does not carry (before W3: colours, roofs, a door's size): the def's defaults");
  return {
    contract: 'world/1', worldId, seq: 0, counter: 0, seed: `v2:${worldId}`, constants: { extent: Math.max(ext[2] - ext[0], ext[3] - ext[1]), ground: 'land', base: 0 },
    state: stateOf(nodes.find((n) => n.parent === null)), ground: { schema: 'ground/1', base: 0, extent: ext, landforms: [], waters } as Ground,
    defs: [...defs.values()], entities, tiles: {}, heights, plain: [...plain],
  };
}

/** The world's state as the old page reads it, from the world node's sky fields (`sky-record.ts` F): how its sky is
 *  drawn (89, the palette) and whether its clock keeps the real day's pace (60, a day of 86,400 world seconds). */
function stateOf(world: NodeRec | undefined): Record<string, unknown> {
  const f = { ...world?.fields, ...world?.sky } as Record<number, unknown>;
  const palette = typeof f[89] === 'string' ? (f[89] as string).split(':').pop()! : 'clear-day';
  return { sky: { palette }, ...(f[60] === undefined || Number(f[60]) === 86_400 ? { time: { clock: 'real' } } : {}) };
}

/** Keeps the stream's nodes as the reader shows them, and offers the snapshot once the open ground is there. */
export class SceneFromStream {
  private readonly nodes = new Map<string, NodeRec>();
  private done = false;
  private readonly worldId: string;
  constructor(worldId: string) { this.worldId = worldId; }
  receive(msg: { t: string; s?: { nodes: NodeRec[]; removed: string[] }; p?: { nodes: NodeRec[]; removed: string[] } }): void {
    const c = msg.t === 'snapshot' ? msg.s : msg.t === 'part' ? msg.p : undefined;
    if (!c || this.done) return;
    for (const id of c.removed) this.nodes.delete(id);
    for (const n of c.nodes) this.nodes.set(n.id, n);
    // the open ground, with its terrain tiles or none (flat ground: N2's test world)
    if (![...this.nodes.values()].some((n) => plainKind(n.kind).endsWith(':ground'))) return;
    this.done = true;
    const s = streamSnapshot([...this.nodes.values()], this.worldId);
    (globalThis as { __soulsStreamScene?: unknown }).__soulsStreamScene = { entities: s.entities.length, defs: s.defs.length, tiles: s.heights.size, waters: s.ground.waters.length, plain: s.plain };
    offerScene(s);
  }
  watch<W extends { addEventListener(type: 'message', fn: (e: MessageEvent) => void): void }>(w: W): W {
    w.addEventListener('message', (e: MessageEvent) => this.receive(e.data));
    return w;
  }
}
