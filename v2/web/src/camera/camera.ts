// One free camera (V5, #2714): orbit about a pivot with the mouse or a finger, pan on the ground, zoom with the wheel,
// and WASD to glide. The gaze and orbit arithmetic is copied from apps/web/src/WorldRtsCamera.ts (not imported).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PITCH_LIMIT = (85 * Math.PI) / 180;
const yawOf = (d: THREE.Vector3) => Math.atan2(d.x, -d.z);
const gazeFrom = (yaw: number, pitch: number) =>
  new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));

/** The eye `distance` from `pivot`, looking down at `pitch` (negative: below level) along `yaw`. */
export function eyeFor(pivot: THREE.Vector3, yaw: number, pitch: number, distance: number): THREE.Vector3 {
  return pivot.clone().addScaledVector(gazeFrom(yaw, Math.max(-PITCH_LIMIT, Math.min(0, pitch))), -distance);
}

/** C1: how far the eye may zoom out for a world whose ground spans `extent` (copied arithmetic). */
export function farLimit(extent: readonly [number, number, number, number] | null): number {
  const r = extent ? Math.max(extent[2] - extent[0], extent[3] - extent[1]) / 2 : 0;
  return Math.min(4000, Math.max(320, Number.isFinite(r) ? r * 2.5 : 0));
}

export class FreeCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private keys = new Set<string>();

  constructor(canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.3, 1200);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  /** Looks at `pivot` from `distance` m, at `yaw` and `pitch` radians. */
  look(pivot: THREE.Vector3, yaw: number, pitch: number, distance: number): void {
    this.controls.target.copy(pivot);
    this.camera.position.copy(eyeFor(pivot, yaw, pitch, distance));
    this.controls.update();
  }

  setExtent(extent: readonly [number, number, number, number] | null): void {
    this.controls.maxDistance = farLimit(extent);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** Each frame: WASD glides the pivot and the eye along the ground, faster when further out. */
  update(dtMs: number): void {
    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const r = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    if (f || r) {
      const d = this.controls.target.clone().sub(this.camera.position);
      const yaw = yawOf(d);
      const speed = (this.camera.position.distanceTo(this.controls.target) * 0.8 * dtMs) / 1000;
      const move = new THREE.Vector3(Math.sin(yaw) * f + Math.cos(yaw) * r, 0, -Math.cos(yaw) * f + Math.sin(yaw) * r).multiplyScalar(speed);
      this.controls.target.add(move);
      this.camera.position.add(move);
    }
    this.controls.update();
  }
}
