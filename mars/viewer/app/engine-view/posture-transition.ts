// Posture transitions drawn between two activities (a cosmetic renderer layer, pure numbers, no three.js objects).
// When the activity a body does changes its posture (lying on the back, face down, seated, standing), the record has no
// in-between phase: the new engine goes from sit-ups to jumping jacks, from a seat to standing, in one tick. The body is
// not left to switch in one frame: from the posture change on, the renderer plays the change itself (LayToIdle getting
// up from the back or lying down, the plank tilting up from the feet or down to them, Sitting_Enter / Sitting_Exit), and
// a procedural activity frame eases in after it, or crossfades from the one before. It observes the record only:
// where the body is stays the engine's; only how it is posed over the next second follows the change.
import { ACTIVITY_OVERLAYS, FACE_DOWN, LYING, type ActivityFrame, type HandGoal } from './activity-poses.ts';

/** The posture an activity holds the body in. */
export type PostureKind = 'stand' | 'back' | 'front' | 'seat' | 'ground';
const SEAT_ACTS: ReadonlySet<string> = new Set(['sit', 'sit-down', 'stand-up']);
/** Gait: a body that moves off at once is not held in a transition (its walk is the engine's). */
const MOVING: ReadonlySet<string> = new Set(['walk', 'wade', 'jog', 'run']);

/** Seconds: getting up from the back, lying down on it, a plank tilting up or down, an activity frame crossfade. Each
 *  posture change is drawn in at most 1 s, its ease after it in 1.3 s: within ACT_HISTORY. */
export const GET_UP = 1.0, LIE_DOWN = 0.9, TILT = 0.6, ACT_BLEND = 0.3;
/** Seconds of activity history the take replay keeps across its previous windows (take-replay.ts indexActs): the
 *  longest change drawn here and its ease after it, with room to spare. */
export const ACT_HISTORY = 1.5;
/** Back to face down (and back): up off the back, then down onto the hands, in 1 s together. */
const TURN_RISE = 0.55, TURN_TILT = 0.45;
/** The old engine's seat transitions' own lengths (clip-library.ts Sitting_Enter / Sitting_Exit fits). */
export const SIT_DOWN = 0.9, STAND_UP = 0.8;

export function postureKind(activity: string, base?: string): PostureKind {
  const a = ACTIVITY_OVERLAYS.has(activity) ? base ?? 'idle' : activity;
  if (LYING.has(a)) return 'back';
  if (FACE_DOWN.has(a)) return 'front';
  if (a === 'sit-ground') return 'ground';
  if (SEAT_ACTS.has(a)) return 'seat';
  return 'stand';
}

/**
 * How the posture change is drawn now. `rise`: LayToIdle by phase (0 lying on the back, 1 standing) in place of the
 * activity's own frame; `tilt`: the face-down frame of `act`, its plank turned from standing (0) to lying (1) about the
 * feet; `activity`: the old engine's own seat transition to draw instead ('sit-down' / 'stand-up', its age `since`);
 * `settle`: 0–1, how far the current activity's own frame has eased in after the change (1: fully). Null: no change
 * being drawn (none, over, or the body moving).
 */
export type PostureNow = { rise?: number; tilt?: { act: string; k: number }; activity?: 'sit-down' | 'stand-up'; since?: number; settle: number };

const S = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** The change from `fromAct` (on `fromBase`) into `toAct`, `age` seconds after it, as drawn now while the body does
 *  `act` (on `base`; the same posture as `toAct`: a later change of activity that kept the posture keeps drawing it). */
export function postureNow(fromAct: string | undefined, fromBase: string | undefined, toAct: string, act: string, base: string | undefined, age: number | undefined): PostureNow | null {
  if (fromAct === undefined || age === undefined || age < 0 || MOVING.has(act)) return null;
  const from = postureKind(fromAct, fromBase), to = postureKind(act, base);
  if (from === to) return null;
  const settle = (t: number) => S((age - t) / ACT_BLEND);
  if (from === 'back' && to === 'front') return age < TURN_RISE ? { rise: S(age / TURN_RISE), settle: 0 } : age < TURN_RISE + TURN_TILT ? { tilt: { act, k: S((age - TURN_RISE) / TURN_TILT) }, settle: 0 } : null;
  if (from === 'front' && to === 'back') return age < TURN_TILT ? { tilt: { act: fromAct, k: 1 - S(age / TURN_TILT) }, settle: 0 } : age < TURN_TILT + TURN_RISE ? { rise: 1 - S((age - TURN_TILT) / TURN_RISE), settle: 0 } : null;
  if (from === 'back') return age < GET_UP ? { rise: S(age / GET_UP), settle: 0 } : age < GET_UP + ACT_BLEND ? { settle: settle(GET_UP) } : null;
  if (to === 'back') return age < LIE_DOWN ? { rise: 1 - S(age / LIE_DOWN), settle: 0 } : null;
  if (to === 'front') return age < TILT ? { tilt: { act, k: S(age / TILT) }, settle: 0 } : null;
  if (from === 'front') return age < TILT ? { tilt: { act: fromAct, k: 1 - S(age / TILT) }, settle: 0 } : age < TILT + ACT_BLEND ? { settle: settle(TILT) } : null;
  // Seats: the old engine published its own 'sit-down' / 'stand-up' phases, drawn as they are; a record without them
  // (straight from standing to 'sit', or from 'sit' to standing) draws them over their own lengths.
  if (from === 'stand' && toAct === 'sit' && act === 'sit') return age < SIT_DOWN ? { activity: 'sit-down', since: age, settle: 0 } : null;
  if (fromAct === 'sit' && to === 'stand') return age < STAND_UP ? { activity: 'stand-up', since: age, settle: 0 } : null;
  return null;
}

/** The latest posture change in an activity history (change ticks `t`, activities `v`, the base at each change from
 *  `base`) at or before run `k`: the activity and base before it, the activity it went into and its age at `tick`
 *  (seconds a tick `dt`). Runs after it keep its posture, so an idle tick between sit-ups and jumping jacks still gets up. */
export function lastPostureChange(t: readonly number[], v: readonly string[], k: number, tick: number, dt: number, base: (at: number, before: boolean) => string | undefined): { from: string; fromBase?: string; to: string; age: number } | null {
  for (let j = k; j >= 1; j--) {
    const age = (tick - t[j]) * dt;
    if (age > GET_UP + ACT_BLEND) return null;
    const fromBase = base(t[j], true);
    if (postureKind(v[j - 1], fromBase) !== postureKind(v[j], base(t[j], false))) return { from: v[j - 1], ...(fromBase ? { fromBase } : {}), to: v[j], age };
  }
  return null;
}

/** Activities with their own fade in and out (or whose frame rides on something): never crossfaded here. */
export const OWN_FADE: ReadonlySet<string> = new Set(['sing', 'play-piano', 'play-music', 'wave', 'bow', 'point', 'ride', 'row', 'swing', 'seesaw', 'rps', 'cycle']);

/** Two standing activity frames mixed, `k` 0 (all `prev`) to 1 (all `cur`); either may be null (standing plain). Each
 *  hand goes from one goal to the other, or eases on (off) from the plain posture by its arm weight; leg, lean, hop and
 *  look numbers are mixed; the rest is the nearer frame's. */
export function blendFrames(prev: ActivityFrame | null, cur: ActivityFrame | null, k: number): ActivityFrame | null {
  if (k >= 1 || (!prev && !cur)) return cur;
  if (k <= 0) return prev;
  const near = (k >= 0.5 ? cur : prev) ?? cur ?? prev!, mix = (a = 0, b = 0) => a + (b - a) * k;
  const hands: [HandGoal | null, HandGoal | null] = [null, null], w: [number, number] = [0, 0];
  for (const i of [0, 1] as const) {
    const pg = prev?.hands?.[i] ?? null, cg = cur?.hands?.[i] ?? null, pw = prev?.handW?.[i] ?? 1, cw = cur?.handW?.[i] ?? 1;
    if (pg && cg) { hands[i] = [mix(pg[0], cg[0]), mix(pg[1], cg[1]), mix(pg[2], cg[2])]; w[i] = mix(pw, cw); }
    else if (cg) { hands[i] = cg; w[i] = cw * k; }
    else if (pg) { hands[i] = pg; w[i] = pw * (1 - k); }
  }
  const out: ActivityFrame = { ...near, hands: hands[0] || hands[1] ? hands : null, handW: w, rootHands: undefined, lying: null,
    feetOut: mix(prev?.feetOut, cur?.feetOut), hop: mix(prev?.hop, cur?.hop), lean: mix(prev?.lean, cur?.lean), side: mix(prev?.side, cur?.side), look: mix(prev?.look, cur?.look) };
  if (prev?.mouth !== undefined || cur?.mouth !== undefined) out.mouth = mix(prev?.mouth, cur?.mouth);
  return out;
}
