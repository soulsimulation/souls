// arrival-search/1 (lane ARR, 2026-10-20): where a new Soul is born when the world's arrival point cannot take it.
//
// The default placement (the native placer's rings round the arrival point) is kept exactly wherever it works: a ready
// probe whose spot lies in the world's open walkable area is returned untouched, so births in ordinary worlds are
// bit-identical. Otherwise (built over, under water, walled in, crowded) the engine's arrival search names the nearest
// standing spot in the open area out to the world's bounds, else the nearest spot of the largest pocket; the birth then
// carries it as the existing birth-near/1 hint {at, first:true}, so the event records the exact place and replay never
// searches. Refused (birth.arrival-unavailable) only when the world has no standing ground at all.
import { nativeBirthPlacement, type ArrivalPocket, type ArrivalSpot, type NativeBirthPlacement } from '@souls/engine-mars';
import type { BirthNearV1 } from '@souls/engine-contract';
import { worldConfig } from './config.ts';
import type { WorldHost } from './world.ts';

type ArrivalEngine = { arrivalSearchV1?(label?: string): ArrivalSpot | null; arrivalPocketV1?(p: [number, number], label?: string): ArrivalPocket; arrivalBlockedV1?(): boolean };
export type BirthIdentity = { id: string; label: string; soul: string };
export type BirthPlan = { probe: NativeBirthPlacement; near?: { at: [number, number]; first: true } };

const engineOf = (host: WorldHost) => host.engine as unknown as ArrivalEngine;

/** The spot the arrival search would use instead of the default, or undefined when the default stands (see header). */
function searchFor(host: WorldHost, who: BirthIdentity, probe: NativeBirthPlacement): { at: [number, number]; first: true } | 'none' | undefined {
  const e = engineOf(host); if (!e.arrivalSearchV1 || !e.arrivalPocketV1) return undefined;
  let pocket: ArrivalPocket | undefined;
  if (probe.outcome === 'ready') {
    pocket = e.arrivalPocketV1([probe.position[0], probe.position[2]], who.label);
    if (pocket.open) return undefined;
  }
  const s = e.arrivalSearchV1(who.label);
  if (!s) return probe.outcome === 'ready' ? undefined : 'none';
  // a ready default in a pocket at least as large as anything the search found stays where it is
  if (pocket && !s.open && s.size <= pocket.size) return undefined;
  return { at: s.at, first: true };
}

/** Place a native birth, moving it off a blocked arrival point when needed. Read-only (on the live engine, A13). */
export function planNativeBirth(host: WorldHost, who: BirthIdentity): BirthPlan {
  const first = nativeBirthPlacement(host.engine, host.factory, who, worldConfig(host).env.SIM_BIRTH_PROBE);
  if (first.outcome !== 'ready' && !(first.outcome === 'unavailable' && first.diagnostic.code === 'birth.arrival-unavailable')) return { probe: first };
  const near = searchFor(host, who, first);
  if (near === undefined) return { probe: first };
  if (near === 'none') return { probe: first.outcome === 'unavailable' ? { ...first, diagnostic: { code: 'birth.arrival-unavailable', message: 'no free walkable ground in this world' } } : first };
  return { probe: nativeBirthPlacement(host.engine, host.factory, { ...who, near: near satisfies BirthNearV1 }, worldConfig(host).env.SIM_BIRTH_PROBE), near };
}

/** A direct create's birth-near/1 hint at the arrival point itself, without `first` (MarsEngine.arrivalCrowdV1): in a world
 *  with arrival-clearance/1 always, else once bodies and solids leave fewer than 24 ring spots, counting the births queued
 *  and not yet applied. Rings first as before; once bodies fill them, the nearest free standing ground, never a throw. */
export function crowdedArrivalNear(host: WorldHost): { at: [number, number] } | undefined {
  const at = (host.engine as unknown as { arrivalCrowdV1?(queued?: number): [number, number] | null }).arrivalCrowdV1?.(host.queuedBirthsV1());
  return at ? { at: [at[0], at[1]] } : undefined;
}

/** birth-near/1 at the arrival point whatever the crowd (a birth again after one that failed). */
export function arrivalPointNear(host: WorldHost): { at: [number, number] } | undefined {
  const at = (host.engine as unknown as { arrivalCrowdV1?(queued?: number, free?: number): [number, number] | null }).arrivalCrowdV1?.(0, Infinity);
  return at ? { at: [at[0], at[1]] } : undefined;
}

/** The cheap form for a direct (non-lifecycle) Soul create: the search's spot only when the world itself blocks the
 *  arrival point (built over, deep water, walled off), else nothing. No detached birth probe, so a create stays as cheap
 *  as it was; a crowd on a clear arrival point is left to the birth's own rings, as before. */
export function blockedArrivalNear(host: WorldHost): { at: [number, number]; first: true } | undefined {
  const e = engineOf(host); if (!e.arrivalBlockedV1?.() || !e.arrivalSearchV1) return undefined;
  const s = e.arrivalSearchV1(); return s ? { at: s.at, first: true } : undefined;
}

/** The god's arrival note (null when the arrival point is clear): the spot the arrival search names. Read-only and cheap
 *  (no detached birth probe: on bench-hamlet that probe alone took ~4 s, too slow for every god edit near the arrival). When
 *  the default rings still find room beside a small blocker, the Soul is born there instead, within a few metres of it. */
export function arrivalNote(host: WorldHost): string | null {
  const e = engineOf(host); if (!e.arrivalBlockedV1?.() || !e.arrivalSearchV1) return null;
  const s = e.arrivalSearchV1();
  if (!s) return 'Arrival point is blocked and this world has no free ground left; new Souls cannot arrive until some is cleared.';
  return `Arrival point is blocked; new Souls will arrive nearby at ${s.at[0].toFixed(1)}, ${s.at[1].toFixed(1)}.`;
}
