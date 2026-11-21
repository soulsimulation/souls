// Things drawn from their kinds' models (V8, #2718). There is no object per thing: a table maps each thing to its
// slots, (batch, index) for each part of its model. A model many things share is drawn as one instanced draw per part;
// the rest (one-off shapes) go into one `BatchedMesh` per material. A thing whose model has not arrived is a box in
// one instanced draw until it does; models load nearest the camera first. State is per-instance data: switching a
// light writes its glow parts' colour slots and nothing else, so it uploads a few bytes and no geometry.
import * as THREE from 'three';
import { glowOf, partsOf, type ModelIndex, type Part } from './models.ts';

/** A model shared by at least this many things in the index is instanced; the rest are batched by material. */
export const SHARED = 8;
/** Models fetched at once. */
const LOADING = 6;
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const OFF = new THREE.Color(0.22, 0.22, 0.22), ON = new THREE.Color(1, 1, 1), WHITE = new THREE.Color(1, 1, 1);

/** Where one part of one thing is drawn. */
type Slot = { batch: Batch; index: number; glow: boolean; flame?: THREE.Matrix4 };
type Thing = { id: string; model: string | null; matrix: THREE.Matrix4; boxes: THREE.Matrix4[]; slots: Slot[]; on: boolean };

/** An instanced draw whose instances are packed: removing one moves the last into its place. */
class Batch {
  mesh: THREE.InstancedMesh;
  owners: Slot[] = [];
  /** A whole upload of the colours is pending (an add or a remove); a light's one slot then rides on it. */
  private whole = false;
  readonly layer: ThingLayer;
  constructor(layer: ThingLayer, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.layer = layer;
    this.mesh = this.make(geometry, material, Math.max(16, capacity));
  }
  private make(g: THREE.BufferGeometry, m: THREE.Material, n: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(g, m, n);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    mesh.onAfterRender = () => void (this.whole = false);
    this.layer.group.add(mesh);
    return mesh;
  }
  add(slot: Slot, matrix: THREE.Matrix4, color: THREE.Color): number {
    if (this.mesh.count === this.mesh.instanceMatrix.count) {
      const old = this.mesh, grown = this.make(old.geometry, old.material as THREE.Material, old.count * 2);
      grown.instanceMatrix.array.set(old.instanceMatrix.array);
      grown.instanceColor!.array.set(old.instanceColor!.array);
      grown.count = old.count;
      this.layer.group.remove(old);
      old.dispose();
      this.mesh = grown;
    }
    const i = this.mesh.count++;
    this.owners[i] = slot;
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.setColorAt(i, color);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.wholeColours();
    return i;
  }
  remove(i: number): void {
    const last = --this.mesh.count, m = new THREE.Matrix4(), c = new THREE.Color();
    if (i !== last) {
      this.mesh.getMatrixAt(last, m);
      this.mesh.getColorAt(last, c);
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, c);
      this.owners[i] = this.owners[last];
      this.owners[i].index = i;
    }
    this.owners.length = last;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.wholeColours();
  }
  private wholeColours(): void {
    this.whole = true;
    this.mesh.instanceColor!.clearUpdateRanges();
    this.mesh.instanceColor!.needsUpdate = true;
  }
  /** Writes one instance's colour and uploads only that slot. */
  color(i: number, c: THREE.Color): void {
    const a = this.mesh.instanceColor!;
    a.setXYZ(i, c.r, c.g, c.b);
    if (!this.whole) a.addUpdateRange(i * 3, 3);
    a.needsUpdate = true;
  }
}

/** One-off shapes sharing a material: one `BatchedMesh`, its geometries added once per model part. */
class Shapes {
  mesh: THREE.BatchedMesh;
  geometries = new Map<THREE.BufferGeometry, number>();
  /** The batch's room for vertices and indices (it grows by doubling). */
  private room = [65_536, 131_072];
  constructor(layer: ThingLayer, material: THREE.Material) {
    this.mesh = new THREE.BatchedMesh(256, this.room[0], this.room[1], material);
    // Culling and sorting every instance on the CPU each frame costs more than drawing them (the issue's footgun).
    this.mesh.perObjectFrustumCulled = false;
    this.mesh.sortObjects = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    layer.group.add(this.mesh);
  }
  add(g: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.Color): number {
    let id = this.geometries.get(g);
    if (id === undefined) {
      const v = g.getAttribute('position').count, n = g.index!.count, m = this.mesh;
      if (m.unusedVertexCount < v || m.unusedIndexCount < n) {
        const used = [this.room[0] - m.unusedVertexCount, this.room[1] - m.unusedIndexCount];
        this.room = [Math.max(used[0] + v, this.room[0] * 2), Math.max(used[1] + n, this.room[1] * 2)];
        m.setGeometrySize(this.room[0], this.room[1]);
      }
      id = m.addGeometry(g);
      this.geometries.set(g, id);
    }
    if (this.mesh.instanceCount >= this.mesh.maxInstanceCount) this.mesh.setInstanceCount(this.mesh.maxInstanceCount * 2);
    const i = this.mesh.addInstance(id);
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.setColorAt(i, color);
    return i;
  }
}

export type ThingLayerOptions = {
  index: ModelIndex;
  /** Fetches a model's glTF bytes by hash. */
  fetch: (hash: string) => Promise<ArrayBuffer>;
  /** Each thing drawn this many times, each copy `spacing` metres further along x (V8's measure: Eden doubled). */
  copies?: number;
  spacing?: number;
};

export class ThingLayer {
  readonly group = new THREE.Group();
  readonly things = new Map<string, Thing>();
  private readonly boxes: Batch;
  private readonly instanced = new Map<string, Batch[]>();
  private readonly batched = new Map<THREE.Material, Shapes>();
  private readonly users = new Map<string, Set<Thing>>();
  private readonly models = new Map<string, Part[]>();
  private readonly pending = new Set<string>();
  private loading = 0;
  private readonly share = new Map<string, number>();
  readonly copies: number;
  spacing: number;
  /** Models loaded, and those that failed (drawn as boxes for good). */
  loaded = 0;
  failed = 0;

  readonly opts: ThingLayerOptions;
  constructor(opts: ThingLayerOptions) {
    this.opts = opts;
    this.copies = opts.copies ?? 1;
    this.spacing = opts.spacing ?? 0;
    for (const h of Object.values(opts.index.things)) this.share.set(h, (this.share.get(h) ?? 0) + 1);
    this.boxes = new Batch(this, new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: 0xb8b2a6 }), 1024);
  }

  /** Places (or moves) a thing: its frame in the world, its origin (today's id), and its boxes (one or a box a solid)
   *  until its model, or for good when it has none. */
  set(id: string, origin: string | null, frame: THREE.Matrix4, box: THREE.Matrix4 | THREE.Matrix4[] | null): void {
    const model = origin ? this.opts.index.things[origin] ?? null : null;
    const boxes = box === null ? [] : Array.isArray(box) ? box : [box];
    if (!model && !boxes.length) return this.remove(id);
    for (let c = 0; c < this.copies; c++) {
      const cid = c ? `${id}#${c}` : id;
      const matrix = c ? new THREE.Matrix4().makeTranslation(c * this.spacing, 0, 0).multiply(frame) : frame.clone();
      const old = this.things.get(cid);
      if (old && old.model === model && old.matrix.equals(matrix)) continue;
      if (old) this.remove(cid, true);
      const t: Thing = { id: cid, model, matrix, boxes: boxes.map((b) => matrix.clone().multiply(b)), slots: [], on: old?.on ?? false };
      this.things.set(cid, t);
      if (model) (this.users.get(model) ?? this.users.set(model, new Set()).get(model)!).add(t);
      this.draw(t);
    }
  }

  remove(id: string, oneCopy = false): void {
    for (let c = 0; c < (oneCopy ? 1 : this.copies); c++) {
      const cid = c && !oneCopy ? `${id}#${c}` : id;
      const t = this.things.get(cid);
      if (!t) continue;
      this.clear(t);
      this.things.delete(cid);
      if (t.model) this.users.get(t.model)?.delete(t);
    }
  }

  /** Switches a thing's light (its kind's `on`/`lit` parts): one colour slot per glow part, nothing else. */
  light(id: string, on: boolean): number {
    const t = this.things.get(id);
    if (!t) return 0;
    t.on = on;
    let n = 0;
    for (const s of t.slots) if (s.glow) {
      s.batch.color(s.index, on ? ON : OFF);
      n++;
    }
    return n;
  }

  private readonly flamesHidden = new Set<string>();
  /** Hides or shows a thing's static flame parts while its animated fire draws (fx/layer.ts), as today's flames do. */
  standIns(id: string, shown: boolean): void {
    if (shown) this.flamesHidden.delete(id); else this.flamesHidden.add(id);
    for (const s of this.things.get(id)?.slots ?? []) if (s.flame) {
      if (s.batch instanceof Batch) (s.batch.mesh.setMatrixAt(s.index, shown ? s.flame : HIDDEN), (s.batch.mesh.instanceMatrix.needsUpdate = true));
      else (s.batch as unknown as Shapes).mesh.setVisibleAt(s.index, shown);
    }
  }

  private clear(t: Thing): void {
    for (const s of t.slots) {
      if (s.batch instanceof Batch) s.batch.remove(s.index);
      else (s.batch as unknown as Shapes).mesh.deleteInstance(s.index);
    }
    t.slots = [];
  }

  /** Draws a thing from its model when it has arrived, as a box otherwise. */
  private draw(t: Thing): void {
    const parts = t.model ? this.models.get(t.model) : undefined;
    if (!parts) {
      if (t.model && !this.pending.has(t.model) && !this.models.has(t.model)) this.pending.add(t.model);
      for (const b of t.boxes) {
        const s: Slot = { batch: this.boxes, index: 0, glow: false };
        s.index = this.boxes.add(s, b, WHITE);
        t.slots.push(s);
      }
      return;
    }
    const shared = (this.share.get(t.model!) ?? 0) >= SHARED;
    const m = new THREE.Matrix4();
    parts.forEach((p, k) => {
      m.multiplyMatrices(t.matrix, p.matrix);
      const color = p.glow ? (t.on ? ON : OFF) : WHITE;
      if (shared) {
        const batches = this.instanced.get(t.model!) ?? this.instanced.set(t.model!, parts.map((q) => new Batch(this, q.geometry, q.material, (this.share.get(t.model!) ?? 1) * this.copies))).get(t.model!)!;
        const s: Slot = { batch: batches[k], index: 0, glow: p.glow, ...(p.flame ? { flame: m.clone() } : {}) };
        s.index = batches[k].add(s, m, color);
        t.slots.push(s);
      } else {
        const shapes = this.batched.get(p.material) ?? this.batched.set(p.material, new Shapes(this, p.material)).get(p.material)!;
        t.slots.push({ batch: shapes as unknown as Batch, index: shapes.add(p.geometry, m, color), glow: p.glow, ...(p.flame ? { flame: m.clone() } : {}) });
      }
    });
    if (this.flamesHidden.has(t.id)) this.standIns(t.id, false); // a model arriving under a burning fire
  }

  /** A model has arrived: its things leave their boxes for it. */
  arrive(hash: string, parts: Part[]): void {
    this.pending.delete(hash);
    this.models.set(hash, parts);
    this.loaded++;
    for (const t of this.users.get(hash) ?? []) {
      this.clear(t);
      this.draw(t);
    }
  }

  /** Starts loading the pending models nearest `eye`, a few at a time. Call once a frame. */
  update(eye: THREE.Vector3): void {
    while (this.loading < LOADING && this.pending.size) {
      let best: string | null = null, near = Infinity;
      const p = new THREE.Vector3();
      for (const h of this.pending) for (const t of this.users.get(h) ?? []) {
        const d = p.setFromMatrixPosition(t.matrix).distanceToSquared(eye);
        if (d < near) [best, near] = [h, d];
      }
      if (!best) break;
      this.pending.delete(best);
      this.loading++;
      const glow = glowOf(this.opts.index.states.get(best));
      this.opts.fetch(best)
        .then((bytes) => partsOf(bytes, glow.roles, glow.materials))
        .then((parts) => this.arrive(best, parts))
        .catch(() => (this.failed++, this.models.set(best, [])))
        .finally(() => this.loading--);
    }
  }

  /** The draws this layer makes, for the measure: instanced batches, material batches and the boxes. */
  get draws(): number {
    let n = this.boxes.mesh.count ? 1 : 0;
    for (const bs of this.instanced.values()) for (const b of bs) if (b.mesh.count) n++;
    for (const s of this.batched.values()) if (s.mesh.instanceCount) n++;
    return n;
  }

  /** Every model asked for has arrived or failed. */
  get settled(): boolean {
    return this.loading === 0 && this.pending.size === 0;
  }

  /** How many things are boxes: waiting for their model, or with none (V17's list: drapes, stored files). */
  get waiting(): number {
    return this.boxes.mesh.count;
  }
}
