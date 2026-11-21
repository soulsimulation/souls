// Things drawn from their kinds' models (V8, #2718). There is no object per thing: a table maps each thing to its
// slots, (batch, index) for each part of its model. A model many things share is drawn as one instanced draw per part;
// the rest (one-off shapes) go into one `BatchedMesh` per material. A thing whose model has not arrived is a box in
// one instanced draw until it does; models load nearest the camera first. State is per-instance data: switching a
// light writes its glow parts' colour slots and nothing else, so it uploads a few bytes and no geometry.
//
// Distance detail (C12, #3683), today's WorldDistanceDetail rules per part: a part whose bounding sphere would be
// smaller than `minRadiusPx` CSS pixels of radius is not drawn, and a small part farther than `shadowNear +
// shadowPerMetre·radius` metres casts no shadow: an instanced model's part moves into the same model's batch that casts
// none; a one-off shape stays where it is and is left out of its batch's shadow draws (#3787: its own shadow draw list,
// no second batch). A building's window frames
// and fittings go first, its walls last, as today. A part moves between its batches (near, far, hidden) only when the
// eye has moved or things changed, with a margin so it does not flicker at the line.
import * as THREE from 'three';
import { glowOf, partsOf, type ModelIndex, type Part } from './models.ts';
import { pageDetail, type DistanceDetail } from '../draw/quality-tier.ts';
import { NO_CUT, above, buildingView, cutHeight, decide, hidden, sameCut, type BuildingView, type Cut, type Storey } from './interior.ts';

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
  /** `storey`: a building's part (C10); `flame`: a static flame part (C8); `off`: hidden by the interior view or by its
   *  thing's burning fire, in whichever band's batch it is. */
  storey?: Storey; flame?: boolean; off?: boolean;
};
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

/** What three's BatchedMesh keeps of its draws (three 0.187): the draw list it builds from the visible instances, and
 *  the texture mapping each draw to its instance. Read and swapped for the shadow pass only. */
type DrawList = {
  _multiDrawStarts: Int32Array; _multiDrawCounts: Int32Array; _multiDrawCount: number; _indirectTexture: THREE.DataTexture;
  _updateDrawParameters(camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, format?: string): void;
  _visibilityChanged: boolean;
};

/** One-off shapes sharing a material: one `BatchedMesh`, its geometries added once per model part.
 *
 *  #3787: an instance can be drawn without a shadow. The batch keeps a second draw list, the visible instances that
 *  cast, and swaps it in for the shadow pass only (onBeforeShadow / onAfterShadow), rebuilt only when the batch's own
 *  list was rebuilt or an instance's shadow changed. A second, shadowless `BatchedMesh` per material stalled a phone's
 *  GPU for about 200 ms every few frames (#3683); this uploads one small texture when something changes. */
class Shapes {
  mesh: THREE.BatchedMesh;
  geometries = new Map<THREE.BufferGeometry, number>();
  /** Instances that cast no shadow (by instance id), and the shadow pass's own draw list. */
  private noShadow = new Uint8Array(256);
  private dirty = true;
  private starts = new Int32Array(0);
  private counts = new Int32Array(0);
  private count = 0;
  private indirect: THREE.DataTexture | null = null;
  private saved: [Int32Array, Int32Array, number, THREE.DataTexture] | null = null;
  /** Shadow draw lists built (for the measure and tests). */
  rebuilds = 0;
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
    const m = this.mesh as unknown as DrawList, update = m._updateDrawParameters;
    m._updateDrawParameters = (...a) => {
      if (m._visibilityChanged) this.dirty = true;
      update.apply(m, a);
    };
    const before = this.mesh.onBeforeShadow;
    this.mesh.onBeforeShadow = (...a) => {
      before.apply(this.mesh, a);
      this.swap();
    };
    this.mesh.onAfterShadow = () => {
      if (!this.saved) return;
      [m._multiDrawStarts, m._multiDrawCounts, m._multiDrawCount, m._indirectTexture] = this.saved;
      this.saved = null;
    };
  }
  /** Whether instance `i` casts a shadow. */
  shadow(i: number, on: boolean): void {
    if (i >= this.noShadow.length) {
      const grown = new Uint8Array(Math.max(i + 1, this.noShadow.length * 2));
      grown.set(this.noShadow);
      this.noShadow = grown;
    }
    if (this.noShadow[i] === (on ? 0 : 1)) return;
    this.noShadow[i] = on ? 0 : 1;
    this.dirty = true;
  }
  /** Puts the shadow pass's draw list in place of the batch's (rebuilding it first if needed). */
  private swap(): void {
    const m = this.mesh as unknown as DrawList, main = m._indirectTexture, n = main.image.data!.length;
    if (!this.indirect || this.indirect.image.data!.length !== n) {
      this.indirect?.dispose();
      this.indirect = new THREE.DataTexture(new Uint32Array(n), main.image.width, main.image.height, main.format as THREE.PixelFormat, main.type);
      this.starts = new Int32Array(m._multiDrawStarts.length);
      this.counts = new Int32Array(m._multiDrawCounts.length);
      this.dirty = true;
    }
    if (this.dirty) {
      const ids = main.image.data as Uint32Array, out = this.indirect.image.data as Uint32Array, off = this.noShadow;
      let k = 0;
      for (let d = 0; d < m._multiDrawCount; d++) {
        const i = ids[d];
        if (i < off.length && off[i]) continue;
        this.starts[k] = m._multiDrawStarts[d];
        this.counts[k] = m._multiDrawCounts[d];
        out[k++] = i;
      }
      this.count = k;
      this.indirect.needsUpdate = true;
      this.dirty = false;
      this.rebuilds++;
    }
    this.saved = [m._multiDrawStarts, m._multiDrawCounts, m._multiDrawCount, main];
    [m._multiDrawStarts, m._multiDrawCounts, m._multiDrawCount, m._indirectTexture] = [this.starts, this.counts, this.count, this.indirect];
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
    this.shadow(i, true);
    return i;
  }
  /** A light's colour on a one-off model's glow part (a `Batch` has the same). */
  color(i: number, c: THREE.Color): void {
    this.mesh.setColorAt(i, c);
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

  /** Moves a placed thing to `frame` in place (#3603, a punt on its course): its parts and boxes follow, nothing is
   *  added again. A thing not placed yet is left to `set`. */
  move(id: string, frame: THREE.Matrix4): void {
    const d = new THREE.Matrix4();
    for (let c = 0; c < this.copies; c++) {
      const t = this.things.get(c ? `${id}#${c}` : id);
      if (!t) continue;
      const matrix = c ? new THREE.Matrix4().makeTranslation(c * this.spacing, 0, 0).multiply(frame) : frame;
      if (t.matrix.equals(matrix)) continue;
      d.copy(t.matrix).invert().premultiply(matrix);
      t.matrix = matrix.clone();
      const boxes = new Set(t.boxes);
      for (const b of t.boxes) b.premultiply(d);
      t.inverse = undefined;
      for (const s of t.slots) {
        if (!boxes.has(s.matrix)) s.matrix.premultiply(d);
        if (s.batch instanceof Batch) s.batch.show(s.index, s.matrix, !t.under);
        else (s.batch as unknown as Shapes).mesh.setMatrixAt(s.index, s.matrix);
      }
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
      s.batch?.color(s.index, on ? ON : OFF);
      n++;
    }
    return n;
  }

  private readonly flamesHidden = new Set<string>();
  /** Hides or shows a thing's static flame parts while its animated fire draws (fx/layer.ts), as today's flames do. */
  standIns(id: string, shown: boolean): void {
    if (shown) this.flamesHidden.delete(id); else this.flamesHidden.add(id);
    const t = this.things.get(id);
    if (t) this.show(t, !t.under);
  }

  /** Shows or hides every part of a thing that its own storey, or its burning fire (a flame stand-in), does not hide. */
  private show(t: Thing, on: boolean): void {
    for (const s of t.slots) {
      s.off = !on || !!(t.view && s.storey && hidden(s.storey, t.cut ?? NO_CUT, t.view.floors)) || !!(s.flame && this.flamesHidden.has(t.id));
      this.visible(s);
    }
  }

  /** Applies a part's interior-view visibility in the batch it is in (none while its band hides it). */
  private visible(s: Slot): void {
    if (s.batch instanceof Batch) s.batch.show(s.index, s.matrix, !s.off);
    else if (s.batch) (s.batch as unknown as Shapes).mesh.setVisibleAt(s.index, !s.off);
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
      if (s.off) this.visible(s);
      return;
    }
    const parts = this.models.get(t.model!)!, k = parts.indexOf(s.part);
    if (!t.view && (this.share.get(t.model!) ?? 0) >= SHARED) {
      const all = this.instanced[band];
      const batches = all.get(t.model!) ?? all.set(t.model!, parts.map((q) => {
        const b = new Batch(this, q.geometry, q.material, band === NEAR ? (this.share.get(t.model!) ?? 1) * this.copies : 16);
        return band === NEAR ? b : this.far(b);
      })).get(t.model!)!;
      s.batch = batches[k];
      s.index = batches[k].add(s, s.matrix, color);
    } else {
      // One batch a material, whatever the band: a FAR shape is left out of its shadow draws (#3787).
      const all = this.batched[NEAR];
      const shapes = all.get(s.part.material) ?? all.set(s.part.material, new Shapes(this, s.part.material)).get(s.part.material)!;
      s.batch = shapes as unknown as Batch;
      s.index = shapes.add(s.part.geometry, s.matrix, color);
      if (band === FAR) shapes.shadow(s.index, false);
    }
    if (s.off) this.visible(s);
  }

  /** A new part: its world sphere and band, then its batch. */
  private slot(t: Thing, part: Part | null, matrix: THREE.Matrix4, glow: boolean, k: number): void {
    const g = part?.geometry ?? this.boxGeometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const centre = g.boundingSphere!.center.clone().applyMatrix4(matrix), radius = g.boundingSphere!.radius * matrix.getMaxScaleOnAxis();
    const s: Slot = { batch: null, index: -1, glow, band: NEAR, part, matrix, centre, radius, thing: t, gone: false, ...(part?.storey ? { storey: part.storey } : {}), ...(part?.flame ? { flame: true } : {}) };
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
        if (s.batch instanceof Shapes && band !== HIDDEN) (s.band = band), s.batch.shadow(s.index, band === NEAR); // stays in its batch
        else {
          this.unplace(s);
          s.band = band;
          this.place(s.thing, s);
        }
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
      if (t.under) this.show(t, false);
      return;
    }
    // A building is batched whatever its share, so each one's storeys show and hide on their own (C10).
    const view = buildingView(parts, t.matrix);
    if (view) (t.view = view, this.buildings.add(t));
    for (const p of parts) this.slot(t, p, new THREE.Matrix4().multiplyMatrices(t.matrix, p.matrix), p.glow, k);
    // A model arriving under a cut, or under a burning fire.
    if (t.under || t.cut || this.flamesHidden.has(t.id)) this.show(t, !t.under);
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
        .then((bytes) => partsOf(bytes, glow.roles, glow.materials, this.opts.index.kinds?.get(best!), this.opts.index.fits?.get(best!)))
        .then((parts) => this.arrive(best, parts))
        .catch(() => (this.failed++, this.models.set(best, [])))
        .finally(() => this.loading--);
    }
  }

  /** The thing a ray meets first within `far` metres, from the boxes each thing stands in (its model's bounds, or its
   *  solids), skipping what an interior view hides: read-only, nothing drawn changes. Each box's inverse is kept with the thing until the thing moves. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, far = Infinity): ThingHit | null {
    let best: Thing | null = null, box = -1, near = far;
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    for (const t of this.things.values()) {
      if (t.under) continue; // hidden with a storey a building's interior view hides (C10): nothing to hover
      if (t.slots.length && t.slots.every((s) => s.off || s.band === HIDDEN)) continue; // every part out of sight (C10, C12)
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
