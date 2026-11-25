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


/** Seconds: a lying frame flattening out (sit-up raise and arms down) before getting up, getting up from the back,
 *  lying down on it, a plank tilting up or down, an activity frame easing in or crossfading. */
export const FLATTEN = 0.25, GET_UP = 1.0, LIE_DOWN = 0.9, TILT = 0.6, ACT_BLEND = 0.3;
/** Back to face down (and back): up off the back, then down onto the hands. */
const TURN_RISE = 0.55, TURN_TILT = 0.45;
/** The old engine's seat transitions' own lengths (clip-library.ts Sitting_Enter / Sitting_Exit fits). */
export const SIT_DOWN = 0.9, STAND_UP = 0.8;
/** Seconds of activity history the take replay keeps across its previous windows (take-replay.ts indexActs): the
 *  longest change drawn here with its ease after it (1.55 s), with room to spare. */
export const ACT_HISTORY = 1.8;

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
 * feet; `flat`: the lying frame of `act` with its raise and arms eased to k (0: flat on the back, arms down);
 * `activity`: the old engine's own seat transition to draw instead ('sit-down' / 'stand-up', its age `since`);
 * `settle`: 0–1, how far the current activity's own frame has eased in after the change (1: fully). Null: no change
 * being drawn (none, over, or the body moving).
 */
export type PostureNow = { rise?: number; tilt?: { act: string; k: number }; flat?: { act: string; k: number }; activity?: 'sit-down' | 'stand-up'; since?: number; settle: number };
/** A change of posture in the record: the activity (and base) before it, the activity after it, its age (s); `before`:
 *  the change before it, when that was still being drawn as this one came. */
export type PostureChange = { from: string; fromBase?: string; to: string; age: number; before?: PostureChange };

const S = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
type Phase = { s: number; at: (u: number) => Omit<PostureNow, 'settle'> & { settle?: number } };

/** The phases a change is drawn in, one after the other. */
function phasesOf(c: PostureChange, base: string | undefined): Phase[] {
  const from = postureKind(c.from, c.fromBase), to = postureKind(c.to, base);
  if (from === to) return [];
  const flat: Phase = { s: FLATTEN, at: (u) => ({ flat: { act: c.from, k: 1 - S(u) } }) };
  const up = (s: number): Phase => ({ s, at: (u) => ({ rise: S(u) }) }), down = (s: number): Phase => ({ s, at: (u) => ({ rise: 1 - S(u) }) });
  const tiltDown = (s: number): Phase => ({ s, at: (u) => ({ tilt: { act: c.to, k: S(u) } }) });
  const tiltUp = (s: number): Phase => ({ s, at: (u) => ({ tilt: { act: c.from, k: 1 - S(u) } }) });
  const settle: Phase = { s: ACT_BLEND, at: (u) => ({ settle: S(u) }) };
  if (from === 'back' && to === 'front') return [flat, up(TURN_RISE), tiltDown(TURN_TILT)];
  if (from === 'front' && to === 'back') return [tiltUp(TURN_TILT), down(TURN_RISE), settle];
  if (from === 'back' && to === 'stand') return [flat, up(GET_UP), settle];
  if (to === 'back' && from === 'stand') return [down(LIE_DOWN), settle];
  if (to === 'front' && from === 'stand') return [tiltDown(TILT)];
  if (from === 'front' && to === 'stand') return [tiltUp(TILT), settle];
  // Seats: the old engine published its own 'sit-down' / 'stand-up' phases, drawn as they are; a record without them
  // (straight from standing to 'sit', or from 'sit' to standing) draws them over their own lengths.
  if (from === 'stand' && c.to === 'sit') return [{ s: SIT_DOWN, at: (u) => ({ activity: 'sit-down', since: u * SIT_DOWN }) }];
  if (c.from === 'sit' && to === 'stand') return [{ s: STAND_UP, at: (u) => ({ activity: 'stand-up', since: u * STAND_UP }) }];
  return [];
}

function drawn(c: PostureChange, base: string | undefined, age: number): PostureNow | null {
  for (const p of phasesOf(c, base)) {
    if (age < p.s) return { settle: 0, ...p.at(age / p.s) };
    age -= p.s;
  }
  return null;
}

/** The change `c` as drawn now while the body does `act` (on `base`; `c.to` or a later activity of the same posture).
 *  A change that comes while the one before it is still being drawn waits for it to finish (lying back, a brief idle,
 *  then push-ups: up off the back first, then down onto the hands); never cut. */
export function postureNow(c: PostureChange | undefined, act: string, base?: string): PostureNow | null {
  if (!c || c.age < 0 || MOVING.has(act)) return null;
  let age = c.age;
  const b = c.before;
  if (b) {
    const len = phasesOf(b, undefined).filter((p) => p.at(0).settle === undefined).reduce((s, p) => s + p.s, 0), left = len - (b.age - c.age);
    if (left > 0) { if (age < left) return drawn(b, undefined, b.age); age -= left; }
  }
  return drawn(c, base, age);
}

/** The latest posture change in an activity history (change ticks `t`, activities `v`, the base at each change from
 *  `base`) at or before run `k`, with the one before it, at `tick` (seconds a tick `dt`); null when none is younger
 *  than ACT_HISTORY. Runs after a change keep its posture, so an idle tick between sit-ups and jumping jacks still gets up. */
export function lastPostureChange(t: readonly number[], v: readonly string[], k: number, tick: number, dt: number, base: (at: number, before: boolean) => string | undefined): PostureChange | null {
  const found: PostureChange[] = [];
  for (let j = k; j >= 1 && found.length < 2; j--) {
    const age = (tick - t[j]) * dt;
    if (age > ACT_HISTORY) break;
    const fromBase = base(t[j], true);
    if (postureKind(v[j - 1], fromBase) !== postureKind(v[j], base(t[j], false))) found.push({ from: v[j - 1], ...(fromBase ? { fromBase } : {}), to: v[j], age });
  }
  return found[0] ? { ...found[0], ...(found[1] ? { before: found[1] } : {}) } : null;
}


/** Activities with their own fade in and out (or whose frame rides on something): never crossfaded here. */
export const OWN_FADE: ReadonlySet<string> = new Set(['sing', 'play-piano', 'play-music', 'wave', 'bow', 'point', 'ride', 'row', 'swing', 'seesaw', 'rps', 'cycle']);

/** Two standing activity frames mixed, `k` 0 (all `prev`) to 1 (all `cur`); either may be null (standing plain). Each
 *  hand goes from one goal to the other, or eases on (off) from the plain posture by its arm weight; leg, lean, hop and
 *  look numbers are mixed; the rest is the nearer frame's. A lying `cur` eased in from nothing keeps its layout, its
 *  raise eased by `k` (0: flat on the back). */
export function blendFrames(prev: ActivityFrame | null, cur: ActivityFrame | null, k: number): ActivityFrame | null {
  const lying = !prev && cur?.lying ? cur.lying : null;
  if (k >= 1 || (!prev && !cur)) return cur;
  if (k <= 0 && !lying) return prev;
  k = Math.max(0, k);
  const near = (k >= 0.5 ? cur : prev) ?? cur ?? prev!, mix = (a = 0, b = 0) => a + (b - a) * k;
  const hands: [HandGoal | null, HandGoal | null] = [null, null], w: [number, number] = [0, 0];
  for (const i of [0, 1] as const) {
    const pg = prev?.hands?.[i] ?? null, cg = cur?.hands?.[i] ?? null, pw = prev?.handW?.[i] ?? 1, cw = cur?.handW?.[i] ?? 1;
    if (pg && cg) { hands[i] = [mix(pg[0], cg[0]), mix(pg[1], cg[1]), mix(pg[2], cg[2])]; w[i] = mix(pw, cw); }
    else if (cg) { hands[i] = cg; w[i] = cw * k; }
    else if (pg) { hands[i] = pg; w[i] = pw * (1 - k); }
  }
  const out: ActivityFrame = { ...near, hands: hands[0] || hands[1] ? hands : null, handW: w, rootHands: undefined, lying: lying ? { ...lying, raise: lying.raise * k } : null,
    feetOut: mix(prev?.feetOut, cur?.feetOut), hop: mix(prev?.hop, cur?.hop), lean: mix(prev?.lean, cur?.lean), side: mix(prev?.side, cur?.side), look: mix(prev?.look, cur?.look) };
  if (prev?.mouth !== undefined || cur?.mouth !== undefined) out.mouth = mix(prev?.mouth, cur?.mouth);
  return out;
}
