// Viewer-only contact with an authored incense tip; native motion/targets stay authoritative.
import * as THREE from 'three';
import {handActuatorFrame, type HandActuatorMotion} from '../../engine/social/hand-actuator.ts';
import {armTo, BODY_MODEL, curlHand, ik, palm, setWorldQuat, swing, type Arm} from './rig.ts';

export type IncenseTipContext = {
  target: string;
  revision: string;
  tip: readonly [number, number, number];
  tipRadius: number;
  bowlTop: number;
  /** World-space horizontal envelope of the authored solid kit, not the smoke. */
  centre: readonly [number, number, number];
  radius: number;
};
export type ArmUnderlay = {o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion}[];
export const armUnderlay = (arm: Arm): ArmUnderlay =>
  [...(arm.shoulder ? [arm.shoulder] : []), arm.upper, arm.lower, arm.hand, ...arm.fingers, ...arm.thumb]
    .map(o => ({o, p: o.position.clone(), q: o.quaternion.clone()}));
const restore = (pose: ArmUnderlay) => {for (const b of pose) {b.o.position.copy(b.p); b.o.quaternion.copy(b.q);}};
const V = () => new THREE.Vector3();
const P = (o: THREE.Object3D) => o.getWorldPosition(V());
export type TipSkin = ((visit: (p: THREE.Vector3) => void) => boolean | void) & {valid?: () => boolean};
const finiteVector = (v: THREE.Vector3) => [v.x, v.y, v.z].every(Number.isFinite);
const finiteQuaternion = (q: THREE.Quaternion) => [q.x, q.y, q.z, q.w].every(Number.isFinite) && Number.isFinite(q.lengthSq()) && q.lengthSq() > 0;
const finiteTriple = (v: readonly number[]) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const validContext = (c: IncenseTipContext) => !!c && finiteTriple(c.tip) && finiteTriple(c.centre) &&
  Number.isFinite(c.tipRadius) && c.tipRadius > 0 && Number.isFinite(c.radius) && c.radius > 0 && Number.isFinite(c.bowlTop);
const armObjects = (a: Arm) => [...(a.shoulder ? [a.shoulder] : []), a.upper, a.lower, a.hand, ...a.fingers, ...a.thumb];
const validArm = (a: Arm) => armObjects(a).every(o => finiteVector(o.position) && finiteVector(o.scale) && finiteQuaternion(o.quaternion) &&
  o.matrixWorld.elements.every(Number.isFinite));
const belongsTo = (o: THREE.Object3D, root: THREE.Object3D) => {
  let parent: THREE.Object3D | null = o;
  for (let i = 0; parent && i < 128; i++, parent = parent.parent) if (parent === root) return true;
  return false;
};
const validUnderlay = (a: Arm, pose: ArmUnderlay) => {
  const objects = new Set(armObjects(a));
  return pose.length === objects.size && new Set(pose.map(b => b.o)).size === objects.size &&
    pose.every(b => objects.has(b.o) && finiteVector(b.p) && finiteQuaternion(b.q));
};

/** Isolate the external skin reader, while allowing a visitor programming error to surface. */
function readSkin(skin: TipSkin, visit: (p: THREE.Vector3) => void): boolean {
  let count = 0, finite = true, visitorError: unknown, visitorThrew = false;
  try {
    const supported = skin(p => {
      if (!p?.isVector3 || !finiteVector(p)) {finite = false; return;}
      count++;
      try {visit(p);} catch (error) {visitorThrew = true; visitorError = error; throw error;}
    });
    return supported !== false && finite && count > 0;
  } catch (error) {
    if (visitorThrew && error === visitorError) throw error;
    return false;
  }
}

type SkinAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
const attributeStamp = (attribute: SkinAttribute) => {
  const storage = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data : attribute;
  return {attribute, storage, array: storage.array, version: storage.version, count: attribute.count, itemSize: attribute.itemSize};
};
type SkinRef = {mesh: THREE.SkinnedMesh; indices: number[]};
function skinAttributes(mesh: THREE.SkinnedMesh) {
  const position = mesh.geometry?.attributes.position, si = mesh.geometry?.attributes.skinIndex, sw = mesh.geometry?.attributes.skinWeight;
  if (!position || !si || !sw || position.itemSize !== 3 || si.itemSize !== 4 || sw.itemSize !== 4 ||
    position.count !== si.count || si.count !== sw.count || !Array.isArray(mesh.skeleton?.bones) || !mesh.skeleton.bones.length ||
    !mesh.skeleton.bones.every(b => b?.isBone) || !Array.isArray(mesh.skeleton.boneInverses) ||
    mesh.skeleton.boneInverses.length !== mesh.skeleton.bones.length) return null;
  return {position, si, sw};
}
const vertexWeightsValid = (si: SkinAttribute, sw: SkinAttribute, i: number, bones: number) => {
  let weight = 0;
  for (let j = 0; j < 4; j++) {
    const b = si.getComponent(i, j), w = sw.getComponent(i, j);
    if (!Number.isInteger(b) || b < 0 || b >= bones || !Number.isFinite(w) || w < 0 || w > 1) return false;
    weight += w;
  }
  return weight > 0;
};
/** Only the actor's cached mesh refs are checked. Normal bone poses/matrices remain dynamic. */
function cachedSkin(root: THREE.Object3D, refs: SkinRef[]): TipSkin {
  const stamps = refs.map(r => {
    const geometry = r.mesh.geometry, skeleton = r.mesh.skeleton;
    return {...r, geometry, skeleton, bones: skeleton.bones.slice(), names: skeleton.bones.map(b => b.name), parents: skeleton.bones.map(b => b.parent),
      inverses: skeleton.boneInverses.slice(), index: geometry.index, indexStamp: geometry.index ? attributeStamp(geometry.index) : null,
      attributes: Object.entries(geometry.attributes).filter(([name]) => ['position', 'skinIndex', 'skinWeight'].includes(name))
        .map(([name, a]) => ({name, ...attributeStamp(a)})),
      morphs: (geometry.morphAttributes.position ?? []).map(attributeStamp)};
  });
  let supported = stamps.length > 0;
  const stampValid = (s: ReturnType<typeof attributeStamp>) => {
    const storage = s.attribute instanceof THREE.InterleavedBufferAttribute ? s.attribute.data : s.attribute;
    return storage === s.storage && storage.array === s.array && storage.version === s.version &&
      s.attribute.count === s.count && s.attribute.itemSize === s.itemSize;
  };
  const valid = () => {
    if (!supported) return false;
    supported = stamps.every(s => {
      return belongsTo(s.mesh, root) && s.mesh.geometry === s.geometry && s.mesh.skeleton === s.skeleton && s.geometry.index === s.index &&
        !!s.geometry.attributes && !!s.geometry.morphAttributes &&
        (!s.indexStamp || stampValid(s.indexStamp)) &&
        s.attributes.length === 3 && s.attributes.every(a => s.geometry.attributes[a.name] === a.attribute && stampValid(a)) &&
        (s.geometry.morphAttributes.position ?? []).length === s.morphs.length &&
        s.morphs.every((a, i) => s.geometry.morphAttributes.position?.[i] === a.attribute && stampValid(a)) &&
        Array.isArray(s.skeleton.bones) && s.skeleton.bones.length === s.bones.length &&
        s.bones.every((b, i) => s.skeleton.bones[i] === b && b.name === s.names[i] && b.parent === s.parents[i]) &&
        Array.isArray(s.skeleton.boneInverses) && s.skeleton.boneInverses.length === s.inverses.length && s.inverses.every((b, i) => s.skeleton.boneInverses[i] === b) &&
        s.mesh.matrixWorld.elements.every(Number.isFinite) && s.mesh.bindMatrix.elements.every(Number.isFinite) &&
        s.mesh.bindMatrixInverse.elements.every(Number.isFinite);
    });
    return supported;
  };
  const skin: TipSkin = visit => {
    if (!valid()) return false;
    const p = V();
    for (const r of stamps) for (const i of r.indices) {
      // A failed owned-mesh read is unsupported depiction data, not an exception
      // that can stop another actor. The visitor runs outside this boundary.
      try {
        const {skinIndex: si, skinWeight: sw} = r.geometry.attributes;
        if (!vertexWeightsValid(si, sw, i, r.bones.length)) {supported = false; return false;}
        r.mesh.getVertexPosition(i, p); p.applyMatrix4(r.mesh.matrixWorld);
      }
      catch {supported = false; return false;}
      if (!finiteVector(p)) {supported = false; return false;}
      visit(p);
    }
    return true;
  };
  skin.valid = valid;
  return skin;
}
export type IncenseTouchGoal = {
  shoulder: THREE.Vector3;
  chainLength: number;
  rawTip: THREE.Vector3;
  rawPalm: THREE.Vector3;
  rawWrist: THREE.Vector3;
  plannedTip: THREE.Vector3;
  /** Genuine planned request, captured before the one IK solve. */
  requestedPalm: THREE.Vector3;
  requestedWrist: THREE.Vector3;
  planningDelta: THREE.Vector3;
  work: IncenseTipWork;
  attainedPalm: THREE.Vector3;
  attainedWrist: THREE.Vector3;
  direction: THREE.Vector3;
  wristExtension: number;
};

export type IncenseTipWork = {directionIterations: number; orientations: number; skinVisits: number; touchIK: number; bracketMetres: number};
export type IncenseTipFailure = {reason: 'incense.tip-domain' | 'incense.tip-skin' | 'incense.tip-bracket' | 'incense.tip-accuracy' | 'incense.tip-contact-infeasible'; work: IncenseTipWork};
const TIP_ACCURACY = .000002;
const DIRECTION_STEPS = 24;

/** Bounded rig-local refs, made once when the opted-in depiction first needs this arm.
 * The anchor is actual terminal-index skin, rather than the wrist/palm landmark. */
export function indexTipSkin(root: THREE.Object3D, arm: Arm): TipSkin | null {
  const terminal = arm.fingers[3];
  if (!terminal) return null;
  const refs: {mesh: THREE.SkinnedMesh; indices: number[]}[] = [];
  let supported = true;
  root.traverse(o => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const attributes = skinAttributes(mesh);
    if (!attributes) {supported = false; return;}
    const {si, sw} = attributes, bone = mesh.skeleton.bones.indexOf(terminal as THREE.Bone);
    if (bone < 0) return;
    const indices: number[] = [];
    for (let i = 0; i < si.count; i++) {
      if (!vertexWeightsValid(si, sw, i, mesh.skeleton.bones.length)) {supported = false; return;}
      for (let j = 0; j < 4; j++) if (si.getComponent(i, j) === bone && sw.getComponent(i, j) > 0) {indices.push(i); break;}
    }
    if (indices.length) refs.push({mesh, indices});
  });
  if (!supported || !refs.length) return null;
  return cachedSkin(root, refs);
}

/** Final arm-only layer, after generic IK/curl. `underlay` is captured immediately before
 * generic arm IK, so neither its closed grip nor a later blend can undo the fitted finger.
 * The other hand, body, motion, bone lengths and fixture are never changed here. */
export function poseIncenseTipTouch(arm: Arm, body: THREE.Object3D, context: IncenseTipContext,
  motion: HandActuatorMotion, seconds: number, underlay: ArmUnderlay, skin: TipSkin,
  observe?: (goal: IncenseTouchGoal) => void, fail?: (failure: IncenseTipFailure) => void): boolean {
  const work: IncenseTipWork = {directionIterations: 0, orientations: 0, skinVisits: 0, touchIK: 0, bracketMetres: 0};
  if (!context || !motion) {fail?.({reason: 'incense.tip-domain', work}); return false;}
  if (motion.target !== context.target || motion.opening || motion.stroke || motion.slide || motion.tug || motion.op ||
    arm.fingers.length !== 16 || arm.thumb.length !== 3) return false;
  if (!validContext(context) || !Number.isFinite(seconds) || !Number.isFinite(motion.startTick) || !finiteTriple(motion.at) ||
    [motion.reach, motion.release, motion.hold, motion.abortedAt, motion.abortWeight].some(n => n !== undefined && !Number.isFinite(n)) ||
    [motion.reach, motion.release].some(n => n !== undefined && n <= 0)) {
    fail?.({reason: 'incense.tip-domain', work}); return false;
  }
  const progress = handActuatorFrame(motion, seconds).weight;
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {fail?.({reason: 'incense.tip-domain', work}); return false;}
  if (!(progress > 0)) return false;
  const generic = armUnderlay(arm);
  const failure = (reason: IncenseTipFailure['reason']) => {
    restore(generic); body.updateMatrixWorld(true); fail?.({reason, work: {...work}}); return false;
  };
  if (!validArm(arm) || !armObjects(arm).every(o => belongsTo(o, body)) || !validUnderlay(arm, underlay)) return failure('incense.tip-domain');
  if (skin.valid?.() === false) return failure('incense.tip-skin');
  restore(underlay); body.updateMatrixWorld(true);
  const startQ = arm.hand.getWorldQuaternion(new THREE.Quaternion()), shoulder = P(arm.upper);
  const wrist = P(arm.hand), elbow = P(arm.lower), length = wrist.distanceTo(P(arm.fingers[3]));
  const chainLength = shoulder.distanceTo(elbow) + elbow.distanceTo(wrist);
  if (!finiteQuaternion(startQ) || ![shoulder, wrist, elbow].every(finiteVector) || !Number.isFinite(length) ||
    !(Number.isFinite(chainLength) && chainLength * BODY_MODEL.maxExtension > TIP_ACCURACY)) return failure('incense.tip-domain');
  const tipCentre = new THREE.Vector3(...context.tip), radial = shoulder.clone().sub(tipCentre).setY(0).normalize();
  // Frame axes and contact support are measured on this rig, rather than a
  // nominal hand or an offset from its palm landmark.
  const forward = P(arm.fingers[1]).sub(P(arm.fingers[0])).normalize();
  const across = P(arm.fingers[1]).sub(P(arm.fingers[13]));
  across.addScaledVector(forward, -across.dot(forward)).normalize();
  const inv = startQ.clone().invert(), f = forward.applyQuaternion(inv), a = across.applyQuaternion(inv);
  if (![radial, f, a].every(v => finiteVector(v) && v.lengthSq() > 0)) return failure('incense.tip-domain');
  let skinFailed = false;
  const read = (visit: (p: THREE.Vector3) => void) => {const ok = readSkin(skin, visit); if (!ok) skinFailed = true; return ok;};
  const support = (direction: THREE.Vector3) => {
    let best = -Infinity; const anchor = V();
    const ok = read(p => {work.skinVisits++; const d = p.dot(direction); if (d > best) {best = d; anchor.copy(p);}});
    return ok && Number.isFinite(best) ? anchor : null;
  };
  const orientHand = (direction: THREE.Vector3, weight: number) => {
    work.orientations++;
    restore(underlay); body.updateMatrixWorld(true);
    const side = V().crossVectors(direction, radial).normalize();
    const desired = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(direction, side, V().crossVectors(direction, side))
      .multiply(new THREE.Matrix4().makeBasis(f, a, V().crossVectors(f, a)).transpose()));
    const q = startQ.clone().slerp(desired, weight);
    if (!finiteVector(side) || !(side.lengthSq() > 0) || !finiteQuaternion(q)) return null;
    setWorldQuat(arm.hand, q); curlHand(arm, .85 * weight);
    const chain = arm.fingers.slice(0, 4);
    for (let j = 1; j < 3; j++) {
      const b = P(chain[j]), c = P(chain[j + 1]), d = b.clone().sub(P(chain[j - 1])).normalize();
      swing(chain[j], c, b.clone().addScaledVector(d, b.distanceTo(c)), weight);
    }
    body.updateMatrixWorld(true); return validArm(arm) ? q : null;
  };
  const contactAt = (direction: THREE.Vector3) => tipCentre.clone().addScaledVector(direction, -(context.tipRadius + .0005));
  type DirectionSample = {direction: THREE.Vector3; anchor: THREE.Vector3; contact: THREE.Vector3; wrist: THREE.Vector3; skin: THREE.Vector3[]; reachable: boolean};
  const sampleDirection = (direction: THREE.Vector3): DirectionSample | null => {
    if (!orientHand(direction, 1)) return null;
    const points: THREE.Vector3[] = []; let best = -Infinity, anchor: THREE.Vector3 | null = null;
    const ok = read(p => {work.skinVisits++; points.push(p.clone()); const d = p.dot(direction); if (d > best) {best = d; anchor = p.clone();}});
    if (!ok || !anchor || !points.length) return null;
    const contact = contactAt(direction), request = wrist.clone().add(contact.clone().sub(anchor));
    if (![request.x, request.y, request.z].every(Number.isFinite)) return null;
    return {direction, anchor, contact, wrist: request, skin: points, reachable: request.distanceTo(shoulder) <= chainLength * BODY_MODEL.maxExtension - TIP_ACCURACY};
  };
  const bracketSize = (a: DirectionSample, b: DirectionSample) => {
    if (a.skin.length !== b.skin.length) return Infinity;
    let size = Math.max(a.anchor.distanceTo(b.anchor), a.contact.distanceTo(b.contact), a.wrist.distanceTo(b.wrist));
    for (let i = 0; i < a.skin.length; i++) size = Math.max(size, a.skin[i].distanceTo(b.skin[i]));
    return size;
  };
  // Certify a world-geometry bracket instead of selecting a coarse angular lattice.
  // A support branch that cannot meet this bound is a local depiction failure.
  const down = new THREE.Vector3(0, -1, 0), diagonal = tipCentre.clone().sub(shoulder).normalize();
  let low = sampleDirection(down);
  if (!low) return failure(skinFailed ? 'incense.tip-skin' : 'incense.tip-domain');
  let direction = down;
  if (!low.reachable) {
    let high = sampleDirection(diagonal);
    if (!high) return failure(skinFailed ? 'incense.tip-skin' : 'incense.tip-domain');
    if (!high.reachable) return failure('incense.tip-bracket');
    const rotation = new THREE.Quaternion().setFromUnitVectors(down, diagonal);
    let lo = 0, hi = 1;
    for (let i = 0; i < DIRECTION_STEPS; i++) {
      work.bracketMetres = bracketSize(low, high);
      if (work.bracketMetres <= TIP_ACCURACY) break;
      const mid = (lo + hi) / 2;
      const candidate = sampleDirection(down.clone().applyQuaternion(new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), rotation, mid)));
      work.directionIterations++;
      if (!candidate) return failure(skinFailed ? 'incense.tip-skin' : 'incense.tip-domain');
      if (candidate.reachable) {hi = mid; high = candidate;} else {lo = mid; low = candidate;}
    }
    work.bracketMetres = bracketSize(low, high);
    if (!(work.bracketMetres <= TIP_ACCURACY)) return failure('incense.tip-accuracy');
    direction = high.direction;
  }
  restore(underlay); body.updateMatrixWorld(true);
  const start = support(direction);
  if (!start) return failure(skinFailed ? 'incense.tip-skin' : 'incense.tip-domain');
  // The native weight already spans the complete reach/release interval. Applying
  // another compressed easing curve makes the wrist and fingers withdraw too fast.
  const q = orientHand(direction, progress), anchor = support(direction);
  if (!q || !anchor) return failure(skinFailed ? 'incense.tip-skin' : 'incense.tip-domain');
  const tip = contactAt(direction), H = Math.max(start.y, tip.y, context.bowlTop);
  const c1 = start.clone().setY(H), c2 = tip.clone().setY(H);
  const u = progress, r = 1 - u;
  const goal = start.clone().multiplyScalar(r * r * r).addScaledVector(c1, 3 * r * r * u)
    .addScaledVector(c2, 3 * r * u * u).addScaledVector(tip, u * u * u);
  // Keep this pose's existing elbow plane. At zero displacement the solve is the
  // identity, rather than switching to an unrelated absolute elbow direction.
  const pole = elbow.clone().sub(shoulder);
  const shift = goal.clone().sub(anchor), rawPalm = palm(arm, V()).add(shift), rawWrist = P(arm.hand).add(shift);
  const radius = chainLength * BODY_MODEL.maxExtension - TIP_ACCURACY;
  const fromShoulder = rawWrist.clone().sub(shoulder), rawDistance = fromShoulder.length();
  const planningDelta = rawDistance > radius ? fromShoulder.multiplyScalar(radius / rawDistance).add(shoulder).sub(rawWrist) : V();
  // At the actual contact peak the raw endpoint must itself be feasible. An
  // intermediate planned route correction is never relabelled as achieved contact.
  if (progress === 1 && planningDelta.lengthSq() > 0) return failure('incense.tip-contact-infeasible');
  const plannedTip = goal.clone().add(planningDelta), requestedPalm = rawPalm.clone().add(planningDelta), requestedWrist = rawWrist.clone().add(planningDelta);
  if (![goal, rawPalm, rawWrist, plannedTip, requestedPalm, requestedWrist, planningDelta, pole].every(finiteVector) ||
    !Number.isFinite(H) || !Number.isFinite(radius) || !Number.isFinite(rawDistance)) return failure('incense.tip-domain');
  work.touchIK++;
  ik(arm.upper, arm.lower, P(arm.hand), requestedWrist, pole, 1, BODY_MODEL.maxExtension);
  setWorldQuat(arm.hand, q); body.updateMatrixWorld(true);
  const attainedPalm = palm(arm, V()), attainedWrist = P(arm.hand);
  if (!validArm(arm) || !finiteVector(attainedPalm) || !finiteVector(attainedWrist)) return failure('incense.tip-domain');
  // The route starts at the actual underlay skin and articulation at weight zero
  // is the underlay itself, so no second whole-arm convergence interval is needed.
  observe?.({shoulder: shoulder.clone(), chainLength, rawTip: goal.clone(), rawPalm, rawWrist, plannedTip, requestedPalm, requestedWrist, planningDelta, work: {...work}, attainedPalm, attainedWrist, direction: direction.clone(),
    wristExtension: shoulder.distanceTo(attainedWrist) / chainLength});
  return true;
}

/** Every ownership channel must be explicitly resolved. Missing information is not
 * evidence that an arm is free. The caller obtains these from the sampled native body. */
export type IncenseFreeArmOwnership = {
  nativeTarget: readonly number[] | null;
  grip: string | null;
  heldItems: readonly unknown[];
  itemPose: unknown | null;
  cup: unknown | null;
  watering: unknown | null;
  transfer: unknown | null;
  handGame: unknown | null;
};
export function incenseArmIsUnowned(o: IncenseFreeArmOwnership): boolean {
  return o.nativeTarget === null && o.grip === null && Array.isArray(o.heldItems) && o.heldItems.length === 0 &&
    o.itemPose === null && o.cup === null && o.watering === null && o.transfer === null && o.handGame === null;
}

/** Incident arm skin, including forearm and hand. Build only for the opted-in rig;
 * no fixture/scene traversal is needed while posing. */
export function incenseArmSkin(root: THREE.Object3D, arm: Arm): TipSkin {
  const side = arm.side > 0 ? 'L' : 'R', names = new RegExp(`^(UpperArm|LowerArm|Wrist|Thumb\\d|Index\\d|Middle\\d|Ring\\d|Pinky\\d)${side}$`);
  const refs: {mesh: THREE.SkinnedMesh; indices: number[]}[] = [];
  let supported = true;
  root.traverse(o => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const attributes = skinAttributes(mesh);
    if (!attributes) {supported = false; return;}
    const {si, sw} = attributes;
    const indices: number[] = [];
    for (let i = 0; i < si.count; i++) {
      if (!vertexWeightsValid(si, sw, i, mesh.skeleton.bones.length)) {supported = false; return;}
      for (let j = 0; j < 4; j++)
      if (sw.getComponent(i, j) > 0 && names.test(mesh.skeleton.bones[si.getComponent(i, j)]?.name ?? '')) {indices.push(i); break;}
    }
    if (indices.length) refs.push({mesh, indices});
  });
  return supported ? cachedSkin(root, refs) : () => false;
}

export type IncenseArmFailure = {reason: 'incense.arm-domain' | 'incense.arm-skin'};

/** The free arm stays on the actor side of the solid fixture's supporting plane.
 * This also covers its idle gesture handoff, after the native actuator's arm is down.
 * Owned arms are unchanged. The active contacting arm uses its separate tip route. */
export function clearUnownedIncenseArm(arm: Arm, body: THREE.Object3D, context: IncenseTipContext,
  ownership: IncenseFreeArmOwnership, skin: TipSkin, fail?: (failure: IncenseArmFailure) => void): boolean {
  if (!incenseArmIsUnowned(ownership)) return false;
  const generic = armUnderlay(arm);
  const failure = (reason: IncenseArmFailure['reason']) => {
    restore(generic); body.updateMatrixWorld(true); fail?.({reason}); return false;
  };
  if (!validContext(context) || !validArm(arm) || !armObjects(arm).every(o => belongsTo(o, body))) return failure('incense.arm-domain');
  if (skin.valid?.() === false) return failure('incense.arm-skin');
  const centre = new THREE.Vector3(...context.centre), radial = P(arm.upper).sub(centre).setY(0).normalize();
  if (!finiteVector(radial)) return failure('incense.arm-domain');
  if (radial.lengthSq() < .9) return false;
  const q = arm.hand.getWorldQuaternion(new THREE.Quaternion());
  if (!finiteQuaternion(q)) return failure('incense.arm-domain');
  const chainLength = P(arm.upper).distanceTo(P(arm.lower)) + P(arm.lower).distanceTo(P(arm.hand));
  if (!Number.isFinite(chainLength) || !(chainLength > 0)) return failure('incense.arm-domain');
  let changed = false;
  for (let it = 0; it < 4; it++) {
    let nearest = Infinity;
    if (!readSkin(skin, p => {nearest = Math.min(nearest, p.clone().sub(centre).dot(radial));})) return failure('incense.arm-skin');
    const need = context.radius + .002 - nearest;
    if (!Number.isFinite(need)) return failure('incense.arm-domain');
    // A tolerance terminates refinement; it must not create a finite activation
    // step at the first positive correction.
    if (!(need > (it === 0 ? 0 : .00001))) break;
    const pole = P(arm.lower).sub(P(arm.upper));
    const goal = palm(arm, V()).addScaledVector(radial, need);
    if (!finiteVector(pole) || !finiteVector(goal) || !Number.isFinite(goal.distanceTo(P(arm.upper)))) return failure('incense.arm-domain');
    armTo(arm, goal, 1, BODY_MODEL.maxExtension, body, pole);
    setWorldQuat(arm.hand, q); body.updateMatrixWorld(true); changed = true;
    if (!validArm(arm) || !finiteVector(palm(arm, V()))) return failure('incense.arm-domain');
  }
  return changed;
}
