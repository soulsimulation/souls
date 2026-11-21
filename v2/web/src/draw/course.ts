// A node on a course (#3603): a rowing punt rows its loop at world time, its riders with it. The node's field 80
// (`replica::schedule::F_COURSE`) holds its track; the replica's `courseAt` reads where the track has it at a world
// time, by the formula the world reads. A track that does not load, or a time before it starts, leaves the node where
// it was placed. Nothing here steps a track: each frame reads it afresh.
import * as THREE from 'three';

/** The replica's WASM `courseAt`: `[x, y, z, vx, vy, vz]` in whole µm and µm a second (a `BigInt64Array`), in the
 *  parent's frame; throws by name. */
export type CourseAt = (field: Uint8Array, t: bigint) => ArrayLike<bigint>;

/** Today's punt turns at most this fast to face its way (carrier/1, 0.5 rad a second). */
const TURN = 0.5;
/** Below this speed (µm a second) a punt is stopped and turns back to the way it was placed, as today's does. */
const MOVING = 20_000;
/** A gap in drawn world time longer than this (µs: a cut, a hidden tab) turns the punt at once. */
const SNAP = 2_000_000;
const UP = new THREE.Vector3(0, 1, 0);

/** The yaw (radians about +y) a turn about +y has; a static place's orientation is one. */
export function yawOf(q: THREE.Quaternion): number {
  return 2 * Math.atan2(q.y, q.w);
}

/** The yaw that faces a velocity along the ground: today's model faces +x (`rotation.y = -heading`). */
export function facing(vx: number, vz: number): number {
  return -Math.atan2(vz, vx);
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** Where one course node is drawn at a world time, and the way it faces, kept between frames for its turn. */
export class CoursePlace {
  pos = new THREE.Vector3();
  rot = new THREE.Quaternion();
  private yaw: number | null = null;
  private t: number | null = null;

  /** Reads the node's place at world time `t` (µs). `placed` is its static position (µm) and `rot` its orientation;
   *  returns false when the course gave nothing (no reader yet, or it threw), so the node stands where it was placed. */
  at(read: CourseAt | null, field: Uint8Array, t: number, placed: readonly number[], rot: THREE.Quaternion): boolean {
    let p: number[] | null = null;
    // Whole µm from the replica; numbers here, still µm (exact below 2^53 µm, 9,000 km), metres only where drawn.
    if (read) try { p = Array.from(read(field, BigInt(Math.floor(t))), Number); } catch { p = null; }
    if (!p) {
      this.pos.set(placed[0], placed[1], placed[2]);
      this.rot.copy(rot);
      this.yaw = null;
      this.t = null;
      return false;
    }
    this.pos.set(p[0], p[1], p[2]);
    const home = yawOf(rot), speed = Math.hypot(p[3], p[5]);
    const want = speed > MOVING ? facing(p[3], p[5]) : home;
    const dt = this.t === null ? Infinity : Math.abs(t - this.t);
    if (this.yaw === null || dt > SNAP) this.yaw = want;
    else {
      const step = (TURN * dt) / 1e6, d = wrap(want - this.yaw);
      this.yaw = wrap(this.yaw + Math.max(-step, Math.min(step, d)));
    }
    this.t = t;
    this.rot.setFromAxisAngle(UP, this.yaw);
    return true;
  }
}
