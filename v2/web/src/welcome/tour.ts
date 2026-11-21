// The guided camera tour (C2, #3674): from wherever the camera is, a flight to each stop in turn, then a few seconds
// there drifting gently in along the stop's own sightline (today's broadcast tour's opening push, WorldTour.ts). It is a
// sequence of camera poses only: it reads no world state and moves nothing in the world.
import * as THREE from 'three';
import { PoseFlight, easeInOut } from '../camera/flight.ts';
import type { Stop } from './stops.ts';

/** Seconds held at each stop, and how far along its sightline the eye drifts in that time. */
export const HOLD_S = 6, PUSH = 0.12;

export type TourPose = { eye: THREE.Vector3; target: THREE.Vector3; stop: Stop; index: number; done: boolean };

export class Tour {
  readonly stops: readonly Stop[];
  index = 0;
  private flight: PoseFlight;
  private held = 0;
  private last: { eye: THREE.Vector3; target: THREE.Vector3 };

  /** Starts at stop 0, from the camera's `eye` looking at `target`. */
  constructor(stops: readonly Stop[], eye: THREE.Vector3, target: THREE.Vector3) {
    if (!stops.length) throw new Error('a tour needs a stop');
    this.stops = stops;
    this.last = { eye: eye.clone(), target: target.clone() };
    this.flight = this.to(0);
  }

  get stop(): Stop {
    return this.stops[this.index];
  }

  /** On to the next stop now, from where the camera is; false after the last one. */
  next(): boolean {
    if (this.index + 1 >= this.stops.length) return false;
    this.flight = this.to(this.index + 1);
    return true;
  }

  /** Advances `dt` seconds: the camera's pose now, `done` once the last stop's hold has run. */
  step(dt: number): TourPose {
    const s = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const stop = this.stop;
    let eye: THREE.Vector3, target: THREE.Vector3, done = false;
    const f = this.flight.step(s);
    if (!f.done) ({ eye, target } = f);
    else {
      this.held = Math.min(HOLD_S, this.held + s);
      const p = new THREE.Vector3(...stop.p);
      target = new THREE.Vector3(...stop.target);
      eye = p.lerp(target, PUSH * easeInOut(this.held / HOLD_S));
      if (this.held >= HOLD_S && !this.next()) done = true;
    }
    this.last = { eye: eye.clone(), target: target.clone() };
    return { eye, target, stop, index: this.index, done };
  }

  private to(i: number): PoseFlight {
    this.index = i;
    this.held = 0;
    const s = this.stops[i];
    return new PoseFlight(this.last.eye, this.last.target, new THREE.Vector3(...s.p), new THREE.Vector3(...s.target));
  }
}
