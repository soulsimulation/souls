/** Bounded presentation samples over observations. This module never owns an elapsed clock. */
export type ClipObservation = { identity: object; duration: number; phase: number };
export type AnimationObservation = {
  actor: string;
  source: 'native' | 'sampled';
  tick: number;
  dt: number;
  time: number;
  idle: ClipObservation;
  walk: ClipObservation;
  walkWeight: number;
  /** The phase advance already used to produce this native observation, before wrapping. */
  walkAdvance?: number;
  restAge?: number;
  restReset?: boolean;
};
export type ObservedAnimationSample = {
  kind: 'sampled';
  time: number;
  nativeTime: number;
  idle: number;
  walk: number;
  restAge?: number;
  /** Existing normalized rest envelope, when its duration is supplied by the pose policy. */
  restOnset?: number;
  walkMode: 'single' | 'advance' | 'wrap' | 'start' | 'stop' | 'stopped';
  restMode: 'single' | 'advance' | 'reset' | 'unknown';
} | { kind: 'fallback'; reason: string };

const finite = Number.isFinite;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
const phase = (n: number, duration: number) => ((n % duration) + duration) % duration;
function clipValid(c: ClipObservation) {
  return !!c.identity && finite(c.duration) && c.duration > 0 && finite(c.phase) && c.phase >= 0 && c.phase < c.duration;
}
function frameValid(f: AnimationObservation) {
  return !!f.actor && finite(f.tick) && finite(f.dt) && f.dt > 0 && finite(f.time) &&
    clipValid(f.idle) && clipValid(f.walk) && finite(f.walkWeight) && f.walkWeight >= 0 && f.walkWeight <= 1 &&
    (f.restAge === undefined || finite(f.restAge) && f.restAge >= 0);
}
const sameClip = (a: ClipObservation, b: ClipObservation) => a.identity === b.identity && a.duration === b.duration;

/** Same inputs always produce the same sample, including fresh, repeated and backward seeks. */
export function observedAnimationSample(a: AnimationObservation | undefined, b: AnimationObservation | undefined, alpha: number, restOnsetSeconds?: number): ObservedAnimationSample {
  const fallback = (reason: string): ObservedAnimationSample => ({ kind: 'fallback', reason });
  if (!a || !b) return fallback('missing-observation');
  if (!finite(alpha) || alpha < 0 || alpha > 1) return fallback('invalid-alpha');
  if (restOnsetSeconds !== undefined && (!finite(restOnsetSeconds) || restOnsetSeconds <= 0)) return fallback('invalid-rest-envelope');
  const onset = (age: number | undefined) => {
    if (restOnsetSeconds === undefined) return undefined;
    if (age === undefined) return 1;
    const k = Math.max(0, Math.min(1, age / restOnsetSeconds));return k * k * (3 - 2 * k);
  };
  if (!frameValid(a) || !frameValid(b)) return fallback('invalid-observation');
  if (a.actor !== b.actor || a.source !== b.source || a.dt !== b.dt) return fallback('mixed-source');
  if (!sameClip(a.idle, b.idle) || !sameClip(a.walk, b.walk)) return fallback('changed-clip');
  const ticks = b.tick - a.tick, seconds = ticks * b.dt;
  if (ticks < 0 || ticks > 1 || !close(b.time - a.time, seconds)) return fallback('unobserved-interval');
  if (ticks === 0) {
    if (a.time !== b.time || a.idle.phase !== b.idle.phase || a.walk.phase !== b.walk.phase || a.restAge !== b.restAge) return fallback('mixed-sample');
    return { kind: 'sampled', time: b.time, nativeTime: b.tick * b.dt, idle: b.idle.phase, walk: b.walk.phase,
      restAge: b.restAge, restOnset: onset(b.restAge), walkMode: 'single', restMode: 'single' };
  }
  if (a.source === 'native' && ticks !== 1) return fallback('unobserved-interval');
  const idleEnd = phase(a.idle.phase + seconds, b.idle.duration);
  if (!close(idleEnd, b.idle.phase) && !close(Math.abs(idleEnd - b.idle.phase), b.idle.duration)) return fallback('idle-reset');
  let walk: number, walkMode: Extract<ObservedAnimationSample, {kind: 'sampled'}>['walkMode'];
  if (a.walkWeight > 0 && b.walkWeight === 0 && b.walk.phase === 0) {
    walk = a.walk.phase; walkMode = 'stop';
  } else if (a.walkWeight === 0 && b.walkWeight > 0) {
    walk = b.walk.phase; walkMode = 'start';
  } else if (a.walkWeight === 0 && b.walkWeight === 0) {
    walk = b.walk.phase; walkMode = 'stopped';
  } else {
    const advance = b.walkAdvance;
    if (advance === undefined || !finite(advance) || advance < 0 || advance >= b.walk.duration ||
      !close(phase(a.walk.phase + advance, b.walk.duration), b.walk.phase)) return fallback('ambiguous-walk-advance');
    walk = phase(a.walk.phase + advance * alpha, b.walk.duration);
    walkMode = b.walk.phase < a.walk.phase ? 'wrap' : 'advance';
  }
  let restAge: number | undefined, restMode: Extract<ObservedAnimationSample, {kind: 'sampled'}>['restMode'];
  if (a.restAge === undefined && b.restAge === undefined) {
    restMode = 'unknown';
  } else if (a.restAge !== undefined && b.restAge !== undefined && close(b.restAge - a.restAge, seconds)) {
    restAge = a.restAge + (b.restAge - a.restAge) * alpha; restMode = 'advance';
  } else if (b.restReset && b.restAge === 0) {
    restAge = 0; restMode = 'reset';
  } else return fallback('ambiguous-rest-envelope');
  let restOnset = onset(restAge);
  if (restMode === 'reset' && restOnsetSeconds !== undefined) {
    // Reset is an observed endpoint policy, not an early switch for the entire interval.
    const from = onset(a.restAge)!, to = onset(b.restAge)!;
    restOnset = alpha === 0 ? from : alpha === 1 ? to : from + (to - from) * alpha;
  }
  return { kind: 'sampled', time: alpha === 0 ? a.time : alpha === 1 ? b.time : a.time + (b.time - a.time) * alpha,
    nativeTime: (alpha === 0 ? a.tick : alpha === 1 ? b.tick : a.tick + ticks * alpha) * b.dt,
    idle: alpha === 0 ? a.idle.phase : alpha === 1 ? b.idle.phase : phase(a.idle.phase + seconds * alpha, b.idle.duration),
    walk, restAge, restOnset, walkMode, restMode };
}
