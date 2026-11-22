// Which sounds are heard at a world time, and where (V21, #2765): a function of the record and the time, as a pose is
// (V7), so live and replay agree and a seek needs nothing remembered. Pure, tested under Node. Carried over from
// today's `apps/web/src/gen-mesh/sound-plan.ts` in what it decides (a kind's sounds, fall-off with distance, the
// loudest few heard); changed in where it reads them: a thing's sounds from its kind in the page's copy (`kinds.json`,
// made from today's defs), and what happens from the record's rows (`record.ts`) and its bodies' motion samples.
//
// - **Things** sound for as long as they stand (a fountain, a wood, a windmill); a loop's phase is world time modulo
//   its length, so the same moment sounds the same however it was reached.
// - **What happens** sounds once, from its world time: a door opening or shutting (its open field set), a named event
//   that has a sound, a footstep. A sound is heard from its start for its length; reached part-way (a seek into it) it
//   is heard from that point, and once it has ended it is never heard again.
// - **Footsteps** are where a walking body's sampled path crosses each stride (STRIDE), timed between its samples.
// - **Far sources give way first**: only sources within their reach are heard, the loudest MAX_SHOTS one-shots and
//   MAX_LOOPS loops, so a thousand walkers are a few footsteps near the listener.
import table from './kinds.json' with { type: 'json' };
import { LOOP_SECONDS, LOOPS, SHOTS, type LoopSound, type ShotSound } from './synth.ts';
import type { Happened } from './record.ts';

export type Spec = { kind: string; radius: number; volume: number; when?: string; variant?: number };
export const KINDS = table.kinds as Record<string, Spec[]>;
/** A sound of the record: what is heard, how far (m) and how loud at its source. */
export type Shot = { sound: ShotSound; radius: number; volume: number };
/** Field sets that sound, by kind and field number: imported Eden's doors (import-eden's field 6, open 1 / shut 0). */
export const FIELD_SOUNDS: Record<string, Record<number, { on: Shot; off: Shot }>> = {
  'core:door': { 6: { on: { sound: 'door-open', radius: 18, volume: 0.6 }, off: { sound: 'door-shut', radius: 22, volume: 0.7 } } },
};
/** Named events that sound, by name: a body sitting down, pressing, putting down or taking. */
export const EVENT_SOUNDS: Record<string, Shot> = {
  'souls:seated': { sound: 'thud', radius: 10, volume: 0.35 },
  'souls:press': { sound: 'click', radius: 8, volume: 0.4 },
  'souls:put': { sound: 'thud', radius: 8, volume: 0.3 },
  'souls:take': { sound: 'click', radius: 8, volume: 0.3 },
};
export const STEP: Shot = { sound: 'step', radius: 14, volume: 0.32 };
/** A stride, µm; a walking body steps each time its path crosses one. Faster than RUN_MOST between samples is a cut,
 *  not a walk, and steps nothing. */
export const STRIDE = 700_000, RUN_MOST = 6;
export const MAX_SHOTS = 12, MAX_LOOPS = 8;

/** A sound that happens once: its key, world time µs, the node it sounds at, and what it is. */
export type Sounding = { key: string; at: number; node: string; shot: Shot; variant: number; local?: [number, number, number] };
/** A thing's lasting sound: its key, where (m, world), what, and, for an area, its outline (m, world `[x, z]`). */
export type Lasting = { key: string; pos: [number, number, number]; area?: [number, number][]; spec: Spec };
/** What is heard now: a key, the sound, the voicing, where, how loud at the listener, and how far into the sound
 *  (s) it is at the time asked. */
export type Heard = { key: string; sound: ShotSound | LoopSound; loop: boolean; variant: number; pos: [number, number, number]; gain: number; offset: number; at: number };

export const plain = (kind: string) => kind.split('@')[0];
/** A kind's name without its namespace: the table was written from today's `core:` defs, and full Eden's import names
 *  the same kinds `eden:` (#3690), so a kind is found by its own name under any namespace. */
const bare = (kind: string) => plain(kind).slice(plain(kind).indexOf(':') + 1);
const byName = <T>(t: Record<string, T>) => new Map(Object.entries(t).map(([k, v]) => [bare(k), v]));
const KINDS_BY_NAME = byName(KINDS), FIELDS_BY_NAME = byName(FIELD_SOUNDS);
/** The sounds of a kind (any namespace, any revision), or none. */
export const kindSounds = (kind: string): Spec[] => KINDS[plain(kind)] ?? KINDS_BY_NAME.get(bare(kind)) ?? [];
const fieldSounds = (kind: string) => FIELD_SOUNDS[plain(kind)] ?? FIELDS_BY_NAME.get(bare(kind));
const hash = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
/** Loudness 0..1 at distance `d` m: a smooth fall to 0 at the radius (sound-plan's `falloff`). */
export const falloff = (d: number, radius: number, volume: number) => (d >= radius ? 0 : volume * (1 - d / radius) ** 2);
const isLoop = (k: string): k is LoopSound => (LOOPS as readonly string[]).includes(k);

/** The sounds among a part's rows, by the kind of the node each row names (`kindOf`). */
export function soundsOf(rows: readonly Happened[], kindOf: (node: string) => string | undefined): Sounding[] {
  const out: Sounding[] = [];
  for (const r of rows) {
    let shot: Shot | undefined;
    if (r.name !== undefined) shot = EVENT_SOUNDS[r.name];
    else if (r.field !== undefined) {
      const f = fieldSounds(kindOf(r.node) ?? '')?.[r.field];
      if (f && Number.isFinite(r.to)) shot = r.to ? f.on : f.off;
    }
    if (shot) out.push({ key: `${r.at}:${r.node}:${r.name ?? r.field}`, at: r.at, node: r.node, shot, variant: hash(r.node) % 4 });
  }
  return out;
}

/** Footsteps from bodies' motion samples (`[node, frame node, slot, at µs, x, y, z µm]`), in the order recorded. Each
 *  body's distance is counted from its first sample seen; a change of frame starts it again. */
export class Steps {
  private last = new Map<string, { frame: string; at: number; p: [number, number, number]; walked: number }>();
  add(samples: readonly (readonly [string, string, number | null, number, number, number, number])[]): Sounding[] {
    const out: Sounding[] = [];
    for (const [node, parent, slot, at, x, y, z] of samples) {
      const frame = `${parent}/${slot}`, prev = this.last.get(node), p: [number, number, number] = [x, y, z];
      if (!prev || prev.frame !== frame || at <= prev.at) { if (!prev || at >= prev.at) this.last.set(node, { frame, at, p, walked: 0 }); continue; }
      const d = Math.hypot(x - prev.p[0], z - prev.p[2]);
      if (d / (at - prev.at) > RUN_MOST) { this.last.set(node, { frame, at, p, walked: 0 }); continue; }
      let walked = prev.walked;
      for (let next = (Math.floor(walked / STRIDE) + 1) * STRIDE; next <= walked + d; next += STRIDE) {
        const k = (next - walked) / d, when = Math.round(prev.at + k * (at - prev.at));
        const n = Math.round(next / STRIDE);
        out.push({ key: `step:${node}:${when}`, at: when, node: parent, shot: STEP, variant: (hash(node) + n) % 4, local: [prev.p[0] + k * (x - prev.p[0]), prev.p[1] + k * (y - prev.p[1]), prev.p[2] + k * (z - prev.p[2])] });
      }
      this.last.set(node, { frame, at, p, walked: walked + d });
    }
    return out;
  }
}

/** A thing's lasting sounds, from its kind; `day` false hears the night's (crickets, frogs) and not the day's. */
export function lastingOf(id: string, kind: string, pos: [number, number, number], area?: [number, number][]): Lasting[] {
  return kindSounds(kind).map((spec, i) => ({ key: `${id}#${i}`, pos, area, spec }));
}

/** Distance in m from the listener to a source: a point, or an area's outline (0 inside). */
export function distance(l: readonly [number, number, number], pos: readonly [number, number, number], area?: readonly [number, number][]): number {
  if (!area || area.length < 3) return Math.hypot(pos[0] - l[0], pos[1] - l[1], pos[2] - l[2]);
  let best = Infinity, inside = false;
  for (let i = 0; i < area.length; i++) {
    const a = area[i], b = area[(i + 1) % area.length], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const t = L > 0 ? Math.max(0, Math.min(1, ((l[0] - a[0]) * dx + (l[2] - a[1]) * dz) / L)) : 0;
    best = Math.min(best, Math.hypot(a[0] + dx * t - l[0], a[1] + dz * t - l[2]));
    if ((a[1] > l[2]) !== (b[1] > l[2]) && l[0] < a[0] + ((l[2] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
  }
  return inside ? 0 : best;
}

/** What is heard at world time `t` µs from `listener` (m, world): every one-shot that has started by `t + ahead` and
 *  not ended, and every lasting sound in reach, the loudest of each kept. `where` places a one-shot's node (m, world),
 *  given its local point (µm in the node's frame) when it has one. */
export function heardAt(t: number, ahead: number, listener: readonly [number, number, number], shots: readonly Sounding[], lasting: readonly Lasting[], where: (node: string, local?: [number, number, number]) => [number, number, number] | null, day = true): Heard[] {
  const one: Heard[] = [];
  for (const s of shots) {
    const len = SHOTS[s.shot.sound] * 1e6;
    if (s.at > t + ahead || s.at + len <= t) continue;
    const pos = where(s.node, s.local);
    if (!pos) continue;
    const gain = falloff(distance(listener, pos), s.shot.radius, s.shot.volume);
    if (gain > 0) one.push({ key: s.key, sound: s.shot.sound, loop: false, variant: s.variant, pos, gain, offset: Math.max(0, t - s.at) / 1e6, at: s.at });
  }
  const loops: Heard[] = [];
  for (const l of lasting) {
    const { spec } = l;
    if (!isLoop(spec.kind) || (spec.when === 'day' && !day) || (spec.when === 'night' && day)) continue;
    const gain = falloff(distance(listener, l.pos, l.area), spec.radius, spec.volume);
    if (gain > 0) loops.push({ key: l.key, sound: spec.kind, loop: true, variant: spec.variant ?? hash(l.key) % 3, pos: l.pos, gain, offset: ((t / 1e6) % LOOP_SECONDS + LOOP_SECONDS) % LOOP_SECONDS, at: t });
  }
  const loudest = (a: Heard, b: Heard) => b.gain - a.gain;
  return [...one.sort(loudest).slice(0, MAX_SHOTS), ...loops.sort(loudest).slice(0, MAX_LOOPS)];
}
