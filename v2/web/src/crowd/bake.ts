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
  /** Per bone, 1 above the hips (the abdomen and every bone below it), else 0: what a gesture over a posture moves. */
  upper: Float32Array;
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

/** Clips made here from another (#3741): today's procedural gestures with no library clip, as a base clip's first frame
 *  with world-space turns on named bones (radians about the body's sideways axis, so positive leans forward) on a
 *  half sine over the clip. `Bow`: `activity-poses.ts`'s bow, the back 0.55 rad over three bones and the head 0.2. */
export const MADE: Readonly<Record<string, { base: string; seconds: number; turns: [string, number][] }>> = {
  Bow: { base: 'Idle', seconds: 1, turns: [['Abdomen', 0.15], ['Torso', 0.2], ['Chest', 0.2], ['Neck', 0.2]] },
};

/** Clips laid out here (#3791): today's lying pose, a library clip's first frame held (`clip-library.ts`: `LayToIdle`
 *  for a lie or nap), turned and moved as `humans.ts` lays it: the hips over the body's point, the head along its back
 *  (local -z, so a body lies down where it stood, facing up the way it faced). */
export const LAID: Readonly<Record<string, string>> = { Lie: 'LayToIdle' };

/** The turn and shift that lay a frame out: the hips to the origin in x and z, the head from them along -z. */
function layout(bones: THREE.Bone[]): THREE.Matrix4 {
  const at = (names: string[]) => {
    const b = names.map((n) => bones.find((x) => x.name === n)).find((x) => x);
    return b ? b.getWorldPosition(new THREE.Vector3()) : null;
  };
  const hips = at(['Hips', 'Pelvis']), head = at(['Head', 'Neck', 'Chest']);
  if (!hips || !head) return new THREE.Matrix4();
  const turn = new THREE.Matrix4().makeRotationY(Math.PI - Math.atan2(head.x - hips.x, head.z - hips.z));
  const h = hips.clone().applyMatrix4(turn);
  return new THREE.Matrix4().makeTranslation(-h.x, 0, -h.z).multiply(turn);
}

const _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _x = new THREE.Vector3(1, 0, 0);

/** Turns `bones` by `made`'s turns at `k` (0..1) of their full lean, each about the world x axis at its own joint. */
function turn(made: (typeof MADE)[string], bones: THREE.Bone[], k: number, root: THREE.Object3D, rest: Map<THREE.Bone, THREE.Quaternion>): void {
  for (const [name, rad] of made.turns) {
    const b = bones.find((x) => x.name === name);
    if (!b) continue;
    // From the base clip's own rotation each frame: a bone the clip does not animate keeps no turn from the last.
    if (!rest.has(b)) rest.set(b, b.quaternion.clone());
    b.quaternion.copy(rest.get(b)!);
    root.updateMatrixWorld(true);
    b.getWorldQuaternion(_q);
    _r.setFromAxisAngle(_x, rad * k);
    // local' = local × (world⁻¹ × turn × world): the bone turned in the world about its own joint.
    b.quaternion.multiply(_q.clone().invert().multiply(_r).multiply(_q));
  }
}

export function bakeModel(name: string, gltf: GLTF, animations: THREE.AnimationClip[], clipNames: string[], simple?: LodMesh): BakedModel {
  const { mesh, skeleton, materials } = merge(gltf);
  const bones = skeleton.bones.length;
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clips: BakedClip[] = [];
  const rows: Float32Array[] = [];
  const m = new THREE.Matrix4();
  for (const want of clipNames) {
    const own = THREE.AnimationClip.findByName(animations, want);
    const laid = own ? undefined : LAID[want];
    const made = own || laid ? undefined : MADE[want];
    const src = THREE.AnimationClip.findByName(animations, laid ?? (made ? made.base : want));
    if (!src) throw new Error(`${name}: no clip ${want}`);
    const clip = inPlace(src, skeleton);
    const seconds = made ? made.seconds : laid ? 1 : clip.duration;
    const frames = laid ? 2 : Math.max(2, Math.round(seconds * BAKE_FPS));
    let lay: THREE.Matrix4 | null = null;
    clips.push({ name: want, start: rows.length, frames, seconds });
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.play();
    const rest = new Map<THREE.Bone, THREE.Quaternion>();
    for (let f = 0; f < frames; f++) {
      mixer.setTime(made || laid ? 0 : (f / frames) * clip.duration);
      if (made) turn(made, skeleton.bones, Math.sin((Math.PI * f) / (frames - 1)), gltf.scene, rest);
      gltf.scene.updateMatrixWorld(true);
      if (laid) lay ??= layout(skeleton.bones);
      const row = new Float32Array(bones * 12);
      skeleton.bones.forEach((b, i) => {
        m.multiplyMatrices(b.matrixWorld, skeleton.boneInverses[i]);
        if (lay) m.premultiply(lay);
        const e = m.elements; // column-major; rows 0..2 go out as three texels
        row.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], i * 12);
      });
      rows.push(row);
    }
    for (const [b, q] of rest) b.quaternion.copy(q);
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
  const above = (b: THREE.Object3D | null): boolean => !!b && (b.name === 'Abdomen' || above(b.parent));
  const upper = Float32Array.from(skeleton.bones, (b) => (above(b) ? 1 : 0));
  return {
    name, lods: levels.map(geometry), bake, bones, clips, materials, joints, upper,
    names: skeleton.bones.map((b) => b.name), parents: Int16Array.from(skeleton.bones, (b) => skeleton.bones.indexOf(b.parent as THREE.Bone)),
    triangles: levels.map((l) => l.index.length / 3), height: hi - lo,
  };
}
