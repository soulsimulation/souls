// Kinds' models, by hash (V8, #2718). V17's bake (`v2/tools/import-eden/bake/bake.ts`) writes each kind's picture once
// as binary glTF named by its T3 hash, and `models.json`: every kind's state table and each thing's model. This reads
// that index and turns a model file into parts the thing layer batches: one geometry, one shared material and a
// matrix in the model's frame each. The page admits no file of its own: what it draws is what the bake wrote.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
};

type ModelsJson = { kinds: { models: Record<string, string>; states?: Record<string, string[]> }[]; things?: Record<string, string> };

export async function fetchIndex(root: string): Promise<ModelIndex> {
  const res = await fetch(new URL('models.json', root));
  if (!res.ok) throw new Error(`models.json: ${res.status}`);
  return indexOf((await res.json()) as ModelsJson);
}

export function indexOf(j: ModelsJson): ModelIndex {
  const states = new Map<string, Record<string, string[]>>();
  for (const k of j.kinds) for (const h of Object.values(k.models)) if (h && k.states) states.set(h, k.states);
  return { things: j.things ?? {}, states };
}

/** Materials are shared by what they look like, so one-off shapes with the same material go in one batch. */
const shared = new Map<string, THREE.Material>();
function materialKey(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  return [m.type, s.color?.getHexString(), s.roughness, s.metalness, s.emissive?.getHexString(), s.emissiveIntensity,
    m.transparent, m.opacity, m.side, m.alphaTest, s.vertexColors, isNightGlass(m)].join('|');
}

/** Every geometry in a batch has the same attributes and an index: position, normal and colour (three floats), and on
 *  the building kit's window glass its pane (four floats, the bake's `_edenpane`; C10). */
function plainGeometry(g: THREE.BufferGeometry, pane = false): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const pos = g.getAttribute('position'), n = pos.count;
  out.setAttribute('position', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => pos.getComponent(Math.floor(i / 3), i % 3)), 3));
  const nor = g.getAttribute('normal');
  out.setAttribute('normal', nor ? new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => nor.getComponent(Math.floor(i / 3), i % 3)), 3) : new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  const col = g.getAttribute('color');
  out.setAttribute('color', new THREE.Float32BufferAttribute(col ? Array.from({ length: n * 3 }, (_, i) => col.getComponent(Math.floor(i / 3), i % 3)) : new Float32Array(n * 3).fill(1), 3));
  if (pane) {
    const p = g.getAttribute('_edenpane');
    out.setAttribute('edenPane', new THREE.Float32BufferAttribute(p ? Array.from({ length: n * 4 }, (_, i) => p.getComponent(Math.floor(i / 4), i % 4)) : new Float32Array(n * 4), 4));
  }
  out.setIndex(g.index ? Array.from(g.index.array) : Array.from({ length: n }, (_, i) => i));
  if (!nor) out.computeVertexNormals();
  return out;
}

/** A model's parts, from its glTF bytes. `glowRoles`: the named parts its kind's `on`/`lit` state changes. */
export async function partsOf(bytes: ArrayBuffer, glowRoles: string[], glowMaterials: boolean): Promise<Part[]> {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const parts: Part[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let role = false, flame = false;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) (glowRoles.includes(p.userData?.role) && (role = true), p.userData?.role === 'flame' && (flame = true));
    const storey = storeyOf(mesh) ?? undefined;
    for (const m of [mesh.material].flat()) {
      const k = materialKey(m);
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
        shared.set(k, m);
      }
      const mat = shared.get(k)!;
      const s = mat as THREE.MeshStandardMaterial;
      const glow = role || (glowMaterials && ((s.emissive && s.emissive.getHex() !== 0) || mat.type === 'MeshBasicMaterial'));
      parts.push({ geometry: plainGeometry(mesh.geometry, isNightGlass(mat)), material: mat, matrix: mesh.matrixWorld.clone(), key: k, glow, flame, ...(storey ? { storey } : {}) });
    }
  });
  return parts;
}

/** Which parts the `on` or `lit` field brightens, from the kind's state table. */
export function glowOf(states: Record<string, string[]> | undefined): { roles: string[]; materials: boolean } {
  const parts = [...(states?.on ?? []), ...(states?.lit ?? [])];
  return { roles: parts.filter((p) => !p.startsWith('(')), materials: parts.includes('(glow materials)') };
}
