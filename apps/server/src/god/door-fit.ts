// #2383 door-fit/1: every built-in doorway is a real door. A building on a core revision that draws its ground-floor
// doors as fixed leaves moves to its door-fitted revision (DOOR_FIT_FROM; same walls, rooms and slots, bare doorways),
// and a hand-operated core/door@2 is placed in each bare doorway (buildingDoorFits). Templates carry the result; a live
// world gets it once, as one recorded engine edit at boot (the last rule in adoptBootRuntimePoliciesV1).
//
// It refuses nothing and moves nobody: a door whose spot a body stands near is placed open, so nobody is pushed; a
// building with a resident's body inside its subtree (seated in it) is left as it is and fitted at a later boot; a
// building whose door the world refuses (a tower's stair crowding its doorway) keeps its old revision and drawn leaf.
// A door that would open into another building's ground-floor room (a second door in series) is not placed until a walk
// passes several closed doors in a row (#2370); its doorway stays an open gap.
import { buildingDoorFits, buildingGroundRooms } from '@souls/generators';
import { DOOR_FIT_FROM, type Entity, type Op } from '@souls/world-compiler';
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
  bodies: Vec2[] = [], taken: (n: string) => boolean = () => false, indoors: (x: number, z: number) => boolean = () => false): { ref: string; doors: PlaceOp[]; series: string[] } | null {
  const to = DOOR_FIT_FROM.get(opRef(def)); if (!to) return null;
  // the door stands at the building's own height (its floor), not on the ground outside: on a slope that may be lower
  const fits = buildingDoorFits(params ?? {}, to.args, { p: xz(p), r: yaw(r) }), series: string[] = [];
  const y = Array.isArray(p) && p.length > 2 ? Math.round(Number(p[1]) * 1000) / 1000 : undefined;
  const doors = fits.flatMap((f, k) => {
    const n = name ? `${name}-door-${k + 1}`.slice(0, 64) : undefined;
    if (indoors(f.p[0] + SERIES_PROBE * Math.sin(f.r), f.p[1] + SERIES_PROBE * Math.cos(f.r))) { series.push(n ?? f.opening); return []; }
    const occupied = bodies.some((b) => Math.hypot(b[0] - f.p[0], b[1] - f.p[1]) < IN_DOORWAY);
    return [{ op: 'place', def: DOOR_FIT_DOOR, in: { parent: 'world' }, ...(n && !taken(n) ? { name: n } : {}), p: y === undefined ? f.p : [f.p[0], y, f.p[1]], r: f.r, params: { sx: f.sx, sy: f.sy },
      state: { open: !to.enclosed || occupied }, mode: 'strict' } as PlaceOp];
  });
  return { ref: to.ref, doors, series };
}

const inside = (q: Vec2[], x: number, z: number) => { let c = false; for (let i = 0, j = q.length - 1; i < q.length; j = i++) { const [xi, zi] = q[i]!, [xj, zj] = q[j]!; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
const BUILDING_REFS: ReadonlyMap<string, Record<string, unknown>> = new Map([...DOOR_FIT_FROM].flatMap(([from, to]) => [[from, { ...to.args, doorThings: false }], [to.ref, to.args]] as [string, Record<string, unknown>][]));
/** Is (x, z) inside the ground-floor room of a core building in `god`'s world other than `self`? */
function indoorsOf(god: GodMode): (self: string) => (x: number, z: number) => boolean {
  const rooms = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && BUILDING_REFS.has(opRef(e.def)))
    .map((e) => ({ id: e.id, polys: buildingGroundRooms((e.params ?? {}) as Record<string, unknown>, BUILDING_REFS.get(opRef(e.def))!, { p: xz(e.p), r: yaw(e.r) }) }));
  return (self) => (x, z) => rooms.some((b) => b.id !== self && b.polys.some((q) => inside(q, x, z)));
}

/** The ops that fit one world-root building `e` in `god`'s model: remove it with its contents, restore it on the fitted
 *  revision and its contents as they were (same ids), then place its doors. */
function fitOps(god: GodMode, e: Entity, bodies: Vec2[], indoors: (x: number, z: number) => boolean) {
  const fit = doorFit(e.def, e.params as Record<string, unknown> | undefined, e.p, e.r, e.name, bodies, (n) => god.model.names.has(`world/${n}`), indoors)!;
  const sub = god.model.subtree(e.id).map((id) => god.model.entities.get(id)!);
  return { ...fit, ops: [{ op: 'remove', id: e.id, cascade: true }, ...sub.map((x, k): Op => ({ op: 'restore', entity: k === 0 ? { ...x, def: storedRef(fit.ref) } : x }) as Op), ...fit.doors] as Op[] };
}

/** What door-fit/1 did: buildings fitted (with their doors), doors held back as a second door in series, buildings left
 *  for a later boot (a resident seated inside), and buildings kept on their old revision (a door the world refuses). */
export type DoorFitReport = { buildings: number; doors: number; left: string[]; kept: string[]; series: string[];
  fitted: { id: string; name?: string; ref: string; doors: PlaceOp[] }[] };

/** door-fit/1 on `god`'s world: every world-root building on a replaced revision, in one engine edit when it is
 *  accepted whole, else building by building (a refused one is left, named, for a later boot). */
export function fitWorldDoorsV1(god: GodMode, bodies: Vec2[], log: (m: string) => void = () => {}): DoorFitReport {
  const targets = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && doorFitted(e.def));
  const out: DoorFitReport = { buildings: 0, doors: 0, left: [], kept: [], series: [], fitted: [] };
  if (!targets.length) return out;
  const indoors = indoorsOf(god);
  const done = (e: Entity, f: ReturnType<typeof fitOps>) => { out.buildings++; out.doors += f.doors.length; out.series.push(...f.series); out.fitted.push({ id: e.id, ...(e.name ? { name: e.name } : {}), ref: f.ref, doors: f.doors }); };
  const note = (n: number, d: number) => `door-fit/1 (#2383): ${n} building(s) moved to their door-fitted revision, ${d} real door(s) set in their doorways`;
  const each = targets.map((e) => ({ e, fit: fitOps(god, e, bodies, indoors(e.id)) }));
  const whole = god.engineAct(each.flatMap((x) => x.fit.ops), note(each.length, each.reduce((a, x) => a + x.fit.doors.length, 0)));
  if (whole.accepted) for (const { e, fit } of each) done(e, fit);
  else for (const { e } of each) {
    const fit = fitOps(god, e, bodies, indoors(e.id));   // names taken by an earlier building's doors are seen afresh
    const r = god.engineAct(fit.ops, note(1, fit.doors.length));
    if (r.accepted) { done(e, fit); continue; }
    const seated = (r.failures ?? []).some((x) => x.code === 'body.protected');
    (seated ? out.left : out.kept).push(e.id);
    log(`door-fit/1: ${god.model.pathOf(e.id)} ${seated ? 'left for a later boot' : 'keeps its old revision'}: ${JSON.stringify(r.failures ?? []).slice(0, 300)}`);
  }
  log(`door-fit/1: ${out.buildings} building(s) fitted, ${out.doors} door(s) placed, ${out.series.length} door(s) in series held back${out.kept.length ? `, ${out.kept.length} kept on the old revision` : ''}${out.left.length ? `, ${out.left.length} left for a later boot` : ''}`);
  return out;
}
