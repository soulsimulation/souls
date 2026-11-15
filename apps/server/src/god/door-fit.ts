// #2383 door-fit/1: every built-in doorway is a real door. A building on a core revision that draws its ground-floor
// doors as fixed leaves moves to its door-fitted revision (DOOR_FIT_FROM; same walls, rooms and slots, bare doorways),
// and a hand-operated core/door@2 is placed in each bare doorway (buildingDoorFits). Templates carry the result; a live
// world gets it once, one recorded engine edit per building in slices at boot (the last rule in adoptBootRuntimePoliciesV1),
// only with DOOR_FIT_BOOT=1: off by default until one building's edit runs well under a second (up to 15.9 s on Eden).
//
// It refuses nothing and moves nobody: every door is placed open (until #2434), so nobody is pushed; a
// building with a resident's body inside its subtree (seated in it) is left as it is and fitted at a later boot; a
// building whose door the world refuses (a tower's stair crowding its doorway) keeps its old revision and drawn leaf for
// now, and is tried again at the next boot.
// A door that would open into another building's ground-floor room, or into a yard buildings close in all round (a second
// door in series) is not placed until a walk passes several closed doors in a row (#2370); its doorway stays an open gap.
import { buildingDoorFits, buildingGroundRooms } from '@souls/generators';
import { DOOR_FIT_FROM, applyBatch, type Entity, type Op, type WorldModel } from '@souls/world-compiler';
import { actuatorPoint } from '../../../../mars/viewer/engine/social/hand-actuator.ts';
import { HUMAN_RADIUS } from '../../../../mars/viewer/engine/world/catalog.ts';
import type { EdgeSoul } from '../edge/contract.ts';
import { createContactActuatorService } from './contact-actuator.ts';
import type { GodMode } from './god.ts';

export const DOOR_FIT_DOOR = 'core/door@2';
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
  bodies: Vec2[] = [], taken: (n: string) => boolean = () => false, indoors: (x: number, z: number) => boolean = () => false): { ref: string; doors: PlaceOp[]; series: string[] } | null {
  const to = DOOR_FIT_FROM.get(opRef(def)); if (!to) return null;
  // the door stands at the building's own height (its floor), not on the ground outside: on a slope that may be lower
  const fits = buildingDoorFits(params ?? {}, to.args, { p: xz(p), r: yaw(r) }), series: string[] = [];
  const y = Array.isArray(p) && p.length > 2 ? Math.round(Number(p[1]) * 1000) / 1000 : undefined;
  const doors = fits.flatMap((f, k) => {
    const n = name ? `${name}-door-${k + 1}`.slice(0, 64) : undefined;
    if (indoors(f.p[0] + SERIES_PROBE * Math.sin(f.r), f.p[1] + SERIES_PROBE * Math.cos(f.r))) { series.push(n ?? f.opening); return []; }
    // placed open (coordinator, until the multi-door passage #2434): the passage leaves a door as it found it, so a Soul
    // inside one house never meets two closed doors on the way to another; a god or a Soul may still close it
    return [{ op: 'place', def: DOOR_FIT_DOOR, in: { parent: 'world' }, ...(n && !taken(n) ? { name: n } : {}), p: y === undefined ? f.p : [f.p[0], y, f.p[1]], r: f.r, params: { sx: f.sx, sy: f.sy },
      state: { open: true }, mode: 'strict' } as PlaceOp];
  });
  return { ref: to.ref, doors, series };
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
export function doorHandBlocked(model: WorldModel, id: string, obstacles: readonly HandObstacle[], skip: (id: string) => boolean = () => false): string | null {
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
        if (Math.hypot(x, z) < HUMAN_RADIUS + 0.025) return `${action} from ${side > 0 ? 'outside' : 'inside'}: ${b.label ?? b.id}`;
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

/** Review of #2438 (#2397's door-fit/1 measured 267 s in one turn on Eden): the boot fits run while the world serves, so a fit is cut in slices, one building each (its own
 *  recorded edit), and the event loop turns between slices (the ticks, the hub and the watchdog's heartbeat run there).
 *  `pause` waits for the next turn; `slice` hears how long each slice held the thread. */
export type FitSlices = { pause?: () => Promise<void>; slice?: (ms: number, what: string) => void };
const nextTurn = () => new Promise<void>((r) => setImmediate(r));

/** door-fit/1 on `god`'s world: every world-root building on a replaced revision, building by building, one recorded edit
 *  and one slice each (a refused one is left, named, for a later boot). A building fitted already (a restart part way
 *  through) is on its fitted revision and is skipped. `obstacles`: the walk graph's solids now, for the hand check
 *  (without them every door is placed). */
export async function fitWorldDoorsV1(god: GodMode, bodies: Vec2[], log: (m: string) => void = () => {}, obstacles?: readonly HandObstacle[], o: FitSlices = {}): Promise<DoorFitReport> {
  const pause = o.pause ?? nextTurn;
  const targets = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && doorFitted(e.def)).map((e) => e.id);
  const out: DoorFitReport = { buildings: 0, doors: 0, left: [], kept: [], series: [], held: [], fitted: [] };
  if (!targets.length) return out;
  let t = performance.now();
  const indoors = indoorsOf(god);
  o.slice?.(performance.now() - t, 'rooms'); await pause();
  const note = (d: number) => `door-fit/1 (#2383): 1 building moved to its door-fitted revision, ${d} real door(s) set in its doorways`;
  for (const id of targets) {
    t = performance.now();
    const e = god.model.entities.get(id);
    if (e && e.in.parent === 'world' && doorFitted(e.def)) {   // (an edit between slices may have removed or refitted it)
      const fit = fitOps(god, e, bodies, indoors(e.id), obstacles);
      const r = god.engineAct(fit.ops, note(fit.doors.length));
      if (r.accepted) { out.buildings++; out.doors += fit.doors.length; out.series.push(...fit.series); out.held.push(...fit.held); out.fitted.push({ id: e.id, ...(e.name ? { name: e.name } : {}), ref: fit.ref, doors: fit.doors }); }
      else {
        const seated = (r.failures ?? []).some((x) => x.code === 'body.protected');
        // review of #2397: no refusal is final; a building the world refuses now is tried again at the next boot
        (seated ? out.left : out.kept).push(e.id);
        log(`door-fit/1: ${god.model.pathOf(e.id)} ${seated ? 'left for a later boot (seated in)' : 'keeps its old revision this boot, tried again at the next'}: ${JSON.stringify(r.failures ?? []).slice(0, 300)}`);
      }
    }
    o.slice?.(performance.now() - t, id); await pause();
  }
  for (const h of out.held) log(`door-fit/1: held back, a hand cannot work it: ${h}`);
  log(`door-fit/1: ${out.buildings} building(s) fitted, ${out.doors} door(s) placed, ${out.series.length} door(s) in series held back, ${out.held.length} a hand cannot work held back${out.kept.length ? `, ${out.kept.length} refused this boot` : ''}${out.left.length ? `, ${out.left.length} left for a later boot` : ''}`);
  return out;
}
