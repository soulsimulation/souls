// A flight to a Soul (V20, #2764): from the camera's own eye and gaze to the Soul's follow shot, eased, tracking the
// Soul as drawn while it walks. The arithmetic is copied from apps/web/src/WorldSoulFlight.ts (not imported).
import * as THREE from 'three';

/** Seconds for a flight whose eye travels `distance` m while its gaze turns `turn` radians: clamp(1, 3, 1 + d/60 + θ/120°). */
export function flightSeconds(distance: number, turn: number): number {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : 0, t = Number.isFinite(turn) ? Math.abs(turn) : 0;
  return Math.max(1, Math.min(3, 1 + d / 60 + t / ((Math.PI * 2) / 3)));
}

/** Cubic ease-in-out: 0 → 0, 1 → 1, symmetric, zero speed at both ends. */
export function easeInOut(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** The follow shot's distance (m) and elevation (radians above level). */
export const SHOT_NEAR = 6, SHOT_FAR = 12, SHOT_LOW = (15 * Math.PI) / 180, SHOT_HIGH = (40 * Math.PI) / 180;

/** The follow shot of a Soul whose target (body + 1 m) is `target`, seen from `eye`: the camera stays on its side of
 *  the Soul, 6 to 12 m out and 15 to 40 degrees above level. Returns the eye's offset from the target. */
export function shotOffset(eye: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  const off = eye.clone().sub(target), flat = Math.hypot(off.x, off.z);
  const heading = flat > 1e-6 ? Math.atan2(off.x, off.z) : 0;
  const elevation = Math.max(SHOT_LOW, Math.min(SHOT_HIGH, Math.atan2(off.y, flat)));
  const r = Math.max(SHOT_NEAR, Math.min(SHOT_FAR, off.length()));
  return new THREE.Vector3(Math.sin(heading) * Math.cos(elevation), Math.sin(elevation), Math.cos(heading) * Math.cos(elevation)).multiplyScalar(r);
}

export class Flight {
  readonly id: string;
  readonly seconds: number;
  readonly offset: THREE.Vector3;
  private t = 0;
  private fromEye: THREE.Vector3;
  private fromTarget: THREE.Vector3;

  /** From the camera at `eye` looking at `pivot` to the Soul `id` whose target is `target`. */
  constructor(id: string, eye: THREE.Vector3, pivot: THREE.Vector3, target: THREE.Vector3) {
    this.id = id;
    this.offset = shotOffset(eye, target);
    this.fromEye = eye.clone();
    this.fromTarget = pivot.clone();
    const gaze = pivot.clone().sub(eye).normalize(), toGaze = this.offset.clone().negate().normalize();
    this.seconds = flightSeconds(target.clone().add(this.offset).distanceTo(eye), gaze.angleTo(toGaze));
  }

  /** Advances `dt` seconds toward the Soul's target as drawn now. */
  step(dt: number, target: THREE.Vector3): { eye: THREE.Vector3; target: THREE.Vector3; done: boolean } {
    this.t = Math.min(1, this.t + (Number.isFinite(dt) ? Math.max(0, dt) : 0) / this.seconds);
    const k = easeInOut(this.t);
    return { eye: this.fromEye.clone().lerp(target.clone().add(this.offset), k), target: this.fromTarget.clone().lerp(target, k), done: this.t >= 1 };
  }
}

/** A flight between two views (C2, #3674): from the camera's eye and gaze to another eye and gaze, eased, timed as a
 *  flight to a Soul is. The guided tour flies between its stops with it; it moves the camera only. */
export class PoseFlight {
  readonly seconds: number;
  private t = 0;
  private fromEye: THREE.Vector3;
  private fromTarget: THREE.Vector3;
  private toEye: THREE.Vector3;
  private toTarget: THREE.Vector3;

  constructor(eye: THREE.Vector3, target: THREE.Vector3, toEye: THREE.Vector3, toTarget: THREE.Vector3) {
    this.fromEye = eye.clone();
    this.fromTarget = target.clone();
    this.toEye = toEye.clone();
    this.toTarget = toTarget.clone();
    const gaze = target.clone().sub(eye).normalize(), toGaze = toTarget.clone().sub(toEye).normalize();
    this.seconds = flightSeconds(toEye.distanceTo(eye), gaze.angleTo(toGaze));
  }

  /** Advances `dt` seconds; the eye and gaze now. */
  step(dt: number): { eye: THREE.Vector3; target: THREE.Vector3; done: boolean } {
    this.t = Math.min(1, this.t + (Number.isFinite(dt) ? Math.max(0, dt) : 0) / this.seconds);
    const k = easeInOut(this.t);
    return { eye: this.fromEye.clone().lerp(this.toEye, k), target: this.fromTarget.clone().lerp(this.toTarget, k), done: this.t >= 1 };
  }
}
