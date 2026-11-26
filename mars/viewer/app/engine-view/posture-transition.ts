// Posture transitions drawn between two activities (a cosmetic renderer layer, pure numbers, no three.js objects).
// When the activity a body does changes its posture (lying on the back, face down, seated, standing), the record has no
// in-between phase: the new engine goes from sit-ups to jumping jacks, from a seat to standing, in one tick. The body is
// not left to switch in one frame: from the posture change on, the renderer plays the change itself (LayToIdle getting
// up from the back or lying down, the plank tilting up from the feet or down to them, Sitting_Enter / Sitting_Exit), and
// a procedural activity frame eases in after it, or crossfades from the one before. It observes the record only:
// where the body is stays the engine's; only how it is posed over the next second follows the change.
import { activityFrame, ACTIVITY_OVERLAYS, FACE_DOWN, LYING, type ActivityFrame, type HandGoal } from './activity-poses.ts';

/** The posture an activity holds the body in. */
export type PostureKind = 'stand' | 'back' | 'front' | 'seat' | 'ground';
const SEAT_ACTS: ReadonlySet<string> = new Set(['sit', 'sit-down', 'stand-up']);
/** Locomotion retains its native trajectory while a cosmetic floor exit finishes above the current root. */
const MOVING: ReadonlySet<string> = new Set(['walk', 'wade', 'jog', 'run']);


/** Seconds: a lying frame flattening out (sit-up raise and arms down) before getting up, getting up from the back,
 *  lying down on it, a plank tilting up or down, an activity frame easing in or crossfading. */
export const FLATTEN = 0.25, GET_UP = 1.0, LIE_DOWN = 0.9, TILT = 0.6, ACT_BLEND = 0.3;
/** Back to face down (and back): up off the back, then down onto the hands. */
const TURN_RISE = 0.55, TURN_TILT = 0.45;
/** The old engine's seat transitions' own lengths (clip-library.ts Sitting_Enter / Sitting_Exit fits). */
export const SIT_DOWN = 0.9, STAND_UP = 0.8;
/** Legacy live-engine transition horizon. Recorded replay retains immutable origins across adjacent windows. */
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
export type PostureNow = { rise?: number; tilt?: { act: string; k: number }; flat?: { act: string; k: number; ago?: number }; frame?: ActivityFrame | null; activity?: 'sit-down' | 'stand-up'; since?: number; settle: number };
/** A change of posture in the record: the activity (and base) before it, the activity after it, its age (s); `before`:
 *  the change before it, when that was still being drawn as this one came. */
export type PostureChange = { from: string; fromBase?: string; to: string; age: number; fromAge?: number; fromWalk?: { weight: number; distance: number }; before?: PostureChange };

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
  if (from === 'stand' && to === 'seat' && c.to !== 'sit-down') return [{ s: SIT_DOWN, at: (u) => ({ activity: 'sit-down', since: u * SIT_DOWN }) }];
  if (from === 'seat' && to === 'stand' && c.from !== 'stand-up') return [{ s: STAND_UP, at: (u) => ({ activity: 'stand-up', since: u * STAND_UP }) }];
  return [];
}

function drawn(c: PostureChange, base: string | undefined, age: number): PostureNow | null {
  for (const p of phasesOf(c, base)) {
    if (age < p.s) return { settle: 0, ...p.at(age / p.s) };
    age -= p.s;
  }
  return null;
}

/** Evaluate an interruption at its recorded boundary, never from the last rendered frame. A retarget starts at
 * that attained layout, rather than finishing an unrelated queued get-up. The optional clock freezes the outgoing
 * procedural frame (including the sit-up/push-up cycle) at that same boundary. */
export function postureNow(c: PostureChange | undefined, act: string, base?: string, clock?: { time: number; id: string }): PostureNow | null {
  if (!c || c.age < 0 || MOVING.has(act)&&!['back','front'].includes(postureKind(c.from,c.fromBase))) return null;
  const frozen = (a: string, ago: number) => clock ? activityFrame(a, c.fromBase ?? 'idle', clock.time - ago, clock.id) : null;
  const settle = (k: number): PostureNow => postureKind(c.to, base) === 'back' ? { settle: k, flat: { act: c.to, k }, ...(clock ? { frame: blendFrames(null, activityFrame(c.to, base ?? 'idle', clock.time, clock.id), k) } : {}) } : { settle: k };
  const b = c.before;
  if (b) {
    const elapsed = b.age - c.age;
    const origin = postureNow({ ...b, age: elapsed, ...(b.before ? { before: shiftAge(b.before, -c.age) } : {}) }, b.to, c.fromBase, clock ? { ...clock, time: clock.time - c.age } : undefined);
    if (origin) {
      const to = postureKind(c.to, base), u = S(c.age / TILT);
      if (origin.rise !== undefined) {
        // A partly completed LayToIdle reverses from its actual phase, not phase zero/one.
        const target = to === 'back' ? 0 : 1, rise = origin.rise + (target - origin.rise) * u;
        if (c.age < TILT) return { settle: 0, rise };
        const rest = c.age - TILT;
        if (to === 'front') return rest < TILT ? { settle: 0, tilt: { act: c.to, k: S(rest / TILT) }, frame: frozen(c.to, c.age) } : null;
        return rest < ACT_BLEND ? settle(S(rest / ACT_BLEND)) : null;
      }
      if (origin.tilt) {
        const target = to === 'front' ? 1 : 0, k = origin.tilt.k + (target - origin.tilt.k) * u;
        const frame = origin.frame ?? frozen(origin.tilt.act, c.age);
        if (c.age < TILT) return { settle: 0, tilt: { act: origin.tilt.act, k }, frame };
        const rest = c.age - TILT;
        if (to === 'back') return rest < LIE_DOWN ? { settle: 0, rise: 1 - S(rest / LIE_DOWN) } : rest < LIE_DOWN + ACT_BLEND ? settle(S((rest - LIE_DOWN) / ACT_BLEND)) : null;
        return rest < ACT_BLEND ? { settle: S(rest / ACT_BLEND), ...(to === 'front' ? { tilt: { act: c.to, k: 1 }, frame: blendFrames(frame, clock ? activityFrame(c.to, base ?? 'idle', clock.time, clock.id) : null, S(rest / ACT_BLEND)) } : {}) } : null;
      }
      if (origin.flat) {
        const frame = origin.frame ?? blendFrames(null, frozen(origin.flat.act, c.age + (origin.flat.ago ?? 0)), origin.flat.k);
        if (to === 'back') {
          if (c.age < ACT_BLEND) return { settle: 0, flat: { act: c.to, k: 1 }, frame: blendFrames(frame, clock ? activityFrame(c.to, base ?? 'idle', clock.time, clock.id) : null, S(c.age / ACT_BLEND)) };
          return null;
        }
        if (c.age < FLATTEN) return { settle: 0, flat: { act: origin.flat.act, k: origin.flat.k * (1 - S(c.age / FLATTEN)) }, frame: blendFrames(null, frame, 1 - S(c.age / FLATTEN)) };
        const rest = c.age - FLATTEN;
        if (rest < GET_UP) return { settle: 0, rise: S(rest / GET_UP) };
        if (to === 'front' && rest >= GET_UP + TILT && rest < GET_UP + TILT + ACT_BLEND) return { settle: 0, tilt: { act: c.to, k: 1 }, frame: blendFrames(frozen(c.to, c.age), clock ? activityFrame(c.to, base ?? 'idle', clock.time, clock.id) : null, S((rest - GET_UP - TILT) / ACT_BLEND)) };
        return to === 'front' && rest < GET_UP + TILT ? { settle: 0, tilt: { act: c.to, k: S((rest - GET_UP) / TILT) }, frame: frozen(c.to, c.age) } : null;
      }
    }
  }
  // Finish a face-down entry by blending its frozen cycle into the live cycle, at the same layout.
  if (postureKind(c.from, c.fromBase) === 'stand' && postureKind(c.to, base) === 'front' && c.age >= TILT && c.age < TILT + ACT_BLEND) {
    const k = S((c.age - TILT) / ACT_BLEND);
    return { settle: k, tilt: { act: c.to, k: 1 }, ...(clock ? { frame: blendFrames(frozen(c.to, c.age), activityFrame(c.to, base ?? 'idle', clock.time, clock.id), k) } : {}) };
  }
  const out = drawn(c, base, c.age);
  if (out && out.rise === undefined && !out.tilt && !out.flat && postureKind(c.to, base) === 'back') out.flat = { act: c.to, k: out.settle };
  if (out?.flat) { out.flat.ago = out.flat.act === c.to ? 0 : c.age; if (clock) out.frame = blendFrames(null, frozen(out.flat.act, out.flat.ago), out.flat.k); }
  if (out?.tilt && clock) out.frame = frozen(out.tilt.act, c.age);
  return out;
}
/** Phase boundaries are recorded-time blend anchors too: a library clip and a procedural frame need not have
 * identical skeletons at their nominal endpoints. Expose the exact schedule, including final return to live phase. */
export function posturePhaseEnds(c: PostureChange, base?: string, activity = c.to): number[] {
  const b=c.before, elapsed=b?b.age-c.age:0;
  const origin=b?postureNow({...b,age:elapsed,...(b.before?{before:shiftAge(b.before,-c.age)}:{})},b.to,c.fromBase):null;
  const to=postureKind(c.to,base);
  const finish=(ends:number[])=>MOVING.has(activity)&&ends.length>1&&Math.abs(ends.at(-1)!-ends.at(-2)!-ACT_BLEND)<1e-6?ends.slice(0,-1):ends;
  if(origin?.rise!==undefined)return finish(to==='front'?[TILT,2*TILT,2*TILT+ACT_BLEND]:[TILT,TILT+ACT_BLEND]);
  if(origin?.tilt)return finish(to==='back'?[TILT,TILT+LIE_DOWN,TILT+LIE_DOWN+ACT_BLEND]:[TILT,TILT+ACT_BLEND]);
  if(origin?.flat)return to==='back'?[ACT_BLEND]:to==='front'?[FLATTEN,FLATTEN+GET_UP,FLATTEN+GET_UP+TILT,FLATTEN+GET_UP+TILT+ACT_BLEND]:[FLATTEN,FLATTEN+GET_UP];
  let end=0;const ends=phasesOf(c,base).map(p=>end+=p.s);
  if(postureKind(c.from,c.fromBase)==='stand'&&to==='front')ends.push(TILT+ACT_BLEND);
  return finish(ends);
}

function shiftAge(c: PostureChange, delta: number): PostureChange {
  return { ...c, age: c.age + delta, ...(c.before ? { before: shiftAge(c.before, delta) } : {}) };
}

/** Immutable activity history supplies every still-relevant interruption. A stable gap terminates the dependency
 * chain; there is no max-two rule and no cutoff applied to an origin while a newer transition still uses it. */
export function lastPostureChange(t: readonly number[], v: readonly string[], k: number, tick: number, dt: number, base: (at: number, before: boolean) => string | undefined): PostureChange | null {
  const found: PostureChange[] = [];
  let later = Infinity;
  for (let j = k; j >= 1; j--) {
    const age = (tick - t[j]) * dt;
    const fromBase = base(t[j], true);
    if (postureKind(v[j - 1], fromBase) === postureKind(v[j], base(t[j], false))) continue;

    if (later - t[j] > (FLATTEN + GET_UP + TILT + ACT_BLEND) / dt && found.length) break;
    found.push({ from: v[j - 1], ...(fromBase ? { fromBase } : {}), to: v[j], age, fromAge: (t[j] - t[j - 1]) * dt });
    later = t[j];
  }
  let out: PostureChange | undefined;
  for (let j = found.length - 1; j >= 0; j--) out = { ...found[j], ...(out ? { before: out } : {}) };
  return out ?? null;
}


/** Activities with their own fade in and out (or whose frame rides on something): never crossfaded here. */
export const OWN_FADE: ReadonlySet<string> = new Set(['operate', 'sing', 'play-piano', 'play-music', 'wave', 'bow', 'point', 'ride', 'row', 'swing', 'seesaw', 'rps', 'cycle']);

/** Two standing activity frames mixed, `k` 0 (all `prev`) to 1 (all `cur`); either may be null (standing plain). Each
 *  hand goes from one goal to the other, or eases on (off) from the plain posture by its arm weight; leg, lean, hop and
 *  look numbers are mixed; the rest is the nearer frame's. A lying `cur` eased in from nothing keeps its layout, its
 *  raise eased by `k` (0: flat on the back). */
export function blendFrames(prev: ActivityFrame | null, cur: ActivityFrame | null, k: number): ActivityFrame | null {
  const lying = cur?.lying && (!prev || prev.lying?.face === cur.lying.face) ? cur.lying : !cur && prev?.lying ? prev.lying : null;
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
  const out: ActivityFrame = { ...near, hands: hands[0] || hands[1] ? hands : null, handW: w, rootHands: undefined, lying: lying ? { ...lying, raise: mix(prev?.lying?.raise, cur?.lying?.raise) } : null,
    feetOut: mix(prev?.feetOut, cur?.feetOut), hop: mix(prev?.hop, cur?.hop), lean: mix(prev?.lean, cur?.lean), side: mix(prev?.side, cur?.side), look: mix(prev?.look, cur?.look) };
  if (prev?.mouth !== undefined || cur?.mouth !== undefined) out.mouth = mix(prev?.mouth, cur?.mouth);
  return out;
}
