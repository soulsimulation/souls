import type {WorldHost} from './world.ts';
import { factoryDescriptorV1 } from './world-factory.ts';
import type { GodMode } from './god/god.ts';
import { fitWorldDoorsV1, type HandObstacle } from './god/door-fit.ts';

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
 *  quarantine/1, #1334 hold-settle/1, #1428 stair-way/1, #1440 quarantine-mark/1, #1454 stand-height/1, #1496 nonfinite-hold/1, #1521 stand-height/2, #1216 item-approach/1, #2196 park-away/1, #2133 stall-release-support/1, #1530 climb-spacing/1, #2294 held-activity/1, #2296 need-anchor/1, #1952 wait-bound/1, #1288 wait-bound/2, legal-edits/1, #2188 legal-edits/2 (over legal-edits/1), board-path/1, #2302 classroom-tv/1, #2155 wait-bound/3, #2426 cede-passage/1 and #2383 door-fit/1 (last; only with DOOR_FIT_BOOT=1) on every world. A failed edge rule does not keep the guard out. Hold-settle/1 comes
 *  after the guard (its settle stands bodies where the guard would) and after quarantine/1, which worlds booted on main
 *  already logged in that place. */
export async function adoptBootRuntimePoliciesV1(host: WorldHost, opts: { after?: Promise<unknown>; edge: boolean; worldKey: string; god?: () => GodMode | undefined; doorFit?: boolean }): Promise<void> {
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
  // #2383, off unless asked for (DOOR_FIT_BOOT=1): live-world door migration is off until a fit can run in slices under 1 s
  if (opts.doorFit ?? doorFitBoot()) await enableDoorFitV1(host, opts.god?.()).catch((e) => console.error('[world] door-fit/1 could not be adopted:', String(e).slice(0, 300)));
}

/** #2383 door-fit/1 at boot is opt-in: `DOOR_FIT_BOOT=1`. Off by default, because one building's fit edit can hold the world's
 *  thread for seconds (up to 15.9 s measured on Eden, past the serving watchdog), so a live world keeps its drawn doorways;
 *  templates, and so new worlds, carry the real doors already. */
export const doorFitBoot = (env: NodeJS.ProcessEnv = process.env): boolean => env.DOOR_FIT_BOOT === '1';

/** #2383 door-fit/1, once per world: its buildings on a revision that draws fixed door leaves move to their door-fitted
 *  revision with a real hand-operated door in each ground-floor doorway (god/door-fit.ts; one recorded engine edit per building, in slices),
 *  then one logged rules event marks it done. A building left (a resident seated in it) or refused keeps the event back,
 *  so the next boot fits what is left. A world without a god (no entity world) has nothing to fit and logs nothing. */
export function doorFitV1(host: Pick<WorldHost, 'extra'>): boolean { return (host.extra.runtimePolicy as { doorFitV1?: boolean } | undefined)?.doorFitV1 === true; }
export async function enableDoorFitV1(host: WorldHost, god: GodMode | undefined, author = 'operator:door-fit'): Promise<unknown> {
  if (doorFitV1(host) || !god) return;
  // the bodies standing about (a Soul's or a resident's), not every posed thing: a bench by a door does not hold it open
  const bodies = Object.values((host.engine.world as unknown as { entities: Record<string, { human?: unknown; pose?: { p?: number[] } }> }).entities)
    .flatMap((e): [number, number][] => e.human && e.pose?.p ? [[e.pose.p[0]!, e.pose.p[2]!]] : []);
  // the walk graph's solids as they stand: a door a hand cannot work for one of them is held back (door-fit.ts)
  const spatial = (host.engine as unknown as { rt?: { services?: { spatial?: { sync(w: unknown): void; scene: { obstacles: HandObstacle[] } } } } }).rt?.services?.spatial;
  spatial?.sync(host.engine.world);
  // review of #2438: in slices, one building at a time, while the world serves; the rules event once it is all done
  const r = await fitWorldDoorsV1(god, bodies, (m) => console.log(`[world] ${m}`), spatial?.scene.obstacles);
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
