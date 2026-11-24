// Engine v2 N1 (#2649): Eden 2026's built content as one file of world-frame facts, for the loader in ../src.
//
// Replays the committed template through today's three content packages (imported by relative path, never the
// server): the world state, then each batch through `applyBatch` on a `WorldModel` over `coreLibrary()`, as
// `applyGenesis` does (with its `correctKitDefines` step and trusted adoption). Then writes, in whole millimetres and
// millidegrees: every placed thing with its pose relative to its tree parent, its bake (rooms, floors, solids, openings
// with windows, stairs, slots), the doors paired with their doorways, the ground (recipe, 1 m heights and classes),
// each water, and the named places derived by the rules in apps/server/src/god/places.ts (read, not imported).
//
//   node v2/tools/import-eden/export/export.ts [--seed <s>] [--out <file>] [--template <file>] [--map <map.json>]
//   (from the repository root)
//
// `--template` replays another committed world template (worlds/templates/*.json) the same way; Eden 2026 by default.
// `--map` names each thing's Soul Actions entry from that world's map (content/worlds/<world>/map.json).
//
// The output is generated: it goes under the ignored .local/ and is never committed.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WorldModel, applyBatch, coreLibrary, correctKitDefines, type Entity } from '../../../../packages/world-compiler/src/index.ts';
import { TileSampler, mediaTile, tileOf } from '../../../../packages/ground/src/index.ts';

type V2 = [number, number];
type Pose = { x: number; y: number; z: number; yaw: number };

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : d; };
// The catalog this is compared with (.local/import-eden/catalog.ts) boots its world with this seed, so ids match.
const SEED = arg('--seed', 'eden-local-lifecycle:genesis');
const OUT = arg('--out', '.local/import-eden/eden-2026.facts.json');
const TEMPLATE = arg('--template', 'worlds/templates/eden-2026.json');

const mm = (m: number) => Math.round(m * 1000);
const mdeg = (rad: number) => { let d = Math.round((rad * 180_000) / Math.PI) % 360_000; if (d < 0) d += 360_000; return d; };
const pt = ([x, z]: V2) => [mm(x), mm(z)];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// --- Replay --------------------------------------------------------------------------------------------------------
// X6 (#2819): `--backup <file> [--world <id>] [--map <map.json>]` takes a live world's model from a backup of its
// database (v2/tools/import-world/export/backup.ts) in place of the template's replay.
const BACKUP = arg('--backup', '');
const backup = await import('../../import-world/export/backup.ts');
// `--assets <dir>`: the world's asset store, where its footprint uploads' physics are kept (backup.ts).
const live = BACKUP ? backup.fromBackup(BACKUP, arg('--world', ''), arg('--map', 'content/worlds/eden/map.json'), arg('--assets', '')) : null;
const text = live ? '' : readFileSync(TEMPLATE, 'utf8');
const g = live ? { batches: [] } : JSON.parse(text);
const t0 = performance.now();
// A template's mesh things name core assets by hash (the Mars campus does); resolve them as the server does.
const core = live ? {} : backup.coreAssets();
const m = live?.m ?? new WorldModel({ constants: { ground: 'land', extent: 1000, ...g.constants }, seed: SEED, assets: (sha) => core[sha] });
if (!live) m.library = coreLibrary();
// A template's things name their Soul Actions entries from a world map (`--map`, `souls-world-map/1`: one row per kind
// and revision, `def` and `entry`), as a backup's do (X6); a kind with no row names none and keeps its own name.
const MAP = live ? '' : arg('--map', '');
const entryOf = MAP ? backup.entryMap(MAP) : null;
let tick = 1;
const apply = (batch: unknown, what: string) => { const r = applyBatch(m, batch, 'genesis', tick++, { trusted: true }); if (!r.result.accepted) throw new Error(`${what} refused: ${JSON.stringify(r.result).slice(0, 600)}`); };
if (g.state) apply({ ops: [{ op: 'world', state: g.state }], group: 'genesis' }, 'state');
for (const [i, b] of g.batches.entries()) apply(correctKitDefines({ ops: b.ops, group: b.group ?? 'genesis' }).batch, `batch ${i + 1}`);
const replayMs = Math.round(performance.now() - t0);

// --- Kinds ---------------------------------------------------------------------------------------------------------
/** T3's plain `namespace:name` for today's def name: core-door -> core:door, an authored eden-cafe -> eden:eden_cafe. */
function kindName(defName: string): string {
  let ns = 'eden', n = defName;
  const slash = n.indexOf('/');
  if (slash > 0) { ns = n.slice(0, slash); n = n.slice(slash + 1); }
  else if (n.startsWith('core-')) { ns = 'core'; n = n.slice(5); }
  ns = ns.toLowerCase().replace(/[^a-z0-9-]/g, '-'); n = n.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z]/.test(ns)) ns = 'k' + ns; if (!/^[a-z]/.test(n)) n = 'k' + n;
  return `${ns}:${n}`;
}
const isDoorDef = (d: { components: Record<string, unknown>; form: string; name: string; tags: string[] }) =>
  !!d.components.opening && d.form === 'point' && !/window|hatch/.test(d.name) && !d.tags.some((t) => t === 'window' || t === 'hatch');
const WATER_KINDS = /^core-(lake|river|pond)$/;

const kinds = new Map<string, { ref: string; hash: string; name: string; form: string; layer: string | null; door: boolean; mesh: boolean; slots: number }>();
/** The defs the world defines itself (a template's `define`): no page carries them, so the first thing of each carries
 *  its whole def (`def_body`, the tree's field 102), as JSON text. */
const CORE = coreLibrary(), carried = new Set<string>();
const defBody = (d: { ref: string }) => (CORE.get(d.ref) || carried.has(d.ref) ? undefined : (carried.add(d.ref), JSON.stringify(d)));
const defOf = (e: Entity) => { const d = m.resolvedDef(e.def); if (!d) throw new Error(`${e.id}: def ${e.def} unresolved`); return d; };
const bakeOf = (e: Entity) => m.bake(defOf(e), e.params ?? {}, e.seed ?? 0, e.shape);

// --- World poses ---------------------------------------------------------------------------------------------------
const world = new Map<string, Pose>();
const scale = new Map<string, number>();
for (const e of m.entities.values()) { const w = m.worldPose(e); world.set(e.id, { x: w.x, y: w.y, z: w.z, yaw: w.yaw }); scale.set(e.id, w.s); }
/** `p` in a frame at `f`, as that frame's local coordinates. */
const toLocal = (f: Pose, p: Pose): Pose => {
  const dx = p.x - f.x, dz = p.z - f.z, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  // worldPose turns local (x, z) to (x c + z s, -x s + z c); this is its inverse.
  return { x: dx * c - dz * s, y: p.y - f.y, z: dx * s + dz * c, yaw: p.yaw - f.yaw };
};
const compose = (f: Pose, l: Pose): Pose => {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return { x: f.x + l.x * c + l.z * s, y: f.y + l.y, z: f.z - l.x * s + l.z * c, yaw: f.yaw + l.yaw };
};
const ORIGIN: Pose = { x: 0, y: 0, z: 0, yaw: 0 };
const out = (p: Pose) => [mm(p.x), mm(p.y), mm(p.z), mdeg(p.yaw)];

// --- Things and their bakes ----------------------------------------------------------------------------------------
type Opening = { id: string; kind: string; at: V2; yaw: number; width: number; height: number; sill?: number; level: number; from?: string; to?: string; exterior?: boolean; state?: string };
const things: unknown[] = [];
/** Every door, gate and arch opening, in the world frame, for pairing door things with their doorways. */
const doorways: { thing: string; opening: string; x: number; z: number; y: number; width: number }[] = [];
const doorThings: { id: string; x: number; y: number; z: number }[] = [];
for (const e of m.entities.values()) {
  const d = defOf(e), b = bakeOf(e), s = scale.get(e.id)!, wp = world.get(e.id)!;
  const ref = d.ref;
  if (!kinds.has(ref)) kinds.set(ref, { ref, hash: d.hash, name: kindName(d.name), form: d.form, layer: (d as { layer?: string }).layer ?? null, door: isDoorDef(d as never), mesh: d.make.kind === 'mesh', slots: d.slots.length });
  // Its tree parent: the room it sits in (a room slot), else its parent thing (with the slot, if any), else the ground.
  const parent = e.in.parent === 'world' ? null : e.in.parent;
  const pe = parent ? m.entities.get(parent)! : undefined;
  const pslot = pe && e.in.slot ? m.slotsOf(pe).findIndex((x) => x.id === e.in.slot) : -1;
  const slotRec = pe && pslot >= 0 ? m.slotsOf(pe)[pslot] : undefined;
  let frame: Pose = ORIGIN;
  if (pe) {
    frame = world.get(pe.id)!;
    // a room slot is a node (the room); its frame is the slot's origin and yaw in the parent's frame
    if (slotRec?.kind === 'room') frame = compose(frame, { x: slotRec.p[0] * scale.get(pe.id)!, y: slotRec.p[1] * scale.get(pe.id)!, z: slotRec.p[2] * scale.get(pe.id)!, yaw: slotRec.yaw });
  }
  const rel = toLocal(frame, wp);
  const S = (v: number) => mm(v * s);
  const P = ([x, z]: V2) => [S(x), S(z)];
  const isWorldShape = d.form !== 'point' && e.in.parent === 'world';
  const rec: Record<string, unknown> = {
    id: e.id, def: e.def, ref, parent, pose: out(rel), world: out(wp), scale_ppm: Math.round(s * 1e6),
    ...(slotRec ? { slot: slotRec.kind === 'room' ? { room: slotRec.id } : { n: pslot + 1, id: slotRec.id } } : e.in.slot ? { slot: { missing: e.in.slot } } : {}),
    ...(e.name ? { name: e.name } : {}),
    // A path or area thing at the world root carries world-frame geometry, heights above the ground unless `abs`.
    ...(isWorldShape ? { worldShape: true } : {}),
    ...live?.thing(e, d),
    ...(entryOf?.(ref) ? { entry: entryOf(ref) } : {}),
    // W3 (0.135): its def's params as today's model holds them, as JSON text (the facts reader takes whole numbers only),
    // which the tree keeps as field 19 so a page drawing from the stream alone draws it as today's page does
    ...(e.params && Object.keys(e.params).length ? { params: JSON.stringify(e.params) } : {}),
    ...((body) => (body ? { def_body: body } : {}))(defBody(d)),
  };
  if (isDoorDef(d as never)) {
    const v = e.state?.open ?? (d.state as Record<string, { default?: unknown } | undefined>)?.open?.default;
    rec.door = { open: v !== false };
    doorThings.push({ id: e.id, x: wp.x, y: wp.y, z: wp.z });
  }
  if (e.shape) rec.shape = { ...(e.shape.path ? { path: e.shape.path.map(pt) } : {}), ...(e.shape.area ? { area: e.shape.area.map(pt) } : {}), ...(e.shape.width !== undefined ? { width: mm(e.shape.width) } : {}) };
  const geo = isWorldShape ? ((v: number) => mm(v)) : S, G = isWorldShape ? pt : P;
  // Only a solid or surface thing's colliders block, as today's engine bridge takes them (engine-bridge.ts): scenery
  // (decor) is walked through, so a decor mesh's bounds (verdelis-eden's dome glass) never fill the ground under it.
  const layer = (d as { layer?: string }).layer;
  if (b.colliders.length && (layer === 'solid' || layer === 'surface')) rec.solids =b.colliders.map((o) => [...G(o.c), geo(o.half[0]), geo(o.half[1]), mdeg(o.yaw), geo(o.y0), geo(o.y1), tagCode(o.tag), (o as { abs?: boolean }).abs ? 1 : 0]);
  if (b.surfaces?.length) rec.floors = b.surfaces.map((f) => ({ level: f.level, y: geo(f.y), polygon: f.polygon.map(G), ...(f.tag ? { tag: f.tag } : {}), ...(f.abs ? { abs: true } : {}) }));
  if (b.rooms?.length) rec.rooms = b.rooms.map((r) => {
    const sl = b.slots.find((x) => x.kind === 'room' && x.id === r.id);
    const rp: Pose = sl ? { x: sl.p[0], y: sl.p[1], z: sl.p[2], yaw: sl.yaw } : { x: r.origin[0], y: r.y, z: r.origin[1], yaw: r.yaw };
    const scaled: Pose = { x: rp.x * s, y: rp.y * s, z: rp.z * s, yaw: rp.yaw };
    const inRoom = (p: V2) => { const l = toLocal(scaled, { x: p[0] * s, y: 0, z: p[1] * s, yaw: 0 }); return [mm(l.x), mm(l.z)]; };
    return { id: r.id, name: r.name, floor: r.floor, pose: out(scaled), height: S(r.height), polygon: r.polygon.map(inRoom) };
  });
  if (b.openings?.length) rec.openings = (b.openings as Opening[]).map((o) => {
    // A window names no room, nor does a door a model's author placed in a mesh building's wall (the Mars campus's):
    // the room it opens from is the one on its floor whose wall it sits in (nearest edge); the door leads outside.
    const from = o.from ?? (o.kind === 'window' || !o.to ? wallRoom(b.rooms ?? [], o) : undefined);
    const room = from && b.rooms?.find((r) => r.id === from);
    let at: number[] | undefined;
    if (room) {
      const sl = b.slots.find((x) => x.kind === 'room' && x.id === room.id);
      const rp: Pose = sl ? { x: sl.p[0] * s, y: sl.p[1] * s, z: sl.p[2] * s, yaw: sl.yaw } : { x: room.origin[0] * s, y: room.y * s, z: room.origin[1] * s, yaw: room.yaw };
      at = out(toLocal(rp, { x: o.at[0] * s, y: rp.y, z: o.at[1] * s, yaw: o.yaw }));
    }
    if (o.kind !== 'window') {
      const w = compose(wp, { x: o.at[0] * s, y: 0, z: o.at[1] * s, yaw: 0 });
      doorways.push({ thing: e.id, opening: o.id, x: w.x, z: w.z, y: wp.y + (room ? room.y * s : 0), width: o.width * s });
    }
    return { id: o.id, kind: o.kind, at: P(o.at), yaw: mdeg(o.yaw), width: S(o.width), height: S(o.height), ...(o.sill !== undefined ? { sill: S(o.sill) } : {}), level: o.level,
      ...(from ? { from } : {}), ...(from && !o.from ? { fromWall: true } : {}), ...(o.to ? { to: o.to } : {}), ...(o.exterior !== undefined ? { exterior: o.exterior } : {}), ...(o.state ? { state: o.state } : {}), ...(at ? { inRoom: at } : {}) };
  });
  if (b.links?.length) rec.stairs = b.links.map((l) => ({ id: l.id, kind: l.kind, from: l.from, to: l.to, path: l.path.map(P), width: S(l.width), y0: S(l.y0), y1: S(l.y1) }));
  const slots = b.slots.filter((x) => x.kind !== 'room');
  if (slots.length) rec.slots = b.slots.flatMap((x, i) => x.kind === 'room' ? [] : [{ n: i + 1, id: x.id, kind: x.kind, at: [S(x.p[0]), S(x.p[1]), S(x.p[2])], yaw: mdeg(x.yaw), ...(x.capacity !== undefined ? { capacity: x.capacity } : {}) }]);
  if (b.water && WATER_KINDS.test(d.name)) rec.water = { level: mm(b.water.level), ...(b.water.area ? { area: b.water.area.map(pt) } : {}), ...(b.water.path ? { path: b.water.path.map(pt), width: mm(b.water.width ?? 0) } : {}), ...(b.water.levels ? { levels: b.water.levels.map(mm) } : {}) };
  things.push(rec);
}
/** The room on the opening's floor with the wall edge nearest its centre (def frame), or undefined if none is within 0.5 m. */
function wallRoom(rooms: { id: string; floor: number; polygon: V2[] }[], o: Opening): string | undefined {
  let best: string | undefined, bestD = 0.5;
  for (const r of rooms) {
    if (r.floor !== o.level) continue;
    r.polygon.forEach((a, i) => {
      const b = r.polygon[(i + 1) % r.polygon.length]!, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((o.at[0] - a[0]) * dx + (o.at[1] - a[1]) * dz) / L));
      const d = Math.hypot(o.at[0] - a[0] - t * dx, o.at[1] - a[1] - t * dz);
      if (d < bestD) { bestD = d; best = r.id; }
    });
  }
  return best;
}
function tagCode(tag?: string): number { if (!tag) return 0; if (tag.startsWith('wall')) return 1; if (tag.startsWith('stairs')) return 2; if (tag === 'rail') return 3; if (tag === 'post') return 4; return 5; }

// --- Doors in their doorways (god/doors.ts doorInGap: within max(0.6 m, half the width), here also on its floor) -----
const doorPairs: { door: string; thing?: string; opening?: string; reason?: string }[] = [];
const taken = new Set<string>();
for (const dt of doorThings) {
  let best: (typeof doorways)[number] | undefined, bestD = Infinity;
  for (const w of doorways) {
    const dd = Math.hypot(w.x - dt.x, w.z - dt.z);
    if (dd <= Math.max(0.6, w.width / 2) && Math.abs(w.y - dt.y) < 1.5 && dd < bestD && w.thing !== dt.id) { best = w; bestD = dd; }
  }
  if (best && !taken.has(best.thing + '/' + best.opening)) { taken.add(best.thing + '/' + best.opening); doorPairs.push({ door: dt.id, thing: best.thing, opening: best.opening }); }
  else if (best) doorPairs.push({ door: dt.id, reason: `its doorway ${best.thing}/${best.opening} already holds a door` });
  else {
    const own = (things.find((t) => (t as { id: string }).id === dt.id) as { openings?: { kind: string }[] }).openings?.some((o) => o.kind !== 'window');
    doorPairs.push({ door: dt.id, ...(own ? { thing: dt.id, opening: 'own' } : { reason: 'stands in no doorway (a free-standing door in its own frame)' }) });
  }
}

// --- The ground ----------------------------------------------------------------------------------------------------
const ground = m.ground();
const sampler = new TileSampler(m.terrain);
const [ex0, ez0, ex1, ez1] = ground.extent;
const [ta, tb] = tileOf(ex0, ez0), [tc, td] = tileOf(ex1 - 1e-6, ez1 - 1e-6);
const tiles: { tx: number; tz: number; heights: string; classes: string }[] = [];
for (let tz = tb; tz <= td; tz++) for (let tx = ta; tx <= tc; tx++) {
  const h = m.terrain.tile(tx, tz), hi = new Int32Array(h.length);
  for (let i = 0; i < h.length; i++) hi[i] = mm(h[i]!);
  tiles.push({ tx, tz, heights: Buffer.from(hi.buffer).toString('base64'), classes: Buffer.from(mediaTile(sampler, tx, tz)).toString('base64') });
}

// --- Named places that are not rooms (the rules of apps/server/src/god/places.ts) -----------------------------------
const SHORE = 3, LANDMARK_MIN = 1.5;
const NOT_LANDMARKS = /^(sign|signpost|notice-board|lamp-post|lantern|flagpole|bollard|bin|wheelie-bin|mailbox|hydrant|crate|barrel|sack|flower-pot|poster|banner|picture-frame|screen|chalkboard|power-line|poster-wall|wanted-board)$/;
const shortDef = (n: string) => n.replace(/^core-/, '').replace(/^ew-/, '').replace(/-pack$/, '');
const centroid = (p: V2[]): V2 => [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length];
const grow = (poly: V2[], d: number): V2[] => { const [cx, cz] = centroid(poly); return poly.map(([x, z]) => { const dx = x - cx, dz = z - cz, n = Math.hypot(dx, dz) || 1; return [x + (dx / n) * d, z + (dz / n) * d] as V2; }); };
const circle = (c: V2, r: number, n = 12): V2[] => Array.from({ length: n }, (_, i) => [c[0] + Math.cos((i / n) * Math.PI * 2) * r, c[1] + Math.sin((i / n) * Math.PI * 2) * r] as V2);
const inPoly = (x: number, z: number, poly: V2[]) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const nearLine = (x: number, z: number, path: V2[], half: number) => path.some((a, i) => { const b = path[i + 1]; if (!b) return Math.hypot(x - a[0], z - a[1]) <= half; const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)); return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) <= half; });

type Place = { id: string; of: string; kind: string; entity: string; name: string; polygon?: V2[]; line?: V2[]; width?: number; level?: number };
const places: Place[] = [];
const label = (e: Entity, d: { name: string }) => e.name ?? `${shortDef(d.name)} ${e.id}`;
for (const e of m.entities.values()) {
  if (e.in.parent !== 'world') continue;
  const d = defOf(e), b = bakeOf(e), name = label(e, d), short = shortDef(d.name), wp = world.get(e.id)!;
  if (b.water && WATER_KINDS.test(d.name)) {
    const w = b.water;
    if (w.area?.length) { places.push({ id: `${e.id}.water`, of: 'water', kind: short, entity: e.id, name, polygon: w.area, level: mm(w.level) }); places.push({ id: `${e.id}.shore`, of: 'shore', kind: 'shore', entity: e.id, name: `${name} shore`, polygon: grow(w.area, SHORE) }); }
    else if (w.path?.length) { places.push({ id: `${e.id}.water`, of: 'water', kind: short, entity: e.id, name, line: w.path, width: w.width ?? 0, level: mm(w.level) }); places.push({ id: `${e.id}.shore`, of: 'shore', kind: 'shore', entity: e.id, name: `${name} shore`, line: w.path, width: (w.width ?? 0) + 2 * SHORE }); }
    continue;
  }
  const lf = b.landform as { kind?: string; r?: number; w?: number } | undefined;
  if (/^(hill|mountain)$/.test(short) && lf) {
    if (lf.kind === 'bump') places.push({ id: `${e.id}.landform`, of: 'landform', kind: short, entity: e.id, name, polygon: circle([wp.x, wp.z], Math.max(6, Number(lf.r ?? 20) * scale.get(e.id)! * 0.5)) });
    else if (e.shape?.path?.length) places.push({ id: `${e.id}.landform`, of: 'landform', kind: short, entity: e.id, name, line: e.shape.path, width: Math.max(4, Number(lf.w ?? e.shape.width ?? 10)) });
    else if (e.shape?.area?.length) places.push({ id: `${e.id}.landform`, of: 'landform', kind: short, entity: e.id, name, polygon: e.shape.area });
    continue;
  }
  if (/^(pier|footpath|bridge)$/.test(short) || /pier|bridge/.test(short)) {
    const path = e.shape?.path;
    if (path?.length) { places.push({ id: `${e.id}.${short}`, of: 'line', kind: short, entity: e.id, name, line: path, width: e.shape?.width ?? 2 }); continue; }
    if (/pier|bridge/.test(short)) { const bx = b.box, c = Math.cos(wp.yaw), s = Math.sin(wp.yaw), ss = scale.get(e.id)!, hw = bx[0] / 2, hd = bx[2] / 2;
      places.push({ id: `${e.id}.${short}`, of: 'outline', kind: short, entity: e.id, name, polygon: ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as V2[]).map(([x, z]) => [wp.x + (x * c + z * s) * ss, wp.z + (-x * s + z * c) * ss] as V2) }); continue; }
  }
  if (d.form === 'area' && e.shape?.area && e.shape.area.length >= 3) {
    const pk = (d.components as Record<string, { kind?: string } | undefined>).place?.kind;
    places.push({ id: `${e.id}.area`, of: 'area', kind: typeof pk === 'string' && pk ? pk : (lf ? short : 'outdoor'), entity: e.id, name, polygon: e.shape.area });
  }
}
// landmarks: a named point thing at least 1.5 m wide standing on its own (not in another named place), no furniture
const outer = places.slice();
for (const e of m.entities.values()) {
  if (e.in.parent !== 'world' || !e.name) continue;
  const d = defOf(e); if (d.form !== 'point' || d.tags.includes('local-fixture') || NOT_LANDMARKS.test(shortDef(d.name))) continue;
  const c = d.components as Record<string, unknown>; if (c.carryable || c.seat || c.item || c.opening) continue;
  const b = bakeOf(e); if (b.rooms?.length) continue;   // a building is a place of rooms, not a landmark
  const wp = world.get(e.id)!, w = Math.max(b.box[0], b.box[2]) * scale.get(e.id)!;
  if (w < LANDMARK_MIN) continue;
  if (outer.some((p) => p.polygon ? inPoly(wp.x, wp.z, p.polygon) : nearLine(wp.x, wp.z, p.line!, (p.width ?? 0) / 2))) continue;
  places.push({ id: `${e.id}.landmark`, of: 'landmark', kind: 'landmark', entity: e.id, name: e.name, polygon: circle([wp.x, wp.z], Math.max(4, w / 2 + 3)) });
}

// --- The replayed model's own counts, in a pass of their own over the model (not over what was written above) -------
const bake: Record<string, number> = {}, byRef: Record<string, number> = {};
const add = (k: string, n = 1) => { bake[k] = (bake[k] ?? 0) + n; };
for (const e of m.entities.values()) {
  const d = m.resolvedDef(e.def)!, b = m.bake(d, e.params ?? {}, e.seed ?? 0, e.shape);
  // keyed by the def as the thing names it (its facts' `def`, the tree's def field): an old spelling (`core/humanoid@1` for
  // `core-humanoid@1`) is counted under the same name on both sides (W2b, 0.133)
  add('things'); byRef[e.def] = (byRef[e.def] ?? 0) + 1;
  if (isDoorDef(d as never)) add('doors');
  add('rooms', b.rooms?.length ?? 0);
  add('floors', new Set([...(b.rooms ?? []).map((r) => r.floor), ...(b.surfaces ?? []).map((s) => s.level), ...(b.links ?? []).flatMap((l) => [l.from, l.to])]).size);
  add('floor surfaces', b.surfaces?.length ?? 0);
  // what blocks, as the things' records write it: a decor thing's colliders are none
  const layer = (d as { layer?: string }).layer;
  add('solids', layer === 'solid' || layer === 'surface' ? b.colliders.length : 0);
  add('slots', b.slots.filter((x) => x.kind !== 'room').length);
  for (const o of b.openings ?? []) add(o.kind === 'window' ? 'windows' : 'doorways');
  for (const l of b.links ?? []) add(`stairs:${l.kind}`);
}

// --- Sky (V19c, #3521) ---------------------------------------------------------------------------------------------
// How today's page draws this world's sky: the date it is drawn on (`state.time.calendar`), its palette
// (`state.sky.palette`), and today's morning mist (`atmosphere/weather.ts` `morningMist`: peaking at 06:30, gone 2.5 h
// either side, at full strength), which today's page draws on every world but the desert palette's.
const ws = m.state as { time?: { calendar?: unknown }; sky?: { palette?: unknown } };
const palette = typeof ws.sky?.palette === 'string' ? ws.sky.palette : null;
const sky = {
  ...(typeof ws.time?.calendar === 'string' ? { calendar: ws.time.calendar } : {}),
  ...(palette ? { palette } : {}),
  ...(palette === 'mars-desert' ? {} : { mist: [390, 150, 100] }),
};

// --- Write ---------------------------------------------------------------------------------------------------------
const file = {
  format: 'souls/import-eden/1',
  ...(live ? live.head : { template: { path: TEMPLATE, sha256: sha(text), batches: g.batches.length } }),
  seed: live ? m.seed : SEED, entities: m.entities.size, bake, byRef, sky,
  kinds: [...kinds.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
  things, doors: doorPairs,
  // The recipe is today's own format (metres, fractions): kept whole as text for N3, never read here as numbers.
  ground: { recipe: JSON.stringify(ground), recipeSha256: sha(JSON.stringify(ground)), tileM: 64, tiles },
  places: places.map((p) => ({ ...p, ...(p.polygon ? { polygon: p.polygon.map(pt) } : {}), ...(p.line ? { line: p.line.map(pt), width: mm(p.width ?? 0) } : {}) })),
};
mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(file);
writeFileSync(OUT, json);
console.log(JSON.stringify({ out: OUT, bytes: json.length, sha256: sha(json), replayMs, entities: m.entities.size, kinds: kinds.size, doors: doorPairs.length, doorsPaired: doorPairs.filter((p) => p.thing).length, places: places.length, tiles: tiles.length }));
