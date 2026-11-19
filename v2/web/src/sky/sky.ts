// The sky, daylight and weather drawn from the record (Engine v2 V19, #2763). Everything drawn is a function of E6's
// fields on the world node (`record.ts`) and the world time being drawn, so a seek to a moment draws what playing to it
// draws: the sun's direction and colour (`sun.ts`), the sky's colour (today's `daylight.ts` blend of night, dusk and
// day, greyed toward overcast by the announced cloud as `WorldAtmosphere.ts` does), the fog, the lights' strengths, and
// rain while the announced weather rains (`rain.ts`). Weather is a fact: a change shows at the world time the record
// changed it, with no easing over the page's own time. V19b (#3508): today's dome (`dome.ts`) with its stars, moon
// (`astro.ts`) and clouds, its uniforms set by `WorldAtmosphere.ts`'s formulas from the record, and today's colour
// grade (`grade.ts`).
import * as THREE from 'three';
import { skyBodies, twilightColour } from './astro.ts';
import { SkyDome } from './dome.ts';
import { installGrade, setGrade } from './grade.ts';
import { Rain, hash01 } from './rain.ts';
import { readSky, type SkyFields, type SkyRecord } from './record.ts';
import { daylightFactors, sunAt } from './sun.ts';

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
};

/** The rain level that draws every drop (E6's `souls:rain` is 60, as today's rain draws them all). */
const FULL_RAIN = 60;

/** What the sky is at world time `t` on record `r` (null: no sky announced yet). */
export function skyState(r: SkyRecord | null, t: number): SkyState {
  if (!r) return { sun: [0.5, 0.7, 0.4], elevation: null, daylight: 1, background: NO_SKY.clone(), fog: NO_SKY.clone(), grey: overcast(NO_SKY), sunColour: SUN_WHITE.clone(), sunIntensity: SUN_DAY, hemiColour: new THREE.Color(0xffffff), hemiIntensity: HEMI_DAY, cloud: 0, rain: 0, wind: 0 };
  const s = sunAt(r, t), f = daylightFactors(s.elevationDeg);
  const cloud = Math.min(1, Math.max(0, r.cloud / 100)), wind = Math.min(1, Math.max(0, r.wind / 100)), rain = Math.min(1, Math.max(0, r.rain / FULL_RAIN));
  const base = NIGHT_SKY.clone().lerp(DUSK_SKY, Math.max(f.warmth * f.daylight, f.blueHour * 0.4)).lerp(DAY_SKY, f.daylight * (1 - f.warmth * 0.6));
  // Today's `applyWeather`: the sky greys toward overcast with cloud, the fog is a lighter grey, and rain hazes the sky
  // toward the fog.
  const grey = overcast(base), sky = base.clone().lerp(grey, cloud * 0.8);
  const fog = grey.clone().multiplyScalar(1.08 + 0.1 * f.daylight).lerp(sky, 0.35);
  const bg = sky.clone().lerp(fog, Math.min(1, rain * 0.25));
  return {
    sun: s.direction, elevation: s.elevationDeg, daylight: f.daylight, background: bg, fog, grey,
    sunColour: SUN_WHITE.clone().lerp(SUN_WARM, f.warmth * 0.7),
    sunIntensity: SUN_DAY * f.daylight * (1 - 0.72 * cloud),
    hemiColour: MOON_HEMI.clone().lerp(SUN_WHITE, f.daylight),
    // Today's observer fill: 0.75 at night to 1.7 at day, scaled to the page's day value; a little less under cloud.
    hemiIntensity: HEMI_DAY * ((0.75 + 0.95 * f.daylight) / 1.7) * (1 - 0.1 * cloud),
    cloud, rain, wind,
  };
}

/** Sets the dome's uniforms for world time `t` from the state, as today's `applyWeather` does from its weather (no fog
 *  or mist: the record announces neither). Clouds drift downwind by world time: today's drift integrated over the
 *  page's frames, here a pure function of world time, along today's direction for the local day. */
export function setDome(d: SkyDome, s: SkyState, r: SkyRecord | null, t: number, sunDir: THREE.Vector3): void {
  const u = d.uniforms, day = s.daylight, seconds = t / 1e6;
  u.uZenith.value.copy(s.background).multiplyScalar(0.94);
  u.uHorizon.value.copy(s.background).lerp(WHITE, 0.16 * day);
  const lit = s.grey.clone().lerp(WHITE, 0.55).multiply(WHITE.clone().lerp(s.sunColour, 0.85).multiplyScalar(1.12));
  u.uCloudLit.value.copy(s.grey).multiplyScalar(1.12).lerp(lit, Math.min(1, day * 1.4));
  u.uCloudShade.value.copy(s.grey).multiplyScalar(0.88 - 0.24 * day);
  const bodies = r && skyBodies(r, t);
  const a = hash01(bodies?.day ?? 0, 313) * Math.PI * 2, drift = (seconds * (2 + 6 * s.wind) * 0.011) % 1000;
  u.uCloud.value.set(Math.min(1, 0.18 + 0.82 * s.cloud + s.rain * 0.1), Math.cos(a) * drift * 2.2, Math.sin(a) * drift * 2.2, day);
  u.uSunDir.value.copy(sunDir);
  u.uBow.value.set(0, (1 - smooth(0.05, 0.3, day)) * (1 - smooth(0.3, 0.75, s.cloud)), seconds % 600, Math.min(0.9, s.rain * 0.25));
  if (!bodies) {
    u.uSun.value.w = u.uMoon.value.w = u.uDusk.value.w = 0;
    u.uMoonLight.value.set(0, 0, 1, 0);
    setGrade(day, 0, 0, s.cloud);
    return;
  }
  const b = bodies;
  u.uSun.value.set(b.sun.x, b.sun.y, b.sun.z, smooth(-1.2, 0.8, b.sunElevation));
  u.uSunColor.value.copy(s.sunColour);
  const moonUp = smooth(-1.5, 1.5, (Math.asin(Math.max(-1, Math.min(1, b.moon.y))) * 180) / Math.PI);
  u.uMoon.value.set(b.moon.x, b.moon.y, b.moon.z, moonUp * (0.3 + 0.7 * (1 - day)));
  u.uMoonLight.value.set(b.illumination, 1 - smooth(0.05, 0.4, day), 1 - 0.75 * b.illumination, 0);
  u.uStarRot.value.copy(b.starRotation);
  // A warm band on the sun's side at dawn and dusk, into a rosy-violet afterglow in the blue hour; less under cloud.
  const dusk = (b.warmth * smooth(-0.2, 0.6, day) * 0.55 + b.blueHour * 0.35) * (1 - 0.75 * s.cloud);
  const warm = s.sunColour.clone().lerp(new THREE.Color(1, 0.55, 0.38), 0.5).lerp(new THREE.Color(0.62, 0.42, 0.62), b.blueHour * 0.7);
  const glow = twilightColour(b.sunElevation, s.cloud, b.day), glowColour = new THREE.Color(...glow.rgb);
  warm.lerp(glowColour, glow.strength * 0.6);
  u.uDusk.value.set(warm.r, warm.g, warm.b, dusk + glow.strength * 0.12);
  u.uCloudLit.value.lerp(glowColour.multiplyScalar(0.95), glow.strength * 0.28);
  u.uBow.value.y *= 1 - 0.5 * b.illumination * moonUp;
  setGrade(day, b.warmth, b.blueHour, s.cloud);
}

/** The page's sky: owns the scene's background and fog colour, the hemisphere light and the sun's direction, colour and
 *  strength, the dome and the rain. `apply` takes every node a part or a seek carries; `update` draws a world time. */
export class WorldSky {
  readonly rain = new Rain();
  readonly dome = new SkyDome();
  state: SkyState = skyState(null, 0);
  /** The records read, each with the world time it holds from, in the order applied (a seek starts the list again). */
  private entries: { from: number; rec: SkyRecord }[] = [];
  private readonly scene: THREE.Scene;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  constructor(scene: THREE.Scene, hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight, rain = true) {
    this.scene = scene;
    this.hemi = hemi;
    this.sun = sun;
    scene.background = NO_SKY.clone();
    installGrade(); // today's grade in every fogged material, before any compiles
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
    const r = this.recordAt(t), s = (this.state = skyState(r, t));
    (this.scene.background as THREE.Color).copy(s.background);
    this.scene.fog?.color.copy(s.fog);
    this.sun.color.copy(s.sunColour);
    this.sun.intensity = s.sunIntensity;
    this.hemi.color.copy(s.hemiColour);
    this.hemi.intensity = s.hemiIntensity;
    this.rain.update(t / 1e6, s.rain, s.daylight, camera, s.wind);
    const dir = new THREE.Vector3(...s.sun);
    if (dir.y < 0.05) dir.y = 0.05; // below the horizon: the shadow camera stays sane; its strength is ~0 anyway
    dir.normalize();
    setDome(this.dome, s, r, t, dir);
    this.dome.follow(camera);
    return dir;
  }
}
