// One draw per classic body. A classic Soul GLB (casual, punk, woman) is 9 to 13 skinned primitives, one per material,
// each its own draw call and its own shadow-pass draw, each with its own skeleton the renderer updates every frame:
// 100 Souls cost about 2,000 body draws. Their finished materials differ only in base colour, finish role and
// roughness, which the humanoid@2 palette material (apps/web/src/humanoid/material.ts) takes per vertex: so the
// primitives draw as one skinned mesh with one material.
//
// Render-only. The original primitives stay in the rig, hidden: measurements (contacts, rest samples, front depths),
// picking and the human presets still read them exactly as before; the merged mesh is skipped by those (`BODY_DRAW`)
// and is never picked. A preset that recolours the primitives shows them again (`setBodyMerged`). Within one body the
// triangles keep the order the renderer drew the primitives in (by material, then scene order), so coplanar parts
// (eyes, brows) resolve as before. `?merge=0` keeps the separate draws for A/B (as compose.ts does for composed looks).
import * as THREE from 'three';
import type {Rig, Template} from './people.ts';
import {humanFinishRoleIdOf} from './content/details/human-presets/finish.ts';
import {humanoidMaterial} from '../../../../apps/web/src/humanoid/material.ts';

/** userData flag of the merged draw: body measurements and picking skip it. */
export const BODY_DRAW = 'bodyDraw';
const MERGE_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('merge') === '0';
const PALETTE_SLOTS = 16;
type Merged = {geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial; parts: number};
const merged = new WeakMap<Template, Merged>();

const skinnedOf = (root: THREE.Object3D) => { const out: THREE.SkinnedMesh[] = []; root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh); }); return out; };
const allOnes = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => { for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) if (a.getComponent(i, c) !== 1) return false; return true; };
/** A material the palette material reproduces exactly: finished, opaque, plain, no maps. */
function plain(m: THREE.Material | THREE.Material[]): m is THREE.MeshStandardMaterial {
  if (Array.isArray(m) || !(m instanceof THREE.MeshStandardMaterial) || Object.getPrototypeOf(m) !== THREE.MeshStandardMaterial.prototype) return false;
  return humanFinishRoleIdOf(m) !== null && m.metalness === 0 && m.opacity === 1 && !m.transparent && m.alphaTest === 0 && m.side === THREE.DoubleSide && !m.map && !m.roughnessMap && !m.metalnessMap
    && !m.normalMap && !m.bumpMap && !m.aoMap && !m.emissiveMap && !m.alphaMap && !m.lightMap && !m.envMap && !m.displacementMap && m.emissive.getHex() === 0 && !m.flatShading && !m.wireframe
    && m.depthTest && m.depthWrite && m.colorWrite && m.visible && !m.polygonOffset && m.shadowSide === null && m.fog && m.toneMapped && m.envMapIntensity === 1;
}

/** The template's primitives as one geometry and one palette material, or null when they cannot draw as one. */
export function mergedBody(t: Template): Merged | null {
  const known = merged.get(t); if (known) return known;
  const meshes = skinnedOf(t.gltf.scene);
  if (meshes.length < 2) return null;
  const first = meshes[0], bones = first.skeleton.bones, inv = first.skeleton.boneInverses;
  t.gltf.scene.updateMatrixWorld(true);
  for (const m of meshes) {
    const g = m.geometry;
    if (!plain(m.material) || !m.matrixWorld.equals(first.matrixWorld) || !m.bindMatrix.equals(first.bindMatrix) || !g.index || g.morphAttributes.position || g.groups.length > 1) return null;
    if (!g.attributes.position || !g.attributes.normal || !g.attributes.skinIndex || !g.attributes.skinWeight || (g.attributes.color && !allOnes(g.attributes.color))) return null;
    const s = m.skeleton; if (s.bones.length !== bones.length || s.bones.some((b, i) => b !== bones[i] || !s.boneInverses[i].equals(inv[i]))) return null;
  }
  const mats = [...new Set(meshes.map(m => m.material as THREE.MeshStandardMaterial))];
  if (mats.length > PALETTE_SLOTS) return null;
  const n = meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), info = new Float32Array(n * 4);
  const palette = new Float32Array(PALETTE_SLOTS * 3), starts: number[] = [];
  mats.forEach((m, i) => palette.set([m.color.r, m.color.g, m.color.b], i * 3));
  // vertices in scene order (each primitive's block as it was); hinfo: palette slot, finish role, roughness·255
  let v = 0;
  for (const m of meshes) {
    const a = m.geometry.attributes, c = a.position.count, mat = m.material as THREE.MeshStandardMaterial, slot = mats.indexOf(mat), role = humanFinishRoleIdOf(mat)!;
    starts.push(v);
    for (let i = 0; i < c; i++, v++) {
      for (let k = 0; k < 3; k++) { pos[v * 3 + k] = a.position.getComponent(i, k); nor[v * 3 + k] = a.normal.getComponent(i, k); }
      for (let k = 0; k < 4; k++) { si[v * 4 + k] = a.skinIndex.getComponent(i, k); sw[v * 4 + k] = a.skinWeight.getComponent(i, k); }
      info.set([slot, role, mat.roughness * 255, 0], v * 4);
    }
  }
  // triangles in the order the renderer drew the primitives: by material id, then scene order (its stable sort)
  const order = meshes.map((m, i) => i).sort((x, y) => (meshes[x].material as THREE.Material).id - (meshes[y].material as THREE.Material).id || x - y);
  const total = meshes.reduce((a, m) => a + m.geometry.index!.count, 0), index = new (n < 65536 ? Uint16Array : Uint32Array)(total);
  let t0 = 0;
  for (const k of order) { const I = meshes[k].geometry.index!, base = starts[k]; for (let i = 0; i < I.count; i++) index[t0++] = I.getX(i) + base; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geometry.setAttribute('hinfo', new THREE.BufferAttribute(info, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.name = 'body';
  const out = {geometry, material: humanoidMaterial(palette, 0), parts: meshes.length};
  merged.set(t, out);
  return out;
}

/** In a fresh rig (just made by createRig): add the merged draw beside the primitives and hide them. */
export function mergeRigBody(rig: Pick<Rig, 'model' | 'template'>): THREE.SkinnedMesh | null {
  if (MERGE_OFF) return null;
  const m = mergedBody(rig.template); if (!m) return null;
  const parts = skinnedOf(rig.model); if (parts.length !== m.parts) return null;
  const first = parts[0], body = new THREE.SkinnedMesh(m.geometry, m.material);
  body.name = 'body'; body.userData[BODY_DRAW] = true; body.raycast = () => {};
  body.castShadow = first.castShadow; body.receiveShadow = first.receiveShadow; body.frustumCulled = first.frustumCulled;
  body.position.copy(first.position); body.quaternion.copy(first.quaternion); body.scale.copy(first.scale);
  first.parent!.add(body);
  body.bind(first.skeleton, first.bindMatrix);
  for (const p of parts) p.visible = false;
  return body;
}

/** Draw the body merged (true) or as its primitives (false: a preset recoloured them). No-op for an unmerged rig. */
export function setBodyMerged(rig: Pick<Rig, 'model'>, on: boolean) {
  let body: THREE.Object3D | null = null; const parts: THREE.Object3D[] = [];
  rig.model.traverse(o => { if (o.userData[BODY_DRAW]) body = o; else if ((o as THREE.SkinnedMesh).isSkinnedMesh) parts.push(o); });
  if (!body) return;
  (body as THREE.Object3D).visible = on; for (const p of parts) p.visible = !on;
}
