// Stage 3 of the 0.131 recovery plan (#4153): the old page draws a world the new engine runs. The page does not run an
// engine: it samples recorded take chunks (mars/viewer/engine/take/replay.ts). This module turns the new engine's public
// body samples (v2/web/src/source's reader: world time in µs, positions in µm) into those chunks, so LiveWorld, its
// renderer and its camera stay as they are. Pure: no page, no socket, no clock.
//
// A chunk is TICKS ticks of DT seconds, aligned to whole multiples of TICKS of world time, as the old server's are. Each
// body is sampled at every tick between its own samples (never past its newest, as the v2 page draws it: no
// extrapolation), faces the way it moves (the old take's yaw: atan2(dz, dx)), and walks while it moves.

import { heldAt, postureOf, type Held, type Seat } from './take-bodies.ts';
import { gestureAt, towardAt, type Gesture } from './take-gestures.ts';
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
 *  position then the floor under the seat. */
export type WorldSample = { at: number; p: [number, number, number]; seat?: Seat };
/** One Soul's body as the chunks need it. */
export type Body = {
  /** The take's entity id. */
  entity: string;
  /** The public Soul id the page lists. */
  soul: string;
  name: string;
  /** In time order. */
  samples: WorldSample[];
  /** Heading (radians, atan2(dz, dx)) before it first moves: from its placed orientation. */
  heading: number;
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

export type RecordedChunk = { fromTick: number; toTick: number; take: Record<string, unknown> };

/** Position (mm) at world time t, between the samples around it; the first before any, the newest after all. */
export function positionAt(s: readonly WorldSample[], t: number): [number, number, number] | null {
  if (!s.length) return null;
  if (t <= s[0].at) return s[0].p;
  const last = s[s.length - 1];
  if (t >= last.at) return last.p;
  let i = 0;
  while (s[i + 1].at <= t) i++;
  const a = s[i], b = s[i + 1], f = (t - a.at) / (b.at - a.at);
  // Into or out of a seat the body changes frame: it is never slid between the two (as the v2 page keeps a track a frame).
  if (a.seat || b.seat) return a.p;
  return [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f];
}

/** Ground speed (m/s) and heading at t: of the segment around t; heading of the last segment that moved before it. */
export function motionAt(s: readonly WorldSample[], t: number, heading: number): { speed: number; heading: number } {
  if (s.length < 2 || t < s[0].at || t >= s[s.length - 1].at) return { speed: 0, heading: lastHeading(s, s.length - 1, t, heading) };
  let i = 0;
  while (s[i + 1].at <= t) i++;
  const a = s[i], b = s[i + 1];
  if (a.seat || b.seat) return { speed: 0, heading: lastHeading(s, i, t, heading) };
  const d = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]) / POS_Q, secs = (b.at - a.at) / 1e6;
  const speed = secs > 0 ? d / secs : 0;
  return { speed, heading: lastHeading(s, i + 1, t, heading) };
}

function lastHeading(s: readonly WorldSample[], upTo: number, t: number, fallback: number): number {
  for (let k = Math.min(upTo, s.length - 1); k > 0; k--) {
    if (s[k - 1].at > t || s[k - 1].seat || s[k].seat) continue;
    const dx = s[k].p[0] - s[k - 1].p[0], dz = s[k].p[2] - s[k - 1].p[2];
    if (Math.hypot(dx, dz) >= 1) return Math.atan2(dz, dx);
  }
  return fallback;
}

/** The last whole chunk's end tick at or before world time `t` µs. */
export const chunkEnd = (t: number, ticks = TICKS) => Math.floor(t / TICK_US / ticks) * ticks;

/** The static part of every chunk's final state: the world clock and anything else the page reads beside entities. */
export type Frame = { rulesVersion: string; datetime: string | null; renderSceneRef?: unknown };

/**
 * The recorded chunk [fromTick, fromTick + ticks] (TICKS unless given) for these bodies, in the shape the old server streams (mars-take/4).
 * A body with no sample at or before the chunk's end is not in it, nor one the copy stopped placing before it began.
 */
export function chunkOf(bodies: readonly Body[], fromTick: number, frame: Frame, ticks = TICKS): RecordedChunk {
  const tracks: Record<string, number[][]> = {}, changes: [number, string, string, unknown][] = [], entities: Record<string, unknown> = {};
  const events: ReturnType<typeof markOf>[] = [];
  const endUs = (fromTick + ticks) * TICK_US;
  for (const b of bodies) {
    if (!b.samples.length || b.samples[0].at > endUs || (b.until !== undefined && fromTick * TICK_US >= b.until)) continue;
    const track: number[][] = [];
    let activity = '', speedQ: number | null = -1, heading = b.heading, p: [number, number, number] = b.samples[0].p;
    let seatH: number | null | undefined, prop: string | null | undefined;
    for (let k = 0; k <= ticks; k++) {
      const t = (fromTick + k) * TICK_US;
      p = positionAt(b.samples, t)!;
      const m = motionAt(b.samples, t, heading);
      heading = m.heading;
      const walking = m.speed >= WALKING;
      // an aimed gesture turns the standing body toward its target, so the old pose (a point, a wave, a bow) faces it
      const aim = walking ? null : towardAt(b.gestures, t);
      if (aim && !seatAt(b.samples, t) && Math.hypot(aim[0] - p[0], aim[1] - p[2]) > 1) heading = Math.atan2(aim[1] - p[2], aim[0] - p[0]);
      track.push([k, Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), Math.round(heading * ANG_Q)]);
      if (k === 0) { changes.push([0, b.entity, 'present', true], [0, b.entity, 'level', 0]); if (b.look) changes.push([0, b.entity, 'body', b.look]); }
      const seat = walking ? null : seatAt(b.samples, t), nextSeat = seat ? seat.height / POS_Q : null, nextProp = heldAt(b.held, t);
      if (k < ticks && nextSeat !== (seatH ?? null)) { changes.push([k, b.entity, 'seatHeight', nextSeat]); seatH = nextSeat; }
      if (k < ticks && nextProp !== prop && (nextProp !== null || prop !== undefined)) { changes.push([k, b.entity, 'prop', nextProp]); prop = nextProp; }
      // A gesture plays where the body stands; seated or lying it keeps its posture (the old poses are standing ones).
      const nextActivity = walking ? 'walk' : postureOf(seat) ?? gestureAt(b.gestures, t) ?? 'idle';
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
