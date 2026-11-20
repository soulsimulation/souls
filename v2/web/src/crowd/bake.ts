// A body model, made ready for the crowd (V6, #2715). Each body file (W3's split: a mesh file and its rig's shared
// clips file, as `mars/viewer/app/engine-view/character-wire.ts` lists them) becomes:
// - one geometry per level with its original UVs and materials, batched per model/material/level; levels 1 and 2
//   are clustered while preserving material and UV seams (`lod.ts`);
// - one texture of bone matrices, every clip baked once at BAKE_FPS: a row per frame, three texels per bone (the top
//   three rows of `bone world × bone inverse`), so the vertex shader skins a body from its clip and phase alone.
// Nothing here runs per body or per frame. A body kind someone authored (B13, #2744) brings its own simple model, made
// at admission by `v2/tools/import-body`; it is drawn as level 2 in place of the clustered one.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { buildCreature } from '../../../../mars/viewer/app/engine-view/creatures.ts';
import { floaterPose } from '../../../../mars/viewer/engine/bodies/pose.ts';
import type { BodyMotion } from '../../../../mars/viewer/engine/bodies/motion.ts';
import { CREATURES, type CreatureId } from '../../../../mars/viewer/engine/bodies/creatures.ts';
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
  sourceMaterials?: THREE.Material[];
  radius?: number;
  centerY?: number;
  walkSpeed?: number;
  /** Authored rigid motion has a time period, independent of travel distance. */
  fixedWalk?: boolean;
};

const loader = new GLTFLoader();
const decodedLoaders = new Map<string, GLTFLoader>();
function loaderFor(decoder?: string): GLTFLoader {
  if (!decoder) return loader;
  let found = decodedLoaders.get(decoder);
  if (!found) {
    const draco = new DRACOLoader().setDecoderPath(decoder).setDecoderConfig({ type: 'wasm' });
    found = new GLTFLoader().setDRACOLoader(draco); decodedLoaders.set(decoder, found);
  }
  return found;
}
const clipFiles = new Map<string, Promise<THREE.AnimationClip[]>>();

/** Loads a body's mesh file and its clips file (shared clips files load once) and bakes `clips`; with `simpleUrl` (a
 *  kind's simple model, `crowd-mesh/1`) that is its level 2. */
export async function loadModel(name: string, meshUrl: string, clipsUrl: string, clips: string[], simpleUrl?: string, options: { decoder?: string; rigidFit?: boolean; yaw?: number } = {}): Promise<BakedModel> {
  const loader = loaderFor(options.decoder);
  let anims = clipFiles.get(clipsUrl);
  if (!anims) clipFiles.set(clipsUrl, (anims = loader.loadAsync(clipsUrl).then((g) => g.animations)));
  const simple = simpleUrl ? fetch(simpleUrl).then(async (r) => {
    if (!r.ok) throw new Error(`${simpleUrl}: ${r.status}`);
    return decodeMesh(new Uint8Array(await r.arrayBuffer()));
  }) : undefined;
  const [mesh, all, low] = await Promise.all([loader.loadAsync(meshUrl), anims, simple]);
  if (options.rigidFit) fitRigid(mesh.scene, options.yaw ?? 0);
  return bakeModel(name, mesh, all, clips, low);
}

/** A body file's bytes, parsed (the importer reads bodies with the crowd's own loader). */
export const parseModel = (bytes: ArrayBuffer, decoder?: string): Promise<GLTF> => loaderFor(decoder).parseAsync(bytes, '');

/** Content-verified bytes are parsed once; embedded images and the pinned decoder retain their source materials. */
export async function bakeBytes(name: string, bytes: Uint8Array, simple: Uint8Array, decoder: string, options: { rigid?: boolean; yaw?: number; motion?: BodyMotion } = {}): Promise<BakedModel> {
  const gltf = await parseModel(bytes.slice().buffer as ArrayBuffer, decoder);
  if (options.rigid) fitRigid(gltf.scene, options.yaw ?? 0);
  return bakeModel(name, gltf, gltf.animations, gltf.animations.map((c) => c.name), decodeMesh(simple), options.motion);
}

/** The merged body in bind pose, in the model's space, with bone indices into the first skeleton's bones. */
/** Apply the existing released rigid-body0.7m fit once, keeping its actual material/UV assets. */
export function fitRigid(scene: THREE.Object3D, yaw = 0): void {
  scene.rotation.y += yaw;
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene), size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (!(extent > 0)) throw new Error('body.empty-geometry');
  const scale = 0.7 / extent, mid = bounds.getCenter(new THREE.Vector3());
  scene.scale.multiplyScalar(scale);
  scene.position.x -= mid.x * scale; scene.position.z -= mid.z * scale;
  scene.position.y -= bounds.min.y * scale;
  scene.updateMatrixWorld(true);
}

export function merge(gltf: GLTF): { mesh: LodMesh; skeleton: THREE.Skeleton; materials: number; sourceMaterials: THREE.Material[] } {
  const parts: THREE.Mesh[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) parts.push(o as THREE.Mesh); });
  if (!parts.length) throw new Error('body.empty-geometry');
  const skinned = parts.filter((p): p is THREE.SkinnedMesh => (p as THREE.SkinnedMesh).isSkinnedMesh);
  const rigid = parts.filter((p) => !(p as THREE.SkinnedMesh).isSkinnedMesh);
  const base = skinned[0]?.skeleton;
  const bones = [...(base?.bones ?? []), ...rigid.map((p) => p as unknown as THREE.Bone)];
  const skeleton = new THREE.Skeleton(bones, [...(base?.boneInverses.map((m) => m.clone()) ?? []), ...rigid.map((p) => p.matrixWorld.clone().invert())]);
  const boneOf = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  const pos: number[] = [], nor: number[] = [], col: number[] = [], uv: number[] = [], materials: number[] = [], si: number[] = [], sw: number[] = [], idx: number[] = [];
  const sourceMaterials: THREE.Material[] = [];
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (const p of parts) {
    const skin = (p as THREE.SkinnedMesh).isSkinnedMesh ? p as THREE.SkinnedMesh : null;
    const matrix = skin ? skin.bindMatrix : p.matrixWorld;
    const g = p.geometry, mats = Array.isArray(p.material) ? p.material : [p.material];
    const localMaterials = mats.map((m) => { let index = sourceMaterials.indexOf(m); if (index < 0) { index = sourceMaterials.length; sourceMaterials.push(m); } return index; });
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), C = g.getAttribute('color'), U = g.getAttribute('uv'), I = g.getAttribute('skinIndex'), W = g.getAttribute('skinWeight');
    const remap = skin ? skin.skeleton.bones.map((b) => { const i = boneOf.get(b.name); if (i === undefined) throw new Error('body.unmatched-rig'); return i; }) : [skeleton.bones.indexOf(p as unknown as THREE.Bone)];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index?.count ?? P.count, materialIndex: 0 }];
    const kept = new Map<string, number>();
    nm.getNormalMatrix(matrix);
    for (const group of groups) {
      const mat = localMaterials[group.materialIndex ?? 0];
      if (mat === undefined) throw new Error('body.material-missing');
      for (let k = group.start; k < group.start + group.count; k++) {
        const i = g.index?.getX(k) ?? k, key = `${i}:${mat}`;
        let to = kept.get(key);
        if (to === undefined) {
          to = pos.length / 3; kept.set(key, to);
          v.fromBufferAttribute(P, i).applyMatrix4(matrix); pos.push(v.x, v.y, v.z);
          if (N) v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); else v.set(0, 1, 0);
          nor.push(v.x, v.y, v.z); col.push(C?.getX(i) ?? 1, C?.getY(i) ?? 1, C?.getZ(i) ?? 1);
          uv.push(U?.getX(i) ?? 0, U?.getY(i) ?? 0); materials.push(mat);
          if (skin) { si.push(remap[I.getX(i)], remap[I.getY(i)], remap[I.getZ(i)], remap[I.getW(i)]); sw.push(W.getX(i), W.getY(i), W.getZ(i), W.getW(i)); }
          else { si.push(remap[0], 0, 0, 0); sw.push(1, 0, 0, 0); }
        }
        idx.push(to);
      }
    }
  }
  return { mesh: { position: new Float32Array(pos), normal: new Float32Array(nor), color: new Float32Array(col), uv: new Float32Array(uv), material: new Uint16Array(materials), skinIndex: new Uint16Array(si), skinWeight: new Float32Array(sw), index: new Uint32Array(idx) }, skeleton, materials: sourceMaterials.length, sourceMaterials };
}

export function geometry(m: LodMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.color, 3));
  if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(m.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(m.skinWeight, 4));
  if (!m.material) g.setIndex(new THREE.BufferAttribute(m.index, 1));
  else {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < m.index.length; i += 3) {
      const mat = m.material[m.index[i]], values = groups.get(mat) ?? [];
      if (m.material[m.index[i + 1]] !== mat || m.material[m.index[i + 2]] !== mat) throw new Error('body.material-seam');
      values.push(m.index[i], m.index[i + 1], m.index[i + 2]); groups.set(mat, values);
    }
    const index: number[] = [];
    for (const [mat, values] of groups) { g.addGroup(index.length, values.length, mat); for (const value of values) index.push(value); }
    g.setIndex(index);
  }
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

export function bakeModel(name: string, gltf: GLTF, animations: THREE.AnimationClip[], clipNames: string[], simple?: LodMesh, motion?: BodyMotion): BakedModel {
  const { mesh, skeleton, materials, sourceMaterials } = merge(gltf);
  const bones = skeleton.bones.length;
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clips: BakedClip[] = [];
  const rows: Float32Array[] = [];
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3(), transformed = new THREE.Vector3(), weighted = new THREE.Vector3();
  let radius = 0;
  const m = new THREE.Matrix4();
  const requested = clipNames.length ? clipNames : ['Idle', 'Walk'];
  for (const want of requested) {
    const src = THREE.AnimationClip.findByName(animations, want) ?? (!animations.length ? new THREE.AnimationClip(want, motion?.[want === 'Walk' ? 'move' : 'idle'].period ?? 2, []) : null);
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
        if (motion) {
          const pose = floaterPose(name, { p: [0, 0, 0], yaw: 0 }, { family: 'floater', type: 'ceramic', radius: 0.35, hoverHeight: 0, motion }, f, clip.duration / frames, want === 'Walk' ? 0.4 : 0);
          const delta = new THREE.Matrix4().compose(new THREE.Vector3(...pose.p), new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.pitch, pose.yaw, pose.roll)), new THREE.Vector3(1, 1, 1));
          m.premultiply(delta);
        }
        const e = m.elements; // column-major; rows 0..2 go out as three texels
        row.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], i * 12);
      });
      for (let i = 0; i < mesh.position.length / 3; i++) {
        point.fromArray(mesh.position, i * 3); weighted.set(0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const weight = mesh.skinWeight[i * 4 + k]; if (!weight) continue;
          const o = mesh.skinIndex[i * 4 + k] * 12;
          transformed.set(row[o] * point.x + row[o + 1] * point.y + row[o + 2] * point.z + row[o + 3], row[o + 4] * point.x + row[o + 5] * point.y + row[o + 6] * point.z + row[o + 7], row[o + 8] * point.x + row[o + 9] * point.y + row[o + 10] * point.z + row[o + 11]);
          weighted.addScaledVector(transformed, weight);
        }
        bounds.expandByPoint(weighted); radius = Math.max(radius, Math.hypot(weighted.x, weighted.z));
      }
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
  const joints = new Float32Array(bones * 3);
  skeleton.boneInverses.forEach((b, i) => joints.set(new THREE.Vector3().setFromMatrixPosition(m.copy(b).invert()).toArray(), i * 3));
  return {
    name, lods: levels.map(geometry), bake, bones, clips, materials, sourceMaterials, joints,
    radius, centerY: (bounds.min.y + bounds.max.y) / 2, fixedWalk: !!motion,
    names: skeleton.bones.map((b) => b.name), parents: Int16Array.from(skeleton.bones, (b) => skeleton.bones.indexOf(b.parent as THREE.Bone)),
    triangles: levels.map((l) => l.index.length / 3), height: bounds.max.y - bounds.min.y,
  };
}

/** Released procedural source sampled once per model. Instance roots always come from the authoritative track. */
export function bakeCreature(species: CreatureId): BakedModel {
  const rig = buildCreature(species), frames = 60, duration = 2;
  // Released rigs face +X; the existing crowd's model-forward axis is +Z.
  rig.root.rotation.y = -Math.PI / 2;
  const gltf = { scene: rig.root } as GLTF;
  const merged = merge(gltf), rows: Float32Array[] = [], clips: BakedClip[] = [];
  let radius = 0, low = Infinity, high = -Infinity;
  const point = new THREE.Vector3(), moved = new THREE.Vector3(), matrix = new THREE.Matrix4();
  for (const mode of ['idle', 'walk'] as const) {
    clips.push({ name: mode === 'idle' ? 'Idle' : 'Walk', start: rows.length, frames, seconds: duration });
    for (let f = 0; f < frames; f++) {
      rig.animate({ mode, speed: mode === 'walk' ? CREATURES[species].speed : 0, t: f / BAKE_FPS, dt: 1 / BAKE_FPS });
      rig.root.updateMatrixWorld(true);
      const row = new Float32Array(merged.skeleton.bones.length * 12);
      merged.skeleton.bones.forEach((b, i) => {
        matrix.multiplyMatrices(b.matrixWorld, merged.skeleton.boneInverses[i]); const e = matrix.elements;
        row.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], i * 12);
      });
      for (let v = 0; v < merged.mesh.position.length / 3; v++) {
        point.fromArray(merged.mesh.position, v * 3); const o = merged.mesh.skinIndex[v * 4] * 12;
        moved.set(row[o] * point.x + row[o + 1] * point.y + row[o + 2] * point.z + row[o + 3], row[o + 4] * point.x + row[o + 5] * point.y + row[o + 6] * point.z + row[o + 7], row[o + 8] * point.x + row[o + 9] * point.y + row[o + 10] * point.z + row[o + 11]);
        radius = Math.max(radius, Math.hypot(moved.x, moved.z)); low = Math.min(low, moved.y); high = Math.max(high, moved.y);
      }
      rows.push(row);
    }
  }
  const data = new Float32Array(rows.length * merged.skeleton.bones.length * 12); rows.forEach((row, i) => data.set(row, i * row.length));
  const bake = new THREE.DataTexture(data, merged.skeleton.bones.length * 3, rows.length, THREE.RGBAFormat, THREE.FloatType);
  bake.minFilter = bake.magFilter = THREE.NearestFilter; bake.needsUpdate = true;
  const levels = [merged.mesh, ...LOD_CELLS.map((cell) => cluster(merged.mesh, cell))];
  // Geometry/materials are detached from the source rig before disposal: one bake, never a rig per Soul.
  const sourceMaterials = merged.sourceMaterials.map((material) => material.clone());
  rig.dispose();
  return { name: `creature:${species}`, lods: levels.map(geometry), bake, bones: merged.skeleton.bones.length, names: merged.skeleton.bones.map((_, i) => `part-${i}`), parents: Int16Array.from(merged.skeleton.bones, () => -1), joints: new Float32Array(merged.skeleton.bones.length * 3), clips, materials: sourceMaterials.length, sourceMaterials, triangles: levels.map((level) => level.index.length / 3), height: high - low, centerY: (high + low) / 2, radius, walkSpeed: CREATURES[species].speed };
}

/** A derived artifact of the actual released procedural source, not a substitute GLB. */
export function encodeBaked(model: BakedModel): Uint8Array {
  const levels = model.lods.map((g) => ({ attributes: Object.fromEntries(['position', 'normal', 'color', 'uv', 'skinIndex', 'skinWeight'].filter((key) => g.hasAttribute(key)).map((key) => [key, Array.from(g.getAttribute(key).array)])), index: Array.from(g.index!.array), groups: g.groups }));
  const materials = (model.sourceMaterials ?? []).map((m) => { const { uuid: _uuid, metadata: _metadata, ...data } = m.toJSON(); return data; });
  return new TextEncoder().encode(JSON.stringify({ format: 'souls/procedural-bake/1', name: model.name, levels, materials, bones: model.bones, names: model.names, parents: Array.from(model.parents), joints: Array.from(model.joints), clips: model.clips, data: Array.from(model.bake.image.data as Float32Array), height: model.height, centerY: model.centerY, radius: model.radius, walkSpeed: model.walkSpeed }));
}
export function decodeBaked(bytes: Uint8Array): BakedModel {
  const m = JSON.parse(new TextDecoder().decode(bytes));
  const finite = (a: unknown, length: number): a is number[] => Array.isArray(a) && a.length === length && a.every(Number.isFinite);
  if (m.format !== 'souls/procedural-bake/1' || !/^creature:(duck|snail|dog)$/.test(m.name) || !Number.isInteger(m.bones) || m.bones < 1 || m.bones > 512 || !Array.isArray(m.levels) || m.levels.length !== 3 || !Array.isArray(m.clips) || m.clips.length !== 2 || !Array.isArray(m.materials) || m.materials.length < 1 || m.materials.length > 128 || !['height', 'radius', 'walkSpeed'].every((key) => Number.isFinite(m[key]) && m[key] > 0) || !Number.isFinite(m.centerY) || !finite(m.parents, m.bones) || !finite(m.joints, m.bones * 3) || !Array.isArray(m.names) || m.names.length !== m.bones || !m.names.every((name: unknown) => typeof name === 'string')) throw new Error('body.bake-invalid');
  let rows = 0;
  for (const [i, clip] of m.clips.entries()) {
    if (clip.name !== ['Idle', 'Walk'][i] || clip.start !== rows || !Number.isInteger(clip.frames) || clip.frames < 2 || clip.frames > 360 || !Number.isFinite(clip.seconds) || clip.seconds <= 0) throw new Error('body.bake-invalid');
    rows += clip.frames;
  }
  if (!finite(m.data, m.bones * 12 * rows)) throw new Error('body.bake-invalid');
  const lods = m.levels.map((level: { attributes: Record<string, unknown>; index: number[]; groups: { start: number; count: number; materialIndex: number }[] }) => {
    const g = new THREE.BufferGeometry(), attributes = level.attributes, positions = attributes.position;
    if (!Array.isArray(positions) || positions.length % 3 || positions.length < 9 || positions.length > 600000) throw new Error('body.bake-invalid');
    const vertices = positions.length / 3;
    for (const [key, size] of Object.entries({ position: 3, normal: 3, color: 3, uv: 2, skinIndex: 4, skinWeight: 4 })) {
      const a = attributes[key];
      if (!finite(a, vertices * size) || (key === 'skinIndex' && a.some((v) => !Number.isInteger(v) || v < 0 || v >= m.bones))) throw new Error('body.bake-invalid');
      g.setAttribute(key, new THREE.BufferAttribute(key === 'skinIndex' ? new Uint16Array(a) : new Float32Array(a), size));
    }
    if (!Array.isArray(level.index) || !level.index.length || level.index.length % 3 || level.index.length > 600000 || level.index.some((v) => !Number.isInteger(v) || v < 0 || v >= vertices) || !Array.isArray(level.groups)) throw new Error('body.bake-invalid');
    let end = 0;
    for (const group of level.groups) {
      if (group.start !== end || !Number.isInteger(group.count) || group.count < 0 || group.count % 3 || !Number.isInteger(group.materialIndex) || group.materialIndex < 0 || group.materialIndex >= m.materials.length) throw new Error('body.bake-invalid');
      end += group.count; g.addGroup(group.start, group.count, group.materialIndex);
    }
    if (end !== level.index.length) throw new Error('body.bake-invalid');
    g.setIndex(level.index); return g;
  });
  const bake = new THREE.DataTexture(new Float32Array(m.data), m.bones * 3, rows, THREE.RGBAFormat, THREE.FloatType); bake.minFilter = bake.magFilter = THREE.NearestFilter; bake.needsUpdate = true;
  return { name: m.name, bones: m.bones, names: m.names, clips: m.clips, height: m.height, radius: m.radius, centerY: m.centerY, walkSpeed: m.walkSpeed, lods, bake, parents: new Int16Array(m.parents), joints: new Float32Array(m.joints), sourceMaterials: m.materials.map((data: Record<string, unknown>, i: number) => new THREE.MaterialLoader().parse({ ...data, uuid: `core-material-${i}` })), materials: m.materials.length, triangles: lods.map((g: THREE.BufferGeometry) => g.index!.count / 3) };
}
