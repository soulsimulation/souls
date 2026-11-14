// #2383 door-fit/1: every built-in doorway is a real door. A building on a core revision that draws its ground-floor
// doors as fixed leaves moves to its door-fitted revision (DOOR_FIT_FROM; same walls, rooms and slots, bare doorways),
// and a hand-operated core/door@2 is placed in each bare doorway (buildingDoorFits). Templates carry the result; a live
// world gets it once, as one recorded engine edit at boot (the last rule in adoptBootRuntimePoliciesV1).
//
// It refuses nothing and moves nobody: a door whose spot a body stands near is placed open, so nobody is pushed; a
// building with a resident's body inside its subtree (seated in it) is left as it is and fitted at a later boot.
import { buildingDoorFits } from '@souls/generators';
import { DOOR_FIT_FROM, type Entity, type Op } from '@souls/world-compiler';
import type { GodMode } from './god.ts';

export const DOOR_FIT_DOOR = 'core/door@2';
/** A body this close (m) to a door's spot stands in its doorway: the door is placed open. */
const IN_DOORWAY = 1.0;

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
  bodies: Vec2[] = [], taken: (n: string) => boolean = () => false): { ref: string; doors: PlaceOp[] } | null {
  const to = DOOR_FIT_FROM.get(opRef(def)); if (!to) return null;
  const fits = buildingDoorFits(params ?? {}, to.args, { p: xz(p), r: yaw(r) });
  return { ref: to.ref, doors: fits.map((f, k) => {
    const occupied = bodies.some((b) => Math.hypot(b[0] - f.p[0], b[1] - f.p[1]) < IN_DOORWAY);
    const n = name ? `${name}-door-${k + 1}`.slice(0, 64) : undefined;
    return { op: 'place', def: DOOR_FIT_DOOR, in: { parent: 'world' }, ...(n && !taken(n) ? { name: n } : {}), p: f.p, r: f.r, params: { sx: f.sx, sy: f.sy },
      state: { open: !to.enclosed || occupied }, mode: 'strict' } as PlaceOp;
  }) };
}

/** The ops that fit one world-root building `e` in `god`'s model: remove it with its contents, restore it on the fitted
 *  revision and its contents as they were (same ids), then place its doors. */
function fitOps(god: GodMode, e: Entity, bodies: Vec2[]): { ops: Op[]; doors: number } | null {
  const fit = doorFit(e.def, e.params as Record<string, unknown> | undefined, e.p, e.r, e.name, bodies, (n) => god.model.names.has(`world/${n}`));
  if (!fit) return null;
  const sub = god.model.subtree(e.id).map((id) => god.model.entities.get(id)!);
  return { ops: [{ op: 'remove', id: e.id, cascade: true }, ...sub.map((x, k): Op => ({ op: 'restore', entity: k === 0 ? { ...x, def: storedRef(fit.ref) } : x }) as Op), ...fit.doors], doors: fit.doors.length };
}

export type DoorFitReport = { buildings: number; doors: number; left: string[] };

/** door-fit/1 on `god`'s world: every world-root building on a replaced revision, in one engine edit when it is
 *  accepted whole, else building by building (a refused one is left, named, for a later boot). */
export function fitWorldDoorsV1(god: GodMode, bodies: Vec2[], log: (m: string) => void = () => {}): DoorFitReport {
  const targets = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && doorFitted(e.def));
  const out: DoorFitReport = { buildings: 0, doors: 0, left: [] };
  if (!targets.length) return out;
  const each = targets.map((e) => ({ e, fit: fitOps(god, e, bodies)! }));
  const note = (n: number, d: number) => `door-fit/1 (#2383): ${n} building(s) moved to their door-fitted revision, ${d} real door(s) set in their doorways`;
  const whole = god.engineAct(each.flatMap((x) => x.fit.ops), note(each.length, each.reduce((a, x) => a + x.fit.doors, 0)));
  if (whole.accepted) { out.buildings = each.length; out.doors = each.reduce((a, x) => a + x.fit.doors, 0); }
  else for (const { e } of each) {
    const fit = fitOps(god, e, bodies)!;   // names taken by an earlier building's doors are seen afresh
    const r = god.engineAct(fit.ops, note(1, fit.doors));
    if (r.accepted) { out.buildings++; out.doors += fit.doors; } else { out.left.push(e.id); log(`door-fit/1: ${god.model.pathOf(e.id)} left as it is: ${JSON.stringify(r.failures ?? []).slice(0, 300)}`); }
  }
  log(`door-fit/1: ${out.buildings} building(s) fitted, ${out.doors} door(s) placed${out.left.length ? `, ${out.left.length} left for a later boot` : ''}`);
  return out;
}
