// Deliberately crude drawing (V5, #2714): the open ground's terrain as a mesh, each thing as boxes (its solids, or a
// small box when it has none), each body as a capsule placed between its recorded samples, in the frame they were
// recorded in (T4), and never past the newest. Rooms, floors, windows and places are structure, not drawn.
import * as THREE from 'three';
import type { NodeRec, SampleRec } from '../source/source.ts';
import { Track } from '../clock/samples.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CrowdBodies } from '../crowd/bodies.ts';

const UM = 1e-6, MM = 1e-3;
export const STRUCTURE = new Set(['souls:place', 'eden:world', 'eden:ground', 'eden:floor', 'eden:room', 'eden:window', 'eden:place', 'eden:doorway']);
const plain = (kind: string) => kind.split('@')[0];
/** Terrain vertices kept per tile side: every TERRAIN_STEP-th. */
const TERRAIN_STEP = 8;
const CLASS_COLOURS = [0x6f8f55, 0x8a7d5c, 0x9a9486, 0x5f7a49, 0x7d9c63, 0xa59b78, 0x4f6b8a, 0x7a7a72];

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
  /** Bodies as V6's crowd once its body files have loaded; capsules until then. */
  private crowdBodies: CrowdBodies | null = null;
  private terrainDone = false;
  extent: [number, number, number, number] | null = null;
  /** False when V8's thing layer draws the things instead of these boxes. */
  drawThings = true;

  constructor() {
    const capsule = new THREE.CapsuleGeometry(0.28, 1.1, 4, 10);
    capsule.translate(0, 0.83, 0);
    this.bodies = new THREE.InstancedMesh(capsule, new THREE.MeshLambertMaterial({ color: 0xf2a541 }), 1024);
    this.bodies.count = 0;
    this.bodies.frustumCulled = false;
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
      if (n.at !== null) {
        if (!this.tracks.has(n.id)) {
          this.tracks.set(n.id, new Track());
          this.bodyIds.push(n.id);
        }
      } else if (!STRUCTURE.has(plain(n.kind))) this.thingsDirty = true;
      if (n.tiles && !this.terrainDone) this.terrain(n);
    }
    // Every sample in entry order, then the state after the part (the newest, so a no-op when it was the last sample).
    for (const [id, parent, slot, at, x, y, z] of samples) this.tracks.get(id)?.add(at, [x, y, z], `${parent}/${slot}`);
    for (const n of nodes) if (n.at !== null) this.tracks.get(n.id)!.add(n.at, n.pos, `${n.parent}/${n.slot}`);
    for (const id of removed) {
      this.nodes.delete(id);
      if (this.tracks.delete(id)) this.bodyIds = this.bodyIds.filter((b) => b !== id);
      else this.thingsDirty = true;
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
      if (slot) m.multiply(new THREE.Matrix4().compose(new THREE.Vector3(slot[1] * MM, slot[2] * MM, slot[3] * MM), yawQuat(slot[4]), new THREE.Vector3(1, 1, 1)));
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
    const side = (ground.tileSize ?? 64_000) * MM;
    let ext: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true }), tiles: THREE.BufferGeometry[] = [];
    for (const [tx, tz, heights, classes] of ground.tiles ?? []) {
      const n = Math.round(Math.sqrt(classes.length));
      const hv = new DataView(heights.buffer, heights.byteOffset, heights.byteLength);
      const k = Math.max(1, Math.floor(n / Math.max(1, Math.round(n / TERRAIN_STEP))));
      const m = Math.floor(n / k);
      const pos = new Float32Array((m + 1) * (m + 1) * 3), col = new Float32Array((m + 1) * (m + 1) * 3);
      const c = new THREE.Color();
      for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
        const v = j * (m + 1) + i, ix = i * k, iz = j * k;
        pos[v * 3] = tx * side + (ix / n) * side;
        pos[v * 3 + 1] = hv.getInt32((iz * (n + 1) + ix) * 4, true) * MM;
        pos[v * 3 + 2] = tz * side + (iz / n) * side;
        c.setHex(CLASS_COLOURS[classes[Math.min(n - 1, iz) * n + Math.min(n - 1, ix)] % CLASS_COLOURS.length]);
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
    if (tiles.length) this.group.add(new THREE.Mesh(mergeGeometries(tiles), mat));
    if (Number.isFinite(ext[0])) this.extent = ext;
  }

  /** Rebuilds the things' boxes when a part changed any thing. */
  private rebuildThings(): void {
    this.thingsDirty = false;
    const boxes: THREE.Matrix4[] = [];
    const tags: number[] = [];
    for (const n of this.nodes.values()) {
      if (n.at !== null || STRUCTURE.has(plain(n.kind))) continue;
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

  /** Places every body at world time `t` and returns how many were drawn. */
  draw(t: number, camera?: THREE.Camera): number {
    if (this.thingsDirty && this.drawThings) this.rebuildThings();
    if (this.bodyIds.length > this.bodies.instanceMatrix.count) {
      const grown = new THREE.InstancedMesh(this.bodies.geometry, this.bodies.material, this.bodyIds.length * 2);
      this.group.remove(this.bodies);
      this.bodies = grown;
      this.bodies.frustumCulled = false;
      this.group.add(grown);
    }
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    const crowd = camera ? this.crowdBodies : null;
    crowd?.begin(t);
    let k = 0;
    for (const id of this.bodyIds) {
      const tr = this.tracks.get(id)!;
      tr.trim(t);
      const p = tr.at(t);
      const n = this.nodes.get(id);
      if (!p || !n) continue;
      v.set(p[0] * UM, p[1] * UM, p[2] * UM).applyMatrix4(this.frame(n.parent));
      if (crowd) (crowd.place(id, v.x, v.y, v.z), k++);
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
      const p = this.tracks.get(id)!.at(t), n = this.nodes.get(id);
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
