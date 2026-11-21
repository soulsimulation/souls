// A picture's time of day (#3795): `?hour=HH:MM` draws the sky, the light and the lit windows at that local hour of the
// world's own day, as today's `?shot=1&hour=HH:MM` does (`apps/web/src/world-env.ts` `parseShotHour`). Presentation
// only: the world's clock, its Souls, the stream and the sound keep world time, and nothing is sent.
import { localAt, type SkyRecord } from './record.ts';

const DAY_US = 86_400_000_000;

/** The hour an address asks for, in minutes after midnight, or null (none, or not `HH:MM`). */
export function parseHour(search: string): number | null {
  const hour = new URLSearchParams(search).get('hour');
  if (!hour || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hour)) return null;
  return Number(hour.slice(0, 2)) * 60 + Number(hour.slice(3));
}

/** The world time at which the sky is drawn for world time `t` at local hour `minutes`: the same local day, the time
 *  of day replaced (a world whose day is not 24 hours long moves by its own share of the day). */
export function hourTime(r: SkyRecord, t: number, minutes: number): number {
  const local = localAt(r, t), day = Math.floor(local / DAY_US) * DAY_US;
  const civil = day + minutes * 60_000_000 - local;
  return t + (r.dayS === 86_400 ? civil : Math.round((civil * r.dayS) / 86_400));
}
