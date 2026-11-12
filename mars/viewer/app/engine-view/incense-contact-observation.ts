import type {HandActuatorMotion} from '../../engine/social/hand-actuator.ts';
import {actuatorHand, handActuatorFrame} from '../../engine/social/hand-actuator.ts';
import type {Take} from '../../engine/take/types.ts';
import type {IncenseFreeArmOwnership, IncenseTipContext} from './incense-tip-touch.ts';

export type IncenseContactRequest = {
  actor: string;
  motion: HandActuatorMotion;
  take: {id: string; startTick: number; endTick: number; dt: number};
  observedTick: number;
  nativeTarget: {def: string; kind: string; tags?: readonly string[];
    pose: {p: readonly number[]; yaw: number; pitch?: number; roll?: number}} | null;
  targetTracked: boolean;
};
export type IncenseDepiction = Pick<typeof import('./incense-tip-touch.ts'),
  'armUnderlay' | 'indexTipSkin' | 'incenseArmSkin' | 'poseIncenseTipTouch' | 'clearUnownedIncenseArm'>;
export type IncenseContactResolver = (request: IncenseContactRequest) => Readonly<IncenseTipContext & {depiction: IncenseDepiction}> | null;
export type IncenseContactObservation = {
  context: Readonly<IncenseTipContext>;
  ownership: {left: IncenseFreeArmOwnership; right: IncenseFreeArmOwnership};
  depiction: IncenseDepiction;
};
const empty = (v: unknown) => v === undefined || v === null || typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
const extra = ['carryContactV1', 'juggleV1', 'together'] as const;
const owners = ['grip', 'heldItemsV1', 'itemTransferV1', 'handTransferV1', 'wateringV1', 'cupV1', 'letGoV1',
  'sleepPose', 'prop', 'instrument', 'game', 'partner', 'handHold', 'rps', 'on', ...extra] as const;
const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** Complements the existing onset certificate only for additional recorded owner channels.
 * Fixed-field index built once per take; queries never sample or scan the world. */
export class IncenseExtraOwners {
  private actors = new Map<string, {initialClear: boolean; events: {tick: number; clear: boolean}[]}>();
  constructor(take: Take) {
    if (take.schema !== 'mars-take/4') return;
    for (const [id, e] of Object.entries(take.entities0 ?? {})) {
      if (e.kind !== 'human' || e.id !== id || !e.human) continue;
      const h = e.human as unknown as Record<string, unknown>;
      this.actors.set(id, {initialClear: empty(h.holding) && extra.every(k => empty(h[k])), events: []});
    }
    const state = new Map<string, Record<string, unknown>>();
    const last = new Map<string, number>();
    for (const [tick, id, key, value] of take.changes) {
      const actor = this.actors.get(id); if (!actor) continue;
      if (!Number.isInteger(tick) || tick < (last.get(id) ?? -Infinity)) {this.actors.delete(id); continue;}
      last.set(id, tick);
      if (!extra.includes(key as typeof extra[number]) && key !== 'present') continue;
      let s = state.get(id); if (!s) {s = {}; state.set(id, s);}
      s[key] = value;
      actor.events.push({tick, clear: s.present !== false && extra.every(k => empty(s[k]))});
    }
  }
  clear(actor: string, lower: number, upper = lower): boolean {
    const entry = this.actors.get(actor);
    if (!entry?.initialClear || !Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower) return false;
    const rows = entry.events;
    let lo = 0, hi = rows.length;
    while (lo < hi) {const mid = (lo + hi) >>> 1; if (rows[mid].tick <= lower) lo = mid + 1; else hi = mid;}
    if (lo && !rows[lo - 1].clear) return false;
    for (let i = lo; i < rows.length && rows[i].tick <= upper; i++) if (!rows[i].clear) return false;
    return true;
  }
}

/** Known complete recorded state only; missing fields on a flattened View are never evidence. */
export function incenseEmptyOwnership(state: Record<string, unknown>, hands: {left?: number[]; right?: number[]} | undefined,
  motion: HandActuatorMotion, itemPose: unknown, seconds: number): IncenseContactObservation['ownership'] | null {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Number.isFinite(seconds) ||
    !empty(itemPose) || owners.some(k => !empty(state[k]))) return null;
  const side = actuatorHand(motion.opening, motion.hand);
  if (hands && (Object.keys(hands).some(k => k !== side) || Object.values(hands).some(p => !triple(p)))) return null;
  const f = handActuatorFrame(motion, seconds);
  if (f.done && f.idleBlend >= 1) return null;
  const ownership = (hand: 'left' | 'right'): IncenseFreeArmOwnership => ({nativeTarget: hands?.[hand] ?? null,
    grip: null, heldItems: [], itemPose: null, cup: null, watering: null, transfer: null, handGame: null});
  return {left: ownership('left'), right: ownership('right')};
}
