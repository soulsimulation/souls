/** Canonical held pictures: native identity/slot/local pose, declared resources and measured rig palms only. */
import * as THREE from 'three';
import type { HeldEntry, HeldSet } from './held-entry.ts';
export type NativeHands = { body: string; kindHash: string; resources: readonly (readonly [string, number, number?])[] };
export type HeldPicture = { object: THREE.Object3D; grip: readonly [number, number, number]; bounds?: {min: readonly [number,number,number]; max: readonly [number,number,number]}; dispose(): void };
export type HeldPictureFactory = (entry: HeldEntry, mode?:'probe') => HeldPicture | null;
export type HeldProjection = { entry: HeldEntry; hand: 'left' | 'right' };

/** Additive public body metadata is optional; malformed recorded fields never become a hand mapping. */
export function nativeHandsOf(value: unknown): NativeHands | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const b = value as { nativeBody?: unknown; nativeKindHash?: unknown; nativeResources?: unknown };
  if (typeof b.nativeBody !== 'string' || !b.nativeBody || typeof b.nativeKindHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.nativeKindHash)
    || !Array.isArray(b.nativeResources) || b.nativeResources.some(r => !Array.isArray(r) || r.length < 2 || r.length > 3
      || typeof r[0] !== 'string' || !Number.isSafeInteger(r[1]) || r[2] !== undefined && (!Number.isSafeInteger(r[2]) || r[2] < 1))) return undefined;
  return {body:b.nativeBody,kindHash:b.nativeKindHash,resources:b.nativeResources};
}

/** Unknown/default metadata is not a default left hand. Ambiguous slots/occupants are unsupported. */
export function heldProjections(set: HeldSet | undefined, body: NativeHands | undefined): HeldProjection[] {
  if (!set || !body || !/^[a-f0-9]{64}$/.test(body.kindHash)) return [];
  const hands = body.resources.filter(r => r[1] === 2 && r[2] !== undefined);
  if (new Set(hands.map(r => r[0])).size !== hands.length || new Set(hands.map(r => r[2])).size !== hands.length) return [];
  const entries = set.entries.filter(e => e.parent === body.body && e.slot !== null && e.rot.some(n => n !== 0));
  return entries.flatMap(entry => {
    if (entries.filter(e => e.slot === entry.slot).length !== 1) return [];
    const resource = hands.find(r => r[2] === entry.slot)?.[0];
    const hand = resource === 'souls:hand-left' ? 'left' : resource === 'souls:hand-right' ? 'right' : null;
    return hand ? [{entry, hand}] : [];
  });
}

/** Actual visible mesh geometry, without shadow duplicates or decorative flame/steam/smoke branches. */
export function heldMeshBounds(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true); const box = new THREE.Box3();
  object.traverse(child => {
    const mesh = child as THREE.Mesh; if (!mesh.isMesh || mesh.userData.shadowProxy || !mesh.geometry) return;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
      if (!p.visible || ['flame','steam','smoke'].includes(String(p.userData.role))) return;
      if (p === object) break;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!materials.some(m => m.visible)) return;
    mesh.geometry.computeBoundingBox(); if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

/** Rearward extent from the declared grip, in native body axes. Bounds come from the actual canonical mesh. */
export function heldGripBounds(picture: HeldPicture, entry: HeldEntry): THREE.Box3 | undefined {
  if (!picture.bounds) return undefined;
  const q = new THREE.Quaternion(entry.rot[1],entry.rot[2],entry.rot[3],entry.rot[0]).normalize();
  const grip = new THREE.Vector3(...picture.grip).applyQuaternion(q), box = new THREE.Box3();
  for (const x of [picture.bounds.min[0],picture.bounds.max[0]]) for (const y of [picture.bounds.min[1],picture.bounds.max[1]]) for (const z of [picture.bounds.min[2],picture.bounds.max[2]]) {
    box.expandByPoint(new THREE.Vector3(x,y,z).applyQuaternion(q).sub(grip).add(new THREE.Vector3(...entry.pos).multiplyScalar(1e-6)));
  }
  return box;
}
export const heldBackExtent = (picture: HeldPicture, entry: HeldEntry): number => Math.max(0,-(heldGripBounds(picture,entry)?.min.x ?? 0));

/** Native local orientation is relative to the body/slot frame, not a model's arbitrary wrist bone axes.
 * The canonical grip meets the drawn palm; native local position and quaternion are each applied once. */
export function placeHeld(picture: HeldPicture, entry: HeldEntry, palm: THREE.Vector3, bodyRotation: THREE.Quaternion, parent: THREE.Object3D): void {
  const q = new THREE.Quaternion(entry.rot[1], entry.rot[2], entry.rot[3], entry.rot[0]).normalize();
  q.premultiply(bodyRotation);
  const pos = new THREE.Vector3(...entry.pos).multiplyScalar(1e-6).applyQuaternion(bodyRotation).add(palm)
    .sub(new THREE.Vector3(...picture.grip).applyQuaternion(q));
  parent.updateWorldMatrix(true, false);
  picture.object.position.copy(parent.worldToLocal(pos));
  picture.object.quaternion.copy(parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q));
  picture.object.updateMatrixWorld(true);
}
