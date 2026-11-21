// Named places (#3676, parity with today's WorldPlacePreviews and WorldPlaceCamera): the list of places a visitor can
// choose, and the framed view of one, shared by its preview picture and the place camera so the picture is where the
// camera lands. The framing arithmetic is today's `fitPlacePreviewCamera` (apps/web/src/WorldPlacePreviews.ts, copied,
// not imported): the place's box fitted in camera space, depth included, 35 degrees above level from a 3/4 side.
// Places come from the copy (#3571, #3574): a node with a public name; an area's outline is its extent.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';

const MM = 1e-3;
/** The frame's vertical field (degrees), its elevation, and the side it is seen from (radians, from +z toward +x). */
export const FRAME = { fov: 38, elevation: (35 * Math.PI) / 180, azimuth: Math.PI / 4 };
/** A place without an outline (a named thing) is framed as a box this many metres across around its point. */
const THING_SPAN = 8;

export type Place = { id: string; name: string };

/** A place's name as read: Eden writes `land-west-lake` and `place-eden-stone-garden`, a visitor reads "land west lake"
 *  and "eden stone garden" (the `place-` prefix is the data's, not the name). */
export const placeWords = (name: string) => name.replace(/^place[-_]+/i, '').replace(/[-_]+/g, ' ').trim();

/** The places a visitor can choose: every named area with an outline, one per name (the first id in order wins), by
 *  name. Named things without an outline are found by the find box (#3574) but are not listed. */
export function placeList(nodes: Iterable<Pick<NodeRec, 'id' | 'placeName' | 'outline'>>): Place[] {
  const seen = new Map<string, Place>();
  for (const n of nodes) {
    if (!n.placeName || !n.outline?.length) continue;
    const name = placeWords(n.placeName), key = name.toLowerCase();
    if (name && !seen.has(key)) seen.set(key, { id: n.id, name });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The box a place fills, world m: its outline's extent (or `THING_SPAN` around `at` without one) from the ground at
 *  `at.y` up a sixth of its span (3 to 20 m), so a plaza is framed with what stands on it. */
export function placeBox(n: Pick<NodeRec, 'outline'>, at: THREE.Vector3): THREE.Box3 {
  const box = new THREE.Box3();
  if (n.outline?.length) for (const [x, z] of n.outline) box.expandByPoint(new THREE.Vector3(x * MM, at.y, z * MM));
  else box.setFromCenterAndSize(at.clone(), new THREE.Vector3(THING_SPAN, 0, THING_SPAN));
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  box.max.y = at.y + Math.max(3, Math.min(20, span / 6));
  return box;
}

/** Today's fit: the camera along `direction` from the box's centre, far enough that every corner is inside 88 % of the
 *  frame. Returns the eye and what it looks at. */
export function fitFrame(box: THREE.Box3, direction: THREE.Vector3, aspect: number, fov = FRAME.fov): { eye: THREE.Vector3; target: THREE.Vector3 } {
  const aim = box.getCenter(new THREE.Vector3()), camera = new THREE.PerspectiveCamera(fov, aspect, 0.01, 10000), view = direction.clone().normalize();
  if (view.lengthSq() < 0.5) view.set(1, 0.6, 1).normalize();
  camera.position.copy(aim).add(view);
  camera.lookAt(aim);
  const inverse = camera.quaternion.clone().invert(), vertical = Math.tan((fov * Math.PI) / 360), horizontal = vertical * aspect;
  let distance = 0.1;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = new THREE.Vector3(x, y, z).sub(aim).applyQuaternion(inverse);
    distance = Math.max(distance, p.z + Math.abs(p.x) / (horizontal * 0.88), p.z + Math.abs(p.y) / (vertical * 0.88));
  }
  return { eye: aim.clone().addScaledVector(view, distance), target: aim };
}

/** The framed view of a place standing at `at` (its frame's position, world m): the same for its preview and its
 *  camera, so the picture shows where choosing it lands. */
export function placeFrame(n: Pick<NodeRec, 'outline'>, at: THREE.Vector3, aspect: number): { eye: THREE.Vector3; target: THREE.Vector3 } {
  const { elevation: el, azimuth: az } = FRAME;
  return fitFrame(placeBox(n, at), new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)), aspect);
}
