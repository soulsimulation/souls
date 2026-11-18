// A body model, made ready for the crowd (V6, #2715). Each body file (W3's split: a mesh file and its rig's shared
// clips file, as `mars/viewer/app/engine-view/character-wire.ts` lists them) becomes:
// - one geometry per level, every part of the body merged into one, each part's colour carried per vertex, so a model
//   draws in one call whatever its materials; levels 1 and 2 are clustered (`lod.ts`);
// - one texture of bone matrices, every clip baked once at BAKE_FPS: a row per frame, three texels per bone (the top
//   three rows of `bone world × bone inverse`), so the vertex shader skins a body from its clip and phase alone.
// Nothing here runs per body or per frame. A body kind someone authored (B13, #2744) brings its own simple model, made
// at admission by `v2/tools/import-body`; it is drawn as level 2 in place of the clustered one.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { cluster, decodeMesh, type LodMesh } from './lod.ts';

export const BAKE_FPS = 30;
/** Grid cells of levels 1 and 2, metres. */
export const LOD_CELLS = [0.035, 0.09];

export type BakedClip = { name: string; start: number; frames: number; seconds: number };
export type BakedModel = {
  name: string;
  /** One geometry per level, nearest first. */
  lods: THREE.BufferGeometry[];
  bake: THREE.DataTexture;
  bones: number;
  /** Per bone, for V7's pose (`../pose/pose.ts`): its name, its parent's index (-1 for none) and its origin in bind pose,
   *  in the model's space (three numbers a bone). */
  names: string[];
  parents: Int16Array;
  joints: Float32Array;
  clips: BakedClip[];
  /** What the source held, for the premise count: triangles and materials per body. */
  triangles: number[];
  materials: number;
  height: number;
};

const loader = new GLTFLoader();
const clipFiles = new Map<string, Promise<THREE.AnimationClip[]>>();

/** Loads a body's mesh file and its clips file (shared clips files load once) and bakes `clips`; with `simpleUrl` (a
 *  kind's simple model, `crowd-mesh/1`) that is its level 2. */
export async function loadModel(name: string, meshUrl: string, clipsUrl: string, clips: string[], simpleUrl?: string): Promise<BakedModel> {
  let anims = clipFiles.get(clipsUrl);
  if (!anims) clipFiles.set(clipsUrl, (anims = loader.loadAsync(clipsUrl).then((g) => g.animations)));
  const simple = simpleUrl ? fetch(simpleUrl).then(async (r) => {
    if (!r.ok) throw new Error(`${simpleUrl}: ${r.status}`);
    return decodeMesh(new Uint8Array(await r.arrayBuffer()));
  }) : undefined;
  const [mesh, all, low] = await Promise.all([loader.loadAsync(meshUrl), anims, simple]);
  return bakeModel(name, mesh, all, clips, low);
}

/** A body file's bytes, parsed (the importer reads bodies with the crowd's own loader). */
export const parseModel = (bytes: ArrayBuffer): Promise<GLTF> => loader.parseAsync(bytes, '');

/** The merged body in bind pose, in the model's space, with bone indices into the first skeleton's bones. */
export function merge(gltf: GLTF): { mesh: LodMesh; skeleton: THREE.Skeleton; materials: number } {
  const parts: THREE.SkinnedMesh[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => void ((o as THREE.SkinnedMesh).isSkinnedMesh && parts.push(o as THREE.SkinnedMesh)));
  if (!parts.length) throw new Error('a body file with no skinned mesh');
  const skeleton = parts[0].skeleton;
  const boneOf = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  const pos: number[] = [], nor: number[] = [], col: number[] = [], si: number[] = [], sw: number[] = [], idx: number[] = [];
  const materials = new Set<string>();
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (const p of parts) {
    const g = p.geometry, mat = p.material as THREE.MeshStandardMaterial;
    materials.add(mat.name || mat.uuid);
    const base = pos.length / 3;
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), I = g.getAttribute('skinIndex'), W = g.getAttribute('skinWeight');
    const remap = p.skeleton.bones.map((b) => boneOf.get(b.name) ?? 0);
    nm.getNormalMatrix(p.bindMatrix);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(p.bindMatrix);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nor.push(v.x, v.y, v.z);
      col.push(mat.color.r, mat.color.g, mat.color.b);
      si.push(remap[I.getX(i)], remap[I.getY(i)], remap[I.getZ(i)], remap[I.getW(i)]);
      sw.push(W.getX(i), W.getY(i), W.getZ(i), W.getW(i));
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for (let i = 0; i < P.count; i++) idx.push(base + i);
  }
  const mesh: LodMesh = {
    position: new Float32Array(pos), normal: new Float32Array(nor), color: new Float32Array(col),
    skinIndex: new Uint16Array(si), skinWeight: new Float32Array(sw), index: new Uint32Array(idx),
  };
  return { mesh, skeleton, materials: materials.size };
}

function geometry(m: LodMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.color, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(m.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(m.skinWeight, 4));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}

/** Keeps a clip in place: the skeleton root's position track holds its first x and z. (Only the root: UAL's foot IK
 *  bones are the root's children and move in x and z with every step.) */
export function inPlace(clip: THREE.AnimationClip, skeleton: THREE.Skeleton): THREE.AnimationClip {
  const c = clip.clone();
  const root = skeleton.bones.find((b) => !(b.parent as THREE.Bone | null)?.isBone);
  for (const t of c.tracks) {
    const [node, prop] = t.name.split('.');
    if (prop !== 'position' || node !== root?.name) continue;
    for (let k = 3; k < t.values.length; k += 3) {
      t.values[k] = t.values[0];
      t.values[k + 2] = t.values[2];
    }
  }
  return c;
}

export function bakeModel(name: string, gltf: GLTF, animations: THREE.AnimationClip[], clipNames: string[], simple?: LodMesh): BakedModel {
  const { mesh, skeleton, materials } = merge(gltf);
  const bones = skeleton.bones.length;
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clips: BakedClip[] = [];
  const rows: Float32Array[] = [];
  const m = new THREE.Matrix4();
  for (const want of clipNames) {
    const src = THREE.AnimationClip.findByName(animations, want);
    if (!src) throw new Error(`${name}: no clip ${want}`);
    const clip = inPlace(src, skeleton);
    const frames = Math.max(2, Math.round(clip.duration * BAKE_FPS));
    clips.push({ name: want, start: rows.length, frames, seconds: clip.duration });
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.play();
    for (let f = 0; f < frames; f++) {
      mixer.setTime((f / frames) * clip.duration);
      gltf.scene.updateMatrixWorld(true);
      const row = new Float32Array(bones * 12);
      skeleton.bones.forEach((b, i) => {
        m.multiplyMatrices(b.matrixWorld, skeleton.boneInverses[i]);
        const e = m.elements; // column-major; rows 0..2 go out as three texels
        row.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], i * 12);
      });
      rows.push(row);
    }
    action.stop();
    mixer.uncacheClip(clip);
  }
  const data = new Float32Array(rows.length * bones * 12);
  rows.forEach((r, i) => data.set(r, i * bones * 12));
  const bake = new THREE.DataTexture(data, bones * 3, rows.length, THREE.RGBAFormat, THREE.FloatType);
  bake.minFilter = bake.magFilter = THREE.NearestFilter;
  bake.needsUpdate = true;
  const levels = [mesh, ...LOD_CELLS.map((c, i) => (i === 1 && simple ? simple : cluster(mesh, c)))];
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < mesh.position.length; i += 3) (lo = Math.min(lo, mesh.position[i])), (hi = Math.max(hi, mesh.position[i]));
  const joints = new Float32Array(bones * 3);
  skeleton.boneInverses.forEach((b, i) => joints.set(new THREE.Vector3().setFromMatrixPosition(m.copy(b).invert()).toArray(), i * 3));
  return {
    name, lods: levels.map(geometry), bake, bones, clips, materials, joints,
    names: skeleton.bones.map((b) => b.name), parents: Int16Array.from(skeleton.bones, (b) => skeleton.bones.indexOf(b.parent as THREE.Bone)),
    triangles: levels.map((l) => l.index.length / 3), height: hi - lo,
  };
}
