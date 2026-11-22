// A kind's picture from its entry's `looks.shape` (#3871): rounded low-poly primitives, as today's page draws a kind with
// no model (`apps/web/src/gen-mesh/kit.mesh.ts`, `buildKit`, kit contract 1, which every entry is: the look gate
// `tools/entry/look.mjs` wraps the shape as a `kit/2` def with no `v`). Ported because this page imports nothing from
// apps/. The entry writes whole millimetres, millidegrees and permille; they become metres, radians and fractions
// here, as `look.mjs`'s `shapeInMetres` does. Shapes of one material class merge into one mesh; shapes with a `role`
// stay apart under a pivot group named `role:<role>` (userData.role), which the looks table moves, hides, tints and
// lights. A shape whose `when` names state (`@on`, `!@on`, `@showing=sea`, `@dirt>=1`) is drawn only in that state.
// Left out of the port (today's are effects, not shapes): animated flames and smoke, falling water, wind sway, faces.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type V3 = [number, number, number];
/** One shape as the entry writes it (mm, millidegrees, permille). */
export type EntryShape = {
  kind: string; at: V3; size?: V3; r?: number; r2?: number; h?: number; segments?: number; round?: number; arc?: number;
  yaw?: number; pitch?: number; roll?: number; scale?: V3; tint?: string; color?: string; material?: string; glow?: number;
  role?: string; pivot?: V3; when?: string; polygon?: [number, number][]; holes?: [number, number][][]; top?: [number, number][];
  profile?: [number, number][]; path?: V3[];
};
export type EntryLook = { shapes: EntryShape[]; round?: number; palette?: Record<string, string>; tags?: string[] };

/** The materials a kit shape may name, and how each looks (today's `MATERIAL_LOOKS`, the ones a colour falls back to). */
const MATERIALS: Record<string, { color: string; roughness: number; metalness: number; opacity?: number }> = {
  wood: { color: '#9a6b43', roughness: 0.8, metalness: 0 }, stone: { color: '#b9b3a6', roughness: 0.92, metalness: 0 },
  plaster: { color: '#efe6d4', roughness: 0.95, metalness: 0 }, brick: { color: '#a8553f', roughness: 0.9, metalness: 0 },
  glass: { color: '#bcd8e6', roughness: 0.06, metalness: 0.1, opacity: 0.38 }, metal: { color: '#8c9196', roughness: 0.35, metalness: 0.8 },
  fabric: { color: '#c46a5a', roughness: 1, metalness: 0 }, ceramic: { color: '#e8e2d6', roughness: 0.35, metalness: 0 },
  water: { color: '#3a7ca8', roughness: 0.2, metalness: 0.1, opacity: 0.78 }, leaf: { color: '#4b8a3c', roughness: 0.9, metalness: 0 },
  paint: { color: '#e9e2d0', roughness: 0.6, metalness: 0 }, plastic: { color: '#d94f4f', roughness: 0.5, metalness: 0 },
  paper: { color: '#f4efe3', roughness: 1, metalness: 0 }, rubber: { color: '#2b2b2b', roughness: 0.9, metalness: 0 },
  emissive: { color: '#ffe9c4', roughness: 0.5, metalness: 0 },
};
const colourOf = (material: string | undefined) => (MATERIALS[material ?? 'paint'] ?? MATERIALS.paint).color;
/** The glow a lit part has as drawn (today's contract-1 emissive class). */
export const GLOW = 0.8;

/** A material class (today's contract-1 `classOf`): shapes of one class share a material and merge. */
const classOf = (sh: EntryShape) => (sh.material === 'glass' ? 'glass' : sh.material === 'water' ? 'water' : sh.glow ? 'glow' : 'solid');
const shared = new Map<string, THREE.MeshStandardMaterial>();
/** The shared material of a class; every geometry carries its colour per vertex. */
export function materialOf(cls: string): THREE.MeshStandardMaterial {
  let m = shared.get(cls);
  if (!m) {
    const look = MATERIALS[cls === 'glow' ? 'emissive' : cls === 'solid' ? 'paint' : cls];
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: look.roughness, metalness: look.metalness, transparent: look.opacity !== undefined, opacity: look.opacity ?? 1, depthWrite: look.opacity === undefined });
    if (cls === 'glow') (m.emissive = new THREE.Color(look.color)), (m.emissiveIntensity = GLOW);
    m.name = `kind:${cls}`;
    shared.set(cls, m);
  }
  return m;
}

const MM = 1e-3, MDEG = Math.PI / 180000;
const mm = (v: number | undefined, d: number) => (v === undefined ? d : v * MM);

/** Geometry for one primitive in metres, centred where its kind is naturally centred (today's `primitive`, contract 1). */
function primitive(sh: EntryShape, round: number): THREE.BufferGeometry {
  const seg = sh.segments ?? 10, full = Math.PI * 2;
  const size = (sh.size ?? [1000, 1000, 1000]).map((v) => v * MM) as V3;
  switch (sh.kind) {
    case 'box': case 'rbox': {
      const [w, h, d] = size;
      const r = Math.min(sh.round !== undefined ? sh.round * MM : sh.kind === 'rbox' ? Math.max(round, 0.06) : round, Math.min(w, h, d) / 2 - 1e-4);
      if (r <= 0.005) return new THREE.BoxGeometry(w, h, d);
      if (sh.kind === 'rbox' && (sh.segments ?? 0) >= 2) return new RoundedBoxGeometry(w, h, d, 2, r);
      const s = new THREE.Shape(); s.moveTo(-w / 2 + r, -h / 2 + r); s.lineTo(w / 2 - r, -h / 2 + r); s.lineTo(w / 2 - r, h / 2 - r); s.lineTo(-w / 2 + r, h / 2 - r); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(1e-3, d - 2 * r), bevelEnabled: true, bevelSize: r, bevelThickness: r, bevelSegments: 1, curveSegments: 1 });
      g.translate(0, 0, -(d - 2 * r) / 2); return g;
    }
    case 'cyl': return new THREE.CylinderGeometry(mm(sh.r2 ?? sh.r, 0.5), mm(sh.r, 0.5), mm(sh.h, 1), seg, 1, false, 0, full);
    case 'cone': return new THREE.ConeGeometry(mm(sh.r, 0.5), mm(sh.h, 1), seg, 1, false, 0, full);
    case 'capsule': return new THREE.CapsuleGeometry(mm(sh.r, 0.2), mm(sh.h, 0.6), 2, Math.max(6, Math.min(seg, 10)));
    case 'sphere': return new THREE.SphereGeometry(mm(sh.r, 0.5), seg, Math.max(4, Math.round(seg * 0.6)), 0, full);
    case 'torus': return new THREE.TorusGeometry(mm(sh.r, 0.5), mm(sh.r2, 0.1), 6, seg, sh.arc !== undefined ? sh.arc * MDEG : full);
    case 'ring': { const g = new THREE.TorusGeometry(mm(sh.r, 0.5), mm(sh.r2, 0.1), 6, seg, sh.arc !== undefined ? sh.arc * MDEG : full); g.rotateX(Math.PI / 2); return g; }
    case 'wedge': {
      const [w, h, d] = size, b = Math.min(sh.round !== undefined ? sh.round * MM : round, 0.03);
      const s = new THREE.Shape([new THREE.Vector2(-d / 2, -h / 2), new THREE.Vector2(d / 2, -h / 2), new THREE.Vector2(-d / 2, h / 2)]);
      const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: (sh.round !== undefined ? sh.round * MM : round) > 0.005, bevelSize: b, bevelThickness: b, bevelSegments: 1 });
      g.translate(0, 0, -w / 2); g.rotateY(-Math.PI / 2); return g;
    }
    case 'lathe': return new THREE.LatheGeometry((sh.profile ?? [[500, 0], [500, 1000]]).map(([r, y]) => new THREE.Vector2(Math.max(0, r * MM), y * MM)), seg, 0, full);
    case 'extrude': {
      const s = new THREE.Shape((sh.polygon ?? [[0, 0], [1000, 0], [0, 1000]]).map(([x, z]) => new THREE.Vector2(x * MM, z * MM)));
      const h = mm(sh.h, 0.2), b = Math.min(sh.round !== undefined ? sh.round * MM : round, 0.03);
      const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: (sh.round !== undefined ? sh.round * MM : round) > 0.005, bevelSize: b, bevelThickness: b, bevelSegments: 1 });
      g.rotateX(Math.PI / 2); g.translate(0, h, 0); return g;
    }
    case 'sweep': {
      const pts = (sh.path ?? [[0, 0, 0], [1000, 0, 0]]).map(([x, y, z]) => new THREE.Vector3(x * MM, y * MM, z * MM));
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(4, pts.length * 4), mm(sh.r, 0.05), Math.max(5, Math.min(seg, 8)), false);
    }
    default: return new THREE.BoxGeometry(size[0], size[1], size[2]); // a kind of shape this port does not know: its box
  }
}

/** A primitive placed by its scale, rotation (YXZ: yaw, pitch, roll) and position, less `offset`; non-indexed, with
 *  its colour on every vertex. */
function placed(sh: EntryShape, round: number, color: THREE.Color, offset?: THREE.Vector3): THREE.BufferGeometry {
  const g0 = primitive(sh, round), g = g0.index ? g0.toNonIndexed() : g0;
  if (g !== g0) g0.dispose();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(sh.at[0] * MM, sh.at[1] * MM, sh.at[2] * MM).sub(offset ?? new THREE.Vector3()),
    new THREE.Quaternion().setFromEuler(new THREE.Euler((sh.pitch ?? 0) * MDEG, (sh.yaw ?? 0) * MDEG, (sh.roll ?? 0) * MDEG, 'YXZ')),
    new THREE.Vector3(...((sh.scale ?? [1000, 1000, 1000]).map((s) => s / 1000) as V3)),
  );
  g.applyMatrix4(m);
  if (m.determinant() < 0) for (const attribute of Object.values(g.attributes)) {
    const a = attribute as THREE.BufferAttribute;
    for (let i = 0; i < a.count; i += 3) for (let k = 0; k < a.itemSize; k++) {
      const j = (i + 1) * a.itemSize + k, l = (i + 2) * a.itemSize + k, v = a.array[j];
      a.array[j] = a.array[l]; a.array[l] = v;
    }
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count, cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) (cols[i * 3] = color.r), (cols[i * 3 + 1] = color.g), (cols[i * 3 + 2] = color.b);
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
  return g;
}

function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  for (const g of geos) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array as Float32Array, o * 3); nor.set(g.attributes.normal.array as Float32Array, o * 3); col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}

/** Whether a shape's `when` holds for this state (today's `kitWhen`, state terms `@field`; a parameter term holds, as
 *  an entry has no parameters). Terms joined by `&`, each `[!]@field[(=|!=|>=|<=|>|<)value[|value]]`. */
export function when(w: string | undefined, state: Record<string, unknown>): boolean {
  if (!w) return true;
  return w.split('&').every((term) => {
    let t = term.trim(); const neg = t.startsWith('!'); if (neg) t = t.slice(1).trim();
    if (!t.startsWith('@')) return true;
    const m = /^([A-Za-z][\w-]*)\s*(!=|=|>=|<=|>|<)?\s*(.*)$/.exec(t.slice(1)); if (!m) return true;
    const v = state[m[1]], op = m[2], rhs = m[3];
    let ok: boolean;
    if (!op) ok = !!v && v !== 'none';
    else if (op === '=' || op === '!=') { const hit = rhs.split('|').some((x) => String(v) === x.trim()); ok = op === '=' ? hit : !hit; }
    else { const a = Number(v), b = Number(rhs); ok = op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b; }
    return neg ? !ok : ok;
  });
}
/** Which of a look's `when` shapes are drawn in this state ('' when it has none): a picture is built once per key. */
export const whenKey = (look: EntryLook, state: Record<string, unknown>) => (look.shapes.some((s) => s.when) ? look.shapes.map((s) => (s.when ? (when(s.when, state) ? '1' : '0') : '')).join('') : '');

/** A kind's picture for a state: one mesh per material class, and a pivot group per role (`role:<name>`,
 *  userData.role) holding that role's shapes; metres, in the thing's own frame. */
export function buildShape(look: EntryLook, state: Record<string, unknown>): THREE.Group {
  const root = new THREE.Group(), round = look.round !== undefined ? look.round * MM : 0.04;
  const tint = (sh: EntryShape) => (sh.tint && look.palette?.[sh.tint]) ?? (sh.tint?.startsWith('#') ? sh.tint : sh.color ?? colourOf(sh.material));
  const byClass = new Map<string, THREE.BufferGeometry[]>(), byRole = new Map<string, EntryShape[]>();
  const color = new THREE.Color();
  for (const sh of look.shapes) {
    if (!when(sh.when, state)) continue;
    if (sh.role) { const list = byRole.get(sh.role) ?? []; list.push(sh); byRole.set(sh.role, list); continue; }
    color.set(tint(sh));
    const k = classOf(sh), list = byClass.get(k) ?? [];
    list.push(placed(sh, round, color));
    byClass.set(k, list);
  }
  for (const [k, geos] of byClass) {
    const mesh = new THREE.Mesh(merge(geos), materialOf(k));
    mesh.castShadow = k === 'solid'; mesh.receiveShadow = true; mesh.name = `kind:${k}`;
    root.add(mesh);
  }
  for (const [role, shapes] of byRole) {
    // the pivot: one a shape states, else the top centre of the role's shapes (legs swing from the hip)
    const explicit = shapes.find((s) => s.pivot)?.pivot;
    const pv = explicit ? new THREE.Vector3(explicit[0] * MM, explicit[1] * MM, explicit[2] * MM) : (() => {
      const b = new THREE.Box3();
      for (const s of shapes) b.expandByPoint(new THREE.Vector3(s.at[0] * MM, s.at[1] * MM, s.at[2] * MM));
      const c = b.getCenter(new THREE.Vector3());
      return new THREE.Vector3(c.x, b.max.y + (role.startsWith('leg') || role.startsWith('arm') ? ((shapes[0].h ?? shapes[0].size?.[1] ?? 200) * MM) / 2 : 0), c.z);
    })();
    const pivot = new THREE.Group();
    pivot.name = `role:${role}`; pivot.position.copy(pv); pivot.userData.role = role;
    const geos = shapes.map((sh) => (color.set(tint(sh)), placed(sh, round, color, pv)));
    const cls = shapes.some((s) => s.glow) ? 'glow' : 'solid';
    const mesh = new THREE.Mesh(merge(geos), materialOf(cls));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = `kind:${cls}`;
    pivot.add(mesh);
    root.add(pivot);
  }
  return root;
}
