// The sun at a world time (Engine v2 V19, #2763), carried over from today's page: the NOAA/Spencer ephemeris of
// `mars/viewer/engine/env/sun.ts` and the daylight factors of `mars/viewer/engine/env/daylight.ts`, on the world's
// own calendar (`record.ts`). As today's real-time worlds (`apps/web/src/sun-site.ts`), the sun is an equator sun on
// the world's local clock: the site is at latitude 0 and the longitude whose solar noon is 12:00 local, so sunrise is
// near 06:00 and sunset near 18:00 all year (within the equation of time). A day of 23 or 25 hours is the offset in
// force changing; the sun follows the local clock through it.
import { civil, localAt, offsetAt, type SkyRecord } from './record.ts';

const D = Math.PI / 180;
/** Degrees added to a compass azimuth before projecting to x/z: the engine's north is −z (today's entity worlds,
 *  `apps/web/src/site-north.ts`), so the sun rises in +x and stands in +z at noon. */
export const NORTH = 0;

const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function dayOfYear(y: number, m: number, d: number): number {
  let n = d;
  for (let i = 0; i < m - 1; i++) n += MONTH_DAYS[i] + (i === 1 && leap(y) ? 1 : 0);
  return n;
}

/** Meeus's refraction correction (degrees) for a true elevation. */
function refraction(e: number): number {
  if (e > 85) return 0;
  const te = Math.tan(e * D);
  const s = e > 5 ? 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5
    : e > -0.575 ? 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)))
      : -20.774 / te;
  return s / 3600;
}

export type Sun = {
  /** Apparent elevation, degrees; azimuth, degrees clockwise from north. */
  elevationDeg: number;
  azimuthDeg: number;
  /** Unit vector from the ground toward the sun, in the world's frame (y up). */
  direction: [number, number, number];
};

/** The sun at a local civil time (`hour` of day `y-m-d`), with the zone's offset `tz` hours, at `lat`, `lon`. */
export function solar(y: number, m: number, d: number, hour: number, tz: number, lat: number, lon: number, north = NORTH): Sun {
  const gamma = ((2 * Math.PI) / (leap(y) ? 366 : 365)) * (dayOfYear(y, m, d) - 1 + (hour - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const ha = (hour * 60 + eqtime + 4 * lon - 60 * tz) / 4 - 180;
  const cosZen = Math.max(-1, Math.min(1, Math.sin(lat * D) * Math.sin(decl) + Math.cos(lat * D) * Math.cos(decl) * Math.cos(ha * D)));
  const trueEl = 90 - Math.acos(cosZen) / D;
  const sinZen = Math.sqrt(Math.max(0, 1 - cosZen * cosZen));
  let az = 180;
  if (sinZen >= 1e-6) {
    const x = Math.max(-1, Math.min(1, (Math.sin(lat * D) * cosZen - Math.sin(decl)) / (Math.cos(lat * D) * sinZen)));
    az = ha > 0 ? 180 + Math.acos(x) / D : 180 - Math.acos(x) / D;
  }
  az = ((az % 360) + 360) % 360;
  const el = trueEl + refraction(trueEl);
  const a = (az + north) * D, e = el * D;
  return { elevationDeg: el, azimuthDeg: az, direction: [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)] };
}

/** The sun at world time `t` (µs) on the record's calendar: the equator sun on the local clock. */
export function sunAt(r: SkyRecord, t: number): Sun {
  const { y, m, d, hour } = civil(localAt(r, t), r.skyDate);
  const tz = offsetAt(r, t) / 3_600_000_000;
  return solar(y, m, d, hour, tz, 0, 15 * tz);
}

const smooth = (x: number, a: number, b: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** Today's daylight factors for a solar elevation (degrees): day 0..1, night, warmth (low sun) and the blue hour. */
export function daylightFactors(el: number): { daylight: number; night: number; warmth: number; blueHour: number } {
  const s = Math.sin(el * D);
  return {
    daylight: smooth(s, -0.12, 0.22),
    night: 1 - smooth(s, -0.2, 0.06),
    warmth: 1 - smooth(s, 0.02, 0.55),
    blueHour: smooth(el, -8, -3) * (1 - smooth(el, -3, 1)),
  };
}
