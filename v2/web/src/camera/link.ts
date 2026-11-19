// A camera a link can carry (V9, #2719): a frame node and, in that node's frame (T4), the eye's position and the point
// it looks at, in whole micrometres. A camera framed on the world's root is the world's frame; one framed on a boat
// moves with the boat once the page draws it there.
import * as THREE from 'three';

export type CameraAt = { node: string; eye: [number, number, number]; target: [number, number, number] };

const UM = 1e-6;
/** Whole micrometres; `+ 0` turns a rounded -0 into 0, so a link reads back equal. */
const um = (v: THREE.Vector3): [number, number, number] => [Math.round(v.x / UM) + 0, Math.round(v.y / UM) + 0, Math.round(v.z / UM) + 0];

/** `node~ex,ey,ez~tx,ty,tz`. */
export function writeCamera(c: CameraAt): string {
  return `${c.node}~${c.eye.join(',')}~${c.target.join(',')}`;
}

export function readCamera(s: string | null): CameraAt | null {
  const [node, eye, target] = (s ?? '').split('~');
  const three = (p: string | undefined) => {
    const v = (p ?? '').split(',').map(Number);
    return v.length === 3 && v.every(Number.isInteger) ? (v as [number, number, number]) : null;
  };
  const e = three(eye), t = three(target);
  return node && e && t ? { node, eye: e, target: t } : null;
}

/** The camera as seen now, framed on `node` whose world matrix is `frame`. */
export function cameraAt(node: string, frame: THREE.Matrix4, eye: THREE.Vector3, target: THREE.Vector3): CameraAt {
  const inv = frame.clone().invert();
  return { node, eye: um(eye.clone().applyMatrix4(inv)), target: um(target.clone().applyMatrix4(inv)) };
}

/** The world positions of a carried camera, its node's world matrix being `frame`. */
export function placeCamera(c: CameraAt, frame: THREE.Matrix4): { eye: THREE.Vector3; target: THREE.Vector3 } {
  const v = (p: [number, number, number]) => new THREE.Vector3(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(frame);
  return { eye: v(c.eye), target: v(c.target) };
}
