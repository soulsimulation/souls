// Deliberately crude drawing (V5, #2714): the open ground's terrain as a mesh, each thing as boxes (its solids, or a
// small box when it has none), each body as a capsule placed between its recorded samples, in the frame they were
// recorded in (T4), and never past the newest. Rooms, floors, windows and places are structure, not drawn.
import * as THREE from 'three';
import type { NodeRec, SampleRec } from '../source/source.ts';
import { Track } from '../clock/samples.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CrowdBodies } from '../crowd/bodies.ts';
import { BANKS, DECKS, DRAPES, WATER, GroundCover, drapeMesh, drapeName, turfMaterial, type Area } from './drapes.ts';
import { asWater } from '../water/water.ts';
import { backdropMesh, type Backdrop } from './backdrop.ts';

const UM = 1e-6, MM = 1e-3;
export const STRUCTURE = new Set(['souls:place', 'eden:world', 'eden:ground', 'eden:floor', 'eden:room', 'eden:window', 'eden:place', 'eden:doorway']);
const plain = (kind: string) => kind.split('@')[0];
/** A body: one with a motion sample, or a body kind standing still since it joined (no motion published yet). */
const BODY = /(^|:)(body|soul)$/;
const isBody = (n: NodeRec) => n.at !== null || BODY.test(plain(n.kind));
/** Terrain vertices kept per tile side: every one, so what stands on the ground meets the ground as drawn (an 8 m
 *  grid left things on hills up to metres above it). */
const TERRAIN_STEP = 1;
/** Today's ground palette for Eden (apps/web/src/gen-mesh/ground-palette.ts, `meadow`, Eden 2026's `state.ground.palette`)
 *  and its base height (`constants.base`, 0): the stream carries neither, so the page paints Eden's. */
export const MEADOW = { low: 0xb6ae89, base: 0x7f9062, high: 0x7e8a6e, rock: 0x8d8a84, snow: 150, snowC: 0xf2f4f6, rockFrom: 0.75, noise: 0.03, shore: 0xb6ae89 };
export const GROUND_BASE = 0;
const _a = new THREE.Color();
function n2(x: number, z: number) { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); }
/** Today's terrain colour (ground-palette.ts `terrainColorFor('meadow')`): height above the base and slope, the shore
 *  below the plain fading to the bed, rock on steep ground, a little positional noise. Per vertex, so the shore's and the
 *  banks' edges blend across a cell as today's do. */
export function terrainColour(c: THREE.Color, y: number, slope: number, x: number, z: number, p = MEADOW, base = GROUND_BASE): THREE.Color {
  const h = y - base;
  c.setHex(h < -0.2 ? p.shore : p.base);
  if (h < -0.2) c.lerp(_a.setHex(p.low), Math.min(1, (-0.2 - h) / 1.5) * 0.6);
  if (h > 40) c.lerp(_a.setHex(p.high), Math.min(1, (h - 40) / 60));
  c.lerp(_a.setHex(p.rock), Math.min(1, Math.max(0, (slope - p.rockFrom) / 0.9)));
  if (h > p.snow) c.lerp(_a.setHex(p.snowC), Math.min(1, (h - p.snow) / 50));
  const k = 1 + (n2(Math.floor(x / 4), Math.floor(z / 4)) - 0.5) * 2 * p.noise;
  c.r = Math.min(1, c.r * k); c.g = Math.min(1, c.g * k); c.b = Math.min(1, c.b * k);
  return c;
}

/** A polygon on the ground `[x, z]` m with its bounds, filed by 8 m cell for the ground cover. */
type Shape = { points: [number, number][]; bb: [number, number, number, number] };
const SHAPE_CELL = 8;
/** Today's lawn edge (Eden's lawns, `edge` 1.2 m): its rim is left long. */
const LAWN_EDGE = 1.2;
function file(into: Map<string, Shape[]>, points: [number, number][]): void {
  if (points.length < 3) return;
  const bb: Shape['bb'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of points) (bb[0] = Math.min(bb[0], x), bb[1] = Math.min(bb[1], z), bb[2] = Math.max(bb[2], x), bb[3] = Math.max(bb[3], z));
  const s = { points, bb };
  for (let j = Math.floor(bb[1] / SHAPE_CELL); j <= Math.floor(bb[3] / SHAPE_CELL); j++) for (let i = Math.floor(bb[0] / SHAPE_CELL); i <= Math.floor(bb[2] / SHAPE_CELL); i++) {
    const k = `${i},${j}`;
    (into.get(k) ?? into.set(k, []).get(k)!).push(s);
  }
}
function inPoly(x: number, z: number, p: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i], [xj, zj] = p[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** The smallest filed shape holding `x, z`, or null. */
function hit(shapes: Map<string, Shape[]>, x: number, z: number): Shape | null {
  let best: Shape | null = null, size = Infinity;
  for (const s of shapes.get(`${Math.floor(x / SHAPE_CELL)},${Math.floor(z / SHAPE_CELL)}`) ?? []) {
    if (x < s.bb[0] || x > s.bb[2] || z < s.bb[1] || z > s.bb[3] || !inPoly(x, z, s.points)) continue;
    const a = (s.bb[2] - s.bb[0]) * (s.bb[3] - s.bb[1]);
    if (a < size) (best = s, size = a);
  }
  return best;
}
function edgeDistance(poly: [number, number][], x: number, z: number): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i], vx = bx - ax, vz = bz - az, n = vx * vx + vz * vz;
    const t = n ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / n)) : 0;
    d = Math.min(d, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return d;
}

function yawQuat(mdeg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (mdeg / 1000) * (Math.PI / 180));
}

export class WorldView {
  readonly group = new THREE.Group();
  readonly nodes = new Map<string, NodeRec>();
  readonly tracks = new Map<string, Track>();
  private matrices = new Map<string, THREE.Matrix4>();
  private things: THREE.InstancedMesh[] = [];
  private bodies: THREE.InstancedMesh;
  private bodyIds: string[] = [];
  private thingsDirty = false;
  private drapesDirty = false;
  private drapes: THREE.Mesh | null = null;
  /** Today's ground cover (grass, tufts, wildflowers) around the drawing camera. */
  cover: GroundCover | null = null;
  /** Where nothing grows (paths, beds, shores, footprints) and the lawns, by 8 m cell, for the cover. */
  private bare = new Map<string, Shape[]>();
  private lawns = new Map<string, Shape[]>();
  private coverDirty = true;
  private lawnAreas: [number, number][][] = [];
  private bareAreas: [number, number][][] = [];
  /** V19b: the still water, in today's water shader (`water/water.ts`). */
  private water: THREE.Mesh | null = null;
  /** Bodies as V6's crowd once its body files have loaded; capsules until then. */
  private crowdBodies: CrowdBodies | null = null;
  private terrainDone = false;
  /** The drawn ground's tiles, for `heightAt`. */
  private ground: { side: number; tiles: Map<string, { n: number; k: number; h: DataView }> } | null = null;
  /** C12 (#3683): the far backdrop beyond the ground's edge. */
  backdrop: Backdrop | null = null;
  /** The open ground's node: what a ground-laid thing's heights are above. */
  groundId: string | null = null;
  extent: [number, number, number, number] | null = null;
  /** False when V8's thing layer draws the things instead of these boxes. */
  drawThings = true;

  constructor() {
    const capsule = new THREE.CapsuleGeometry(0.28, 1.1, 4, 10);
    capsule.translate(0, 0.83, 0);
    this.bodies = new THREE.InstancedMesh(capsule, new THREE.MeshLambertMaterial({ color: 0xf2a541 }), 1024);
    this.bodies.count = 0;
    this.bodies.frustumCulled = false;
    this.bodies.castShadow = true;
    this.group.add(this.bodies);
  }

  attach(c: CrowdBodies): void {
    this.crowdBodies = c;
    this.group.add(c.crowd.group);
    this.bodies.visible = false;
  }

  /** Applies a part's node records: bodies' samples (every one the part carried, V6) go into their tracks, everything
   *  else into the scene. */
  apply(nodes: NodeRec[], removed: string[], samples: SampleRec[] = []): void {
    for (const n of nodes) {
      this.nodes.set(n.id, n);
      if (isBody(n)) {
        if (!this.tracks.has(n.id)) {
          this.tracks.set(n.id, new Track());
          this.bodyIds.push(n.id);
        }
      } else if (!STRUCTURE.has(plain(n.kind))) this.thingsDirty = this.coverDirty = true;
      if (n.surfaces || n.waterLevel !== undefined || drapeName(n.kind) in DRAPES || drapeName(n.kind) in DECKS) this.drapesDirty = true;
      if (n.tiles && !this.terrainDone) this.terrain(n);
    }
    // Every sample in entry order, then the state after the part (the newest, so a no-op when it was the last sample).
    for (const [id, parent, slot, at, x, y, z] of samples) this.tracks.get(id)?.add(at, [x, y, z], `${parent}/${slot}`);
    // A still body has no sample time: its pose stands from the start of its track until a sample moves it.
    for (const n of nodes) if (isBody(n)) this.tracks.get(n.id)!.add(n.at ?? 0, n.pos, `${n.parent}/${n.slot}`);
    for (const id of removed) {
      this.nodes.delete(id);
      if (this.tracks.delete(id)) this.bodyIds = this.bodyIds.filter((b) => b !== id);
      else this.thingsDirty = this.coverDirty = true;
    }
    this.matrices.clear();
  }

  /** A node's frame in the world: its parent's, then its slot's, then its own pose. */
  frame(id: string | null): THREE.Matrix4 {
    if (id === null) return new THREE.Matrix4();
    const cached = this.matrices.get(id);
    if (cached) return cached;
    const n = this.nodes.get(id);
    const m = new THREE.Matrix4();
    if (n) {
      m.copy(this.frame(n.parent));
      const parent = n.parent ? this.nodes.get(n.parent) : undefined;
      const slot = n.slot !== null ? parent?.slots?.find((s) => s[0] === n.slot) : undefined;
      // A slot's point only, as T4's carry adds it: the slot's yaw does not turn what is in it.
      if (slot) m.multiply(new THREE.Matrix4().makeTranslation(slot[1] * MM, slot[2] * MM, slot[3] * MM));
      const [w, x, y, z] = n.rot;
      m.multiply(new THREE.Matrix4().compose(
        new THREE.Vector3(n.pos[0] * UM, n.pos[1] * UM, n.pos[2] * UM),
        new THREE.Quaternion(x, y, z, w).normalize(),
        new THREE.Vector3(1, 1, 1),
      ));
    }
    this.matrices.set(id, m);
    return m;
  }

  private terrain(ground: NodeRec): void {
    this.terrainDone = true;
    this.groundId = ground.id;
    const side = (ground.tileSize ?? 64_000) * MM;
    let ext: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const tiles: THREE.BufferGeometry[] = [];
    this.ground = { side, tiles: new Map() };
    const list = (ground.tiles ?? []).map(([tx, tz, heights, classes]) => {
      const n = Math.round(Math.sqrt(classes.length));
      const hv = new DataView(heights.buffer, heights.byteOffset, heights.byteLength);
      const k = Math.max(1, Math.floor(n / Math.max(1, Math.round(n / TERRAIN_STEP))));
      this.ground!.tiles.set(`${tx},${tz}`, { n, k, h: hv });
      return { tx, tz, n, k, hv };
    });
    // Every tile is known before any is painted, so a slope at a tile's edge reads its neighbour's heights.
    for (const { tx, tz, n, k, hv } of list) {
      const m = Math.floor(n / k);
      const pos = new Float32Array((m + 1) * (m + 1) * 3), col = new Float32Array((m + 1) * (m + 1) * 3);
      const c = new THREE.Color(), cell = (side / n) * k;
      for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
        const v = j * (m + 1) + i, ix = i * k, iz = j * k;
        const x = tx * side + (ix / n) * side, z = tz * side + (iz / n) * side, y = hv.getInt32((iz * (n + 1) + ix) * 4, true) * MM;
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
        // Today's slope: the height's rise a metre, by differences across the neighbouring grid points.
        const hx0 = this.heightAt(x - cell, z) ?? y, hx1 = this.heightAt(x + cell, z) ?? y, hz0 = this.heightAt(x, z - cell) ?? y, hz1 = this.heightAt(x, z + cell) ?? y;
        terrainColour(c, y, Math.hypot((hx1 - hx0) / (2 * cell), (hz1 - hz0) / (2 * cell)), x, z);
        col.set([c.r, c.g, c.b], v * 3);
      }
      const index: number[] = [];
      for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
        const a = j * (m + 1) + i, b = a + 1, d = a + m + 1, e = d + 1;
        index.push(a, d, b, b, d, e);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(index);
      g.computeVertexNormals();
      tiles.push(g); // V8: one draw for the ground, not one a tile (Eden has 256)
      ext = [Math.min(ext[0], tx * side), Math.min(ext[1], tz * side), Math.max(ext[2], (tx + 1) * side), Math.max(ext[3], (tz + 1) * side)];
    }
    if (tiles.length) {
      // Today's Eden turf (WorldEdenRealism's ground class): lush and sun-dried swathes over the palette's colours.
      const mesh = new THREE.Mesh(mergeGeometries(tiles), turfMaterial());
      mesh.receiveShadow = true;
      mesh.name = 'terrain';
      this.group.add(mesh);
    }
    if (Number.isFinite(ext[0])) {
      this.extent = ext;
      this.backdrop = backdropMesh(ext, (x, z) => this.heightAt(x, z), (x, z) => this.colourAt(x, z));
      this.group.add(this.backdrop.mesh);
    }
    this.cover = new GroundCover({
      heightAt: (x, z) => this.heightAt(x, z),
      colour: (c, y, slope, x, z) => terrainColour(c, y, slope, x, z),
      blocked: (x, z) => !!hit(this.bare, x, z),
      lawn: (x, z) => {
        const s = hit(this.lawns, x, z);
        return s ? { edge: LAWN_EDGE, rim: edgeDistance(s.points, x, z) } : null;
      },
      base: GROUND_BASE,
    });
    this.group.add(this.cover.group);
  }

  /** The drawn ground's colour at world `x, z`, as its vertex there is painted (today's terrain colour at its height,
   *  slope and noise cell); on the far edges the height is read just inside. Null off the tiles. */
  colourAt(x: number, z: number): THREE.Color | null {
    const g = this.ground, e = this.extent;
    const hx = e ? Math.min(x, e[2] - 1e-6) : x, hz = e ? Math.min(z, e[3] - 1e-6) : z, y = this.heightAt(hx, hz);
    if (!g || y === null) return null;
    const t = g.tiles.get(`${Math.floor(hx / g.side)},${Math.floor(hz / g.side)}`)!, cell = (g.side / t.n) * t.k;
    const hx0 = this.heightAt(x - cell, z) ?? y, hx1 = this.heightAt(x + cell, z) ?? y, hz0 = this.heightAt(x, z - cell) ?? y, hz1 = this.heightAt(x, z + cell) ?? y;
    return terrainColour(new THREE.Color(), y, Math.hypot((hx1 - hx0) / (2 * cell), (hz1 - hz0) / (2 * cell)), x, z);
  }

  /** The drawn ground's height at world `x, z` (m), on the same triangles the mesh draws; null off the tiles. */
  heightAt(x: number, z: number): number | null {
    const g = this.ground;
    if (!g) return null;
    const tx = Math.floor(x / g.side), tz = Math.floor(z / g.side), t = g.tiles.get(`${tx},${tz}`);
    if (!t) return null;
    const m = Math.floor(t.n / t.k), cell = (g.side / t.n) * t.k;
    const lx = (x - tx * g.side) / cell, lz = (z - tz * g.side) / cell;
    const i = Math.min(Math.floor(lx), m - 1), j = Math.min(Math.floor(lz), m - 1), u = lx - i, v = lz - j;
    const h = (a: number, b: number) => t.h.getInt32(((b * t.k) * (t.n + 1) + a * t.k) * 4, true) * MM;
    const a = h(i, j), b = h(i + 1, j), d = h(i, j + 1), e = h(i + 1, j + 1);
    // The quad's two triangles as indexed: (a, d, b) and (b, d, e).
    return u + v <= 1 ? a + (b - a) * u + (d - a) * v : e + (d - e) * (1 - u) + (b - e) * (1 - v);
  }

  /** Rebuilds the things' boxes when a part changed any thing. */
  private rebuildThings(): void {
    this.thingsDirty = false;
    const boxes: THREE.Matrix4[] = [];
    const tags: number[] = [];
    for (const n of this.nodes.values()) {
      if (isBody(n) || STRUCTURE.has(plain(n.kind))) continue;
      const f = this.frame(n.id);
      const s = (n.scale ?? 1_000_000) / 1_000_000;
      const solids = n.solids?.length ? n.solids : [[0, 0, 250, 250, 0, 0, 500, 0, 0]];
      for (const [cx, cz, hx, hz, yaw, y0, y1, tag] of solids) {
        const local = new THREE.Matrix4().compose(
          new THREE.Vector3(cx * MM * s, ((y0 + y1) / 2) * MM * s, cz * MM * s),
          yawQuat(yaw),
          new THREE.Vector3(Math.max(0.05, 2 * hx * MM * s), Math.max(0.05, (y1 - y0) * MM * s), Math.max(0.05, 2 * hz * MM * s)),
        );
        boxes.push(f.clone().multiply(local));
        tags.push(tag);
      }
    }
    for (const m of this.things) {
      this.group.remove(m);
      m.dispose();
    }
    // One instanced mesh per 100 m cell, so what is out of view is culled as a whole.
    const cells = new Map<string, number[]>();
    const p = new THREE.Vector3();
    boxes.forEach((m, i) => {
      p.setFromMatrixPosition(m);
      const key = `${Math.floor(p.x / 100)},${Math.floor(p.z / 100)}`;
      (cells.get(key) ?? cells.set(key, []).get(key)!).push(i);
    });
    const box = new THREE.BoxGeometry(1, 1, 1), mat = new THREE.MeshLambertMaterial({ color: 0xffffff }), c = new THREE.Color();
    this.things = [...cells.values()].map((ids) => {
      const mesh = new THREE.InstancedMesh(box, mat, ids.length);
      ids.forEach((b, i) => {
        mesh.setMatrixAt(i, boxes[b]);
        mesh.setColorAt(i, c.setHSL(0.08 + (tags[b] % 9) * 0.05, 0.18, 0.62));
      });
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      return mesh;
    });
  }

  /** Is this thing a ground-laid area, drawn flat on the ground rather than as a thing? */
  isDrape(n: NodeRec): boolean {
    return drapeName(n.kind) in DRAPES;
  }

  /** Is this thing a deck (a pier, a bridge), its surfaces at their own heights? */
  isDeck(n: NodeRec): boolean {
    return drapeName(n.kind) in DECKS;
  }

  /** The ground-laid areas, flat on the drawn ground. */
  private rebuildDrapes(): void {
    this.drapesDirty = false;
    const areas: Area[] = [], water: Area[] = [];
    const floors = new Map<string, NodeRec[]>();
    for (const n of this.nodes.values()) if (n.surfaces && n.parent) (floors.get(n.parent) ?? floors.set(n.parent, []).get(n.parent)!).push(n);
    const p = new THREE.Vector3();
    for (const n of this.nodes.values()) {
      if (n.waterLevel !== undefined && n.outline) water.push({ colour: WATER, level: true, lift: n.waterLevel * MM, points: n.outline.map(([x, z]) => [x * MM, z * MM]) });
      const level = this.isDeck(n), colour = level ? DECKS[drapeName(n.kind)] : DRAPES[drapeName(n.kind)];
      if (colour === undefined) continue;
      const bank = drapeName(n.kind) in BANKS ? drapeName(n.kind) : undefined;
      const own = floors.get(n.id) ?? [];
      for (const f of own) {
        const m = this.frame(f.id);
        for (const [y, pts] of f.surfaces!) {
          const at = p.set(0, y * MM, 0).applyMatrix4(m).y;
          areas.push({ colour, level, bank, lift: level ? at : y * MM, points: pts.map(([x, z]) => (p.set(x * MM, 0, z * MM).applyMatrix4(m), [p.x, p.z])) });
        }
      }
      if (!own.length && n.outline) areas.push({ colour, bank, lift: 0, points: n.outline.map(([x, z]) => [x * MM, z * MM]) });
    }
    // A lawn grows mown tufts; every other area (paths, beds, pitches, shores, decks) and the water grow nothing.
    this.lawnAreas = areas.filter((a) => a.colour === DRAPES.lawn && !a.level).map((a) => a.points);
    this.bareAreas = [...areas.filter((a) => a.colour !== DRAPES.lawn || a.level), ...water].map((a) => a.points);
    this.coverDirty = true;
    for (const m of [this.drapes, this.water]) if (m) (this.group.remove(m), m.geometry.dispose());
    this.drapes = drapeMesh(areas, (x, z) => this.heightAt(x, z));
    const w = drapeMesh(water, (x, z) => this.heightAt(x, z));
    this.water = w && asWater(w);
    for (const m of [this.drapes, this.water]) if (m) this.group.add(m);
  }

  /** Files the cover's shapes: the areas, and the footprint of every solid standing on the open ground. */
  private rebuildCoverShapes(): void {
    this.coverDirty = false;
    this.bare = new Map();
    this.lawns = new Map();
    for (const a of this.bareAreas) file(this.bare, a);
    for (const a of this.lawnAreas) file(this.lawns, a);
    const p = new THREE.Vector3();
    for (const n of this.nodes.values()) {
      if (isBody(n) || n.parent !== this.groundId || STRUCTURE.has(plain(n.kind)) || !n.solids?.length || this.isDrape(n) || this.isDeck(n)) continue;
      const f = this.frame(n.id), s = (n.scale ?? 1_000_000) / 1_000_000;
      for (const [cx, cz, hx, hz, yaw, y0] of n.solids) {
        const a = (yaw / 1000) * (Math.PI / 180), ca = Math.cos(a), sa = Math.sin(a);
        const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v]): [number, number] => {
          const lx = (cx + u * hx * ca + v * hz * sa) * MM * s, lz = (cz - u * hx * sa + v * hz * ca) * MM * s;
          p.set(lx, y0 * MM * s, lz).applyMatrix4(f);
          return [p.x, p.z];
        });
        // Only what stands on the ground keeps it bare (a canopy or an awning over it does not).
        p.set(cx * MM * s, y0 * MM * s, cz * MM * s).applyMatrix4(f);
        const g = this.heightAt(p.x, p.z);
        if (g !== null && p.y <= g + 0.5) file(this.bare, corners);
      }
    }
    this.cover?.invalidate();
  }

  /** Places every body at world time `t` and returns how many were drawn. */
  draw(t: number, camera?: THREE.Camera): number {
    if (this.drapesDirty && this.ground) this.rebuildDrapes();
    if (this.thingsDirty && this.drawThings) this.rebuildThings();
    if (this.coverDirty && this.cover && !this.drapesDirty) this.rebuildCoverShapes();
    if (camera && this.cover) this.cover.update(camera);
    if (this.bodyIds.length > this.bodies.instanceMatrix.count) {
      const grown = new THREE.InstancedMesh(this.bodies.geometry, this.bodies.material, this.bodyIds.length * 2);
      this.group.remove(this.bodies);
      this.bodies = grown;
      this.bodies.frustumCulled = false;
      this.bodies.castShadow = true;
      this.group.add(grown);
    }
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    const crowd = camera ? this.crowdBodies : null;
    crowd?.begin(t);
    let k = 0;
    for (const id of this.bodyIds) {
      const tr = this.tracks.get(id)!;
      tr.trim(t);
      const n = this.nodes.get(id);
      if (!n) continue;
      const p = tr.at(t) ?? n.pos;
      v.set(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(this.frame(n.parent));
      if (crowd) (crowd.place(id, v.x, v.y, v.z, n.body), k++);
      else this.bodies.setMatrixAt(k++, m.makeTranslation(v.x, v.y, v.z));
    }
    if (crowd) {
      crowd.end(camera!);
      return k;
    }
    this.bodies.count = k;
    this.bodies.instanceMatrix.needsUpdate = true;
    return k;
  }

  /** Where the bodies are thickest, for the first view: the body with the most others within 60 m. */
  crowd(t: number): THREE.Vector3 | null {
    const at: THREE.Vector3[] = [];
    for (const id of this.bodyIds) {
      const n = this.nodes.get(id), p = this.tracks.get(id)!.at(t) ?? n?.pos;
      if (p && n) at.push(new THREE.Vector3(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(this.frame(n.parent)));
    }
    let best: THREE.Vector3 | null = null, most = -1;
    for (const a of at) {
      const near = at.filter((b) => a.distanceToSquared(b) < 3600).length;
      if (near > most) [best, most] = [a, near];
    }
    return best;
  }
}
