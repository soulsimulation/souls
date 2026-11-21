// Things drawn from their kinds' models (V8, #2718). There is no object per thing: a table maps each thing to its
// slots, (batch, index) for each part of its model. A model many things share is drawn as one instanced draw per part;
// the rest (one-off shapes) go into one `BatchedMesh` per material. A thing whose model has not arrived is a box in
// one instanced draw until it does; models load nearest the camera first. State is per-instance data: switching a
// light writes its glow parts' colour slots and nothing else, so it uploads a few bytes and no geometry.
//
// Distance detail (C12, #3683), today's WorldDistanceDetail rules per part: a part whose bounding sphere would be
// smaller than `minRadiusPx` CSS pixels of radius is not drawn, and a small part farther than `shadowNear +
// shadowPerMetre·radius` metres is drawn into the same model's batch that casts no shadow (instanced models; a one-off
// shape keeps its shadow). A building's window frames
// and fittings go first, its walls last, as today. A part moves between its batches (near, far, hidden) only when the
// eye has moved or things changed, with a margin so it does not flicker at the line.
import * as THREE from 'three';
import { glowOf, partsOf, type ModelIndex, type Part } from './models.ts';
import { pageDetail, type DistanceDetail } from '../draw/quality-tier.ts';

/** A model shared by at least this many things in the index is instanced; the rest are batched by material. */
export const SHARED = 8;
/** Models fetched at once. */
const LOADING = 6;
const OFF = new THREE.Color(0.22, 0.22, 0.22), ON = new THREE.Color(1, 1, 1), WHITE = new THREE.Color(1, 1, 1);

/** A part's detail band: drawn and casting, drawn without a shadow, or not drawn. */
export const NEAR = 0, FAR = 1, HIDDEN = 2;
/** The eye moves this far (m) before parts are sorted into bands again; and they are, at least every PASS_FRAMES. */
const MOVE = 1, PASS_FRAMES = 60, MIN_GAP = 4;
/** Parts sorted a frame: a pass over Eden's ~10,000 parts is spread over a few frames (about 7 ms at once on a laptop,
 *  four times that on a phone). */
const PER_FRAME = 2500;
/** Where one part of one thing is drawn: its batch and index (null and -1 while hidden), and what it needs to be
 *  drawn again: its geometry, material and matrix, and its world sphere for the bands. */
type Slot = {
  batch: Batch | null; index: number; glow: boolean; band: number;
  part: Part | null; matrix: THREE.Matrix4; centre: THREE.Vector3; radius: number;
  /** Its thing; `gone` once the thing has left or been redrawn. */
  thing: Thing; gone: boolean;
};
type Thing = { id: string; model: string | null; matrix: THREE.Matrix4; boxes: THREE.Matrix4[]; slots: Slot[]; on: boolean };

/** An instanced draw whose instances are packed: removing one moves the last into its place. */
class Batch {
  mesh: THREE.InstancedMesh;
  owners: Slot[] = [];
  /** False for a FAR batch: drawn without a shadow (kept when it grows). */
  shadow = true;
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
    mesh.castShadow = this.shadow;
    mesh.receiveShadow = true;
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
  /** A light's colour on a one-off model's glow part (a `Batch` has the same). */
  color(i: number, c: THREE.Color): void {
    this.mesh.setColorAt(i, c);
  }
}

export type ThingLayerOptions = {
  index: ModelIndex;
  /** Fetches a model's glTF bytes by hash. */
  fetch: (hash: string) => Promise<ArrayBuffer>;
  /** Each thing drawn this many times, each copy `spacing` metres further along x (V8's measure: Eden doubled). */
  copies?: number;
  spacing?: number;
  /** C12: distance detail; default the page's tier (`pageDetail`), none outside a browser. */
  detail?: DistanceDetail | null;
  /** The view's height in CSS pixels and vertical field of view in degrees; default the window's and the page camera's 50. */
  view?: () => { height: number; fov: number };
};

export class ThingLayer {
  readonly group = new THREE.Group();
  readonly things = new Map<string, Thing>();
  /** Boxes, instanced models and one-off shapes, one set a band: NEAR casts a shadow, FAR does not. */
  private readonly boxes: [Batch, Batch];
  private readonly instanced = [new Map<string, Batch[]>(), new Map<string, Batch[]>()];
  private readonly batched = [new Map<THREE.Material, Shapes>(), new Map<THREE.Material, Shapes>()];
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private boxSlots = 0;
  readonly detail: DistanceDetail | null;
  private eye: THREE.Vector3 | null = null;
  private passEye = new THREE.Vector3();
  private frame = 0;
  private lastPass = -Infinity;
  private changed = false;
  /** Every part, for the passes (rebuilt when things change), and how far the pass under way has got (-1: none). */
  private all: Slot[] = [];
  private allDirty = false;
  private cursor = -1;
  private count = [0, 0, 0];
  private moved = 0;
  private passMs = 0;
  /** The last band pass: parts in each band, parts moved, CPU ms. */
  readonly stats = { near: 0, far: 0, hidden: 0, moved: 0, cpuMs: 0 };
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
    this.detail = opts.detail === undefined ? pageDetail() : opts.detail;
    const boxMaterial = new THREE.MeshLambertMaterial({ color: 0xb8b2a6 });
    this.boxes = [new Batch(this, this.boxGeometry, boxMaterial, 1024), this.far(new Batch(this, this.boxGeometry, boxMaterial, 16))];
  }

  /** A FAR batch: drawn, no shadow. */
  private far<B extends Batch | Shapes>(b: B): B {
    if (b instanceof Batch) b.shadow = false;
    b.mesh.castShadow = false;
    return b;
  }

  /** Pixels per metre at one metre: a sphere of radius r at distance d is r·k/d pixels. */
  private pixels(): number {
    const g = globalThis as { innerHeight?: number };
    const v = this.opts.view?.() ?? { height: g.innerHeight ?? 720, fov: 50 };
    return v.height / (2 * Math.tan((v.fov * Math.PI) / 360));
  }

  /** The band for a part at its sphere, given its band now (a margin keeps it from flickering at the line). */
  private bandOf(s: Slot, k: number): number {
    const o = this.detail, eye = this.eye;
    if (!o || !eye) return NEAR;
    const d = s.centre.distanceTo(eye) - s.radius;
    if (d <= 0) return NEAR;
    const px = (s.radius * k) / d;
    if (px < o.minRadiusPx * (s.band === HIDDEN ? 1.15 : 1)) return HIDDEN;
    const line = o.shadowNear + o.shadowPerMetre * s.radius;
    // A one-off shape stays in its casting batch: a second, shadowless `BatchedMesh` per material stalled the GPU for
    // about 200 ms every few frames on a phone (measured, #3683); only instanced models get the FAR band.
    if (s.part && (this.share.get(s.thing.model!) ?? 0) < SHARED) return NEAR;
    return s.radius < o.shadowMaxRadius && d > line * (s.band === FAR ? 0.95 : 1) ? FAR : NEAR;
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
      s.batch?.color(s.index, on ? ON : OFF);
      n++;
    }
    return n;
  }

  private clear(t: Thing): void {
    for (const s of t.slots) {
      this.unplace(s);
      s.gone = true;
      if (!s.part) this.boxSlots--;
    }
    t.slots = [];
  }

  /** Takes a part out of its batch. */
  private unplace(s: Slot): void {
    if (s.batch instanceof Batch) s.batch.remove(s.index);
    else if (s.batch) (s.batch as unknown as Shapes).mesh.deleteInstance(s.index);
    s.batch = null;
    s.index = -1;
  }

  /** Puts a part into its band's batch (none while hidden). */
  private place(t: Thing, s: Slot): void {
    if (s.band === HIDDEN) return;
    const color = s.glow ? (t.on ? ON : OFF) : WHITE, band = s.band;
    if (!s.part) {
      s.batch = this.boxes[band];
      s.index = this.boxes[band].add(s, s.matrix, color);
      return;
    }
    const parts = this.models.get(t.model!)!, k = parts.indexOf(s.part);
    if ((this.share.get(t.model!) ?? 0) >= SHARED) {
      const all = this.instanced[band];
      const batches = all.get(t.model!) ?? all.set(t.model!, parts.map((q) => {
        const b = new Batch(this, q.geometry, q.material, band === NEAR ? (this.share.get(t.model!) ?? 1) * this.copies : 16);
        return band === NEAR ? b : this.far(b);
      })).get(t.model!)!;
      s.batch = batches[k];
      s.index = batches[k].add(s, s.matrix, color);
    } else {
      const all = this.batched[band];
      const shapes = all.get(s.part.material) ?? all.set(s.part.material, band === NEAR ? new Shapes(this, s.part.material) : this.far(new Shapes(this, s.part.material))).get(s.part.material)!;
      s.batch = shapes as unknown as Batch;
      s.index = shapes.add(s.part.geometry, s.matrix, color);
    }
  }

  /** A new part: its world sphere and band, then its batch. */
  private slot(t: Thing, part: Part | null, matrix: THREE.Matrix4, glow: boolean, k: number): void {
    const g = part?.geometry ?? this.boxGeometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const centre = g.boundingSphere!.center.clone().applyMatrix4(matrix), radius = g.boundingSphere!.radius * matrix.getMaxScaleOnAxis();
    const s: Slot = { batch: null, index: -1, glow, band: NEAR, part, matrix, centre, radius, thing: t, gone: false };
    this.allDirty = true;
    s.band = this.bandOf(s, k);
    if (!part) this.boxSlots++;
    t.slots.push(s);
    this.place(t, s);
  }

  /** Sorts every part into its band for the eye now; moves only those whose band changed. */
  private pass(): void {
    if (this.cursor < 0) {
      if (this.allDirty) {
        this.all = [];
        for (const t of this.things.values()) for (const s of t.slots) this.all.push(s);
        this.allDirty = false;
      }
      this.cursor = 0;
      this.count = [0, 0, 0];
      this.moved = 0;
      this.passMs = 0;
    }
    const t0 = performance.now(), k = this.pixels(), all = this.all, end = Math.min(all.length, this.cursor + PER_FRAME);
    for (let i = this.cursor; i < end; i++) {
      const s = all[i];
      if (s.gone) continue;
      const band = this.bandOf(s, k);
      if (band !== s.band) {
        this.unplace(s);
        s.band = band;
        this.place(s.thing, s);
        this.moved++;
      }
      this.count[s.band]++;
    }
    this.cursor = end;
    this.passMs += performance.now() - t0;
    if (end < all.length) return;
    this.cursor = -1;
    Object.assign(this.stats, { near: this.count[NEAR], far: this.count[FAR], hidden: this.count[HIDDEN], moved: this.moved, cpuMs: this.passMs });
  }

  /** Draws a thing from its model when it has arrived, as a box otherwise. */
  private draw(t: Thing): void {
    const parts = t.model ? this.models.get(t.model) : undefined;
    const k = this.detail && this.eye ? this.pixels() : 0;
    this.changed = true;
    if (!parts) {
      if (t.model && !this.pending.has(t.model) && !this.models.has(t.model)) this.pending.add(t.model);
      for (const b of t.boxes) this.slot(t, null, b, false, k);
      return;
    }
    for (const p of parts) this.slot(t, p, new THREE.Matrix4().multiplyMatrices(t.matrix, p.matrix), p.glow, k);
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
    this.frame++;
    if (this.detail) {
      const first = !this.eye;
      this.eye = (this.eye ?? new THREE.Vector3()).copy(eye);
      const since = this.frame - this.lastPass;
      if (this.cursor >= 0) this.pass();
      else if (first || (since >= MIN_GAP && (this.changed || since >= PASS_FRAMES || this.passEye.distanceTo(eye) > MOVE))) {
        this.passEye.copy(eye);
        this.lastPass = this.frame;
        this.changed = false;
        this.pass();
      }
    }
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
    let n = 0;
    for (const b of this.boxes) if (b.mesh.count) n++;
    for (const m of this.instanced) for (const bs of m.values()) for (const b of bs) if (b.mesh.count) n++;
    for (const m of this.batched) for (const s of m.values()) if (s.mesh.instanceCount) n++;
    return n;
  }

  /** Every model asked for has arrived or failed. */
  get settled(): boolean {
    return this.loading === 0 && this.pending.size === 0;
  }

  /** How many things are boxes: waiting for their model, or with none (V17's list: drapes, stored files). */
  get waiting(): number {
    return this.boxSlots;
  }
}
