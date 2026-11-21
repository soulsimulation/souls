// The interior view of a generated building (0.131 parity C10, #3681), carried over from today's building kit
// (`apps/web/src/gen-mesh/building.mesh.ts` `attachInteriorView`): a camera inside a building's footprint hides its roof
// and the storeys above the camera, so the rooms, their furniture and whoever is in them show from above; the camera's
// own ceiling stays while the camera is below it. `?hideRoofs=1` hides every roof (with `cut=<floor>`, the storeys above
// that floor too). The bake keeps the kit's groups by name (`level-<k>`, `slab-<k>`, `roof`, under
// `building-canonical`); the layout numbers today's view reads (footprint, storey height, storeys, top) are read back
// from the parts' own bounds, so the models need no new bytes.
import * as THREE from 'three';

/** Today's ground floor's top above the building's base, m (`building-buffers.ts` FLOOR0). */
const FLOOR0 = 0.1, SLAB = 0.18;

/** Where a part is in the building: its storey (Infinity: the roof) and whether it is that storey's floor slab (the
 *  ceiling of the storey below); `wall`: the storey's walls. `inner` is the building's own frame in the model (`building-canonical`). */
export type Storey = { level: number; slab: boolean; wall: boolean; inner: THREE.Matrix4 };

/** What the view needs of one placed building: its frame's inverse (world to the building's own frame), the half
 *  footprint with today's margin, its top, storey height and storeys. */
export type BuildingView = { inv: THREE.Matrix4; halfX: number; halfZ: number; top: number; fh: number; floors: number };

/** The view's decision for one camera: the roof hidden, storeys above `hideAbove` hidden, and the slab kept. */
export type Cut = { hideRoof: boolean; hideAbove: number; keepSlab: number };
export const NO_CUT: Cut = { hideRoof: false, hideAbove: Infinity, keepSlab: -1 };

/** A mesh's storey from its group names (`level-2`, `slab-1`, `roof`), when it is part of a generated building. */
export function storeyOf(o: THREE.Object3D): Storey | null {
  let group: string | null = null, inner: THREE.Object3D | null = null;
  for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) {
    if (group === null && /^(level-\d+|slab-\d+|roof)$/.test(p.name)) group = p.name;
    if (p.name === 'building-canonical') inner = p;
  }
  if (!group || !inner) return null;
  const level = group === 'roof' ? Infinity : Number(group.slice(group.indexOf('-') + 1));
  return { level, slab: group.startsWith('slab-'), wall: /[ _]wall$/.test(o.name), inner: inner.matrixWorld };
}

/** The building's layout read from its parts (geometry, matrix in the model, storey), for a thing at `frame`. Today's
 *  footprint is the walls' half size plus 0.4 m and the porch; here the ground storey's bounds (walls, plinth, porch)
 *  plus 0.3 m. The storey height is the ground storey's wall top; the storeys, the highest slab's number. */
export function buildingView(parts: readonly { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4; storey?: Storey }[], frame: THREE.Matrix4): BuildingView | null {
  const inner = parts.find((p) => p.storey)?.storey?.inner;
  if (!inner) return null;
  const toInner = inner.clone().invert(), ground = new THREE.Box3(), all = new THREE.Box3(), b = new THREE.Box3(), m = new THREE.Matrix4();
  let wallTop = 0, floors = 1;
  for (const p of parts) {
    if (!p.storey) continue;
    p.geometry.boundingBox ?? p.geometry.computeBoundingBox();
    b.copy(p.geometry.boundingBox!).applyMatrix4(m.multiplyMatrices(toInner, p.matrix));
    all.union(b);
    if (p.storey.level === 0 && !p.storey.slab) {
      ground.union(b);
      if (p.storey.wall) wallTop = Math.max(wallTop, b.max.y);
    }
    if (p.storey.slab) floors = Math.max(floors, p.storey.level);
    else if (Number.isFinite(p.storey.level)) floors = Math.max(floors, p.storey.level + 1);
  }
  if (ground.isEmpty()) return null;
  const fh = wallTop > FLOOR0 ? wallTop : Math.max(2.4, (all.max.y - FLOOR0) / floors);
  return {
    inv: frame.clone().multiply(inner).invert(),
    halfX: Math.max(-ground.min.x, ground.max.x) + 0.3,
    halfZ: Math.max(-ground.min.z, ground.max.z) + 0.3,
    top: all.max.y, fh, floors,
  };
}

const local = new THREE.Vector3();
/** Today's decision for a camera at `eye` (world): inside the footprint and below the top, the roof goes and the
 *  storeys above the camera's; the camera's own ceiling stays while the camera is below it. */
export function decide(v: BuildingView, eye: THREE.Vector3, hideRoofs = false, cut: number | null = null): Cut {
  let hideRoof = hideRoofs, hideAbove = cut !== null && hideRoofs ? cut : Infinity, keepSlab = -1;
  local.copy(eye).applyMatrix4(v.inv);
  if (Math.abs(local.x) < v.halfX && Math.abs(local.z) < v.halfZ && local.y < v.top && local.y > -1) {
    hideRoof = true;
    const level = Math.max(0, Math.floor((local.y - FLOOR0 + 0.3) / v.fh));
    hideAbove = Math.min(hideAbove, level);
    if (!hideRoofs && local.y < (level + 1) * v.fh + FLOOR0 - SLAB - 0.05) keepSlab = level + 1;
  }
  return { hideRoof, hideAbove, keepSlab };
}

/** Is a part on this storey hidden under the decision (today's rule, the top slab going with the roof)? */
export function hidden(s: Storey, c: Cut, floors: number): boolean {
  if (s.level === Infinity) return c.hideRoof;
  if (s.slab) return s.level !== c.keepSlab && (s.level > c.hideAbove || (s.level === floors && c.hideRoof));
  return s.level > c.hideAbove;
}

/** The height in the building's frame from which things are hidden under the decision (Infinity: none): the floor of the
 *  first hidden storey, as today hides the furniture of the storeys it cuts. */
export function cutHeight(v: BuildingView, c: Cut): number {
  return c.hideAbove === Infinity ? Infinity : (c.hideAbove + 1) * v.fh + FLOOR0 - SLAB;
}

/** Is a point (world) inside the building's footprint at or above `y` in its frame? */
export function above(v: BuildingView, p: THREE.Vector3, y: number): boolean {
  local.copy(p).applyMatrix4(v.inv);
  return Math.abs(local.x) < v.halfX && Math.abs(local.z) < v.halfZ && local.y >= y - 0.05;
}

export const sameCut = (a: Cut, b: Cut) => a.hideRoof === b.hideRoof && a.hideAbove === b.hideAbove && a.keepSlab === b.keepSlab;
