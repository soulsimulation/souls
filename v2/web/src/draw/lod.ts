// The ground drawn simplified at a distance (#3785), today's WorldMeshLod (apps/web/src/WorldMeshLod.ts) for v2's one
// large mesh. Eden's things have no part near today's 6,000-triangle line (their largest is a few hundred triangles),
// so what today simplifies, terrain sectors and merged batches, is here the ground: two million triangles in one draw.
//
// The ground is cut into sectors of SECTOR_TILES × SECTOR_TILES tiles that share its vertices; each sector gets coarser
// index buffers from meshoptimizer's simplifier, built in a worker (lod.worker.ts) so the page never stalls, with
// today's ratios, weights, locked borders (so sectors never crack) and 1.5 cm cap. Once a frame, each sector draws the
// coarsest level whose error, at the sector's nearest point, is under `maxErrorPx` CSS pixels (today's 1 on a phone,
// half on a desktop), and its full index otherwise: up close the ground is exactly as before. The sectors are also
// culled by the camera's view, which one ground-wide draw never was. Until a sector's levels arrive it draws in full.
import * as THREE from 'three';
import { COLOUR_WEIGHT, NORMAL_WEIGHT, type LodInput, type LodLevel } from './lod-core.ts';
import type { MeshLod } from './quality-tier.ts';

/** Tiles a sector side: Eden's 64 m tiles make 256 m sectors, 16 of them, 131,072 triangles each. */
export const SECTOR_TILES = 4;
/** One ground tile's place in the ground's merged geometry. */
export type GroundTile = { tx: number; tz: number; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number };
/** Builds a sector's levels (the worker, or a simplifier in tests). */
export type Levels = (input: LodInput) => Promise<LodLevel[]>;

type Level = { geometry: THREE.BufferGeometry; error: number; triangles: number };
type Sector = { mesh: THREE.Mesh; full: THREE.BufferGeometry; box: THREE.Box3; tiles: GroundTile[]; triangles: number; levels: Level[] | null; pending: boolean };

export class GroundLod {
  readonly group = new THREE.Group();
  readonly sectors: Sector[] = [];
  /** The last update: sectors, sectors with levels, sectors drawn coarser, triangles drawn (in view or not) vs. in full. */
  readonly stats = { sectors: 0, ready: 0, coarser: 0, triangles: 0, fullTriangles: 0, cpuMs: 0 };
  private inFlight = 0;
  private readonly at = new THREE.Vector3();
  readonly terrain: THREE.Mesh;
  private readonly opts: MeshLod;
  private readonly levels: Levels;
  private readonly concurrent: number;

  constructor(terrain: THREE.Mesh, tiles: GroundTile[], opts: MeshLod, levels: Levels, concurrent = 2) {
    this.terrain = terrain;
    this.opts = opts;
    this.levels = levels;
    this.concurrent = concurrent;
    this.group.name = 'terrain sectors';
    const g = terrain.geometry, index = g.index!.array as ArrayLike<number>, pos = g.getAttribute('position');
    const bySector = new Map<string, GroundTile[]>();
    for (const t of tiles) {
      const key = `${Math.floor(t.tx / SECTOR_TILES)},${Math.floor(t.tz / SECTOR_TILES)}`;
      (bySector.get(key) ?? bySector.set(key, []).get(key)!).push(t);
    }
    for (const list of bySector.values()) {
      const n = list.reduce((a, t) => a + t.indexCount, 0), own = new Uint32Array(n), box = new THREE.Box3(), p = new THREE.Vector3();
      let o = 0;
      for (const t of list) {
        for (let i = 0; i < t.indexCount; i++) own[o++] = index[t.indexStart + i];
        for (let v = t.vertexStart; v < t.vertexStart + t.vertexCount; v++) box.expandByPoint(p.fromBufferAttribute(pos, v));
      }
      const full = this.share(new THREE.BufferAttribute(own, 1), box);
      const mesh = new THREE.Mesh(full, terrain.material);
      mesh.receiveShadow = terrain.receiveShadow;
      mesh.castShadow = terrain.castShadow;
      mesh.name = 'terrain sector';
      this.group.add(mesh);
      this.sectors.push({ mesh, full, box, tiles: list, triangles: n / 3, levels: null, pending: false });
    }
    terrain.visible = false;
    terrain.parent?.add(this.group);
  }

  /** A geometry drawing `index` over the ground's own vertices (uploaded once, whatever shares them). */
  private share(index: THREE.BufferAttribute, box: THREE.Box3): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry(), base = this.terrain.geometry;
    for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a);
    g.setIndex(index);
    g.boundingBox = box.clone();
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    return g;
  }

  /** What the simplifier needs of a sector: its own copy of its vertices (positions, colours, normals) and its index
   *  into them. */
  input(s: Sector): LodInput {
    const g = this.terrain.geometry, count = s.tiles.reduce((a, t) => a + t.vertexCount, 0), index = g.index!.array as ArrayLike<number>;
    const copy = (name: string) => {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (!a) return null;
      const out = new Float32Array(count * 3);
      let o = 0;
      for (const t of s.tiles) for (let v = t.vertexStart; v < t.vertexStart + t.vertexCount; v++) (out[o++] = a.getX(v), out[o++] = a.getY(v), out[o++] = a.getZ(v));
      return out;
    };
    const indices = new Uint32Array(s.triangles * 3);
    let o = 0, local = 0;
    for (const t of s.tiles) {
      for (let i = 0; i < t.indexCount; i++) indices[o++] = index[t.indexStart + i] - t.vertexStart + local;
      local += t.vertexCount;
    }
    const colour = copy('color'), normal = copy('normal');
    return { positions: copy('position')!, indices, parts: [...(colour ? [{ array: colour, n: 3, w: COLOUR_WEIGHT }] : []), ...(normal ? [{ array: normal, n: 3, w: NORMAL_WEIGHT }] : [])] };
  }

  /** A sector's levels have arrived: their local indices back onto the ground's vertices. */
  attach(s: Sector, levels: LodLevel[]): void {
    const back = new Uint32Array(s.tiles.reduce((a, t) => a + t.vertexCount, 0));
    let o = 0;
    for (const t of s.tiles) for (let v = 0; v < t.vertexCount; v++) back[o++] = t.vertexStart + v;
    s.levels = levels.map(({ index, error, triangles }) => {
      const global = new Uint32Array(index.length);
      for (let i = 0; i < index.length; i++) global[i] = back[index[i]];
      return { geometry: this.share(new THREE.BufferAttribute(global, 1), s.box), error, triangles };
    });
  }

  /** Once a frame, before the draw: starts the next sectors' levels, and gives each sector its level for `camera`. */
  update(camera: THREE.PerspectiveCamera, viewHeight: number): void {
    const t0 = performance.now();
    for (const s of this.sectors) {
      if (this.inFlight >= this.concurrent) break;
      if (s.levels || s.pending) continue;
      s.pending = true;
      this.inFlight++;
      this.levels(this.input(s))
        .then((levels) => this.attach(s, levels), () => (s.levels = []))
        .finally(() => ((s.pending = false), this.inFlight--));
    }
    const cam = camera.position, pxPerMetre = viewHeight / (2 * Math.tan((camera.fov * Math.PI) / 360)) * (camera.zoom || 1);
    let ready = 0, coarser = 0, tris = 0, full = 0;
    for (const s of this.sectors) {
      full += s.triangles;
      let pick: Level | null = null;
      const d = s.box.distanceToPoint(this.at.copy(cam));
      if (s.levels?.length) {
        ready++;
        const allowed = (this.opts.maxErrorPx * d) / pxPerMetre;
        if (d > 0) for (const l of s.levels) if (l.error <= allowed) pick = l; else break;
      }
      s.mesh.geometry = pick?.geometry ?? s.full;
      if (pick) coarser++;
      tris += pick?.triangles ?? s.triangles;
    }
    Object.assign(this.stats, { sectors: this.sectors.length, ready, coarser, triangles: tris, fullTriangles: full, cpuMs: performance.now() - t0 });
  }

  /** Back to the one ground-wide mesh. */
  dispose(): void {
    this.group.removeFromParent();
    for (const s of this.sectors) for (const l of s.levels ?? []) l.geometry.dispose();
    this.terrain.visible = true;
  }
}

/** Levels from a worker (lod.worker.ts): resolves null when it cannot start (no Worker, or no WebAssembly). */
export function workerLevels(make: () => Worker, timeoutMs = 15_000): Promise<Levels | null> {
  let worker: Worker;
  try {
    worker = make();
  } catch {
    return Promise.resolve(null);
  }
  const waiting = new Map<number, { ok: (l: LodLevel[]) => void; no: (e: Error) => void }>();
  let next = 1, dead: Error | null = null;
  return new Promise((resolve) => {
    const fail = (e: Error) => {
      dead = e;
      for (const w of waiting.values()) w.no(e);
      waiting.clear();
      worker.terminate();
      resolve(null);
    };
    const timer = setTimeout(() => fail(new Error('LOD worker startup timed out')), timeoutMs);
    worker.onerror = () => fail(new Error('LOD worker failed'));
    worker.onmessage = (ev: MessageEvent<{ id: number; ready?: boolean; levels?: LodLevel[]; error?: string }>) => {
      const { id, levels, error } = ev.data;
      if (id === 0) {
        clearTimeout(timer);
        if (!ev.data.ready) return fail(new Error('simplifier unavailable'));
        return resolve((input) => {
          if (dead) return Promise.reject(dead);
          const k = next++;
          return new Promise<LodLevel[]>((ok, no) => {
            waiting.set(k, { ok, no });
            worker.postMessage({ id: k, input }, [input.positions.buffer, input.indices.buffer, ...input.parts.map((p) => p.array.buffer)]);
          });
        });
      }
      const w = waiting.get(id);
      waiting.delete(id);
      if (levels) w?.ok(levels);
      else w?.no(new Error(error ?? 'LOD worker failed'));
    };
    worker.postMessage({ id: 0 });
  });
}
