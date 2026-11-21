// The sky, daylight and weather drawn from the record (Engine v2 V19, #2763). Everything drawn is a function of E6's
// fields on the world node (`record.ts`) and the world time being drawn, so a seek to a moment draws what playing to it
// draws: the sun's direction and colour (`sun.ts`), the sky's colour (today's `daylight.ts` blend of night, dusk and
// day, greyed toward overcast by the announced cloud as `WorldAtmosphere.ts` does), the fog, the lights' strengths, and
// rain while the announced weather rains (`rain.ts`). Weather is a fact: a change shows at the world time the record
// changed it, with no easing over the page's own time. V19b (#3508): today's dome (`dome.ts`) with its stars, moon
// (`astro.ts`) and clouds, its uniforms set by `WorldAtmosphere.ts`'s formulas from the record, and today's colour
// grade (`grade.ts`). V19c (#3521): a world's sky date (`record.ts`), palette (`palette.ts`), morning mist (`mist.ts`)
// and today's fog of the announced weather, as `WorldAtmosphere.ts` draws them; a world without these settings draws
// as V19b.
import * as THREE from 'three';
import { skyBodies, twilightColour } from './astro.ts';
import { SkyDome } from './dome.ts';
import { installGrade, setGrade } from './grade.ts';
import { ATMOS, MIST, installMist } from './mist.ts';
import { skyLook, type SkyLook } from './palette.ts';
import { Rain, hash01 } from './rain.ts';
import { civil, localAt, readSky, type SkyFields, type SkyRecord } from './record.ts';
import { daylightFactors, sunAt } from './sun.ts';
import { hourTime } from './hour.ts';
import { setWind } from './wind.ts';

const WHITE = new THREE.Color(1, 1, 1);
const smooth = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** Today's overcast grey of a sky colour's brightness (`atmosphere/lighting.ts`). */
const overcast = (c: THREE.Color) => {
  const l = (c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722) * 0.92;
  return new THREE.Color().setRGB(l * 0.97, l, l * 1.04);
};

const DAY_SKY = new THREE.Color('#a6bed0'), NIGHT_SKY = new THREE.Color('#121a2b'), DUSK_SKY = new THREE.Color('#d99a6c');
const SUN_WHITE = new THREE.Color('#fff2dc'), SUN_WARM = new THREE.Color('#ffb36b'), MOON_HEMI = new THREE.Color(0x9fb3d9);
/** The page's lights at full day, clear (V5's values, which V8's things were tuned under). */
const SUN_DAY = 1.4, HEMI_DAY = 1.6;
/** Before the world node holds its calendar: V5's soft midday. */
const NO_SKY = new THREE.Color(0xbcd3e6);

export type SkyState = {
  /** Toward the sun (unit, y up); elevation degrees, null without a calendar. */
  sun: [number, number, number];
  elevation: number | null;
  daylight: number;
  /** The sky's colour (today's background, weathered by cloud and rain), the fog's, and the overcast grey under both. */
  background: THREE.Color;
  fog: THREE.Color;
  grey: THREE.Color;
  sunColour: THREE.Color;
  sunIntensity: number;
  hemiColour: THREE.Color;
  hemiIntensity: number;
  /** The announced levels, 0..1; `rain` is the drawn rain's share of its drops. */
  cloud: number;
  rain: number;
  wind: number;
  /** V19c: today's fog (0..1) of the announced weather and the morning mist (0..1), both 0 on a world without mist
   *  settings; the world's palette, or null. */
  fogLevel: number;
  mist: number;
  look: SkyLook | null;
};

/** Today's fog of each weather kind, and the share of the morning mist each lets through (`atmosphere/weather.ts`
 *  `targetFor`: fog 1 with mist 0.8 of its own; any other kind 0.1 of the mist). */
const KIND_FOG: Record<string, number> = { 'souls:cloudy': 0.03, 'souls:rain': 0.25, 'souls:storm': 0.3, 'souls:fog': 1 };
const KIND_MIST: Record<string, number> = { 'souls:clear': 0.45, 'souls:cloudy': 0.35, 'souls:fog': 1 };
/** Today's fog and mist at world time `t` on a world with mist settings (else none): the mist peaks at its peak hour
 *  and is gone a half-width either side, scaled by its strength and the kind's share. */
function fogAndMist(r: SkyRecord, t: number): { fog: number; mist: number } {
  if (!r.mist) return { fog: 0, mist: 0 };
  const kind = r.weather ?? '', hour = civil(localAt(r, t)).hour, [peak, half, strength] = r.mist;
  const morning = Math.max(0, 1 - Math.abs(hour - peak / 3_600_000_000) / (half / 3_600_000_000)) * (strength / 100);
  return { fog: KIND_FOG[kind] ?? 0, mist: Math.min(1, Math.max(kind === 'souls:fog' ? 0.8 : 0, morning * (KIND_MIST[kind] ?? 0.1))) };
}
/** How far a palette moves the sky by day: less under cloud and fog (today's `applyWeather`). */
const paletteShare = (s: SkyState) => s.daylight * (1 - 0.85 * s.cloud) * (1 - s.fogLevel);

/** The rain level that draws every drop (E6's `souls:rain` is 60, as today's rain draws them all). */
const FULL_RAIN = 60;

/** What the sky is at world time `t` on record `r` (null: no sky announced yet). */
export function skyState(r: SkyRecord | null, t: number): SkyState {
  if (!r) return { sun: [0.5, 0.7, 0.4], elevation: null, daylight: 1, background: NO_SKY.clone(), fog: NO_SKY.clone(), grey: overcast(NO_SKY), sunColour: SUN_WHITE.clone(), sunIntensity: SUN_DAY, hemiColour: new THREE.Color(0xffffff), hemiIntensity: HEMI_DAY, cloud: 0, rain: 0, wind: 0, fogLevel: 0, mist: 0, look: null };
  const s = sunAt(r, t), f = daylightFactors(s.elevationDeg), { fog: fogLevel, mist } = fogAndMist(r, t);
  const cloud = Math.min(1, Math.max(0, r.cloud / 100)), wind = Math.min(1, Math.max(0, r.wind / 100)), rain = Math.min(1, Math.max(0, r.rain / FULL_RAIN));
  const base = NIGHT_SKY.clone().lerp(DUSK_SKY, Math.max(f.warmth * f.daylight, f.blueHour * 0.4)).lerp(DAY_SKY, f.daylight * (1 - f.warmth * 0.6));
  // Today's `applyWeather`: the sky greys toward overcast with cloud, the fog is a lighter grey, and rain hazes the sky
  // toward the fog, as fog does.
  const grey = overcast(base), sky = base.clone().lerp(grey, cloud * 0.8);
  const fog = grey.clone().multiplyScalar(1.08 + 0.1 * f.daylight).lerp(sky, 0.35);
  const bg = sky.clone().lerp(fog, Math.min(1, fogLevel * 0.9 + rain * 0.25));
  return {
    sun: s.direction, elevation: s.elevationDeg, daylight: f.daylight, background: bg, fog, grey,
    sunColour: SUN_WHITE.clone().lerp(SUN_WARM, f.warmth * 0.7),
    sunIntensity: SUN_DAY * f.daylight * (1 - 0.72 * cloud),
    hemiColour: MOON_HEMI.clone().lerp(SUN_WHITE, f.daylight),
    // Today's observer fill: 0.75 at night to 1.7 at day, scaled to the page's day value; a little less under cloud.
    hemiIntensity: HEMI_DAY * ((0.75 + 0.95 * f.daylight) / 1.7) * (1 - 0.1 * cloud - 0.08 * fogLevel),
    cloud, rain, wind, fogLevel, mist, look: skyLook(r.palette),
  };
}

/** Sets the dome's uniforms for world time `t` from the state, as today's `applyWeather` does from its weather, its
 *  fog and mist (V19c) and its palette; `layer` is how much of the fog's ground layer the camera looks through. Clouds
 *  drift downwind by world time: today's drift integrated over the page's frames, here a pure function of world time,
 *  along today's direction for the local day; the mist's patches drift with them. */
export function setDome(d: SkyDome, s: SkyState, r: SkyRecord | null, t: number, sunDir: THREE.Vector3, layer = 1): void {
  const u = d.uniforms, day = s.daylight, seconds = t / 1e6, fog = s.fogLevel;
  u.uZenith.value.copy(s.background).multiplyScalar(0.94);
  u.uHorizon.value.copy(s.background).lerp(WHITE, 0.16 * day).lerp(s.fog, Math.min(1, fog + s.mist * 0.3));
  const lit = s.grey.clone().lerp(WHITE, 0.55).multiply(WHITE.clone().lerp(s.sunColour, 0.85).multiplyScalar(1.12));
  u.uCloudLit.value.copy(s.grey).multiplyScalar(1.12).lerp(lit, Math.min(1, day * 1.4));
  u.uCloudShade.value.copy(s.grey).multiplyScalar(0.88 - 0.24 * day);
  if (s.look) {
    const k = paletteShare(s);
    u.uZenith.value.lerp(s.look.zenith, k);
    u.uHorizon.value.lerp(s.look.horizon, k);
  }
  const bodies = r && skyBodies(r, t);
  const a = hash01(bodies?.day ?? 0, 313) * Math.PI * 2, drift = (seconds * (2 + 6 * s.wind) * 0.011) % 1000;
  u.uCloud.value.set(Math.min(1, 0.18 + 0.82 * s.cloud + s.rain * 0.1), Math.cos(a) * drift * 2.2, Math.sin(a) * drift * 2.2, day);
  ATMOS.value.z = -Math.cos(a) * drift;
  ATMOS.value.w = -Math.sin(a) * drift;
  setWind(seconds, s.wind, a); // C9: plants and cloth sway with the wind, along today's bearing for the day
  u.uSunDir.value.copy(sunDir);
  u.uBow.value.set(0, (1 - smooth(0.05, 0.3, day)) * (1 - smooth(0.3, 0.75, s.cloud)) * (1 - fog) * (1 - s.mist * 0.5), seconds % 600, Math.min(0.9, fog * 0.9 * layer + s.rain * 0.25));
  if (!bodies) {
    u.uSun.value.w = u.uMoon.value.w = u.uDusk.value.w = 0;
    u.uMoonLight.value.set(0, 0, 1, 0);
    setGrade(day, 0, 0, s.cloud);
    return;
  }
  const b = bodies;
  u.uSun.value.set(b.sun.x, b.sun.y, b.sun.z, smooth(-1.2, 0.8, b.sunElevation) * (1 - fog * 0.9));
  u.uSunColor.value.copy(s.sunColour);
  const moonUp = smooth(-1.5, 1.5, (Math.asin(Math.max(-1, Math.min(1, b.moon.y))) * 180) / Math.PI);
  u.uMoon.value.set(b.moon.x, b.moon.y, b.moon.z, moonUp * (0.3 + 0.7 * (1 - day)) * (1 - fog * 0.85));
  u.uMoonLight.value.set(b.illumination, 1 - smooth(0.05, 0.4, day), 1 - 0.75 * b.illumination, 0);
  u.uStarRot.value.copy(b.starRotation);
  // A warm band on the sun's side at dawn and dusk, into a rosy-violet afterglow in the blue hour; less under cloud.
  const dusk = (b.warmth * smooth(-0.2, 0.6, day) * 0.55 + b.blueHour * 0.35) * (1 - 0.75 * s.cloud) * (1 - fog);
  const warm = s.sunColour.clone().lerp(new THREE.Color(1, 0.55, 0.38), 0.5).lerp(new THREE.Color(0.62, 0.42, 0.62), b.blueHour * 0.7);
  const glow = twilightColour(b.sunElevation, s.cloud, b.day), glowColour = new THREE.Color(...glow.rgb);
  warm.lerp(glowColour, glow.strength * 0.6);
  u.uDusk.value.set(warm.r, warm.g, warm.b, dusk + glow.strength * 0.12 * (1 - fog));
  u.uCloudLit.value.lerp(glowColour.multiplyScalar(0.95), glow.strength * 0.28 * (1 - fog));
  u.uBow.value.y *= 1 - 0.5 * b.illumination * moonUp;
  setGrade(day, b.warmth, b.blueHour, s.cloud);
}

/** The page's sky: owns the scene's background and fog colour, the hemisphere light and the sun's direction, colour and
 *  strength, the dome and the rain. `apply` takes every node a part or a seek carries; `update` draws a world time. */
export class WorldSky {
  readonly rain = new Rain();
  readonly dome = new SkyDome();
  state: SkyState = skyState(null, 0);
  /** #3795: a picture's local hour, minutes after midnight (`?hour=HH:MM`), or null for the world's own time. Only the
   *  sky, its light and the lit windows are drawn at it; the record in force and the rain keep world time. */
  hour: number | null = null;
  /** The records read, each with the world time it holds from, in the order applied (a seek starts the list again). */
  private entries: { from: number; rec: SkyRecord }[] = [];
  private readonly scene: THREE.Scene;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  /** The scene's own fog (V19b's), and today's exp² fog for a world with a palette or mist (V19c). */
  private readonly linear: THREE.Fog | THREE.FogExp2 | null;
  private readonly exp2 = new THREE.FogExp2(0xbcd3e6, 0.0009);
  constructor(scene: THREE.Scene, hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight, rain = true) {
    this.scene = scene;
    this.hemi = hemi;
    this.sun = sun;
    this.linear = scene.fog;
    scene.background = NO_SKY.clone();
    installGrade(); // today's grade in every fogged material, before any compiles
    installMist(); // and today's mist
    if (rain) scene.add(this.rain.mesh, this.dome.mesh);
  }
  /** Takes the nodes a live part carries (with its span) or a seek gives (no span: the state at the moment). A part is
   *  played before the page draws its times, so a changed weather holds from the world time it changed: the timer's
   *  due time (the previous record's next change) when it falls in the part, else the part's start (a creator's). */
  apply(nodes: { sky?: SkyFields }[], part?: { from: number; to: number }): void {
    for (const n of nodes) {
      const rec = n.sky && readSky(n.sky);
      if (!rec) continue;
      const prev = this.entries.at(-1)?.rec;
      if (!part || !prev) {
        this.entries = [{ from: -Infinity, rec }];
        continue;
      }
      const changed = prev.weather !== rec.weather || prev.cloud !== rec.cloud || prev.rain !== rec.rain || prev.wind !== rec.wind;
      const due = prev.weatherNext;
      this.entries.push({ from: changed && due !== null && due <= part.to ? due : part.from, rec });
      if (this.entries.length > 16) this.entries.shift();
    }
  }
  /** The record in force at world time `t`. */
  recordAt(t: number): SkyRecord | null {
    let r = this.entries[0]?.rec ?? null;
    for (const e of this.entries) if (e.from <= t) r = e.rec;
    return r;
  }
  /** Draws world time `t` (µs); returns the direction toward the sun for the shadow's light. */
  update(t: number, camera: THREE.Camera): THREE.Vector3 {
    const r = this.recordAt(t), worldT = t;
    if (r && this.hour !== null) t = hourTime(r, t, this.hour);
    const s = (this.state = skyState(r, t));
    (this.scene.background as THREE.Color).copy(s.background);
    // V19c: a world with a palette or mist settings gets today's exp² fog, thickened by the weather's fog and rain
    // within its ground layer (thin from high up) and by cloud; its colour leans to the palette's horizon by day.
    const camY = camera.getWorldPosition(new THREE.Vector3()).y, layer = 1 / (1 + Math.max(0, camY - 6) / 10);
    const today = !!r && (r.mist !== null || s.look !== null);
    this.scene.fog = today ? this.exp2 : this.linear;
    if (today) this.exp2.density = 0.0009 * (s.look?.fog ?? 1) + (s.fogLevel * 0.022 + s.rain * 0.0055) * layer + s.cloud * 0.0006;
    this.scene.fog?.color.copy(s.fog);
    if (s.look) this.scene.fog?.color.lerp(s.look.horizon, paletteShare(s) * 0.6);
    MIST.value.x = Math.min(1, s.mist + s.fogLevel * 0.35);
    MIST.value.y = (t / 1e6) % 600;
    this.sun.color.copy(s.sunColour);
    this.sun.intensity = s.sunIntensity;
    this.hemi.color.copy(s.hemiColour);
    this.hemi.intensity = s.hemiIntensity;
    this.rain.update(worldT / 1e6, s.rain, s.daylight, camera, s.wind);
    const dir = new THREE.Vector3(...s.sun);
    if (dir.y < 0.05) dir.y = 0.05; // below the horizon: the shadow camera stays sane; its strength is ~0 anyway
    dir.normalize();
    setDome(this.dome, s, r, t, dir, layer);
    this.dome.follow(camera);
    return dir;
  }
}
