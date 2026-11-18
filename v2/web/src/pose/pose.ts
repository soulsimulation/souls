// A pose is a function of the record and time (Engine v2 V7, #2716). `poseAt(record, model, t)` gives a body's place,
// facing and clip weights, and `poseBones` its bones too, from what was recorded and the world time alone: nothing is
// kept between frames, so two viewers, a replay next year and a video rendered frame by frame at any speed agree.
//
// - The record is a body's samples (V5's: world time in µs, place in metres in its frame) and its move records (B2's
//   `MoveRecord`: move, limbs, target and contact point, start and each phase's end, how it ended).
// - Every blend is a function of the time since a recorded event: a walk's weight is its speed over a window around
//   `t` (walk-ease's window, so a start or stop eases), a walk's phase the distance since the walk began, a seat's
//   weight the time since its start-up began and since the body next moved, a reach's the time since its phase ends.
// - Variation (idle phase, stride offset, facing before any walk) is seeded from the body's id, never drawn at random.
// - Clips are sampled from V6's baked table (`../crowd/bake.ts`) by time. Far bodies take `poseAt`'s clip, phase and
//   blend (the crowd's arrays); the nearest take `poseBones`: the clips sampled and blended, then an arm swung onto
//   the recorded contact point (two-bone, rig.ts's arithmetic on arrays), a row of twelve floats a bone as the bake's.
// - An arm whose contact point is out of reach hangs as the clip has it (rig.ts's `contact` fade).
import type { BakedModel } from '../crowd/bake.ts';
import { expressionAt, type GestureRecord, type MoodRecord, type Words } from './gesture.ts';

export type Vec = readonly [number, number, number];
/** A recorded place: world time in µs, metres in the body's frame. */
export type Sample = { at: number; pos: Vec };
/** B2's move record (`v2/crates/replica/src/moves.rs`), times in µs. */
export type MoveRecord = {
  name: string;
  revision: number;
  limbs: readonly string[];
  target: string;
  contact: string;
  start: number;
  ends: readonly number[];
  ended?: { at: number; how: string };
};
/** What is recorded of one body: its samples in time order, its moves in start order, and its gestures and moods
 * (E11, `./gesture.ts`) in time order. */
export type BodyRecord = {
  id: string; samples: readonly Sample[]; moves: readonly MoveRecord[];
  gestures?: readonly GestureRecord[]; moods?: readonly MoodRecord[];
};
/** A thing's named point (K3) in the body's frame, from the world at the move's time; null when unknown. */
export type Points = (target: string, point: string) => Vec | null;
/** What the pose reads of a baked model. */
export type PoseModel = Pick<BakedModel, 'bones' | 'clips' | 'names' | 'parents' | 'joints' | 'bake'>;

/** Moves whose body holds a posture, by move name, and the clip of that posture (clip-library's choice). */
export const POSTURES: Readonly<Record<string, string>> = { 'souls:sit': 'Sitting_Idle_Loop' };
/** Metres one cycle of the walk clip covers (V6's WALK_STRIDE). */
export const WALK_STRIDE = 1.3;
/** Seconds a walk start or stop eases over (walk-ease.ts's WALK_EASE). */
export const WALK_EASE = 0.55;
/** Seconds a posture takes to leave once the body moves on, and a reach to let go once cancelled. */
const LEAVE = 0.4, LET_GO = 0.3;
/** Below this speed (m/s) a stretch between two samples is standing still. */
const STILL = 0.05;
/** Half the window a walk's facing is read over, µs. */
const FACE_HALF = 250_000;
/** The arm's reach is clamped to this share of its length (rig.ts's maxExt). */
const MAX_EXT = 0.98;

export type BodyPose = {
  x: number; y: number; z: number; yaw: number;
  idle: number; idlePhase: number;
  walk: number; walkPhase: number; walkWeight: number;
  /** The posture clip, its phase and weight; clip -1 for none. */
  posture: number; posturePhase: number; postureWeight: number;
  /** The arm swung onto a contact point: the point in the model's space, its side and weight; side null for none. */
  reach: Vec | null; side: 'left' | 'right' | null; reachWeight: number;
  /** A gesture's clip (its own for the words, else its stand-in), phase and weight, clip -1 for none (E11). */
  gesture: number; gesturePhase: number; gestureWeight: number;
  /** The gesture's words, else the mood's, as this viewer may see them; null for none. */
  caption: string | null;
};

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const fract = (x: number) => x - Math.floor(x);

/** FNV-1a of `s` (V6's hash, as hashId), a whole number in 0..2^32. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The index of the last sample at or before `t`, or -1. */
function sampleAt(s: readonly Sample[], t: number): number {
  let lo = 0, hi = s.length - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].at <= t) (k = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return k;
}

/** The place at `t`: between the samples around it, the first before any, the newest after all (V5's rule). */
export function placeAt(s: readonly Sample[], t: number): Vec {
  if (!s.length) return [0, 0, 0];
  const k = sampleAt(s, t);
  if (k < 0) return s[0].pos;
  if (k === s.length - 1) return s[k].pos;
  const a = s[k], b = s[k + 1], f = (t - a.at) / (b.at - a.at);
  return [a.pos[0] + (b.pos[0] - a.pos[0]) * f, a.pos[1] + (b.pos[1] - a.pos[1]) * f, a.pos[2] + (b.pos[2] - a.pos[2]) * f];
}

/** Ground distance covered between `t0` and `t1`. */
function covered(s: readonly Sample[], t0: number, t1: number): number {
  let d = 0;
  for (let k = Math.max(0, sampleAt(s, t0)); k + 1 < s.length && s[k].at < t1; k++) {
    const a = placeAt(s, Math.max(t0, s[k].at)), b = placeAt(s, Math.min(t1, s[k + 1].at));
    d += Math.hypot(b[0] - a[0], b[2] - a[2]);
  }
  return d;
}

/** Whether the stretch from sample `k` to `k + 1` is standing still. */
function still(s: readonly Sample[], k: number): boolean {
  const a = s[k], b = s[k + 1];
  return Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]) / ((b.at - a.at) / 1e6) < STILL;
}

/** The last stretch at or before `t` that moved, as [index of its walk's first stretch, its own index], or null. */
function lastWalk(s: readonly Sample[], t: number): [number, number] | null {
  let j = Math.min(sampleAt(s, t), s.length - 2);
  while (j >= 0 && still(s, j)) j--;
  if (j < 0) return null;
  let i = j;
  while (i > 0 && !still(s, i - 1)) i--;
  return [i, j];
}

/** The first time after `t` the body moves, or Infinity. */
function nextMove(s: readonly Sample[], t: number): number {
  for (let k = Math.max(0, sampleAt(s, t)); k + 1 < s.length; k++) if (!still(s, k)) return Math.max(t, s[k].at);
  return Infinity;
}

/** The side a limb or bone name says, or null. */
function sideOf(name: string): 'left' | 'right' | null {
  if (/left|[._]l$/i.test(name)) return 'left';
  if (/right|[._]r$/i.test(name)) return 'right';
  return null;
}

/** The arm chain of `side`: upper arm, lower arm and wrist bones, or null. */
function arm(model: PoseModel, side: 'left' | 'right'): [number, number, number] | null {
  const w = model.names.findIndex((n) => /wrist|hand$/i.test(n.replace(/[._](l|r)$/i, '')) && sideOf(n) === side);
  if (w < 0) return null;
  const lower = model.parents[w], upper = lower >= 0 ? model.parents[lower] : -1;
  return upper >= 0 ? [upper, lower, w] : null;
}

/** The body's place, facing and weights at world time `t` (µs), from its record alone. */
export function poseAt(rec: BodyRecord, model: PoseModel, t: number, points: Points, words: Words = () => null): BodyPose {
  const s = rec.samples, seed = hash(rec.id);
  const [x, y, z] = placeAt(s, t);
  const clip = (name: string) => model.clips.findIndex((c) => c.name === name);
  const walk = clip('Walk');
  // A mood takes the idle's place; a gesture is drawn over everything by its weight (./gesture.ts).
  const ex = expressionAt(rec.gestures ?? [], rec.moods ?? [], model, t, words, clip('Idle'));
  const idle = ex.idle;
  const cycle = (k: number) => (k >= 0 ? model.clips[k].seconds : 1);
  // Facing: the way it moves over a window around t; else the way it last moved; else seeded from its id.
  const a = placeAt(s, t - FACE_HALF), b = placeAt(s, t + FACE_HALF);
  let yaw = ((seed % 3600) / 3600) * 2 * Math.PI;
  const run = lastWalk(s, t);
  if (Math.hypot(b[0] - a[0], b[2] - a[2]) > 0.02) yaw = Math.atan2(b[0] - a[0], b[2] - a[2]);
  else if (run) {
    const p = s[run[1]].pos, q = s[run[1] + 1].pos;
    yaw = Math.atan2(q[0] - p[0], q[2] - p[2]);
  }
  // Walk: the share of a walking speed over walk-ease's window around t; the phase the distance since the walk began.
  const half = (WALK_EASE * 1e6) / 2;
  const speed = covered(s, t - half, t + half) / WALK_EASE;
  const walkWeight = Math.max(0, Math.min(1, (speed - 0.06) / 0.25));
  const walkPhase = fract((seed % 1000) / 1000 + (run ? covered(s, s[run[0]].at, t) / WALK_STRIDE : 0));
  // The latest posture and the latest reach that started by t.
  let posture = -1, posturePhase = 0, postureWeight = 0, reach: Vec | null = null, side: 'left' | 'right' | null = null, reachWeight = 0;
  let face: Vec | null = null;
  for (let i = rec.moves.length - 1; i >= 0; i--) {
    const m = rec.moves[i];
    if (m.start > t) continue;
    const contact = m.ends[0], last = m.ends[m.ends.length - 1];
    const cancelled = m.ended && m.ended.how !== 'done' ? m.ended.at : Infinity;
    if (posture < 0 && POSTURES[m.name] !== undefined) {
      posture = clip(POSTURES[m.name]);
      if (posture < 0) continue;
      const leave = Math.min(cancelled, nextMove(s, contact));
      postureWeight = smooth((t - m.start) / (contact - m.start)) * (1 - smooth((t - leave) / (LEAVE * 1e6)));
      posturePhase = fract((t - m.start) / 1e6 / cycle(posture) + (hash(rec.id + m.target) % 1000) / 1000);
    }
    const hand = m.limbs.map(sideOf).find((v) => v !== null) ?? null;
    if (side === null && hand !== null && m.limbs.some((l) => /hand/i.test(l))) {
      const p = points(m.target, m.contact);
      if (!p) continue;
      side = hand;
      face = p;
      // Up over start-up (contact at its end), held, down over the last phase; let go from a cancel.
      const down = Math.min(m.ends.length > 1 ? m.ends[m.ends.length - 2] : last, cancelled);
      const fall = cancelled < Infinity ? LET_GO * 1e6 : last - down;
      reachWeight = smooth((t - m.start) / (contact - m.start)) * (1 - smooth((t - down) / Math.max(1, fall)));
    }
    if (posture >= 0 && side !== null) break;
  }
  // A reach turns the body toward its point by its weight.
  if (face && reachWeight > 0) {
    const want = Math.atan2(face[0] - x, face[2] - z);
    const d = Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw));
    yaw += d * reachWeight;
  }
  if (face) {
    const c = Math.cos(yaw), sn = Math.sin(yaw), dx = face[0] - x, dz = face[2] - z;
    reach = [c * dx - sn * dz, face[1] - y, sn * dx + c * dz];
  }
  return {
    x, y, z, yaw,
    idle, idlePhase: fract(t / 1e6 / cycle(idle) + (seed % 997) / 997),
    walk, walkPhase, walkWeight,
    posture, posturePhase, postureWeight,
    reach, side, reachWeight,
    gesture: ex.gesture, gesturePhase: ex.gesturePhase, gestureWeight: ex.gestureWeight, caption: ex.caption,
  };
}

/** Adds `w` × clip `k` at `phase` (cycles) into `out`, a row of twelve floats a bone, frames blended as V6's shader. */
function addClip(model: PoseModel, k: number, phase: number, w: number, out: Float32Array): void {
  if (k < 0 || w <= 0) return;
  const data = model.bake.image.data as Float32Array, row = model.bones * 12, c = model.clips[k];
  const f = fract(phase) * c.frames, f0 = Math.floor(f), u = f - f0;
  const r0 = (c.start + f0) * row, r1 = (c.start + ((f0 + 1) % c.frames)) * row;
  for (let i = 0; i < row; i++) out[i] += w * (data[r0 + i] * (1 - u) + data[r1 + i] * u);
}

/** Bone `b`'s point `p` (model space, bind pose) as posed by `m`. */
function apply(m: Float32Array, b: number, p: Vec): [number, number, number] {
  const o = b * 12;
  return [
    m[o] * p[0] + m[o + 1] * p[1] + m[o + 2] * p[2] + m[o + 3],
    m[o + 4] * p[0] + m[o + 5] * p[1] + m[o + 6] * p[2] + m[o + 7],
    m[o + 8] * p[0] + m[o + 9] * p[1] + m[o + 10] * p[2] + m[o + 11],
  ];
}

const joint = (model: PoseModel, b: number): Vec => [model.joints[b * 3], model.joints[b * 3 + 1], model.joints[b * 3 + 2]];
const sub = (a: Vec, b: Vec): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);

/** Turns bone `root` and every bone below it about `pivot` by the rotation taking direction `from` to `to`, by `w`. */
function swing(model: PoseModel, m: Float32Array, root: number, pivot: Vec, from: Vec, to: Vec, w: number): void {
  const lf = len(from), lt = len(to);
  if (lf < 1e-9 || lt < 1e-9) return;
  const u = [from[0] / lf, from[1] / lf, from[2] / lf], v = [to[0] / lt, to[1] / lt, to[2] / lt];
  let ax = u[1] * v[2] - u[2] * v[1], ay = u[2] * v[0] - u[0] * v[2], az = u[0] * v[1] - u[1] * v[0];
  const sn = Math.hypot(ax, ay, az);
  if (sn < 1e-9) return;
  (ax /= sn), (ay /= sn), (az /= sn);
  const th = Math.atan2(sn, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * w, c = Math.cos(th), s = Math.sin(th), k = 1 - c;
  const R = [
    c + ax * ax * k, ax * ay * k - az * s, ax * az * k + ay * s,
    ay * ax * k + az * s, c + ay * ay * k, ay * az * k - ax * s,
    az * ax * k - ay * s, az * ay * k + ax * s, c + az * az * k,
  ];
  for (let b = 0; b < model.bones; b++) {
    let p = b;
    while (p >= 0 && p !== root) p = model.parents[p];
    if (p !== root) continue;
    const o = b * 12, M = m.slice(o, o + 12);
    for (let r = 0; r < 3; r++) {
      for (let col = 0; col < 3; col++) m[o + r * 4 + col] = R[r * 3] * M[col] + R[r * 3 + 1] * M[4 + col] + R[r * 3 + 2] * M[8 + col];
      const t0 = M[3] - pivot[0], t1 = M[7] - pivot[1], t2 = M[11] - pivot[2];
      m[o + r * 4 + 3] = R[r * 3] * t0 + R[r * 3 + 1] * t1 + R[r * 3 + 2] * t2 + pivot[r];
    }
  }
}

/** The palm (midway from the wrist to its children's mean) in bind pose, the point that touches (rig.ts's `palm`). */
function palm(model: PoseModel, w: number): Vec {
  const kids = [...model.parents.keys()].filter((b) => model.parents[b] === w);
  const p = joint(model, w);
  if (!kids.length) return p;
  const q = kids.reduce((a, b) => [a[0] + model.joints[b * 3], a[1] + model.joints[b * 3 + 1], a[2] + model.joints[b * 3 + 2]], [0, 0, 0]);
  return [(p[0] + q[0] / kids.length) / 2, (p[1] + q[1] / kids.length) / 2, (p[2] + q[2] / kids.length) / 2];
}

/** The palm of the arm on `side` as posed by `bones`, in the model's space; null when the model has no such arm. */
export function palmAt(model: PoseModel, bones: Float32Array, side: 'left' | 'right'): Vec | null {
  const chain = arm(model, side);
  return chain ? apply(bones, chain[2], palm(model, chain[2])) : null;
}

/** Bone `b`'s origin as posed by `bones`, in the model's space. */
export function jointAt(model: PoseModel, bones: Float32Array, b: number): Vec {
  return apply(bones, b, joint(model, b));
}

/** The body's pose at `t` and its bones written into `out` (a row of twelve floats a bone, V6's live texture row). */
export function poseBones(
  rec: BodyRecord, model: PoseModel, t: number, points: Points, out = new Float32Array(model.bones * 12), words: Words = () => null,
): BodyPose {
  const p = poseAt(rec, model, t, points, words);
  out.fill(0);
  const gw = p.gesture >= 0 ? p.gestureWeight : 0, rest = 1 - gw;
  const pw = p.postureWeight, ww = p.walkWeight * (1 - pw);
  addClip(model, p.idle, p.idlePhase, (1 - pw - ww) * rest, out);
  addClip(model, p.walk, p.walkPhase, ww * rest, out);
  addClip(model, p.posture, p.posturePhase, pw * rest, out);
  addClip(model, p.gesture, p.gesturePhase, gw, out);
  const chain = p.side && p.reach ? arm(model, p.side) : null;
  if (chain && p.reach && p.reachWeight > 0) {
    const [upper, lower, wrist] = chain;
    const s = apply(out, upper, joint(model, upper)), e = apply(out, lower, joint(model, lower));
    const tip = palm(model, wrist), h = apply(out, wrist, tip);
    const a = len(sub(e, s)), b = len(sub(h, e)), reach = len(sub(p.reach, s));
    // Out of reach the arm hangs: full within 1.02 arm lengths, none by 1.25 (rig.ts's `contact`).
    const w = p.reachWeight * Math.max(0, Math.min(1, ((a + b) * 1.25 - reach) / ((a + b) * 0.23)));
    if (w > 0 && reach > 1e-6) {
      const c = Math.max(Math.abs(a - b) + 0.02, Math.min((a + b) * MAX_EXT, reach));
      const d = sub(p.reach, s).map((v) => v / reach) as [number, number, number];
      const cosA = Math.max(-1, Math.min(1, (a * a + c * c - b * b) / (2 * a * c)));
      // The elbow bends down and out from the body's middle line.
      const out0 = Math.sign(s[0]) * 0.5;
      const dot = out0 * d[0] - d[1];
      let pole = [out0 - dot * d[0], -1 - dot * d[1], -dot * d[2]];
      const pl = Math.hypot(pole[0], pole[1], pole[2]) || 1;
      pole = pole.map((v) => v / pl);
      const sinA = Math.sqrt(1 - cosA * cosA);
      const elbow: Vec = [s[0] + d[0] * a * cosA + pole[0] * a * sinA, s[1] + d[1] * a * cosA + pole[1] * a * sinA, s[2] + d[2] * a * cosA + pole[2] * a * sinA];
      swing(model, out, upper, s, sub(e, s), sub(elbow, s), w);
      const e1 = apply(out, lower, joint(model, lower)), h1 = apply(out, wrist, tip);
      const goal: Vec = [s[0] + d[0] * c, s[1] + d[1] * c, s[2] + d[2] * c];
      swing(model, out, lower, e1, sub(h1, e1), sub(goal, e1), w);
    }
  }
  return p;
}

/** A model-space point placed in the world by the body's place and facing (V6's instance matrix). */
export function toWorld(p: BodyPose, v: Vec): Vec {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return [p.x + c * v[0] + s * v[2], p.y + v[1], p.z - s * v[0] + c * v[2]];
}
