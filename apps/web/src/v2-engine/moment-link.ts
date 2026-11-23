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
