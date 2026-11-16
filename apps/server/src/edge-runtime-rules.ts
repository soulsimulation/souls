import type {WorldHost} from './world.ts';
import { factoryDescriptorV1 } from './world-factory.ts';
import type { GodMode } from './god/god.ts';
import { DOOR_FIT_DOOR, fitWorldDoorsV1, fitWorldDoorsV2, type DoorReach, type HandObstacle } from './god/door-fit.ts';
import { engineSettled } from './god/query.ts';
import { HUMAN_RADIUS } from '../../../mars/viewer/engine/world/catalog.ts';

/** Little Martians scene worlds: the old world (WORLD_KEY `littlemartians`, also its launcher fork) and the launcher's
 *  arium (slug `little-martians-arium`, as tools/world-launcher/op-souls.mjs names it). They are excluded from Soul
 *  features (Gene's standing rule), so edge startup does not turn on the stair-traffic rules there. */
export const LITTLE_MARTIANS_WORLD_KEYS: readonly string[] = Object.freeze(['littlemartians', 'little-martians-arium']);

/** The prospective runtime rules an edge world turns on at startup, in order. Each enable is idempotent (a world that
 *  already logged the rule queues nothing). The stair-traffic rules (occupiedLinkRoutingV1, concurrentLinkEgressV1,
 *  stairLandingClearanceV1) are not activated on the Little Martians worlds; every other world gets them in order.
 *  route-reach/1 (#872) is activated on every world: it only plans walks that were refused. */
export async function enableEdgeRuntimeRules(host: WorldHost, worldKey: string): Promise<void> {
  await host.enableQuietStallReleaseV1();
  await host.enableYieldTimeoutV1?.();
  await host.enableSpreadV2?.();
  await host.enableRouteReachV1?.();
  if (LITTLE_MARTIANS_WORLD_KEYS.includes(worldKey)) return;
  await host.enableOccupiedLinkRoutingV1?.();
  await host.enableConcurrentLinkEgressV1?.();
  await host.enableStairLandingClearanceV1?.();
}

/** The runtime-policy events a world adopts at boot, one after another: each event copies the policy before it, so two queued
 *  together would drop the earlier one's flag from the host's record and log it again at the next boot. After `after` (main's
 *  quiet-seat courtesy event, when it queued one): the edge rules on an edge world, then #1332 body-step-guard/1, #1369
 *  quarantine/1, #1334 hold-settle/1, #1428 stair-way/1, #1440 quarantine-mark/1, #1454 stand-height/1, #1496 nonfinite-hold/1, #1521 stand-height/2, #1216 item-approach/1, #2196 park-away/1, #2133 stall-release-support/1, #1530 climb-spacing/1, #2294 held-activity/1, #2296 need-anchor/1, #1952 wait-bound/1, #1288 wait-bound/2, legal-edits/1, #2188 legal-edits/2 (over legal-edits/1), board-path/1, #2302 classroom-tv/1, #2155 wait-bound/3, #2426 cede-passage/1, #2383 door-fit/1 and #2434 door-fit/2 (last) on every world. A failed edge rule does not keep the guard out. Hold-settle/1 comes
 *  after the guard (its settle stands bodies where the guard would) and after quarantine/1, which worlds booted on main
 *  already logged in that place. */
export async function adoptBootRuntimePoliciesV1(host: WorldHost, opts: { after?: Promise<unknown>; edge: boolean; worldKey: string; god?: () => GodMode | undefined; doorFit?: boolean; /** #2462: hears the door fits' own promise (they run on after the boot rules) */ doorFits?: (p: Promise<void>) => void }): Promise<void> {
  await opts.after?.catch(() => undefined);
  if (opts.edge) await enableEdgeRuntimeRules(host, opts.worldKey).catch((e) => console.error('[world] an edge runtime rule could not be adopted:', String(e).slice(0, 300)));
  await host.enableBodyStepGuardV1('world').catch((e) => console.error('[world] body-step-guard/1 could not be adopted:', String(e).slice(0, 300)));
  await host.enableQuarantineV1('world').catch((e) => console.error('[world] quarantine/1 could not be adopted:', String(e).slice(0, 300)));
  await host.enableRefusalSettleV1('world').catch((e) => console.error('[world] hold-settle/1 could not be adopted:', String(e).slice(0, 300)));   // #1334, after the guard: its settle stands bodies where the guard would
  await host.enableStairWayV1('world').catch((e) => console.error('[world] stair-way/1 could not be adopted:', String(e).slice(0, 300)));   // #1428
  await host.enableQuarantineMarkV1('world').catch((e) => console.error('[world] quarantine-mark/1 could not be adopted:', String(e).slice(0, 300)));   // #1440
  await host.enableStandHeightV1('world');   // #1454: each event copies the policy before it
  await host.enableNonFiniteHoldV1('world').catch((e) => console.error('[world] nonfinite-hold/1 could not be adopted:', String(e).slice(0, 300)));   // #1496
  await host.enableStandHeightV2('world').catch((e) => console.error('[world] stand-height/2 could not be adopted:', String(e).slice(0, 300)));   // #1521
  await host.enableItemApproachV1('world').catch((e) => console.error('[world] item-approach/1 could not be adopted:', String(e).slice(0, 300)));   // #1216
  await host.enableCarrierParkAwayV1('world').catch((e) => console.error('[world] park-away/1 could not be adopted:', String(e).slice(0, 300)));   // #2196
  await host.enableStallReleaseSupportV1('world').catch((e) => console.error('[world] stall-release-support/1 could not be adopted:', String(e).slice(0, 300)));   // #2133
  await host.enableClimbSpacingV1('world').catch((e) => console.error('[world] climb-spacing/1 could not be adopted:', String(e).slice(0, 300)));   // #1530
  await host.enableHeldActivitiesV1('world').catch((e) => console.error('[world] held-activity/1 could not be adopted:', String(e).slice(0, 300)));   // #2294
  await host.enableNeedAnchorsV1('world').catch((e) => console.error('[world] need-anchor/1 could not be adopted:', String(e).slice(0, 300)));   // #2296
  await host.enableWaitBoundV1('world').catch((e) => console.error('[world] wait-bound/1 could not be adopted:', String(e).slice(0, 300)));   // #1952
  await host.enableWaitBoundV2('world').catch((e) => console.error('[world] wait-bound/2 could not be adopted:', String(e).slice(0, 300)));   // #1288
  // legal-edits/1 needs the off-thread preview, which rebuilds the world's factory from its descriptor: a world without one
  // (Eden core reads its history from the database) would refuse every god edit, so it keeps the rules it has
  if (factoryDescriptorV1(host.factory)) await enableLegalEditsV1(host, 'world').catch((e) => console.error('[world] legal-edits/1 could not be adopted:', String(e).slice(0, 300)));   // legal by construction 1b
  await enableLegalEditsV2(host, 'world').catch((e) => console.error('[world] legal-edits/2 could not be adopted:', String(e).slice(0, 300)));   // #2188 (only over legal-edits/1)
  await host.enableCarrierBoardPathV1('world').catch((e) => console.error('[world] board-path/1 could not be adopted:', String(e).slice(0, 300)));   // board-path/1
  await host.enableClassroomTvV1('world').catch((e) => console.error('[world] classroom-tv/1 could not be adopted:', String(e).slice(0, 300)));   // #2302
  await host.enableWaitBoundV3('world').catch((e) => console.error('[world] wait-bound/3 could not be adopted:', String(e).slice(0, 300)));   // #2155
  await host.enableCedePassageV1('world').catch((e) => console.error('[world] cede-passage/1 could not be adopted:', String(e).slice(0, 300)));   // #2426
  // #2383 and #2434, last, and opt-in (`doorFit`: the world config's doorFitBoot, DOOR_FIT_BOOT=1). Off by default until it
  // is switched on per world (docs/design/door-fit-live.md); templates, and so new worlds, carry the real doors already.
  // #2462: the fits run on after the boot rules, in slices, so nothing after them (the classroom TV) waits minutes for them
  if (opts.doorFit) {
    // #2462 (A3): a live world runs door-fit/2 alone. It fits every building door-fit/1 would (a first revision moves
    // straight to its every-doorway revision, its outside doors with the rest) and checks each fit, which door-fit/1
    // never did: on bench-eden door-fit/1 alone cut off 19 places. A world door-fit/1 already fitted keeps its doors
    const fits = (async () => {
      await enableDoorFitV2(host, opts.god?.()).catch((e) => console.error('[world] door-fit/2 could not be adopted:', String(e).slice(0, 300)));
    })();
    opts.doorFits?.(fits);
  }
}

/** #2462: how long (ms) one turn of a fit may hold the world's thread (#2433's turn budget); a longer one is logged. */
export const DOOR_FIT_TURN_MS = 100;
/** A fit's slice hook: logs each turn over the budget and keeps the longest, for the fit's summary line. */
function fitTurns(rule: string) {
  const longest = { ms: 0, what: '' }, over: string[] = [];
  return { longest, over, slice: (ms: number, what: string) => { if (ms > longest.ms) { longest.ms = ms; longest.what = what; } if (ms > DOOR_FIT_TURN_MS) { over.push(what); console.log(`[world] ${rule}: one turn held the thread ${Math.round(ms)} ms (${what})`); } },
    line: () => `[world] ${rule}: longest turn ${Math.round(longest.ms)} ms (${longest.what}), ${over.length} over ${DOOR_FIT_TURN_MS} ms` };
}
/** The bodies standing about (a Soul's or a resident's), not every posed thing: a bench by a door does not hold it open. */
const standingBodies = (host: WorldHost) => () => Object.values((host.engine.world as unknown as { entities: Record<string, { human?: unknown; pose?: { p?: number[] } }> }).entities)
  .flatMap((e): [number, number][] => e.human && e.pose?.p ? [[e.pose.p[0]!, e.pose.p[2]!]] : []);

/** #2434 door-fit/2, once per world, after door-fit/1: its buildings move to their every-doorway revision with a real
 *  hand-operated door in every doorway that has none (inside, upstairs, the courtyard doors door-fit/1 held back in
 *  series, and those a hand could not work: swung the other way, or a prop moved clear), one recorded engine edit, then
 *  one logged rules event. A building left or refused keeps the event back for the next boot, as door-fit/1. */
export function doorFitV2(host: Pick<WorldHost, 'extra'>): boolean { return (host.extra.runtimePolicy as { doorFitV2?: boolean } | undefined)?.doorFitV2 === true; }
export async function enableDoorFitV2(host: WorldHost, god: GodMode | undefined, author = 'operator:door-fit'): Promise<unknown> {
  if (doorFitV2(host) || !god) return;
  const spatial = (host.engine as unknown as { rt?: { services?: { spatial?: { sync(w: unknown): void; scene: { obstacles: HandObstacle[] } } } } }).rt?.services?.spatial;
  spatial?.sync(host.engine.world);
  // review of #2438: in slices, one building at a time, while the world serves; the rules event once it is all done
  // #2462: the bodies are read again for each building; outside doors are the building's own, so they follow it
  const turns = fitTurns('door-fit/2');
  const r = await fitWorldDoorsV2(god, standingBodies(host), (m) => console.log(`[world] ${m}`), spatial?.scene.obstacles, { walk: engineDoorReach(host, god), follow: true, slice: turns.slice });
  console.log(turns.line());
  if (r.left.length || r.kept.length) return;
  return host.enqueue('rules', author, { runtimePolicy: { sleepBlockTicks: 1200, ...host.extra.runtimePolicy as object, doorFitV2: true }, doorFitV2: { buildings: r.buildings, doors: r.doors, flipped: r.flipped.length, moved: r.moved.length, held: r.held.length, ...(r.refused.length ? { refused: r.refused.slice(0, 64) } : {}) },
    why: 'door-fit/2 (#2434): every remaining building doorway (inside, upstairs, in series, by a prop) holds a real door a Soul opens by hand; fitted by a recorded engine edit just before this event' });
}

type ReachEngine = { world: unknown; rt?: { services?: { spatial?: { sync(w: unknown): void; scene: { levels: { id: number; y: number }[] } } } };
  standableNearV1?(at: [number, number], level?: number, except?: string, minClear?: number, maxRing?: number): [number, number] | null;
  reachV1?(from: { p: [number, number]; level?: number }, to: { p: [number, number]; level?: number }): { ok: boolean };
  navTargetsV1?(keep?: (at: [number, number]) => boolean): { id: string; kind: string; p: [number, number]; level?: number }[] };
/** door-fit/2's reach check on this world's engine (review of #2438): pure reads, after the engine holds the last edit. */
export function engineDoorReach(host: WorldHost, god: GodMode): DoorReach | undefined {
  const engine = host.engine as unknown as ReachEngine, sp = engine.rt?.services?.spatial;
  if (!engine.reachV1 || !engine.standableNearV1 || !sp) return undefined;
  const opRef = (d: string) => d.replace(/^core-/, 'core/');
  // a door counts on the ground, or on an upper level near its height. Levels are many and close in height (each
  // building's floors), so the nearest by height may be another building's: each is tried, nearest first, and the first
  // with standing room at the point is the one (#2438 fix: an arcade's upstairs was probed on a neighbour's level, so a
  // prop move that cut it off went unseen)
  const levelsAt = (y: number, base: number) => y < base + 1 ? [0] : sp.scene.levels.filter((l) => l.id !== 0 && Math.abs(l.y - y) <= 0.6).sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y) || a.id - b.id).map((l) => l.id);
  return {
    settle: () => engineSettled(god.model, 10000),
    front(id, ways) {
      const b = god.model.entities.get(id); if (!b) return null;
      const bw = god.model.worldPose(b);
      // #2462: the first outside ground-floor doorway its fit plans (a door stands in it as the doorway does, or none yet:
      // the review found a building with no outside door yet got no check), else its own door-fit/1 outside door
      const way = ways?.find((x) => x.exterior && x.floor === 0);
      const d = way || !b.name ? undefined : [...god.model.entities.values()].filter((x) => x.in.parent === 'world' && opRef(x.def) === DOOR_FIT_DOOR && (x.name ?? '').startsWith(`${b.name}-door-`))
        .sort((x, y) => (x.name! < y.name! ? -1 : 1))[0];
      if (!d && !way) return null;
      const w = way ? { x: way.p[0], z: way.p[1], yaw: way.r } : god.model.worldPose(d!), n: [number, number] = [Math.sin(w.yaw) * 1.3, Math.cos(w.yaw) * 1.3];
      const p: [number, number] = [w.x + n[0], w.z + n[1]], q: [number, number] = [w.x - n[0], w.z - n[1]];
      return engine.standableNearV1!(Math.hypot(p[0] - bw.x, p[1] - bw.z) > Math.hypot(q[0] - bw.x, q[1] - bw.z) ? p : q, 0, undefined, HUMAN_RADIUS + 0.05, 6);
    },
    reach(from, to, y, base) {
      for (const level of levelsAt(y, base)) {
        const s = engine.standableNearV1!(to, level, undefined, HUMAN_RADIUS + 0.05, 3);
        if (s) return engine.reachV1!({ p: from, level: 0 }, { p: s, level }).ok;
      }
      return null;
    },
    // #2438: the seats and berths the walk audit checks (their approach points), so a prop moved onto a seat's way is seen
    seats: (near) => (engine.navTargetsV1?.((at) => near(at[0], at[1])) ?? []).filter((x) => x.kind !== 'region').map((x) => ({ id: x.id, p: x.p, level: x.level ?? 0 })),
    reachAt: (from, p, level) => engine.reachV1!({ p: from, level: 0 }, { p, level }).ok,
    // #2462: the bodies standing near now, on their floor
    bodies: (near) => Object.entries((engine.world as { entities: Record<string, { human?: { level?: number }; pose?: { p?: number[] } }> }).entities)
      .flatMap(([id, e]) => e.human && e.pose?.p && near(e.pose.p[0]!, e.pose.p[2]!) ? [{ id, p: [e.pose.p[0]!, e.pose.p[2]!] as [number, number], level: e.human.level ?? 0, y: e.pose.p[1] ?? 0 }] : []),
  };
}

/** #2383 door-fit/1, once per world: its buildings on a revision that draws fixed door leaves move to their door-fitted
 *  revision with a real hand-operated door in each ground-floor doorway (god/door-fit.ts; one recorded engine edit per building, in slices),
 *  then one logged rules event marks it done. A building left (a resident seated in it) or refused keeps the event back,
 *  so the next boot fits what is left. A world without a god (no entity world) has nothing to fit and logs nothing. */
export function doorFitV1(host: Pick<WorldHost, 'extra'>): boolean { return (host.extra.runtimePolicy as { doorFitV1?: boolean } | undefined)?.doorFitV1 === true; }
export async function enableDoorFitV1(host: WorldHost, god: GodMode | undefined, author = 'operator:door-fit'): Promise<unknown> {
  if (doorFitV1(host) || !god) return;
  const bodies = standingBodies(host)();
  // the walk graph's solids as they stand: a door a hand cannot work for one of them is held back (door-fit.ts)
  const spatial = (host.engine as unknown as { rt?: { services?: { spatial?: { sync(w: unknown): void; scene: { obstacles: HandObstacle[] } } } } }).rt?.services?.spatial;
  spatial?.sync(host.engine.world);
  // review of #2438: in slices, one building at a time, while the world serves; the rules event once it is all done
  const turns = fitTurns('door-fit/1');
  const r = await fitWorldDoorsV1(god, bodies, (m) => console.log(`[world] ${m}`), spatial?.scene.obstacles, { slice: turns.slice });
  console.log(turns.line());
  // a building left (seated in) or refused this boot is tried again at the next: the event waits for both
  if (r.left.length || r.kept.length) return;
  return host.enqueue('rules', author, { runtimePolicy: { sleepBlockTicks: 1200, ...host.extra.runtimePolicy as object, doorFitV1: true }, doorFitV1: { buildings: r.buildings, doors: r.doors, series: r.series.length, held: r.held.length },
    why: 'door-fit/1 (#2383): every building doorway holds a real door a Soul opens by hand; the buildings and doors were fitted by a recorded engine edit just before this event' });
}

/** Legal by construction 1b (docs/design/legal-by-construction.md part 1): legal-edits/1, one logged rules event (prospective,
 *  host-only: the engine never reads it, so no snapshot binding changes). From it on, a god edit, undo or redo whose off-thread
 *  preview breaks a rule on a Soul, or that changes what a Soul sits, lies on or holds, is refused, naming the body, the rule
 *  and the nearest legal place; nobody is walked out. Batches before the event replay as recorded. Repeated calls are no-ops. */
export function legalEditsV1(host: Pick<WorldHost, 'extra'>): boolean { return (host.extra.runtimePolicy as { legalEditsV1?: boolean } | undefined)?.legalEditsV1 === true; }
export function enableLegalEditsV1(host: WorldHost, author = 'operator:legal-edits'): Promise<unknown> {
  if (legalEditsV1(host)) return Promise.resolve();
  return host.enqueue('rules', author, { runtimePolicy: { sleepBlockTicks: 1200, ...host.extra.runtimePolicy as object, legalEditsV1: true }, why: 'legal-edits/1 (legal by construction 1b): a god edit that would break a rule on a Soul, or change what one uses, is refused by name, never walked out; retain historical replay before this event' });
}
/** #2188 legal-edits/2, one logged rules event over legal-edits/1 (prospective and host-only, like it): from it on, a god edit,
 *  undo or redo that would leave a Soul on the ground with no walk out (sealed in a pocket nav-connect/1 would step her out
 *  of, for example by the last wall of a ring closed round her at a distance) is refused by name before it commits
 *  (god/seal-check.ts). Edits before the event keep legal-edits/1's verdicts. A world without legal-edits/1 does not adopt it. */
export function legalEditsV2(host: Pick<WorldHost, 'extra'>): boolean { return legalEditsV1(host) && (host.extra.runtimePolicy as { legalEditsV2?: boolean } | undefined)?.legalEditsV2 === true; }
export function enableLegalEditsV2(host: WorldHost, author = 'operator:legal-edits'): Promise<unknown> {
  if (!legalEditsV1(host) || legalEditsV2(host)) return Promise.resolve();
  return host.enqueue('rules', author, { runtimePolicy: { sleepBlockTicks: 1200, ...host.extra.runtimePolicy as object, legalEditsV2: true }, why: 'legal-edits/2 (#2188): a god edit that would leave a Soul with no walk out is refused by name before it commits; retain historical replay before this event' });
}
