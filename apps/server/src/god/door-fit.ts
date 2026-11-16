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
import { ALL_DOORS_FROM, DOOR_FIT_FROM, applyBatch, type Diff, type Entity, type Failure, type Op, type Result, type WorldModel } from '@souls/world-compiler';
import { actuatorPoint } from '../../../../mars/viewer/engine/social/hand-actuator.ts';
import { HUMAN_RADIUS } from '../../../../mars/viewer/engine/world/catalog.ts';
import type { EdgeSoul } from '../edge/contract.ts';
import { createContactActuatorService } from './contact-actuator.ts';
import type { GodMode } from './god.ts';
import { projectProviders } from './query.ts';

export const DOOR_FIT_DOOR = 'core/door@2';
/** #2434: the narrowest doorway a core/door@2 fits (its frame at the least stretch, 0.8 x 1.16 m, plus a margin). */
const NARROWEST = 0.96;
/** How far (m) in front of a door its outside is probed for another building's room. */
const SERIES_PROBE = 0.6;

type Vec2 = [number, number];
type PlaceOp = Extract<Op, { op: 'place' }>;
/** A doorway in world terms: its middle (x, z), the door's yaw, the height of its floor (m), its width and floor index,
 *  and whether it leads outside (#2462: a building with no outside door yet is checked from its planned one). */
export type Way = { p: Vec2; r: number; y: number; width: number; floor: number; exterior: boolean };
const xz = (p: unknown): Vec2 => { const a = Array.isArray(p) ? p as number[] : [0, 0]; return a.length > 2 ? [a[0]!, a[2]!] : [a[0] ?? 0, a[1] ?? 0]; };
/** A model stores a core ref as `core-cottage@1`; ops and templates write `core/cottage@1`. */
const opRef = (def: string) => def.replace(/^core-/, 'core/'), storedRef = (ref: string) => ref.replace(/^core\//, 'core-');
export const doorFitted = (def: string): boolean => DOOR_FIT_FROM.has(opRef(def));
const yaw = (r: unknown): number => Array.isArray(r) ? Number(r[1] ?? 0) : typeof r === 'number' ? r : 0;

/** Doors both fits hold back by name, their doorway left bare: each measured on a fresh genesis of the fitted Eden
 *  template. Open, region-alpine-mountain-station-door-1's leaf cuts the station hall off from its entry (#2397); each
 *  artists-studio door's frame cuts its building's upper floor or bedroom off (#2434, bc13f17b0; the reach check in
 *  fitWorldDoorsV2 catches three of the four on its own). The template tools and the live rule read this one list. */
export const DOOR_FIT_HELD: ReadonlySet<string> = new Set(['region-alpine-mountain-station-door-1', 'artists-studio-2-door-3', 'artists-studio-3-door-1-0', 'artists-studio-8-door-3', 'artists-studio-4-door-3']);

/** The fitted revision and its doors for a building `def` placed at `p`, turned `r`; null when `def` is not replaced.
 *  `bodies` are the (x, z) of the bodies standing about; `taken(name)` says a door name is in use. */
export function doorFit(def: string, params: Record<string, unknown> | undefined, p: unknown, r: unknown, name: string | undefined,
  bodies: Vec2[] = [], taken: (n: string) => boolean = () => false, indoors: (x: number, z: number) => boolean = () => false,
  all?: { baseY?: number; existing?: (x: number, z: number, floor: number) => boolean; parent?: string; /** #2462: outside doors too are the building's children, so they follow it */ follow?: boolean }): { ref: string; doors: PlaceOp[]; series: string[]; named: string[]; at: Vec2[]; ways: Way[]; placed: Way[]; local: { p: Vec2; y: number; r: number }[] } | null {
  // #2434 (`all`, door-fit/2): every doorway, with no door held back in series (a walk passes any number); a doorway that
  // already holds a door (door-fit/1's) keeps it; an inside or upstairs door starts open, an outside one as door-fit/1's
  const to = (all ? ALL_DOORS_FROM : DOOR_FIT_FROM).get(opRef(def)); if (!to) return null;
  // the door stands at the building's own height (its floor), not on the ground outside: on a slope that may be lower
  const fits = buildingDoorFits(params ?? {}, to.args, { p: xz(p), r: yaw(r) }), series: string[] = [], named: string[] = [], at: Vec2[] = [];
  // #2434: an upstairs door is the building's child (`all.parent`), in its frame: a world-root thing raised to an upper
  // floor would grade the terrain under it up to its foot (a foundation pad), and the building's floors with it
  const local = all?.parent ? buildingDoorFits(params ?? {}, to.args, { p: [0, 0], r: 0 }) : [];
  const y = Array.isArray(p) && p.length > 2 ? Math.round(Number(p[1]) * 1000) / 1000 : all?.baseY;
  // review of #2438: every doorway in world terms (its middle, yaw, height and width), and those a door is placed in
  const ways: Way[] = fits.map((f) => ({ p: f.p, r: f.r, y: (y ?? 0) + (f.y ?? 0), width: f.width, floor: f.floor, exterior: f.exterior })), placed: Way[] = [];
  const doors = fits.flatMap((f, k) => {
    // a doorway narrower than the door's narrowest frame (its wall had no room to widen it) stays bare, named
    if (all && f.width < NARROWEST && !all.existing?.(f.p[0], f.p[1], f.floor)) { series.push(`${name ?? f.opening} ${f.opening} (${f.width} m wide)`); return []; }
    // an inside or upstairs door is the building's child (its ancestor's walls do not count as overlapping it)
    // #2462 (`follow`, the live rule): an outside door is the building's child too, so a later edit that moves the
    // building moves its doors with it (a world-root door stayed where it was, #2397 follow-up 6)
    if (all?.parent && (f.floor > 0 || !f.exterior || all.follow) && !all.existing?.(f.p[0], f.p[1], f.floor)) {
      const l = local[k]!; let n = name ? `${name}-door-${k + 1}`.slice(0, 64) : undefined; if (n && taken(n)) n = `${name}-door-${k + 1}-${f.floor}`.slice(0, 64);
      if (n && DOOR_FIT_HELD.has(n)) { named.push(n); return []; }
      at.push(f.p); placed.push(ways[k]!);
      return [{ op: 'place', def: DOOR_FIT_DOOR, in: { parent: all.parent }, ...(n && !taken(n) ? { name: n } : {}), p: [l.p[0], l.y ?? 0, l.p[1]], r: l.r, params: { sx: l.sx, sy: l.sy }, state: { open: true }, mode: 'strict' } as PlaceOp];
    }
    let n = name ? `${name}-door-${k + 1}`.slice(0, 64) : undefined;
    if (all && n && taken(n)) n = `${name}-door-${k + 1}-${f.floor}`.slice(0, 64);
    if (all?.existing?.(f.p[0], f.p[1], f.floor)) return [];
    if (!all && indoors(f.p[0] + SERIES_PROBE * Math.sin(f.r), f.p[1] + SERIES_PROBE * Math.cos(f.r))) { series.push(n ?? f.opening); return []; }
    if (n && DOOR_FIT_HELD.has(n)) { named.push(n); return []; }
    const fy = y === undefined ? undefined : Math.round((y + (f.y ?? 0)) * 1000) / 1000;
    at.push(f.p); placed.push(ways[k]!);
    // placed open (coordinator, until the multi-door passage #2434 is proven): the passage leaves a door as it found it.
    // Anchored 'center' at that height (#2397): a base-anchored door on a slope cut its own foundation pad at its y into the
    // ground under its building's wall, which re-settled the building away from its door (#2448; the vineyard villa's door
    // pad 1.17 m under the villa cut off its rooms). A door never reshapes the ground or re-settles.
    return [{ op: 'place', def: DOOR_FIT_DOOR, in: { parent: 'world' }, ...(n && !taken(n) ? { name: n } : {}), p: fy === undefined ? f.p : [f.p[0], fy, f.p[1]], r: f.r,
      ...(fy === undefined ? {} : { anchor: 'center' }), params: { sx: f.sx, sy: f.sy }, state: { open: true }, mode: 'strict' } as PlaceOp];
  });
  return { ref: to.ref, doors, series, named, at, ways, placed, local: local.map((l) => ({ p: l.p, y: l.y ?? 0, r: l.r })) };
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
  fitted: { id: string; name?: string; ref: string; doors: PlaceOp[]; /** #2434 door-fit/2: props moved clear of a door */ moves?: Op[] }[] };

/** #2438: a fit's edit is the server's, not the engine's, but GodMode.engineAct journals it as the engine's, which the
 *  bridge does not send on: the edit's own diff (its tiles and defs too, #2462) is sent to the engine here, so the walk
 *  graph, the reach check, a moved prop's pose and the ground under it agree with the model.
 *  #2462: BUILDSAFE, as a god edit has it, on the would-be world before the edit is made: an edit of a resident's body is
 *  refused (`bodies.refuse`); under legal-edits/1 its preview breaking a rule on a Soul, or a Soul in its way or using what
 *  it changes, refuses it (`bodies.legal`, its preview waited for off the tick thread, at most three rounds); and without
 *  legal-edits/1 an edit the walk-out planner would walk a resident out of the way for is refused too (`bodies.prepare`,
 *  dry: it moves nobody, and one that leaves a resident stuck in its way), since a fit never walks anyone; and the god's
 *  own guard (`actGuard`: no deck or stair flight someone stands on is moved or removed under them). `inverse` undoes the
 *  edit. A `cleanup` edit (a door taken out again, a prop move or the whole fit undone: it puts back what was there before
 *  the fit) is gated only by `bodies.refuse` and `actGuard`, so a Soul who stepped near meanwhile does not keep a cut-off
 *  building fitted. */
export async function fitAct(god: GodMode, ops: Op[], note: string, o: { cleanup?: boolean } = {}): Promise<{ r: Result; inverse: Op[]; diff?: Diff }> {
  try {
    for (let round = 0; ; round++) {
      let pending = false, diff: Diff | undefined, inverse: Op[] = [];
      const r = god.engineAct(ops, note, undefined, undefined, (before, after, d, inv) => {
        diff = d; inverse = inv;
        const guard = god.actGuard?.({ ops }); if (guard) return guard;
        const b = god.bodies; if (!b) return null;
        const own = b.refuse?.(after, d, ops); if (own) return { accepted: false, failures: [own] };
        if (o.cleanup) return null;
        const legal = b.legal?.(before, after, d);
        if (legal === 'pending') { pending = true; return { accepted: false, failures: [{ op: -1, code: FIT_PENDING, field: 'legal-edits/1', detail: 'checked off the tick thread first' }] }; }
        if (legal) return { accepted: false, failures: legal };
        // dry, the plan's warnings are the residents stuck in its way (it has nowhere to walk them)
        const plan = b.prepare?.(before, after, d, ops, { dry: true }), moved = plan?.moved ?? [], stuck = plan?.warnings ?? [];
        if (stuck.length) return { accepted: false, failures: stuck.map((w): Failure => ({ op: -1, code: 'body.in-the-way', field: 'door-fit', detail: w })) };
        return moved.length ? { accepted: false, failures: moved.map((m): Failure => ({ op: -1, code: 'body.in-the-way', entity: m.body, field: 'door-fit', detail: `${m.name} is in this fit's way (${m.reason}).` })) } : null;
      });
      if (pending && round < 3 && god.bodies?.legalRun) { const refused = await god.bodies.legalRun(); if (refused) return { r: { accepted: false, failures: refused }, inverse: [] }; continue; }
      if (r.accepted && diff) projectProviders.get(god.model)?.(diff);
      return r.accepted ? { r, inverse, diff } : { r, inverse: [] };
    }
  } finally { god.bodies?.legalDone?.(); }
}
const FIT_PENDING = 'door-fit.preview-pending';
/** #2462: a refusal that a body caused (a resident seated in, in the way, using what the edit changes, sealed in): the
 *  building is left for a later boot, as one seated in always was. */
const bodyRefusal = (f: readonly Failure[] | undefined) => (f ?? []).some((x) => x.code.startsWith('body.'));

/** Review of #2438: the boot fits run while the world serves, so a fit is cut in slices, one building each (its own
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
      const { r } = await fitAct(god, fit.ops, note(fit.doors.length));
      if (r.accepted) { out.buildings++; out.doors += fit.doors.length; out.series.push(...fit.series); out.held.push(...fit.held, ...fit.named.map((n) => `${n} (held by name, DOOR_FIT_HELD)`)); out.fitted.push({ id: e.id, ...(e.name ? { name: e.name } : {}), ref: fit.ref, doors: fit.doors }); }
      else {
        const seated = bodyRefusal(r.failures);
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

// ---- #2434 door-fit/2: every remaining doorway a real door ----

/** What door-fit/2 did, beside door-fit/1's counts: doors turned to swing the other way (a prop in the first swing), props
 *  moved the shortest legal distance clear of a door's swings, and doors a hand still cannot work (no prop to move). */
export type DoorFit2Report = DoorFitReport & { flipped: string[]; moved: string[]; /** #2462: buildings not fitted, for good (named): their check could not run, or still cut off a way */ refused: string[]; /** #2462: door-fit/1 doors made their building's (`follow`) */ adopted: number };
const turned = (r: number) => { let v = r + Math.PI; while (v > Math.PI + 1e-6) v -= 2 * Math.PI; return Math.round(v * 1000) / 1000; };
/** Prop moves tried, nearest first: 0.25 m to 2.5 m in eight directions. */
const MOVES: Vec2[] = Array.from({ length: 10 }, (_, i) => (i + 1) * 0.25).flatMap((d) => Array.from({ length: 8 }, (_, k): Vec2 => [Math.round(Math.cos(k * Math.PI / 4) * d * 1000) / 1000, Math.round(Math.sin(k * Math.PI / 4) * d * 1000) / 1000]));

/** A rectangle on the ground (x, z): its middle, two unit axes and the half extents along them, and its height span. */
type Rect = { c: Vec2; u: Vec2; v: Vec2; h: Vec2; y0: number; y1: number };
const rectOf = (o: HandObstacle, d: Vec2 = [0, 0]): Rect => { const c = Math.cos(o.obb.yaw), s = Math.sin(o.obb.yaw); return { c: [o.obb.c[0] + d[0], o.obb.c[1] + d[1]], u: [c, s], v: [-s, c], h: o.obb.half, y0: o.y0, y1: o.y1 }; };
/** The gap (m) between two rectangles on the ground, 0 when they overlap (separating axes). */
function rectGap(a: Rect, b: Rect): number {
  let gap = 0;
  for (const ax of [a.u, a.v, b.u, b.v]) {
    const proj = (r: Rect) => Math.abs(r.u[0] * ax[0] + r.u[1] * ax[1]) * r.h[0] + Math.abs(r.v[0] * ax[0] + r.v[1] * ax[1]) * r.h[1];
    const d = Math.abs((b.c[0] - a.c[0]) * ax[0] + (b.c[1] - a.c[1]) * ax[1]) - proj(a) - proj(b);
    gap = Math.max(gap, d);
  }
  return gap;
}
const pointGap = (r: Rect, x: number, z: number) => { const dx = x - r.c[0], dz = z - r.c[1]; return Math.hypot(Math.max(0, Math.abs(dx * r.u[0] + dz * r.u[1]) - r.h[0]), Math.max(0, Math.abs(dx * r.v[0] + dz * r.v[1]) - r.h[1])); };
/** How far (m) to each side of a doorway its opening is kept clear of a moved prop (a body standing in it). */
const WAY_DEPTH = 0.5;
/** A doorway as a rectangle on the ground: its opening and a body's stand to each side. */
const wayRect = (w: Way): Rect => ({ c: w.p, u: [Math.cos(w.r), -Math.sin(w.r)], v: [Math.sin(w.r), Math.cos(w.r)], h: [w.width / 2, WAY_DEPTH], y0: w.y, y1: w.y + 2 });

/** The ops that move one world-root building `e` onto its every-doorway revision (ALL_DOORS_FROM) with a real door in each
 *  doorway that has none yet. A door a hand cannot work (doorHandBlocked, against the walk graph's solids with the
 *  building's own walls as the fit leaves them) is swung the other way; if both ways are blocked by a prop, the prop moves
 *  the shortest legal distance that frees the door. A door blocked by walls alone is held back, named. A prop moves only
 *  where it touches no body (with the body's radius), no other solid and no doorway of the building, and where every door
 *  of the building a hand could work before the move still can (review of #2438). */
function* fitOps2(god: GodMode, e: Entity, bodies: Vec2[], all: readonly HandObstacle[] | undefined, follow = false) {
  const m = god.model, wp = m.worldPose(e), base = wp.y;
  // review of #2438: only what stands near the building counts (its doors' hand checks reach 4 m out, a prop moves 2.5 m)
  const reachR = m.footprint(e).reduce((r, f) => Math.max(r, Math.hypot(f.c[0] - wp.x, f.c[1] - wp.z) + Math.hypot(f.half[0], f.half[1])), 0) || 30;
  const nearBuilding = (x: number, z: number, pad: number) => Math.hypot(x - wp.x, z - wp.z) < reachR + 8 + pad;
  const obstacles = all?.filter((o) => nearBuilding(o.obb.c[0], o.obb.c[1], Math.hypot(o.obb.half[0], o.obb.half[1])));
  bodies = bodies.filter(([x, z]) => nearBuilding(x, z, 1));
  const doorThings = [...m.entities.values()].filter((x) => (x.in.parent === 'world' || x.in.parent === e.id) && opRef(x.def) === DOOR_FIT_DOOR && (x.in.parent === e.id || (() => { const w = m.worldPose(x); return nearBuilding(w.x, w.z, 1); })()));
  const existingAt = (x: number, z: number, floor: number) => doorThings.find((t) => { const w = m.worldPose(t); return Math.hypot(w.x - x, w.z - z) < 0.15 && (floor === 0 ? Math.abs(w.y - base) < 1 : w.y > base + 1); });
  const existing = (x: number, z: number, floor: number) => !!existingAt(x, z, floor);
  const fit = doorFit(e.def, e.params as Record<string, unknown> | undefined, e.p, e.r, e.name, bodies, (n) => m.names.has(`world/${n}`), undefined, { baseY: base, existing, parent: e.id, follow })!;
  // the doors the building already has (door-fit/1's), in its doorways: a moved prop must leave them as a hand found them
  const kept = fit.ways.flatMap((w) => { const t = existingAt(w.p[0], w.p[1], w.floor); return t ? [t.id] : []; });
  // #2462 (`follow`): door-fit/1's world-root doors in the building's doorways become its children, the same id, state and
  // name in its frame, so a later edit that moves the building moves them with it
  const adopted = follow ? fit.ways.flatMap((w, k) => { const t = existingAt(w.p[0], w.p[1], w.floor), l = fit.local[k]; return t && l && t.in.parent === 'world' ? [{ t, l }] : []; }) : [];
  const adopt = adopted.flatMap(({ t, l }): Op[] => { const { anchor: _, ...x } = t; return [{ op: 'remove', id: t.id, cascade: true }, { op: 'restore', entity: { ...x, in: { parent: e.id }, p: [l.p[0], l.y, l.p[1]], r: l.r } }] as Op[]; });
  const sub = m.subtree(e.id).map((id) => m.entities.get(id)!);
  const moves: Op[] = [];
  // a prop of the building's own (in its subtree) moves after it is restored; any other before the building is
  const ownProp = (id: string) => sub.some((x) => x.id === id), outer = () => moves.filter((o) => !ownProp((o as { id: string }).id));
  // (review of #2438: a building's own prop is restored where it stood and then moved, so the engine takes the move in)
  const ops = () => [...outer(), { op: 'remove', id: e.id, cascade: true }, ...sub.map((x, k): Op => ({ op: 'restore', entity: k === 0 ? { ...x, def: storedRef(fit.ref) } : x }) as Op), ...moves.filter((o) => ownProp((o as { id: string }).id)), ...adopt, ...fit.doors] as Op[];
  const held: string[] = [], flipped: string[] = [], moved: string[] = [];
  /** Each prop move with the door it frees and where the prop stood (fitWorldDoorsV2 undoes one that cuts off a way). */
  const freed: { move: Op; door: PlaceOp; p0: number[]; text: string; label: string }[] = [];
  if (obstacles && fit.doors.length) {
    const own = (id: string) => id.startsWith(e.id + '#'), skipOwn = (id: string) => id.startsWith(e.id + '#door:');
    const shift = new Map<string, Vec2>();
    // the walk graph's solids with the building's walls as the fit leaves them, and a moved prop where it is moved to
    const solids = (next: WorldModel): HandObstacle[] => {
      const b = next.entities.get(e.id), out = obstacles.filter((o) => !own(o.id)).map((o) => { const d = shift.get(o.id.split('#')[0]!); return d ? { ...o, obb: { ...o.obb, c: [o.obb.c[0] + d[0], o.obb.c[1] + d[1]] as Vec2 } } : o; });
      if (b) out.push(...next.footprint(b).map((f, i) => ({ id: `${e.id}#fit${i}`, obb: { c: f.c, half: f.half, yaw: -f.yaw }, y0: f.y0, y1: f.y1 })));
      return out;
    };
    // one fork per way the doors swing (a big world's model is costly to fork): a moved prop changes only the solids a hand
    // meets, never where a door stands, so a prop's trial moves share the fork
    let memo: { key: string; next: WorldModel | null; doors: { id: string; x: number; z: number }[]; solids: HandObstacle[]; moves: string } | null = null, forked = false;
    const state = () => {
      const key = fit.doors.map((d) => `${d.name}:${d.r}`).join(',');
      if (memo?.key !== key) {
        forked = true;
        const next = m.fork(), r = applyBatch(next, { ops: ops() }, 'engine', 0, { trusted: true });
        memo = r.result.accepted
          ? { key, next, doors: (r.diff?.upserts ?? []).filter((y) => !m.entities.has(y.id) && opRef(y.def) === DOOR_FIT_DOOR).map((y) => { const w = next.worldPose(next.entities.get(y.id)!); return { id: y.id, x: w.x, z: w.z }; }), solids: [], moves: '' }
          : { key, next: null, doors: [], solids: [], moves: '' };
        if (memo.next) memo.solids = solids(memo.next);
      }
      const mk = JSON.stringify([...shift]);
      if (memo.next && memo.moves !== mk) { memo.solids = solids(memo.next); memo.moves = mk; }
      return memo;
    };
    const doorId = (k: number) => { const q = fit.at[k]!; return state().doors.find((y) => Math.hypot(y.x - q[0], y.z - q[1]) < 0.01)?.id; };
    const tryFit = (k: number, hit?: { id?: string }) => {
      const s = state(); if (!s.next) return 'refused';
      const id = doorId(k);
      return id ? doorHandBlocked(s.next, id, s.solids, skipOwn, hit) : null;
    };
    // the building's doorways as rectangles a moved prop keeps clear of: the opening and a body's stand to each side
    const wayRects = fit.ways.map((w): Rect & { w: Way } => ({ w, ...wayRect(w) }));
    /** Why prop `prop` may not stand shifted by world `d`: a body, another solid or a doorway it would touch (but the
     *  doorway of the door it is moved for, whose hand check is the judge there). */
    const propBlocked = (prop: string, d: Vec2, mine0: Way): string | null => {
      const mine = obstacles.filter((o) => o.id === prop || o.id.startsWith(prop + '#')).map((o) => rectOf(o, d));
      if (!mine.length) return null;
      for (const r of mine) {
        if (bodies.some(([x, z]) => pointGap(r, x, z) < HUMAN_RADIUS)) return 'a body';
        for (const o of state().solids) if (o.id !== prop && !o.id.startsWith(prop + '#') && o.y0 < r.y1 - 0.05 && r.y0 < o.y1 - 0.05 && rectGap(r, rectOf(o)) <= 0) return o.label ?? o.id;
        for (const w of wayRects) if (w.w !== mine0 && w.y0 < r.y1 - 0.05 && r.y0 < w.y1 && rectGap(r, w) <= 0) return 'a doorway';
      }
      return null;
    };
    // the driver may turn the event loop at each yield (review of #2438: a fork of a big world is costly)
    yield;
    for (let k = 0; k < fit.doors.length; k++) {
      const d = fit.doors[k]!, label = d.name ?? `${e.name ?? e.id} door ${k + 1}`;
      const hit: { id?: string } = {}, why = tryFit(k, hit);
      yield;
      if (!why || why === 'refused') continue;
      d.r = turned(d.r as number);   // swung the other way
      const hit2: { id?: string } = {}, why2 = tryFit(k, hit2);
      yield;
      if (!why2 || why2 === 'refused') { flipped.push(label); continue; }
      d.r = turned(d.r as number);
      // both ways blocked: the prop in the first swing moves the shortest legal distance that frees the door
      const prop = (hit.id ?? hit2.id ?? '').split('#')[0]!, pe = m.entities.get(prop);
      const movable = !!pe && prop !== e.id && opRef(pe.def) !== DOOR_FIT_DOOR && !BUILDING_REFS.has(opRef(pe.def)) && !ALL_DOORS_FROM.has(opRef(pe.def)) && ![...ALL_DOORS_FROM.values()].some((v) => v.ref === opRef(pe.def)) && !pe.shape;
      let free = false;
      if (movable) {
        // the doors placed so far and the building's own doors, as a hand finds them before the move
        const s0 = state(); yield;
        const others = [...Array.from({ length: k }, (_, j) => doorId(j)), ...kept].filter((x): x is string => !!x);
        const workable = s0.next ? others.filter((id) => !doorHandBlocked(s0.next!, id, s0.solids, skipOwn)) : [];
        const at0 = m.worldPose(pe!), p0 = Array.isArray(pe!.p) ? pe!.p as number[] : [at0.x, at0.z], py = pe!.in.parent === 'world' ? 0 : m.worldPose(m.entities.get(pe!.in.parent)!).yaw, pc = Math.cos(py), ps = Math.sin(py);
        for (const [dx, dz] of MOVES) {
          const dw: Vec2 = [dx * pc + dz * ps, -dx * ps + dz * pc];   // a child prop moves in its parent's frame
          if (propBlocked(prop, dw, fit.placed[k]!)) continue;
          const to = p0.length > 2 ? [p0[0]! + dx, p0[1]!, p0[2]! + dz] : [p0[0]! + dx, p0[1]! + dz];
          moves.push({ op: 'move', id: prop, p: to } as Op); shift.set(prop, dw);
          const s = state();
          yield;
          if (!tryFit(k) && workable.every((id) => !doorHandBlocked(s.next!, id, s.solids, skipOwn))) { const text = `${pe!.name ?? prop} moved ${Math.round(Math.hypot(dx, dz) * 100) / 100} m clear of ${label}`; moved.push(text); freed.push({ move: moves.at(-1)!, door: d, p0: [...p0], text, label }); free = true; break; }
          moves.pop(); shift.delete(prop);
        }
      }
      if (!free) { held.push(`${label} (${why})`); fit.doors.splice(k, 1); fit.at.splice(k, 1); fit.placed.splice(k, 1); k--; }
    }
  }
  // what the plan read: the edit is made only while these stand as they were (the world serves between slices)
  const read = [...sub, ...moves.map((o) => m.entities.get((o as { id: string }).id)!), ...adopted.map((a) => a.t)];
  return { ...fit, held, flipped, moved, moves, freed, adopted: adopted.length, ops: ops(), fresh: () => read.every((x) => m.entities.get(x.id) === x) && m.subtree(e.id).length === sub.length };
}

/** How long (ms) a slice of a boot fit runs before it turns the event loop (#2462: half #2433's 100 ms turn budget,
 *  as a step already begun runs on past it). */
const SLICE_MS = 50;
/** Runs generator `g` to its end, turning the event loop whenever a slice has held the thread `SLICE_MS`. */
async function sliced<T>(g: Generator<void, T>, what: string, o: FitSlices, pause: () => Promise<void>): Promise<T> {
  let t = performance.now();
  for (;;) {
    const r = g.next();
    if (r.done) { o.slice?.(performance.now() - t, what); return r.value; }
    if (performance.now() - t >= SLICE_MS) { o.slice?.(performance.now() - t, what); await pause(); t = performance.now(); }
  }
}

/** door-fit/2's reach check on the live engine (review of #2438): `settle` waits until the engine holds the last edit
 *  (#2462: false when it did not in time, and then nothing is judged on it); `front` is a standing point outside building
 *  `id`'s own ground-floor outside door, or (#2462) outside the first outside doorway of `ways` (its plan) when it has no
 *  door yet, null when it has neither; `reach` says whether a body walks from it to standing room near `to` at height `y`
 *  (null: no standing room there). Pure reads. */
export type DoorReach = { settle(): Promise<boolean>; front(id: string, ways?: readonly Way[]): Vec2 | null; reach(from: Vec2, to: Vec2, y: number, base: number): boolean | null;
  /** #2438: the seat and berth approaches near a point test (the walk audit's targets), and whether one is reached */
  seats?(near: (x: number, z: number) => boolean): { id: string; p: Vec2; level: number }[]; reachAt?(from: Vec2, p: Vec2, level: number): boolean;
  /** #2462: the bodies (a Soul's or a resident's) standing near a point test now, with their floor level and height */
  bodies?(near: (x: number, z: number) => boolean): { id: string; p: Vec2; level: number; y: number }[] };
/** How far (m) out from a door line its two sides are probed by the reach check. */
const REACH_FACE = 0.9;
const faces = (w: Way): [Vec2, Vec2] => [[w.p[0] + Math.sin(w.r) * REACH_FACE, w.p[1] + Math.cos(w.r) * REACH_FACE], [w.p[0] - Math.sin(w.r) * REACH_FACE, w.p[1] - Math.cos(w.r) * REACH_FACE]];
/** #2462: how often a fit waits for the engine to take its edit in (each wait up to DoorReach.settle's own bound). */
const SETTLE_TRIES = 3;

/** door-fit/2 (#2434) on `god`'s world: every world-root building on a revision before its every-doorway one (a first
 *  revision, or door-fit/1's) moves onto it, with a real door in each doorway that has none, building by building, one
 *  recorded edit and a few slices each (review of #2438; a refused one is left, named, for a later boot; a building fitted
 *  already is skipped, so a restart part way through goes on where it stopped). `bodies` (#2462: read again for each
 *  building, as a fit runs for minutes) are where bodies stand. With `walk`, the fit is checked on the engine after its
 *  edit (#2462): each side of each new door, each thing of the building (and where a moved prop stood), each seat and
 *  berth approach and each body near it that was reached from outside its front door before must be reached after. If
 *  one is not, the prop moves are undone first, then the new doors are taken out, the door whose side is cut (else the
 *  one nearest the front) first, one recorded edit each; if it is still cut off with every new door out, the building's
 *  whole fit is undone (refused, named: it keeps its drawn doorways). A building whose check cannot run (no outside
 *  doorway to walk from) is refused, named; one whose engine does not settle is undone and tried again at the next boot. */
export async function fitWorldDoorsV2(god: GodMode, bodies: Vec2[] | (() => Vec2[]), log: (m: string) => void = () => {}, obstacles?: readonly HandObstacle[], o: FitSlices & { walk?: DoorReach; follow?: boolean } = {}): Promise<DoorFit2Report> {
  const pause = o.pause ?? nextTurn, walk = o.walk, bodiesNow = () => typeof bodies === 'function' ? bodies() : bodies;
  const targets = [...god.model.entities.values()].filter((e) => e.in.parent === 'world' && ALL_DOORS_FROM.has(opRef(e.def))).map((e) => e.id);
  const out: DoorFit2Report = { buildings: 0, doors: 0, left: [], kept: [], series: [], held: [], fitted: [], flipped: [], moved: [], refused: [], adopted: 0 };
  if (!targets.length) return out;
  const note = (d: number) => `door-fit/2 (#2434): 1 building moved to its every-doorway revision, ${d} more real door(s) set in its doorways`;
  const settled = async () => { if (!walk) return true; for (let k = 0; k < SETTLE_TRIES; k++) if (await walk.settle()) return true; return false; };
  for (const id of targets) {
    let t = performance.now();
    const e = god.model.entities.get(id);
    if (!e || e.in.parent !== 'world' || !ALL_DOORS_FROM.has(opRef(e.def))) { o.slice?.(performance.now() - t, id); await pause(); continue; }
    const path = god.model.pathOf(id);
    // planned, the reach check's baseline taken, then the edit; planned again (up to three times) when the building or a
    // prop it moves changed in between (a resident took a thing, the god moved it: the world serves between slices)
    let fit!: ReturnType<typeof fitOps2> extends Generator<void, infer T> ? T : never, from: Vec2 | null = null, before: boolean[][] = [], fresh = false, lag = false;
    // the things of the building (every floor) and where a moved prop stood: a prop moved onto a stair's foot cuts off the
    // floors above, which no door's sides show (the old-town arcades); and its seats, berths and the bodies near it
    let probes: { p: Vec2; y: number }[] = [], probesBefore: boolean[] = [], seatsBefore: string[] = [], bodiesBefore: string[] = [], near: (x: number, z: number) => boolean = () => false;
    for (let attempt = 0; attempt < 3 && !fresh; attempt++) {
      const cur = god.model.entities.get(id);
      if (!cur || cur.in.parent !== 'world' || !ALL_DOORS_FROM.has(opRef(cur.def))) break;
      fit = await sliced(fitOps2(god, cur, bodiesNow(), obstacles, o.follow), `${id} plan`, o, pause); await pause();
      from = null; before = []; probes = []; probesBefore = []; seatsBefore = []; bodiesBefore = [];
      if (walk && fit.doors.length) {
        // #2462: a baseline read off an engine that has not taken the last edit in is the world from before it
        if (!(await settled())) { lag = true; break; }
        t = performance.now();
        from = walk.front(id, fit.ways);
        const base = god.model.worldPose(cur).y;
        o.slice?.(performance.now() - t, `${id} front`); await pause();
        if (from) {
          // one walk per slice: a long one across a big world takes a while
          for (const w of fit.placed) {
            const row: boolean[] = [];
            for (const f of faces(w)) { t = performance.now(); row.push(walk.reach(from, f, w.y, base) === true); o.slice?.(performance.now() - t, `${id} reach before`); await pause(); }
            before.push(row);
          }
          const sub = god.model.subtree(id), mv = fit.freed.map((f) => (f.move as { id: string }).id).filter((x) => !sub.includes(x));
          probes = [...sub.slice(1), ...new Set(mv)].map((x) => god.model.entities.get(x)).filter((x): x is Entity => !!x && opRef(x.def) !== DOOR_FIT_DOOR)
            .map((x) => { const q = god.model.worldPose(x); return { p: [q.x, q.z] as Vec2, y: q.y }; });
          for (const q of probes) { t = performance.now(); probesBefore.push(walk.reach(from, q.p, q.y, base) === true); o.slice?.(performance.now() - t, `${id} reach before`); await pause(); }
          const bw = god.model.worldPose(cur), rad = god.model.footprint(cur).reduce((r, f) => Math.max(r, Math.hypot(f.c[0] - bw.x, f.c[1] - bw.z) + Math.hypot(f.half[0], f.half[1])), 0) || 30;
          near = (x, z) => Math.hypot(x - bw.x, z - bw.z) < rad + 2;
          t = performance.now(); seatsBefore = walk.seats && walk.reachAt ? walk.seats(near).filter((q) => walk.reachAt!(from!, q.p, q.level)).map((q) => q.id) : []; o.slice?.(performance.now() - t, `${id} seats before`); await pause();
          t = performance.now(); bodiesBefore = walk.bodies && walk.reachAt ? walk.bodies(near).filter((q) => walk.reachAt!(from!, q.p, q.level)).map((q) => q.id) : []; o.slice?.(performance.now() - t, `${id} bodies before`); await pause();
        }
      }
      fresh = fit.fresh();
    }
    t = performance.now();
    if (lag) { out.kept.push(id); log(`door-fit/2: ${path} not fitted this boot: the engine had not taken the last edit in, so its reach could not be judged; tried again at the next boot`); o.slice?.(performance.now() - t, id); await pause(); continue; }
    if (!fresh) { out.kept.push(id); log(`door-fit/2: ${path} kept changing while it was planned, tried again at the next boot`); o.slice?.(performance.now() - t, id); await pause(); continue; }
    // #2462: a fit whose reach cannot be checked (no outside doorway to walk in from) is not made
    if (walk && fit.doors.length && !from) { out.refused.push(`${path} (no outside doorway to check its reach from)`); o.slice?.(performance.now() - t, id); await pause(); continue; }
    // #2462: a body standing in a doorway a door goes in now (the bodies read again just before the edit): a later boot
    const standing = walk?.bodies ? walk.bodies(() => true).map((b): [number, number, number] => [b.p[0], b.p[1], b.y]) : bodiesNow().map((b): [number, number, number] => [b[0], b[1], NaN]);
    const inWay = fit.placed.find((w) => standing.some(([x, z, y]) => (Number.isNaN(y) || Math.abs(y - w.y) < 1.5) && pointGap(wayRect(w), x, z) < HUMAN_RADIUS));
    if (inWay) { out.left.push(id); log(`door-fit/2: ${path} left for a later boot (a body stands in a doorway a door goes in, at ${inWay.p.map((n) => Math.round(n * 10) / 10).join(', ')})`); o.slice?.(performance.now() - t, id); await pause(); continue; }
    const { r, inverse, diff } = await fitAct(god, fit.ops, note(fit.doors.length));
    o.slice?.(performance.now() - t, `${id} edit`); await pause();
    if (!r.accepted) {
      const seated = bodyRefusal(r.failures);
      (seated ? out.left : out.kept).push(id);
      log(`door-fit/2: ${path} ${seated ? 'left for a later boot (a body in its way)' : 'keeps its revision this boot, tried again at the next'}: ${JSON.stringify(r.failures ?? []).slice(0, 300)}`);
      continue;
    }
    // every edit this fit made, so the whole of it can be undone, and what each left (review of #2462: the whole fit is
    // undone only while the building and what the fit changed stand as the fit left them, so nothing done since is lost)
    const edits: Op[][] = [inverse], mine = new Map<string, Entity | undefined>();
    let subAfter = '';
    const made = (d?: Diff) => { for (const x of d?.removes ?? []) mine.set(x, undefined); for (const x of d?.upserts ?? []) mine.set(x.id, god.model.entities.get(x.id)); subAfter = god.model.subtree(id).join(); };   // (a removed-and-restored id is an upsert)
    made(diff);
    const asLeft = () => god.model.subtree(id).join() === subAfter && [...mine].every(([k, v]) => god.model.entities.get(k) === v);
    /** Undoes the whole fit (a cleanup edit, tried up to three times while a Soul steps clear); false when it cannot be. */
    const undoAll = async (why: string) => {
      for (let k = 0; k < 3; k++) {
        if (!asLeft()) { log(`door-fit/2: ${path}'s fit should be undone (${why}) but the building changed since, so it is left as it is`); return false; }
        t = performance.now();
        const { r: ur } = await fitAct(god, edits.slice().reverse().flat(), `door-fit/2 (#2462): ${path}'s fit undone, ${why}`, { cleanup: true });
        o.slice?.(performance.now() - t, `${id} undo`); await pause();
        if (ur.accepted) { log(`door-fit/2: ${path}'s fit undone: ${why}`); return true; }
        log(`door-fit/2: ${path}'s fit should be undone (${why}) but could not be${k < 2 ? ', tried again' : ''}: ${JSON.stringify(ur.failures ?? []).slice(0, 300)}`);
        await settled();
      }
      return false;
    };
    /** A fit that cuts something off and cannot be undone is never counted as fitted: named, and the rules event waits. */
    const notUndone = (why: string): 'kept' => { out.refused.push(`${path} (${why}, and its fit could not be undone)`); return 'kept'; };
    const doors: (PlaceOp | null)[] = [...fit.doors];
    const findDoor = (d: PlaceOp, q: Vec2) => [...god.model.subtree(id).map((y) => god.model.entities.get(y)!), ...[...god.model.entities.values()].filter((y) => y.in.parent === 'world')]
      .find((y) => opRef(y.def) === DOOR_FIT_DOOR && (d.name ? y.name === d.name : (() => { const w = god.model.worldPose(y); return Math.hypot(w.x - q[0], w.z - q[1]) < 0.01; })()));
    let outcome: 'fitted' | 'kept' | 'left' | 'refused' = 'fitted';
    if (walk && from) {
      const dist = (k: number) => Math.hypot(fit.placed[k]!.p[0] - from![0], fit.placed[k]!.p[1] - from![1]);
      const order = doors.map((_, k) => k).sort((a, b) => dist(a) - dist(b) || a - b);
      /** The first thing reached before the fit and not now (a door's side names its door), or null. */
      const cutNow = async (): Promise<{ what: string; door?: number; body?: true } | null> => {
        const b = god.model.entities.get(id), base = b ? god.model.worldPose(b).y : 0;
        for (const k of order) {
          const fs = faces(fit.placed[k]!);
          for (let s = 0; s < 2; s++) {
            if (!doors[k] || !before[k]?.[s]) continue;
            t = performance.now(); const ok = walk.reach(from!, fs[s]!, fit.placed[k]!.y, base) === true; o.slice?.(performance.now() - t, `${id} reach after`); await pause();
            if (!ok) return { what: `a side of ${doors[k]!.name ?? `door ${k + 1}`}`, door: k };
          }
        }
        for (let k = 0; k < probes.length; k++) {
          if (!probesBefore[k]) continue;
          t = performance.now(); const ok = walk.reach(from!, probes[k]!.p, probes[k]!.y, base) === true; o.slice?.(performance.now() - t, `${id} reach after`); await pause();
          if (!ok) return { what: `a thing at ${probes[k]!.p.map((n) => Math.round(n * 10) / 10).join(', ')}` };
        }
        if (seatsBefore.length && walk.seats && walk.reachAt) {
          t = performance.now();
          const now = new Map(walk.seats(near).map((q) => [q.id, q])), sid = seatsBefore.find((x) => { const q = now.get(x); return !q || !walk.reachAt!(from!, q.p, q.level); });
          o.slice?.(performance.now() - t, `${id} seats after`); await pause();
          if (sid) return { what: `the approach of ${sid}` };
        }
        if (bodiesBefore.length && walk.bodies && walk.reachAt) {
          t = performance.now();
          const now = new Map(walk.bodies(near).map((q) => [q.id, q])), bid = bodiesBefore.find((x) => { const q = now.get(x); return !!q && !walk.reachAt!(from!, q.p, q.level); });
          o.slice?.(performance.now() - t, `${id} bodies after`); await pause();
          if (bid) return { what: `body ${bid}`, body: true };
        }
        return null;
      };
      for (;;) {
        if (!(await settled())) { const why = 'the engine had not taken it in, so its reach could not be judged'; outcome = (await undoAll(why)) ? 'kept' : notUndone(why); break; }
        const cut = await cutNow();
        if (!cut) break;
        // #2438: a prop moved clear of a door must not cut off anything reached before the fit: every prop this fit moved
        // goes back where it stood and the doors they were moved for are taken out, one recorded edit
        if (fit.freed.length) {
          t = performance.now();
          const undo: Op[] = [];
          for (const f of fit.freed) {
            undo.push({ op: 'move', id: (f.move as { id: string }).id, p: f.p0 } as Op);
            const k = doors.indexOf(f.door), x = k >= 0 ? findDoor(f.door, fit.placed[k]!.p) : undefined;
            if (x) undo.push({ op: 'remove', id: x.id } as Op);
          }
          const { r: ur, inverse: ui, diff: ud } = await fitAct(god, [...new Map(undo.map((u) => [JSON.stringify(u), u])).values()], `door-fit/2 (#2434): ${fit.freed.length} prop move(s) undone and the door(s) they freed taken out, a move cuts off a way reached before`, { cleanup: true });
          o.slice?.(performance.now() - t, `${id} undo moves`); await pause();
          if (!ur.accepted) { log(`door-fit/2: a prop move cuts off a way but could not be undone: ${JSON.stringify(ur.failures ?? []).slice(0, 300)}`); outcome = (await undoAll(`${cut.what} is cut off and the prop moves could not be undone`)) ? 'kept' : notUndone(`${cut.what} is cut off`); break; }
          edits.push(ui); made(ud);
          for (const f of fit.freed) {
            const k = doors.indexOf(f.door);
            if (k >= 0) { doors[k] = null; fit.held.push(`${f.label} (moving its prop clear cuts off a way reached before)`); }
            const j = fit.moved.indexOf(f.text); if (j >= 0) fit.moved.splice(j, 1);
          }
          fit.moves.length = 0; fit.freed.length = 0;
          continue;
        }
        // the door whose side is cut, else the one nearest the front, is taken out again
        const k = cut.door ?? order.find((j) => doors[j]);
        if (k === undefined) { outcome = (await undoAll(`${cut.what} is cut off with every new door out`)) ? (cut.body ? 'left' : 'refused') : notUndone(`${cut.what} is cut off with every new door out`); if (outcome === 'refused') out.refused.push(`${path} (${cut.what} is cut off with every new door out)`); break; }
        const d = doors[k]!, x = findDoor(d, fit.placed[k]!.p);
        t = performance.now();
        const { r: rr, inverse: ri, diff: rd } = x ? await fitAct(god, [{ op: 'remove', id: x.id } as Op], `door-fit/2 (#2434): ${d.name ?? x.id} taken out again, its frame cuts off a way reached before`, { cleanup: true }) : { r: { accepted: false, failures: [] } as Result, inverse: [], diff: undefined };
        o.slice?.(performance.now() - t, `${id} take out`); await pause();
        if (!rr.accepted) { log(`door-fit/2: ${d.name ?? '?'} cuts off ${cut.what} but could not be taken out: ${JSON.stringify((rr as { failures?: unknown }).failures ?? []).slice(0, 300)}`); outcome = (await undoAll(`${cut.what} is cut off and ${d.name ?? 'a door'} could not be taken out`)) ? 'kept' : notUndone(`${cut.what} is cut off`); break; }
        edits.push(ri); made(rd);
        fit.held.push(`${d.name ?? x!.id} (its frame cuts off ${cut.what}, reached before)`);
        doors[k] = null;
      }
    }
    if (outcome === 'kept') { out.kept.push(id); continue; }
    if (outcome === 'left') { out.left.push(id); continue; }
    if (outcome === 'refused') continue;
    const placed = doors.filter(Boolean) as PlaceOp[];
    out.buildings++; out.doors += placed.length; out.adopted += fit.adopted; out.held.push(...fit.held, ...fit.series.map((s) => `${s}: narrower than a door`), ...fit.named.map((n) => `${n} (held by name, DOOR_FIT_HELD)`)); out.flipped.push(...fit.flipped); out.moved.push(...fit.moved);
    out.fitted.push({ id: e.id, ...(e.name ? { name: e.name } : {}), ref: fit.ref, doors: placed, ...(fit.moves.length ? { moves: fit.moves } : {}) });
  }
  for (const h of out.flipped) log(`door-fit/2: swung the other way (a prop in the first swing): ${h}`);
  for (const h of out.moved) log(`door-fit/2: ${h}`);
  for (const h of out.held) log(`door-fit/2: held back: ${h}`);
  for (const h of out.refused) log(`door-fit/2: refused, keeps its drawn doorways: ${h}`);
  log(`door-fit/2: ${out.buildings} building(s) fitted, ${out.doors} door(s) placed, ${out.flipped.length} swung the other way, ${out.moved.length} prop(s) moved, ${out.held.length} held back${out.adopted ? `, ${out.adopted} door-fit/1 door(s) made their building's` : ''}${out.refused.length ? `, ${out.refused.length} refused` : ''}${out.kept.length ? `, ${out.kept.length} refused this boot` : ''}${out.left.length ? `, ${out.left.length} left for a later boot` : ''}`);
  return out;
}
