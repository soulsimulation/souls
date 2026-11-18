// Ground-laid areas (paths, lawns, pitches, courts, beds): flat on the drawn ground in their surface's
// colour, as today's page drapes them (apps/web/src/gen-mesh/areas.mesh.ts, paths.mesh.ts), not as a box around
// their solids. The stream carries no material, so the colour is the kind's default there. Each area is its floor's
// surfaces (import-eden's field 14), or its outline (field 11) when it has none, cut into triangles no side longer
// than the ground's 1 m grid, each corner at the ground's height plus the surface's own lift.
import * as THREE from 'three';

/** Today's default surface colour for each ground-laid kind (by its plain name). */
// A terrace is not one: today it draws nothing and levels the ground (generators' terrace/1).
export const DRAPES: Record<string, number> = {
  footpath: 0xb3ac9e, // path/1: gravel
  lawn: 0x6aa84f,
  'sand-patch': 0xd9c38f,
  'garden-bed': 0x6a5136,
  'flower-garden': 0x6a5136,
  'football-pitch': 0x4f8f3a,
  'tennis-court': 0x3f7a5a,
};

/** Decks over water or ground (piers, bridges, decks): their surfaces are at their own heights, not on the ground. */
export const DECKS: Record<string, number> = {
  pier: 0xa07a4f, // wood
  deck: 0xa07a4f,
  bridge: 0x9a8f80,
};

/** Still water (a lake's, a pond's outline at its level), so what floats on it is seen on water, not over its bed. */
export const WATER = 0x4f7f9a;

/** A kind's plain name, `core:footpath@1` -> `footpath`. */
export const drapeName = (kind: string) => kind.split('@')[0].split(':').pop()!;

/** Lift above the ground, m, at least: enough to stay over the ground's triangles between the grid points. */
const MIN_LIFT = 0.02;
/** Longest side of a drawn triangle, m (the ground's grid). */
const MAX_SIDE = 1;

/** An area's corners `[x, z]` (m); `lift` above the ground, or the height itself when `level` (a deck). */
export type Area = { colour: number; lift: number; points: [number, number][]; level?: boolean };

/** One mesh of every area, each corner on the ground (`heightAt`); corners off the ground keep height 0. */
export function drapeMesh(areas: Area[], heightAt: (x: number, z: number) => number | null): THREE.Mesh | null {
  const pos: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  for (const a of areas) {
    if (a.points.length < 3) continue;
    c.setHex(a.colour);
    const contour = a.points.map(([x, z]) => new THREE.Vector2(x, z));
    const lift = a.level ? a.lift : Math.max(MIN_LIFT, a.lift);
    const put = (p: THREE.Vector2) => {
      pos.push(p.x, a.level ? lift : (heightAt(p.x, p.y) ?? 0) + lift, p.y);
      col.push(c.r, c.g, c.b);
    };
    const split = (p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2): void => {
      const pq = p.distanceTo(q), qr = q.distanceTo(r), rp = r.distanceTo(p), most = Math.max(pq, qr, rp);
      if (most <= MAX_SIDE || a.level) { // a level area needs no corners between its own
        // Facing up whichever way the outline winds.
        if ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) > 0) (put(p), put(r), put(q));
        else (put(p), put(q), put(r));
        return;
      }
      if (most === pq) {
        const m = p.clone().lerp(q, 0.5);
        (split(p, m, r), split(m, q, r));
      } else if (most === qr) {
        const m = q.clone().lerp(r, 0.5);
        (split(q, m, p), split(m, r, p));
      } else {
        const m = r.clone().lerp(p, 0.5);
        (split(r, m, q), split(m, p, q));
      }
    };
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) split(contour[i], contour[j], contour[k]);
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mesh.receiveShadow = true;
  mesh.name = 'drapes';
  return mesh;
}
