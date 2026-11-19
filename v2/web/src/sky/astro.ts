// The moon and the stars at a world time (Engine v2 V19b, #3508), carried over from today's
// `apps/web/src/atmosphere/astro.ts`: the moon's phase from the synodic month, the moon placed where the sun stood
// `elongation / 15` hours earlier (good to a few degrees), and the star field turned about the celestial pole at the
// sidereal rate. On the record's calendar and today's equator sun (`sun.ts`), so a seek draws what playing draws.
import * as THREE from 'three';
import { civil, offsetAt, skyLocalAt, type SkyRecord } from './record.ts';
import { daylightFactors, solar } from './sun.ts';

const SYNODIC = 29.530588853, NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14), DEG = Math.PI / 180, HOUR_US = 3_600_000_000;

export type SkyBodies = {
  sun: THREE.Vector3;
  moon: THREE.Vector3;
  /** 0 new .. 0.5 full .. 1 new; the lit fraction of the disc. */
  phase: number;
  illumination: number;
  sunElevation: number;
  warmth: number;
  blueHour: number;
  /** Takes a sky direction to the star field's own coordinates. */
  starRotation: THREE.Matrix3;
  /** Days since 1970 on the local calendar (today's twilight colour varies by day). */
  day: number;
};

/** Today's synodic phase of a civil ms (the 7.5 h fold is today's, kept so the phase matches it). */
export function moonPhase(ms: number): number {
  const p = ((ms + 7.5 * 3600e3 - NEW_MOON_MS) / 86400e3 / SYNODIC) % 1;
  return p < 0 ? p + 1 : p;
}

/** The sun's direction at local µs `local`, in the zone `tz` hours (today's equator site). */
function sunLocal(local: number, tz: number) {
  const { y, m, d, hour } = civil(local);
  return solar(y, m, d, hour, tz, 0, 15 * tz);
}

/** The sky's bodies at world time `t` (µs) on the record's calendar, on its sky date when it has one. */
export function skyBodies(r: SkyRecord, t: number): SkyBodies {
  const local = skyLocalAt(r, t), tz = offsetAt(r, t) / HOUR_US, ms = local / 1000;
  const phase = moonPhase(ms), elong = phase * 360;
  const s = sunLocal(local, tz), m = sunLocal(local - (elong / 15) * HOUR_US, tz);
  const a = sunLocal(local - 3 * HOUR_US, tz), b = sunLocal(local + 3 * HOUR_US, tz);
  const v = (d: [number, number, number]) => new THREE.Vector3(...d).normalize();
  const f = daylightFactors(s.elevationDeg);
  // The pole is the axis the sun turns about over the day; the stars turn about it at 15.041 degrees an hour.
  const pole = v(a.direction).cross(v(b.direction)).normalize();
  const angle = ((ms / 3600e3) * 15.041 * DEG) % (Math.PI * 2);
  return {
    sun: v(s.direction), moon: v(m.direction), phase, illumination: 0.5 * (1 - Math.cos(phase * 2 * Math.PI)),
    sunElevation: s.elevationDeg, warmth: f.warmth, blueHour: f.blueHour,
    starRotation: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationAxis(pole, -angle)),
    day: Math.floor(ms / 86_400_000),
  };
}

const smooth = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** Today's twilight glow (`atmosphere/twilight.ts`): its strength and colour by the sun's elevation, cloud and day. */
export function twilightColour(elevation: number, cloud: number, day: number): { strength: number; rgb: [number, number, number] } {
  const strength = smooth(-7, -1, elevation) * (1 - smooth(5, 17, elevation));
  const variation = (Math.sin(Math.floor(day) * 1.713 + 2.1) + 1) / 2;
  const rose = (1 - smooth(-2, 5, elevation)) * (0.25 + 0.55 * variation) * smooth(0.08, 0.6, cloud);
  return { strength: strength * (1 - smooth(0.8, 1, cloud) * 0.7), rgb: [1, 0.59 - 0.17 * rose, 0.31 + 0.23 * rose] };
}
