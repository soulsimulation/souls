// The crowd (V6, #2715): every body in flat typed arrays (where it stands and faces, two clips with their phases and
// rates, a blend, its model and level), drawn as one instanced draw per model per level. Each frame, `draw` walks the
// arrays once: culls a body against the view, picks its level by distance, and writes its sixteen-float root matrix and
// six animation floats into that draw's buffers. No object, mixer or bone tree per body; the GPU skins from the bake.
// Only level 0 (the nearest bodies) casts shadows. `live` is a second bone texture, a row per body for the nearest
// LIVE_ROWS that V7 poses itself; a body given a row (`setLive`) is drawn from it.
import * as THREE from 'three';
import type { BakedModel } from './bake.ts';
import { crowdMaterial, MAX_CLIPS, type CrowdUniforms } from './shader.ts';

/** Level by distance from the camera, metres: under the first is level 0, under the second level 1, else 2. */
export const LOD_DISTANCES = [18, 55];
export const LIVE_ROWS = 32;
/** A body's bounding sphere for culling: centre this high, this radius. */
const BODY_MID = 0.9, BODY_RADIUS = 1.1;

type Draw = { mesh: THREE.InstancedMesh; parts: THREE.InstancedMesh[]; anim: THREE.InstancedBufferAttribute; mix: THREE.InstancedBufferAttribute };

export class Crowd {
  readonly group = new THREE.Group();
  readonly models: BakedModel[];
  worn: ((hash: string) => Promise<BakedModel>) | null = null;
  readonly bodyLoads = new Map<string, { state: 'loading' | 'ready' | 'unavailable'; model?: number; reason?: string }>();
  ready: Uint8Array;
  /** The per-body bone texture V7 fills: a row per body, three texels per bone, as the bake's rows. */
  readonly live: THREE.DataTexture;
  count = 0;
  private cap: number;
  x: Float32Array; y: Float32Array; z: Float32Array; yaw: Float32Array;
  clipA: Uint8Array; phaseA: Float32Array; rateA: Float32Array;
  clipB: Uint8Array; phaseB: Float32Array; rateB: Float32Array;
  blend: Float32Array; model: Uint32Array; lod: Uint8Array; liveRow: Int16Array;
  /** [model][level] */
  private draws: Draw[][];
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  /** What the last `draw` did. */
  stats = { bodies: 0, visible: 0, byLevel: [0, 0, 0], draws: 0 };

  constructor(models: BakedModel[], capacity = 1024) {
    this.models = models;
    this.cap = capacity;
    this.x = new Float32Array(capacity); this.y = new Float32Array(capacity); this.z = new Float32Array(capacity);
    this.yaw = new Float32Array(capacity);
    this.clipA = new Uint8Array(capacity); this.phaseA = new Float32Array(capacity); this.rateA = new Float32Array(capacity);
    this.clipB = new Uint8Array(capacity); this.phaseB = new Float32Array(capacity); this.rateB = new Float32Array(capacity);
    this.ready = new Uint8Array(capacity).fill(1);
    this.blend = new Float32Array(capacity); this.model = new Uint32Array(capacity); this.lod = new Uint8Array(capacity);
    this.liveRow = new Int16Array(capacity).fill(-1);
    const bones = Math.max(...models.map((m) => m.bones));
    this.live = new THREE.DataTexture(new Float32Array(bones * 3 * LIVE_ROWS * 4), bones * 3, LIVE_ROWS, THREE.RGBAFormat, THREE.FloatType);
    this.live.minFilter = this.live.magFilter = THREE.NearestFilter;
    this.live.needsUpdate = true;
    this.draws = models.map((m) => this.makeDraws(m, capacity));
  }

  private makeDraws(m: BakedModel, cap: number): Draw[] {
    if (m.clips.length > MAX_CLIPS) throw new Error(`${m.name}: more than ${MAX_CLIPS} clips`);
    const pad = (a: number[]) => [...a, ...new Array(MAX_CLIPS - a.length).fill(0)];
    const uniforms: CrowdUniforms = {
      uBake: { value: m.bake }, uLive: { value: this.live },
      uClipStart: { value: pad(m.clips.map((c) => c.start)) }, uClipFrames: { value: pad(m.clips.map((c) => c.frames)) },
    };
    return m.lods.map((g, level) => {
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const mix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
      const groups = m.sourceMaterials && g.groups.length ? g.groups : [{ start: 0, count: g.index?.count ?? g.getAttribute('position').count, materialIndex: 0 }];
      const parts = groups.map((group) => {
        const source = m.sourceMaterials?.[group.materialIndex ?? 0];
        if (m.sourceMaterials && !source) throw new Error('body.material-missing');
        const geo = g.clone(); geo.clearGroups(); geo.setDrawRange(group.start, group.count);
        geo.setAttribute('aAnim', anim); geo.setAttribute('aMix', mix);
        const material = source?.clone() ?? new THREE.MeshLambertMaterial();
        if ('vertexColors' in material) material.vertexColors = true;
        const skin = source as THREE.MeshStandardMaterial | undefined;
        const depth = crowdMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: skin?.map, alphaMap: skin?.alphaMap, alphaTest: source?.alphaTest ?? 0, side: source?.side ?? THREE.FrontSide }), uniforms, true);
        const mesh = new THREE.InstancedMesh(geo, crowdMaterial(material, uniforms), cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = 0; mesh.frustumCulled = false;
        mesh.castShadow = level === 0; mesh.customDepthMaterial = depth; mesh.name = `crowd ${m.name} level ${level}`;
        this.group.add(mesh); return mesh;
      });
      for (const mesh of parts.slice(1)) mesh.instanceMatrix = parts[0].instanceMatrix;
      return { mesh: parts[0], parts, anim, mix };
    });
  }

  /** One model/material batch per level, retained by content hash. No body owns a scene hierarchy. */
  addModel(m: BakedModel): number {
    const width = m.bones * 3, old = this.live.image;
    if (width > old.width) {
      const data = new Float32Array(width * LIVE_ROWS * 4);
      for (let row = 0; row < LIVE_ROWS; row++) data.set((old.data as Float32Array).subarray(row * old.width * 4, (row + 1) * old.width * 4), row * width * 4);
      this.live.image = { data, width, height: LIVE_ROWS }; this.live.needsUpdate = true;
    }
    const index = this.models.length; this.models.push(m); this.draws.push(this.makeDraws(m, this.cap)); return index;
  }

  /** Adds a body of `model` and returns its index; indices stay put until `remove` moves the last body into a hole. */
  add(model: number): number {
    if (this.count === this.cap) this.grow();
    const i = this.count++;
    this.model[i] = model; this.ready[i] = 1;
    this.clipA[i] = this.clipB[i] = 0;
    this.phaseA[i] = this.phaseB[i] = this.rateA[i] = this.rateB[i] = this.blend[i] = 0;
    this.liveRow[i] = -1;
    return i;
  }

  /** Removes body `i` by moving the last body into its place; returns the old index of the body moved (or -1). */
  remove(i: number): number {
    const last = --this.count;
    if (i === last) return -1;
    for (const a of [this.x, this.y, this.z, this.yaw, this.clipA, this.phaseA, this.rateA, this.clipB, this.phaseB, this.rateB, this.blend, this.model, this.lod, this.liveRow, this.ready]) a[i] = a[last];
    return last;
  }

  /** Gives body `i` a row of the live texture (V7), or takes it away with -1. */
  setLive(i: number, row: number): void {
    this.liveRow[i] = row;
  }

  private grow(): void {
    const cap = this.cap * 2;
    const g = <T extends Float32Array | Uint8Array | Uint32Array | Int16Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(cap);
      b.set(a);
      return b;
    };
    this.x = g(this.x); this.y = g(this.y); this.z = g(this.z); this.yaw = g(this.yaw);
    this.clipA = g(this.clipA); this.phaseA = g(this.phaseA); this.rateA = g(this.rateA);
    this.clipB = g(this.clipB); this.phaseB = g(this.phaseB); this.rateB = g(this.rateB);
    this.ready = g(this.ready);
    this.blend = g(this.blend); this.model = g(this.model); this.lod = g(this.lod); this.liveRow = g(this.liveRow);
    for (const d of this.draws.flat()) {
      for (const mesh of d.parts) {
        this.group.remove(mesh); mesh.dispose(); mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose(); mesh.customDepthMaterial?.dispose();
      }
    }
    this.cap = cap;
    this.draws = this.models.map((m) => this.makeDraws(m, cap));
  }

  /** Advances every phase by its rate (cycles a second) over `dt` seconds. */
  step(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      this.phaseA[i] = (this.phaseA[i] + this.rateA[i] * dt) % 1;
      this.phaseB[i] = (this.phaseB[i] + this.rateB[i] * dt) % 1;
    }
  }

  /** Fills the draws for `camera`'s view. */
  draw(camera: THREE.Camera): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cx = camera.matrixWorld.elements[12], cy = camera.matrixWorld.elements[13], cz = camera.matrixWorld.elements[14];
    const n0 = LOD_DISTANCES[0] ** 2, n1 = LOD_DISTANCES[1] ** 2;
    const fill = this.draws.map((levels) => levels.map(() => 0));
    const byLevel = [0, 0, 0];
    const s = this.sphere;
    s.radius = BODY_RADIUS;
    for (let i = 0; i < this.count; i++) {
      if (!this.ready[i]) continue;
      const x = this.x[i], y = this.y[i], z = this.z[i];
      const model = this.models[this.model[i]];
      s.center.set(x, y + (model.centerY ?? BODY_MID), z);
      s.radius = model.radius === undefined ? BODY_RADIUS : Math.hypot(model.radius, model.height / 2);
      if (!this.frustum.intersectsSphere(s)) continue;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
      const level = d2 < n0 ? 0 : d2 < n1 ? 1 : 2;
      this.lod[i] = level;
      byLevel[level]++;
      const m = this.model[i];
      const d = this.draws[m][level];
      const k = fill[m][level]++;
      const c = Math.cos(this.yaw[i]), sn = Math.sin(this.yaw[i]);
      const e = d.mesh.instanceMatrix.array as Float32Array, o = k * 16;
      e[o] = c; e[o + 1] = 0; e[o + 2] = -sn; e[o + 3] = 0;
      e[o + 4] = 0; e[o + 5] = 1; e[o + 6] = 0; e[o + 7] = 0;
      e[o + 8] = sn; e[o + 9] = 0; e[o + 10] = c; e[o + 11] = 0;
      e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
      const a = d.anim.array as Float32Array, b = d.mix.array as Float32Array;
      a[k * 4] = this.clipA[i]; a[k * 4 + 1] = this.phaseA[i]; a[k * 4 + 2] = this.clipB[i]; a[k * 4 + 3] = this.phaseB[i];
      b[k * 2] = this.blend[i]; b[k * 2 + 1] = this.liveRow[i];
    }
    let draws = 0;
    this.draws.forEach((levels, m) => levels.forEach((d, level) => {
      const n = fill[m][level];
      for (const mesh of d.parts) { mesh.count = n; mesh.visible = n > 0; }
      if (!n) return;
      draws += d.parts.length;
      d.mesh.instanceMatrix.clearUpdateRanges();
      d.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      d.mesh.instanceMatrix.needsUpdate = true;
      d.anim.clearUpdateRanges();
      d.anim.addUpdateRange(0, n * 4);
      d.anim.needsUpdate = true;
      d.mix.clearUpdateRanges();
      d.mix.addUpdateRange(0, n * 2);
      d.mix.needsUpdate = true;
    }));
    this.stats = { bodies: this.count, visible: byLevel[0] + byLevel[1] + byLevel[2], byLevel, draws };
  }

  /** The clip index of `name` in model `m`, or -1. */
  clip(m: number, name: string): number {
    return this.models[m].clips.findIndex((c) => c.name === name);
  }
}
