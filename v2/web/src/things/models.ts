// Kinds' models, by hash (V8, #2718). V17's bake (`v2/tools/import-eden/bake/bake.ts`) writes each kind's picture once
// as binary glTF named by its T3 hash, and `models.json`: every kind's state table and each thing's model. This reads
// that index and turns a model file into parts the thing layer batches: one geometry, one shared material and a
// matrix in the model's frame each. The page admits no file of its own: what it draws is what the bake wrote.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { patchWind, windModeOf, windWeights } from '../sky/wind.ts';
import { storeyOf, type Storey } from './interior.ts';
import { isNightGlass, nightWindows } from './windows.ts';

/** One drawn part of a model. `glow`: the parts a light's `on` (or `lit`) state brightens. `storey`: where a generated
 *  building's part is (C10, `interior.ts`), so the interior view can hide its roof and upper storeys. `flame`: a static
 *  flame part (role `flame`), the stand-in an animated fire hides while it draws (fx/layer.ts). */
export type Part = { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4; key: string; glow: boolean; storey?: Storey; flame?: boolean };

/** What the page needs of V17's `models.json`. */
export type ModelIndex = {
  /** Today's thing id (a node's origin field) -> its model's hash. */
  things: Record<string, string>;
  /** A model's hash -> the state table of its kind (field -> the parts it changes, or a note in parentheses). */
  states: Map<string, Record<string, string[]>>;
  /** A model's hash -> its kind's name (`core-flagpole`), which says whether its cloth sways (C9). */
  kinds?: Map<string, string>;
  /** A stored model's hash -> how today's page fits it to its kind's box (the bake's `fit`, `[scale, x, y, z]`) and
   *  whether it is drawn a hair towards the camera (`flat`: a rug, a lily pad). */
  fits?: Map<string, Fit>;
};

/** A stored model's placement: its point p is drawn at `scale * p + (x, y, z)` in the thing's frame. */
export type Fit = { fit?: number[]; flat?: boolean };

type ModelsJson = { kinds: { kind?: string; models: Record<string, string>; states?: Record<string, string[]>; fit?: number[]; flat?: boolean }[]; things?: Record<string, string> };

export async function fetchIndex(root: string): Promise<ModelIndex> {
  const res = await fetch(new URL('models.json', root));
  if (!res.ok) throw new Error(`models.json: ${res.status}`);
  return indexOf((await res.json()) as ModelsJson);
}

export function indexOf(j: ModelsJson): ModelIndex {
  const states = new Map<string, Record<string, string[]>>(), kinds = new Map<string, string>(), fits = new Map<string, Fit>();
  for (const k of j.kinds) for (const h of Object.values(k.models)) {
    if (h && k.states) states.set(h, k.states);
    if (h && k.kind) kinds.set(h, k.kind);
    if (h && (k.fit || k.flat)) fits.set(h, { ...(k.fit ? { fit: k.fit } : {}), ...(k.flat ? { flat: true } : {}) });
  }
  return { things: j.things ?? {}, states, kinds, fits };
}

/** Materials are shared by what they look like, so one-off shapes with the same material go in one batch. */
const shared = new Map<string, THREE.Material>();
/** The texture maps a stored model's material may carry (its glTF's WebP or AVIF images). */
const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'] as const;
const mapsOf = (m: THREE.Material) => MAPS.map((k) => (m as unknown as Record<string, THREE.Texture | null | undefined>)[k]?.uuid ?? '');
function materialKey(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  return [m.type, s.color?.getHexString(), s.roughness, s.metalness, s.emissive?.getHexString(), s.emissiveIntensity,
    m.transparent, m.opacity, m.side, m.alphaTest, s.vertexColors, isNightGlass(m), ...mapsOf(m)].join('|');
}
/** Does a material sample a texture (its geometry then keeps its uv)? */
const textured = (m: THREE.Material) => mapsOf(m).some(Boolean);

/** Every geometry in a batch has the same attributes and an index: position, normal and colour (three floats), and on
 *  the building kit's window glass its pane (four floats, the bake's `_edenpane`; C10). */
function plainGeometry(g: THREE.BufferGeometry, pane = false, uv = false): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const pos = g.getAttribute('position'), n = pos.count;
  out.setAttribute('position', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => pos.getComponent(Math.floor(i / 3), i % 3)), 3));
  const nor = g.getAttribute('normal');
  out.setAttribute('normal', nor ? new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => nor.getComponent(Math.floor(i / 3), i % 3)), 3) : new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  const col = g.getAttribute('color');
  out.setAttribute('color', new THREE.Float32BufferAttribute(col ? Array.from({ length: n * 3 }, (_, i) => col.getComponent(Math.floor(i / 3), i % 3)) : new Float32Array(n * 3).fill(1), 3));
  if (uv) {
    const t = g.getAttribute('uv');
    out.setAttribute('uv', new THREE.Float32BufferAttribute(t ? Array.from({ length: n * 2 }, (_, i) => t.getComponent(Math.floor(i / 2), i % 2)) : new Float32Array(n * 2), 2));
  }
  if (pane) {
    const p = g.getAttribute('_edenpane');
    out.setAttribute('edenPane', new THREE.Float32BufferAttribute(p ? Array.from({ length: n * 4 }, (_, i) => p.getComponent(Math.floor(i / 4), i % 4)) : new Float32Array(n * 4), 4));
  }
  out.setIndex(g.index ? Array.from(g.index.array) : Array.from({ length: n }, (_, i) => i));
  if (!nor) out.computeVertexNormals();
  return out;
}

/** One loader for every model, with the meshopt decoder a stored file needs (WebP and AVIF images load as they are). */
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** A model's parts, from its glTF bytes. `glowRoles`: the named parts its kind's `on`/`lit` state changes; `kind`: its
 *  kind's name, for the wind (C9): a part that sways gets its own copy of its material, patched to sway, and its
 *  geometry carries each vertex's share of the sway. `place`: a stored model's fit to its kind's box (today's
 *  `instantiate`) and its flat look; a stored file is meshopt-compressed with WebP or AVIF textures, as today's page
 *  gets it. */
export async function partsOf(bytes: ArrayBuffer, glowRoles: string[], glowMaterials: boolean, kind = '', place?: Fit): Promise<Part[]> {
  const gltf = await loader.parseAsync(bytes, '');
  const root = gltf.scene;
  const [scale, x, y, z] = place?.fit ?? [1, 0, 0, 0];
  root.updateMatrixWorld(true);
  const fit = new THREE.Matrix4().makeScale(scale, scale, scale).setPosition(x, y, z);
  const parts: Part[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let role = false, flame = false;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) (glowRoles.includes(p.userData?.role) && (role = true), p.userData?.role === 'flame' && (flame = true));
    const storey = storeyOf(mesh) ?? undefined;
    for (const original of [mesh.material].flat()) {
      const mode = windModeOf(original.name, kind);
      const weights = mode && windWeights(mesh.geometry, mesh.matrixWorld, mode);
      const m = weights || place?.flat ? original.clone() : original;
      // today's flat things (a few cm thick) are drawn a hair towards the camera against gently uneven ground
      if (place?.flat) Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      const k = materialKey(m) + (weights ? `|wind:${mode}` : '') + (place?.flat ? '|flat' : '');
      if (!shared.has(k)) {
        const s = m as THREE.MeshStandardMaterial;
        s.vertexColors = true;
        if (isNightGlass(m)) nightWindows(m); // C10: rooms behind lit windows at night
        // A glowing material's light follows its instance's colour, so a light switched off stops glowing.
        if (s.emissive && s.emissive.getHex() !== 0) s.onBeforeCompile = (sh) => {
          sh.vertexShader = 'varying float vGlow;\n' + sh.vertexShader.replace('#include <color_vertex>',
            '#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\nvGlow = instanceColor.g;\n#else\nvGlow = 1.0;\n#endif');
          sh.fragmentShader = 'varying float vGlow;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow;');
        };
        if (weights) patchWind(m, mode!); // after the glow hook, which it keeps
        shared.set(k, m);
      }
      const mat = shared.get(k)!;
      const s = mat as THREE.MeshStandardMaterial;
      const glow = role || (glowMaterials && ((s.emissive && s.emissive.getHex() !== 0) || mat.type === 'MeshBasicMaterial'));
      const geometry = plainGeometry(mesh.geometry, isNightGlass(mat), textured(mat));
      if (weights) geometry.setAttribute('edenWind', new THREE.Float32BufferAttribute(weights, 1));
      parts.push({ geometry, material: mat, matrix: fit.clone().multiply(mesh.matrixWorld), key: k, glow, flame, ...(storey ? { storey } : {}) });
    }
  });
  return parts;
}

/** Which parts the `on` or `lit` field brightens, from the kind's state table. */
export function glowOf(states: Record<string, string[]> | undefined): { roles: string[]; materials: boolean } {
  const parts = [...(states?.on ?? []), ...(states?.lit ?? [])];
  return { roles: parts.filter((p) => !p.startsWith('(')), materials: parts.includes('(glow materials)') };
}
