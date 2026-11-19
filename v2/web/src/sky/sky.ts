// The sky, daylight and weather drawn from the record (Engine v2 V19, #2763). Everything drawn is a function of E6's
// fields on the world node (`record.ts`) and the world time being drawn, so a seek to a moment draws what playing to it
// draws: the sun's direction and colour (`sun.ts`), the sky's colour (today's `daylight.ts` blend of night, dusk and
// day, greyed toward overcast by the announced cloud as `WorldAtmosphere.ts` does), the fog, the lights' strengths, and
// rain while the announced weather rains (`rain.ts`). Weather is a fact: a change shows at the world time the record
// changed it, with no easing over the page's own time. The sky is a flat colour, not today's dome.
import * as THREE from 'three';
import { Rain } from './rain.ts';
import { readSky, type SkyFields, type SkyRecord } from './record.ts';
import { daylightFactors, sunAt } from './sun.ts';

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
  background: THREE.Color;
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
  if (!r) return { sun: [0.5, 0.7, 0.4], elevation: null, daylight: 1, background: NO_SKY.clone(), sunColour: SUN_WHITE.clone(), sunIntensity: SUN_DAY, hemiColour: new THREE.Color(0xffffff), hemiIntensity: HEMI_DAY, cloud: 0, rain: 0, wind: 0 };
  const s = sunAt(r, t), f = daylightFactors(s.elevationDeg);
  const cloud = Math.min(1, Math.max(0, r.cloud / 100)), wind = Math.min(1, Math.max(0, r.wind / 100));
  const bg = NIGHT_SKY.clone().lerp(DUSK_SKY, Math.max(f.warmth * f.daylight, f.blueHour * 0.4)).lerp(DAY_SKY, f.daylight * (1 - f.warmth * 0.6));
  const l = (bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722) * 0.92;
  bg.lerp(new THREE.Color().setRGB(l * 0.97, l, l * 1.04), cloud * 0.8);
  return {
    sun: s.direction, elevation: s.elevationDeg, daylight: f.daylight, background: bg,
    sunColour: SUN_WHITE.clone().lerp(SUN_WARM, f.warmth * 0.7),
    sunIntensity: SUN_DAY * f.daylight * (1 - 0.72 * cloud),
    hemiColour: MOON_HEMI.clone().lerp(SUN_WHITE, f.daylight),
    // Today's observer fill: 0.75 at night to 1.7 at day, scaled to the page's day value; a little less under cloud.
    hemiIntensity: HEMI_DAY * ((0.75 + 0.95 * f.daylight) / 1.7) * (1 - 0.1 * cloud),
    cloud, rain: Math.min(1, Math.max(0, r.rain / FULL_RAIN)), wind,
  };
}

/** The page's sky: owns the scene's background and fog colour, the hemisphere light and the sun's direction, colour and
 *  strength, and the rain. `apply` takes every node a part or a seek carries; `update` draws a world time. */
export class WorldSky {
  readonly rain = new Rain();
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
    if (rain) scene.add(this.rain.mesh);
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
    const s = (this.state = skyState(this.recordAt(t), t));
    (this.scene.background as THREE.Color).copy(s.background);
    this.scene.fog?.color.copy(s.background);
    this.sun.color.copy(s.sunColour);
    this.sun.intensity = s.sunIntensity;
    this.hemi.color.copy(s.hemiColour);
    this.hemi.intensity = s.hemiIntensity;
    this.rain.update(t / 1e6, s.rain, s.daylight, camera, s.wind);
    const dir = new THREE.Vector3(...s.sun);
    if (dir.y < 0.05) dir.y = 0.05; // below the horizon: the shadow camera stays sane; its strength is ~0 anyway
    return dir.normalize();
  }
}
