// #1649: on a real-time world the sun is an equator sun on the world's local clock: sunrise near 06:00 and sunset near
// 18:00 local, all year (within the equation of time, about a quarter hour). The streamed datetime is already the local
// time in the world's zone; the sun model (mars/viewer/engine/env/sun.ts) reads a datetime as Pacific local time, so the
// site sits on the equator at the longitude whose solar noon is 12:00 on that clock (15° per hour of its UTC offset).
// Every other world keeps the Bombay Beach sun it always had.
import { losAngelesUtcOffsetHours, parseLocalDateTime } from '../../../mars/viewer/engine/env/sun.ts';

let equator = false;
/** The world's clock is real time (`state.time.clock === 'real'`): light it with the equator sun. */
export function setEquatorSun(on: boolean) { equator = on; }
export const equatorSun = () => equator;
/** Whether a world's state puts it on real time. */
export const realClockOf = (state: unknown) => (state as { time?: { clock?: unknown } } | null)?.time?.clock === 'real';

/** The sun's site for a local datetime: [lat, lon], or [undefined, undefined] for the sun model's default site. */
export function sunSite(localIso: string): [number | undefined, number | undefined] {
  if (!equator) return [undefined, undefined];
  const t = parseLocalDateTime(localIso);
  return [0, 15 * losAngelesUtcOffsetHours(t.year, t.month, t.day, 12)];
}
