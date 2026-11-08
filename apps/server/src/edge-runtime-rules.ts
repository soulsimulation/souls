import type {WorldHost} from './world.ts';

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
 *  quiet-seat courtesy event, when it queued one): the edge rules on an edge world, then #1332 body-step-guard/1 and #1369
 *  quarantine/1 on every world.
 *  A failed edge rule does not keep the guard out. */
export async function adoptBootRuntimePoliciesV1(host: WorldHost, opts: { after?: Promise<unknown>; edge: boolean; worldKey: string }): Promise<void> {
  await opts.after?.catch(() => undefined);
  if (opts.edge) await enableEdgeRuntimeRules(host, opts.worldKey).catch((e) => console.error('[world] an edge runtime rule could not be adopted:', String(e).slice(0, 300)));
  await host.enableBodyStepGuardV1('world').catch((e) => console.error('[world] body-step-guard/1 could not be adopted:', String(e).slice(0, 300)));
  await host.enableQuarantineV1('world');
}
