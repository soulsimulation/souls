// The page's catalogue of a creator's kinds (Engine v2 parity L12, #3697). A creator defines a kind as data: a node of
// the engine's generic kind `souls:kind` at the world's root, holding its full name (`ns:name@<hash>`, field 1) and its
// canonical `souls-entry/1` record (field 2; `replica::kinds::defined`). The page learns those nodes from the stream as
// it plays them and answers a thing of a creator's kind from its record: its bounds (`geometry.bounds_mm`, the box its
// solids come from), its shapes (`geometry.parts`, the kit's primitives in mm, millidegrees and permille, as
// `souls-god define-kit` writes them) and, when the record names a model the page can load (`looks.model` or
// `geometry.model`, a model hash the models index knows), that model. The `souls:kind` nodes themselves are never drawn.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import type { ModelIndex, Part } from '../things/models.ts';

/** The engine's generic kind a definition is a node of. */
export const DEFINITION = 'souls:kind';
export const isDefinition = (kind: string): boolean => kind.split('@')[0] === DEFINITION;

/** One shape of a record's `geometry.parts`: lengths mm, angles millidegrees, `scale` and `glow` permille. */
export type Shape = {
  kind: string; at?: number[]; from?: number[]; to?: number[]; size?: number[]; r?: number; r2?: number; h?: number;
  profile?: number[][]; polygon?: number[][]; holes?: number[][][]; yaw?: number; pitch?: number; roll?: number; arc?: number;
  scale?: number[]; color?: string; tint?: string; material?: string; glow?: number; role?: string;
};

/** What the page draws a creator's kind from. */
export type CreatorKind = {
  full: string; name: string;
  /** `[w, h, d]` mm: the footprint centred on the thing, from the ground up. */
  bounds: [number, number, number] | null;
  shapes: Shape[]; palette: Record<string, string>;
  /** The model the record names, as written; the page draws it only when its index knows it (`modelOf`). */
  model: string | null;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const nums = (v: unknown, n?: number): number[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && (n === undefined || v.length === n) ? (v as number[]) : null);

/** A record's bytes as a creator kind, or null when they are not a `souls-entry/1` record. */
export function readRecord(full: string, bytes: Uint8Array): CreatorKind | null {
  let entry: Json | null;
  try {
    entry = obj(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
  if (!entry || entry.format !== 'souls-entry/1') return null;
  const g = obj(entry.geometry) ?? {}, looks = obj(entry.looks) ?? {};
  const b = nums(g.bounds_mm, 3);
  const shapes = (Array.isArray(g.parts) ? g.parts : []).filter((s): s is Shape => !!obj(s) && typeof (s as Json).kind === 'string');
  const palette = Object.fromEntries(Object.entries(obj(g.palette) ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  const model = typeof looks.model === 'string' ? looks.model : typeof g.model === 'string' ? g.model : null;
  return { full, name: typeof entry.kind === 'string' ? entry.kind : full.split('@')[0], bounds: b && b.every((x) => x > 0) ? (b as [number, number, number]) : null, shapes, palette, model };
}

/** The creator's kinds a world has defined so far, learnt from its `souls:kind` nodes. */
export class KindCatalogue {
  private readonly kinds = new Map<string, CreatorKind>();
  private readonly nodes = new Map<string, string>();

  /** Learns the definitions among `nodes` and forgets those `removed`; true when the catalogue changed. */
  apply(nodes: NodeRec[], removed: string[]): boolean {
    let changed = false;
    for (const id of removed) {
      const full = this.nodes.get(id);
      if (full === undefined) continue;
      this.nodes.delete(id);
      if (![...this.nodes.values()].includes(full)) this.kinds.delete(full);
      changed = true;
    }
    for (const n of nodes) {
      if (!isDefinition(n.kind) || !n.defines || !n.entry || this.nodes.get(n.id) === n.defines) continue;
      const k = readRecord(n.defines, n.entry);
      if (!k) continue;
      this.nodes.set(n.id, n.defines);
      this.kinds.set(n.defines, k);
      changed = true;
    }
    return changed;
  }

  /** The creator's kind a thing's full kind name names, or null (a boot kind, or one not defined). */
  of(kind: string): CreatorKind | null {
    return this.kinds.get(kind) ?? null;
  }

  get size(): number {
    return this.kinds.size;
  }
}

/** The box of a kind's bounds in its thing's frame (the unit box the thing layer's boxes scale), or null. */
export function boundsBox(k: CreatorKind): THREE.Matrix4 | null {
  if (!k.bounds) return null;
  const [w, h, d] = k.bounds;
  return new THREE.Matrix4().makeScale(w / 1000, h / 1000, d / 1000);
}

/** The model the record names, when the page's models index knows it; null otherwise. */
export function modelOf(k: CreatorKind, index: ModelIndex): string | null {
  const m = k.model;
  if (!m) return null;
  return index.states.has(m) || index.kinds?.has(m) || Object.values(index.things).includes(m) ? m : null;
}

const M = 1e-3, RAD = Math.PI / 180_000;
/** Curve segments, as today's kits' default. */
const SEG = 16;

/** One shape's geometry in the kind's frame (metres): today's kit primitives (apps/web `kit.mesh.ts`), centred on
 *  `at` and turned yaw, pitch, roll (YXZ). Null for a shape this page does not draw (`arch`, `loft`, `sweep`). */
export function shapeGeometry(s: Shape): THREE.BufferGeometry | null {
  const size = (nums(s.size, 3) ?? [1000, 1000, 1000]).map((v) => Math.max(1, v) * M);
  const r = (s.r ?? 500) * M, r2 = s.r2 !== undefined ? s.r2 * M : undefined, h = (s.h ?? 1000) * M;
  const arc = s.arc !== undefined ? s.arc * RAD : Math.PI * 2;
  let g: THREE.BufferGeometry;
  switch (s.kind) {
    case 'box': case 'rbox': g = new THREE.BoxGeometry(size[0], size[1], size[2]); break;
    case 'wedge': {
      const [w, hh, d] = size;
      g = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-d / 2, -hh / 2), new THREE.Vector2(d / 2, -hh / 2), new THREE.Vector2(-d / 2, hh / 2)]), { depth: w, bevelEnabled: false });
      g.translate(0, 0, -w / 2);
      g.rotateY(-Math.PI / 2);
      break;
    }
    case 'cyl': g = new THREE.CylinderGeometry(r2 ?? r, r, h, SEG, 1, false, 0, arc); break;
    case 'cone': g = new THREE.ConeGeometry(r, h, SEG, 1, false, 0, arc); break;
    case 'capsule': g = new THREE.CapsuleGeometry(s.r !== undefined ? r : 0.2, s.h !== undefined ? h : 0.6, 2, 10); break;
    case 'sphere': g = new THREE.SphereGeometry(r, SEG, 10, 0, arc); break;
    case 'torus': g = new THREE.TorusGeometry(r, r2 ?? 0.1, 6, SEG, arc); break;
    case 'ring': g = new THREE.TorusGeometry(r, r2 ?? 0.1, 6, SEG, arc).rotateX(Math.PI / 2); break;
    case 'lathe': g = new THREE.LatheGeometry((s.profile ?? [[500, 0], [500, 1000]]).map(([x, y]) => new THREE.Vector2(Math.max(0, x * M), y * M)), SEG, 0, arc); break;
    case 'extrude': {
      const shape = new THREE.Shape((s.polygon ?? [[0, 0], [1000, 0], [0, 1000]]).map(([x, z]) => new THREE.Vector2(x * M, z * M)));
      for (const hole of s.holes ?? []) shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x * M, z * M))));
      const depth = s.h !== undefined ? h : 0.2;
      g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, depth, 0);
      break;
    }
    default: return null;
  }
  const at = nums(s.at, 3) ?? [0, 0, 0], sc = nums(s.scale, 3) ?? [1000, 1000, 1000];
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(at[0] * M, at[1] * M, at[2] * M),
    new THREE.Quaternion().setFromEuler(new THREE.Euler((s.pitch ?? 0) * RAD, (s.yaw ?? 0) * RAD, (s.roll ?? 0) * RAD, 'YXZ')),
    new THREE.Vector3(sc[0] / 1000, sc[1] / 1000, sc[2] / 1000),
  );
  return plain(g.applyMatrix4(m));
}

/** The thing layer batches geometries with one set of attributes: position, normal, colour (white), an index. */
function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry(), n = g.getAttribute('position').count;
  out.setAttribute('position', g.getAttribute('position').clone());
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  out.setAttribute('normal', g.getAttribute('normal').clone());
  out.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  out.setIndex(g.index ? Array.from(g.index.array) : Array.from({ length: n }, (_, i) => i));
  g.dispose();
  return out;
}

/** A shape's colour: its own, else its tint or material from the palette, else a stone grey. */
export function colourOf(s: Shape, palette: Record<string, string>): string {
  const c = s.color ?? (s.tint && palette[s.tint]) ?? (s.material && palette[s.material]) ?? null;
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : '#9a958c';
}

/** Materials by colour and glow, shared by every creator kind so equal shapes batch together. */
const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(colour: string, glow: number): THREE.MeshStandardMaterial {
  const k = `${colour}|${glow}`;
  let m = materials.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85, metalness: 0, vertexColors: true });
    if (glow > 0) (m.emissive.set(colour), (m.emissiveIntensity = glow / 1000));
    materials.set(k, m);
  }
  return m;
}

/** The parts a kind's shapes are drawn as (the thing layer's `Part`s, in the thing's frame); none without shapes. */
export function partsOfKind(k: CreatorKind): Part[] {
  const out: Part[] = [];
  for (const s of k.shapes) {
    const geometry = shapeGeometry(s);
    if (!geometry) continue;
    const colour = colourOf(s, k.palette), glow = Math.max(0, Math.min(1000, s.glow ?? 0));
    out.push({ geometry, material: material(colour, glow), matrix: new THREE.Matrix4(), key: `${k.full}|${colour}|${glow}`, glow: glow > 0 });
  }
  return out;
}

/** The key a creator's kind's shapes are kept under in the thing layer, apart from every model hash. */
export const shapesKey = (k: CreatorKind): string => `kind:${k.full}`;
