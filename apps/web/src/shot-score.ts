// #2201 A4 (docs/design/auto-camera.md §1): how good a camera position is for looking at a Soul, from positions alone.
// One pure function, arithmetic only: the caller casts any rays (the sightline gate, the sky behind the head) and passes
// what they found. Every part is 0..1; the total is their weighted mean. The follow camera scores its candidate views
// with it; it never moves anything.
import * as THREE from 'three';

export type ShotContext = {
  /** The way the Soul faces, flat (its walking heading, or the last one), or null when unknown. */
  heading: THREE.Vector3 | null;
  /** The view the camera holds now and the view the viewer asked for, both as offsets from the Soul. */
  held: THREE.Vector3 | null;
  asked: THREE.Vector3;
  /** Toward the sun (unit), and the daylight (0 night … 1 day); null when the world has no sun. */
  sun?: THREE.Vector3 | null;
  daylight?: number | null;
  /** The camera's vertical field of view (radians). */
  fov: number;
  /** Forced off the asked-for view (§3): stay drops out and asked counts double. */
  forced?: boolean;
  /** Whether a ray from the head, continued away from the camera, met nothing (sky or far background); null: not cast. */
  sky?: boolean | null;
};
export type ShotParts = { face: number; sky: number; sun: number; framing: number; stay: number; asked: number };
export const SHOT_WEIGHTS: ShotParts = { face: 2.5, sky: 1, sun: 1, framing: 1.5, stay: 1.5, asked: 2 };
/** A body's height (m) for the framing part, the frame share it should fill, and the most comfortable look down. */
const BODY = 1.7, FILL = [.3, .6] as const, PITCH_DOWN = 26 * Math.PI / 180;
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** Score `eye` (the camera's offset from the Soul's torso) for `ctx`: {total, parts}. */
export function shotScore(eye: THREE.Vector3, ctx: ShotContext): { total: number; parts: ShotParts } {
  const distance = eye.length(), flat = Math.hypot(eye.x, eye.z);
  // face: 1 face on, .8 in side profile, 0 from behind; unknown facing is neutral
  let face = .5;
  if (ctx.heading && flat > 1e-6) {
    const cos = (ctx.heading.x * eye.x + ctx.heading.z * eye.z) / (Math.hypot(ctx.heading.x, ctx.heading.z) * flat);
    face = Math.max((1 + cos) / 2, .8 * Math.sqrt(Math.max(0, 1 - cos * cos)));
  }
  // sky: from below the head looking level or a little up, the sky is behind it by geometry; higher, the ray says
  const pitchUp = Math.atan2(.6 - eye.y, flat);  // the angle the camera looks up at the head
  const sky = pitchUp >= -5 * Math.PI / 180 && pitchUp <= 15 * Math.PI / 180 && eye.y < .6 ? 1 : ctx.sky == null ? .5 : ctx.sky ? 1 : 0;
  // sun: light on the Soul from the camera's side; never the sun in the frame (but low sun is neutral)
  let sun = .5, sunWeight = SHOT_WEIGHTS.sun;
  if (!ctx.sun || ctx.daylight == null || ctx.daylight < .2) sunWeight = 0;
  else {
    const s = new THREE.Vector3(ctx.sun.x, 0, ctx.sun.z), f = new THREE.Vector3(-eye.x, 0, -eye.z);
    const elevation = Math.asin(Math.max(-1, Math.min(1, ctx.sun.y / (ctx.sun.length() || 1))));
    const view = eye.clone().negate().normalize(), inFrame = view.angleTo(ctx.sun.clone().normalize()) < ctx.fov / 2 + 10 * Math.PI / 180;
    if (elevation < 8 * Math.PI / 180) sun = .5;
    else if (inFrame) sun = 0;
    else if (s.lengthSq() > 1e-9 && f.lengthSq() > 1e-9) sun = (1 - f.normalize().dot(s.normalize())) / 2;
  }
  // framing: the body fills 30-60 % of the frame height, and the camera does not look down steeply (at most halved: a
  // high view is still how a camera sees over a row of houses)
  const fill = BODY / (2 * distance * Math.tan(ctx.fov / 2)), pitchDown = Math.atan2(eye.y, flat);
  const framing = clamp(1 - Math.max(0, FILL[0] - fill, fill - FILL[1]) / .3) * (.5 + .5 * clamp(1 - Math.max(0, pitchDown - PITCH_DOWN) / (30 * Math.PI / 180)));
  const stay = ctx.held && ctx.held.lengthSq() > 1e-9 ? 1 - ctx.held.angleTo(eye) / Math.PI : 1;
  const asked = clamp(1 - ctx.asked.angleTo(eye) / Math.PI - Math.abs(distance - ctx.asked.length()) / Math.max(1, ctx.asked.length()));
  const parts: ShotParts = { face, sky, sun, framing, stay, asked };
  const w = { ...SHOT_WEIGHTS, sun: sunWeight, ...(ctx.forced ? { stay: 0, asked: 2 * SHOT_WEIGHTS.asked } : {}) };
  let sum = 0, weights = 0;
  for (const k of Object.keys(parts) as (keyof ShotParts)[]) { sum += w[k] * parts[k]; weights += w[k]; }
  return { total: sum / weights, parts };
}

/** #2201 A4: where a walking Soul's camera drifts: about 110° off its heading, on the side nearer `theta` (the azimuth,
 *  as THREE.Spherical measures it, of the camera now). A side-behind view sees the face in profile, not the back of the head. */
export function walkingDrift(heading: THREE.Vector3, theta: number): number {
  const h = Math.atan2(heading.x, heading.z), off = 110 * Math.PI / 180;
  const near = (a: number) => Math.abs(Math.atan2(Math.sin(a - theta), Math.cos(a - theta)));
  return near(h + off) <= near(h - off) ? h + off : h - off;
}
