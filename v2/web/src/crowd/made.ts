// Clips made at bake time (#3741, #3757): today's procedural gestures that have no library clip, built on a base
// clip's first frame from the rig itself, as today's renderer builds them (`mars/viewer/app/engine-view/
// activity-poses.ts`, applied by `humans.ts`). A made clip is a function of its fraction `u` (0..1) giving:
// - turns: named bones turned in the world about their own joint, about the body's sideways (x: + leans forward),
//   forward (z: + leans to the body's right) or up (y) axis, in radians;
// - hands: today's hand goals, each relative to that arm's shoulder (the upper arm's joint) as [forward, outward, up]
//   metres, reached by two-bone IK with today's elbow pole (outward, down, a little back), and `k`, how far each arm
//   goes from the base pose toward its reach (today's hand weight: the bones are slerped, never stretched).
// Every made clip here is a one-shot fitted to its move (`./gestures.ts`) and starts and ends on the base pose, so
// the gesture's weight only ever blends poses near each other.
import * as THREE from 'three';

/** A hand goal relative to its shoulder: [forward, outward, up] metres (activity-poses.ts's HandGoal). */
export type HandGoal = readonly [number, number, number];
export type MadeFrame = {
  turns?: [bone: string, axis: 'x' | 'y' | 'z', rad: number][];
  /** [left, right]; null leaves the arm as the base clip has it. */
  hands?: [HandGoal | null, HandGoal | null];
  /** How far the arms go toward their goals (0..1). */
  k?: number;
  /** Outward is measured from the body's midline (between the shoulders) rather than each shoulder: hands that meet. */
  mid?: boolean;
};
export type Made = { base: string; seconds: number; frame: (u: number) => MadeFrame };

const S = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
/** In by `a`, out from `b` (fractions of the clip), smoothed: the arms' weight over a one-shot. */
const env = (u: number, a: number, b: number) => S(u / a) * (1 - S((u - b) / (1 - b)));

export const MADE: Readonly<Record<string, Made>> = {
  // activity-poses.ts's bow: the back 0.55 rad over three bones and the head 0.2, on a half sine.
  Bow: { base: 'Idle', seconds: 1, frame: (u) => {
    const k = Math.sin(Math.PI * u);
    return { turns: [['Abdomen', 'x', 0.15 * k], ['Torso', 'x', 0.2 * k], ['Chest', 'x', 0.2 * k], ['Neck', 'x', 0.2 * k]] };
  } },
  // clap: both hands in front of the chest (today's goals ahead and below the shoulders), meeting at the midline and
  // parting 7 cm, at today's 2.2 claps a second (its 0.9 s move holds one clap at full reach); the head a little down.
  // The IK places the wrists, so they stop 3 cm each side of the midline, where the palms meet.
  Clap: { base: 'Idle', seconds: 0.9, frame: (u) => {
    const c = Math.abs(Math.sin(Math.PI * 2.2 * 0.9 * u)), k = env(u, 0.35, 0.8);
    const out = 0.03 + 0.035 * c;
    return { hands: [[0.34, out, -0.18], [0.34, out, -0.2]], k, mid: true, turns: [['Neck', 'x', 0.05 * k]] };
  } },
  // point: the right hand out ahead at shoulder height (today's goal at full: [0.58, 0.12, 0.02]), the head a little
  // up; held from contact to the end of the move, then down.
  Point: { base: 'Idle', seconds: 0.8, frame: (u) => {
    const k = env(u, 0.4, 0.7);
    return { hands: [null, [0.58, 0.12, 0.02]], k, turns: [['Neck', 'x', -0.05 * k]] };
  } },
  // shrug (today has the word, not a pose): the shoulders up (about today's 5 cm shrug of the girdle), forearms out
  // with the palms open at the waist, the head tipped a little to one side, and back.
  Shrug: { base: 'Idle', seconds: 0.6, frame: (u) => {
    const k = env(u, 0.4, 0.6);
    return {
      hands: [[0.2, 0.22, -0.4], [0.2, 0.22, -0.4]], k,
      turns: [['ShoulderL', 'z', 0.6 * k], ['ShoulderR', 'z', -0.6 * k], ['Neck', 'z', 0.12 * k]],
    };
  } },
  // stretch: both hands straight up over the head (today's [0.02, 0.05, 0.62]) and the body leaning to one side and
  // the other (today's 0.28 rad, over three bones), then down.
  Stretch: { base: 'Idle', seconds: 1.5, frame: (u) => {
    const k = env(u, 0.35, 0.75), side = 0.28 * Math.sin(2 * Math.PI * S((u - 0.25) / 0.6)) * k;
    return {
      hands: [[0.02, 0.05, 0.62], [0.02, 0.05, 0.62]], k,
      turns: [['Abdomen', 'z', side * 0.3], ['Torso', 'z', side * 0.35], ['Chest', 'z', side * 0.35]],
    };
  } },
};

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const _q = new THREE.Quaternion(), _r = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

/** A bone by its rig name; three drops the dot from glTF names (`UpperArm.L` loads as `UpperArmL`). */
const find = (bones: THREE.Bone[], name: string) => bones.find((b) => b.name.replace('.', '') === name);

/** Turns `b` by the world rotation `r` about its own joint: local' = local × (world⁻¹ × r × world). */
function rotate(b: THREE.Bone, r: THREE.Quaternion): void {
  b.getWorldQuaternion(_q);
  b.quaternion.multiply(_q.clone().invert().multiply(r).multiply(_q));
  b.updateMatrixWorld(true);
}

/** Two-bone IK: `upper`'s joint stays, the elbow bends toward `pole`, the wrist reaches `target` (or as near as 0.98
 *  of the arm's length, as today's `armTo`). */
function reach(upper: THREE.Bone, lower: THREE.Bone, wrist: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3): void {
  const s = upper.getWorldPosition(new THREE.Vector3()), e = lower.getWorldPosition(new THREE.Vector3()), w = wrist.getWorldPosition(new THREE.Vector3());
  const a = s.distanceTo(e), b = e.distanceTo(w);
  const dir = _a.subVectors(target, s);
  const d = Math.min(0.98 * (a + b), Math.max(Math.abs(a - b) + 1e-3, dir.length()));
  dir.normalize();
  const along = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - along * along));
  const p = _b.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  const elbow = _c.copy(s).addScaledVector(dir, along).addScaledVector(p, h), hand = _d.copy(s).addScaledVector(dir, d);
  rotate(upper, _r.setFromUnitVectors(e.sub(s).normalize(), elbow.clone().sub(s).normalize()));
  const e2 = lower.getWorldPosition(new THREE.Vector3()), w2 = wrist.getWorldPosition(new THREE.Vector3());
  rotate(lower, _r.setFromUnitVectors(w2.sub(e2).normalize(), hand.sub(e2).normalize()));
}

/** Poses the skeleton as `made` at `u`, from the base pose the mixer left; `rest` keeps each touched bone's base
 *  rotation across frames (a bone the base clip does not animate keeps nothing from the last frame). */
export function pose(made: Made, u: number, bones: THREE.Bone[], root: THREE.Object3D, rest: Map<THREE.Bone, THREE.Quaternion>): void {
  const f = made.frame(u);
  const arms = (['L', 'R'] as const).map((s) => ['UpperArm', 'LowerArm', 'Wrist'].map((n) => find(bones, n + s)));
  const touched = [...(f.turns ?? []).map(([n]) => find(bones, n)), ...arms.flat()].filter((b): b is THREE.Bone => !!b);
  for (const b of touched) if (!rest.has(b)) rest.set(b, b.quaternion.clone());
  for (const [b, q] of rest) b.quaternion.copy(q);
  root.updateMatrixWorld(true);
  for (const [n, axis, rad] of f.turns ?? []) {
    const b = find(bones, n);
    if (b && rad) rotate(b, _r.setFromAxisAngle(AXES[axis], rad));
  }
  const k = f.k ?? 1;
  if (!f.hands || k <= 0) return;
  const midX = f.mid && arms[0][0] && arms[1][0] ? (arms[0][0].getWorldPosition(_a).x + arms[1][0].getWorldPosition(_b).x) / 2 : null;
  f.hands.forEach((goal, i) => {
    const [upper, lower, wrist] = arms[i];
    if (!goal || !upper || !lower || !wrist) return;
    // The body faces +z with its left along +x: outward is +x for the left arm and -x for the right.
    const out = i === 0 ? 1 : -1;
    const from = [upper.quaternion.clone(), lower.quaternion.clone()];
    const target = upper.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(out * goal[1], goal[2], goal[0]));
    if (midX !== null) target.x = midX + out * goal[1];
    reach(upper, lower, wrist, target, new THREE.Vector3(out * 0.6, -0.5, -0.2));
    // Toward the reach by k: each bone slerped from the base pose, so an arm on its way never shortens.
    upper.quaternion.slerpQuaternions(from[0], upper.quaternion.clone(), k);
    lower.quaternion.slerpQuaternions(from[1], lower.quaternion.clone(), k);
    upper.updateMatrixWorld(true);
  });
}
