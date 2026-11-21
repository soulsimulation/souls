// The far backdrop beyond the world's edge (C12, #3683). Today's page lays a flat "outside-ground" plane 80 m past the
// world's bounds (apps/web WorldGeometry.ts) and, for the Mars campus, a backdrop in two tiers (WorldBackdropTiers.ts:
// coarse far, exact near). Without one, v2's ground stopped at the last terrain tile and the view looked off a cliff
// into the sky. Two tiers here, one draw: a skirt that starts on the drawn ground's own edge heights and colours and
// runs SKIRT m out, sloping to one level, then flat ground at that level to FAR m past the edge (past the camera's far
// plane), fading into the scene's fog. It has a hole the world's size, so it never covers the world's own ground (a
// lake bed lower than the edge stays visible); nothing stands on it, it casts no shadow and receives the sun's.
import * as THREE from 'three';

/** Today's margin: the outside ground reached 80 m past the world's bounds. */
export const SKIRT = 80;
/** Past the camera's far plane (1200 m) from any point inside the world. */
export const FAR = 1600;
/** Edge points every this many metres (the terrain's own grid). */
const STEP = 1;

export type Backdrop = { mesh: THREE.Mesh; level: number; colour: THREE.Color };

/** The backdrop around `extent` ([x0, z0, x1, z1] m). `heightAt` and `colourAt` read the drawn ground (null off it). */
export function backdropMesh(
  extent: readonly [number, number, number, number],
  heightAt: (x: number, z: number) => number | null,
  colourAt: (x: number, z: number) => THREE.Color | null,
): Backdrop {
  const [x0, z0, x1, z1] = extent;
  // Just inside the edge: the tile that holds x1 is the one before it.
  const inX = (x: number) => Math.min(Math.max(x, x0), x1 - 1e-6), inZ = (z: number) => Math.min(Math.max(z, z0), z1 - 1e-6);
  // The edge's points, once around: south (z0) west to east, east (x1) south to north, north (z1) east to west, west (x0).
  const ring: [number, number][] = [];
  const side = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / STEP));
    for (let i = 0; i < n; i++) ring.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
  };
  side(x0, z0, x1, z0); side(x1, z0, x1, z1); side(x1, z1, x0, z1); side(x0, z1, x0, z0);
  const heights = ring.map(([x, z]) => heightAt(inX(x), inZ(z)));
  const known = heights.filter((h): h is number => h !== null);
  const level = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
  const mean = new THREE.Color(0, 0, 0);
  let coloured = 0;
  const colours = ring.map(([x, z]) => {
    const c = colourAt(inX(x), inZ(z));
    if (c) (mean.add(c), coloured++);
    return c;
  });
  if (coloured) mean.multiplyScalar(1 / coloured);
  else mean.setHex(0x6f8f55);

  const pos: number[] = [], col: number[] = [], index: number[] = [];
  const vertex = (x: number, y: number, z: number, c: THREE.Color) => (pos.push(x, y, z), col.push(c.r, c.g, c.b), pos.length / 3 - 1);
  // Tier 1, the skirt: each edge point joined to the point SKIRT m straight out (corners: out on both axes).
  const out = ([x, z]: [number, number]): [number, number] => [
    x <= x0 ? x - SKIRT : x >= x1 ? x + SKIRT : x,
    z <= z0 ? z - SKIRT : z >= z1 ? z + SKIRT : z,
  ];
  const inner: number[] = [], outer: number[] = [];
  ring.forEach((p, i) => {
    inner.push(vertex(p[0], heights[i] ?? level, p[1], colours[i] ?? mean));
    const [ox, oz] = out(p);
    outer.push(vertex(ox, level, oz, mean));
  });
  // Faces up: the ring runs anticlockwise seen from above (+y), with +z toward the viewer of a top-down map.
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    index.push(inner[i], inner[j], outer[i], outer[i], inner[j], outer[j]);
  }
  // Tier 2, flat ground from the skirt's outer edge to FAR m past the world's.
  const a = [x0 - SKIRT, z0 - SKIRT, x1 + SKIRT, z1 + SKIRT], b = [x0 - FAR, z0 - FAR, x1 + FAR, z1 + FAR];
  const corners = (r: number[]) => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(([x, z]) => vertex(x, level, z, mean));
  const ai = corners(a), bi = corners(b);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    index.push(ai[i], ai[j], bi[i], bi[i], ai[j], bi[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  // Winding: make every face's normal point up whatever the order above produced.
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  let up = 0;
  for (let i = 0; i < n.count; i++) up += n.getY(i);
  if (up < 0) {
    for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
    g.setIndex(index);
    g.computeVertexNormals();
  }
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'far-backdrop';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return { mesh, level, colour: mean };
}
