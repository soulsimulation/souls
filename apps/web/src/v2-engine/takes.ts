// Stage 3 of the 0.131 recovery plan (#4153): the old page draws a world the new engine runs. The page does not run an
// engine: it samples recorded take chunks (mars/viewer/engine/take/replay.ts). This module turns the new engine's public
// body samples (v2/web/src/source's reader: world time in µs, positions in µm) into those chunks, so LiveWorld, its
// renderer and its camera stay as they are. Pure: no page, no socket, no clock.
//
// A chunk is TICKS ticks of DT seconds, aligned to whole multiples of TICKS of world time, as the old server's are. Each
// body is sampled at every tick between its own samples (never past its newest, as the v2 page draws it: no
// extrapolation), faces the way it moves (the old take's yaw: atan2(dz, dx)), and walks while it moves.

import { ACTIVITY_OVERLAYS } from '../../../../mars/viewer/app/engine-view/activity-poses.ts';
import { heldAt, postureOf, type Held, type Seat } from './take-bodies.ts';
import { LOOPS, gestureNow, type Gesture } from './take-gestures.ts';
import { markOf, type Talk } from './take-speech.ts';

/** Seconds a tick, as the old engine's takes. */
export const DT = 0.05;
export const TICK_US = DT * 1_000_000;
/** Ticks a chunk: one second, as the old server streams them. */
export const TICKS = 20;
/** The take's quanta (mars/viewer/engine/take/types.ts): mm, mrad, cm/s. */
const POS_Q = 1000, ANG_Q = 1000, SPEED_Q = 100;
/** Slower than this (m/s) a body stands. */
const WALKING = 0.05;

/** A body sample in the world frame: world time µs, position mm; `seat` while it is in a slot (take-bodies.ts), its
 *  position then the floor under the seat. K4 (0.135): `on` while its frame moves on a course (a balloon's rider): its
 *  world position (mm) at a later time, until its next sample; `p` is where it was at `at`. */
export type WorldSample = { at: number; p: [number, number, number]; seat?: Seat; on?: (t: number) => [number, number, number] | null };
/** The world turned a standing body at world time `at` (µs), from one heading to another (radians, atan2(dz, dx)). */
export type Turn = { at: number; from: number; to: number };
/** One Soul's body as the chunks need it. */
export type Body = {
  /** The take's entity id. */
  entity: string;
  /** The v2 body node it draws (an aimed gesture names its target by it). */
  node?: string;
  /** The public Soul id the page lists. */
  soul: string;
  name: string;
  /** In time order. */
  samples: WorldSample[];
  /** Heading (radians, atan2(dz, dx)) before it first moves: from its placed orientation. */
  heading: number;
  /** Each time the world turned it where it stood (its record's orientation changed in place), in time order. */
  turns?: Turn[];
  /** World time (µs) from which it is not drawn: the public copy can no longer place it (a frame that is not public, or
   *  it left); absent while it is drawn. */
  until?: number;
  /** What it holds, in time order (take-bodies.ts). */
  held?: Held[];
  /** Its gesture moves (take-gestures.ts), in start order. */
  gestures?: Gesture[];
  /** What it said, as talk lines in time order (take-speech.ts). */
  said?: Talk[];
  /** Its look as the old page records a body (BODY-v1, take-bodies.ts legacyBodyOf); absent: the default person. */
  look?: Record<string, unknown>;
};

/** K4 (0.135): a thing the take carries beside the bodies, so the camera can follow it and the page can frame a ride with
 *  it: a thing on a course (a balloon) today. `at`: its place (mm) and heading at world time t µs, null where the copy
 *  cannot place it. Drawn by the page's own layers, not by the take: its record is a `vehicle` (never a stand-in box), or
 *  a `fixture` the take draws for a kind no layer has (FIXTURES). */
export type Thing = { entity: string; label: string; def: string; at: (t: number) => { p: [number, number, number]; yaw: number } | null;
  /** Whether it is a ride (its record has a `carrier`: the page frames a rider with it). */
  carrier?: boolean };

/** A thing on a course no page library draws, by its kind's plain name: drawn by the take's own fixture views under
 *  today's def name (mars engine-view fixtures.ts: a rowing punt, its hull and oars). */
const FIXTURES: Record<string, string> = { rowing_punt: 'rowing-punt' };

export type RecordedChunk = { fromTick: number; toTick: number; take: Record<string, unknown> };

/** Position (mm) at world time t, between the samples around it; the first before any, the newest after all. */
export function positionAt(s: readonly WorldSample[], t: number): [number, number, number] | null {
  if (!s.length) return null;
  if (t <= s[0].at) return s[0].p;
  const last = s[s.length - 1];
  if (t >= last.at) return last.on?.(t) ?? last.p;
  let i = 0;
  while (s[i + 1].at <= t) i++;
  const a = s[i], b = s[i + 1], f = (t - a.at) / (b.at - a.at);
  // In a frame on a course the body goes where its frame goes until its next sample.
  if (a.on) return a.on(t) ?? a.p;
  // Into or out of a seat the body changes frame: it is never slid between the two (as the v2 page keeps a track a frame).
  if (a.seat || b.seat) return a.p;
  return [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f];
}

/** Ground speed (m/s) and heading at t: of the segment around t; heading of the last segment that moved before it. */
export function motionAt(s: readonly WorldSample[], t: number, heading: number, turns: readonly Turn[] = []): { speed: number; heading: number } {
  // seated, it faces out of its seat: never the way it walked up to it (its back to the seat's back)
  const sat = seatAt(s, t)?.heading;
  if (sat !== undefined) return { speed: 0, heading: sat };
  if (s.length < 2 || t < s[0].at || t >= s[s.length - 1].at) return { speed: 0, heading: turnedAt(turns, t, lastHeading(s, s.length - 1, t, heading)) };
  let i = 0;
  while (s[i + 1].at <= t) i++;
  const a = s[i], b = s[i + 1];
  if (a.seat || b.seat) return { speed: 0, heading: lastHeading(s, i, t, heading).heading };
  const d = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]) / POS_Q, secs = (b.at - a.at) / 1e6;
  const speed = secs > 0 ? d / secs : 0;
  const h = lastHeading(s, i + 1, t, heading);
  return { speed, heading: speed < WALKING ? turnedAt(turns, t, h) : h.heading };
}

/** The activity the body is drawn with at world time t, by `chunkOf`'s rule: walking, its seat's posture (sit, lie,
 *  ride), the pose of the gesture playing (dance, read, jumping-jacks, …), else idle. */
export function activityAt(b: Body, t: number): string {
  if (motionAt(b.samples, t, b.heading, b.turns).speed >= WALKING) return 'walk';
  const posture = postureOf(seatAt(b.samples, t)), gesture = gestureNow(b.gestures, t)?.activity;
  return posture === 'sit' ? gesture && ACTIVITY_OVERLAYS.has(gesture) ? gesture : posture : posture ?? gesture ?? 'idle';
}

/** The heading of the last step that moved before t, and when that step ended (µs; -Infinity: none, `fallback`). */
function lastHeading(s: readonly WorldSample[], upTo: number, t: number, fallback: number): { heading: number; at: number } {
  for (let k = Math.min(upTo, s.length - 1); k > 0; k--) {
    if (s[k - 1].at > t) continue;
    // risen from a seat it faced out of: it stands facing that way, never back the way it walked up to the seat
    if (s[k - 1].seat?.heading !== undefined && !s[k].seat) return { heading: s[k - 1].seat!.heading!, at: s[k].at };
    if (s[k - 1].seat || s[k].seat) continue;
    const dx = s[k].p[0] - s[k - 1].p[0], dz = s[k].p[2] - s[k - 1].p[2];
    if (Math.hypot(dx, dz) >= 1) return { heading: Math.atan2(dz, dx), at: s[k].at };
  }
  return { heading: fallback, at: -Infinity };
}

/** How fast the drawing turns a standing body to the facing the world set it (rad/s): half a turn in 0.6 s. */
const TURN_RATE = Math.PI / 0.6;

/**
 * A standing body's heading at t: the world's facing for it once the world turned it after its last step (a walk to a
 * thing ends facing it, worldd `Bodies::face`), else the way that step went. The drawing eases from the one to the other
 * at [TURN_RATE]; the world's body turned at once.
 */
function turnedAt(turns: readonly Turn[], t: number, last: { heading: number; at: number }): number {
  let from = last.heading, to: Turn | null = null;
  for (const r of turns) {
    if (r.at > t) { if (!to && last.at === -Infinity) from = r.from; break; }
    if (r.at < last.at) continue;
    if (to) from = to.to;
    else if (last.at === -Infinity) from = r.from;
    to = r;
  }
  if (!to) return from;
  const d = ((to.to - from) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  const u = Math.min(1, (t - to.at) / 1e6 * TURN_RATE / Math.max(Math.abs(d), 1e-9));
  return from + d * u * u * (3 - 2 * u);
}

/** How long a let-go hand hold stays in the take after it ends, µs: the old renderer lowers both arms over it
 *  (mars/viewer/engine/social/hand-hold.ts RELEASE_SECONDS, HAND_STATE_TAIL). */
const HOLD_TAIL = 2_600_000;

/**
 * 0.134 T2 on the old page: body `b`'s hand hold at world time `t`, as the old renderer's `human.handHold` (entry 35),
 * or null. Its hands join from the held move's start (`since`, an absolute take tick) and part from its end (`release`).
 * The pair stand side by side facing one way: the one on the left holds with its right hand, the other with its left.
 */
export function holdState(b: Body, byNode: ReadonlyMap<string, Body>, t: number): { with: string; hand: 'left' | 'right'; since: number; release?: number } | null {
  let h: Gesture | undefined;
  for (const g of b.gestures ?? []) if (g.hold && g.target && g.start <= t && t < g.end + HOLD_TAIL) h = g;
  const other = h?.target ? byNode.get(h.target) : undefined;
  if (!h || !other) return null;
  const p = positionAt(b.samples, h.start), q = positionAt(other.samples, h.start);
  if (!p || !q) return null;
  const f = motionAt(b.samples, h.start, b.heading, b.turns).heading;
  // The partner to the right of the way the body faces (+z of a body facing +x) is held with the right hand.
  const right = Math.cos(f) * (q[2] - p[2]) - Math.sin(f) * (q[0] - p[0]) >= 0;
  const tick = (us: number) => Math.round(us / TICK_US);
  return { with: other.entity, hand: right ? 'right' : 'left', since: tick(h.start), ...(t >= h.end ? { release: tick(h.end) } : {}) };
}

/** The last whole chunk's end tick at or before world time `t` µs. */
export const chunkEnd = (t: number, ticks = TICKS) => Math.floor(t / TICK_US / ticks) * ticks;

/** The static part of every chunk's final state: the world clock and anything else the page reads beside entities. */
export type Frame = { rulesVersion: string; datetime: string | null; renderSceneRef?: unknown };

/**
 * The recorded chunk [fromTick, fromTick + ticks] (TICKS unless given) for these bodies, in the shape the old server streams (mars-take/4).
 * A body with no sample at or before the chunk's end is not in it, nor one the copy stopped placing before it began.
 */
export function chunkOf(bodies: readonly Body[], fromTick: number, frame: Frame, ticks = TICKS, things: readonly Thing[] = []): RecordedChunk {
  const tracks: Record<string, number[][]> = {}, changes: [number, string, string, unknown][] = [], entities: Record<string, unknown> = {};
  const events: ReturnType<typeof markOf>[] = [];
  const endUs = (fromTick + ticks) * TICK_US;
  const byNode = new Map(bodies.flatMap((b) => (b.node ? [[b.node, b] as const] : [])));
  // 0.134 T3: the bodies looping one activity's moves (a dance on one beat), by that activity.
  const loops = new Map<string, Body[]>();
  for (const b of bodies) for (const g of b.gestures ?? []) {
    if (!g.run || !g.activity || !LOOPS.has(g.activity)) continue;
    const l = loops.get(g.run) ?? [];
    if (!l.includes(b)) loops.set(g.run, [...l, b]);
  }
  for (const b of bodies) {
    if (!b.samples.length || b.samples[0].at > endUs || (b.until !== undefined && fromTick * TICK_US >= b.until)) continue;
    const track: number[][] = [];
    let baseActivity: string | null | undefined;
    let activity = '', speedQ: number | null = -1, heading = b.heading, p: [number, number, number] = b.samples[0].p;
    let seatH: number | null | undefined, prop: string | null | undefined, partner: string | null | undefined, hold: string | null | undefined;
    for (let k = 0; k <= ticks; k++) {
      const t = (fromTick + k) * TICK_US;
      p = positionAt(b.samples, t)!;
      const m = motionAt(b.samples, t, heading, b.turns);
      heading = m.heading;
      const walking = m.speed >= WALKING;
      // 0.134 B4: a gesture aimed at another body faces it and names it the partner (the old paired poses meet it); a
      // held hand is the old renderer's hand hold with it. An aimed gesture at a thing (B1) turns the standing body
      // toward where its target stood. The drawing turns; the body in the world does not.
      const g = walking ? null : gestureNow(b.gestures, t), other = g?.target && g.target !== b.node ? byNode.get(g.target) : undefined;
      const op = other ? positionAt(other.samples, t) : null;
      const aim: [number, number] | null = op && !g?.hold ? [op[0], op[2]] : g?.toward && !seatAt(b.samples, t) ? g.toward : null;
      const drawn = aim && Math.hypot(aim[0] - p[0], aim[1] - p[2]) > 1 ? Math.atan2(aim[1] - p[2], aim[0] - p[0]) : heading;
      // Dancers on one beat move in step: each names the first of them (by entity) its partner, whose phase the old
      // renderer shares between partners; that first one names none.
      const lead = g?.run && g.activity && LOOPS.has(g.activity)
        ? (loops.get(g.run) ?? []).filter((o) => o.entity < b.entity && gestureNow(o.gestures, t)?.run === g.run).map((o) => o.entity).sort()[0] ?? null
        : null;
      const nextPartner = lead ?? (g && !g.hold && other ? other.entity : null);
      if (k < ticks && nextPartner !== (partner ?? null)) { changes.push([k, b.entity, 'partner', nextPartner]); partner = nextPartner; }
      const held = holdState(b, byNode, t), nextHold = held ? JSON.stringify(held) : null;
      if (k < ticks && nextHold !== (hold ?? null)) { changes.push([k, b.entity, 'handHold', held]); hold = nextHold; }
      track.push([k, Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), Math.round(drawn * ANG_Q)]);
      if (k === 0) { changes.push([0, b.entity, 'present', true], [0, b.entity, 'level', 0]); if (b.look) changes.push([0, b.entity, 'body', b.look]); }
      const seat = walking ? null : seatAt(b.samples, t), nextSeat = seat && !seat.ride ? seat.height / POS_Q : null, nextProp = heldAt(b.held, t);
      if (k < ticks && nextSeat !== (seatH ?? null)) { changes.push([k, b.entity, 'seatHeight', nextSeat]); seatH = nextSeat; }
      if (k < ticks && nextProp !== prop && (nextProp !== null || prop !== undefined)) { changes.push([k, b.entity, 'prop', nextProp]); prop = nextProp; }
      // A gesture plays where the body stands; seated or lying it keeps its posture (the old poses are standing ones).
      const posture = postureOf(seat);
      const nextBase = posture === 'sit' ? 'sit' : null;
      if (k < ticks && nextBase !== baseActivity) { changes.push([k, b.entity, 'baseActivity', nextBase]); baseActivity = nextBase; }
      const nextActivity = walking ? 'walk' : posture === 'sit' ? g?.activity && ACTIVITY_OVERLAYS.has(g.activity) ? g.activity : posture : posture ?? g?.activity ?? 'idle';
      if (nextActivity !== activity && k < ticks) { changes.push([k, b.entity, 'activity', nextActivity]); activity = nextActivity; }
      const q = walking ? Math.round(m.speed * SPEED_Q) : null;
      if (k < ticks && (q === null ? speedQ !== null : speedQ === null || Math.abs(q - speedQ) > 2)) { changes.push([k, b.entity, 'speed', q]); speedQ = q; }
    }
    tracks[b.entity] = thin(track);
    for (const l of b.said ?? []) if (l.tick >= fromTick && l.tick < fromTick + ticks) events.push(markOf(l, fromTick));
    entities[b.entity] = {
      id: b.entity, def: 'human', kind: 'human', label: b.name, ...(b.look ? { body: b.look } : {}),
      pose: { p: [p[0] / POS_Q, p[1] / POS_Q, p[2] / POS_Q], yaw: heading },
      provenance: { origin: 'simulation', confidence: 'hypothetical' },
      human: { activity: activity || 'idle', level: 0, soul: b.soul, ...(speedQ !== null && speedQ >= 0 ? { speed: speedQ / SPEED_Q } : {}),
        ...(seatH ? { seatHeight: seatH } : {}), ...(prop ? { prop } : {}) },
    };
  }
  for (const th of things) {
    const track: number[][] = [];
    let last: { p: [number, number, number]; yaw: number } | null = null;
    for (let k = 0; k <= ticks; k++) {
      const here = th.at((fromTick + k) * TICK_US);
      if (!here) continue;
      last = here;
      track.push([k, Math.round(here.p[0]), Math.round(here.p[1]), Math.round(here.p[2]), Math.round(here.yaw * ANG_Q)]);
    }
    if (!last) continue;
    tracks[th.entity] = thin(track);
    changes.push([0, th.entity, 'present', true]);
    const p: [number, number, number] = [last.p[0] / POS_Q, last.p[1] / POS_Q, last.p[2] / POS_Q];
    const fixture = FIXTURES[th.def];
    entities[th.entity] = { id: th.entity, def: fixture ?? th.def, kind: fixture ? 'fixture' : 'vehicle', label: th.label, pose: { p, yaw: last.yaw },
      provenance: { origin: 'simulation', confidence: 'hypothetical' }, ...(th.carrier ? { carrier: { contract: 'carrier-state/1', home: p } } : {}) };
  }
  changes.sort((a, b) => a[0] - b[0]);
  events.sort((a, b) => a.t - b.t);
  const id = `v2-${fromTick}`;
  return {
    fromTick, toTick: fromTick + ticks,
    take: {
      schema: 'mars-take/4', id, baselineStateHash: `v2-state-${fromTick}`, finalStateHash: `v2-state-${fromTick + ticks}`,
      rulesVersion: frame.rulesVersion, ...(frame.renderSceneRef ? { renderSceneRef: frame.renderSceneRef } : {}),
      dt: DT, startTick: fromTick, ticks: ticks, keyframeEvery: ticks,
      tracks, changes, events, removed: [], entities0: {},
      finalState: { tick: fromTick + ticks, entities, regions: {}, env: { datetime: frame.datetime } },
    },
  };
}

/** The seat of the newest sample at or before t (none before the first). */
function seatAt(s: readonly WorldSample[], t: number): Seat | null {
  let seat: Seat | null = null;
  for (const x of s) { if (x.at > t) break; seat = x.seat ?? null; }
  return seat;
}

/** Drops samples equal to both neighbours (a body standing still), keeping the first and the last. */
function thin(track: number[][]): number[][] {
  const same = (a: number[], b: number[]) => a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
  return track.filter((x, i) => i === 0 || i === track.length - 1 || !same(track[i - 1], x) || !same(x, track[i + 1]));
}
