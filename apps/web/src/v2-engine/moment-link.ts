// X3 (0.134): a link to a moment on the old page, for a moved world. The page's address names the world, so the link
// adds only the world time, in microseconds after `#t=` (the v2 page's key, `v2/web/src/history/link.ts`, copied): the
// moment is never sent to a server, and a time means the same a day later. Opening the link shows the world at that
// moment and plays from there, for as long as the world's history keeps it.
import { TICK_US } from './takes.ts';

/** The take tick a link names, or null when the fragment has none. */
export function momentTick(hash: string): number | null {
  const t = new URLSearchParams(hash.replace(/^#/, '')).get('t') ?? '', at = Number(t);
  return /^\d+$/.test(t) && Number.isSafeInteger(at) ? Math.floor(at / TICK_US) : null;
}

/** The page's address with the moment at take tick `tick` as its fragment (any other fragment is replaced). */
export function momentLink(href: string, tick: number): string {
  const u = new URL(href);
  u.hash = new URLSearchParams({ t: String(Math.round(tick * TICK_US)) }).toString();
  return u.href;
}

/** The tick a seek shows: never past now, and no earlier than the last hour unless the world's history keeps more. */
export const seekTick = (wanted: number, now: number, hourTicks: number, anyTime: boolean) =>
  Math.floor(Math.max(anyTime ? 0 : now - hourTicks, Math.min(now, wanted), 0));

/** How near now the stream's clock is taken to have caught up (a link names a past time), µs. */
const NEAR_US = 120e6;
/** World times from here on (1 January 2000, µs since the Unix epoch) are a real-time world's: its clock reads as the
 *  wall's (an imported world, Eden). A world made through New world keeps its own clock, in its day 0 whatever the date
 *  (history-keys.ts walk), and reaches this after thirty years. */
const WALL_FROM_US = 946_684_800e6;

/** A link's seek does not wait for the live stream. Opened cold, the stream starts at its last checkpoint, up to hours
 *  before now (Eden on soul.game: an hour), and reaches now only seconds later (10 to 11 s into the page); the seek used
 *  to wait for that, although the moment is read from the world's history and needs nothing the stream gives. This is
 *  the world's take tick now that the link's seek goes by, or null to wait for the stream. A past moment of a real-time
 *  world: the wall clock's (`wallUs`, µs since the Unix epoch), whatever the stream has shown, nothing at all included
 *  (`shown` null). Otherwise the shown clock, once it has reached the moment or is about now: a world whose clock is
 *  its own, and a moment the wall clock has not reached. */
export function landingNow(shown: number | null, moment: number, wallUs: number): number | null {
  const at = moment * TICK_US;
  if (at >= WALL_FROM_US && at <= wallUs) return Math.max(shown ?? 0, Math.floor(wallUs / TICK_US));
  if (shown === null) return null;
  return shown >= moment || wallUs - shown * TICK_US <= NEAR_US ? shown : null;
}
