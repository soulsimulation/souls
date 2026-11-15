// #2383 door-fit/1: every built-in doorway is a real door. A building on a core revision that draws its ground-floor
// doors as fixed leaves moves to its door-fitted revision (DOOR_FIT_FROM; same walls, rooms and slots, bare doorways),
// and a hand-operated core/door@2 is placed in each bare doorway (buildingDoorFits). Templates carry the result; a live
// world gets it once, as one recorded engine edit at boot (the last rule in adoptBootRuntimePoliciesV1).
//
// It refuses nothing and moves nobody: a door whose spot a body stands near is placed open, so nobody is pushed; a
// building with a resident's body inside its subtree (seated in it) is left as it is and fitted at a later boot; a
// building whose door the world refuses (a tower's stair crowding its doorway) keeps its old revision and drawn leaf for
// now, and is tried again at the next boot.
// A door that would open into another building's ground-floor room, or into a yard buildings close in all round (a second
// door in series) is not placed until a walk passes several closed doors in a row (#2370); its doorway stays an open gap.
import { buildingDoorFits, buildingGroundRooms } from '@souls/generators';
import { ALL_DOORS_FROM, DOOR_FIT_FROM, applyBatch, type Entity, type Op, type WorldModel } from '@souls/world-compiler';
import { actuatorPoint } from '../../../../mars/viewer/engine/social/hand-actuator.ts';
import { HUMAN_RADIUS } from '../../../../mars/viewer/engine/world/catalog.ts';
import type { EdgeSoul } from '../edge/contract.ts';
import { createContactActuatorService } from './contact-actuator.ts';
import type { GodMode } from './god.ts';

export const DOOR_FIT_DOOR = 'core/door@2';
/** A body this close (m) to a door's spot stands in its doorway: the door is placed open. */
const IN_DOORWAY = 1.0;
/** How far (m) in front of a door its outside is probed for another building's room. */
const SERIES_PROBE = 0.6;

type Vec2 = [number, number];
type PlaceOp = Extract<Op, { op: 'place' }>;
const xz = (p: unknown): Vec2 => { const a = Array.isArray(p) ? p as number[] : [0, 0]; return a.length > 2 ? [a[0]!, a[2]!] : [a[0] ?? 0, a[1] ?? 0]; };
/** A model stores a core ref as `core-cottage@1`; ops and templates write `core/cottage@1`. */
const opRef = (def: string) => def.replace(/^core-/, 'core/'), storedRef = (ref: string) => ref.replace(/^core\//, 'core-');
export const doorFitted = (def: string): boolean => DOOR_FIT_FROM.has(opRef(def));
const yaw = (r: unknown): number => Array.isArray(r) ? Number(r[1] ?? 0) : typeof r === 'number' ? r : 0;

/** The fitted revision and its doors for a building `def` placed at `p`, turned `r`; null when `def` is not replaced.
 *  `bodies` are the (x, z) of the bodies standing about; `taken(name)` says a door name is in use. */
export function doorFit(def: string, params: Record<string, unknown> | undefined, p: unknown, r: unknown, name: string | undefined,
  bodies: Vec2[] = [], taken: (n: string) => boolean = () => false, indoors: (x: number, z: number) => boolean = () => false,
  all?: { baseY?: number; existing?: (x: number, z: number, floor: number) => boolean; parent?: string }): { ref: string; doors: PlaceOp[]; series: string[]; at: Vec2[] } | null {
  // #2434 (`all`, door-fit/2): every doorway, with no door held back in series (a walk passes any number); a doorway that
  // already holds a door (door-fit/1's) keeps it; an inside or upstairs door starts open, an outside one as door-fit/1's
  const to = (all ? ALL_DOORS_FROM : DOOR_FIT_FROM).get(opRef(def)); if (!to) return null;
  // the door stands at the building's own height (its floor), not on the ground outside: on a slope that may be lower
  const fits = buildingDoorFits(params ?? {}, to.args, { p: xz(p), r: yaw(r) }), series: string[] = [], at: Vec2[] = [];
  // #2434: an upstairs door is the building's child (`all.parent`), in its frame: a world-root thing raised to an upper
  // floor would grade the terrain under it up to its foot (a foundation pad), and the building's floors with it
  const local = all?.parent ? buildingDoorFits(params ?? {}, to.args, { p: [0, 0], r: 0 }) : [];
  const y = Array.isArray(p) && p.length > 2 ? Math.round(Number(p[1]) * 1000) / 1000 : all?.baseY;
  const doors = fits.flatMap((f, k) => {
    if (all?.parent && f.floor > 0 && !all.existing?.(f.p[0], f.p[1], f.floor)) {
      const l = local[k]!, n = name ? `${name}-door-${k + 1}`.slice(0, 64) : undefined;
      at.push(f.p);
      return [{ op: 'place', def: DOOR_FIT_DOOR, in: { parent: all.parent }, ...(n && !taken(n) ? { name: n } : {}), p: [l.p[0], l.y ?? 0, l.p[1]], r: l.r, params: { sx: l.sx, sy: l.sy }, state: { open: true }, mode: 'strict' } as PlaceOp];
    }
    let n = name ? `${name}-door-${k + 1}`.slice(0, 64) : undefined;
    if (all && n && taken(n)) n = `${name}-door-${k + 1}-${f.floor}`.slice(0, 64);
    if (all?.existing?.(f.p[0], f.p[1], f.floor)) return [];
    if (!all && indoors(f.p[0] + SERIES_PROBE * Math.sin(f.r), f.p[1] + SERIES_PROBE * Math.cos(f.r))) { series.push(n ?? f.opening); return []; }
    const occupied = bodies.some((b) => Math.hypot(b[0] - f.p[0], b[1] - f.p[1]) < IN_DOORWAY);
    const fy = y === undefined ? undefined : Math.round((y + (f.y ?? 0)) * 1000) / 1000;
    at.push(f.p);
    return [{ op: 'place', def: DOOR_FIT_DOOR, in: { parent: 'world' }, ...(n && !taken(n) ? { name: n } : {}), p: fy === undefined ? f.p : [f.p[0], fy, f.p[1]], r: f.r, params: { sx: f.sx, sy: f.sy },
      state: { open: !to.enclosed || occupied || (!!all && !f.exterior) }, mode: 'strict' } as PlaceOp];
  });
  return { ref: to.ref, doors, series, at };
}

const inside = (q: Vec2[], x: number, z: number) => { let c = false; for (let i = 0, j = q.length - 1; i < q.length; j = i++) { const [xi, zi] = q[i]!, [xj, zj] = q[j]!; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
const BUILDING_REFS: ReadonlyMap<string, Record<string, unknown>> = new Map([...DOOR_FIT_FROM].flatMap(([from, to]) => [[from, { ...to.args, doorThings: false }], [to.ref, to.args]] as [string, Record<string, unknown>][]));
/** Distance from (x, z) to polygon q's edges. */
const edgeDist = (q: Vec2[], x: number, z: number) => {
  let d = Infinity;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [ax, az] = q[j]!, [bx, bz] = q[i]!, ex = bx - ax, ez = bz - az, l = ex * ex + ez * ez;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l)) : 0;
    d = Math.min(d, Math.hypot(x - ax - t * ex, z - az - t * ez));
  }
  return d;
};
/** Flood-fill cell (m), how far it must reach to be open ground (m), and how far a room's outline is grown to close its walls. */
const YARD_CELL = 0.5, YARD_OPEN_R = 20, WALL_GROW = 0.4;
/** Is (x, z) inside the ground-floor room of a core building in `god`'s world other than `self`, or in a yard the core
 *  buildings' ground floors close in all round (a courtyard reached only through another building's door: a second door
 *  in series, #2383)? The yard test floods 0.5 m cells from the point, stopped by the rooms (grown to close their walls),
 *  and calls it open when the flood gets 20 m away. */
function indoorsOf(god: GodMode): (self: string) => (x: number, z: number) => boolean {
  const rooms = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && BUILDING_REFS.has(opRef(e.def)))
    .map((e) => ({ id: e.id, polys: buildingGroundRooms((e.params ?? {}) as Record<string, unknown>, BUILDING_REFS.get(opRef(e.def))!, { p: xz(e.p), r: yaw(e.r) }) }));
  const boxes = rooms.flatMap((b) => b.polys.map((q) => {
    const xs = q.map((v) => v[0]), zs = q.map((v) => v[1]);
    return { q, box: [Math.min(...xs) - WALL_GROW, Math.min(...zs) - WALL_GROW, Math.max(...xs) + WALL_GROW, Math.max(...zs) + WALL_GROW] };
  }));
  const blocked = (x: number, z: number) => boxes.some(({ q, box }) => x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3] && (inside(q, x, z) || edgeDist(q, x, z) < WALL_GROW));
  const yard = (x: number, z: number) => {
    if (blocked(x, z)) return false;
    const seen = new Set<string>(['0,0']), q: [number, number][] = [[0, 0]], n = Math.ceil(YARD_OPEN_R / YARD_CELL);
    while (q.length) {
      const [i, j] = q.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di, b = j + dj, k = `${a},${b}`;
        if (seen.has(k) || blocked(x + a * YARD_CELL, z + b * YARD_CELL)) continue;
        if (Math.hypot(a, b) >= n) return false;
        seen.add(k); q.push([a, b]);
      }
    }
    return true;
  };
  return (self) => (x, z) => rooms.some((b) => b.id !== self && b.polys.some((q) => inside(q, x, z))) || yard(x, z);
}

/** A solid the walk graph holds (the engine's spatial scene): what a hand step is checked against. */
export type HandObstacle = { id: string; obb: { c: Vec2; half: Vec2; yaw: number }; y0: number; y1: number; label?: string };
/** How far out from the door line (m) a body stands to open it or close it, for the check. */
const HAND_FROM = 1.2;
/** Can a hand work door `id` in `model` both ways (open from one side, close from the other: in from outside and out from
 *  inside)? The same plan a passage makes (contact-actuator.ts, door-natural-v2), its body's steps sampled over the swing and
 *  checked as the hand actuator checks them (`contact.step-blocked`: nothing solid within a body radius), against
 *  `obstacles` other than the door's own and `skip`'s. Null when it can; else what is in the way. */
export function doorHandBlocked(model: WorldModel, id: string, obstacles: readonly HandObstacle[], skip: (id: string) => boolean = () => false, hit?: { id?: string }): string | null {
  const e = model.entities.get(id); if (!e) return 'gone';
  const contact = createContactActuatorService({ model: () => model, body: () => undefined, access: () => null, record() {}, commit: () => ({ accepted: false }) });
  const wp = model.worldPose(e), n: Vec2 = [Math.sin(wp.yaw), Math.cos(wp.yaw)], soul = { entityId: '' } as EdgeSoul;
  const at = (k: number): Vec2 => [wp.x + n[0] * k * HAND_FROM, wp.z + n[1] * k * HAND_FROM];
  const near = obstacles.filter((o) => o.id !== id && !o.id.startsWith(id + '#') && !skip(o.id) && Math.hypot(o.obb.c[0] - wp.x, o.obb.c[1] - wp.z) < 4 + Math.hypot(o.obb.half[0], o.obb.half[1]));
  for (const [action, side] of [['open', 1], ['close', -1], ['open', -1], ['close', 1]] as const) {
    const plan = contact.plan(soul, id, action, {}, { from: at(side), open: action === 'close' }), o = plan?.params.opening;
    if (!o) return `${action} from ${side > 0 ? 'outside' : 'inside'}: no plan`;
    for (let k = 0; k <= 16; k++) {
      const root = actuatorPoint(o, o.from + (o.to - o.from) * k / 16).root;
      for (const b of near) {
        if (b.y1 <= root[1] + 0.15 || b.y0 >= root[1] + 1.75) continue;
        const c = Math.cos(b.obb.yaw), s = Math.sin(b.obb.yaw), dx = root[0] - b.obb.c[0], dz = root[2] - b.obb.c[1];
        const x = Math.max(0, Math.abs(dx * c + dz * s) - b.obb.half[0]), z = Math.max(0, Math.abs(-dx * s + dz * c) - b.obb.half[1]);
        if (Math.hypot(x, z) < HUMAN_RADIUS + 0.025) { if (hit) hit.id = b.id; return `${action} from ${side > 0 ? 'outside' : 'inside'}: ${b.label ?? b.id}`; }
      }
    }
  }
  return null;
}

/** The ops that fit one world-root building `e` in `god`'s model: remove it with its contents, restore it on the fitted
 *  revision and its contents as they were (same ids), then place its doors. With `obstacles`, a door a hand cannot work
 *  (doorHandBlocked, on the model as the fit leaves it) is held back. */
function fitOps(god: GodMode, e: Entity, bodies: Vec2[], indoors: (x: number, z: number) => boolean, obstacles?: readonly HandObstacle[]) {
  const fit = doorFit(e.def, e.params as Record<string, unknown> | undefined, e.p, e.r, e.name, bodies, (n) => god.model.names.has(`world/${n}`), indoors)!;
  const sub = god.model.subtree(e.id).map((id) => god.model.entities.get(id)!);
  const ops = (doors: PlaceOp[]) => [{ op: 'remove', id: e.id, cascade: true }, ...sub.map((x, k): Op => ({ op: 'restore', entity: k === 0 ? { ...x, def: storedRef(fit.ref) } : x }) as Op), ...doors] as Op[];
  const held: string[] = [];
  if (obstacles && fit.doors.length) {
    const next = god.model.fork(), r = applyBatch(next, { ops: ops(fit.doors) }, 'engine', 0, { trusted: true });
    if (r.result.accepted) {
      const placed = [...next.entities.values()].filter((x) => !god.model.entities.has(x.id) && opRef(x.def) === DOOR_FIT_DOOR);
      fit.doors = fit.doors.filter((d, k) => {
        const q = xz(d.p), x = placed.find((y) => { const w = next.worldPose(y); return Math.hypot(w.x - q[0], w.z - q[1]) < 1e-3; });
        const why = x ? doorHandBlocked(next, x.id, obstacles, (id) => id.startsWith(e.id + '#door:')) : null;
        if (why) held.push(`${d.name ?? `${e.name ?? e.id} door ${k + 1}`} (${why})`);
        return !why;
      });
    }
  }
  return { ...fit, held, ops: ops(fit.doors) };
}

/** What door-fit/1 did: buildings fitted (with their doors), doors held back as a second door in series or as one a hand
 *  cannot work, buildings left for a later boot (a resident seated inside), and buildings kept on their old revision this
 *  boot (a door the world refuses), tried again at the next. */
export type DoorFitReport = { buildings: number; doors: number; left: string[]; kept: string[]; series: string[]; held: string[];
  fitted: { id: string; name?: string; ref: string; doors: PlaceOp[] }[] };

/** door-fit/1 on `god`'s world: every world-root building on a replaced revision, in one engine edit when it is
 *  accepted whole, else building by building (a refused one is left, named, for a later boot). `obstacles`: the walk
 *  graph's solids now, for the hand check (without them every door is placed). */
export function fitWorldDoorsV1(god: GodMode, bodies: Vec2[], log: (m: string) => void = () => {}, obstacles?: readonly HandObstacle[]): DoorFitReport {
  const targets = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && doorFitted(e.def));
  const out: DoorFitReport = { buildings: 0, doors: 0, left: [], kept: [], series: [], held: [], fitted: [] };
  if (!targets.length) return out;
  const indoors = indoorsOf(god);
  const done = (e: Entity, f: ReturnType<typeof fitOps>) => { out.buildings++; out.doors += f.doors.length; out.series.push(...f.series); out.held.push(...f.held); out.fitted.push({ id: e.id, ...(e.name ? { name: e.name } : {}), ref: f.ref, doors: f.doors }); };
  const note = (n: number, d: number) => `door-fit/1 (#2383): ${n} building(s) moved to their door-fitted revision, ${d} real door(s) set in their doorways`;
  const each = targets.map((e) => ({ e, fit: fitOps(god, e, bodies, indoors(e.id), obstacles) }));
  const whole = god.engineAct(each.flatMap((x) => x.fit.ops), note(each.length, each.reduce((a, x) => a + x.fit.doors.length, 0)));
  if (whole.accepted) for (const { e, fit } of each) done(e, fit);
  else for (const { e } of each) {
    const fit = fitOps(god, e, bodies, indoors(e.id), obstacles);   // names taken by an earlier building's doors are seen afresh
    const r = god.engineAct(fit.ops, note(1, fit.doors.length));
    if (r.accepted) { done(e, fit); continue; }
    const seated = (r.failures ?? []).some((x) => x.code === 'body.protected');
    // review of #2397: no refusal is final; a building the world refuses now is tried again at the next boot
    (seated ? out.left : out.kept).push(e.id);
    log(`door-fit/1: ${god.model.pathOf(e.id)} ${seated ? 'left for a later boot (seated in)' : 'keeps its old revision this boot, tried again at the next'}: ${JSON.stringify(r.failures ?? []).slice(0, 300)}`);
  }
  for (const h of out.held) log(`door-fit/1: held back, a hand cannot work it: ${h}`);
  log(`door-fit/1: ${out.buildings} building(s) fitted, ${out.doors} door(s) placed, ${out.series.length} door(s) in series held back, ${out.held.length} a hand cannot work held back${out.kept.length ? `, ${out.kept.length} refused this boot` : ''}${out.left.length ? `, ${out.left.length} left for a later boot` : ''}`);
  return out;
}

// ---- #2434 door-fit/2: every remaining doorway a real door ----

/** What door-fit/2 did, beside door-fit/1's counts: doors turned to swing the other way (a prop in the first swing), props
 *  moved the shortest legal distance clear of a door's swings, and doors a hand still cannot work (no prop to move). */
export type DoorFit2Report = DoorFitReport & { flipped: string[]; moved: string[] };
const turned = (r: number) => { let v = r + Math.PI; while (v > Math.PI + 1e-6) v -= 2 * Math.PI; return Math.round(v * 1000) / 1000; };
/** Prop moves tried, nearest first: 0.25 m to 2.5 m in eight directions. */
const MOVES: Vec2[] = Array.from({ length: 10 }, (_, i) => (i + 1) * 0.25).flatMap((d) => Array.from({ length: 8 }, (_, k): Vec2 => [Math.round(Math.cos(k * Math.PI / 4) * d * 1000) / 1000, Math.round(Math.sin(k * Math.PI / 4) * d * 1000) / 1000]));

/** The ops that move one world-root building `e` onto its every-doorway revision (ALL_DOORS_FROM) with a real door in each
 *  doorway that has none yet. A door a hand cannot work (doorHandBlocked, against the walk graph's solids with the
 *  building's own walls as the fit leaves them) is swung the other way; if both ways are blocked by a prop, the prop moves
 *  the shortest legal distance that frees the door. A door blocked by walls alone is held back, named. */
function fitOps2(god: GodMode, e: Entity, bodies: Vec2[], obstacles: readonly HandObstacle[] | undefined) {
  const m = god.model, base = m.worldPose(e).y;
  const doorThings = [...m.entities.values()].filter((x) => (x.in.parent === 'world' || x.in.parent === e.id) && opRef(x.def) === DOOR_FIT_DOOR).map((x) => m.worldPose(x));
  const existing = (x: number, z: number, floor: number) => doorThings.some((w) => Math.hypot(w.x - x, w.z - z) < 0.15 && (floor === 0 ? Math.abs(w.y - base) < 1 : w.y > base + 1));
  const fit = doorFit(e.def, e.params as Record<string, unknown> | undefined, e.p, e.r, e.name, bodies, (n) => m.names.has(`world/${n}`), undefined, { baseY: base, existing, parent: e.id })!;
  const sub = m.subtree(e.id).map((id) => m.entities.get(id)!);
  const moves: Op[] = [];
  const ops = () => [...moves, { op: 'remove', id: e.id, cascade: true }, ...sub.map((x, k): Op => ({ op: 'restore', entity: k === 0 ? { ...x, def: storedRef(fit.ref) } : x }) as Op), ...fit.doors] as Op[];
  const held: string[] = [], flipped: string[] = [], moved: string[] = [];
  if (obstacles && fit.doors.length) {
    const own = (id: string) => id.startsWith(e.id + '#');
    // the walk graph's solids with the building's walls as the fit leaves them, and a moved prop where it is moved to
    const solids = (next: WorldModel, shift: Map<string, Vec2>): HandObstacle[] => {
      const b = next.entities.get(e.id), out = obstacles.filter((o) => !own(o.id)).map((o) => { const d = shift.get(o.id.split('#')[0]!); return d ? { ...o, obb: { ...o.obb, c: [o.obb.c[0] + d[0], o.obb.c[1] + d[1]] as Vec2 } } : o; });
      if (b) out.push(...next.footprint(b).map((f, i) => ({ id: `${e.id}#fit${i}`, obb: { c: f.c, half: f.half, yaw: -f.yaw }, y0: f.y0, y1: f.y1 })));
      return out;
    };
    const tryFit = (shift: Map<string, Vec2>, k: number, hit?: { id?: string }) => {
      const next = m.fork(), r = applyBatch(next, { ops: ops() }, 'engine', 0, { trusted: true });
      if (!r.result.accepted) return 'refused';
      const q = fit.at[k]!, x = [...next.entities.values()].find((y) => !m.entities.has(y.id) && opRef(y.def) === DOOR_FIT_DOOR && Math.hypot(next.worldPose(y).x - q[0], next.worldPose(y).z - q[1]) < 0.01);
      return x ? doorHandBlocked(next, x.id, solids(next, shift), (id) => id.startsWith(e.id + '#door:'), hit) : null;
    };
    const shift = new Map<string, Vec2>();
    for (let k = 0; k < fit.doors.length; k++) {
      const d = fit.doors[k]!, label = d.name ?? `${e.name ?? e.id} door ${k + 1}`;
      const hit: { id?: string } = {}, why = tryFit(shift, k, hit);
      if (!why || why === 'refused') continue;
      d.r = turned(d.r as number);   // swung the other way
      const hit2: { id?: string } = {}, why2 = tryFit(shift, k, hit2);
      if (!why2 || why2 === 'refused') { flipped.push(label); continue; }
      d.r = turned(d.r as number);
      // both ways blocked: the prop in the first swing moves the shortest legal distance that frees the door
      const prop = (hit.id ?? hit2.id ?? '').split('#')[0]!, pe = m.entities.get(prop);
      const movable = !!pe && pe.in.parent === 'world' && prop !== e.id && opRef(pe.def) !== DOOR_FIT_DOOR && !BUILDING_REFS.has(opRef(pe.def)) && !ALL_DOORS_FROM.has(opRef(pe.def)) && ![...ALL_DOORS_FROM.values()].some((v) => v.ref === opRef(pe.def)) && !pe.shape;
      let free = false;
      if (movable) {
        const at = m.worldPose(pe!), p0 = Array.isArray(pe!.p) ? pe!.p as number[] : [at.x, at.z];
        for (const [dx, dz] of MOVES) {
          const to = p0.length > 2 ? [p0[0]! + dx, p0[1]!, p0[2]! + dz] : [p0[0]! + dx, p0[1]! + dz];
          moves.push({ op: 'move', id: prop, p: to } as Op); shift.set(prop, [dx, dz]);
          if (!tryFit(shift, k)) { moved.push(`${pe!.name ?? prop} moved ${Math.round(Math.hypot(dx, dz) * 100) / 100} m clear of ${label}`); free = true; break; }
          moves.pop(); shift.delete(prop);
        }
      }
      if (!free) { held.push(`${label} (${why})`); fit.doors.splice(k, 1); fit.at.splice(k, 1); k--; }
    }
  }
  return { ...fit, held, flipped, moved, ops: ops() };
}

/** door-fit/2 (#2434) on `god`'s world: every world-root building on a revision before its every-doorway one (a first
 *  revision, or door-fit/1's) moves onto it, with a real door in each doorway that has none, in one engine edit when it is
 *  accepted whole, else building by building (a refused one is left, named, for a later boot). */
export function fitWorldDoorsV2(god: GodMode, bodies: Vec2[], log: (m: string) => void = () => {}, obstacles?: readonly HandObstacle[]): DoorFit2Report {
  const targets = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && ALL_DOORS_FROM.has(opRef(e.def)));
  const out: DoorFit2Report = { buildings: 0, doors: 0, left: [], kept: [], series: [], held: [], fitted: [], flipped: [], moved: [] };
  if (!targets.length) return out;
  const done = (e: Entity, f: ReturnType<typeof fitOps2>) => { out.buildings++; out.doors += f.doors.length; out.held.push(...f.held); out.flipped.push(...f.flipped); out.moved.push(...f.moved); out.fitted.push({ id: e.id, ...(e.name ? { name: e.name } : {}), ref: f.ref, doors: f.doors }); };
  const note = (n: number, d: number) => `door-fit/2 (#2434): ${n} building(s) moved to their every-doorway revision, ${d} more real door(s) set in their doorways`;
  const each = targets.map((e) => ({ e, fit: fitOps2(god, e, bodies, obstacles) }));
  const whole = god.engineAct(each.flatMap((x) => x.fit.ops), note(each.length, each.reduce((a, x) => a + x.fit.doors.length, 0)));
  if (whole.accepted) for (const { e, fit } of each) done(e, fit);
  else for (const { e } of each) {
    const fit = fitOps2(god, e, bodies, obstacles);
    const r = god.engineAct(fit.ops, note(1, fit.doors.length));
    if (r.accepted) { done(e, fit); continue; }
    const seated = (r.failures ?? []).some((x) => x.code === 'body.protected');
    (seated ? out.left : out.kept).push(e.id);
    log(`door-fit/2: ${god.model.pathOf(e.id)} ${seated ? 'left for a later boot (seated in)' : 'keeps its revision this boot, tried again at the next'}: ${JSON.stringify(r.failures ?? []).slice(0, 300)}`);
  }
  for (const h of out.flipped) log(`door-fit/2: swung the other way (a prop in the first swing): ${h}`);
  for (const h of out.moved) log(`door-fit/2: ${h}`);
  for (const h of out.held) log(`door-fit/2: held back, a hand cannot work it either way and no prop can move: ${h}`);
  log(`door-fit/2: ${out.buildings} building(s) fitted, ${out.doors} door(s) placed, ${out.flipped.length} swung the other way, ${out.moved.length} prop(s) moved, ${out.held.length} held back${out.kept.length ? `, ${out.kept.length} refused this boot` : ''}${out.left.length ? `, ${out.left.length} left for a later boot` : ''}`);
  return out;
}
