import { postureKind, SIT_DOWN, STAND_UP, type PostureChange } from './posture-transition.ts';

/** The same seat clips and durations, retargeted from their attained fraction. */
export function seatTransition(c: PostureChange | undefined, activity: string, base?: string): { activity: 'sit-down' | 'stand-up'; since: number; end: number; fraction: number } | null {
  return seatPlan(c, activity, base, 0);
}

function seatPlan(c: PostureChange | undefined, activity: string, base: string | undefined, offset: number): ReturnType<typeof seatTransition> {
  if (!c || c.age - offset < 0) return null;
  const age = c.age - offset;
  const from = postureKind(c.from, c.fromBase), to = postureKind(activity, base);
  if (from === to || !['stand', 'seat'].includes(from) || !['stand', 'seat'].includes(to)) return null;
  let start = from === 'seat' ? 1 : 0;
  if (c.before) {
    // Keep recorded ages immutable; the preceding change is sampled at this boundary.
    const origin = seatPlan(c.before, c.before.to, c.fromBase, c.age);
    if (origin) start = origin.fraction;
  }
  const entering = to === 'seat', duration = entering ? SIT_DOWN : STAND_UP;
  const since = (entering ? start : 1 - start) * duration + age;
  return { activity: entering ? 'sit-down' : 'stand-up', since, end: (entering ? 1 - start : start) * duration,
    fraction: Math.max(0, Math.min(1, entering ? since / duration : 1 - since / duration)) };
}
