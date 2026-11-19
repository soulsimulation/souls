// Follow a Soul (V20, #2764): a camera whose frame is the Soul's body as drawn (its track at the clock, never ahead of
// it). The viewer's orbit and zoom set the eye's offset from the Soul (`wanted`); a solid between the Soul and that eye
// pulls the drawn eye in front of it, so the camera is never inside a wall, and it eases back out once clear. The
// solids are the things' own (`NodeRec.solids`, as world.ts draws them), gathered near the Soul twice a second; each
// frame tests one segment against those few boxes. A camera observes: it owns no movement.
// Zoom bounds and the gesture grace are WorldFollow.ts's (copied, not imported).
import * as THREE from 'three';
import { STRUCTURE, type WorldView } from '../draw/world.ts';

const UM = 1e-6, MM = 1e-3;
/** Zoom bounds (m from the Soul), and how long (s) after a gesture the viewer's view is shown as is. */
export const FOLLOW_MIN = 2.4, FOLLOW_MAX = 40, USER_HOLD = 1.5;
/** The nearest the eye comes when walls leave no clear view farther out (m), and what it keeps clear of a solid. */
export const FOLLOW_NEAR = 1, CLEAR = 0.35;
/** The nearest the eye ever comes (m, the camera's near plane), and how fast (rad/s) a cut sightline turns. */
const EYE_NEAR = 0.3, TURN = 3;
const UP = new THREE.Vector3(0, 1, 0);
/** The follow target stands this far above the body's feet (m). */
export const TARGET_UP = 1;
/** The solids near the Soul are gathered again every `refresh` s, out to the eye's distance ×1.5 (at least `least` m)
 *  plus `margin`, and sooner once the Soul has moved `margin` m. */
export const SCENE = { refresh: 0.5, least: 20, margin: 3 };
/** How fast (m/s) the eye goes back out to the asked distance once a wall no longer cuts it. */
const RETURN_SPEED = 6;

const plain = (kind: string) => kind.split('@')[0];

/** A solid as a box: the inverse of its world matrix (no scale), its half extents, and its world centre. */
export type Box = { inv: THREE.Matrix4; half: THREE.Vector3; centre: THREE.Vector3; reach: number };

/** Where body `id` is drawn at world time `t` (its feet): on its track, or where it stands when it has not moved since
 *  the page began (as W4's chips place it); null when it is not in the world. */
export function bodyAt(world: Pick<WorldView, 'nodes' | 'tracks' | 'frame'>, id: string, t: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  const n = world.nodes.get(id);
  if (!n) return null;
  const p = world.tracks.get(id)?.at(t);
  return p ? out.set(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(world.frame(n.parent)) : out.setFromMatrixPosition(world.frame(id));
}

/** Every solid of every thing (not bodies, not structure, not what `skip` carries) within `radius` m of `at`. */
export function solidsNear(world: Pick<WorldView, 'nodes' | 'frame'>, at: THREE.Vector3, radius: number, skip: string | null = null): Box[] {
  const out: Box[] = [];
  const local = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  for (const n of world.nodes.values()) {
    if (!n.solids?.length || n.at !== null || STRUCTURE.has(plain(n.kind)) || (skip && n.parent === skip)) continue;
    const f = world.frame(n.id), s = (n.scale ?? 1_000_000) / 1_000_000;
    for (const [cx, cz, hx, hz, yaw, y0, y1] of n.solids) {
      const half = new THREE.Vector3(hx * MM * s, ((y1 - y0) / 2) * MM * s, hz * MM * s);
      local.compose(c.set(cx * MM * s, ((y0 + y1) / 2) * MM * s, cz * MM * s), q.setFromAxisAngle(up, (yaw / 1000) * (Math.PI / 180)), one);
      const m = f.clone().multiply(local), centre = new THREE.Vector3().setFromMatrixPosition(m), reach = half.length();
      if (centre.distanceTo(at) - reach > radius) continue;
      out.push({ inv: m.invert(), half, centre, reach });
    }
  }
  return out;
}

const a = new THREE.Vector3(), b = new THREE.Vector3();
/** The fraction along `from`→`to` where the segment first enters `box`, or null when it misses it or starts inside. */
export function enters(box: Box, from: THREE.Vector3, to: THREE.Vector3): number | null {
  a.copy(from).applyMatrix4(box.inv);
  b.copy(to).applyMatrix4(box.inv);
  let lo = 0, hi = 1;
  for (const k of ['x', 'y', 'z'] as const) {
    const o = a[k], d = b[k] - a[k], h = box.half[k];
    if (Math.abs(o) <= h && Math.abs(d) < 1e-12) continue;
    if (Math.abs(d) < 1e-12) return null;
    let t0 = (-h - o) / d, t1 = (h - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
    if (lo > hi) return null;
  }
  // A segment starting inside a box (the Soul in a chair, or under a roof's box) does not count it.
  return Math.abs(a.x) < box.half.x && Math.abs(a.y) < box.half.y && Math.abs(a.z) < box.half.z ? null : lo;
}

/** Is `p` inside any of `boxes`? */
export function inside(boxes: Box[], p: THREE.Vector3): boolean {
  return boxes.some((box) => (a.copy(p).applyMatrix4(box.inv), Math.abs(a.x) < box.half.x && Math.abs(a.y) < box.half.y && Math.abs(a.z) < box.half.z));
}

export class Follow {
  readonly id: string;
  /** The eye's offset from the target as the viewer asked for it (world axes, m). */
  readonly wanted: THREE.Vector3;
  /** The time (s, the follow's own clock) of the viewer's last gesture. */
  userAt = -Infinity;
  private shown: number;
  private clock = 0;
  private boxes: Box[] = [];
  private gatheredAt = -Infinity;
  private gatheredFrom = new THREE.Vector3(Infinity, 0, 0);

  constructor(id: string, offset: THREE.Vector3) {
    this.id = id;
    this.wanted = offset.clone().setLength(Math.max(FOLLOW_MIN, Math.min(FOLLOW_MAX, offset.length())));
    this.shown = this.wanted.length();
  }

  /** The target (body + 1 m) of the followed body at `t`, or null when it is not drawn. */
  target(world: Pick<WorldView, 'nodes' | 'tracks' | 'frame'>, t: number): THREE.Vector3 | null {
    const p = bodyAt(world, this.id, t);
    return p && p.setY(p.y + TARGET_UP);
  }

  /** Marks a viewer's gesture now. */
  touched(): void {
    this.userAt = this.clock;
  }

  /** The eye to draw this frame, `dt` seconds on, for `target`: along the asked offset, in front of the first solid
   *  that cuts it and above the drawn ground. */
  eye(world: Pick<WorldView, 'nodes' | 'frame'> & { heightAt?(x: number, z: number): number | null }, target: THREE.Vector3, dt: number): THREE.Vector3 {
    this.clock += dt;
    this.wanted.setLength(Math.max(FOLLOW_MIN, Math.min(FOLLOW_MAX, this.wanted.length())));
    const want = this.wanted.length();
    if (this.clock - this.gatheredAt > SCENE.refresh || target.distanceTo(this.gatheredFrom) > SCENE.margin) {
      this.boxes = solidsNear(world, target, Math.max(SCENE.least, want * 1.5) + SCENE.margin, this.id);
      this.gatheredAt = this.clock;
      this.gatheredFrom.copy(target);
    }
    // When a solid stands nearer than FOLLOW_NEAR on the asked sightline (the Soul in a doorway, seen past its jamb),
    // the asked offset turns round the Soul toward the nearest clear side, at TURN rad/s, or at once when even the
    // solid's near face is too close to stand in front of.
    let hit = this.hit(target, this.wanted);
    if (hit - CLEAR < FOLLOW_NEAR) {
      const side = this.clearSide(target, Math.min(want, 2 * FOLLOW_NEAR) + CLEAR);
      if (side !== null) {
        this.wanted.applyAxisAngle(UP, Math.abs(side) <= TURN * dt || hit - 0.1 < EYE_NEAR ? side : Math.sign(side) * TURN * dt);
        hit = this.hit(target, this.wanted);
      }
    }
    let clear = Math.min(want, hit - CLEAR);
    // Nearer than FOLLOW_NEAR only while turning, and always in front of the solid.
    if (clear < FOLLOW_NEAR) clear = Math.max(EYE_NEAR, Math.min(FOLLOW_NEAR, hit - 0.1));
    // In at once (never inside a wall); out eased, or as is while the viewer is between gestures.
    this.shown = clear < this.shown || this.clock - this.userAt < USER_HOLD ? clear : Math.min(clear, this.shown + RETURN_SPEED * dt);
    const eye = target.clone().addScaledVector(this.wanted, this.shown / want);
    const ground = world.heightAt?.(eye.x, eye.z);
    if (ground != null && eye.y < ground + 0.5) eye.y = ground + 0.5;
    return eye;
  }

  /** How far (m) from `target` along `offset` the first gathered solid begins; Infinity when none does. */
  private hit(target: THREE.Vector3, offset: THREE.Vector3): number {
    const far = target.clone().add(offset), len = offset.length();
    let d = Infinity;
    for (const box of this.boxes) {
      const f = enters(box, target, far);
      if (f !== null) d = Math.min(d, f * len);
    }
    return d;
  }

  /** The smallest turn (radians about up, either way, in sixteenths) after which the sightline is clear for `need` m. */
  private clearSide(target: THREE.Vector3, need: number): number | null {
    for (let k = 1; k <= 8; k++) {
      for (const a of [(k * Math.PI) / 8, (-k * Math.PI) / 8]) if (this.hit(target, this.wanted.clone().applyAxisAngle(UP, a)) >= need) return a;
    }
    return null;
  }
}
