// Things drawn from their kinds' models (V8, #2718). There is no object per thing: a table maps each thing to its
// slots, (batch, index) for each part of its model. A model many things share is drawn as one instanced draw per part;
// the rest (one-off shapes) go into one `BatchedMesh` per material. A thing whose model has not arrived is a box in
// one instanced draw until it does; models load nearest the camera first. State is per-instance data: switching a
// light writes its glow parts' colour slots and nothing else, so it uploads a few bytes and no geometry.
import * as THREE from 'three';
import { glowOf, partsOf, type ModelIndex, type Part } from './models.ts';
import { NO_CUT, above, buildingView, cutHeight, decide, hidden, sameCut, type BuildingView, type Cut, type Storey } from './interior.ts';

/** A model shared by at least this many things in the index is instanced; the rest are batched by material. */
export const SHARED = 8;
/** Models fetched at once. */
const LOADING = 6;
const OFF = new THREE.Color(0.22, 0.22, 0.22), ON = new THREE.Color(1, 1, 1), WHITE = new THREE.Color(1, 1, 1);

/** Where one part of one thing is drawn, at `matrix` in the world; `storey`: a building's part (C10). */
type Slot = { batch: Batch; index: number; glow: boolean; matrix: THREE.Matrix4; storey?: Storey };
/** `view` and `cut`: a generated building's interior view and its decision; `under`: hidden by a building's cut (the
 *  furniture of the storeys it hides). */
type Thing = { id: string; model: string | null; matrix: THREE.Matrix4; boxes: THREE.Matrix4[]; slots: Slot[]; on: boolean; inverse?: THREE.Matrix4[]; view?: BuildingView; cut?: Cut; under?: string };
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** What a ray meets first among the things (N-V20 hover): the thing's id (a copy's `#n` dropped), how far along the
 *  ray, where its box stands (the middle of the box's base) and the box's half width on the ground. */
export type ThingHit = { id: string; distance: number; foot: THREE.Vector3; radius: number };

/** Where a ray (`origin + k * dir`) enters the unit box (x and z from -0.5 to 0.5, y from 0 to 1), or null. */
export function rayUnitBox(o: THREE.Vector3, d: THREE.Vector3): number | null {
  let near = 0, far = Infinity;
  const lo = [-0.5, 0, -0.5], hi = [0.5, 1, 0.5], oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(da[a]) < 1e-12) {
      if (oa[a] < lo[a] || oa[a] > hi[a]) return null;
      continue;
    }
    let k0 = (lo[a] - oa[a]) / da[a], k1 = (hi[a] - oa[a]) / da[a];
    if (k0 > k1) [k0, k1] = [k1, k0];
    near = Math.max(near, k0);
    far = Math.min(far, k1);
    if (near > far) return null;
  }
  return near;
}

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
  /** Shows or hides one instance (an instanced draw has no visibility of its own: a hidden one is scaled to nothing). */
  show(i: number, matrix: THREE.Matrix4, on: boolean): void {
    this.mesh.setMatrixAt(i, on ? matrix : ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
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
  /** Today's `?hideRoofs=1` (every roof off) and `cut=<floor>` (with it, the storeys above that floor too). */
  hideRoofs?: boolean;
  cut?: number | null;
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
  /** The generated buildings drawn from their models, for the interior view. */
  private readonly buildings = new Set<Thing>();
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
      if (t.view) this.uncut(t);
      this.buildings.delete(t);
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

  /** Shows or hides every part of a thing that its own storey does not hide. */
  private show(t: Thing, on: boolean): void {
    for (const s of t.slots) {
      const visible = on && !(t.view && s.storey && hidden(s.storey, t.cut ?? NO_CUT, t.view.floors));
      if (s.batch instanceof Batch) s.batch.show(s.index, s.matrix, visible);
      else (s.batch as unknown as Shapes).mesh.setVisibleAt(s.index, visible);
    }
  }

  /** C10, today's interior view: each building decides for the camera at `eye`; a changed decision shows or hides its
   *  roof and storeys and the things standing on the storeys it hides. */
  interior(eye: THREE.Vector3): number {
    let changed = 0;
    for (const b of this.buildings) {
      const c = decide(b.view!, eye, this.opts.hideRoofs, this.opts.cut ?? null);
      if (sameCut(c, b.cut ?? NO_CUT)) continue;
      changed++;
      b.cut = c;
      this.show(b, true);
      this.uncut(b);
      const y = cutHeight(b.view!, c);
      if (y === Infinity) continue;
      const p = new THREE.Vector3();
      for (const t of this.things.values()) {
        if (t === b || t.view || t.under || !above(b.view!, p.setFromMatrixPosition(t.matrix), y)) continue;
        t.under = b.id;
        this.show(t, false);
      }
    }
    return changed;
  }

  /** Shows again what a building's cut hid. */
  private uncut(b: Thing): void {
    for (const t of this.things.values()) if (t.under === b.id) (t.under = undefined, this.show(t, true));
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
        const s: Slot = { batch: this.boxes, index: 0, glow: false, matrix: b };
        s.index = this.boxes.add(s, b, WHITE);
        t.slots.push(s);
      }
      if (t.under) this.show(t, false);
      return;
    }
    // A building is batched whatever its share, so each one's storeys show and hide on their own (C10).
    const view = buildingView(parts, t.matrix);
    if (view) (t.view = view, this.buildings.add(t));
    const shared = !view && (this.share.get(t.model!) ?? 0) >= SHARED;
    parts.forEach((p, k) => {
      const m = new THREE.Matrix4().multiplyMatrices(t.matrix, p.matrix);
      const color = p.glow ? (t.on ? ON : OFF) : WHITE;
      if (shared) {
        const batches = this.instanced.get(t.model!) ?? this.instanced.set(t.model!, parts.map((q) => new Batch(this, q.geometry, q.material, (this.share.get(t.model!) ?? 1) * this.copies))).get(t.model!)!;
        const s: Slot = { batch: batches[k], index: 0, glow: p.glow, matrix: m };
        s.index = batches[k].add(s, m, color);
        t.slots.push(s);
      } else {
        const shapes = this.batched.get(p.material) ?? this.batched.set(p.material, new Shapes(this, p.material)).get(p.material)!;
        t.slots.push({ batch: shapes as unknown as Batch, index: shapes.add(p.geometry, m, color), glow: p.glow, matrix: m, ...(p.storey ? { storey: p.storey } : {}) });
      }
    });
    if (t.under || t.cut) this.show(t, !t.under);
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

  /** Starts loading the pending models nearest `eye`, a few at a time, and decides the interior view. Call once a frame. */
  update(eye: THREE.Vector3): void {
    this.interior(eye);
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

  /** The thing a ray meets first within `far` metres, from the boxes each thing stands in (its model's bounds, or its
   *  solids): read-only, nothing drawn changes. Each box's inverse is kept with the thing until the thing moves. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, far = Infinity): ThingHit | null {
    let best: Thing | null = null, box = -1, near = far;
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    for (const t of this.things.values()) {
      const inv = (t.inverse ??= t.boxes.map((b) => b.clone().invert()));
      for (let k = 0; k < inv.length; k++) {
        // The ray in the box's own space: its distance along the ray stays the same (an affine map keeps ratios).
        o.copy(origin).applyMatrix4(inv[k]);
        d.copy(origin).add(dir).applyMatrix4(inv[k]).sub(o);
        const hit = rayUnitBox(o, d);
        if (hit !== null && hit < near) [best, box, near] = [t, k, hit];
      }
    }
    if (!best) return null;
    const m = best.boxes[box], e = m.elements;
    const foot = new THREE.Vector3().applyMatrix4(m);
    const radius = Math.hypot(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[8], e[9], e[10])) / 2;
    return { id: best.id.split('#')[0], distance: near, foot, radius };
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
