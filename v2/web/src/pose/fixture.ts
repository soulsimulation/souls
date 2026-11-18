// The agreement test's minute (V7, #2716): a small body with the real bodies' bone names (UAL's, as
// `animated-casual.mesh.glb` has them), three clips made here and baked by V6's `bakeModel`, and a recorded minute
// of one body: standing, walking, sitting on a seat, walking on, and pouring with the right hand. Shared by the test
// and the fresh process it asks for one frame. Body files are media, not in git, so CI bakes this one.
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bakeModel, type BakedModel } from '../crowd/bake.ts';
import type { BodyRecord, Points, Sample, Vec } from './pose.ts';

/** [name, parent, local offset] */
const BONES: [string, string | null, Vec][] = [
  ['Root', null, [0, 0, 0]],
  ['Hips', 'Root', [0, 1, 0]],
  ['Abdomen', 'Hips', [0, 0.1, 0]],
  ['Torso', 'Abdomen', [0, 0.15, 0]],
  ['Chest', 'Torso', [0, 0.15, 0]],
  ...(['L', 'R'] as const).flatMap((s): [string, string | null, Vec][] => {
    const x = s === 'L' ? 1 : -1; // facing +z, the body's left is +x
    return [
      [`Shoulder.${s}`, 'Chest', [0.08 * x, 0.1, 0]],
      [`UpperArm.${s}`, `Shoulder.${s}`, [0.1 * x, 0, 0]],
      [`LowerArm.${s}`, `UpperArm.${s}`, [0, -0.28, 0]],
      [`Wrist.${s}`, `LowerArm.${s}`, [0, -0.26, 0]],
      [`Middle1.${s}`, `Wrist.${s}`, [0, -0.08, 0]],
      [`UpperLeg.${s}`, 'Hips', [0.1 * x, -0.05, 0]],
      [`LowerLeg.${s}`, `UpperLeg.${s}`, [0, -0.45, 0]],
      [`Foot.${s}`, `LowerLeg.${s}`, [0, -0.45, 0]],
    ];
  }),
];

const turn = (axis: Vec, deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), (deg * Math.PI) / 180).toArray();
const quats = (bone: string, times: number[], degs: number[], axis: Vec = [1, 0, 0]) =>
  new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, degs.flatMap((d) => turn(axis, d)));

function clips(): THREE.AnimationClip[] {
  return [
    new THREE.AnimationClip('Idle', 2, [quats('Chest', [0, 1, 2], [-3, 3, -3], [0, 0, 1])]),
    new THREE.AnimationClip('Walk', 1, [
      quats('UpperLeg.L', [0, 0.5, 1], [25, -25, 25]), quats('UpperLeg.R', [0, 0.5, 1], [-25, 25, -25]),
      quats('UpperArm.L', [0, 0.5, 1], [-15, 15, -15]), quats('UpperArm.R', [0, 0.5, 1], [15, -15, 15]),
    ]),
    new THREE.AnimationClip('Sitting_Idle_Loop', 2, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 2], [0, 0.55, 0, 0, 0.55, 0]),
      quats('UpperLeg.L', [0, 2], [-90, -90]), quats('UpperLeg.R', [0, 2], [-90, -90]),
      quats('LowerLeg.L', [0, 2], [90, 90]), quats('LowerLeg.R', [0, 2], [90, 90]),
    ]),
  ];
}

/** A clip of `seconds` that holds bone `bone` turned `deg` about `axis` (E11's stand-ins and real clips). */
export function held(name: string, seconds: number, bone: string, deg: number, axis: Vec = [1, 0, 0]): THREE.AnimationClip {
  return new THREE.AnimationClip(name, seconds, [quats(bone, [0, seconds], [deg, deg], axis)]);
}

/** The body, baked as the crowd bakes a body file, with `extra` clips after the three. */
export function model(extra: THREE.AnimationClip[] = []): BakedModel {
  const scene = new THREE.Group();
  const bones = new Map<string, THREE.Bone>();
  for (const [name, parent, at] of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...at);
    bones.set(name, b);
    (parent ? bones.get(parent)! : scene).add(b);
  }
  scene.updateMatrixWorld(true);
  const list = [...bones.values()];
  // A small triangle at each bone, skinned to it alone.
  const pos: number[] = [], skin: number[] = [], weight: number[] = [];
  list.forEach((b, i) => {
    const p = b.getWorldPosition(new THREE.Vector3());
    for (const d of [[0, 0, 0], [0.02, 0, 0], [0, 0.02, 0]]) pos.push(p.x + d[0], p.y + d[1], p.z + d[2]), skin.push(i, 0, 0, 0), weight.push(1, 0, 0, 0);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map(() => 0), 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial());
  scene.add(mesh);
  mesh.bind(new THREE.Skeleton(list));
  const all = [...clips(), ...extra];
  return bakeModel('fixture', { scene } as GLTF, all, all.map((c) => c.name));
}

const S = 1_000_000;
/** The cup's mouth the right hand pours into: straight ahead of where the body stops, at 1.1 m. */
export const MOUTH: Vec = [10.3, 1.1, 12];
/** The pour's start, contact and phase ends, µs. */
export const POUR = { start: 45 * S, ends: [45.7 * S, 48.2 * S, 48.7 * S] };

/** One body's recorded minute, sampled ten times a second. */
export function minute(): BodyRecord {
  const samples: Sample[] = [];
  for (let k = 0; k <= 600; k++) {
    const t = k / 10;
    // 0–5 s stands; 5–15 s walks 12 m along +z; sits 16–30 s; 30–40 s walks 10 m along +x; stands to the end.
    const z = Math.min(12, Math.max(0, (t - 5) * 1.2)), x = Math.min(10, Math.max(0, t - 30));
    samples.push({ at: Math.round(t * S), pos: [x, 0, z] });
  }
  return {
    id: 'body-7f3a',
    samples,
    moves: [
      { name: 'souls:sit', revision: 1, limbs: ['souls:legs'], target: 'bench-2', contact: 'souls:seat', start: 16 * S, ends: [16.6 * S, 17 * S], ended: { at: 17 * S, how: 'done' } },
      { name: 'souls:pour', revision: 1, limbs: ['souls:hand-right'], target: 'cup-9', contact: 'souls:mouth', start: POUR.start, ends: POUR.ends, ended: { at: POUR.ends[2], how: 'done' } },
    ],
  };
}

/** The world's named points: the bench's seat and the cup's mouth. */
export const points: Points = (target, point) =>
  target === 'cup-9' && point === 'souls:mouth' ? MOUTH : target === 'bench-2' && point === 'souls:seat' ? [0, 0.45, 12.4] : null;
