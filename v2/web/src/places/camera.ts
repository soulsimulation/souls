// The place camera (#3676, parity with today's WorldPlaceCamera): from the camera's own eye and gaze to a place's
// framed view (places.ts), eased as a flight to a Soul is (camera/flight.ts), and then the free camera again, pivoting
// on the place. Today's cut to an authored view becomes a short flight to the computed one; like every camera it
// observes and moves nothing in the world.
import * as THREE from 'three';
import { easeInOut, flightSeconds } from '../camera/flight.ts';

export class PlaceFlight {
  readonly id: string;
  readonly seconds: number;
  readonly eye: THREE.Vector3;
  readonly target: THREE.Vector3;
  private t = 0;
  private fromEye: THREE.Vector3;
  private fromTarget: THREE.Vector3;

  /** From the camera at `eye` looking at `pivot` to place `id`'s framed view `to`. */
  constructor(id: string, eye: THREE.Vector3, pivot: THREE.Vector3, to: { eye: THREE.Vector3; target: THREE.Vector3 }) {
    this.id = id;
    this.fromEye = eye.clone();
    this.fromTarget = pivot.clone();
    this.eye = to.eye.clone();
    this.target = to.target.clone();
    const gaze = pivot.clone().sub(eye).normalize(), toGaze = this.target.clone().sub(this.eye).normalize();
    this.seconds = flightSeconds(this.eye.distanceTo(eye), gaze.angleTo(toGaze));
  }

  /** Advances `dt` seconds; `done` once it shows the framed view. */
  step(dt: number): { eye: THREE.Vector3; target: THREE.Vector3; done: boolean } {
    this.t = Math.min(1, this.t + (Number.isFinite(dt) ? Math.max(0, dt) : 0) / this.seconds);
    const k = easeInOut(this.t);
    return { eye: this.fromEye.clone().lerp(this.eye, k), target: this.fromTarget.clone().lerp(this.target, k), done: this.t >= 1 };
  }
}
