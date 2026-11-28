import {HELD_ARM_EASE,heldArmBinding,type HeldArmOrigin} from './held-arm-origin.ts';
import { heldProjections, heldBackExtent, heldGripBounds, placeHeld, type HeldPicture, type HeldPictureFactory, type NativeHands } from './held-projection.ts';
import {wavePose,WAVE_BLEND_SECONDS,type WaveSample} from './wave-blend.ts';
import {actuatorHand,handActuatorFrame,posterLocal,strokeWork,twoHanded,HAND_REACH_SECONDS,HAND_RELEASE_SECONDS,type HandActuatorMotion} from '../../engine/social/hand-actuator.ts';
import {insidePoint,itemPoseOf,ITEM_RECOVERY_SECONDS,type ItemPoseView} from '../../engine/items/presentation.ts';
import {wateringFrame,transferWeight,TRANSFER_HANDOFF,type HandTransfer,type WateringMotion} from '../../engine/items/watering.ts';
import { posterTexture, sheetGeometry, sheetLift as sheetLiftAt, tapeStrips, rollMesh, PAPERS } from './poster-sheet.ts';
import type {LetGoV1} from '../../engine/items/let-go.ts';
import {cupFrame,cupPose,cupYawAt,MUG,type CupMotion,type CupMarks} from '../../engine/items/cup.ts';
import {BODY_MODEL as ENGINE_BODY} from '../../engine/body/model.ts';
// Engine humans → animated rigs. Renderers only read world state (guide):
// after every fixed tick we snapshot pose + derive clip state; frames
// interpolate between the last two ticks, so visuals are a deterministic
// function of sim history (not of frame rate).
//
// Only Idle/Walk clips exist, so everything else is a procedural pose layer on top of the clip
// (after mixer.update, every frame; the clip values are restored first, so nothing accumulates).
// Docs: docs/engineering/POSES.md. Layers, in order:
// - legs / pelvis (one of):
//   · sit (sit / sit-down / stand-up, and eat / serve with baseActivity sit): body lowered onto the
//     seat, thighs forward, feet on the ground; a `legs-crossed` variant for about half the people
//     (hash of the id);
//   · stairs: on an engine stairs link the Walk clip's legs are replaced by a tread-by-tread gait
//     (stair-gait.ts): foot IK plants each foot on a tread top, the pelvis follows the feet;
//   · posture (posture.ts): crouch / squat, hip bend, heel raise — solved per tick from where the
//     hands must go (engine hand points or grip slot points) and the activity, blended over 0.4 s;
// - arms: two-bone IK to the engine's published hand points (`human.hands`), else to the grip slot
//   of the gripped part, else hands on thighs (seated) / held out to the fire (warm). Reach honesty:
//   full contact within 1.02 arm lengths (reach clamped at 0.97, carriers 0.88 — elbows bent),
//   fading to none by 1.25; beyond that the arm hangs as the clip has it. No stretching.
// - Walk clip only while the person actually moves over the ground (engine `human.speed` when
//   published, else the position delta), blended out within 0.2 s.
// All of it is a pure function of (world history, entity id): no randomness.
import * as THREE from 'three';
import { hashId, humanGroundAt, humanGroundSampler, setHumanGround, templateNameFor } from './people-light.ts';
import { seatedFootWeight, seatedSupportY } from './seated-ground.ts';
import { seatTransition } from './seat-transition.ts';
import type { Entity, Pose, WorldState } from '../../engine/world/types.ts';
import type { Vec3 } from '../../engine/core/math.ts';
import type { Link } from '../../engine/spatial/types.ts';
import { CATALOG } from '../../engine/world/catalog.ts';
import { toWorld } from '../../engine/carry/formation.ts';
import { entityCorners } from '../../engine/spatial/service.ts';
import { handPoint, STATION_SLOT } from '../../engine/construction/liftcrew.ts';
import { LIFT_HAND } from '../../engine/construction/raise.ts';
import { DT } from '../../engine/runtime/runtime.ts';
import { createRig, libAction, type Rig, type Template } from './people.ts';
import { CLIP_BODY, CLIP_FADE, IDLE_VARIANTS, SPRINT_SPEED, clipTime, libraryPick, pickClip, type LibraryPick } from './clip-library.ts';
import {HumanActorAppearance} from './human-appearance.ts';
import {applyHumanFinish} from './content/details/human-presets/finish.ts';
import {BODY_DRAW,mergeRigBody,setBodyMerged} from './body-merge.ts';
import { disposeSkeletons } from '../../lib/three-resources.ts';
import { seatHeight } from './fixtures.ts';
import {blendWaterFoot} from './water-foot-blend.ts';
import { BODY_MODEL, UP, ankleLocal, armLen, armTo, armsOf, clamp01, contact, curlHand, legTo, legsOf, palm, place, setWorldQuat, smooth, spineOf, swing, turn, type Arm, type Leg, type Spine } from './rig.ts';
import { BEND_SHARE, KNEE_Y, KNEEL_SIDE, NEUTRAL, approach, kneelDrop, shoulderAt, solvePosture, styleFor, type Dims, type Posture, type Target } from './posture.ts';
import { groundFootLift } from './ground-foot-fit.ts';
import { flightOf, gaitAt, stairFootTarget, type Flight, type Gait } from './stair-gait.ts';
import {measureStairRigContact,stairContactEnvelope,stairBearingRotation,type StairRigContact} from './stair-rig-contact.ts';
import {stairSoleFit} from './stair-sole.ts';
import {stairShoeTrajectory} from './stair-trajectory.ts';
import {stairShoeRefs} from './stair-shoe-refs.ts';
import { frameCtx, framePose, stanceFacing, type FrameCtx, type FramePose } from './frame-gait.ts';
import { GIRDLE, LIP, PRONE_ACTS, engineTurn, lipAlong, RISE_STEP, approachProne, lerpProne, proneFrame, riseOf, solveProne, type ProneState } from './prone.ts';
import { expressionAt, type Expression } from './expression.ts';
import {waterMotionAt,type WaterMotion} from './water-motion.ts';
import type {WaterTransition} from './water-transition.ts';
import type {ShoreContactV1} from '../../../../packages/engine-contract/src/shore.ts';
import type { DepictionBeat } from './station-depiction.ts';
import { sleepGoal, sleepHands, sleepHeadPitch, sleepRestWeight, sleepHeadRestLift } from './sleep.ts';
import { PRONE_ACTIVITY } from '../../engine/construction/handup.ts';
import { ACTIVITY_OVERLAYS, CARRY_HAND, GESTURE_RETURN, GROUND_SEAT, RETURNS, LYING, PIANO_FADE, SING_LET_GO, activityFrame, carriedProp, carrySide, gameArmBlend, makeProp, placeProp, propFor, formPresses, pressWeight, type FormPress, type ActivityFrame, type PropKind } from './activity-poses.ts';
import type { HeldSet, ConsumeMove } from './held-entry.ts';
import { accompanistOf } from './piano-score.ts';
import { ACT_BLEND, ACT_HISTORY, OWN_FADE, blendFrames, postureKind, postureNow, posturePhaseEnds, type PostureChange, type PostureNow } from './posture-transition.ts';
import {posePianoHand} from './piano-hands.ts';
import { handGameActive, handGameGestureClock, handGameSuppress, poseHandGames, type HandGameDiag } from './hand-games.ts';
import type { HandHoldState } from '../../engine/social/hand-hold.ts';
import type { RpsState } from '../../engine/social/rps.ts';
import {recordedGame,type RecordedGame} from './recorded-games.ts';
import {runningGaitAt} from './running-gait.ts';
import { chooseGait, type GaitChoice } from './gait-choice.ts';
import {PLAY_MOTION, playSeatAt, rideSeat} from './play-motion.ts';
import {BIKE_SADDLE, crankAngle, makeBicycle, pedalLocal, poseBicycle} from './bicycle.ts';

type Hands = { left?: Vec3; right?: Vec3 };
/** Cosmetic point bearing, never a native hand endpoint. Coordinates are world metres; times are world µs. */
export type PointAim = { target: string; at: [number, number]; hand: 'left' | 'right'; start: number; ends: number[]; cut?: number; contact?: string; run?: string };
export function pointAimOf(value: unknown): PointAim | undefined {
  const p = value as PointAim | null;
  if (!p || typeof p.target !== 'string' || !p.target || !['left','right'].includes(p.hand)
    || !Array.isArray(p.at) || p.at.length !== 2 || !p.at.every(Number.isFinite) || !Number.isFinite(p.start)
    || !Array.isArray(p.ends) || !p.ends.length || !p.ends.every((n,i) => Number.isFinite(n) && n > (i ? p.ends[i-1] : p.start))
    || p.cut !== undefined && (!Number.isFinite(p.cut) || p.cut < p.start || p.cut > p.ends.at(-1)!)) return undefined;
  return { target:p.target, at:[...p.at], hand:p.hand, start:p.start, ends:[...p.ends], ...(p.cut === undefined ? {} : {cut:p.cut}),
    ...(typeof p.contact === 'string' ? {contact:p.contact} : {}), ...(typeof p.run === 'string' ? {run:p.run} : {}) };
}
type Snap = { p: [number, number, number]; yaw: number; walkW: number; walkT: number; idleT: number; sitW: number; warmW: number; expressionT: number; pose: Posture; hands: Hands; pr: ProneState | null };
const POSTURE_ORIGINS = new Set(['idle','pushups','situps','stargaze','lie','jumping-jacks','stretch','yoga']);
export type ClipOrigin = {
  age: number; sample: SampledHuman;
  /** Earlier contributing boundaries, newest first; no recursive sampled-human tree. */
  history?: readonly {offset:number;age:number;sample:SampledHuman}[];
  /** Identity of the immutable indexed recording context, invalidated when adjacent takes change. */
  context?: object;
  /** Internal collapsed pose, used only by the isolated iterative evaluator. */
  drawn?: DrawnOrigin;
};
export type DrawnOrigin = { bones: { p: THREE.Vector3; q: THREE.Quaternion }[]; offset: THREE.Vector3; q: THREE.Quaternion; feet?: THREE.Vector3[]; arms?: { name: string; p: THREE.Vector3; q: THREE.Quaternion }[]; palms?: THREE.Vector3[] };
function poseBones(model:THREE.Object3D) {
  const joints:THREE.Object3D[]=[];model.traverse(o=>{if((o as THREE.Bone).isBone)joints.push(o);});return joints;
}
function drawnOrigin(model:THREE.Object3D,holder:THREE.Object3D,root:THREE.Vector3,nativeQ:THREE.Quaternion):DrawnOrigin {
  return {bones:poseBones(model).map(o=>({p:o.position.clone(),q:o.quaternion.clone()})),offset:holder.position.clone().sub(root).applyQuaternion(nativeQ.clone().invert()),q:nativeQ.clone().invert().multiply(holder.quaternion)};
}
function blendDrawn(holder:THREE.Object3D,joints:THREE.Object3D[],target:{bones:DrawnOrigin['bones'];p:THREE.Vector3;q:THREE.Quaternion},origin:DrawnOrigin,k:number,root:THREE.Vector3,nativeQ:THREE.Quaternion){
  target.bones.forEach((s,i)=>{joints[i].position.lerpVectors(origin.bones[i].p,s.p,k);joints[i].quaternion.slerpQuaternions(origin.bones[i].q,s.q,k);});
  holder.position.copy(root).add(origin.offset.clone().lerp(target.p.clone().sub(root).applyQuaternion(nativeQ.clone().invert()),k).applyQuaternion(nativeQ));
  holder.quaternion.copy(nativeQ).multiply(origin.q.clone().slerp(nativeQ.clone().invert().multiply(target.q),k));holder.updateMatrixWorld(true);
}
/** Root-sibling feet retain the authored shin-end offset during a seated pose blend. */
function seatFootOffsets(v: View) {
  v.rig.holder.updateMatrixWorld(true);
  return v.legs.map((leg, i) => leg.foot.getWorldPosition(V()).sub(leg.lower.localToWorld(v.ankle[i].clone())));
}
function armBases(v: View) {
  return v.arms.flatMap(a => [...(a.shoulder ? [a.shoulder] : []), a.upper, a.lower, a.hand, ...a.fingers, ...a.thumb]).map(o => ({ name: o.name, p: o.position.clone(), q: o.quaternion.clone() }));
}
function blendSeatDrawn(v: View, joints: THREE.Object3D[], target: { bones: DrawnOrigin['bones']; p: THREE.Vector3; q: THREE.Quaternion }, origin: DrawnOrigin, k: number, root: THREE.Vector3, nativeQ: THREE.Quaternion) {
  const offsets = seatFootOffsets(v);
  const arms = v.cur.hands.left || v.cur.hands.right || v.formPress?.length ? new Map(origin.arms?.map(b => [b.name, b])) : null;
  const input = arms?.size ? { ...origin, bones: origin.bones.map((b, i) => arms.get(joints[i].name) ?? b) } : origin;
  blendDrawn(v.rig.holder, joints, target, input, k, root, nativeQ);
  if (origin.feet) v.legs.forEach((leg, i) => place(leg.foot, leg.lower.localToWorld(v.ankle[i].clone()).add(origin.feet![i].clone().lerp(offsets[i], k))));
}
type View = {
  postureOrigins?: Map<string, DrawnOrigin>;
  clipOrigins?: Map<string, DrawnOrigin>;
  clipContext?: object;
  clipOrigin?: ClipOrigin;
  seatSample?: SampledHuman;
  seatPlan?: ReturnType<typeof seatTransition>;
  seatOrigins?: Map<string, DrawnOrigin>;
  ownerArmBase?: NonNullable<DrawnOrigin['arms']>;
  clipReference?: {o:THREE.Object3D;p:THREE.Vector3;q:THREE.Quaternion;s:THREE.Vector3}[];
  rig: Rig;
  /** PERF-EDEN: posed at least once (a new body is never left in its bind pose by the pose-rate throttle). */
  posedOnce?: boolean;
  /** V11 (#2618): in the view at the last pose-rate decision, at its sampled place or where it is drawn. */
  shown?: boolean;
  /** V11: neither posed this frame nor shown: its rig keeps the matrices and bone texture it was last drawn with. */
  held?: boolean;
  appearance?:HumanActorAppearance;
  appearanceSoulKey?:string;
  prev: Snap;
  cur: Snap;
  speed: number;
  activity: string;
  handActuator?:HandActuatorMotion;
  handActuatorTime?:number;
  itemPose?:ItemPoseView;
  /** entry 43: render time an opted-in put let go of its item (gestures come back only after the arm has). */
  itemReleasedAt?:number;
  /** Soul Actions 34: a watering-can stage (fill / pour), on the take clock. */
  watering?:WateringMotion;
  wateringTime?:number;
  /** Soul Actions 43: the last let-go before a reach (let-go.ts), on the take clock. */
  letGo?:LetGoV1;
  letGoTime?:number;
  /** Soul Actions 44: a mug drunk from or rinsed (cup.ts), on the take clock. */
  cup?:CupMotion;
  cupTime?:number;
  /** Soul Actions 44: the idle hand-off last frame, and the weight a let-go fades its gesture out from. */
  idleLast?:number;
  letGoFrom?:{tick:number;from:number};
  /** Soul Actions 44: the walk age last frame (a smaller one is a new walk), and the gesture level shown when it started. */
  walkKey?:number;
  handoffAtWalk?:number;
  /** Soul Actions 34: a handle-held item taken or put by hand (take_item / put_item), on the take clock. */
  transfer?:HandTransfer;
  transferTime?:number;
  /** Entry 38: the actuator that just ended, while its idle handoff is still fading in. */
  lastHandActuator?:HandActuatorMotion;
  sleepPose?: NonNullable<Entity['human']>['sleepPose'];
  shore?: ShoreContactV1;
  shoreTime?: number;
  waterTransition?: WaterTransition;
  readingGaze?: { prev: number; cur: number };
  /** Ticks since `activity` began (the prone rise clock, prone.ts riseOf, when the engine publishes no phaseK). */
  age: number;
  /** The engine's prone body turn / phaseK at the latest tick (diagnostics; undefined: not published). */
  proneEng?: { turn?: number; k?: number };
  /** The activity an overlay (eat / serve) is layered on (engine human.baseActivity). */
  base: string;
  grip?: string;
  /** Grip slot on that part (engine/construction: lift-far, foot-l/r, hold-N, lift-end/edge/corner-*, lift-station, handup-*). */
  gripSlot?: string;
  carryWeight?: number;
  /** Rack-structure link stood on (engine human.on; readout). */
  on?: string;
  /** Pose on the rack structure (frame-gait.ts): climbing a frame, standing on its bracing, walking a beam. */
  frame?: FrameCtx | null;
  arms: Arm[];
  legs: Leg[];
  spine?: Spine;
  dims?: Dims;
  /** Per leg: ankle in the shin's frame, rest foot rotation relative to the holder, lateral offset (m, + = right). */
  ankle: THREE.Vector3[];
  footRest: THREE.Quaternion[];
  footLat: number[];
  /** Skinned vertices of each foot / hand (by the side the leg / arm has: +1 left): the prone layer keeps them on the deck. */
  surf: { leg?: Map<number, VertexRefs>; foot: Map<number, VertexRefs>; hand: Map<number, VertexRefs>; body?: VertexRefs };
  /** PERF-PASSES: restNeed's lowest samples from its last full pass (see restNeed). */
  restCache?: { key: string; n: number; refs: VertexRefs };
  stairShoes?:ReturnType<typeof stairShoeRefs>;
  stairContact?:StairRigContact|null;
  stairGoals?:[number,number,number][];
  stairResiduals?:{along:number;lift:number}[][];
  /** Sitting-surface height of the occupied seat (m). */
  seat: number;
  /** Lying on a bench (bench press, sit-ups on a bench): the bench top height from the spot's seatHeight; 0 = the ground. */
  bench?: number;
  /** Nearest campfire (centre x, z and ring radius) for `warm`. */
  fire?: [number, number, number];
  /** Per-person variation in [0, 1), from the id. */
  vary: number;
  /** Seated variant: one leg crossed over the other (deterministic per id). */
  cross: boolean;
  /** Bones the pose layers touch, with their clip-local transforms from the last mixer apply. */
  saved: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[];
  /** Diagnostics: per arm, shoulder→grip point distance / arm length at the last frame (null = no point). */
  reachRatio: (number | null)[];
  diag?: Diag;
  layered: boolean;
  gaze?: { prev: number; cur: number };
  /** Body activity layer (activity-poses.ts): the engine's prop, sitting on the ground, running, and the prop mesh. */
  propWanted?: string;
  /** Native public observation, retained separately from the legacy visual/contact owner. */
  heldEntries?: HeldSet;
  nativeHands?: NativeHands;
  /** Native consume observations only; pose code does not read this field. */
  consumeMove?: ConsumeMove;
  /** Take time (s) the body began to carry its prop in one hand (the carry pose eases in from it). */
  carrySince?: number;
  heldArmOrigin?:HeldArmOrigin;
  heldArmKnown?:boolean;
  heldArmCache?:Map<string,DrawnOrigin>;
  heldArmContext?:object;
  instrument?:string;
  game?:RecordedGame;
  gameTick?:number;
  gameDt?:number;
  groundSeat?: boolean;
  running?: boolean;
  /** Walk or jog for a stretch (gait-choice.ts): the drawn gait, since when, and a change waiting out its dwell. */
  gait?: GaitChoice;
  /** todo (leisure): the dock bicycle under a cycling body, metres ridden (turns the cranks), when it last cycled (s). */
  bike?: THREE.Group; ridden?: number; bikeAt?: number;
  prop?: { kind: PropKind; obj: THREE.Object3D };
  /** Soul Actions entry 38: the poster in the hands while it goes up or comes down (sheet on the wall, roll between the palms). */
  sheet?: { key: string; group: THREE.Group; flat: THREE.Mesh; roll: THREE.Mesh; tapes: THREE.Mesh[] };
  /** Library clip layer (clip-library.ts): seconds since `activity` began (undefined: before the record), the activity
   *  and base before it (crossfade), the paired-gesture partner and where it is, metres walked, speaking now. */
  since?: number;
  formPress?: readonly FormPress[];
  pointAim?: PointAim;
  pointAimTime?: number;
  prevAct?: string;
  /** posture-transition.ts: the latest change of posture (activity before it, its base, the activity after) and its age. */
  postureChange?: PostureChange;
  waveSamples?: readonly WaveSample[];
  waveClock?: number;
  waveEvents?: {start:number;end?:number}[];
  prevWaveDuration?: number;
  waveRestAge?: number;
  prevBase?: string;
  prevDuration?: number;
  /** The last drawn one-off gesture (activity-poses.ts RETURNS): its age and the take time it was drawn at. */
  gesture?: { act: string; age: number; at: number };
  prevInstrument?: string;
  restAge?: number;
  restFrom?: number;
  /** Idle variety weight drawn at the last render (Idle_Neutral + variant; diagnostics only). */
  variety?: number;
  /** Entry 36: the idle-variety onset level when the body last stood idle (a singer's gesture fades out from it). */
  singOnset?: number;
  /** Seconds since the current walk began (its weight left 0), and the rest clock then; undefined: not walking / long ago. */
  walkAge?: number;
  restAgeAtWalk?: number;
  partner?: string;
  partnerP?: THREE.Vector3;
  /** entry 35 (hand-games.ts): holding hands / an offered hand, and a rock-paper-scissors count; the tick drawn and the
   *  hand partner's drawn root. */
  handHold?: HandHoldState;
  rps?: RpsState;
  hgTick?: number;
  hgDt?: number;
  holdP?: THREE.Vector3;
  dist: number;
  speaking?: boolean;
  /** Library actions playing at the last render (stopped when no longer wanted). */
  libOn: Set<THREE.AnimationAction>;
};
/** Per-frame readout of the pose layers (lab hook `bones()`, e2e). */
export type Diag = {
  expression?: Expression;
  water?: WaterMotion;
  stairShoeCoverage?:{vertices:number;complete:boolean};
  stairContacts?:{goals:[number,number,number][];ankleErrors:number[];residuals:{along:number;lift:number}[][]};
  gait: { flight: string; u: number; weight: number; feet: { planted: boolean; k: number; top: number }[] } | null;
  /** Foot bones (ankles) and their soles (ankle − rest ankle height), left first. */
  feet: [number, number, number][];
  soles: number[];
  hipY: number;
  /** Head bone (rendered). */
  head: [number, number, number] | null;
  pose: Posture;
  arms: { side: 'left' | 'right'; shoulder: number[]; palm: number[]; len: number; target: number[] | null; source: Source; contact: number; err: number | null; ratio: number | null }[];
  /** Rack-structure layer (frame-gait.ts): kind, ladder rung coordinate, exit progress, blend weight, the planned soles. */
  frame: { kind: string; u: number; exit: number; weight: number; feet: { p: number[]; planted: boolean }[] | null } | null;
  /** Prone layer (prone.ts): rise coordinate, torso pitch and body turn (rad), rendered yaw, layer weight; what the
   *  engine published at the latest tick (its body turn angleDelta(pose.yaw, proneYaw), phaseK; null: not published). */
  prone: (ProneState & { engTurn: number | null; phaseK: number | null }) | null;
  /** entry 35: the hand-game layer drawn this frame (hold / offer / rps), its weight, the shaped hand's finger curls. */
  handGame?: HandGameDiag;
};
/** Where an arm's target came from: engine hand points, a grip slot, or private frame/balance/ground-sleep contacts. */
type Source = 'hands' | 'grip' | 'frame' | 'sleep' | 'expression' | 'water' | 'carry' | null;
/** Seconds a carried thing's hand takes to come up to the carry point once it is held. */
const CARRY_EASE = 0.4;
/**
 * One person in a random-access frame (take replay / scrubbing). `walk` is the Walk clip weight
 * (0–1) and `walkDist` the metres walked along the track so far, so the Walk phase is a pure
 * function of take time: clip seconds = metres / clip ground speed (feet speed-matched).
 */
export type SampledHuman = {
  /** Native held metadata; absent on legacy takes, entries:[] only after observing no held things. */
  heldEntries?: HeldSet;
  nativeHands?: NativeHands;
  /** Native consume observations only; pose code does not read this field. */
  consumeMove?: ConsumeMove;
  /** Public recorded Soul association, never inferred from a display name/id. */
  publicSoulKey?:string;
  bodyModel?:string;
  waterTransition?: WaterTransition;
  /** Renderer-owned seat surface above this root, supplied only by a matching recorded fixture counterpart. */
  seatHeight?: number;
  id: string;
  p: [number, number, number];
  yaw: number;
  walk: number;
  walkDist: number;
  activity?: string;
  grip?: string;
  gripSlot?: string;
  carryWeight?: number;
  /** Engine hand points (take field `hands`): arms, posture and held items follow them as in the lab. */
  hands?: Hands;
  /** Activity an eat / serve overlay is layered on (take field `baseActivity`; 'sit' = seated). */
  baseActivity?: string;
  /** Rack-structure link the person stands on (take field `on`: `beam:…` / `climb:…`); readout only. */
  on?: string;
  /** Prone receiver (engine W32; take fields once the recorder carries them): lying heading (world yaw) and 0–1 progress
   *  within the engine phase — the prone layer's body turn and exact rise mid-phase (else each phase's end pose). */
  proneYaw?: number;
  phaseK?: number;
  handActuator?:HandActuatorMotion;
  handActuatorTime?:number;
  itemPose?:ItemPoseView;
  /** Soul Actions 34: a watering-can stage (fill / pour), on the take clock. */
  watering?:WateringMotion;
  wateringTime?:number;
  /** Soul Actions 43: the last let-go before a reach (let-go.ts), on the take clock. */
  letGo?:LetGoV1;
  letGoTime?:number;
  /** Soul Actions 44: a mug drunk from or rinsed (cup.ts), on the take clock. */
  cup?:CupMotion;
  cupTime?:number;
  /** Soul Actions 44: the idle hand-off last frame, and the weight a let-go fades its gesture out from. */
  idleLast?:number;
  letGoFrom?:{tick:number;from:number};
  /** Soul Actions 44: the walk age last frame (a smaller one is a new walk), and the gesture level shown when it started. */
  walkKey?:number;
  handoffAtWalk?:number;
  /** Soul Actions 34: a handle-held item taken or put by hand (take_item / put_item), on the take clock. */
  transfer?:HandTransfer;
  transferTime?:number;
  sleepPose?: NonNullable<Entity['human']>['sleepPose'];
  shore?: ShoreContactV1;
  shoreTime?: number;
  /** Small object in the hands for a body activity (engine human.prop, ACTIVITIES-v1). */
  prop?: string;
  instrument?:string;
  game?:RecordedGame;
  gameTick?:number;
  gameDt?:number;
  /** Ground speed (m/s) over ±0.15 s; running (gait-choice.ts: above 2.3 m/s, for a stretch) plays the Run clip. */
  speed?: number;
  /** together/1: the other body of a paired gesture (hug, handshake, high-five, give/take, dance together). */
  partner?: string;
  /** entry 35: take fields handHold / rps, and the absolute take tick (fractional) and tick length they are read at. */
  handHold?: HandHoldState;
  rps?: RpsState;
  handGameTick?: number;
  handGameDt?: number;
  /** Seconds since `activity` began in this take, and the activity / base before it (library clip crossfades and
   *  one-shots); absent when the activity began before the take. */
  activityAge?: number;
  /** Immutable prior drawn context at the newest activity boundary, including any still-visible origin. */
  clipOrigin?: ClipOrigin;
  /** Recorded seat before departure, retained separately from the current (now absent) seat. */
  seatOrigin?: { height?: number; tick?: number; phase?: number; sample?: SampledHuman };
  heldArmOrigin?:HeldArmOrigin;
  heldArmKnown?:boolean;
  /** Existing v2 press record, including its native hand and phase clock. */
  formPress?: readonly FormPress[];
  pointAim?: PointAim;
  pointAimTime?: number;
  /** The latest change of posture in the recorded history (posture-transition.ts): the activity and base before it,
   *  the activity it went into and its age (s); absent when there was none in the last second or so. */
  postureChange?: PostureChange;
  prevActivity?: string;
  /** Release-only shared-wave timing; derived from recorded activity history, never a renderer wall clock. */
  waveSamples?: readonly WaveSample[];
  waveClock?: number;
  prevWaveDuration?: number;
  waveRestAge?: number;
  prevBaseActivity?: string;
  /** Duration and instrument of the previous recorded activity, for an interrupted entry fade. */
  prevActivityDuration?: number;
  prevInstrument?: string;
  restAge?: number;
  /** Seconds since the current walk began (the Walk weight left 0; absent: not walking, or longer than a gesture fade). */
  walkAge?: number;
  /** The rest clock (restAge) when that walk began; absent: unknown. */
  restAgeAtWalk?: number;
};
export type { Hands };
/** A gripped part's pose over the last two ticks (hand points follow the interpolated part). */
type Part = { def: string; prev: Pose; cur: Pose };
/** Nearest point of a gripped entity to a world point (components.ts nearestPoint). */
export type Reach = (entity: string, from: THREE.Vector3, out: THREE.Vector3) => boolean;

const BLEND = DT / 0.2; // Walk↔Idle crossfade: a stopped walker is standing within 0.2 s (§3)
const POSE_BLEND = DT / 0.4; // sit / warm / postures in and out over 0.4 s
/** How far a native carry's arms extend (fraction of their length), and how much less the body is planned for. */
const CARRY_EXTENSION = 0.88, CARRY_PLAN_MARGIN = 0.08;
const WALK_EPS = 0.08; // m/s: Walk plays iff ground speed ≥ this (engine locomotion/walk.ts WALK_MIN, MOVEMENT.md §3)
const SEAT_DEFAULT = 0.45; // m, when the seat fixture is unknown (take replay)
const SEAT_MATCH = 0.8; // m, body point to nearest seat point (covers the sit-down / stand-up approach line)
const SEATED = new Set(['sit', 'sit-down', 'stand-up']);
const OVERLAYS = new Set(['eat', 'serve', 'drink', ...ACTIVITY_OVERLAYS]);
/** Soul Actions 44: the lips from the rig's head bone, in the body frame of a 1.75 m body (scaled by height). */
const CUP_LIPS = { fwd: 0.1, up: 0.02 } as const;
/** #2197: where the eating palm stops, from the head bone: in front of the chin, with the food above it at the lips. */
const EAT_PALM = { fwd: 0.11, up: -0.06, side: 0.02 } as const;
const INTERACT = new Set(['browse', 'post-letter', 'give', 'take', 'hand-over']);
const PELVIS = 0.09; // m from the hip joints down to the sitting surface (thigh/buttock thickness)
const PALM_LIFT = 0.02; // m: palm centre above a surface the hand lies flat on (half a hand's thickness)
const WARM_REACH = 1.2; // m from the fire's edge within which people hold their hands out
const HEEL = 0.06; // m: trailing heel lifted at the end of a stair stance (toe-off)
const BEAM_WALK_W = 0.5; // Walk clip weight on a beam (short steps: half the leg swing, the rest Idle)
const BEAM_CADENCE = 1.8; // Walk clip rate multiplier on a beam (half-length steps at the same ground speed)
const lerpAngle = (a: number, b: number, t: number) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * t;

// hashId, templateNameFor and the visual ground live in people-light.ts (a page loads them before this renderer)
export { templateNameFor, setHumanGround, humanGroundAt };

/** Stable template choice per actor id. */
export function templateFor(id: string, ts: Template[]) {
  const order=(ts as Template[]&{stableOrder?:readonly string[]}).stableOrder;return order?ts.find(t=>t.name===templateNameFor(id,order)):ts[hashId(id) % ts.length];
}

type Fixtures = { seats: [number, number, number][]; fires: [number, number, number][] };

/** Seat points (x, z, sitting height) and campfires (x, z, ring radius) from the world's fixtures. */
function fixturesOf(world: WorldState): Fixtures {
  const out: Fixtures = { seats: [], fires: [] };
  for (const e of Object.values(world.entities)) {
    if (e.kind !== 'fixture') continue;
    const d = CATALOG[e.def];
    if (e.def === 'campfire') out.fires.push([e.pose.p[0], e.pose.p[2], (d?.size[0] ?? 1) / 2]);
    const h = seatHeight(e.def);
    if (h === undefined) continue;
    const c = Math.cos(e.pose.yaw), s = Math.sin(e.pose.yaw);
    for (const sl of d?.slots ?? [])
      if (sl.kind === 'seat') out.seats.push([e.pose.p[0] + sl.local[0] * c - sl.local[1] * s, e.pose.p[2] + sl.local[0] * s + sl.local[1] * c, e.pose.p[1] + h]);
  }
  return out;
}

function nearest(list: [number, number, number][], x: number, z: number) {
  let best: [number, number, number] | undefined, bd = Infinity;
  for (const f of list) {
    const d = Math.hypot(f[0] - x, f[1] - z);
    if (d < bd) [best, bd] = [f, d];
  }
  return { f: best, d: bd };
}

/** Base activity: what the body does under an eat / serve overlay. */
const baseOf = (act: string, base?: string) => { if (act === 'cycle') return 'sit'; const b = OVERLAYS.has(act) ? (base ?? 'idle') : act; return b === 'sit-ground' ? 'sit' : b; };
/** Sitting on the ground (sit-ground, or an overlay layered on it): the seat is the grass. */
const onGround = (act: string, base?: string) => act === 'sit-ground' || (base === 'sit-ground' && OVERLAYS.has(act));
/** Idle variety: now and then (about 6 s in every 25, per person) the Idle_Neutral clip blends in. */
const IDLE_VARIETY_ONSET = 1.2;
/** An idle gesture playing when a reach or a walk starts fades out over this long (s) instead of being cut. */
export const GESTURE_FADE = 1.4;
/** Track names (three-sanitised bone names) of the arms and hands: shoulders to fingertips. */
const ARM_TRACK = /^(Shoulder|UpperArm|LowerArm|Wrist|Thumb|Index|Middle|Ring|Pinky)/;
/** An idle gesture (Idle_Neutral, fold arms, look around) is drawn on the arms, neck and head only; the body, hips and
 *  legs keep the Idle clip. The gesture clips stand in their own stance (fold arms / look around: feet 0.41 m apart, the
 *  other foot forward from Idle's 0.34 m stagger; Idle_Neutral: feet together), so every gesture fade in or out slid
 *  both feet 0.2–0.4 m across the ground and crossed them (entry 39, take 3: at the tap she reached while her feet slid
 *  from one split stance to the other). Their torso turn belongs to that stance too (25° off the legs without it). */
const GESTURE_TRACK = /^(Neck|Head|Shoulder|UpperArm|LowerArm|Wrist|Thumb|Index|Middle|Ring|Pinky)/;
/** Per rig, the upper-body (GESTURE_TRACK) copy of an idle gesture clip. */
function gestureAction(rig: Rig, name: string): THREE.AnimationAction | null {
  const key = name + '#gesture';
  let a = rig.lib.get(key);
  if (a === undefined) {
    const c = THREE.AnimationClip.findByName(rig.template.gltf.animations, name), tracks = c?.tracks.filter((t) => GESTURE_TRACK.test(t.name)) ?? [];
    a = c && tracks.length ? rig.mixer.clipAction(new THREE.AnimationClip(key, c.duration, tracks)) : null;
    rig.lib.set(key, a);
  }
  return a;
}
/** Per rig, the Idle clip without the gesture tracks: it carries the gesture's share of the body and legs, so their
 *  weights still sum to one (the mixer fills a bone's missing share with its bind pose). */
function idleBodyAction(rig: Rig): THREE.AnimationAction {
  const key = '#idle-body';
  let a = rig.lib.get(key);
  if (!a) {
    const c = rig.idle.getClip();
    a = rig.mixer.clipAction(new THREE.AnimationClip(key, c.duration, c.tracks.filter((t) => !GESTURE_TRACK.test(t.name))));
    rig.lib.set(key, a);
  }
  return a;
}
/** Per rig, an arms-only copy of a template clip (the gesture fades on the arms while the legs stride). */
function armsAction(rig: Rig, name: string): THREE.AnimationAction | null {
  const key = name + '#arms';
  let a = rig.lib.get(key);
  if (a === undefined) {
    const c = THREE.AnimationClip.findByName(rig.template.gltf.animations, name), tracks = c?.tracks.filter((t) => ARM_TRACK.test(t.name)) ?? [];
    a = c && tracks.length ? rig.mixer.clipAction(new THREE.AnimationClip(key, c.duration, tracks)) : null;
    rig.lib.set(key, a);
  }
  return a;
}
// 'operate' (a hand actuator) is standing too: an idle gesture fades out over its reach and back in after the release.
// entry 35: a rock-paper-scissors count is standing still too (the onset clock runs on; the hand game fades gestures itself)
export const REST_ACTS = new Set(['idle', 'reach', 'operate', 'rps']);
/** Activities in which the body covers ground on its feet (walk.ts: `ex.gait ?? 'walk'`, wading). Idle variety fades out
 *  with the Walk weight's ease at a walk start; the onset clock restarts only from a full stride (take-replay restAge). */
export const GAIT_ACTS = new Set(['walk', 'wade', 'jog', 'run']);
/** Walk weight of a full stride (walk-ease.ts WALK_FULL; the live path's eased walkW). */
const WALK_FULL_LIVE = 0.98;
function neutralWeight(id: string, t: number) { const ph = (hashId(id) % 997) / 997, u = ((t / 25 + ph) % 1) * 25; return u < 1 ? smooth(u) : u < 6 ? 1 : u < 7 ? 1 - smooth(u - 6) : 0; }
const handList = (h: Hands): Vec3[] => [h.left, h.right].filter((q): q is Vec3 => !!q);
const copyHands = (h?: Hands): Hands => ({ ...(h?.left ? { left: [...h.left] as Vec3 } : {}), ...(h?.right ? { right: [...h.right] as Vec3 } : {}) });

/** Entry 42: clip time advanced under a fade-out of length f, r s in: ∫0^r (1 − smoothstep(u/f)) du (f/2 once the fade is over). */
const heldClip = (r: number, f: number) => { const x = Math.min(1, Math.max(0, r / f)); return Math.max(0, Math.min(r, f)) - f * (x * x * x - x * x * x * x / 2); };
/** PERF-EDEN (2026-11-01): the eye, its view and the pose-rate distances (quality-tier.ts bodies). Null: every body is
 *  posed every frame, as before. */
export type HumanViewer = { eye: THREE.Vector3; frustum: THREE.Frustum; nearM: number; farM: number };
/** Shared by every people update within one live animation frame; omitted for immediate random-access views. */
export type RigCreationBudget={remaining:number};
const _bodySphere = new THREE.Sphere(undefined, 1.3);
/** V11 (#2618): while `v.held`, the rig's world matrices and bone texture are left as last drawn (nothing in it changed:
 *  it was not posed and is out of the view, so idle life skips it too); a moved parent still updates it. */
function holdable(v: View) {
  const h = v.rig.holder, walk = h.updateMatrixWorld, parentAt = new THREE.Matrix4();
  h.updateMatrixWorld = function (force?: boolean) {
    const parent = h.parent;
    if (v.held && parent && parentAt.equals(parent.matrixWorld)) return;
    walk.call(h, force);
    if (parent) parentAt.copy(parent.matrixWorld);
  };
  h.traverse((o) => {
    const s = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null; if (!s) return;
    const update = s.update; s.update = function () { if (!v.held) update.call(s); };
  });
}
export class HumanViews {
  readonly group = new THREE.Group();
  /** Render-time pose rate only: a body further from the eye, or outside the view, keeps its last pose for a few frames
   *  (every 2nd frame to `farM`, every 4th beyond, every 8th off screen; the skinned mesh itself is still drawn). Speaking
   *  bodies and bodies within `nearM` are posed every frame. Nothing here moves a body or owns a movement path.
   *  V11 (#2618): a body is in the view if it is at its sampled place or where it is drawn now, so a held pose never
   *  lingers in view; a body that comes into view is posed on that frame, whatever its rate; and a body neither posed
   *  this frame nor in the view is held: three's matrix walk and bone upload skip its rig (holdable), so its drawn pose
   *  and its shadow stay exactly what they were. */
  viewer: HumanViewer | null = null;
  private poseFrame = 0;
  /** Last render(): bodies posed / skipped by the pose-rate throttle, in the view, come into view, held (diagnostics). */
  readonly poseStats = { posed: 0, skipped: 0, shown: 0, entered: 0, held: 0 };
  private poseDue(v: View): boolean {
    const w = this.viewer; if (!w || !v.posedOnce || v.speaking) { v.shown = true; return true; }
    const p = v.cur.p, at = v.rig.holder.position; _bodySphere.center.set(p[0], p[1] + 0.9, p[2]);
    const d = _bodySphere.center.distanceTo(w.eye);
    let shown = w.frustum.intersectsSphere(_bodySphere);
    if (!shown) { _bodySphere.center.set(at.x, at.y + 0.9, at.z); shown = w.frustum.intersectsSphere(_bodySphere); }
    const entered = shown && !v.shown; v.shown = shown;
    if (shown) this.poseStats.shown++;
    if (entered) { this.poseStats.entered++; return true; }
    const every = !shown ? 8 : d < w.nearM ? 1 : d < w.farM ? 2 : 4;
    return every === 1 || ((this.poseFrame + Math.floor(v.vary * 8)) % every) === 0;
  }
  private stationBeat:DepictionBeat|null=null;
  /** Explicit renderer phase only; cannot admit an activity or replace hands. */
  setStationBeat(beat:DepictionBeat|null){this.stationBeat=beat?{...beat}:null;}
  private views = new Map<string, View>();
  /** Authoritative draw identity; uploaded GLTF node names cannot masquerade as another actor. */
  bodyObject(id:string):THREE.Object3D|null{return this.views.get(id)?.rig.holder??null;}
  private templates: Template[] = [];
  private bodyTemplates:ReadonlyMap<string,Template>=new Map();
  setBodyTemplates(templates:ReadonlyMap<string,Template>){this.bodyTemplates=templates;}
  private parts = new Map<string, Part>();
  private fixtureHandling = new Map<string, import('../../engine/world/catalog.ts').Handling>();
  setFixtureHandling(handling: Record<string, import('../../engine/world/catalog.ts').Handling>) {
    this.fixtureHandling = new Map(Object.entries(handling));
  }
  private flights: Flight[] = [];
  private readingActors = new Set<string>();
  private climbs: { id: string; path: [number, number, number][] }[] = [];

  private heldPictureFactory?: HeldPictureFactory;
  private readonly heldPictures = new Map<string, Map<string, {key:string; picture:HeldPicture; hand:'left'|'right'}>>();
  setHeldPictureFactory(factory: HeldPictureFactory | undefined) { this.clearHeldPictures(); this.heldPictureFactory = factory; }
  private clearHeldPictures(id?: string) { for (const [actor, pictures] of this.heldPictures) if (id === undefined || id === actor) { for (const p of pictures.values()) p.picture.dispose(); this.heldPictures.delete(actor); } }

  private readonly humanPresets: boolean;
  constructor(humanPresets = false) {
    this.humanPresets = humanPresets;
    this.group.name = 'engine humans';
  }

  setTemplates(ts: Template[]) {
    // Materials only: shared in-place surface finish on each template's own GLB materials (every clone shares
    // them), before any rig or appearance preset is prepared. Idempotent; rigs/geometry untouched.
    for (const t of ts) applyHumanFinish(t.name, t.gltf.scene);
    this.templates = ts;
  }
  /** Optional presentation readiness, never a simulation/action barrier. */
  async appearancesSettled(ids?:ReadonlySet<string>){await Promise.all([...this.views].filter(([id])=>!ids||ids.has(id)).flatMap(([,v])=>v.appearance?[v.appearance.ready]:[]));}
  appearanceStatus(){return [...this.views].map(([id,v])=>({id,...(v.appearance?.snapshot()??{state:'simple',presetId:null,template:v.rig.template.name,ownedMaterials:0})}));}
  private syncAppearance(v:View,key:string|undefined){
    if(!this.humanPresets||v.appearance&&v.appearanceSoulKey===key)return;
    if(v.appearance&&!v.appearance.retire())return; // retain foreign-reference quarantine, never stack owners
    v.appearanceSoulKey=key;const a=v.appearance=new HumanActorAppearance(v.rig.model,v.rig.appearance,key);
    // a preset recolours the body's own primitives: draw those while it is attached (body-merge.ts)
    void a.ready.then(()=>{if(v.appearance===a)setBodyMerged(v.rig,a.snapshot().state!=='attached');});
  }

  /** Stair flights people may be on (the Spatial scene's usable stairs links; call when they change). */
  setStairs(links: Link[]) {
    this.flights = links.map(flightOf).filter((f): f is Flight => !!f);
    this.climbs = links.filter((l) => l.kind === 'climb').map((l) => ({ id: l.id, path: l.path as [number, number, number][] }));
  }
  private supplementalFlights:readonly Flight[]=[];
  setSupplementalStairs(flights:readonly Flight[]){this.supplementalFlights=flights;}

  /** Lab activity attention; a bounded head turn, never rotates a claimed seated body. Call once per tick. */
  setAttention(targets: Record<string, [number, number]>) {
    for (const [id, v] of this.views) {
      const q = targets[id];
      const want = q && v.cur.walkW < 0.1 ? Math.max(-0.65, Math.min(0.65, (Math.atan2(q[1] - v.cur.p[2], q[0] - v.cur.p[0]) - v.cur.yaw + Math.PI * 3) % (Math.PI * 2) - Math.PI)) : 0;
      const prior = v.gaze?.cur ?? 0;
      v.gaze = { prev: prior, cur: prior + Math.max(-0.1, Math.min(0.1, want - prior)) };
    }
  }
  attention() { return [...this.views].map(([id, v]) => ({ id, turn: v.gaze?.cur ?? 0 })); }
  /** Bodies speaking right now (viewer speech): seated and standing talkers gesture with the library talking clips. */
  setSpeaking(ids: ReadonlySet<string>) { for (const [id, v] of this.views) v.speaking = ids.has(id); }

  /** The flights in use (tests: tread tops). */
  stairs() {
    return [...this.flights,...this.supplementalFlights].map((f) => ({ id: f.id, o: f.o, dir: f.dir, going: f.going, width: f.width, yBottom: f.yBottom, yTop: f.yTop, treads: f.treads.map((t) => ({ ...t })) }));
  }

  clear() {
    this.clearHeldPictures();
    for (const v of this.views.values()) {
      v.appearance?.retire();
      v.rig.mixer.stopAllAction();
      v.rig.mixer.uncacheRoot(v.rig.model);
      disposeSkeletons(v.rig.model);
    }
    this.views.clear();
    this.group.clear();
  }

  /** Create/destroy rigs to match the world and take a first snapshot. */
  reset(world: WorldState) {
    this.clear();
    this.onTick(world);
  }

  private make(id: string, s: Snap, activity: string,publicSoulKey?:string,bodyModel?:string, sourceOnly = false): View {
    const rig = createRig(bodyModel?this.bodyTemplates.get(bodyModel)!:templateFor(id, this.templates)!);
    if (!sourceOnly) mergeRigBody(rig);   // a classic body's primitives draw as one (body-merge.ts)
    rig.holder.name = id;
    rig.holder.traverse(o=>{
      o.userData.entity=id;const m=o as THREE.SkinnedMesh,p=THREE.SkinnedMesh.prototype;
      if(m.isSkinnedMesh&&m.computeBoundingSphere===p.computeBoundingSphere&&m.getVertexPosition===p.getVertexPosition&&m.applyBoneTransform===p.applyBoneTransform)m.computeBoundingSphere=computeBodySphere;
    });
    this.group.add(rig.holder);
    const arms = armsOf(rig), legs = legsOf(rig), spine = spineOf(rig);
    const touched = [...arms.flatMap((a) => [a.upper, a.lower, a.shoulder, a.hand, ...a.fingers, ...a.thumb]), ...legs.flatMap((l) => [l.upper, l.lower, l.foot]), spine?.body, spine?.hips, spine?.abdomen, spine?.torso, spine?.head, rig.model.getObjectByName('Root')];
    const saved = touched.filter((o): o is THREE.Object3D => !!o).map((o) => ({ o, p: o.position.clone(), q: o.quaternion.clone() }));
    const h = hashId(id);
    const v: View = { rig, prev: s, cur: { ...s }, speed: 0, activity, age: 0, base: activity, arms, legs, spine, seat: SEAT_DEFAULT, vary: (h % 1000) / 1000, cross: ((Math.imul(h, 2654435761) >>> 15) & 1) === 1, saved, layered: false, reachRatio: [], ankle: [], footRest: [], footLat: [], surf: { foot: new Map(), hand: new Map() }, dist: 0, libOn: new Set() };
    v.clipReference=[];rig.model.traverse(o=>{if((o as THREE.Bone).isBone)v.clipReference!.push({o,p:o.position.clone(),q:o.quaternion.clone(),s:o.scale.clone()});});
    measure(v);
    holdable(v);
    this.views.set(id, v);
    if(!bodyModel)this.syncAppearance(v,publicSoulKey);
    return v;
  }

  /** Call after every engine tick. Pure function of (previous snapshot, world). */
  onTick(world: WorldState) {
    if (!this.templates.length) return;
    this.readingActors = new Set(Object.values(world.entities).filter(e =>
      e.equipment?.kind === 'reading' && e.equipment.config.status === 'active' && e.equipment.config.phase === 'reading'
    ).map(e => String(e.equipment!.config.user)));
    let fx: Fixtures | undefined;
    for (const e of Object.values(world.entities)) {
      if (e.kind !== 'human' || !e.human || e.body?.family==='floater'||!templateFor(e.id,this.templates)) continue;
      const act = e.human.activity;
      const base = baseOf(act, e.human.baseActivity);
      let v = this.views.get(e.id);
      if (!v) {
        const s: Snap = { p: [...e.pose.p], yaw: e.pose.yaw, walkW: 0, walkT: 0, idleT: (e.id.length * 0.37) % 1, sitW: base === 'sit' ? 1 : 0, warmW: act === 'warm' ? 1 : 0, expressionT: world.tick * DT, pose: NEUTRAL, hands: copyHands(e.human.hands), pr: null };
        const key=(e.human as {soul?:unknown}).soul;
        v = this.make(e.id, s, act,typeof key==='string'?key:undefined);
        v.base = base;
        // A live/lab view joining an already active wave has no certified onset.
        // Retain full attained weight, as replay does for a pre-window wave.
        if(act==='wave'){v.waveEvents=[{start:world.tick*DT-WAVE_BLEND_SECONDS}];v.waveSamples=[{}];v.waveClock=world.tick*DT;}
        v.grip = e.human.grip?.entity;
        v.gripSlot = e.human.grip?.slot;
        v.cur.pose = v.prev.pose = this.postureGoal(v, e, world, false);
        continue;
      }
      const priorReading = v.readingGaze?.cur ?? 0;
      const publicSoulKey=(e.human as {soul?:unknown}).soul;
      this.syncAppearance(v,typeof publicSoulKey==='string'?publicSoulKey:undefined);
      const wantedReading = this.readingActors.has(e.id) ? .35 : 0;
      v.readingGaze = {prev:priorReading,cur:priorReading+Math.max(-.04,Math.min(.04,wantedReading-priorReading))};
      const c = v.cur;
      // Ground speed: the engine's (walk_to publishes human.speed, W4) or the position delta.
      const inst = Math.hypot(e.pose.p[0] - c.p[0], e.pose.p[2] - c.p[2]) / DT;
      const ground = act === 'ride' || act === 'row' ? 0 : e.human.speed ?? inst; // a vehicle carries a rider: no gait from its motion
      v.speed += (ground - v.speed) * 0.6;
      if (act !== v.activity && postureKind(act, base) !== postureKind(v.activity, v.base)) { const was = v.postureChange; v.postureChange = { from: v.activity, ...(v.base ? { fromBase: v.base } : {}), to: act, age: 0, ...(was && was.age < ACT_HISTORY ? { before: { ...was, before: undefined } } : {}) }; }
      else if (v.postureChange) { v.postureChange.age += DT; if (v.postureChange.before) v.postureChange.before.age += DT; }
      if (act !== v.activity) {
        const clock=world.tick*DT;
        if(v.activity==='wave'&&v.waveEvents?.length)v.waveEvents[v.waveEvents.length-1].end=clock;
        if(act==='wave'){if(!v.waveEvents?.length)v.waveRestAge=v.restAge;(v.waveEvents??=[]).push({start:clock});}
        v.prevWaveDuration=v.activity==='wave'?v.since:undefined;
        v.prevAct = v.activity; v.prevBase = v.base; v.prevDuration=(v.age+1)*DT;v.prevInstrument=v.instrument;
      }
      v.age = act === v.activity ? v.age + 1 : 0;
      v.pointAim = undefined; v.pointAimTime = undefined;
      v.since = v.age * DT;
      if(v.waveEvents){
        const human=e.human,owner=human.hands?.left||human.hands?.right||human.grip||human.handHold||human.rps||human.heldItemsV1?.left||human.heldItemsV1?.right||human.on;
        if(owner||(act!=='wave'&&act!=='idle'&&!GAIT_ACTS.has(act))){v.waveEvents=undefined;v.waveSamples=[];v.waveClock=undefined;v.waveRestAge=undefined;}
      }
      if(v.waveSamples?.length===0&&act!=='wave'&&(v.since??0)>=WAVE_BLEND_SECONDS)v.waveSamples=undefined;
      if(v.waveEvents){
        const clock=world.tick*DT;if(v.waveRestAge!==undefined)v.waveRestAge+=DT;v.waveEvents=v.waveEvents.filter(e=>e.end===undefined||clock-e.end<WAVE_BLEND_SECONDS);
        v.waveSamples=v.waveEvents.map(e=>e.end===undefined?{age:clock-e.start}:{released:clock-e.end,duration:e.end-e.start});v.waveClock=clock;
        if(!v.waveEvents.length){v.waveEvents=undefined;v.waveSamples=undefined;v.waveClock=undefined;v.waveRestAge=undefined;}
      }
      v.activity = act;
      v.groundSeat = onGround(act, e.human.baseActivity);
      v.partner = (e.human as { partner?: string }).partner;
      const pe = v.partner ? world.entities[v.partner] : undefined;
      v.partnerP = pe ? new THREE.Vector3(...pe.pose.p) : undefined;
      v.dist += Math.hypot(e.pose.p[0] - c.p[0], e.pose.p[2] - c.p[2]);
      v.shore = undefined;
      v.shoreTime = undefined;
      v.waterTransition = undefined;
      if(v.handActuator&&!e.human?.handActuator)v.lastHandActuator=v.handActuator;else if(e.human?.handActuator)v.lastHandActuator=undefined;
      v.handActuator=e.human?.handActuator;v.handActuatorTime=world.tick*DT;v.watering=e.human?.wateringV1;v.wateringTime=world.tick*DT;v.letGo=e.human?.letGoV1;v.letGoTime=world.tick*DT;v.cup=e.human?.cupV1;v.cupTime=world.tick*DT;v.transfer=e.human?.handTransferV1;v.transferTime=world.tick*DT;
      v.itemPose=itemPoseOf(e.human?.itemTransferV1,e.human?.heldItemsV1,world.tick,DT);
      v.handHold=e.human?.handHold;v.rps=e.human?.rps;v.hgTick=world.tick;v.hgDt=DT;{const q=v.handHold?world.entities[v.handHold.with]:undefined;v.holdP=q?new THREE.Vector3(...q.pose.p):undefined;}
      v.sleepPose = e.human?.sleepPose;
      v.base = base;
      v.propWanted = (e.human as { prop?: string }).prop;
      v.nativeHands = undefined;
      v.heldEntries = undefined; // old tick input makes no claim about native held metadata
      v.consumeMove = undefined;
      v.instrument=(e.human as {instrument?:string}).instrument;v.game=recordedGame((e.human as {game?:unknown}).game)??undefined;v.gameTick=world.tick;v.gameDt=DT;
      v.gait = chooseGait(v.gait, v.speed, world.tick * DT, act === 'jog' || act === 'run'); v.running = v.gait.running;
      v.grip = e.human.grip?.entity;
      v.gripSlot = e.human.grip?.slot;
      v.on = e.human.on;
      v.frame = frameCtx(e.human.on, act, (id) => world.entities[id], this.climbs);
      // Honest clip mapping: Walk only while the body actually moves over the ground (walk, stairs,
      // carry on the move, a crew gathering), speed-matched; a walker pushed to a stop (engine 'wait',
      // speed 0) or anyone standing plays Idle within 0.2 s, with the pose layers of render() on top.
      // sit-down / stand-up (0.6 s, engine/social) slide the body point between the seat's approach
      // point and the seat: that is the sit pose blending in/out, not walking.
      const seated = SEATED.has(base);
      const walking = !seated && ground >= WALK_EPS;
      if (seated || act === 'warm') {
        fx ??= fixturesOf(world);
        if (seated) {
          const n = nearest(fx.seats, e.pose.p[0], e.pose.p[2]);
          v.seat = act === 'cycle' ? BIKE_SADDLE : onGround(act, e.human.baseActivity) ? GROUND_SEAT : n.f && n.d <= SEAT_MATCH ? n.f[2] - e.pose.p[1] : SEAT_DEFAULT;
        } else v.fire = nearest(fx.fires, e.pose.p[0], e.pose.p[2]).f;
      }
      const sitting = (base === 'sit' || base === 'sit-down') && !walking;
      const walkW = clamp01(c.walkW + (walking ? BLEND : -BLEND));
      // idle-variety onset clock: restarts from a full stride or anything other than standing; a walk start (weight still
      // easing in) or a short nudge does not restart it, so a gesture fades out with the walk's own blend
      if (GAIT_ACTS.has(act)) { if (v.walkAge === undefined) { v.walkAge = 0; v.restAgeAtWalk = v.restAge; } else v.walkAge += DT; }
      else v.walkAge = v.restAgeAtWalk = undefined;
      const moving = GAIT_ACTS.has(act) && walkW >= WALK_FULL_LIVE;
      v.restAge = moving || (!REST_ACTS.has(act) && !GAIT_ACTS.has(act)) ? 0 : v.restAge === undefined ? undefined : v.restAge + DT;
      // on a beam: short steps — the stride at half the Walk weight is about half the clip's, so the cadence doubles
      const rate = walking ? Math.max(0.35, v.speed / v.rig.template.walkSpeed) * (act === 'beam-walk' ? BEAM_CADENCE : 1) : 1;
      const dur = v.rig.walk.getClip().duration;
      v.prev = c;
      v.cur = {
        p: [...e.pose.p],
        yaw: e.pose.yaw,
        walkW,
        walkT: walkW > 0 ? (c.walkT + DT * rate) % dur : 0,
        idleT: (c.idleT + DT) % v.rig.idle.getClip().duration,
        sitW: clamp01(c.sitW + (sitting ? POSE_BLEND : -POSE_BLEND)),
        expressionT: world.tick * DT,
        warmW: clamp01(c.warmW + (act === 'warm' && !walking ? POSE_BLEND : -POSE_BLEND)),
        // lying / getting up (prone.ts): the posture waits kneeling, so stand_with_load blends out of a kneel
        pose: PRONE_ACTS.has(act) && v.dims ? { drop: kneelDrop(v.dims), bend: 0, rise: 0, kneel: 1 } : approach(c.pose, this.postureGoal(v, e, world, walking), POSE_BLEND),
        hands: copyHands(e.human.hands),
        pr: this.proneGoal(v, e, world, c.pr, false),
      };
    }
    for (const [id, v] of this.views)
      if (!world.entities[id]) {
        v.rig.mixer.stopAllAction();
        v.rig.mixer.uncacheRoot(v.rig.model);
        v.appearance?.retire();
        disposeSkeletons(v.rig.model);
        this.group.remove(v.rig.holder); if (v.bike) this.group.remove(v.bike);
        this.views.delete(id);this.clearHeldPictures(id);
      }
    this.trackParts((id) => world.entities[id]);
  }

  /**
   * Where the body should be (posture.ts) for this tick's hand targets: the engine's published hand
   * points, else each arm's grip slot point on the gripped part (from a standing shoulder estimate).
   * Seated people and people without targets stand neutral.
   */
  private postureGoal(v: View, e: Entity, world: WorldState, walking: boolean): Posture {
    const d = v.dims;
    if (!d || SEATED.has(v.base) || v.frame?.kind === 'ladder') return NEUTRAL;
    // on a stance with a load the body turns on the rod toward it (frame-gait.ts): solve in that frame
    const turned = v.frame?.kind === 'stance' ? stanceFacing(v.frame, [e.pose.p[0], e.pose.p[2]], handList(e.human?.hands ?? {})) : null;
    const yaw = turned ?? e.pose.yaw, c = Math.cos(yaw), s = Math.sin(yaw), o = e.pose.p;
    const toBody = (x: number, y: number, z: number, side: number): Target => {
      const rx = x - o[0], rz = z - o[2], lat = -rx * s + rz * c;
      return { f: rx * c + rz * s, lat: side < 0 ? Math.min(lat, -0.01) : Math.max(lat, 0.01), up: y - o[1] };
    };
    const ts: Target[] = [];
    const hands = e.human?.hands;
    if (hands && (hands.left || hands.right)) {
      // Soul Actions 34: the free hand on a tap's valve (chest height) asks nothing of the body; only the can hand leans it
      if (hands.left && !e.human?.wateringV1) ts.push(toBody(hands.left[0], hands.left[1], hands.left[2], -1));
      if (hands.right) ts.push(toBody(hands.right[0], hands.right[1], hands.right[2], 1));
    } else if (v.grip && v.gripSlot !== STATION_SLOT) {
      const part = world.entities[v.grip];
      if (part) {
        for (const side of [-1, 1]) {
          const sh = new THREE.Vector3(o[0] + c * (d.sh.f) - s * side * d.shHalf, o[1] + d.pivotH + d.sh.up, o[2] + s * d.sh.f + c * side * d.shHalf);
          const out = new THREE.Vector3();
          const r = slotPoint(part, v.gripSlot ?? '', sh, o[1], out, this.fixtureHandling.get(part.def));
          if (r === false) continue;
          if (r === undefined && !boxNearest(part, sh, out)) continue;
          ts.push(toBody(out.x, out.y, out.z, side));
        }
      }
    }
    if(v.itemPose?.transfer&&!v.handActuator){
      // Opted-in item transfer: one posture toward the fixed grasp / placement point, on the reach hump; standing
      // before and after it. Solving against the moving hand hopped between grid minima and popped at its ends.
      const r=v.itemPose.posture;
      if(!r)return NEUTRAL;
      // entry 43: 'lean' (hips, little knee): a shorter body set a mug on a 0.75 m table in a 0.26 m squat with 'hips'
      const q=solvePosture(d,[toBody(r.target[0],r.target[1],r.target[2],r.hand==='left'?-1:1)],'lean');
      return {drop:q.drop*r.k,bend:q.bend*r.k,rise:q.rise*r.k,kneel:q.kneel*r.k};
    }
    // Entry 43: a handle-held vessel's fill or pour leans toward its one fixed hold point (under the tap, over the cup),
    // eased with the hand on the stage's own clock ('hips', as 34's per-frame solve: 'lean' squatted 0.16 m under a
    // 1.33 m hold close to the chest). A hold well above the hips (a kettle over a cup) is a standing hold: at most a small
    // lean ('walk': ≤ 25°, ≤ 8 cm); 'hips' squatted a taller body 12 cm to keep the kettle hand off its chest (take 5).
    // Solved per frame against the moving hand it hopped between grid minima:
    // a 0.26 m one-frame dip as the kettle hand passed 1.2 m on its way up to a pour.
    // Soul Actions 44: a mug at the lips or under a tap asks nothing of the body while drinking (it is brought to the
    // mouth, the mouth is not brought to it); under a tap the body leans a little toward the hold, on the frame's own ease
    // ('stand', entry 33's reach at or above the hips: under 'walk' the knees bent and the hips went back at the basin)
    if(v.cup&&!walking){const m=v.cup,c=cupFrame(m,(v.cupTime??0)-m.startTick*DT);if(m.stage==='drink'||!m.hold)return NEUTRAL;
      const k=(c.a==='hold'?1-c.k:0)+(c.b==='hold'?c.k:0),t=toBody(m.hold[0],m.hold[1]+MUG.wrapUp,m.hold[2],m.hand==='left'?-1:1),q=solvePosture(d,[t],'stand');
      return {drop:q.drop*k,bend:q.bend*k,rise:q.rise*k,kneel:q.kneel*k};}
    if(v.watering&&!v.handActuator&&!walking){const m=v.watering,k=wateringFrame(m,(v.wateringTime??0)-m.startTick*DT).right,t=toBody(m.hold[0],m.hold[1],m.hold[2],1),q=solvePosture(d,[t],t.up>d.hipH+0.15?'walk':'hips');return {drop:q.drop*k,bend:q.bend*k,rise:q.rise*k,kneel:q.kneel*k};}
    // A hand actuator whose hand points are all at or above the hip joints is a standing reach: lean, never dip.
    // Entry 40: doors too (a door's knob at 1.04 m is above every rig's hips). Entry 31's close from the push side stands 3 cm
    // farther from the leaf for wall clearance; under `knees` that 0.63 m push dipped the hips 0.17 m (0.086 before 31).
    // A latch below the hips keeps its small bend (`knees`).
    const style = styleFor(v.activity, walking), standing = style === 'knees' && !!v.handActuator && ts.length > 0 && ts.every((t) => t.up >= d.hipH);
    // entry 43: taking or putting a handle-held thing (a kettle) leans like the vessel stages: 'hips' flickered its hips 4 cm
    // A native carry's arms stop at CARRY_EXTENSION of their length: plan the body for that reach, less a margin for the
    // gait's sway. Planned for the usual 0.92, the shoulders stopped where the far hand of a held beam fell up to 4 cm
    // short of its contact. A walking carrier is planned as a standing one: the walk's own limits (8 cm, 25 degrees)
    // left that hand up to 8 cm short, and the hands stay on the load before the gait keeps its shape.
    const carried = v.carryWeight !== undefined && !!hands && !!(hands.left || hands.right);
    const pz = solvePosture(d, ts, v.transfer && v.transfer.endTick === undefined && v.activity === 'reach' && !walking ? 'lean' : standing ? 'stand' : carried && walking ? styleFor(v.activity, false) : style, carried ? CARRY_EXTENSION - CARRY_PLAN_MARGIN : undefined);
    // A low latch may need a small bend as well as a hand reach. Ease the whole
    // solved posture on the same timeline so the torso cannot pop in/out.
    if(v.handActuator){const k=handActuatorFrame(v.handActuator,(v.handActuatorTime??0)-v.handActuator.startTick*DT).weight;for(const key of ['drop','bend','rise','kneel'] as const)pz[key]*=k;}
    // entry 43: a take's or put's posture rises over its reach and settles over the hand's way back (a hump, as 29's item
    // reach): at the put's full arm weight from its first frame the free arm swung 0.099 m in one sample as the bend
    // switched on; and once a take has ended the hand hangs at its carry point and asks nothing of the body (held at full
    // weight, a full kettle at the side kept a body 8 cm down, standing and walking, until the next put popped it up)
    if(v.transfer){const ts=(v.transferTime??0)-v.transfer.startTick*DT,r=v.transfer.reach,k=v.transfer.endTick!==undefined&&v.transfer.mode==='take'?0:ts<r?smooth(ts/r):1-smooth((ts-r)/r);for(const key of ['drop','bend','rise','kneel'] as const)pz[key]*=k;}

    // on a frame's bracing: crouch / bend on the rod, never kneel or rise onto the toes
    const weight = v.carryWeight;
    const blended = weight === undefined ? pz : {drop:pz.drop*weight, bend:pz.bend*weight, rise:pz.rise*weight, kneel:pz.kneel*weight};
    return v.frame?.kind === 'stance' ? { ...blended, kneel: 0, rise: 0 } : blended;
  }

  /**
   * Prone layer (prone.ts) for this tick: in a prone activity the rise coordinate from the engine's `phaseK` (exact),
   * else its phase clock (`v.age`; a take frame without phaseK has no clock, `settled`: the phase's end pose), the body
   * turn from the engine's lying heading (`proneYaw`; else searched), and the torso pitch that brings the shoulders
   * within reach of the engine's hand points; after it the last pose, fading out over 0.4 s while the posture layer
   * takes over (humans.ts pose blends the bones).
   */
  private proneGoal(v: View, e: Entity, world: WorldState, cur: ProneState | null, settled: boolean): ProneState | null {
    const d = v.dims, act = v.activity;
    if (!d) return null;
    if (e.human?.sleepPose) {
      v.proneEng = undefined;
      return sleepGoal(e.human.sleepPose, e.pose.yaw);
    }
    if (PRONE_ACTS.has(act)) {
      const k = e.human?.phaseK, turn = engineTurn(e.pose.yaw, e.human?.proneYaw);
      v.proneEng = { turn, k };
      const clock = riseOf(act, settled ? 1e6 : v.age, k), prev = settled ? null : cur;
      // getting up the body follows the engine's rise (smooth(phaseK); the fallback clock without it) but may wait for
      // the load it holds, never ahead of the engine and never back down (this rig's arms are not the engine's cylinder)
      const rising = act === PRONE_ACTIVITY.pushUp || act === PRONE_ACTIVITY.kneelUp;
      const rLo = rising && prev ? Math.min(prev.r, clock) : clock, rHi = rising && prev ? Math.min(clock, prev.r + RISE_STEP) : clock;
      const c = Math.cos(e.pose.yaw), s = Math.sin(e.pose.yaw), o = e.pose.p;
      const ts = handList(e.human?.hands ?? {}).map((q): Target => {
        const rx = q[0] - o[0], rz = q[2] - o[2];
        return { f: rx * c + rz * s, lat: -rx * s + rz * c, up: q[1] - o[1] };
      });
      // a turned body must still lie on the deck: installed sheets whose top is the level they lie on
      const decks = Object.values(world.entities).filter((q) => q.phase === 'installed' && q.def.startsWith('plywood') && Math.abs(q.pose.p[1] + (CATALOG[q.def]?.size[1] ?? 0) - o[1]) < 0.03 && !q.pose.roll && !q.pose.pitch);
      const onDeck = (f: number, lat: number) => {
        const x = o[0] + f * c - lat * s, z = o[2] + f * s + lat * c;
        return decks.some((q) => {
          const sz = CATALOG[q.def].size, dx = x - q.pose.p[0], dz = z - q.pose.p[2], qc = Math.cos(q.pose.yaw), qs = Math.sin(q.pose.yaw);
          return Math.abs(dx * qc + dz * qs) <= sz[0] / 2 + 1e-6 && Math.abs(-dx * qs + dz * qc) <= sz[2] / 2 + 1e-6;
        });
      };
      const g = solveProne(d, ts, rLo, rHi, onDeck, prev ?? undefined, turn);
      const next = approachProne(prev, { r: g.r, bend: g.bend, turn: g.turn, yaw: 0, w: 1, slide: g.slide }, POSE_BLEND, turn !== undefined);
      return { ...next, yaw: e.pose.yaw + next.turn };
    }
    v.proneEng = undefined;
    return cur && cur.w > 0 ? { ...cur, w: Math.max(0, cur.w - POSE_BLEND) } : null;
  }

  /** Keep the last two poses of every gripped part (and forget parts nobody grips). */
  private trackParts(get: (id: string) => Entity | undefined) {
    const held = new Set<string>();
    for (const v of this.views.values()) if (v.grip) held.add(v.grip);
    for (const id of this.parts.keys()) if (!held.has(id)) this.parts.delete(id);
    for (const id of held) {
      const e = get(id);
      if (!e) continue;
      const pose: Pose = { p: [...e.pose.p], yaw: e.pose.yaw, pitch: e.pose.pitch ?? 0, roll: e.pose.roll ?? 0 };
      const was = this.parts.get(id);
      this.parts.set(id, { def: e.def, prev: was?.def === e.def ? was.cur : pose, cur: pose });
    }
  }

  /**
   * Random-access pose for take replay: set every rig straight from a sampled frame (no tick
   * history, so scrubbing backwards or jumping gives the same picture as playing through; sit is
   * therefore fully in or out, at the default seat height — takes carry no fixtures; postures are
   * solved for the frame without the 0.4 s blend).
   * Rigs for ids missing from `frame` are removed. Follow with `render(1, reach)`.
   */
  setFrame(frame: SampledHuman[], t: number, parts: Record<string, Entity> = {}, rigBudget?:RigCreationBudget) {
    if (!this.templates.length&&!this.bodyTemplates.size) return;
    const seen = new Set<string>();
    const world = { entities: parts } as unknown as WorldState;
    for (const f of frame) {
      if(f.bodyModel?!this.bodyTemplates.has(f.bodyModel):!templateFor(f.id,this.templates))continue;
      seen.add(f.id);
      // a record that goes straight between standing and a seat draws the old engine's own sit-down / stand-up phase
      const pc = f.postureChange, seatPlan = seatTransition(pc, f.activity ?? 'idle', f.baseActivity);
      const seatMove = seatPlan ? pc!.age < seatPlan.end ? seatPlan : null : pc ? postureNow(pc, f.activity ?? 'idle', f.baseActivity) : null;
      const act = seatMove?.activity ?? f.activity ?? 'idle';
      const base = baseOf(act, seatMove?.activity ?? f.baseActivity);
      let v = this.views.get(f.id);
      const wanted=f.bodyModel?this.bodyTemplates.get(f.bodyModel):templateFor(f.id,this.templates);
      // A live arrival can finish many unique templates together. Defer only new rigs, keeping every existing actor
      // on the current sample (and its old body until a replacement can be made). No pose is queued across frames.
      if((!v||v.rig.template!==wanted)&&(!rigBudget||rigBudget.remaining>0)){
        if(v){v.rig.mixer.stopAllAction();v.rig.mixer.uncacheRoot(v.rig.model);v.appearance?.retire();disposeSkeletons(v.rig.model);v.rig.holder.removeFromParent();this.views.delete(f.id);this.clearHeldPictures(f.id);}
        v=this.make(f.id, { p: [...f.p], yaw: f.yaw, walkW: 0, walkT: 0, idleT: 0, sitW: 0, warmW: 0, expressionT: t, pose: NEUTRAL, hands: {}, pr: null }, act,f.publicSoulKey,f.bodyModel);if(rigBudget)rigBudget.remaining--;
      }
      if(!v)continue;
      if(!f.bodyModel&&v.rig.template===wanted)this.syncAppearance(v,f.publicSoulKey);
      const walkDur = v.rig.walk.getClip().duration, idleDur = v.rig.idle.getClip().duration;
      v.activity = act;
      if(v.handActuator&&!f.handActuator)v.lastHandActuator=v.handActuator;else if(f.handActuator)v.lastHandActuator=undefined;
      v.handActuator=f.handActuator;v.handActuatorTime=f.handActuatorTime;v.watering=f.watering;v.wateringTime=f.wateringTime;v.letGo=f.letGo;v.letGoTime=f.letGoTime;v.cup=f.cup;v.cupTime=f.cupTime;v.transfer=f.transfer;v.transferTime=f.transferTime;
      v.itemPose=f.itemPose; v.formPress=formPresses(f.formPress); v.pointAim=pointAimOf(f.pointAim); v.pointAimTime=f.pointAimTime;
      v.sleepPose = f.sleepPose;
      v.shore = f.shore;
      v.shoreTime = f.shoreTime;
      v.waterTransition = f.waterTransition;
      v.base = base;
      v.grip = f.grip;
      v.gripSlot = f.gripSlot;
      v.carryWeight = f.carryWeight;
      v.on = f.on;
      v.frame = frameCtx(f.on, act, (id) => parts[id], this.climbs);
      const seatHeight = seatPlan?.activity === 'stand-up' ? f.seatOrigin?.height ?? f.seatHeight : f.seatHeight;
      v.seat = act==='cycle'?BIKE_SADDLE:SEATED.has(base)&&!f.on&&!f.grip&&typeof seatHeight==='number'&&Number.isFinite(seatHeight)&&seatHeight>0&&seatHeight<=1.2?seatHeight:SEAT_DEFAULT;
      v.bench = LYING.has(act)||act==='bench-press'?(typeof f.seatHeight==='number'&&Number.isFinite(f.seatHeight)&&f.seatHeight>0&&f.seatHeight<=1.2?f.seatHeight:0):0;
      v.groundSeat = onGround(act, f.baseActivity);
      if (v.groundSeat) v.seat = GROUND_SEAT;
      v.propWanted = f.heldEntries?.entries.length===0 ? undefined : f.prop;
      v.heldEntries = f.heldEntries;
      v.nativeHands = f.nativeHands;
      v.consumeMove = f.consumeMove;
      v.instrument=f.instrument;v.game=f.game;v.gameTick=f.gameTick;v.gameDt=f.gameDt;
      v.speed = typeof f.speed === 'number' ? f.speed : 0;
      v.gait = chooseGait(v.gait, v.speed, t, act === 'jog' || act === 'run'); v.running = v.gait.running;
      v.since = seatMove?.activity ? seatMove.since : f.activityAge;
      v.clipOrigin = f.clipOrigin;
      v.seatSample = seatPlan || SEATED.has(base) || f.clipOrigin && SEATED.has(baseOf(f.clipOrigin.sample.activity ?? 'idle', f.clipOrigin.sample.baseActivity)) ? f : undefined;
      v.seatPlan = seatPlan;
      v.heldArmOrigin=f.heldArmOrigin;v.heldArmKnown=f.heldArmKnown;
      v.postureChange = f.postureChange;
      v.restFrom = f.restAge === undefined ? undefined : t - f.restAge;
      v.restAge = f.restAge;
      v.walkAge = f.walkAge;
      v.restAgeAtWalk = f.restAgeAtWalk;
      v.prevAct = f.prevActivity;v.prevDuration=f.prevActivityDuration;v.prevInstrument=f.prevInstrument;
      v.prevWaveDuration=f.prevWaveDuration;v.waveRestAge=f.waveRestAge;v.waveSamples=f.waveSamples;v.waveClock=f.waveClock;
      v.prevBase = f.prevActivity === undefined ? undefined : baseOf(f.prevActivity, f.prevBaseActivity);
      v.partner = f.partner;
      v.partnerP = undefined;
      v.handHold = f.handHold; v.rps = f.rps; v.hgTick = f.handGameTick; v.hgDt = f.handGameDt; v.holdP = undefined;
      v.dist = f.walkDist;
      const water=!!waterMotionAt(f.id,act,f.shoreTime??t,f.shore)&&!f.hands?.left&&!f.hands?.right&&!f.grip&&!f.on;
      const transition=f.waterTransition,targetWeight=transition?.weight??1,priorWater=transition?.origins.reduce((sum,x)=>sum+(x.pose?x.weight:0),0)??0;
      const free=!f.hands?.left&&!f.hands?.right&&!f.grip&&!f.on;
      const waterWeight=free?clamp01((water?targetWeight:0)+(1-targetWeight)*priorWater):0;
      const walk = SEATED.has(base) ? 0 : f.walk * (1-waterWeight);
      const e = { id: f.id, def: 'human', kind: 'human', pose: { p: f.p, yaw: f.yaw }, human: { activity: act, level: 0, hands: f.hands, proneYaw: f.proneYaw, phaseK: f.phaseK, sleepPose: f.sleepPose, wateringV1: f.watering } } as unknown as Entity;
      const snap: Snap = {
        p: [...f.p],
        yaw: f.yaw,
        walkW: walk,
        walkT: ((f.walkDist / v.rig.template.walkSpeed) % walkDur + walkDur) % walkDur,
        idleT: (t + (f.id.length * 0.37) % 1) % idleDur,
        sitW: base === 'sit' ? 1 : SEATED.has(base) ? 0.5 : 0, // sit-down / stand-up: halfway (no timing here)
        expressionT: t,
        warmW: 0, // no fire position in a take frame
        pose: this.postureGoal(v, e, world, walk > 0.5),
        hands: copyHands(f.hands),
        pr: null,
      };
      v.age = 0;
      snap.pr = this.proneGoal(v, e, world, null, true);
      v.prev = v.cur = snap;
    }
    for (const [id, v] of this.views)
      if (!seen.has(id)) {
        v.rig.mixer.stopAllAction();
        v.rig.mixer.uncacheRoot(v.rig.model);
        v.appearance?.retire();
        disposeSkeletons(v.rig.model);
        this.group.remove(v.rig.holder); if (v.bike) this.group.remove(v.bike);
        this.views.delete(id);this.clearHeldPictures(id);
      }
    for (const f of frame) { const v = this.views.get(f.id); if (v?.partner) { const q = frame.find((g) => g.id === v.partner); v.partnerP = q ? new THREE.Vector3(...q.p) : undefined; } }
    // entry 35: the hand partner's drawn root (both bodies draw their joined hands to one point between them)
    for (const f of frame) { const v = this.views.get(f.id); if (v?.handHold) { const q = frame.find((g) => g.id === v.handHold!.with); v.holdP = q ? new THREE.Vector3(...q.p) : undefined; } }
    this.parts.clear(); // random access: no tick history, so prev = cur
    this.trackParts((id) => parts[id]);
  }

  /**
   * Apply interpolated pose/animation. alpha ∈ [0,1] = fraction of the next tick elapsed.
   * `reach`: nearest point of a gripped part (components.ts) for grips without a known slot.
   */
  /** Entry 36: who plays the piano or the drums now (a singer sings along with the nearest), rebuilt each render. */
  private players: { id: string; p: readonly number[]; kind: 'piano' | 'drums' }[] = [];
  render(alpha: number, reach?: Reach) {
    PLAY_MOTION.value.set(0, 0, 0, 0); // empty playground seats hang at rest; riders set theirs below
    this.players.length = 0;
    for (const [id, v] of this.views) if (v.activity === 'play-piano' || (v.activity === 'play-music' && v.instrument === 'drums')) this.players.push({ id, p: v.cur.p, kind: v.activity === 'play-piano' ? 'piano' : 'drums' });
    this.poseFrame++; const st = this.poseStats; st.posed = st.skipped = st.shown = st.entered = st.held = 0;
    for (const v of this.views.values()) {
      const due = this.poseDue(v);
      // A resumed pose needs fresh matrices throughout reconstruction, including ground fitting.
      if (due) { v.held = false; this.pose(v, alpha, reach); v.posedOnce = true; st.posed++; } else st.skipped++;
      v.held = !due && !v.shown; if (v.held) st.held++;
      for (const item of this.heldPictures.get(v.rig.holder.name)?.values() ?? []) item.picture.object.visible = v.rig.holder.visible;
    }
    // the dock shows one bicycle fewer for each one out under a rider (decorative-motion 'dock-bike')
    let out = 0; for (const v of this.views.values()) if (v.bike?.visible) out++; PLAY_MOTION.value.w = out;
  }

  private pose(v: View, alpha: number, reach?: Reach, sourcePose = false) {
    const a = v.prev, b = v.cur, h = v.rig.holder;
    // Animation bindings capture original values when activated. Reset before activating any clip so random-access
    // evaluation cannot capture a previous procedural layer as the next clip's reference pose.
    // Transition layouts change the lowest torso vertex; a prior-pose shortlist is not a valid contact sample.
    if(v.postureChange)v.restCache=undefined;
    const nativeHandOwner=!!(a.hands.left||a.hands.right||b.hands.left||b.hands.right||v.itemPose||v.handActuator);
    const pointFree=!!v.pointAim&&!nativeHandOwner&&!v.formPress?.length&&!v.itemPose&&!v.handActuator&&!v.lastHandActuator&&!v.transfer&&!v.watering&&!v.cup&&!v.letGo&&!v.handHold&&!v.rps&&!v.propWanted&&!v.prop?.obj.visible&&!v.instrument&&!v.grip&&!v.on;
    const clipHistoryReset=!!v.clipOrigin&&!v.speaking&&!v.instrument&&!v.propWanted&&!v.prop?.obj.visible&&!v.itemPose&&!v.handActuator&&!v.transfer&&!v.watering&&!v.cup&&!v.letGo&&!v.lastHandActuator&&!v.handHold&&!v.rps&&!v.grip&&!v.on&&!v.formPress?.length&&v.cur.walkW<.01&&v.cur.sitW===0&&postureKind(v.activity,v.base)==='stand'&&postureKind(v.clipOrigin.sample.activity??'idle',v.clipOrigin.sample.baseActivity)==='stand';
    const plainIdle=v.activity==='idle'&&!pointFree&&!v.postureChange&&!clipHistoryReset&&!(v.heldArmKnown!==undefined&&heldArmBinding(v)!==undefined);
    const seatReset=!!v.seatSample&&!v.itemPose&&!v.handActuator&&(SEATED.has(v.base)||!!v.seatPlan&&v.seatSample.postureChange!.age<v.seatPlan.end+ACT_BLEND);
    if((!nativeHandOwner || seatReset) && !plainIdle){
      v.rig.mixer.stopAllAction();
      for(const s of v.clipReference??[]){s.o.position.copy(s.p);s.o.quaternion.copy(s.q);s.o.scale.copy(s.s);}
      v.rig.idle.play();v.rig.walk.play();v.layered=false;
    }
    h.position.set(a.p[0] + (b.p[0] - a.p[0]) * alpha, a.p[1] + (b.p[1] - a.p[1]) * alpha, a.p[2] + (b.p[2] - a.p[2]) * alpha);
    let yaw = lerpAngle(a.yaw, b.yaw, alpha);
    const engineYaw = yaw;
    // prone receiver (prone.ts): the lying / rising body may be turned about S toward the hands
    const pr = lerpProne(a.pr, b.pr, alpha);
    // library clips (clip-library.ts): what this body plays now, and what it played just before (crossfade)
    const tSec0 = lerp(a.expressionT, b.expressionT, alpha);
    const lib = this.libraryPlan(v, b, tSec0);
    const proneW = !lib.sleep && pr && v.dims && v.spine && v.legs.length >= 2 ? pr.w : 0;
    if (proneW > 0) yaw = lerpAngle(yaw, pr!.yaw, proneW);
    // rack structure: a climber faces the frame (the engine keeps the stance / link heading), a person on the bracing faces it
    const fp = v.frame ? framePose(v.frame, [h.position.x, h.position.y, h.position.z], yaw, handList(lerpHands(a.hands, b.hands, alpha))) : null;
    const fw = fp?.weight ?? 0;
    if (fp?.facing != null && fw > 0) yaw = lerpAngle(yaw, fp.facing, fw);
    h.rotation.y = -yaw;
    const w = (a.walkW + (b.walkW - a.walkW) * alpha) * (fp?.kind === 'beam' ? BEAM_WALK_W : 1) * (lib.still ? 0 : 1);
    const { walk, idle, mixer, extra } = v.rig;
    const wt = b.walkT >= a.walkT ? a.walkT + (b.walkT - a.walkT) * alpha : b.walkT;
    const opening=v.handActuator?.opening;
    const slide=v.handActuator?.slide;
    // pulling a door toward you or a drawer out, the body steps backwards
    const backwards=(opening&&opening.side*(opening.to-opening.from)<0)||(!!slide&&slide.to>slide.from);
    walk.time=backwards?(walk.getClip().duration-wt%walk.getClip().duration)%walk.getClip().duration:wt;
    idle.time = b.idleT;
    // Body activity layer (activity-poses.ts): free hands only (engine hand points / grips win), never on a frame or prone.
    const tSec = lerp(a.expressionT, b.expressionT, alpha);
    const recordedPress = !!v.formPress?.some(p=>p.current!==false);
    const engineHands = !!(b.hands.left || b.hands.right || a.hands.left || a.hands.right);
    const freeBody = !v.grip && !v.on && !fp && proneW === 0 && !v.sleepPose;
    // Shared Wave eases from its recorded onset and lowers from the attained
    // pose at a stop. Native hand/seat/walk owners keep the final authority.
    const waveReturn=(v.waveSamples?v.waveSamples.some(s=>s.released!==undefined):(v.prevAct==='wave'&&(v.since??Infinity)<WAVE_BLEND_SECONDS)) && (v.activity==='idle'||v.activity==='sit'||v.base==='sit'||GAIT_ACTS.has(v.activity)) && freeBody && !v.handHold && !v.rps;
    const waveActive=v.activity==='wave'||waveReturn;
    const wave=waveActive?wavePose(v.waveSamples??[v.activity==='wave'?{age:v.since}:{released:v.since,duration:v.prevWaveDuration}],v.waveClock??tSec):null;
    const waveBlend=wave?.weight??0;
    const waveTime=wave?.fallbackTime??tSec;
    const waveClip = waveActive && !!extra.wave && !engineHands && b.sitW === 0, interactClip = INTERACT.has(v.activity) && !!extra.interact && !engineHands && b.sitW === 0;
    // a library clip that does the whole body replaces the procedural frame; overlays (hands) stay on top of it
    const clipBody = !!lib.cur && CLIP_BODY.has(v.activity) && lib.cur.pick.body !== 'seat' && !(lib.cur.pick.body === 'ground-seat' && v.activity !== 'sit-ground');
    const pairPhase = v.partner && v.partner < h.name ? v.partner : h.name; // partners move in step
    // entry 36: a singer sings along with the nearest player (her head and breath follow the sung notes); just after her
    // singing ends, the singing frame eases out (the hand lets go of the mic) instead of snapping to the base posture
    const letGo = v.activity !== 'sing' && v.prevAct === 'sing' && (v.since ?? 9) < SING_LET_GO && !GAIT_ACTS.has(v.activity);
    const fluteRelease=v.activity==='idle'&&v.prevAct==='play-music'&&v.prevInstrument==='flute'&&v.since!==undefined&&v.since<.8;
    const pianoRelease=v.activity!=='play-piano'&&(v.prevAct==='play-piano'||v.prevAct==='play-music'&&(v.prevInstrument==='piano'||v.prevInstrument==='keyboard'))&&v.since!==undefined&&v.since<PIANO_FADE;
    // A one-off gesture's age (a bow, a point) is the take's, else carried on from this body's last frame of it: a live
    // take window can begin inside it with no history (its age unknown, its arc restarted at a random phase). One that
    // ends while still out then comes back from where it was over GESTURE_RETURN, on the same clock, not in one frame.
    const g0=v.gesture,gestureAge=!RETURNS.has(v.activity)?undefined:v.since??(g0?.act===v.activity&&tSec>=g0.at&&tSec-g0.at<1?g0.age+tSec-g0.at:0);
    if(gestureAge!==undefined)v.gesture={act:v.activity,age:gestureAge,at:tSec};
    const back=v.activity==='idle'&&g0?tSec-g0.at:-1, gestureBack=back>=0&&back<GESTURE_RETURN;
    const point = v.pointAim, pointNow = v.pointAimTime;
    const pointEnd = point ? Math.min(point.ends.at(-1)!, point.cut ?? Infinity) : 0;
    const pointOwned = pointFree && point && pointNow !== undefined && Number.isFinite(pointNow) && pointNow >= point.start && pointNow < pointEnd + GESTURE_RETURN * 1e6
      && ['point','idle','sit'].includes(v.activity);
    const pointFrame = pointOwned ? activityFrame('point',v.base,tSec,h.name,{since:(pointNow-point.start)/1e6,
      ...(pointNow >= pointEnd ? {released:(pointNow-pointEnd)/1e6,priorAge:(pointEnd-point.start)/1e6} : {})}) : null;
    const act0: ActivityFrame | null = !(recordedPress && v.activity === 'operate') && freeBody && !engineHands && w < 0.5 && !waveClip && !interactClip && !clipBody && !lib.sleep && lib.rise === undefined
      ? letGo ? activityFrame('sing', 'idle', tSec, pairPhase, { since: 9, released: v.since, accompanist: null })
      : fluteRelease ? activityFrame('play-music','idle',tSec-v.since!,pairPhase,{instrument:'flute',actorId:h.name,released:v.since,priorAge:v.prevDuration})
      : pointFrame ?? (gestureBack ? activityFrame(g0!.act,v.base,tSec,pairPhase,{released:back,priorAge:g0!.age})
      : pianoRelease ? activityFrame('play-piano',v.prevBase??'sit',tSec-v.since!,pairPhase,{actorId:h.name,released:v.since,priorAge:v.prevDuration})
      : activityFrame(waveReturn?'wave':v.activity, v.base, waveActive?waveTime:tSec, pairPhase, { groundSeat: v.groundSeat, since: gestureAge ?? v.since, gap: v.partnerP ? Math.hypot(v.partnerP.x - h.position.x, v.partnerP.z - h.position.z) : undefined,instrument:v.instrument,game:v.game,gameTick:v.gameTick,gameDt:v.gameDt,actorId:h.name, ...(v.activity === 'sing' ? { accompanist: accompanistOf(v.cur.p, this.players) } : {}) })) : null;
    // posture-transition.ts: over a change of posture a face-down plank tilts up from (down to) the feet; after getting up
    // the standing activity's own frame eases in; between two standing activities their frames crossfade (ACT_BLEND)
    const pn = lib.posture;
    // A gesture owns its arm fade, not the free body's recorded floor-to-standing transition.
    const floorChange = v.postureChange;
    const floorAnchor = !!floorChange && posturePhaseEnds(floorChange,v.base,v.activity).some(end=>end<=floorChange.age&&floorChange.age-end<ACT_BLEND);
    const floorKinds = [postureKind(floorChange?.from??v.activity,floorChange?.fromBase),postureKind(v.activity,v.base)];
    const freeContactBody = freeBody && !nativeHandOwner && !v.formPress?.length && w < .01
      && a.sitW === 0 && b.sitW === 0 && !v.handHold && !v.rps && !v.partner && !v.propWanted && !v.prop?.obj.visible
      && !v.shore && !v.waterTransition?.origins.some(origin=>origin.pose!==null) && !v.transfer && !v.watering && !v.cup && !v.letGo && !v.instrument;
    const floorTransition = !!floorChange && (!!pn || floorAnchor) && floorKinds.some(kind=>kind==='back'||kind==='front')
      && floorKinds.every(kind=>['stand','back','front'].includes(kind)) && freeContactBody;
    const own = floorTransition || freeBody && !engineHands && w < 0.5 && !waveClip && !interactClip && !lib.sleep && lib.rise === undefined && !letGo && !fluteRelease && !gestureBack && !pianoRelease && !waveActive;
    const blendFrom = own && !pn && v.since !== undefined && v.since < ACT_BLEND && v.prevAct !== undefined && v.prevAct !== v.activity && !OWN_FADE.has(v.prevAct) && !OWN_FADE.has(v.activity) && !(recordedPress && (v.activity === 'operate' || v.prevAct === 'operate'))
      && postureKind(v.prevAct, v.prevBase) === postureKind(v.activity, v.base) ? v.prevAct : null;
    let act: ActivityFrame | null = !own ? act0
      : pn?.tilt ? pn.frame ?? activityFrame(pn.tilt.act, v.base, tSec, pairPhase, { actorId: h.name })
      : pn?.flat ? pn.frame ?? blendFrames(null, activityFrame(pn.flat.act, v.base, tSec - (pn.flat.ago ?? 0), pairPhase, { actorId: h.name }), pn.flat.k)
      : pn ? blendFrames(null, act0, pn.settle)
      : blendFrom ? blendFrames(activityFrame(blendFrom, v.prevBase ?? 'idle', tSec, pairPhase, { actorId: h.name, since:v.prevDuration===undefined?undefined:v.prevDuration+v.since! }), act0, smooth(v.since! / ACT_BLEND))
      : act0;
    const tilt = pn?.tilt ? pn.tilt.k : 1;
    if(act&&pn?.tilt)act={...act,handW:[(act.handW?.[0]??1)*tilt,(act.handW?.[1]??1)*tilt]};
    if(act && waveActive && !waveClip)act.handW=[0,waveBlend];
    h.rotation.z = 0; h.rotation.x = 0;
    let lieFloor = h.position.y;
    if (act?.lying) {
      // whole body on the ground along the heading: on the back (head behind the body point, hips over it) or face down
      // in a plank (feet at the body point); only the arms and the torso raise are layered on top
      const hip = v.dims?.hipH ?? 0.9, c = Math.cos(yaw), s = Math.sin(yaw);
      if (act.lying.face === 'back') { h.rotation.z = Math.PI / 2; h.position.x += c * hip; h.position.z += s * hip; const fit = lyingFloor(h.position.y, h.position.x, h.position.z, c, s); lieFloor = fit.y + (v.bench ?? 0); h.position.y = lieFloor + 0.1;
        // on a slope the whole body lies along the ground (head uphill or down), not level above its highest point
        if (fit.k !== 0 && !v.bench) h.quaternion.premultiply(_tilt.setFromAxisAngle(_axis.set(-s, 0, c), Math.atan(fit.k))); }
      else { h.rotation.z = -(Math.PI / 2 - act.lying.raise) * tilt; h.position.y += 0.06 * tilt; }
    } else if (act && act.hop > 0 && b.sitW === 0) h.position.y += act.hop;
    // leisure: a rider moves with the swing or the see-saw plank they sit on (play-motion.ts); the scenery seat follows
    if (act?.ride) { const seat = playSeatAt(act.ride.kind, h.position.x, h.position.z); if (seat) rideSeat(h, seat, act.ride.angle); }
    // clips: Run replaces Walk while running; Wave / Interact / Idle_Neutral take Idle's share
    // running: the library jog / sprint (speed-matched) where present, else the GLB's Run
    const jog = v.running ? libAction(v.rig, v.speed > SPRINT_SPEED && v.rig.template.sprintSpeed ? 'Sprint_Loop' : 'Jog_Fwd_Loop') : null;
    const runW = v.running && (jog || extra.run) ? w : 0;
    const runFallback = v.running && !jog && !extra.run && w > .05 ? runningGaitAt(Math.max(0,v.dist-v.speed*DT*(1-alpha)),v.speed) : null;
    const libShare = lib.cur || lib.prev ? 1 - w : 0;
    const curW = lib.cur ? libShare * lib.fade : 0, prevW = lib.prev ? libShare * (1 - lib.fade) : 0;
    const waveW = waveClip && !lib.cur ? (1 - w)*waveBlend : 0, interactW = interactClip && !lib.cur ? 1 - w : 0;
    // A hand actuator's reach out of an idle gesture (hand at the hair, folded arms): the gesture fades out over the reach
    // while the arm travels from it to the target. It was cut on the first actuator frame (engine hands, idleBlend 0): the
    // hand dropped from the hair to the hip in one frame, 0.747 m per 50 ms (entry 33, neon switch-off).
    const reachS = v.handActuator ? (v.handActuatorTime ?? tSec) - v.handActuator.startTick * DT : 0;
    const handoff = v.handActuator ? handActuatorFrame(v.handActuator, reachS) : null;
    // Over GESTURE_FADE, not the 0.65 s reach: folded arms opening in 0.65 s still swung the free hand 0.13 m per 50 ms (0.084 over 1.2 s).
    const transferS = v.transfer ? (v.transferTime ?? tSec) - v.transfer.startTick * DT : -1;
    // Soul Actions 34: an idle gesture fades out the same way over a hand-held item's reach (take_item / put_item)
    const reachFade = v.handActuator && v.handActuator.abortedAt === undefined && reachS >= 0 && reachS < GESTURE_FADE ? 1 - smooth(reachS / GESTURE_FADE)
      : v.transfer && transferS >= 0 && transferS < GESTURE_FADE ? 1 - smooth(transferS / GESTURE_FADE) : 0;
    // Idle variety also plays on into a walk start (scaled by 1 − walk weight, so it fades out with the walk's ease).
    // An opted-in item transfer (lantern, bowl) keeps its own clock (presentation.ts): idle variety plays on through its
    // turn and fades out over a pick-up from the reach start, as a hand actuator's does; 0 while an item is held.
    const itemReach = !!v.itemPose && v.activity === 'reach';
    // Entry 36: likewise a singer's reach for the mic out of an idle gesture that had begun while she turned to it: the
    // gesture fades out over GESTURE_FADE from the singing's start, at the onset level it had then (it was cut: 0.175 m
    // per 50 ms in take 3), while the arm eases onto the mic
    const singFade = v.activity === 'sing' && v.singOnset !== undefined && (v.since ?? 9) < GESTURE_FADE ? 1 - smooth((v.since ?? 9) / GESTURE_FADE) : 0;
    // entry 35: a hand game holds idle gestures off, fading them out from its start and back in after it (no pop at a
    // join, a count's start or a release); rps keeps the variety layer for that fade
    const hgOff = handGameSuppress(v), gT = handGameGestureClock(v, tSec);
    // Entry 4: carry reach/release converges to the same idle clip underneath the IK.
    // Otherwise an idle variation (e.g. hands on hips) appears in one frame at release end.
    const carryIdle = v.carryWeight !== undefined, idleShare = carryIdle ? 1 - v.carryWeight! : 1;
    // Entry 7 (frisbee clear-v1): the arms lower out of the game on its own recorded clock; idle variety fades in under them
    const gameBlend = v.game?.flightPolicy === 'clear-v1' ? gameArmBlend(v.game, v.gameTick ?? 0, v.gameDt ?? .05) : 1;
    const gameShare = v.activity === 'idle' || v.game?.flightPolicy !== 'clear-v1' ? 1 : 1 - gameBlend;
    const idleFree = (recordedPress || waveActive || v.activity === 'idle' || gameBlend < 1 || carryIdle || itemReach || GAIT_ACTS.has(v.activity) || ((v.activity === 'operate' || v.activity === 'reach') && reachFade > 0) || singFade > 0 || (v.activity === 'rps' && hgOff < 1)) && b.sitW === 0 && (!engineHands || reachFade > 0 || (v.itemPose?.idleBlend ?? 0) > 0) && (freeBody || carryIdle) && !lib.cur && !lib.posture;
    // Entry 43 (entry 41's M04 finding): a let-go before a reach fades the gesture out on its own clock; the reach after
    // it then fades none of its own (its gesture is already gone), and the act's own return of the idle (after the arm is
    // down) still applies. A reach with no let-go keeps the fade over the reach. A put of a handle-held item starts
    // holding it (no gesture): its reach never lets one in (34's fade let folded arms in at full weight as the put began).
    const lg = v.letGo, lgS = lg ? (v.letGoTime ?? tSec) - lg.startTick * DT : Infinity;
    const driverStart = Math.max(v.handActuator?.startTick ?? -Infinity, v.transfer?.startTick ?? -Infinity, v.watering?.startTick ?? -Infinity, v.cup?.startTick ?? -Infinity, v.itemPose?.start ?? -Infinity);
    // the let-go is the newest record: fading out over it, then off for a second (the reach is about to start); a reach
    // that never comes lets the idle back in over TRANSFER_HANDOFF. A reach begun within that second after it is `letGone`.
    const letGoing = !!lg && lg.startTick >= driverStart, letGone = !!lg && !letGoing && (driverStart - lg.startTick) * DT <= lg.seconds + 1;
    // entry 44: a let-go fades the gesture out from the weight it had when the let-go began, not from full weight: right
    // after a kettle was put down its gesture was still fading back in (0.03), and a let-go for the next pick-up switched it
    // on at 0.99 in one frame (the free arm swung behind the back) before fading it out
    if (letGoing && v.letGoFrom?.tick !== lg!.startTick) v.letGoFrom = {tick: lg!.startTick, from: lgS < 0.25 && v.idleLast !== undefined ? v.idleLast : 1};
    const letIdle = !letGoing ? 1 : lgS < lg!.seconds ? (v.letGoFrom?.from ?? 1) * (1 - smooth(lgS / lg!.seconds)) : smooth((lgS - lg!.seconds - 1) / TRANSFER_HANDOFF);
    const fadeOut = letGone ? 0 : v.transfer?.mode === 'put' && transferS >= 0 && !handoff ? 0 : reachFade;
    // entry 43 (entry 41's M04 finding): after an opted-in put the arm goes back over the recovery first, then idle
    // gestures fade in over TRANSFER_HANDOFF (29 blended both over the same 1.2 s: folded arms swept in as the arm fell)
    if (v.itemPose?.releasedFor !== undefined) v.itemReleasedAt = tSec - v.itemPose.releasedFor;
    const relS = v.itemReleasedAt === undefined ? Infinity : tSec - v.itemReleasedAt;
    const putReturn = relS < ITEM_RECOVERY_SECONDS + TRANSFER_HANDOFF ? smooth((relS - ITEM_RECOVERY_SECONDS) / TRANSFER_HANDOFF) : 1;
    if (relS >= ITEM_RECOVERY_SECONDS + TRANSFER_HANDOFF) v.itemReleasedAt = undefined;
    // Entry 38: an actuator that hands the body over soon after its arm is down (a board stroke and its step back) keeps
    // the idle handoff fading in after it ends, instead of switching idle variety on at full weight (a 0.31 m palm jump, take 5)
    const after = !handoff && v.lastHandActuator ? handActuatorFrame(v.lastHandActuator, (v.handActuatorTime ?? tSec) - v.lastHandActuator.startTick * DT).idleBlend : 1;
    if (after >= 1) v.lastHandActuator = undefined;
    const idleHandoff = Math.min(putReturn, letGoing ? letIdle : v.itemPose ? (letGone && v.itemPose.take ? 0 : v.itemPose.idleBlend) : (handoff ? (reachS < 0 ? 1 : Math.max(handoff.idleBlend, fadeOut)) : v.transfer?.endTick !== undefined ? smooth(((v.transferTime ?? tSec) - v.transfer.endTick * DT) / TRANSFER_HANDOFF) : v.transfer && transferS >= 0 ? fadeOut : singFade > 0 ? singFade : after));
    v.idleLast = idleHandoff;
    // Idle variety (Idle_Neutral, fold arms, look around) fades in from when the body came to rest: switched on at full
    // weight it raised or crossed the arms in one frame whenever a walk ended inside a person's variety window
    // (entry 29's shared idle-onset fix, carried by entry 33: a hand-to-hair flash at each walk stop before a reach).
    const normalRestOnset=v.restAge===undefined?1:smooth(v.restAge/IDLE_VARIETY_ONSET);
    const waveRestOnset=v.waveRestAge===undefined?1:smooth(v.waveRestAge/IDLE_VARIETY_ONSET);
    const restOnset = waveActive ? waveRestOnset : singFade > 0 ? v.singOnset! : normalRestOnset;
    if (v.activity === 'idle') v.singOnset = restOnset; else if (v.activity !== 'sing') v.singOnset = undefined;
    const neutralW = extra.idleNeutral && idleFree ? (1 - w) * neutralWeight(h.name, gT) * idleHandoff * restOnset * (1 - hgOff) * idleShare * gameShare * (waveActive?1-waveBlend:1) : 0;
    const variant = idleFree ? idleVariant(h.name, gT) : null, variantA = variant ? libAction(v.rig, variant.clip) : null;
    const variantW = variantA ? (1 - w - neutralW) * variant!.w * idleHandoff * restOnset * (1 - hgOff) * idleShare * gameShare * (waveActive?1-waveBlend:1) : 0;
    v.variety = neutralW + variantW;
    // A walk starting out of an idle gesture: the legs take the walk's own ease (WALK_EASE, 0.55 s), but folded arms opening
    // that fast swung a hand 0.28 m per 50 ms. On the arms alone (arms-only copies of the gesture clips) the gesture fades
    // over GESTURE_FADE from the walk start: its share of the arm pose is (full-body share + A) / (1 + A) after the mixer
    // normalises, so A is chosen to make that share the gesture level at the walk start × the fade.
    let armsN = 0, armsV = 0;
    const gv = idleVariant(h.name, tSec);
    if ((v.activity === 'idle' || GAIT_ACTS.has(v.activity)) && v.walkAge !== undefined && v.walkAge < GESTURE_FADE && b.sitW === 0 && !engineHands && freeBody && !lib.cur) {
      const g = 1 - smooth(v.walkAge / GESTURE_FADE), on = v.restAgeAtWalk === undefined ? 1 : smooth(Math.min(1, v.restAgeAtWalk / IDLE_VARIETY_ONSET));
      const n0 = extra.idleNeutral ? neutralWeight(h.name, tSec) * on : 0, v0 = gv && libAction(v.rig, gv.clip) ? (1 - n0) * gv.w * on : 0;
      // entry 44: the gesture level at the walk start is what was shown then: a gesture let go before setting off (let-go,
      // then the walk) is not put back on the arms (folded arms reappeared at full weight in one frame as she set off)
      if (v.walkKey === undefined || v.walkAge < v.walkKey - 0.05) v.handoffAtWalk = v.walkAge < 0.25 ? v.idleLast ?? 1 : 1;
      v.walkKey = v.walkAge;
      // Entry 38: and never above the idle handoff of an actuator that just ended (a board stroke handing over to its step back)
      const want = (n0 + v0) * g * Math.min(idleHandoff, v.handoffAtWalk ?? 1), have = neutralW + variantW;
      if (want > have + 1e-4 && hgOff < 1e-4) { const k = Math.min(20, (want - have) / Math.max(1e-3, 1 - want)) / (n0 + v0); armsN = n0 * k; armsV = v0 * k; }
    }
    // Quaternion accumulation in AnimationMixer depends on activation order.
    // A fresh seek must blend Wave and the idle layers in the same order as
    // continuous playback. Re-activate only this contributing wave's layers;
    // every action below receives its recorded time and weight again.
    if(waveW>0||(act&&waveActive&&!waveClip&&waveBlend>0)){
      if(v.layered){for(const saved of v.saved){saved.o.position.copy(saved.p);saved.o.quaternion.copy(saved.q);}v.layered=false;}
      for(const action of v.libOn)action.stop();for(const action of Object.values(extra))action?.stop();
    }
    const libOn = new Set<THREE.AnimationAction>();
    const libAt = (act: THREE.AnimationAction | null, weight: number, time: number, loop = true) => {
      if (!act || weight <= 1e-4) return;
      if (!act.isRunning()) act.play();
      const d = act.getClip().duration;
      act.time = loop ? ((time % d) + d) % d : Math.max(0,Math.min(d-1e-7,time)); act.setEffectiveWeight(weight + (libOn.has(act) ? act.getEffectiveWeight() : 0)); libOn.add(act);
    };
    if (lib.cur) libAt(lib.cur.act, curW, lib.cur.time, lib.cur.pick.mode==='loop');
    if (lib.prev) libAt(lib.prev.act, prevW, lib.prev.time, lib.prev.pick.mode==='loop');
    // entry 42 (take 6): a gesture fading out under a hand actuator's reach also slows its own clip to a stop over the fade:
    // a look-around raising the hand kept moving it at its own speed while the arm reached for a drawer knob (0.095 m per 50 ms
    // together). Clip time = the reach start + ∫(1 − fade) — the same pose and speed at the reach start, at rest by its end.
    const slowed = reachFade > 0 ? heldClip(reachS, GESTURE_FADE) - reachS : 0;   // (weight 0 once the fade is over: back on the clock unseen)
    if (variantA) libAt(gestureAction(v.rig, variant!.clip), variantW, variantTime(variant!.clip, h.name, gT + slowed));
    if (neutralW > 0) libAt(gestureAction(v.rig, 'Idle_Neutral'), neutralW, gT);
    if (neutralW + variantW > 1e-4) libAt(idleBodyAction(v.rig), neutralW + variantW, b.idleT);
    if (armsN > 0) libAt(armsAction(v.rig, 'Idle_Neutral'), armsN, tSec);
    if (armsV > 0 && gv) libAt(armsAction(v.rig, gv.clip), armsV, variantTime(gv.clip, h.name, tSec + slowed));
    if (jog) { const sp = jog.getClip().name === 'Sprint_Loop' ? v.rig.template.sprintSpeed : v.rig.template.jogSpeed; libAt(jog, runW, sp ? v.dist / sp : tSec); }
    for (const x of v.libOn) if (!libOn.has(x)) x.stop();
    v.libOn = libOn;
    const clipAt = (k: 'wave' | 'run' | 'interact' | 'idleNeutral', weight: number, time: number) => {
      const c = extra[k];
      if (!c) return;
      if (weight > 1e-4) { if (!c.isRunning()) c.play(); c.time = ((time % c.getClip().duration) + c.getClip().duration) % c.getClip().duration; c.setEffectiveWeight(weight); }
      else if (c.isRunning()) c.stop();
    };
    clipAt('run', jog ? 0 : runW, v.dist/(v.rig.template.runSpeed ?? 2.5));
    clipAt('wave', waveW, wave&&extra.wave?wave.phase*extra.wave.getClip().duration:0);
    clipAt('interact', interactW, tSec);
    clipAt('idleNeutral', 0, tSec); // drawn as a gesture (arms, neck, head) above
    walk.setEffectiveWeight(w - runW);
    idle.setEffectiveWeight(Math.max(0, 1 - w - waveW - interactW - neutralW - variantW - curW - prevW));
    // The mixer only writes a bone when its clip value changed since the last apply, so undo last
    // frame's pose layers first (back to that clip value) or they would accumulate while paused.
    if (v.layered) for (const s of v.saved) { s.o.position.copy(s.p); s.o.quaternion.copy(s.q); }
    v.layered = false;
    v.diag = undefined;
    v.stairGoals=undefined;
    v.stairResiduals=undefined;
    mixer.update(0);
    const sitW = a.sitW + (b.sitW - a.sitW) * alpha, warmW = a.warmW + (b.warmW - a.warmW) * alpha;
    const pz: Posture = { drop: lerp(a.pose.drop, b.pose.drop, alpha), bend: lerp(a.pose.bend, b.pose.bend, alpha), rise: lerp(a.pose.rise, b.pose.rise, alpha), kneel: lerp(a.pose.kneel, b.pose.kneel, alpha) };
    const posed = pz.drop > 1e-4 || pz.bend > 1e-4 || pz.rise > 1e-4 || pz.kneel > 1e-4;
    const hands = lerpHands(a.hands, b.hands, alpha);
    const hasHands = !!(hands.left || hands.right);
    const part = v.grip ? this.parts.get(v.grip) : undefined;
    const gripping = !hasHands && !!((reach || part) && v.grip && v.arms.length);
    const gait = sitW > 0 ? null : this.gaitOf(h.position,v);
    // A grounded cosmetic layer yields to every existing support/locomotion/grip pose.
    const expression = !lib.cur && w < .05 && sitW === 0 && warmW === 0 && !v.grip && !v.on && !gait && !fp && proneW === 0 && pz.kneel === 0 && pz.bend < .1
      ? expressionAt(h.name,v.activity,lerp(a.expressionT,b.expressionT,alpha),hands,this.stationBeat) : null;
    const water=!lib.water&&!hasHands&&!gripping&&!v.grip&&!v.on&&!gait&&!fp&&proneW===0&&sitW===0&&warmW===0&&!posed?waterMotionAt(h.name,v.activity,v.shoreTime??lerp(a.expressionT,b.expressionT,alpha),v.shore):null;
    const gaze = v.gaze && !v.cup ? v.gaze.prev + (v.gaze.cur - v.gaze.prev) * alpha : 0;
    const waterOrigins=!lib.water&&!hasHands&&!gripping&&!v.grip&&!v.on&&!gait&&!fp&&proneW===0&&sitW===0&&warmW===0&&!posed&&v.waterTransition&&v.waterTransition.weight<1?v.waterTransition.origins:[];
    const waterFrom=waterOrigins.some(x=>x.pose!==null);
    // a carried item (engine human.prop) shows in the hand whenever it is set; an activity's own prop while it runs
    const heldArmBlocked=!!(hasHands || gripping || v.grip || v.on || v.itemPose || v.handActuator || v.transfer || v.watering || v.cup || v.letGo || v.lastHandActuator || v.instrument || v.handHold || v.rps || v.partner || v.formPress?.length || proneW || lib.sleep || fp || v.sleepPose);
    const canonicalHeld = this.prepareHeld(v,heldArmBlocked);
    // An observed empty native hand set cannot be replaced by a generic activity-default plate/book/tool.
    // Explicit instrument owners are independent; legacy worlds without a held observation keep their defaults.
    const propActivity=act || clipBody || lib.cur ? v.activity : '';
    const propKind = !hasHands && !gripping && proneW === 0 ? act?.flute ? 'flute'
      : v.heldEntries?.entries.length===0&&!v.instrument ? null : propFor(propActivity,v.propWanted,v.instrument) : null;
    // a thing the body carries (the engine's prop) with no activity posing the hands is in one hand at the carry point,
    // standing or walking (below); a book is carried closed and read open
    const held = !!propKind && propKind === v.propWanted;
    const canonicalArmFree = !act?.hands && !clipBody && !waveClip && !interactClip;
    const carried = (held || canonicalHeld) && canonicalArmFree && (sitW === 0 || canonicalHeld) && !fp && !gait;
    if (!carried) v.carrySince = undefined; else if (v.carrySince === undefined || v.carrySince > tSec) v.carrySince = tSec;
    const seatExit = v.seatPlan;
    const carryAge = seatExit?.activity === 'stand-up' ? v.seatSample!.postureChange!.age - seatExit.end : tSec - v.carrySince!;
    const carryW = carried ? smooth(Math.min(1, carryAge / CARRY_EASE)) : 0;
    const wantProp = held ? carriedProp(propKind, v.activity) : propKind;
    if (v.prop && v.prop.kind !== wantProp) v.prop.obj.visible = false;
    // A free standing overlay shares ordinary idle's foot policy. Floor layout and
    // airborne frames keep their own contacts until the standing settle takes over.
    const freeStandingContacts = freeContactBody && postureKind(v.activity,v.base)==='stand' && !GAIT_ACTS.has(v.activity)
      && !water && !waterFrom && !lib.water && !gait && !posed && !runFallback && !gripping && !hasHands && !warmW
      && !act?.hop && !act?.feetOut && !act?.lying && !pn?.flat && !pn?.tilt && lib.rise===undefined && !clipBody;
    const footFit = !water && !waterFrom && !lib.water && sitW <= 0 && !gait && !fp?.feet && !posed && !runFallback && !gripping && !hasHands && (freeStandingContacts || ['idle', 'walk', 'run', 'jog'].includes(v.activity) || recordedPress && v.activity === 'operate');
    const freeFootFit = !water && !waterFrom && !lib.water && freeBody && sitW <= 0 && !gait && !posed && !runFallback && !gripping && !hasHands
      && !lib.posture && !lib.still && !act?.lying && !act?.ride && !act?.pairedContact && !v.handHold && !v.rps && !v.propWanted;
    const handGame = handGameActive(v) && freeBody && sitW === 0 && !hasHands && !gripping;
    if (!(v.formPress || footFit || freeFootFit || runFallback || waterFrom || water || expression || Math.abs(gaze) > 1e-5 || sitW > 0 || warmW > 0 || gripping || hasHands || posed || gait || fp || proneW > 0 || act || lib.cur || lib.prev || wantProp || canonicalHeld || handGame || floorTransition || freeStandingContacts)) return;
    for (const s of v.saved) { s.p.copy(s.o.position); s.q.copy(s.o.quaternion); }
    v.layered = true;
    _fwd.set(Math.cos(yaw), 0, Math.sin(yaw)); // engine yaw 0 faces +x; holder.rotation.y = -yaw
    _right.set(-Math.sin(yaw), 0, Math.cos(yaw));
    const seatClip = this.libraryBody(v, lib, curW, prevW, yaw);
    const seatHands = seatClip || !!v.seatSample && (lib.cur?.pick.body === 'seat' || lib.prev?.pick.body === 'seat');
    h.updateMatrixWorld(true);
    let waterStart:{p:THREE.Vector3;q:THREE.Quaternion}[]|null=null;
    if(waterFrom){
      let total=0;const poses=new Map<string,{p:THREE.Vector3;q:THREE.Quaternion}[]>();
      for(const origin of waterOrigins){
        if(origin.weight<=0)continue;
        const m=origin.pose?waterMotionAt(h.name,origin.pose.activity,v.shoreTime??lerp(a.expressionT,b.expressionT,alpha),origin.pose.contact):null,key=JSON.stringify(m);
        let pose=poses.get(key);if(!pose){if(m)applyWaterPose(v,m);pose=v.saved.map(s=>({p:s.o.position.clone(),q:s.o.quaternion.clone()}));poses.set(key,pose);for(const s of v.saved){s.o.position.copy(s.p);s.o.quaternion.copy(s.q);}h.updateMatrixWorld(true);}
        const k=origin.weight/(total+origin.weight);if(!waterStart)waterStart=pose.map(s=>({p:s.p.clone(),q:s.q.clone()}));else pose.forEach((s,i)=>{waterStart![i].p.lerp(s.p,k);waterStart![i].q.slerp(s.q,k);});total+=origin.weight;
      }
    }
    // legs / pelvis (lying / rising: the prone body, blended into the other layers over 0.4 s as it fades out)
    let keep: { p: THREE.Vector3; q: THREE.Quaternion }[] | null = null;
    if (proneW > 0) {
      proneBody(v, pr!);
      if (proneW < 1) {
        keep = v.saved.map((s) => ({ p: s.o.position.clone(), q: s.o.quaternion.clone() }));
        for (const s of v.saved) { s.o.position.copy(s.p); s.o.quaternion.copy(s.q); }
        h.updateMatrixWorld(true);
      }
    }
    if (proneW < 1) {
      if (seatClip) { /* the library sitting clip, lowered / raised onto the seat (libraryBody) */ }
      else if (sitW > 0) sitPose(v, sitW, h.position.y);
      else if (gait) stairLegs(v, gait.g, gait.f, h);
      else if (fp?.feet && fw > 0) frameLegs(v, fp, pz, fw);
      else if (posed) postureLegs(v, pz);
      else if (runFallback && v.dims && v.spine && !hasHands && !gripping) {
        place(v.spine.body,v.spine.body.getWorldPosition(V()).addScaledVector(UP,runFallback.bob*w));
        bendTorso(v.spine,runFallback.lean*w);h.updateMatrixWorld(true);
        v.legs.forEach((leg,i)=>{const f=runFallback.legs[leg.side>0?0:1],target=V().copy(h.position).addScaledVector(_fwd,f.forward).addScaledVector(_right,v.footLat[i]).addScaledVector(UP,v.dims!.ankleH+f.up);
          legTo(leg,v.ankle[i],target,V().copy(_fwd).addScaledVector(UP,.2),.97,footPitch(v,i,0));});
      }
      // Free upright clips/overlays share ground support. Dedicated owners and authored
      // kneeling/floor layouts retain their contacts; aimed partners alone do not own one.
      if (footFit && !seatClip) fitGroundFeet(v, h);
      else if (freeFootFit && !seatClip) { const support = uprightLegs(v, h); if (support > 0) fitGroundFeet(v, h, support); }
      if (sitW <= 0 && pz.bend > 1e-4 && v.spine) bendTorso(v.spine, pz.bend);
    }
    if (keep) {
      v.saved.forEach((s, k) => (s.o.position.lerp(keep![k].p, proneW), s.o.quaternion.slerp(keep![k].q, proneW)));
      h.updateMatrixWorld(true);
      // blending a pointed foot into a planted / tucked one swings the toes down: keep the feet on the deck
      v.legs.forEach((l, i) => {
        const dip = h.position.y + 0.003 - lowestY(v.surf.foot.get(l.side));
        if (dip <= 0) return;
        const ankle = l.foot.getWorldPosition(V()), knee = l.lower.getWorldPosition(V()), hip = l.upper.getWorldPosition(V());
        legTo(l, v.ankle[i], ankle.setY(ankle.y + dip), knee.sub(hip.add(ankle).multiplyScalar(0.5)), 0.999, l.foot.getWorldQuaternion(new THREE.Quaternion()));
      });
    }
    // Seated continuity precedes existing native-hand, held-prop and selected-press
    // owners. Each applies once below, after the attained base has been blended.
    const seatHandOwner = !!(hasHands || v.propWanted || v.formPress?.length) && !v.itemPose && !v.handActuator && !v.transfer && !v.watering && !v.cup && !v.letGo;
    let seatOwnerShare = 1;
    if (v.seatSample && seatHandOwner && freeBody && !gripping && !v.handHold && !v.rps) {
      seatOwnerShare = this.blendSeat(v, tSec, sourcePose);
      if (act && seatOwnerShare < 1) act = blendFrames(null, act, seatOwnerShare);
    }
    v.ownerArmBase = sourcePose && (hasHands || v.formPress?.length) ? armBases(v) : undefined;
    if (act && v.spine && !hasHands && !gripping) {
      if (act.lying) {
        if (act.lying.face === 'back' && act.lying.raise > 0) bendTorso(v.spine, act.lying.raise);
        if (act.lying.face === 'back') restOnGround(v, h, lieFloor, v.bench ?? 0);
        // On the back the standing clip's stride (one foot forward, one back) would lift one leg and sink the other
        // foot through the ground (a shoe seemed to float apart): lay both legs out long, heels resting on the ground.
        if (act.lying.face === 'back' && v.legs.length >= 2) lyingLegs(v, lieFloor, v.bench ?? 0);
        if (act.lying.face === 'front' && v.legs.length >= 2) frontLegs(v, h, lieFloor, tilt);
      }
      else {
        if (act.feetOut > 0 && sitW === 0 && v.legs.length >= 2) activityLegs(v, act.feetOut);
        if (act.lean) bendTorso(v.spine, act.lean);
        if (act.side) turn(v.spine.abdomen, _fwd, act.side);
      }
      h.updateMatrixWorld(true);
    }
    // todo (leisure): cycling — the dock bicycle under the rider along the heading, cranks turned by the distance ridden, feet
    // on the pedals; it stays a moment between the legs of a ride (the body idles a tick between walk_to steps)
    {
      const cycling = v.activity === 'cycle';
      if (cycling) v.bikeAt = tSec;
      const show = cycling || (v.bikeAt !== undefined && tSec - v.bikeAt >= 0 && tSec - v.bikeAt < 0.6 && !['pick-up', 'put-down'].includes(v.activity));
      if (show) {
        if (!v.bike) { v.bike = makeBicycle(hashId(h.name) % 4); this.group.add(v.bike); }
        const crank = crankAngle(v.dist), by = a.p[1] + (b.p[1] - a.p[1]) * alpha;
        v.bike.visible = true; poseBicycle(v.bike, h.position.x, by, h.position.z, yaw, crank);
        if (cycling && v.legs.length >= 2) {
          v.legs.forEach((leg, i) => {
            const [lx, ly, lz] = pedalLocal(crank, -leg.side), goal = V().set(h.position.x, by, h.position.z).addScaledVector(_fwd, lx).addScaledVector(UP, ly).addScaledVector(_right, lz);
            legTo(leg, v.ankle[i], goal, V().copy(_fwd).addScaledVector(UP, .4).addScaledVector(_right, -leg.side * .1), .999, leg.foot.getWorldQuaternion(new THREE.Quaternion()));
          });
          h.updateMatrixWorld(true);
        }
      } else if (v.bike) v.bike.visible = false;
    }
    if (expression && v.spine) {
      if (expression.kind === 'planted-dance') expressionLegs(v,expression);
      turn(v.spine.hips ?? v.spine.abdomen,UP,-expression.torsoYaw);
      bendTorso(v.spine,expression.lean);
      h.updateMatrixWorld(true);
    }
    if(water?.kind==='surface-swim')surfaceSwimBody(v,water);
    if(water?.floating)waterLegs(v,water);
    // arms
    h.userData.wateringTilt=0;h.userData.wateringFlow=0;h.userData.wateringYaw=0;h.userData.cupPose=undefined;
    const targets: (THREE.Vector3 | null)[] = v.arms.map(() => null);
    let source: Source = null;
    if (hasHands) {
      source = 'hands';
      v.arms.forEach((arm, i) => {
        const q = armSide(v, i) === 'left' ? hands.left : hands.right;
        if (q) targets[i] = new THREE.Vector3(q[0], q[1], q[2]);
        // an empty-handed item pick-up: from the drawn palm to the fixed grasp point on the reach clock (presentation.ts `goal`)
        const g = v.itemPose?.goal;
        if (g && q && armSide(v, i) === g.hand) {
          h.updateMatrixWorld(true); const from = palm(arm, V());
          // entry 42: into a container the goal takes the engine's arc over the lip (same control points, from the drawn palm)
          if (g.via) { const q = insidePoint([from.x, from.y, from.z], g.via, g.p, g.k); targets[i]!.set(q[0], q[1], q[2]); }
          else targets[i]!.set(g.p[0], g.p[1], g.p[2]).sub(from).multiplyScalar(g.k).add(from);
        }
      });
      // Soul Actions 44: the mug hand goes where the cup timeline puts the mug, resolved with this rig's own lips (its head
      // bone), its carry point and the tap's hold; the engine's hand point is the same pose on a 1.75 m body
      const cm=v.cup,cs=cm?(v.cupTime!==undefined?v.cupTime+(tSec-b.expressionT):tSec)-cm.startTick*DT:0,cf=cm?cupFrame(cm,cs):null;
      let cupPlan:{arm:number;pose:ReturnType<typeof cupPose>;marks:CupMarks}|null=null;
      if(cm&&cf){const arm=v.arms.findIndex((_,i)=>armSide(v,i)===cm.hand);if(arm>=0){h.updateMatrixWorld(true);
        const head=v.spine?.head?.getWorldPosition(V()),side=cm.hand==='left'?-1:1,sc=1;
        const lips=head?V().copy(head).addScaledVector(_fwd,CUP_LIPS.fwd*sc).addScaledVector(UP,CUP_LIPS.up*sc):V().copy(h.position).addScaledVector(_fwd,0.085).addScaledVector(UP,1.545*sc);
        const C=ENGINE_BODY.carryHand,carry=V().copy(h.position).addScaledVector(_fwd,C.fwd).addScaledVector(_right,side*C.side).addScaledVector(UP,C.up);
        const marks:CupMarks={o:[h.position.x,h.position.y,h.position.z],f:[_fwd.x,0,_fwd.z],r:[_right.x,0,_right.z],lips:[lips.x,lips.y,lips.z],carry:[carry.x,carry.y,carry.z],hold:cm.hold,side};
        const pose=cupPose(cf,marks);cupPlan={arm,pose,marks};targets[arm]=new THREE.Vector3(...pose.palm);}}
      // A hand on the engine's mouth landmark (items/body.ts: 0.15 m ahead of the body axis at 1.58 m,
      // −0.45 seated) would cover the rig's face (its lips are ~7 cm further back and 3 cm lower): the
      // palm stops below and in front of the mouth and the spoon reaches the lips (components.ts).
      if (v.activity === 'eat') {
        const mouth = _tmp.copy(h.position).addScaledVector(_fwd, 0.15);
        mouth.y += 1.58 - (SEATED.has(v.base) ? 0.45 : 0);
        for (const t of targets) {
          if (!t) continue;
          const k = clamp01(1 - t.distanceTo(mouth) / 0.12);
          if (k > 0) t.addScaledVector(_fwd, 0.05 * k).addScaledVector(UP, -0.07 * k);
        }
      }
      // a prone receiver's hand flat on the deck (engine point on the deck top, behind the lip): the palm centre a
      // hand's half-thickness above it, so the hand lies on the deck rather than in it
      // (how flat: 1 on the deck up to 3 cm before the lip, 0 just past it / 0.25 m up — the hand turning as it comes down, and once over the edge)
      const flat = targets.map((t) => {
        if (!t || proneW <= 0) return 0;
        const f = (t.x - h.position.x) * Math.cos(engineYaw) + (t.z - h.position.z) * Math.sin(engineYaw);
        const w = clamp01((LIP + 0.02 - f) / 0.05) * clamp01(1 - (t.y - h.position.y) / 0.25);
        if (w > 0) t.y = Math.max(t.y, h.position.y + PALM_LIFT * w);
        return w * proneW;
      });
      // prone: elbows up beside the chest for a hand on the deck, forward and out (off the edge) reaching over it
      const pa: ProneArms | undefined = proneW > 0 ? { girdle: GIRDLE * proneW, pole: (arm, t) => {
        const out = V().copy(_right).multiplyScalar(-arm.side * 0.5);
        const f = (t.x - h.position.x) * Math.cos(engineYaw) + (t.z - h.position.z) * Math.sin(engineYaw);
        return f < LIP ? out.add(UP) : out.add(_fwd).addScaledVector(UP, -0.2);
      } } : expression?.kind === 'planted-dance' ? {girdle:0,pole:arm=>V().copy(_right).multiplyScalar(-arm.side*(.35+expression.elbowLift)).addScaledVector(UP,-.5+expression.elbowLift).addScaledVector(_fwd,.15)} : undefined;
      // Blend the actual arm bones to/from the existing idle/walk clip; lowering a
      // Cartesian hand target alone leaves the elbow/shoulder snapping at release.
      const actW=v.handActuator?handActuatorFrame(v.handActuator,(v.handActuatorTime??tSec)-v.handActuator.startTick*DT).weight:undefined;
      const weight=v.itemPose?.weight??actW??1;
      // entry 42: carrying in one hand while the free hand works a drawer or door: that hand takes the actuator's clock,
      // the carrying hand the item's (one weight for both popped the free arm onto the knob in one frame)
      const actSide=v.itemPose&&v.handActuator&&actW!==undefined?actuatorHand(v.handActuator.opening,v.handActuator.hand):undefined;
      // Soul Actions 34: the can hand stays on the can; the free hand blends in to the valve and back out to the clip
      // between take frames: the frame's own time plus how far the render is past it (the hands interpolate the same way)
      const wf=v.watering?wateringFrame(v.watering,(v.wateringTime!==undefined?v.wateringTime+(tSec-b.expressionT):tSec)-v.watering.startTick*DT):null;
      // a handle-held item's reach blends that arm in from (and its release back out to) the clip's own pose
      const tw=v.transfer?transferWeight(v.transfer,(v.transferTime!==undefined?v.transferTime+(tSec-b.expressionT):tSec)-v.transfer.startTick*DT).weight:null;
      // entry 43: a handle-held transfer's record stays on the body after it ends (its idle handoff reads it), but a later
      // driver of that arm owns it: a hand actuator begun since (a kettle's switch), or a presented item (a mug in hand).
      // Before, the ended record's weight (0) kept the arm on the clip: the switch was pressed by a hand at the hip.
      const transferOwns=tw!==null&&!v.itemPose&&!(v.handActuator&&v.handActuator.startTick>=v.transfer!.startTick);
      const armW=(i:number)=>cf&&cm?(armSide(v,i)===cm.hand?1:cm.stage==='wash'?cf.left:weight):wf?(armSide(v,i)==='left'?wf.left:1):transferOwns&&armSide(v,i)===v.transfer!.hand?tw!:actSide&&armSide(v,i)===actSide?actW!:weight;
      h.userData.wateringTilt=wf?.tilt??0;h.userData.wateringFlow=wf?.flow??0;h.userData.wateringYaw=wf?.yaw??0;
      const armBase=v.arms.some((_,i)=>armW(i)<1)?v.arms.flatMap((arm,i)=>[...(arm.shoulder?[arm.shoulder]:[]),arm.upper,arm.lower,arm.hand].map(o=>({o,w:armW(i)}))).map(({o,w})=>({o,w,q:o.quaternion.clone(),p:o.position.clone()})):[];
      const k = reachTo(v, targets, pz.rise > 0, v.carryWeight===undefined?BODY_MODEL.maxExtension:CARRY_EXTENSION, undefined, pa);
      v.arms.forEach((arm, i) => {
        if (!targets[i] && sitW > 0 && !seatHands) handOnThigh(v, i, sitW);
      });
      // an opted-in item reach bends up to ~60° in 1 s: let the free arm hang from the first degree of bend,
      // not swing down between 30° and 63° in a fifth of a second; an idle gesture still fading out (folded arms at a
      // pick-up) keeps the free arm until it has gone: hung at the bend's rate, it dropped 0.11 m per 50 ms
      if (sitW <= 0) dangle(v, proneW > 0 ? Math.max(pz.bend * (1 - proneW), pr!.bend * proneW) : pz.bend, k, v.itemPose?.posture ? 0 : DANGLE_FROM, v.itemPose?.posture ? 1 - clamp01(v.variety ?? 0) : 1);
      v.arms.forEach((arm, i) => flat[i] > 0 && k[i] > 0 && flatHand(v, arm, targets[i]!, h.position.y, flat[i] * k[i], pa!.pole(arm, targets[i]!)));
      for(const b of armBase){b.o.quaternion.slerp(b.q,1-b.w);b.o.position.lerp(b.p,1-b.w);}if(armBase.length)h.updateMatrixWorld(true);
      // the drawn mug sits in the drawn hand: the planned pose moved by where the palm actually got to (an arm short of its
      // target carries the mug short with it, never leaves the hand off the mug)
      if(cupPlan&&cf&&cm){const pm=palm(v.arms[cupPlan.arm],V()),p=cupPlan.pose,dx=pm.x-p.palm[0],dy=pm.y-p.palm[1],dz=pm.z-p.palm[2];
        const base=new THREE.Vector3(p.base[0]+dx,p.base[1]+dy,p.base[2]+dz),axis=new THREE.Vector3(...p.axis);
        const q=new THREE.Quaternion().setFromUnitVectors(UP,axis).multiply(new THREE.Quaternion().setFromAxisAngle(UP,-cupYawAt(cm,cs)));
        h.userData.cupPose={item:cm.item,base,q,water:cf.water,outflow:cf.outflow,tilt:cf.tilt,atLips:cf.atLips,lips:cupPlan.marks.lips,rimNear:[p.rimNear[0]+dx,p.rimNear[1]+dy,p.rimNear[2]+dz],palm:[pm.x,pm.y,pm.z],target:p.palm,grip:cf.grip};}
      closeHands(v, k.map((c, i) => armW(i)*(expression?.kind === 'planted-dance' ? 0 : c * (1 - flat[i]))));
    } else if (v.sleepPose && pr && v.dims && proneW > 0) {
      // Free contact expression is private to the current rig, never authoritative hands/grips.
      source = 'sleep';
      const local = sleepHands(v.dims, pr);
      v.arms.forEach((arm, i) => {
        const q = local[armSide(v, i) === 'left' ? 0 : 1];
        targets[i] = V().copy(h.position).addScaledVector(_fwd, q.f).addScaledVector(_right, q.lat).addScaledVector(UP, q.up);
      });
      const rest=sleepRestWeight(pr);
      const pa: ProneArms = { girdle: GIRDLE * proneW * (1-rest), pole: (arm) => V().copy(_right).multiplyScalar(-arm.side * (0.5-0.3*rest)).addScaledVector(UP,1-1.15*rest) };
      const k = reachTo(v, targets, false, BODY_MODEL.maxExtension, undefined, pa);
      v.arms.forEach((arm, i) => {
        if (targets[i] && k[i] > 0) flatHand(v, arm, targets[i]!, h.position.y, proneW * k[i], pa.pole(arm, targets[i]!));
      });
      closeHands(v, k.map(() => 0));
    } else if (gripping) {
      source = 'grip';
      const grip = v.grip!, slot = v.gripSlot ?? '', floor = h.position.y;
      const q = part && lerpPose(part.prev, part.cur, alpha);
      const find = (from: THREE.Vector3, out: THREE.Vector3) => {
        const r = part ? slotPoint({ def: part.def, pose: q! } as Entity, slot, from, floor, out, this.fixtureHandling.get(part.def)) : undefined;
        return r ?? (reach ? reach(grip, from, out) : false);
      };
      v.arms.forEach((arm, i) => {
        arm.upper.getWorldPosition(_s);
        const t = V();
        if (find(_s, t)) targets[i] = v.carryWeight === undefined ? t : palm(arm,V()).lerp(t,v.carryWeight);
      });
      const k = reachTo(v, targets, pz.rise > 0, v.activity === 'carry' ? 0.88 : BODY_MODEL.maxExtension, find);
      if (sitW <= 0) dangle(v, pz.bend, k);
      closeHands(v, v.carryWeight === undefined ? k : k.map(x => x * v.carryWeight!));
    } else if (act?.hands) {
      // body activity: each hand to a goal relative to its own shoulder (forward, outward, up), reach-honest IK;
      // an arm without a goal keeps the base posture (hand on thigh seated, hanging standing)
      source = 'expression';
      const floor = (act.lying ? (act.lying.face === 'back' ? lieFloor : h.position.y - 0.1) : h.position.y - act.hop) + 0.06;
      v.arms.forEach((arm, i) => {
        const left = armSide(v, i) === 'left', aimedPoint = !!pointFrame && !act.pairedContact;
        const q = aimedPoint ? (armSide(v,i) === point!.hand ? act.hands![1] : null) : act.hands![left ? 0 : 1], r = act.rootHands?.[left ? 0 : 1], wgt = act.handW?.[left ? 0 : 1] ?? 1;
        if (!q && !r) { if (sitW > 0 && !seatHands) handOnThigh(v, i, sitW); return; }
        const weight=act.handWeights?.[left?0:1]??1;
        const saved=weight<1?[arm.upper,arm.lower,arm.hand].map(o=>({o,p:o.position.clone(),q:o.quaternion.clone()})):[];
        arm.upper.getWorldPosition(_s);
        // entry 36: a goal on a fixed thing (the mic's grip) is placed from the body root at its own height above the floor
        const t = r ? V().copy(h.position).addScaledVector(_fwd, r[0]).addScaledVector(_right, (left ? -1 : 1) * r[1]).addScaledVector(UP, r[2])
          : V().copy(_s).addScaledVector(_fwd, q![0]).addScaledVector(_right, (left ? -1 : 1) * q![1]).addScaledVector(UP, q![2]);
        if (aimedPoint && q) {
          const direction = V().set(point!.at[0]-_s.x,0,point!.at[1]-_s.z);
          if (direction.lengthSq() > 1e-12) t.copy(_s).addScaledVector(direction.normalize(),Math.hypot(q[0],q[1])).addScaledVector(UP,q[2]);
        }
        if(act.flute){
          const head=v.spine?.head?.getWorldPosition(V())??V().copy(h.position).addScaledVector(UP,1.525);
          t.copy(head).addScaledVector(_fwd,.125).addScaledVector(UP,.005).addScaledVector(_right,left?.14:.36);
        }
        // #2197: the eating hand ends just below and in front of this rig's lips, so the food held up in its fingers meets the mouth
        if(act.mouth&&!left&&v.spine?.head){const head=v.spine.head.getWorldPosition(V());t.lerp(head.addScaledVector(_fwd,EAT_PALM.fwd).addScaledVector(UP,EAT_PALM.up).addScaledVector(_right,EAT_PALM.side),act.mouth);}
        if (t.y < floor) t.y = floor;
        if (wgt <= 0) return;
        targets[i] = t;
        if(!act.piano)armTo(arm, t, wgt, 0.98, h, V().copy(_right).multiplyScalar(left ? -0.6 : 0.6).addScaledVector(UP, -0.5).addScaledVector(_fwd, -0.2));
        for(const b of saved){b.o.position.lerpVectors(b.p,b.o.position,weight);b.o.quaternion.slerpQuaternions(b.q,b.o.quaternion.clone(),weight);}
      });
      const fingerBase=act.handW?v.arms.map(arm=>[...arm.fingers,...arm.thumb].map(o=>({o,q:o.quaternion.clone()}))):null;
      closeHands(v, v.arms.map((_, i) => !targets[i] ? 0 : (act.curl ? act.curl[armSide(v, i) === 'left' ? 0 : 1] : 0.6) * (act.handWeights?.[armSide(v, i) === 'left' ? 0 : 1] ?? 1)));
      fingerBase?.forEach((bones,i)=>{const k=act.handW![armSide(v,i)==='left'?0:1];for(const b of bones)b.o.quaternion.slerpQuaternions(b.q,b.o.quaternion.clone(),k);});
      if (act.lying?.face === 'front') v.arms.forEach((arm, i) => {
        const target = targets[i]; if (!target) return;
        curlHand(arm, 0);
        const support = groundUnder(target.x, target.z, lieFloor);
        target.y = Math.max(target.y, support + .04);
        for (let n = 0; n < 3; n++) {
          flatHand(v, arm, target, support, tilt, V().copy(_right).multiplyScalar(-arm.side * .6).addScaledVector(UP, -.5).addScaledVector(_fwd, -.2));
          h.updateMatrixWorld(true);
        }
      });
      if(act.piano)v.arms.forEach((arm,i)=>{if(targets[i])posePianoHand(arm,h.position,targets[i]!,_fwd,_right,h.position.y+act.piano!.height,act.piano!.lift[armSide(v,i)==='left'?0:1],act.piano!.weight,visit=>eachSkinnedWorld(v.surf.hand.get(arm.side),V(),visit));});
    } else if (carried && carryW > 0 && !canonicalHeld) {
      // a carried thing: its hand at the carry point from its own shoulder (forearm forward, elbow bent), walking or
      // standing; the other arm keeps the clip (its walk swing, its idle). The prop follows the drawn palm (below).
      source = 'carry';
      const side = carrySide(wantProp!), i = v.arms.findIndex((_, k) => armSide(v, k) === side);
      if (i >= 0) {
        const arm = v.arms[i], out = side === 'left' ? -1 : 1;
        const t = arm.upper.getWorldPosition(V()).addScaledVector(_fwd, CARRY_HAND[0]).addScaledVector(_right, out * CARRY_HAND[1]).addScaledVector(UP, CARRY_HAND[2]);
        targets[i] = t;
        armTo(arm, t, carryW * seatOwnerShare, 0.98, h, V().copy(_right).multiplyScalar(out * 0.6).addScaledVector(UP, -0.5).addScaledVector(_fwd, -0.2));
        curlHand(arm, smooth((0.6 * carryW - 0.3) / 0.5) * seatOwnerShare);
      }
    } else if (runFallback && !gait && !fp && !posed && proneW===0 && sitW===0) {
      source='expression';v.arms.forEach((arm,i)=>{const f=runFallback.hands[arm.side>0?0:1];targets[i]=arm.upper.getWorldPosition(V()).addScaledVector(_fwd,f.forward).addScaledVector(_right,-arm.side*.06).addScaledVector(UP,f.up);});reachTo(v,targets,false);closeHands(v,targets.map(()=>.45));
    } else if (sitW > 0 && !seatHands) v.arms.forEach((_, i) => handOnThigh(v, i, sitW));
    else if (fp && fw > 0 && (fp.hands[0] || fp.hands[1])) {
      // free hands on the frame (climbing: the ladder cycle's holds; on the bracing: column + brace) or held
      // out for balance on a beam — renderer-chosen, within reach by construction, reach-honest all the same
      source = 'frame';
      v.arms.forEach((_, i) => {
        const q = fp.hands[armSide(v, i) === 'left' ? 0 : 1];
        if (q) targets[i] = new THREE.Vector3(q[0], q[1], q[2]);
      });
      const k = reachTo(v, targets, false).map((c) => c * fw);
      if (fp.kind !== 'beam') closeHands(v, k);
    } else if(water){
      source='water';v.arms.forEach((arm,i)=>{const q=water.hands[armSide(v,i)==='left'?0:1];targets[i]=V().copy(h.position).addScaledVector(_fwd,q[0]).addScaledVector(_right,q[1]).addScaledVector(UP,q[2]);});reachTo(v,targets,false);closeHands(v,targets.map(()=>0));
    } else if (expression?.freeHands) {
      source='expression';
      v.arms.forEach((arm,i)=>{
        const q=expression.freeHands![armSide(v,i)==='left'?0:1];
        targets[i]=V().copy(h.position).addScaledVector(_fwd,q[0]).addScaledVector(_right,q[1]).addScaledVector(UP,q[2]);
      });
      reachTo(v,targets,false);closeHands(v,targets.map(()=>0));
    } else dangle(v, pz.bend, []);
    // Canonical geometry replaces only the generic object. The declared holding hand keeps a real carry pose,
    // including seated holds; its opposite hand and every authoritative contact keep the attained base pose.
    if (canonicalHeld && canonicalArmFree) {
      const pictures = this.heldPictures.get(h.name);
      for (const [id,current] of pictures ?? []) {
        const entry = v.heldEntries?.entries.find(e => e.id === id), i = v.arms.findIndex((_,i)=>armSide(v,i)===current.hand);
        if (!entry || i < 0) continue;
        const arm = v.arms[i], out = current.hand === 'left' ? -1 : 1;
        const target = arm.upper.getWorldPosition(V()).addScaledVector(_fwd,CARRY_HAND[0]+heldBackExtent(current.picture,entry))
          .addScaledVector(_right,out*CARRY_HAND[1]).addScaledVector(UP,CARRY_HAND[2]);
        if (sitW > 0) {
          // A held solid clears the actual posed lap, including crossed legs; never raise the body to fit it.
          let lap = -Infinity;
          for (const refs of v.surf.leg?.values() ?? []) eachSkinnedWorld(refs,V(),p=>{lap=Math.max(lap,p.y);});
          const bottom=heldGripBounds(current.picture,entry)?.min.y;
          if (bottom !== undefined && Number.isFinite(lap)) target.y=Math.max(target.y,lap-bottom);
        }
        const weight = v.heldArmKnown ? 1 : carryW;
        if (weight <= 0) continue; // Leave the attained base untouched at the exact arrival boundary.
        current.picture.object.userData.heldReach = {requested:target.toArray(),reachable:arm.upper.getWorldPosition(V()).distanceTo(target)<=armLen(arm)*.98};
        targets[i]=target; source='carry'; armTo(arm,target,weight,.98,h,V().copy(_right).multiplyScalar(out*.6).addScaledVector(UP,-.5).addScaledVector(_fwd,-.2));
        curlHand(arm,smooth((.6*weight-.3)/.5)); h.updateMatrixWorld(true);
      }
    }
    // The recorded press owns only its selected free hand, over the actual current base pose.
    // Its native recovery is inside the move; cancellation lowers from the attained weight.
    // Explicit hands, held props, grips and paired contacts always win.
    if (v.formPress && freeBody && !hasHands && !gripping && !v.itemPose && !v.handActuator && !v.propWanted && !wantProp && !v.handHold && !v.rps && !v.partner) for (const press of v.formPress) {
      const k = pressWeight(press,tSec), i = v.arms.findIndex((_,i) => armSide(v,i) === press.hand);
      if (k > 0 && i >= 0) {
        const arm = v.arms[i], from = palm(arm,V()), shoulder = arm.upper.getWorldPosition(V());
        const left = armSide(v,i) === 'left';
        const offset = V().copy(_fwd).multiplyScalar(.6).addScaledVector(_right,(left?-1:1)*-.18).addScaledVector(UP,-.3);
        offset.clampLength(0,armLen(arm)*.98);
        const target = shoulder.clone().add(offset);
        const pole = arm.lower.getWorldPosition(V()).sub(shoulder.clone().add(from).multiplyScalar(.5));
        pole.lerp(V().copy(_right).multiplyScalar(left?-.6:.6).addScaledVector(UP,-.5).addScaledVector(_fwd,-.2),k);
        armTo(arm,from.lerp(target,k),k,.98,h,pole);
        h.updateMatrixWorld(true); targets[i] = target; source = 'expression';
      }
    }
    // entry 35: hand games over whatever the arms do now (holding hands, an offered hand, a rock-paper-scissors count)
    const hgDiag = handGame ? poseHandGames(v, v.arms, (i) => armSide(v, i), h, _fwd, _right, h.position.y, v.spine?.head) : null;
    if (warmW > 0 && v.fire && !gripping && !hasHands) warmHands(v, warmW, h.position);
    if (v.sleepPose && pr && v.spine?.head && !lib.sleep) {
      turn(v.spine.head, _right, sleepHeadPitch(pr));
      if(source==='sleep')turn(v.spine.head, _fwd, (v.vary<.5?-1:1)*Math.PI*.48*sleepRestWeight(pr));
      h.updateMatrixWorld(true);
    }
    // A bounded book gaze uses the existing rig adapter only; seat/body authority is unchanged.
    if (v.spine?.head && v.readingGaze && sitW > .9) {
      const head=v.spine.head;
      const axis=_right.clone().applyQuaternion(head.parent!.getWorldQuaternion(new THREE.Quaternion()).invert());
      head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis,-(v.readingGaze.prev+(v.readingGaze.cur-v.readingGaze.prev)*alpha)));
    }
    if (act && v.spine?.head && act.look && !act.lying && !(v.readingGaze && sitW > .9 && v.readingGaze.cur > 0)) {
      const head = v.spine.head;
      const axis = _right.clone().applyQuaternion(head.parent!.getWorldQuaternion(new THREE.Quaternion()).invert());
      head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, -act.look));
      h.updateMatrixWorld(true);
    }
    if (canonicalHeld && v.prop) v.prop.obj.visible = false;
    if (wantProp && !canonicalHeld) {
      if (!v.prop || v.prop.kind !== wantProp) { if (v.prop) h.remove(v.prop.obj); v.prop = { kind: wantProp, obj: makeProp(wantProp) }; h.add(v.prop.obj); }
      const hand = (side: 'left' | 'right') => { const i = v.arms.findIndex((_, k) => armSide(v, k) === side); return i >= 0 ? palm(v.arms[i], V()) : null; };
      let L = hand('left'), R = hand('right');
      // a library eat / drink clip lifts one hand to the mouth: the item goes in that hand (the higher one over the clip).
      // Only when that clip owns the arms: seated, the sitting clip plays under the procedural frame, whose right hand rises.
      if (clipBody && lib.cur && (v.activity === 'eat' || v.activity === 'drink') && wantProp !== 'plate') {
        const d = lib.cur.act.getClip().duration;
        let up = 0;
        for (const k of [0.2, 0.4, 0.6, 0.8]) { const p = clipProbe(v.rig.template, lib.cur.clip, Math.round(d * k * 10) / 10); if (p) up += p.wristL.y - p.wristR.y; }
        if (up > 0) [L, R] = [R, L];
      }
      if(wantProp==='flute'&&act?.flute){
        const head=v.spine?.head?.getWorldPosition(V())??V().copy(h.position).addScaledVector(UP,1.525);
        const centre=head.addScaledVector(_fwd,.1).addScaledVector(UP,.02).addScaledVector(_right,.24);
        if(L&&R)centre.lerp(V().copy(L).add(R).multiplyScalar(.5),1-act.flute.weight);
        _m.makeBasis(_right,UP,V().copy(_fwd).negate()).setPosition(centre);v.prop.obj.matrixAutoUpdate=false;v.prop.obj.matrix.copy(_m);v.prop.obj.matrixWorldNeedsUpdate=true;v.prop.obj.visible=true;
      }else placeProp(v.prop.obj, wantProp, L, R, V().copy(_fwd));
      // placeProp wrote a world matrix: express it in the holder's frame (the prop is the holder's child)
      v.prop.obj.matrix.premultiply(_inv.copy(h.matrixWorld).invert());
    }
    heldSheet(v, h, tSec);
    if (v.spine?.head && Math.abs(gaze) > 1e-5) {
      const head = v.spine.head;
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(head.parent!.getWorldQuaternion(new THREE.Quaternion()).invert());
      head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, -gaze));
      h.updateMatrixWorld(true);
    }
    if((water||waterFrom)&&v.waterTransition){
      const weight=clamp01(v.waterTransition.weight);
      const swimReference=water?.kind==='surface-swim'?water:waterOrigins.map(origin=>origin.pose?waterMotionAt(h.name,origin.pose.activity,v.shoreTime??lerp(a.expressionT,b.expressionT,alpha),origin.pose.contact):null).find(m=>m?.kind==='surface-swim');
      v.saved.forEach((s,i)=>{
        s.o.position.lerp(waterStart?.[i].p??s.p,1-weight);
        const origin=waterStart?.[i].q??s.q,foot=swimReference?v.legs.findIndex(l=>l.foot===s.o):-1;
        if(foot>=0){
          const reference=footPitch(v,foot,-Math.PI/4-swimReference!.bodyPitch*.5);
          reference.premultiply(s.o.parent!.getWorldQuaternion(new THREE.Quaternion()).invert());
          blendWaterFoot(s.o.quaternion,origin,reference,weight);
        }else s.o.quaternion.slerp(origin,1-weight);
      });h.updateMatrixWorld(true);
      // Original Foot bones are Root siblings: reconnect to the blended shin
      // endpoint while retaining the eased foot orientation and fixed lengths.
      v.legs.forEach((leg,i)=>place(leg.foot,leg.lower.localToWorld(v.ankle[i].clone())));
    }
    if(source==='sleep'&&pr&&v.sleepPose&&!water&&!waterFrom&&v.spine?.head){
      const lift=sleepHeadRestLift(pr,v.rig.template.name);
      if(lift>0){place(v.spine.head,v.spine.head.getWorldPosition(V()).addScaledVector(UP,lift));v.spine.head.updateWorldMatrix(true,true);}
    }
    // A transition starts from the pose actually drawn at its immutable activity boundary. The source evaluation
    // uses an isolated skeleton/mixer with the same immutable template; it never samples the previous frame.
    const pc = v.postureChange;
    const floorToMove=!!pc&&['back','front'].includes(postureKind(pc.from,pc.fromBase))&&GAIT_ACTS.has(v.activity);
    const freeFloor=['back','front'].includes(postureKind(v.activity,v.base))&&POSTURE_ORIGINS.has(v.activity);
    const phase = pc ? posturePhaseEnds(pc,v.base,v.activity).filter(end=>end<=pc.age&&pc.age-end<ACT_BLEND).at(-1) : undefined;
    const walkingOrigin=!!pc&&GAIT_ACTS.has(pc.from)&&!!pc.fromWalk&&freeFloor&&pc.age<ACT_BLEND;
    // A known floor-phase endpoint is safe to sample even when its original entry came from locomotion.
    const noOwner = (floorTransition || (POSTURE_ORIGINS.has(pc?.from ?? v.activity)||walkingOrigin||phase!==undefined&&freeFloor) && (POSTURE_ORIGINS.has(v.activity)||floorToMove)) && freeBody && !engineHands && !gripping && !v.handHold && !v.rps && !v.partner && !v.propWanted && !v.prop?.obj.visible && !v.shore && !waterFrom && sitW === 0 && (w < .01 || floorToMove || freeFloor);
    if (pc && pc.age >= 0 && (pc.age < ACT_BLEND || phase !== undefined) && noOwner && ['stand','back','front'].includes(postureKind(pc.from,pc.fromBase)) && ['stand','back','front'].includes(postureKind(v.activity,v.base))) {
      this.blendPostureOrigin(v, pc, tSec, alpha, reach, sourcePose, phase ?? 0);
    } else if (!noOwner) v.postureOrigins?.clear();
    // Upright library ownership changes also suppress idle/procedural layers at zero clip weight. Start from
    // their full immutable drawn origin, not merely the last named clip or the last rendered frame.
    const origin = v.clipOrigin;
    const originFrame = origin ? activityFrame(origin.sample.activity ?? 'idle', origin.sample.baseActivity ?? 'idle', tSec - origin.age, h.name, { since: origin.sample.activityAge }) : null;
    // A re-entering Wave already reconstructs its released tail; freezing it again double-blends that owner.
    const clipBoundary = !!origin && origin.age >= 0 && origin.age < CLIP_FADE && freeBody && !nativeHandOwner && !engineHands && !gripping && !v.transfer && !v.watering && !v.cup && !v.letGo && !v.lastHandActuator && !v.handHold && !v.rps && !v.propWanted && !v.prop?.obj.visible && !v.instrument && !v.speaking && !v.formPress?.length && !v.shore && !waterFrom && sitW === 0 && w < .01
      && !(v.activity==='wave'&&origin.history?.length===0&&(origin.sample.activityAge??0)>=CLIP_FADE&&origin.sample.waveSamples?.some(s=>s.released!==undefined))
      && !act?.pairedContact && !originFrame?.pairedContact && (!act?.hop || ACTIVITY_OVERLAYS.has(v.activity)) && (!originFrame?.hop || ACTIVITY_OVERLAYS.has(origin.sample.activity ?? 'idle')) && !act?.ride && !originFrame?.ride && !lib.posture && !lib.still
      && postureKind(v.activity, v.base) === 'stand' && postureKind(origin.sample.activity ?? 'idle', origin.sample.baseActivity) === 'stand'
      && origin.sample.walk < .01 && !origin.sample.instrument;
    if (clipBoundary) {
      this.blendClipOrigin(v, origin!, tSec, sourcePose);
    }
    if (v.seatSample && freeBody && !nativeHandOwner && !engineHands && !gripping && !v.handHold && !v.rps && !v.propWanted && !v.formPress?.length && !v.instrument && !act?.pairedContact) this.blendSeat(v, tSec, sourcePose);
    const freeContacts=noOwner||freeFloor&&freeBody&&!engineHands&&!gripping&&!v.handHold&&!v.rps&&!v.partner&&!v.propWanted&&!v.prop?.obj.visible&&!v.shore&&!waterFrom&&sitW===0;
    if (freeContacts && (act?.lying || pc && (pc.age < ACT_BLEND || phase !== undefined || lib.posture))) fitFreeGround(v, h, v.cur.p[1]);
    if(!heldArmBlocked&&canonicalArmFree&&v.heldArmOrigin)this.blendHeldArmOrigin(v,v.heldArmOrigin,tSec,sourcePose);
    this.drawHeld(v);
    v.diag = diagOf(v, gait?.g ?? null, gait?.f.id ?? '', pz, targets, source, fp, proneW > 0 ? pr : null);
    if(expression)v.diag.expression=expression;
    if(water)v.diag.water=water;
    if(hgDiag)v.diag.handGame=hgDiag;
  }

  private prepareHeld(v: View, blocked: boolean): boolean {
    const id = v.rig.holder.name;
    if (blocked || !this.heldPictureFactory) { this.clearHeldPictures(id); return false; }
    const projections = heldProjections(v.heldEntries, v.nativeHands);
    if (!projections.length) { this.clearHeldPictures(id); return false; }
    let pictures = this.heldPictures.get(id);
    if (!pictures) this.heldPictures.set(id, pictures = new Map());
    const kept = new Set<string>();
    for (const {entry, hand} of projections) {
      if (!v.arms.some((_, i) => armSide(v,i) === hand)) continue;
      const key = JSON.stringify(entry); let current = pictures.get(entry.id);
      if (current?.key !== key) {
        current?.picture.dispose(); pictures.delete(entry.id);
        const picture = this.heldPictureFactory!(entry);
        if (picture) { this.group.add(picture.object); current = {key,picture,hand}; pictures.set(entry.id,current); }
        else current = undefined;
      }
      if (current) { if (current.hand !== hand) v.carrySince = undefined; current.hand = hand; kept.add(entry.id); }
    }
    for (const [entry, current] of pictures) if (!kept.has(entry)) { current.picture.dispose(); pictures.delete(entry); }
    return pictures.size > 0;
  }

  private drawHeld(v: View) {
    const pictures = this.heldPictures.get(v.rig.holder.name); if (!pictures?.size) return;
    v.rig.holder.updateMatrixWorld(true);
    const rotation = v.rig.holder.getWorldQuaternion(new THREE.Quaternion());
    for (const [id, current] of pictures) {
      const entry = v.heldEntries?.entries.find(e => e.id === id), i = v.arms.findIndex((_, i) => armSide(v,i) === current.hand);
      if (entry && i >= 0) placeHeld(current.picture,entry,palm(v.arms[i],V()),rotation,this.group);
    }
  }

  /** Fold immutable observed predecessors in an isolated rig, then affect only the declared arm bones. */
  private blendHeldArmOrigin(v:View,c:HeldArmOrigin,time:number,sourcePose:boolean){
    if(c.age<0||c.age>=HELD_ARM_EASE)return;
    if(v.heldArmContext!==c.context){v.heldArmCache?.clear();v.heldArmContext=c.context;}
    const cache=v.heldArmCache??=new Map<string,DrawnOrigin>(),h=v.rig.holder,joints=poseBones(v.rig.model);
    let origin=c.drawn;
    const sources=[{at:c.at,age:c.age,hands:c.hands,sample:c.sample},...(c.history??[]).map(s=>({...s,at:c.at-s.offset}))];
    const displayBoundary=time-c.age;
    const key=(i:number)=>JSON.stringify([sources[i].at,sources[i].sample,h.position.toArray(),v.cur.yaw,displayBoundary-(c.at-sources[i].at)]);
    if(!origin){
      let start=sources.length-1;
      for(let i=0;i<sources.length;i++){const found=cache.get(key(i));if(found){origin=found;start=i-1;break;}}
      const evaluator=new HumanViews(false);evaluator.templates=[v.rig.template];
      // A historical probe returns metadata on a non-rendered empty object, never a second visible held mesh.
      evaluator.setHeldPictureFactory(entry=>this.heldPictureFactory?.(entry,'probe')??null);
      try {
        for(let i=start;i>=0;i--){
          const source=sources[i],prior=sources[i+1];
          // Missing exact historical contact geometry is unknown, never a legacy-prop origin.
          for(const projection of heldProjections(source.sample.heldEntries,source.sample.nativeHands)){
            const probe=this.heldPictureFactory?.(projection.entry,'probe');if(!probe)return;probe.dispose();
          }
          const sample={...source.sample,id:h.name,p:[...v.cur.p] as [number,number,number],yaw:v.cur.yaw,heldArmKnown:true,
            heldArmOrigin:origin&&prior?{at:prior.at,age:prior.age,hands:[...new Set(sources.slice(i+1).flatMap(s=>s.hands))],sample:prior.sample,drawn:origin,context:c.context}:undefined};
          if(sample.bodyModel)evaluator.setBodyTemplates(new Map([[sample.bodyModel,v.rig.template]]));
          evaluator.setFrame([sample],displayBoundary-(c.at-source.at));evaluator.render(1);
          const old=evaluator.bodyObject(h.name);if(!old)return;
          origin=drawnOrigin(old,old,new THREE.Vector3(...v.cur.p),new THREE.Quaternion().setFromAxisAngle(UP,-v.cur.yaw));
          if(!sourcePose){if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(key(i),origin);}
        }
      }finally{evaluator.clear();}
    }
    if(!origin)return;
    const selected=new Set<THREE.Object3D>();
    for(const hand of new Set(sources.flatMap(s=>s.hands))){const arm=v.arms.find((_,i)=>armSide(v,i)===hand);if(arm){arm.upper.traverse(o=>selected.add(o));selected.add(arm.hand);for(const finger of [...arm.fingers,...arm.thumb])selected.add(finger);}}
    const weight=smooth(c.age/HELD_ARM_EASE);
    joints.forEach((bone,i)=>{if(selected.has(bone)){bone.position.lerpVectors(origin!.bones[i].p,bone.position,weight);bone.quaternion.slerpQuaternions(origin!.bones[i].q,bone.quaternion,weight);}});
    h.updateMatrixWorld(true);
  }

  private blendClipOrigin(v: View, c: ClipOrigin, time: number, sourcePose: boolean) {
    const h=v.rig.holder, root=new THREE.Vector3(...v.cur.p), nativeQ=new THREE.Quaternion().setFromAxisAngle(UP,-v.cur.yaw);
    const localPalm=(arm:Arm)=>palm(arm,V()).sub(root).applyQuaternion(nativeQ.clone().invert());
    const palms=v.seatSample?undefined:v.arms.map(localPalm);
    const joints=poseBones(v.rig.model);
    const target={bones:joints.map(o=>({p:o.position.clone(),q:o.quaternion.clone()})),p:h.position.clone(),q:h.quaternion.clone()};
    if(v.clipContext!==c.context){v.clipOrigins?.clear();v.clipContext=c.context;}
    const cache=v.clipOrigins??=new Map();let origin=c.drawn;
    if(!origin){
      const boundary=time-c.age, sources=[{offset:0,age:c.age,sample:c.sample},...c.history??[]];
      if(sources.some(source=>source.sample.bodyModel&&this.bodyTemplates.get(source.sample.bodyModel)!==v.rig.template))return;
      const key=(i:number)=>JSON.stringify([boundary-sources[i].offset,sources[i].sample,v.cur.p,v.cur.yaw],(_k,value)=>typeof value==='number'?Math.round(value*1e6)/1e6:value);
      // A cached collapsed prefix is a complete fixed-size pose, including every earlier contribution.
      // Warm playback evaluates only new boundaries; a cold seek folds the retained chain once, without recursion.
      let start=sources.length-1;
      for(let i=0;i<sources.length;i++){const found=cache.get(key(i));if(found&&(!v.seatSample||found.feet)){origin=found;start=i-1;break;}}
      if(start>=0){
        const evaluator=new HumanViews(false);evaluator.setTemplates([v.rig.template]);
        evaluator.setHeldPictureFactory(entry=>this.heldPictureFactory?.(entry,'probe')??null);
        try {
          for(let i=start;i>=0;i--){
            const source=sources[i],prior=sources[i+1];
            const sample={...source.sample,id:h.name,p:[...v.cur.p] as [number,number,number],yaw:v.cur.yaw,
              ...(origin&&prior?{clipOrigin:{age:prior.age,sample:prior.sample,drawn:origin}}:{})};
            if(sample.bodyModel)evaluator.setBodyTemplates(new Map([[sample.bodyModel,v.rig.template]]));
            evaluator.setFrame([sample],boundary-source.offset);
            if(v.seatSample&&(v.cur.hands.left||v.cur.hands.right||v.formPress?.length))evaluator.pose(evaluator.views.get(h.name)!,1,undefined,true);else evaluator.render(1);
            const old=evaluator.bodyObject(h.name)!;origin=drawnOrigin(old,old,root,nativeQ);
            if(v.seatSample){const view=evaluator.views.get(h.name)!;origin.feet=seatFootOffsets(view);origin.arms=view.ownerArmBase;}
            else origin.palms=evaluator.views.get(h.name)!.arms.map(localPalm);
            if(!sourcePose){if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(key(i),origin);}
          }
        } finally {evaluator.clear();}
      }
    }
    if(!origin)return;
    const k=smooth(c.age/CLIP_FADE);
    if(v.seatSample)blendSeatDrawn(v,joints,target,origin,k,root,nativeQ);else{
      blendDrawn(h,joints,target,origin,k,root,nativeQ);
      // Bone slerp can bow a free hand into nearby scenery even when both endpoint poses clear it.
      // Keep the immutable palm chord; the existing fixed-length solver retains its bend/reach policy.
      if(palms&&origin.palms?.length===v.arms.length)v.arms.forEach((arm,i)=>{
        const goal=origin.palms![i].clone().lerp(palms[i],k).applyQuaternion(nativeQ).add(root);
        if(goal.distanceToSquared(palm(arm,V()))<1e-16)return;
        const pole=arm.lower.getWorldPosition(V()).sub(arm.upper.getWorldPosition(V()));
        armTo(arm,goal,1,BODY_MODEL.maxExtension,h,pole);
      });
    }
  }

  private blendPostureOrigin(v: View, pc: PostureChange, time: number, alpha: number, reach: Reach | undefined, sourcePose: boolean, phase: number) {
    const delta=pc.age-phase+1e-6;
    const boundary = time - delta, h = v.rig.holder;
    const shifted = (c: PostureChange): PostureChange => ({...c,age:c.age-delta,...(c.before?{before:shifted(c.before)}:{})});
    const before = phase ? shifted(pc) : pc.before ? shifted(pc.before) : undefined;
    const from = phase ? v.activity : pc.from, fromBase=phase?v.base:pc.fromBase;
    const nativeQ = new THREE.Quaternion().setFromAxisAngle(UP, -v.cur.yaw);
    const key = JSON.stringify([Math.round(boundary*1e6),pc.from,pc.fromBase,pc.fromAge,before,v.cur.p,v.cur.yaw,pc.fromWalk??null,phase],(_k,value)=>typeof value==='number'?Math.round(value*1e6)/1e6:value);
    const cache = v.postureOrigins ??= new Map();
    let origin = cache.get(key);
    const joints=poseBones(v.rig.model);
    const target = {bones:joints.map(o=>({p:o.position.clone(),q:o.quaternion.clone()})),p:h.position.clone(),q:h.quaternion.clone()};
    const root = new THREE.Vector3(...v.cur.p);
    if (!origin) {
      const age = phase ? v.since===undefined?undefined:v.since-delta : pc.fromAge===undefined?undefined:Math.max(0,pc.fromAge-1e-6);
      const snap = {...v.cur,...(!phase?GAIT_ACTS.has(from)&&pc.fromWalk?{walkW:pc.fromWalk.weight,walkT:((pc.fromWalk.distance/v.rig.template.walkSpeed)%v.rig.walk.getClip().duration+v.rig.walk.getClip().duration)%v.rig.walk.getClip().duration}:{walkW:0,walkT:0}:{}),expressionT:boundary,idleT:(boundary+(h.name.length*.37)%1)%v.rig.idle.getClip().duration};
      // A separate skeleton AND mixer keep source evaluation out of the displayed rig's property-binding cache.
      // This private evaluator is never attached to the world and never loads appearances, props or network assets.
      const evaluator = new HumanViews(false);evaluator.templates=[v.rig.template];
      const old=evaluator.make(h.name,snap,from,undefined,undefined,true);
      Object.assign(old,{prev:snap,cur:snap,activity:from,base:fromBase??from,since:age,prevAct:before?.from,prevBase:before?.fromBase,prevDuration:before?.fromAge,postureChange:before,
        restAge:REST_ACTS.has(from)?age:undefined,restFrom:REST_ACTS.has(from)&&age!==undefined?boundary-age:undefined});
      try {
        evaluator.pose(old,1,undefined,true);
        origin=drawnOrigin(old.rig.model,old.rig.holder,root,nativeQ);
      } finally { evaluator.clear(); }
      // Cache only values derived from immutable boundaries. Eviction changes cost, never the evaluated pose.
      if(!sourcePose){if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(key,origin!);}
    }
    const k=smooth((pc.age-phase)/ACT_BLEND);
    blendDrawn(h,joints,target,origin!,k,root,nativeQ);
  }

  /** Seat phase endpoints and activity interruptions share immutable recorded origins. */
  private blendSeat(v: View, time: number, sourcePose: boolean): number {
    const sample = v.seatSample!, pc = sample.postureChange, plan = v.seatPlan;
    const endpoint = plan && pc && pc.age >= plan.end && pc.age - plan.end < ACT_BLEND ? plan.end : undefined;
    const initial = pc && pc.age < ACT_BLEND && plan ? 0 : undefined;
    const phase = endpoint ?? initial;
    let origin: SampledHuman | undefined, age: number;
    const shift = (p: PostureChange, dt: number): PostureChange => ({ ...p, age: p.age - dt, ...(p.before ? { before: shift(p.before, dt) } : {}) });
    if (phase !== undefined && sample.seatOrigin?.phase === phase && sample.seatOrigin.sample) {
      origin = sample.seatOrigin.sample; age = pc!.age - phase!;
    } else if (phase === 0 && sample.clipOrigin && Math.abs(sample.clipOrigin.age - pc!.age) < 1e-5) {
      this.blendClipOrigin(v, sample.clipOrigin, time, sourcePose);
      v.legs.forEach((_, i) => fitSeatedFoot(v, i, 1, true)); return smooth(sample.clipOrigin.age / CLIP_FADE);
    }
    else if (phase !== undefined && pc) {
      age = pc.age - phase;
      const delta = age + 1e-6;
      origin = phase > 0 ? { ...sample, activityAge: sample.activityAge === undefined ? undefined : Math.max(0, sample.activityAge - delta), postureChange: shift(pc, delta), clipOrigin: sample.clipOrigin && sample.clipOrigin.age >= delta ? { ...sample.clipOrigin, age: sample.clipOrigin.age - delta } : undefined }
        : { ...sample, activity: pc.from, baseActivity: pc.fromBase, activityAge: sample.activity === pc.from && sample.activityAge !== undefined ? Math.max(0, sample.activityAge - delta) : pc.fromAge, postureChange: pc.before ? shift(pc.before, delta) : undefined, clipOrigin: undefined,
          ...(sample.seatOrigin ? { seatHeight: sample.seatOrigin.height } : {}) };
    } else if (sample.clipOrigin && sample.clipOrigin.age < CLIP_FADE && postureKind(sample.activity ?? 'idle', sample.baseActivity) === postureKind(sample.clipOrigin.sample.activity ?? 'idle', sample.clipOrigin.sample.baseActivity)) {
      this.blendClipOrigin(v, sample.clipOrigin, time, sourcePose);
      v.legs.forEach((_, i) => fitSeatedFoot(v, i, 1, true)); return smooth(sample.clipOrigin.age / CLIP_FADE);
    } else return 1;
    if(origin.bodyModel&&this.bodyTemplates.get(origin.bodyModel)!==v.rig.template)return 1;
    const h = v.rig.holder, root = new THREE.Vector3(...v.cur.p), nativeQ = new THREE.Quaternion().setFromAxisAngle(UP, -v.cur.yaw), joints = poseBones(v.rig.model);
    const target = { bones: joints.map(o => ({ p: o.position.clone(), q: o.quaternion.clone() })), p: h.position.clone(), q: h.quaternion.clone() };
    const key = JSON.stringify([time - age!, origin, v.cur.p, v.cur.yaw], (_key, value) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value);
    const cache = v.seatOrigins ??= new Map();
    let drawn = cache.get(key);
    if (!drawn) {
      const evaluator = new HumanViews(false); evaluator.setTemplates([v.rig.template]);
      evaluator.setHeldPictureFactory(entry=>this.heldPictureFactory?.(entry,'probe')??null);
      if(origin.bodyModel)evaluator.setBodyTemplates(new Map([[origin.bodyModel,v.rig.template]]));
      try {
        evaluator.setFrame([{ ...origin, id: h.name, p: [...v.cur.p], yaw: v.cur.yaw }], time - age! - 1e-6);
        const old = evaluator.views.get(h.name)!; evaluator.pose(old, 1, undefined, true);
        drawn = drawnOrigin(old.rig.model, old.rig.holder, root, nativeQ); drawn.feet = seatFootOffsets(old); drawn.arms = old.ownerArmBase;
      } finally { evaluator.clear(); }
      if (!sourcePose) { if (cache.size >= 32) cache.delete(cache.keys().next().value!); cache.set(key, drawn); }
    }
    let share = smooth(age! / ACT_BLEND);
    blendSeatDrawn(v, joints, target, drawn, share, root, nativeQ);
    // A newer gesture can interrupt a still-blending seat endpoint. Its origin is
    // the whole attained endpoint blend, not just the outgoing chair clip.
    if (phase !== undefined && sample.clipOrigin && sample.clipOrigin.age < CLIP_FADE && pc!.age - sample.clipOrigin.age > phase + 1e-5) { this.blendClipOrigin(v, sample.clipOrigin, time, sourcePose); share *= smooth(sample.clipOrigin.age / CLIP_FADE); }
    // Bone interpolation must not bury a shoe cuff; never lower an already fitted origin twice.
    v.legs.forEach((_, i) => fitSeatedFoot(v, i, 1, true));
    return share;
  }

  /**
   * Library clips for this frame (clip-library.ts): the current activity's clip and, during the first CLIP_FADE seconds
   * of an activity, the previous one's, each with its clip time. Never on a frame, a grip or with engine hand points
   * for a standing clip (those poses stay the engine's).
   */
  private libraryPlan(v: View, b: Snap, t: number): LibPlan {
    const out: LibPlan = { cur: null, prev: null, fade: 1, sleep: false, still: false, water: false };
    if (v.grip || v.on || v.frame || !this.templates.length) return out;
    const engineHands = !!(b.hands.left || b.hands.right);
    const sh = v.shore, buoyant = sh?.mode === 'buoyant';
    const water = !engineHands && sh && buoyant ? (v.activity === 'swim' ? 'swim' as const : v.activity === 'tread' ? 'tread' as const : undefined) : undefined;
    const phaseId = v.partner && v.partner < v.rig.holder.name ? v.partner : v.rig.holder.name;
    const one = (pick: LibraryPick | null, since: number | undefined, phase = v.sleepPose?.standingFraction): LibOne | null => {
      if (!pick || (engineHands && pick.body !== 'seat' && pick.body !== 'ground-seat')) return null;
      const clip = pickClip(pick, v.rig.holder.name), act = libAction(v.rig, clip);
      if (!act) return null;
      return { pick, act, clip, time: clipTime(pick, act.getClip().duration, t, phaseId, since, phase) };
    };
    // posture-transition.ts: a change of posture with no phase of its own in the record is drawn over the next second;
    // getting up from the back or lying down on it is LayToIdle by phase in place of the activity's own frame
    const pc = v.postureChange;
    const pn = pc && !v.sleepPose && !engineHands && !water ? postureNow(pc, v.activity, v.base, { time: t, id: phaseId }) : null;
    out.posture = pn?.activity ? null : pn; // a seat's own phase is drawn as that activity (setFrame)
    const rise = out.posture?.rise;
    if (rise !== undefined && (out.cur = one({ clip: 'LayToIdle', mode: 'phase', body: 'lie' }, undefined, rise))) { out.rise = rise; out.still = true; return out; }
    const ctx = (activity: string, base: string, ground: boolean) => ({ activity, base, ground, seated: SEATED.has(base) && !ground, speaking: !!v.speaking, speed: v.speed, partner: !!v.partner });
    out.cur = one(libraryPick({ ...ctx(v.activity, v.base, !!v.groundSeat), ...(v.sleepPose ? { sleep: v.sleepPose.standingFraction } : {}), ...(water ? { water } : {}) }), v.since);
    if (v.since !== undefined && v.since < CLIP_FADE && v.prevAct !== undefined && v.prevAct !== v.activity) {
      out.fade = smooth(v.since / CLIP_FADE);
      out.prev = one(libraryPick(ctx(v.prevAct, v.prevBase ?? 'idle', v.prevAct === 'sit-ground')), undefined);
    }
    const body = out.cur?.pick.body;
    out.sleep = !!(out.cur && body === 'lie' && v.sleepPose);
    const movingFloorExit=!!pn&&!!pc&&GAIT_ACTS.has(v.activity)&&['back','front'].includes(postureKind(pc.from,pc.fromBase));
    out.still = body === 'lie' || body === 'swim' || body === 'tread' || movingFloorExit&&!!(pn.flat||pn.tilt);
    out.water = body === 'swim' || body === 'tread';
    return out;
  }

  /**
   * Place the library clip's body (after the mixer): a sitting clip lowered / raised so the pelvis rests on this seat (its
   * feet stay on the floor by leg IK, or dangle from a high seat); LayToIdle laid along the heading with the hips over
   * the body point and the back resting on the ground; swimming / treading with the body at the water surface.
   * Returns whether a sitting clip owns the legs.
   */
  private libraryBody(v: View, lib: LibPlan, curW: number, prevW: number, yaw: number): boolean {
    const h = v.rig.holder, t = v.rig.template;
    if (!v.spine || v.legs.length < 2) return false;
    let seatW = 0, seatShift = 0, seatX = 0, seatZ = 0, supportW = 0;
    for (const [one, wgt] of [[lib.cur, curW], [lib.prev, prevW]] as [LibOne | null, number][]) {
      if (!one || wgt <= 1e-4) continue;
      const body = one.pick.body;
      if (body === 'seat' || body === 'ground-seat') {
        const d = one.act.getClip().duration, k = one.clip === 'Sitting_Enter' ? smooth(one.time / d) : one.clip === 'Sitting_Exit' ? 1 - smooth(one.time / d) : 1;
        const rest = clipProbe(t, body === 'seat' ? 'Sitting_Idle_Loop' : 'GroundSit_Idle_Loop', 0);
        const seat = body === 'ground-seat' ? GROUND_SEAT : v.seat;
        if (rest) {
          seatShift += wgt * k * (seat + PELVIS * (v.rig.template.bodyScale ?? 1) - rest.hip.y); seatW += wgt;
          // The clip sits its pelvis behind its standing origin. The native seat
          // point owns the pelvis, not that old origin: otherwise the shins pass
          // through the plank's front. Translate the fitted seated layout,
          // including foot goals, rather than stretching legs or moving a seat.
          if (body === 'seat') {
            supportW += wgt * k;
            seatX -= wgt * k * (rest.hip.x * Math.cos(yaw) - rest.hip.z * Math.sin(yaw));
            seatZ -= wgt * k * (rest.hip.x * Math.sin(yaw) + rest.hip.z * Math.cos(yaw));
          }
        }
      } else if (body === 'lie' && one === lib.cur) {
        const p0 = clipProbe(t, 'LayToIdle', 0);
        if (!p0) continue;
        // rising (sleep → standing, or a posture change getting up from the back): keep the lying heading and hips-over-point
        // layout, easing to the plain stance by the end; lying down (posture-transition.ts) is the same, run backwards
        const frac = lib.rise ?? v.sleepPose?.standingFraction ?? 0;
        const up = one.pick.mode === 'phase' ? smooth((frac - 0.55) / 0.45) : 0;
        const phi = Math.atan2(p0.head.z - p0.hip.z, p0.head.x - p0.hip.x);
        // lie / nap: hips over the body point, head along −yaw (as the procedural layout); a sleeper on a mat: feet at the
        // body point, head along +yaw (as the engine's prone sleep pose, so the body stays on its mat)
        const sleeper = one.pick.mode === 'phase' && lib.rise === undefined, want = sleeper ? 0 : Math.PI;
        const turnBy = lerpAngle(want - phi, 0, up) * wgt, ly = yaw + turnBy;
        h.rotation.y = -ly;
        const c = Math.cos(ly), s = Math.sin(ly), k = (1 - up) * wgt;
        // sleeper: hips 0.24 m ahead of the body point, head further along +yaw (where the prone sleep pose had them)
        const reach = sleeper ? 0.24 : 0;
        const ox = p0.hip.x * c - p0.hip.z * s - Math.cos(yaw) * reach, oz = p0.hip.x * s + p0.hip.z * c - Math.sin(yaw) * reach;
        h.position.x -= ox * k; h.position.z -= oz * k;
        const ec = Math.cos(yaw), es = Math.sin(yaw);
        const fit = lyingFloor(h.position.y, h.position.x + ox, h.position.z + oz, ec, es), bench = v.bench ?? 0, floor = fit.y + bench;
        const rest = smooth(1 - frac / 0.35) * wgt;
        // on a slope the body lies along the ground (as the procedural lying layout, WN3-3b)
        if (fit.k !== 0 && !bench && rest > 0) h.quaternion.premultiply(_tilt.setFromAxisAngle(_axis.set(-es, 0, ec), Math.atan(fit.k) * rest));
        h.updateMatrixWorld(true);
        // the back / head rest on the ground under each part of them
        let need = -Infinity;
        need = restNeed(v, sleeper ? 'sleep' : 'lie', bench, floor);
        if (Number.isFinite(need) && rest > 0) { h.position.y += need * rest; h.updateMatrixWorld(true); }
      } else if ((body === 'swim' || body === 'tread') && one === lib.cur && v.shore) {
        const p0 = clipProbe(t, one.clip, 0), root = v.rig.model.getObjectByName('Root');
        if (!p0 || !root) continue;
        const sub = v.shore.submergedHeightMetres;
        const dy = (body === 'swim' ? Math.max(sub - 0.06 - p0.hip.y, sub + 0.02 - p0.head.y) : sub + 0.16 - p0.head.y) * wgt; // swim: back at the surface, head out
        h.updateMatrixWorld(true);
        place(root, root.getWorldPosition(V()).addScaledVector(UP, dy));
      }
    }
    if (seatW <= 1e-4) return false;
    h.updateMatrixWorld(true);
    // feet first (Root children: they stay where the clip put them), then the pelvis onto the seat, then the legs to the feet
    const feet = v.legs.map((l) => ({ p: l.foot.getWorldPosition(V()), q: l.foot.getWorldQuaternion(new THREE.Quaternion()) }));
    const seatOffset = V().set(seatX, seatShift, seatZ);
    place(v.spine.body, v.spine.body.getWorldPosition(V()).add(seatOffset));
    h.updateMatrixWorld(true);
    const floorY = h.position.y + (v.dims?.ankleH ?? 0.08);
    v.legs.forEach((l, i) => {
      const goal = feet[i].p.clone(); goal.x += seatX; goal.z += seatZ;
      goal.y = Math.max(goal.y, floorY);
      legTo(l, v.ankle[i], goal, V().copy(_fwd).addScaledVector(UP, 0.35), 0.995, feet[i].q);
      fitSeatedFoot(v, i, supportW);
    });
    return seatW > 0.5;
  }

  private gaitOf(p: THREE.Vector3,v:View): { g: Gait; f: Flight } | null {
    for (const f of [...this.supplementalFlights,...this.flights]) {
      // Only the verified ordinary Walk/Idle/native-climb layer has this bound.
      const ordinary=!v.running&&(['idle','walk'].includes(v.activity)||v.activity.startsWith('climb'));
      if(f.supports&&!ordinary)continue;
      const envelope=f.supports&&v.stairContact&&ordinary?stairContactEnvelope(v.stairContact,-v.rig.holder.rotation.y,f.dir):undefined;
      const g = gaitAt(f, p.x, p.z, p.y,envelope);
      if (g && g.weight > 0) return { g, f };
    }
    return null;
  }

  /** Rendered palm centre of a person's hand after the last render (items in hand attach here). */
  palmOf(id: string, hand: 'left' | 'right', out: THREE.Vector3): boolean {
    const v = this.views.get(id);
    if (!v) return false;
    const i = v.arms.findIndex((_, k) => armSide(v, k) === hand);
    if (i < 0) return false;
    palm(v.arms[i], out);
    return true;
  }

  /** Rendered yaw (engine convention) and mouth point (≈ lips) of a person after the last render. */
  headOf(id: string, out: THREE.Vector3): number | null {
    const v = this.views.get(id);
    if (!v?.spine?.head) return null;
    v.spine.head.getWorldPosition(out);
    const yaw = -v.rig.holder.rotation.y;
    out.x += Math.cos(yaw) * 0.09;
    out.z += Math.sin(yaw) * 0.09;
    out.y += 0.02;
    return yaw;
  }

  /** Per-person pose readout of the last render (lab hook `bones()`). */
  /** Entry 26: the instrument a body plays now (from its take frame), for the sound layer. */
  instrumentOf(id: string): string | undefined { return this.views.get(id)?.instrument; }
  /** Seconds the depicted activity has run (the age the activity frames use); absent when it began before known history. */
  activityAgeOf(id: string): number | undefined { return this.views.get(id)?.since; }
  bones(id?: string) {
    const out: Record<string, Diag & { activity: string; base: string; ankleH: number; armLen: number; walkW: number; variety: number; template: string; body: Record<string, number>; armFit: { k: number; before: number }[]; on: string | null; goal: Posture; dims: Dims | null }> = {};
    for (const [k, v] of this.views) {
      if (id && k !== id) continue;
      if (!v.diag) {
        v.rig.holder.updateMatrixWorld(true);
        v.diag = diagOf(v, null, '', NEUTRAL, v.arms.map(() => null), null, null);
      }
      const d = v.dims, r4 = (x: number) => +x.toFixed(4);
      // standing rig measurements (Idle, t = 0): the body model's numbers as this rig has them
      const body = d ? { shoulderH: r4(d.pivotH + d.sh.up), armLen: r4(d.armLen), hipH: r4(d.hipH), thigh: r4(d.thigh), shin: r4(d.shin), kneelHip: r4(d.hipH - kneelDrop(d)), shoulderHalf: r4(d.shHalf) } : ({} as Record<string, number>);
      out[k] = { ...v.diag, activity: v.activity, base: v.base, ankleH: r4(d?.ankleH ?? 0), armLen: r4(d?.armLen ?? 0), walkW: +v.cur.walkW.toFixed(3), variety: +(v.variety ?? 0).toFixed(3), template: v.rig.template.name, body, armFit: v.rig.template.arms, on: v.on ?? null, goal: v.cur.pose, dims: d ?? null };
    }
    return out;
  }

  /** Local camera composition of the visible surface swimmer, never canonical
   * body/contact/capsule data. Other activities retain existing camera framing. */
  cameraSubjects(){
    const out:Record<string,{p:Vec3;yaw:number;height:number;points:Vec3[]}>={};
    for(const [id,v]of this.views){
      if(v.diag?.water?.kind!=='surface-swim'||!v.spine?.head)continue;
      const bones=[v.spine.body,v.spine.head,...v.legs.map(l=>l.foot),...v.arms.map(a=>a.hand)];
      const points=bones.map(b=>b.getWorldPosition(V()).toArray() as Vec3);
      const min=points.reduce((a,p)=>a.map((n,i)=>Math.min(n,p[i])) as Vec3,[Infinity,Infinity,Infinity]);
      const max=points.reduce((a,p)=>a.map((n,i)=>Math.max(n,p[i])) as Vec3,[-Infinity,-Infinity,-Infinity]);
      if(![...min,...max].every(Number.isFinite))continue;
      // Include hair/skin around bone centres without changing physical bounds.
      points.push([min[0]-.12,min[1]-.12,min[2]-.12],[max[0]+.12,max[1]+.18,max[2]+.12]);
      out[id]={p:[(min[0]+max[0])/2,min[1]-.12,(min[2]+max[2])/2],yaw:v.cur.yaw,height:max[1]-min[1]+.30,points};
    }
    return out;
  }

  /** Rendered body surface after the last render: every `stride`-th skinned vertex (world) with its body part (e2e). */
  meshPoints(id: string, stride = 3) {
    const v = this.views.get(id);
    const out: { p: [number, number, number]; part: BodyPart }[] = [];
    if (v) skinnedPoints(v.rig, stride, (q, part) => out.push({ p: [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4)], part }));
    return out;
  }

  /** Interpolated world positions (for labels/discs) keyed by actor id. */
  positions() {
    return new Map([...this.views].map(([id, v]) => [id, v.rig.holder.position]));
  }

  /** Read-only native metadata after sampling; no inferred grip or pose is added. */
  heldEntriesOf(id:string):HeldSet|undefined { return this.views.get(id)?.heldEntries; }
  consumeMoveOf(id:string):ConsumeMove|undefined { return this.views.get(id)?.consumeMove; }

  info() {
    return [...this.views].map(([id, v]) => ({ id, template: v.rig.template.name, clipSpeed: +v.rig.template.walkSpeed.toFixed(3), forward: v.rig.template.forward, speed: +v.speed.toFixed(3), walkWeight: +v.cur.walkW.toFixed(2), activity: v.activity, base: v.base, grip: v.grip ?? null, gripSlot: v.gripSlot ?? null, reach: v.grip || v.cur.hands.left || v.cur.hands.right ? v.reachRatio : null, armLen: v.arms[0] ? +armLen(v.arms[0]).toFixed(3) : null, arms: v.arms.length, sit: +v.cur.sitW.toFixed(2), seat: v.cur.sitW > 0 ? +v.seat.toFixed(2) : null, crossed: v.cross, pose: { drop: +v.cur.pose.drop.toFixed(3), bend: +v.cur.pose.bend.toFixed(3), rise: +v.cur.pose.rise.toFixed(3), kneel: +v.cur.pose.kneel.toFixed(3) } }));
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
type LibOne = { pick: LibraryPick; act: THREE.AnimationAction; clip: string; time: number };
type LibPlan = { cur: LibOne | null; prev: LibOne | null; fade: number; sleep: boolean; still: boolean; water: boolean;
  /** posture-transition.ts: the posture change drawn now, and LayToIdle's standing fraction while getting up or lying down. */
  posture?: PostureNow | null; rise?: number };
/** Playback rate of an idle variant clip. Idle_LookAround_Loop at the library's speed drops a hand from the head to the
 *  hip at up to 0.19 m per 50 ms (0.164–0.172 on 1.72 m bodies; entry 33, take 08: 0.158 m per 50 ms 1.2 s after a torch put-out; take 02:
 *  0.164), faster than any hand reach or release (≤ 0.15); at 0.7 it peaks at ≤ 0.14 on 1.65–1.85 m bodies (idle-gesture-speed.test.ts). */
const VARIANT_RATE: Readonly<Record<string, number>> = { Idle_LookAround_Loop: 0.7 };
/** Clip time of a person's idle variant at depicted seconds t (a per-person offset, at the clip's rate). */
export const variantTime = (clip: string, id: string, t: number) => (t + (hashId(id) % 7)) * (VARIANT_RATE[clip] ?? 1);
/** Idle variety from the library: about 9 s in every 37 s (per person, offset from Idle_Neutral) a person looks around
 *  or folds their arms. */
function idleVariant(id: string, t: number): { clip: string; w: number } | null {
  const h = hashId(id), ph = ((h >>> 7) % 991) / 991, cyc = t / 37 + ph, u = (cyc % 1) * 37;
  const w = u < 1.2 ? smooth(u / 1.2) : u < 9 ? 1 : u < 10.2 ? 1 - smooth((u - 9) / 1.2) : 0;
  return w > 0 ? { clip: IDLE_VARIANTS[(Math.floor(cyc) + h) % IDLE_VARIANTS.length], w } : null;
}
/** Library clip probe per template: holder-local hip mid, head and feet mid of a clip at a time (holder at the origin, yaw 0,
 *  facing +x), measured once on a private rig. */
const PROBES = new WeakMap<Template, { rig: Rig; at: Map<string, { hip: THREE.Vector3; head: THREE.Vector3; feet: THREE.Vector3; wristL: THREE.Vector3; wristR: THREE.Vector3 } | null> }>();
function clipProbe(t: Template, clip: string, time: number) {
  let p = PROBES.get(t);
  if (!p) { p = { rig: createRig(t), at: new Map() }; PROBES.set(t, p); }
  const key = clip + '@' + time.toFixed(2);
  if (p.at.has(key)) return p.at.get(key)!;
  const { rig } = p, act = libAction(rig, clip);
  let out: { hip: THREE.Vector3; head: THREE.Vector3; feet: THREE.Vector3; wristL: THREE.Vector3; wristR: THREE.Vector3 } | null = null;
  if (act) {
    rig.mixer.stopAllAction(); act.play(); act.time = time; act.setEffectiveWeight(1); rig.mixer.update(0);
    rig.holder.position.set(0, 0, 0); rig.holder.rotation.set(0, 0, 0); rig.holder.updateMatrixWorld(true);
    const w = (n: string) => rig.model.getObjectByName(n)?.getWorldPosition(V());
    const l = w('UpperLegL'), r = w('UpperLegR'), head = w('Head'), fl = w('FootL'), fr = w('FootR'), wl = w('WristL'), wr = w('WristR');
    if (l && r && head && fl && fr && wl && wr) out = { hip: l.add(r).multiplyScalar(0.5), head, feet: fl.add(fr).multiplyScalar(0.5), wristL: wl, wristR: wr };
    act.stop();
  }
  p.at.set(key, out);
  return out;
}
function lerpHands(a: Hands, b: Hands, t: number): Hands {
  const one = (p?: Vec3, q?: Vec3): Vec3 | undefined => (q ? (p ? [lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)] : q) : undefined);
  return { left: one(a.left, b.left), right: one(a.right, b.right) };
}

const V = () => new THREE.Vector3();
/** Soul Actions entry 38: the poster in a Soul's hands, from the recorded hand-actuator timeline (posterLocal) and the drawn
 *  palms. Putting up: a roll held between the palms is raised to the slot, its top edge pressed to the wall, and the sheet
 *  unrolls downward under the sliding palms; tape goes on the bottom corners, then the top. Taking down: the tape comes off,
 *  the sheet rolls up from the top under the palms and the roll is lifted away. The flat part is the same bent sheet the
 *  wall draws (poster-sheet.ts), 1.5 mm proud of it, so the handoff at the commit is invisible. */
const _sheetM = new THREE.Matrix4(), _sheetQ = new THREE.Quaternion(), _rollAxis = new THREE.Vector3(), _rollY = new THREE.Vector3(0, 1, 0);
function heldSheet(v: View, h: THREE.Object3D, tSec: number) {
  const m = v.handActuator, s = m?.stroke;
  if (!m || !s || !twoHanded(s) || !s.sheet || !v.arms.length) { if (v.sheet) { h.remove(v.sheet.group); v.sheet.flat.geometry.dispose(); v.sheet = undefined; } return; }
  const key = `${m.startTick}:${m.target}:${s.kind}`, el = (v.handActuatorTime ?? tSec) - m.startTick * DT, u = (el - HAND_REACH_SECONDS) / s.seconds, W = s.width, H = s.height, age = s.sheet.age ?? 0;
  if (!v.sheet || v.sheet.key !== key) {
    if (v.sheet) { h.remove(v.sheet.group); v.sheet.flat.geometry.dispose(); }
    const group = new THREE.Group(); group.name = 'held poster'; group.matrixAutoUpdate = false;
    const map = posterTexture(s.sheet.title, s.sheet.detail, s.sheet.name ?? '', s.sheet.paper, age);
    const flat = new THREE.Mesh(sheetGeometry(W, H, 1, age), new THREE.MeshStandardMaterial({ map: map ?? undefined, color: map ? '#ffffff' : PAPERS[s.sheet.paper % PAPERS.length].paper, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }));
    const wall = new THREE.Group(); wall.name = 'held poster wall frame'; wall.add(flat);
    const tapes = tapeStrips(W, H, s.sheet.title + (s.sheet.name ?? '')); for (const t of tapes) wall.add(t);
    const roll = rollMesh(s.sheet.paper); roll.matrixAutoUpdate = false;
    group.add(wall, roll); h.add(group); v.sheet = { key, group, flat, roll, tapes };
  }
  const sh = v.sheet, wall = sh.group.children[0] as THREE.Group;
  // the wall frame: at the slot centre, turned to the wall (engine yaw is Three's rotation.y), 1.5 mm proud of the wall poster
  _sheetM.makeRotationY(s.yaw).setPosition(m.at[0], m.at[1], m.at[2]); _sheetM.multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.0015));
  sh.group.matrix.copy(_inv.copy(h.matrixWorld).invert()).multiply(_sheetM); sh.group.matrixWorldNeedsUpdate = true;
  const local = posterLocal(s, Math.max(0, Math.min(1, u)), m.at);
  const w = strokeWork(s, u);   // the work's own progress (negative while the lead brings the hands up to the chest)
  const yH = local.y;   // the palms' height on the sheet (face-local)
  // how much of the sheet lies flat on the wall: [from, to] in v (0 = bottom edge, 1 = top edge)
  let from = 1, to = 1, rolled = 1;
  if (s.kind === 'poster') {
    if (w >= .45) { from = 0; rolled = 0; } else if (w > .09) { from = Math.max(0, Math.min(1, (yH - .006 + H / 2) / H)); rolled = from; } else { from = 1; rolled = 1; }
  } else {
    if (w < .15) { from = 0; to = 1; rolled = 0; } else if (w < .55) { from = 0; to = Math.max(0, Math.min(1, (yH + .006 + H / 2) / H)); rolled = 1 - to; } else { from = 0; to = 0; rolled = 1; }
  }
  const flatOn = to - from > .002;
  sh.flat.visible = flatOn; if (flatOn) sheetGeometryRange(sh.flat.geometry as THREE.BufferGeometry, W, H, from, to, age);
  // tape: putting up, bottom corners at u .50, top at .83 (the presses in posterLocal); taking down, top comes off at .12, bottom at .55
  const tapeOn = (i: number) => s.kind === 'poster' ? (i >= 2 ? w >= .5 : w >= .83) : (i >= 2 ? w < .55 : w < .12);
  sh.tapes.forEach((t, i) => { t.visible = tapeOn(i) && !(i === 3 && age >= 1.8); });
  // the roll: between the drawn palms, a paper tube as long as the sheet is wide; its radius follows how much is rolled
  const L = palmSide(v, 'left'), R = palmSide(v, 'right');
  const showRoll = rolled > .01 && !!L && !!R;
  if (!showRoll) { sh.roll.visible = false; return; }
  const f = handActuatorFrame(m, el), releaseAt = HAND_REACH_SECONDS + s.seconds;
  // appearing in the hands as they rise (putting up) and put away as they lower (taking down)
  const grow = s.kind === 'poster' ? smooth(clamp01(el / .35)) : 1 - smooth(clamp01((el - releaseAt - (s.release ?? HAND_RELEASE_SECONDS) * .35) / ((s.release ?? HAND_RELEASE_SECONDS) * .65)));
  if (grow <= .01 || (s.kind === 'poster' && f.weight <= 1e-3 && el > HAND_REACH_SECONDS)) { sh.roll.visible = false; return; }
  const r = (.006 + .022 * Math.sqrt(rolled)) * grow, len = W * grow;
  const mid = V().addVectors(L!, R!).multiplyScalar(.5);
  // the tube sits between the palms, toward the wall (the palms hold its ends from the room side)
  const out = V().set(Math.sin(s.yaw), 0, Math.cos(s.yaw)); mid.addScaledVector(out, -Math.min(.012, r * .4));
  _rollAxis.subVectors(R!, L!); if (_rollAxis.lengthSq() < 1e-6) _rollAxis.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw)); _rollAxis.normalize();
  _sheetQ.setFromUnitVectors(_rollY, _rollAxis);
  const world = new THREE.Matrix4().compose(mid, _sheetQ, V().set(r, len, r));
  sh.roll.matrix.copy(_inv.copy(sh.group.matrixWorld.copy(h.matrixWorld).multiply(sh.group.matrix)).invert()).multiply(world); sh.roll.matrixWorldNeedsUpdate = true; sh.roll.visible = true;
  void wall;
}
function palmSide(v: View, side: 'left' | 'right') { const i = v.arms.findIndex((_, k) => armSide(v, k) === side); return i >= 0 ? palm(v.arms[i], V()) : null; }
/** sheetGeometry over a v range [from, to] (taking down rolls from the top, so the flat part is the bottom). */
function sheetGeometryRange(g: THREE.BufferGeometry, w: number, h: number, from: number, to: number, age: number) {
  sheetGeometry(w, h, from, age, g);
  if (to >= 1) return;
  const pos = g.getAttribute('position') as THREE.BufferAttribute, uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) { const v0 = uv.getY(k), v = from + (v0 - from) / Math.max(1e-6, 1 - from) * (to - from), y = (v - .5) * h, x = pos.getX(k); uv.setY(k, v); pos.setXYZ(k, x, y, sheetLiftAt(x, y, w, h, age)); }
  pos.needsUpdate = true; uv.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
}
const _s = V(), _fwd = V(), _right = V(), _ax = V(), _hip = V(), _knee = V(), _tmp = V(), _c = V();
const _goals: THREE.Vector3[] = [V(), V()];
const _qh = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _qt = new THREE.Quaternion();

/** 'left' / 'right' for arm i, from where its shoulder sits (measured, not from bone names). */
function armSide(v: View, i: number): 'left' | 'right' {
  return v.arms[i].side > 0 ? 'left' : 'right';
}

/**
 * Rig measurements in the person's frame from the Idle clip at t = 0, holder at the origin facing
 * +x (right = +z): hip / pivot / ankle heights, leg and arm lengths, shoulder position, ankle in the
 * shin frame, rest foot rotation. Arms / legs are re-labelled left / right from where they are.
 */
function measure(v: View) {
  const { rig, legs, arms, spine } = v;
  if (legs.length < 2 || !arms.length || !spine) return;
  const h = rig.holder;
  const p0 = h.position.clone(), r0 = h.rotation.y;
  h.position.set(0, 0, 0);
  h.rotation.y = 0;
  rig.walk.setEffectiveWeight(0);
  rig.idle.setEffectiveWeight(1);
  rig.idle.time = 0;
  rig.mixer.update(0);
  h.updateMatrixWorld(true);
  const w = (o: THREE.Object3D) => o.getWorldPosition(V());
  const hips = legs.map((l) => w(l.upper)), knees = legs.map((l) => w(l.lower)), feet = legs.map((l) => w(l.foot));
  for (const [i, l] of legs.entries()) l.side = feet[i].z > 0 ? -1 : 1; // + = left (right is +z here)
  for (const a of arms) a.side = w(a.upper).z > 0 ? -1 : 1;
  const hipH = (hips[0].y + hips[1].y) / 2;
  const ankleH = (feet[0].y + feet[1].y) / 2;
  const thigh = (hips[0].distanceTo(knees[0]) + hips[1].distanceTo(knees[1])) / 2, shin = (knees[0].distanceTo(feet[0]) + knees[1].distanceTo(feet[1])) / 2;
  const legLen = thigh + shin;
  const pivot = w(spine.hips ?? spine.body);
  const sh = arms.map((a) => w(a.upper));
  const shMid = sh.reduce((s, q) => s.add(q), V()).multiplyScalar(1 / sh.length);
  const joints = [pivot, w(spine.abdomen), w(spine.torso), shMid];
  const hipMid = hips[0].clone().add(hips[1]).multiplyScalar(0.5);
  const limbSides = new Map<THREE.Object3D, number>();
  for (const limb of legs) for (const bone of [limb.upper, limb.lower, limb.foot]) limbSides.set(bone, limb.side);
  for (const limb of arms) for (const bone of [limb.upper, limb.lower, limb.hand, ...limb.fingers, ...limb.thumb]) limbSides.set(bone, limb.side);
  const shape = standingShape(rig,limbSides,()=>frontDepths(rig, hipMid.x, shMid.x, shMid.y, feet[legs[0].side > 0 ? 0 : 1], legs.flatMap((_, i) => [[hips[i], knees[i]], [knees[i], feet[i]]] as [THREE.Vector3, THREE.Vector3][])));
  const front=shape.front;
  v.dims = {
    hipH,
    pivotH: pivot.y,
    ankleH,
    legLen,
    thigh,
    shin,
    sh: { f: shMid.x - pivot.x, up: shMid.y - pivot.y },
    chain: joints.slice(1).map((q, i) => ({ f: q.x - joints[i].x, up: q.y - joints[i].y })),
    shHalf: sh.length > 1 ? Math.abs(sh[0].z - sh[1].z) / 2 : 0.19,
    armLen: armLen(arms[0]),
    pivotF: pivot.x - hipMid.x,
    pivotUp: pivot.y - hipH,
    lieHip: front.body,
    chestDepth: front.chest,
    foot: front.foot,
  };
  v.ankle = legs.map((l) => ankleLocal(l));
  v.footRest = legs.map((l) => l.foot.getWorldQuaternion(new THREE.Quaternion()));
  v.footLat = feet.map((f) => f.z);
  v.surf = shape.surf;
  v.stairShoes=stairShoeRefs(rig,v.legs);
  v.stairContact=measureStairRigContact(rig,v.legs,v.stairShoes,legLen);
  h.position.copy(p0);
  h.rotation.y = r0;
  h.updateMatrixWorld(true);
}

/** Body part of a skinned vertex, by the bone that weighs most on it (rig bone names, rig.ts). */
export type BodyPart = 'torso' | 'head' | 'arm' | 'hand' | 'leg' | 'foot';
function partOf(bone: string): BodyPart {
  if (/^(Wrist|Thumb|Index|Middle|Ring|Pinky)/.test(bone)) return 'hand';
  if (/^(Shoulder|UpperArm|LowerArm)/.test(bone)) return 'arm';
  if (/^(Neck|Head)/.test(bone)) return 'head';
  if (/^(UpperLeg|LowerLeg)/.test(bone)) return 'leg';
  if (/^(Foot|Toe)/.test(bone)) return 'foot';
  return 'torso';
}

/** Skinned vertices of a rig in world space (every `stride`-th), each with its body part. */
function skinnedPoints(rig: Rig, stride: number, out: (p: THREE.Vector3, part: BodyPart) => void) {
  rig.holder.updateMatrixWorld(true);
  const p = V(), idx = new THREE.Vector4(), wt = new THREE.Vector4();
  rig.model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.geometry.attributes.skinIndex || m.userData[BODY_DRAW]) return;
    const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex as THREE.BufferAttribute, sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute;
    const indices=Array.from({length:Math.ceil(pos.count/stride)},(_,i)=>i*stride);let at=0;
    eachSkinnedWorld([{mesh:m,idx:indices}],p,p=>{
      const i=indices[at++];
      idx.fromBufferAttribute(si, i);
      wt.fromBufferAttribute(sw, i);
      let k = 0;
      for (let j = 1; j < 4; j++) if (wt.getComponent(j) > wt.getComponent(k)) k = j;
      out(p, partOf(m.skeleton.bones[idx.getComponent(k)]?.name ?? ''));
    });
  });
}

/** Skinned vertices of a mesh (indices). */
type VertexRefs = { mesh: THREE.SkinnedMesh; idx: number[] }[];

type StoredRefs={mesh:number;idx:number[]}[];
type ShapeStamp={geometry:THREE.BufferGeometry;attributes:(THREE.BufferAttribute|THREE.InterleavedBufferAttribute)[];versions:number[]};
type StandingShape={stamps:ShapeStamp[];front:ReturnType<typeof frontDepths>;body:StoredRefs;leg:Map<number,StoredRefs>;foot:Map<number,StoredRefs>;hand:Map<number,StoredRefs>};
const standingShapes=new WeakMap<Template,StandingShape>();
/** The same immutable template in Idle0 has the same surface measurements for every actor. Cache numbers and vertex
 * indices only: mesh references are rebound to this actor, never retained from the actor that first measured them.
 * Attribute replacement/version changes invalidate the cache (kit shape edits and geometry updates). */
function standingShape(rig:Rig,limbSides:ReadonlyMap<THREE.Object3D,number>,measureFront:()=>ReturnType<typeof frontDepths>){
 const meshes:THREE.SkinnedMesh[]=[];
 rig.model.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh&&!o.userData[BODY_DRAW])meshes.push(o as THREE.SkinnedMesh);});
 const attributes=(m:THREE.SkinnedMesh)=>[...Object.values(m.geometry.attributes),...Object.values(m.geometry.morphAttributes).flat()];
 const version=(a:THREE.BufferAttribute|THREE.InterleavedBufferAttribute)=>'version'in a?a.version:a.data.version;
 const old=standingShapes.get(rig.template);
 const matches=old&&old.stamps.length===meshes.length&&old.stamps.every((s,i)=>{
  const a=attributes(meshes[i]);
  return s.geometry===meshes[i].geometry&&s.attributes.length===a.length&&a.every((v,k)=>v===s.attributes[k]&&version(v)===s.versions[k]);
 });
 if(old&&matches){
  const bind=(refs:StoredRefs):VertexRefs=>refs.map(r=>({mesh:meshes[r.mesh],idx:r.idx.slice()}));
  return{
   front:{...old.front,foot:old.front.foot.map(p=>[...p] as [number,number])},
   surf:{body:bind(old.body),leg:new Map([...old.leg].map(([side,r])=>[side,bind(r)])),foot:new Map([...old.foot].map(([side,r])=>[side,bind(r)])),hand:new Map([...old.hand].map(([side,r])=>[side,bind(r)]))},
  };
 }
 const front=measureFront(),surf=surfaceRefs(rig,limbSides),save=(refs:VertexRefs):StoredRefs=>refs.map(r=>({mesh:meshes.indexOf(r.mesh),idx:r.idx.slice()}));
 standingShapes.set(rig.template,{
  stamps:meshes.map(m=>{const a=attributes(m);return{geometry:m.geometry,attributes:a,versions:a.map(version)};}),
  front:{...front,foot:front.foot.map(p=>[...p] as [number,number])},
  body:save(surf.body),leg:new Map([...surf.leg].map(([side,r])=>[side,save(r)])),foot:new Map([...surf.foot].map(([side,r])=>[side,save(r)])),hand:new Map([...surf.hand].map(([side,r])=>[side,save(r)])),
 });
 return{front,surf};
}

/** Foot and hand vertices of a rig, per side (+1 = the person's left: z < 0 with the holder at the origin facing +x). */
function surfaceRefs(rig: Rig, limbSides: ReadonlyMap<THREE.Object3D, number>) {
  const out: { leg: Map<number, VertexRefs>; foot: Map<number, VertexRefs>; hand: Map<number, VertexRefs>; body: VertexRefs } = { leg:new Map(), foot: new Map(), hand: new Map(), body: [] };
  const p = V(), idx = new THREE.Vector4(), wt = new THREE.Vector4();
  rig.holder.updateMatrixWorld(true);
  rig.model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.geometry.attributes.skinIndex || m.userData[BODY_DRAW]) return;
    const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex as THREE.BufferAttribute, sw = m.geometry.attributes.skinWeight as THREE.BufferAttribute;
    const contacts:{i:number;part:'foot'|'hand'|'leg';side?:number}[]=[];
    for (let i = 0; i < pos.count; i++) {
      idx.fromBufferAttribute(si, i);
      wt.fromBufferAttribute(sw, i);
      let k = 0;
      for (let j = 1; j < 4; j++) if (wt.getComponent(j) > wt.getComponent(k)) k = j;
      const bone = m.skeleton.bones[idx.getComponent(k)], part = partOf(bone?.name ?? '');
      // a sample of the torso, hips and head: what a body lying on the ground rests on
      if ((part === 'torso' || part === 'head') && i % 3 === 0) { let r = out.body.find((q) => q.mesh === m); if (!r) out.body.push((r = { mesh: m, idx: [] })); r.idx.push(i); }
      if (part !== 'foot' && part !== 'hand' && part !== 'leg') continue;
      // A crossed idle stance can put one foot's vertices across the body midline.
      // Support follows the owning limb, including toes/fingers under its bones.
      let owner: THREE.Object3D | null = bone ?? null;
      while (owner && !limbSides.has(owner)) owner = owner.parent;
      contacts.push({i,part,side:owner ? limbSides.get(owner) : undefined});
    }
    let at=0;eachSkinnedWorld([{mesh:m,idx:contacts.map(c=>c.i)}],p,p=>{
      const {i,part,side:ownedSide}=contacts[at++];
      const side = ownedSide ?? (p.z < 0 ? 1 : -1), map = out[part];
      const refs = map.get(side) ?? [];
      let r = refs.find((q) => q.mesh === m);
      if (!r) refs.push((r = { mesh: m, idx: [] }));
      r.idx.push(i);
      map.set(side, refs);
    });
  });
  return out;
}

/** PERF-PASSES: the lift that rests a lying body's back and head just on the ground: the largest (ground + 0.012 − y)
 *  over its sampled torso / head vertices (~1,000 a body). Every 8th pose, and whenever the layout or the floor rule
 *  changes (moved 5 cm, turned 0.01 rad), every sample is skinned and the REST_KEEP lowest relative to the ground are kept; the poses between read only
 *  those (in 8 frames breathing moves a back by well under a millimetre, so the lowest sample stays among them). */
const REST_KEEP = 48, REST_FULL_EVERY = 8;
export function restNeed(v: View, layout: string, bench: number, floor: number): number {
  const h = v.rig.holder, key = `${layout}|${bench}|${Math.round(h.position.x * 20)}|${Math.round(h.position.z * 20)}|${Math.round(h.rotation.y * 100)}`, c = v.restCache, under = (x: number, z: number) => (bench ? floor : groundUnder(x, z, floor)) + 0.012;
  let need = -Infinity;
  if (c && c.key === key && ++c.n < REST_FULL_EVERY) { eachSkinnedWorld(c.refs, _vp, (p) => { need = Math.max(need, under(p.x, p.z) - p.y); }); return need; }
  const scored: { mesh: THREE.SkinnedMesh; i: number; n: number }[] = [];
  for (const r of v.surf.body ?? []) { let k = 0; eachSkinnedWorld([r], _vp, (p) => { const n = under(p.x, p.z) - p.y; scored.push({ mesh: r.mesh, i: r.idx[k++], n }); if (n > need) need = n; }); }
  scored.sort((a, b) => b.n - a.n);
  const refs: VertexRefs = [];
  for (const s of scored.slice(0, REST_KEEP)) { let r = refs.find((q) => q.mesh === s.mesh); if (!r) refs.push((r = { mesh: s.mesh, idx: [] })); r.idx.push(s.i); }
  v.restCache = { key, n: 0, refs };
  return need;
}
/** Lowest point (world y) of these vertices as rendered now (bone world matrices up to date). */
function lowestY(refs: VertexRefs | undefined) {
  let low = Infinity;
  eachSkinnedWorld(refs, _vp, (p) => { low = Math.min(low, p.y); });
  return low;
}
const _vp = new THREE.Vector3();
/** PERF-PASSES: each vertex's world position as rendered now, exactly `mesh.getVertexPosition(i, out).applyMatrix4(mesh.matrixWorld)`
 *  (three 0.186's SkinnedMesh.applyBoneTransform, the same operations in the same order), but each bone's skinning
 *  matrix (bone.matrixWorld × boneInverse) is formed once per call instead of once per vertex influence: a lying body
 *  rests on ~1,000 sampled torso / head vertices every pose (Eden 2026: most of humans.render while orbiting). */
const _skinM: THREE.Matrix4[] = [], _skinB = new THREE.Vector4(), _skinT = new THREE.Vector4(), _skinI = new THREE.Vector4(), _skinW = new THREE.Vector4();
let _skinMark = new Uint32Array(0), _skinGen = 0;
export function eachSkinnedWorld(refs: VertexRefs | undefined, out: THREE.Vector3, each: (p: THREE.Vector3) => void) {
  eachSkinned(refs,out,each,true);
}
function eachSkinned(refs: VertexRefs | undefined, out: THREE.Vector3, each: (p: THREE.Vector3) => void, world:boolean) {
  for (const r of refs ?? []) {
    const m = r.mesh as THREE.SkinnedMesh, g = m.geometry;
    if (!m.isSkinnedMesh || (g.morphAttributes.position && m.morphTargetInfluences) || !g.attributes.skinIndex) { for (const i of r.idx) {m.getVertexPosition(i,out);if(world)out.applyMatrix4(m.matrixWorld);each(out);} continue; }
    const bones = m.skeleton.bones, inverses = m.skeleton.boneInverses, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (_skinMark.length < bones.length) _skinMark = new Uint32Array(bones.length * 2);
    while (_skinM.length < bones.length) _skinM.push(new THREE.Matrix4());
    if (++_skinGen === 0xffffffff) { _skinMark.fill(0); _skinGen = 1; }
    for (const i of r.idx) {
      out.fromBufferAttribute(pos, i);
      _skinI.fromBufferAttribute(si as THREE.BufferAttribute, i); _skinW.fromBufferAttribute(sw as THREE.BufferAttribute, i);
      _skinB.set(out.x, out.y, out.z, 1).applyMatrix4(m.bindMatrix);
      out.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = _skinW.getComponent(k); if (w === 0) continue;
        const b = _skinI.getComponent(k), mat = _skinM[b];
        if (_skinMark[b] !== _skinGen) { mat.multiplyMatrices(bones[b].matrixWorld, inverses[b]); _skinMark[b] = _skinGen; }
        out.addScaledVector(_skinT.copy(_skinB).applyMatrix4(mat), w);
      }
      out.applyMatrix4(m.bindMatrixInverse);if(world)out.applyMatrix4(m.matrixWorld);each(out);
    }
  }
}

/** Three computes this on the first draw even for a body with frustum culling off (opaque depth sorting). The same
 * vertex order and Sphere.expandByPoint keep its result exact; only repeated bone-matrix multiplication is removed. */
export function computeBodySphere(this:THREE.SkinnedMesh){
 const sphere=this.boundingSphere??(this.boundingSphere=new THREE.Sphere());sphere.makeEmpty();
 const idx=Array.from({length:this.geometry.attributes.position.count},(_,i)=>i);
 eachSkinned([{mesh:this,idx}],new THREE.Vector3(),p=>sphere.expandByPoint(p),false);
}

/**
 * Front depths of the body in the Idle pose (holder at the origin facing +x): `body` = how far the front of the
 * torso is ahead of the hip joints, or a leg's surface (above the shoes) from its bones, whichever is more (lying on
 * the stomach with the pelvis pitched 90° and the legs straight, the hip joints are this high above the floor);
 * `chest` = how far the front of the chest (torso vertices within 0.25 m below the shoulders) is ahead of the shoulder
 * joints (lying flat, the shoulder joints this high); `foot` = a sample of the foot's surface about its ankle.
 */
function frontDepths(rig: Rig, hipX: number, shX: number, shY: number, ankle: THREE.Vector3, legBones: [THREE.Vector3, THREE.Vector3][]) {
  const seg = new THREE.Line3(), q = V();
  let body = 0, chest = 0;
  const foot: [number, number][] = [];
  skinnedPoints(rig, 1, (p, part) => {
    if (part === 'foot' && p.z * ankle.z > 0) foot.push([+(p.x - ankle.x).toFixed(4), +(p.y - ankle.y).toFixed(4)]);
    if (part === 'torso') body = Math.max(body, p.x - hipX);
    // a leg lies straight: its front is its radius about the bone (the Idle clip stands with a knee forward)
    if (part === 'leg' && p.y > 0.2) body = Math.max(body, Math.min(...legBones.map(([a, b]) => seg.set(a, b).closestPointToPoint(p, true, q).distanceTo(p))));
    if (part === 'torso' && p.y < shY + 0.02 && p.y > shY - 0.25) chest = Math.max(chest, p.x - shX);
  });
  return { body: body + 0.005, chest, foot: foot.filter((_, i) => i % 3 === 0) };
}

/** Bend the upper body forward by `bend` rad at the hips (60 %), abdomen (20 %) and torso (20 %). */
function bendTorso(sp: Spine, bend: number) {
  _ax.crossVectors(UP, _fwd).normalize(); // rotating up about up×fwd tips it forward
  const [a, b, c] = BEND_SHARE;
  if (sp.hips) turn(sp.hips, _ax, bend * a);
  turn(sp.abdomen, _ax, bend * (sp.hips ? b - a : b));
  turn(sp.torso, _ax, bend * (c - b));
}

/** Evaluate the recorded prior water pose before blending to this frame's target. */
function applyWaterPose(v:View,motion:WaterMotion){
 if(motion.kind==='surface-swim')surfaceSwimBody(v,motion);if(motion.floating)waterLegs(v,motion);
 const targets=v.arms.map((arm,i)=>{const q=motion.hands[armSide(v,i)==='left'?0:1];return V().copy(v.rig.holder.position).addScaledVector(_fwd,q[0]).addScaledVector(_right,q[1]).addScaledVector(UP,q[2]);});reachTo(v,targets,false);closeHands(v,targets.map(()=>0));
}

/** Cosmetic surface swim: turn the rig around its own hips and keep those
 * hips just below the recorded datum. Holder/root/contact remain untouched;
 * this is no horizontal capsule, collision or support authority. */
function surfaceSwimBody(v:View,motion:WaterMotion){
 if(!v.spine||v.legs.length<2||!v.dims)return;
 const sp=v.spine,h=v.rig.holder;
 _ax.crossVectors(UP,_fwd).normalize();
 turn(sp.body,_ax,motion.bodyPitch);
 h.updateMatrixWorld(true);
 const hipMid=v.legs.reduce((sum,l)=>sum.add(l.upper.getWorldPosition(V())),V()).multiplyScalar(1/v.legs.length);
 const goal=h.position.clone().addScaledVector(UP,motion.hipUp);
 place(sp.body,sp.body.getWorldPosition(V()).add(goal).sub(hipMid));
 if(sp.head)turn(sp.head,_ax,-motion.bodyPitch*.55);
 h.updateMatrixWorld(true);
}

/** Buoyant kicks solve baked foot targets. Surface strokes extend the legs behind
 * the rotated hips; treading retains the upright clip. Native root stays fixed. */
function waterLegs(v:View,motion:WaterMotion){
 if(v.legs.length<2||!v.dims)return;
 const goals=v.legs.map((l,i)=>{
  const kick=motion.feet[l.side>0?0:1];
  if(motion.kind==='surface-swim'){
   const hip=l.upper.getWorldPosition(V());
   const length=hip.distanceTo(l.lower.getWorldPosition(V()))+l.lower.getWorldPosition(V()).distanceTo(l.lower.localToWorld(v.ankle[i].clone()));
   return {p:hip.addScaledVector(_fwd,-length*.965*Math.sin(motion.bodyPitch)+kick[0]).addScaledVector(_right,kick[1]).addScaledVector(UP,-length*.965*Math.cos(motion.bodyPitch)+kick[2]),q:footPitch(v,i,-Math.PI/2-motion.bodyPitch)};
  }
  return {p:l.foot.getWorldPosition(V()).addScaledVector(_fwd,kick[0]).addScaledVector(_right,kick[1]).addScaledVector(UP,kick[2]),q:l.foot.getWorldQuaternion(new THREE.Quaternion())};
 });
 v.legs.forEach((l,i)=>{
  legTo(l,v.ankle[i],goals[i].p,motion.kind==='surface-swim'?V().copy(UP).negate().addScaledVector(_right,-l.side*.05):V().copy(_fwd).addScaledVector(UP,.2).addScaledVector(_right,-l.side*.15),motion.kind==='surface-swim'?.995:.97,goals[i].q);
  if(motion.kind==='surface-swim'){
   // The original three rigs' forefoot is bone-local +Y. Idle feet can toe out:
   // calibrate the pointed foot to its actual solved shin, not the Idle heading.
   const q=l.foot.getWorldQuaternion(new THREE.Quaternion()),toe=V().set(0,1,0).applyQuaternion(q),shin=l.foot.getWorldPosition(V()).sub(l.lower.getWorldPosition(V())).normalize();
   setWorldQuat(l.foot,new THREE.Quaternion().setFromUnitVectors(toe,shin).multiply(q));
  }
 });
}

/** Planted groove: solve both legs back to the clip's original world ankle
 * pose after moving/twisting the pelvis. No foot lift, root displacement or new
 * support. Existing hand IK runs afterward against unchanged recorded targets. */
/** Standing cycles: feet apart (each side) under a hopping pelvis; the feet keep their rest orientation. */
const _inv = new THREE.Matrix4();
/** Lying on the back: each leg nearly straight from its hip along the body, a hand's width apart, the knee toward
 * the sky, the heel resting on the ground at `floor` (the foot keeps its clip angle, so the toes point up). */
/** The ground a body lying along heading (c, s) from its hips at (x, z) rests on: the highest of the ground under
 * its head, back, hips and knees (so nothing sinks on a slope), never below the engine's own height. */
const _tilt = new THREE.Quaternion(), _axis = new THREE.Vector3();
/** The ground a body lying along heading (c, s) from its hips at (x, z) rests on: a straight-line fit of the visual
 * ground under its head, back, hips and knees — height at the hips (never below the engine's own) and rise per metre
 * along the heading (0 on flat ground or without a ground sampler). */
function lyingFloor(y: number, x: number, z: number, c: number, s: number) {
  const humanGround = humanGroundSampler();
  if (!humanGround) return { y, k: 0 };
  const pts: [number, number][] = [];
  for (const d of [-1.45, -0.9, -0.4, 0, 0.5]) { const g = humanGround(x + c * d, z + s * d); if (g !== null && Number.isFinite(g) && Math.abs(g - y) < 0.8) pts.push([d, g]); }
  if (pts.length < 2) return { y, k: 0 };
  const md = pts.reduce((a, p) => a + p[0], 0) / pts.length, mg = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let num = 0, den = 0; for (const [d, g] of pts) { num += (d - md) * (g - mg); den += (d - md) * (d - md); }
  const k = Math.max(-0.45, Math.min(0.45, den > 0 ? num / den : 0));
  return { y: Math.max(y, mg - k * md), k: Math.abs(k) < 0.01 ? 0 : k };
}
/** Ground under a point (the viewer's visual ground where known, else the given floor). */
const groundUnder = (x: number, z: number, floor: number) => { const g = humanGroundSampler()?.(x, z); return g !== null && g !== undefined && Number.isFinite(g) && Math.abs(g - floor) < 0.8 ? g : floor; };
/** Lift (or lower) a body lying on its back so its torso / head rests just on the ground under each part of it. */
function restOnGround(v: View, h: THREE.Object3D, floor: number, bench = 0) {
  h.updateMatrixWorld(true);
  let need = -Infinity;
  need = restNeed(v, 'back', bench, floor);
  if (!Number.isFinite(need) || Math.abs(need) < 0.003) return;
  h.position.y += need; h.updateMatrixWorld(true);
}

function lyingLegs(v: View, floor: number, bench = 0) {
  const hips = v.legs.map((l) => l.upper.getWorldPosition(V()));
  const mid = hips[0].clone().add(hips[1]).multiplyScalar(0.5);
  // along the body, from the head end to the hips (the clip's feet lie that way)
  const feet = v.legs.map((l) => l.foot.getWorldPosition(V()));
  const down = feet[0].clone().add(feet[1]).multiplyScalar(0.5).sub(mid).setY(0);
  if (down.lengthSq() < 1e-6) return;
  down.normalize();
  const across = V().crossVectors(UP, down).normalize();
  v.legs.forEach((l, i) => {
    const knee = l.lower.getWorldPosition(V()), len = hips[i].distanceTo(knee) + knee.distanceTo(feet[i]);
    const q = l.foot.getWorldQuaternion(new THREE.Quaternion());
    const side = Math.sign(V().subVectors(hips[i], mid).dot(across)) || (i ? -1 : 1);
    // on a bench: knees bent over its end, feet planted on the ground either side; on the ground: legs out long
    const goal = bench > 0 ? hips[i].clone().addScaledVector(down, len * 0.55).addScaledVector(across, side * 0.24).setY(floor - bench + 0.1)
      : hips[i].clone().addScaledVector(down, len * 0.96).addScaledVector(across, side * 0.06);
    if (!bench) goal.setY(groundUnder(goal.x, goal.z, floor) + 0.1);
    legTo(l, v.ankle[i], goal, V().copy(UP).addScaledVector(across, side * 0.25), 0.999, q);
    l.foot.updateMatrixWorld(true);
    // rest the heel on the ground: lift (or lower) by the shoe's lowest point
    const low = lowestY(v.surf.foot.get(l.side));
    const sole = bench > 0 ? floor - bench : groundUnder(goal.x, goal.z, floor);
    if (Number.isFinite(low) && Math.abs(low - (sole + 0.01)) > 0.005) legTo(l, v.ankle[i], goal.setY(goal.y + sole + 0.01 - low), V().copy(UP).addScaledVector(across, side * 0.25), 0.999, q);
  });
}

/** A free plank owns both legs; the idle clip's asymmetric stride is not a planted stance. Solve each leg from
 * its own hip to its measured rest lateral position, then fit its actual skinned shoe to support. No native root
 * is moved, and this layer never runs for held/native hand targets, seats, locomotion or airborne activities. */
function frontLegs(v: View, h: THREE.Object3D, floor: number, weight: number) {
  if (!v.dims) return;
  const yaw = h.rotation.y, q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  v.legs.forEach((leg, i) => {
    const goal = new THREE.Vector3(0, 0, v.footLat[i]).applyQuaternion(q).add(h.position);
    goal.y = groundUnder(goal.x, goal.z, floor) + v.dims!.ankleH;
    const original = leg.foot.getWorldPosition(V()), originalRotation = leg.foot.getWorldQuaternion(new THREE.Quaternion());
    goal.lerp(original, 1 - weight);
    const rotation = originalRotation.slerp(q.clone().multiply(v.footRest[i]), weight);
    for (let j = 0; j < 3; j++) {
      legTo(leg, v.ankle[i], goal, V().copy(UP).addScaledVector(_right, -leg.side * .15), .999, rotation);
      h.updateMatrixWorld(true);
      const low = lowestY(v.surf.foot.get(leg.side));
      if (!Number.isFinite(low)) break;
      const delta = groundUnder(goal.x, goal.z, floor) + .003 - low;
      if (Math.abs(delta) < .001) break;
      goal.y += delta > 0 ? delta : delta * weight;
    }
  });
}

/** Pose interpolation can dip an otherwise clear free limb. Correct only actual penetration after blending;
 * unweighted limbs above support stay unweighted. Native hands, props, seats and locomotion never enter here. */
function fitFreeGround(v: View, h: THREE.Object3D, floor: number) {
  for (let pass = 0; pass < 3; pass++) {
    h.updateMatrixWorld(true);
    const feet = v.legs.map(leg=>({p:leg.foot.getWorldPosition(V()),q:leg.foot.getWorldQuaternion(new THREE.Quaternion()),pole:leg.lower.getWorldPosition(V()).sub(leg.upper.getWorldPosition(V()))}));
    const legLow=Math.min(...v.legs.map(leg=>lowestY(v.surf.leg?.get(leg.side))));
    if(v.spine&&Number.isFinite(legLow)&&legLow<floor+.002){
      place(v.spine.body,v.spine.body.getWorldPosition(V()).addScaledVector(UP,floor+.002-legLow));
      h.updateMatrixWorld(true);
      v.legs.forEach((leg,i)=>legTo(leg,v.ankle[i],feet[i].p,feet[i].pole,.999,feet[i].q));
    }
    v.legs.forEach((leg, i) => {
      const at = leg.foot.getWorldPosition(V()), support = Math.max(floor, groundUnder(at.x, at.z, floor));
      const footLow = lowestY(v.surf.foot.get(leg.side)), legLow = lowestY(v.surf.leg?.get(leg.side));
      const low = Math.min(footLow, legLow);
      if (low >= support + .002 || !Number.isFinite(low)) return;
      const q = leg.foot.getWorldQuaternion(new THREE.Quaternion());
      const pole = leg.lower.getWorldPosition(V()).sub(leg.upper.getWorldPosition(V()));
      legTo(leg, v.ankle[i], at.setY(at.y + support + .002 - low), pole, .999, q);
    });
    h.updateMatrixWorld(true);
    v.arms.forEach(arm => {
      const at = palm(arm, V()), support = Math.max(floor, groundUnder(at.x, at.z, floor));
      const low = lowestY(v.surf.hand.get(arm.side));
      if (low >= support + .002 || !Number.isFinite(low)) return;
      const q = arm.hand.getWorldQuaternion(new THREE.Quaternion());
      const pole = arm.lower.getWorldPosition(V()).sub(arm.upper.getWorldPosition(V()));
      armTo(arm, at.setY(at.y + support + .002 - low), 1, BODY_MODEL.maxExtension, h, pole);
      setWorldQuat(arm.hand, q);
    });
  }
  h.updateMatrixWorld(true);
}

function activityLegs(v: View, out: number) {
  v.legs.forEach((leg, i) => {
    // the clip's planted foot moved out sideways; it rises with the hop (the whole body leaves the ground)
    const foot = leg.foot.getWorldPosition(V()).addScaledVector(_right, -leg.side * out), q = leg.foot.getWorldQuaternion(new THREE.Quaternion());
    legTo(leg, v.ankle[i], foot, V().copy(_fwd).addScaledVector(UP, .2).addScaledVector(_right, -leg.side * .3), .999, q);
  });
}
function expressionLegs(v:View,expression:Expression) {
  if(!v.spine||v.legs.length<2)return;
  const feet=v.legs.map(l=>({p:l.foot.getWorldPosition(V()),q:l.foot.getWorldQuaternion(new THREE.Quaternion())}));
  place(v.spine.body,v.spine.body.getWorldPosition(V()).addScaledVector(_right,expression.side).addScaledVector(UP,-expression.drop));
  turn(v.spine.body,UP,-expression.hipTwist);
  v.legs.forEach((leg,i)=>legTo(leg,v.ankle[i],feet[i].p,V().copy(_fwd).addScaledVector(UP,.2).addScaledVector(_right,-leg.side*.25),.999,feet[i].q));
}

/**
 * Posture legs: pelvis down by `drop` (and back to balance a standing hip bend, up by `rise`), feet stay
 * planted (leg IK, knees forward). Kneeling (`kneel` → 1): one knee on the floor straight under its hip
 * joint (the pelvis is at kneelDrop), that shin back along the floor with the toes tucked; the other
 * foot planted out to its side (KNEEL_SIDE) with that knee up — so a person kneeling on a beam keeps
 * both on the beam line. Which knee goes down is fixed per person (id hash).
 */
function postureLegs(v: View, pz: Posture) {
  const d = v.dims;
  if (!d || !v.spine || v.legs.length < 2) return;
  const feet = v.legs.map((l, i) => l.foot.getWorldPosition(_goals[i]).clone());
  const floor = v.rig.holder.position.y;
  // heel raise: ankles up by `rise` (toes stay down)
  const back = shoulderAt(d, pz).back;
  v.spine.body.getWorldPosition(_c);
  _c.addScaledVector(_fwd, -back);
  _c.y += pz.rise - pz.drop;
  place(v.spine.body, _c.clone());
  const pole = _tmp.copy(_fwd).addScaledVector(UP, 0.2).clone();
  const kn = smooth(pz.kneel), down = v.vary < 0.5 ? -1 : 1; // side of the kneeling leg (+1 = left)
  const centre = v.rig.holder.position;
  v.legs.forEach((l, i) => {
    const goal = feet[i];
    goal.y += pz.rise;
    let kp = pole.clone().addScaledVector(_right, -l.side * 0.25); // knees a little apart in a squat
    let q = pz.rise > 0 ? footPitch(v, i, -Math.asin(Math.min(0.9, pz.rise / 0.13))) : undefined;
    if (kn > 0) {
      l.upper.getWorldPosition(_hip);
      if (l.side === down) {
        // knee on the floor under the hip joint, a little forward; shin back along the floor, toes tucked
        const kf = 0.05, kneeY = _hip.y - Math.sqrt(Math.max(0, d.thigh * d.thigh - kf * kf));
        const ankleY = floor + 0.11, dy = kneeY - ankleY;
        const run = Math.sqrt(Math.max(0, d.shin * d.shin - dy * dy));
        const ankle = V().copy(_hip).addScaledVector(_fwd, kf - run);
        ankle.y = ankleY;
        goal.lerp(ankle, kn);
        kp = kp.lerp(V().copy(_fwd).addScaledVector(UP, -0.3), kn);
        q = footPitch(v, i, -1.1 * kn);
      } else {
        // up-knee: foot planted out to its side, a little forward; the knee points forward and out
        const spot = V().copy(centre).addScaledVector(_right, -l.side * KNEEL_SIDE).addScaledVector(_fwd, 0.12);
        spot.y = floor + d.ankleH;
        goal.lerp(spot, kn);
        kp = kp.lerp(V().copy(_fwd).addScaledVector(UP, 0.4).addScaledVector(_right, -l.side * 0.6), kn);
      }
    }
    legTo(l, v.ankle[i], goal, kp, 0.999, q);
  });
}

/** Foot pitch (rad about the right axis, − = toes down): pointed, the top of the foot on the deck — lying, and kneeling up from it. */
const LIE_FOOT = -2.6;
/** Ankle height that puts the lowest point of the foot, pitched by `pitch`, on the floor (the measured foot surface). */
function ankleFor(d: Dims, pitch: number) {
  const s = Math.sin(pitch), c = Math.cos(pitch);
  let low = 0;
  for (const [f, up] of d.foot) low = Math.min(low, f * s + up * c);
  return 0.003 - low;
}

/**
 * Prone body (prone.ts; the holder is at S, yawed to the prone yaw): pelvis pitched forward by the frame's pitch with
 * the hip joints on their point (lying on the deck / over the knees / standing), the spine bent to the torso pitch
 * (lying: the tip all at the Torso joint, just past the lip), legs by IK — knees on the deck, shins back along it,
 * feet pointed lying → toes tucked kneeling, then the clip's feet standing — along r.
 */
function proneBody(v: View, pr: ProneState) {
  const d = v.dims!, sp = v.spine!, h = v.rig.holder, floor = h.position.y;
  const fr = proneFrame(d, pr.r, pr.bend, lipAlong(d, pr.turn), pr.slide);
  const clipFeet = v.legs.map((l) => l.foot.getWorldPosition(V()));
  _ax.crossVectors(UP, _fwd).normalize(); // turning about up×fwd tips the body forward
  if (fr.pitch) turn(sp.body, _ax, fr.pitch);
  const hipMid = v.legs.reduce((s, l) => s.add(l.upper.getWorldPosition(_hip)), V()).multiplyScalar(1 / v.legs.length);
  const goal = h.position.clone().addScaledVector(_fwd, fr.hip.f);
  goal.y = floor + fr.hip.up;
  place(sp.body, sp.body.getWorldPosition(_c).add(goal).sub(hipMid));
  const b = pr.bend - fr.pitch, [s0, s1, s2] = fr.share;
  if (sp.hips) turn(sp.hips, _ax, b * s0);
  turn(sp.abdomen, _ax, b * (sp.hips ? s1 - s0 : s1));
  turn(sp.torso, _ax, b * (s2 - s1));
  // legs: from lying to kneeling each knee rests on the deck (KNEE_Y) a thigh from its hip joint, the shin back along
  // the deck to an ankle as high as the pointed foot needs (its measured surface on the deck: the instep, lying and
  // kneeling); standing up (r > 2) the kneeling legs blend into the clip's, the foot turning up as it leaves the deck
  const pitch = LIE_FOOT;
  const ankleY = ankleFor(d, pitch), run = Math.sqrt(Math.max(0, d.shin * d.shin - (ankleY - KNEE_Y) ** 2));
  v.legs.forEach((l, i) => {
    const H = l.upper.getWorldPosition(V());
    const K = H.clone().addScaledVector(_fwd, -Math.sqrt(Math.max(0, d.thigh * d.thigh - (H.y - floor - KNEE_Y) ** 2)));
    K.y = floor + KNEE_Y;
    let ankle = K.clone().addScaledVector(_fwd, -run).setY(floor + ankleY);
    let pole = K.clone().sub(H.clone().add(ankle).multiplyScalar(0.5)).addScaledVector(UP, -0.05);
    let q = pitch;
    if (pr.r > 2) {
      const k = smooth(pr.r - 2);
      ankle = ankle.lerp(clipFeet[i], k);
      pole = pole.normalize().lerp(V().copy(_fwd).addScaledVector(UP, 0.2), k);
      q = LIE_FOOT * (1 - k);
      ankle.y = Math.max(ankle.y, floor + ankleFor(d, q));
    }
    const fq = footPitch(v, i, q);
    legTo(l, v.ankle[i], ankle, pole, 0.999, fq);
    // the foot as rendered: lift the ankle by whatever of it dips below the deck (its surface, measured)
    const dip = floor + 0.003 - lowestY(v.surf.foot.get(l.side));
    if (dip > 0) legTo(l, v.ankle[i], ankle.setY(ankle.y + dip), pole, 0.999, fq);
  });
}

/**
 * A hand lying flat on the deck (by `w`): the wrist turned palm down, fingers forward and a little out (the rig's own
 * palm and finger-curl axes), the palm centre back on the point (the arm IK again after the wrist turns), then lifted
 * by whatever of the hand as rendered still dips below the deck.
 */
function flatHand(v: View, arm: Arm, t: THREE.Vector3, floor: number, w: number, pole: THREE.Vector3) {
  if (!arm.curlAxis) return;
  const fl = V().copy(arm.palmLocal).normalize(), nl = V().crossVectors(arm.curlAxis, fl).normalize(), bl = V().crossVectors(fl, nl);
  const F = V().copy(_fwd).addScaledVector(_right, -arm.side * 0.35).normalize(), N = V().set(0, -1, 0), B = V().crossVectors(F, N);
  const flatQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(F, N, B).multiply(new THREE.Matrix4().makeBasis(fl, nl, bl).transpose()));
  const lay = () => setWorldQuat(arm.hand, arm.hand.getWorldQuaternion(new THREE.Quaternion()).slerp(flatQ, w));
  for (let it = 0; it < 2; it++) {
    lay();
    armTo(arm, t, 1, BODY_MODEL.maxExtension, v.rig.holder, pole);
  }
  lay();
  const dip = floor + 0.002 - lowestY(v.surf.hand.get(arm.side));
  if (dip > 0) {
    armTo(arm, t.setY(t.y + dip), 1, BODY_MODEL.maxExtension, v.rig.holder, pole);
    lay();
  }
}

/** Closed hand on every arm that holds something (contact from 0.3, fully closed by 0.8). */
function closeHands(v: View, contacts: number[]) {
  v.arms.forEach((arm, i) => curlHand(arm, smooth(((contacts[i] ?? 0) - 0.3) / 0.5)));
}

/** World foot rotation = rest (relative to the holder) pitched by `pitch` rad about the person's right axis (− = toes down). */
function footPitch(v: View, i: number, pitch: number) {
  v.rig.holder.getWorldQuaternion(_qh);
  _qf.copy(_qh).multiply(v.footRest[i]);
  if (pitch) _qf.premultiply(_qt.setFromAxisAngle(_right, pitch));
  return _qf.clone();
}

/** Classify the drawn support, including library clips whose nominal body kind is 'stand'
 * but which actually kneel. No activity-name list can describe the pose being drawn. */
function uprightLegs(v: View, holder: THREE.Object3D) {
  if (!v.dims || v.legs.length < 2) return 0;
  holder.updateMatrixWorld(true);
  let weight = 1;
  for (const leg of v.legs) {
    const hip = (leg.upper.getWorldPosition(V()).y - holder.position.y) / v.dims.hipH;
    const knee = (leg.lower.getWorldPosition(V()).y - holder.position.y) / v.dims.shin;
    // Fade before the authored kneeling layout takes over. Both ends have zero
    // slope, so crossing the support boundary cannot switch the rig in a frame.
    weight = Math.min(weight, smooth(Math.max(0, Math.min(1,(hip-.6)/.2))), smooth(Math.max(0, Math.min(1,(knee-.25)/.5))));
  }
  return weight;
}

function fitGroundFeet(v: View, holder: THREE.Object3D, fullSkinWeight?: number) {
  if (!v.dims || v.legs.length < 2) return;
  holder.updateMatrixWorld(true);
  for (const [i, leg] of v.legs.entries()) {
    const ankle = leg.foot.getWorldPosition(V());
    if (fullSkinWeight === undefined) {
      const lift = groundFootLift(holder.position.y, lowestY(v.surf.foot.get(leg.side)), humanGroundSampler()?.(ankle.x, ankle.z));
      if (lift < .001) continue;
      const pole = leg.lower.getWorldPosition(V()).sub(leg.upper.getWorldPosition(V()));
      legTo(leg, v.ankle[i], ankle.setY(ankle.y + lift), pole, .999, leg.foot.getWorldQuaternion(new THREE.Quaternion()));
      continue;
    }
    const originY = ankle.y, original = [leg.upper,leg.lower,leg.foot].map(b=>({p:b.position.clone(),q:b.quaternion.clone()}));
    const authoredOffset = ankle.clone().sub(leg.lower.localToWorld(v.ankle[i].clone()));
    const pole = leg.lower.getWorldPosition(V()).sub(leg.upper.getWorldPosition(V()).add(ankle).multiplyScalar(.5));
    if (pole.lengthSq() < 1e-8) pole.copy(_fwd).addScaledVector(UP,.1);
    const rotation = leg.foot.getWorldQuaternion(new THREE.Quaternion());
    let corrected = false;
    // Skin blends between shin and foot bones, so one ankle correction does not
    // necessarily lift the complete surface by the same amount. Recheck the real
    // skin with the same fixed-length IK, keeping the original 8 cm total bound.
    for (let pass = 0; pass < 4; pass++) {
      const low = Math.min(lowestY(v.surf.foot.get(leg.side)), lowestY(v.surf.leg?.get(leg.side)));
      const lift = Math.min(.08 - (ankle.y - originY), groundFootLift(holder.position.y, low, humanGroundSampler()?.(ankle.x, ankle.z)));
      if (lift < .0001) break;
      legTo(leg, v.ankle[i], ankle.setY(ankle.y + lift), pole, .999, rotation);
      corrected = true;
      holder.updateMatrixWorld(true);
      leg.foot.getWorldPosition(ankle);
    }
    if (corrected && fullSkinWeight < 1) {
      [leg.upper,leg.lower,leg.foot].forEach((bone,index)=>{
        bone.position.lerp(original[index].p,1-fullSkinWeight);
        bone.quaternion.slerp(original[index].q,1-fullSkinWeight);
      });
      holder.updateMatrixWorld(true);
      // Foot is a Root sibling. Fade its authored offset with support, not across a different endpoint path.
      place(leg.foot,leg.lower.localToWorld(v.ankle[i].clone()).addScaledVector(authoredOffset,1-fullSkinWeight));
    }
  }
}

/** Seat-owned leg correction, after its pelvis fit. No root/pelvis/bearing or hand-contact target changes. */
function fitSeatedFoot(v: View, i: number, phase: number, liftOnly = false) {
  if (phase <= 0 || v.grip || v.on || v.frame) return;
  const leg = v.legs[i], holder = v.rig.holder, refs = v.surf.foot.get(leg.side);
  if (!refs?.length) return;
  holder.updateMatrixWorld(true);
  const ankle = leg.foot.getWorldPosition(V()), hip = leg.upper.getWorldPosition(V()), knee = leg.lower.getWorldPosition(V());
  const end = leg.lower.localToWorld(v.ankle[i].clone()), length = hip.distanceTo(knee) + knee.distanceTo(end);
  const ground = humanGroundSampler(), legRefs = v.surf.leg?.get(leg.side);
  const clearance = () => {
    let low = Infinity;
    eachSkinnedWorld(refs, _vp, p => { low = Math.min(low, p.y - seatedSupportY(holder.position.y, ground?.(p.x, p.z)) - (liftOnly ? 0 : .003)); });
    // Trouser cuffs blend across the ankle; they must also clear the support.
    if (legRefs) eachSkinnedWorld(legRefs, _vp, p => { low = Math.min(low, p.y - seatedSupportY(holder.position.y, ground?.(p.x, p.z))); });
    return low;
  };
  const before = clearance();
  if (!Number.isFinite(before) || liftOnly && before >= 0) return;
  const supportGoal = ankle.clone(); supportGoal.y -= before;
  const weight = seatedFootWeight(hip.toArray(), supportGoal.toArray(), length, phase);
  if (weight <= 0) return;
  const targetClearance = before * (1 - weight), rotation = leg.foot.getWorldQuaternion(new THREE.Quaternion());
  for (let pass = 0; pass < 3; pass++) {
    const delta = targetClearance - clearance();
    if (Math.abs(delta) < .0001) break;
    leg.foot.getWorldPosition(ankle); ankle.y += delta;
    legTo(leg, v.ankle[i], ankle, V().copy(_fwd).addScaledVector(UP, .35), .995, rotation);
    holder.updateMatrixWorld(true);
  }
}

/**
 * Stairs: plant each foot on its tread (stair-gait.ts), lower the pelvis just enough that no leg has
 * to over-extend (it rises riser by riser with the body point), knees forward, feet flat except the
 * trailing heel lifting before toe-off. Blended with the clip's legs by the gait weight at the ends.
 */
function stairLegs(v: View, g: Gait, f: Flight, holder: THREE.Object3D) {
  const d = v.dims;
  if (!d || !v.spine || v.legs.length < 2) return;
  const w = g.weight;
  const goals: THREE.Vector3[] = [];
  const pitches: number[] = [];
  const clipRotations=v.legs.map(l=>l.foot.getWorldQuaternion(new THREE.Quaternion()));
  const bearings=f.supports?v.legs.map((l,i)=>{
    const rest=footPitch(v,i,0),normal=f.supports&&v.stairContact?.normals.get(l.side);
    return normal?stairBearingRotation(rest,normal):rest;
  }):undefined;
  v.legs.forEach((l, i) => {
    const { foot, point, facing } = stairFootTarget(f, g, l.side > 0 ? 'left' : 'right', v.footLat[i], -holder.rotation.y);
    const clip = l.foot.getWorldPosition(V());
    // toe-off: the trailing heel comes up over the last half-step of the stance, in the travel direction
    let heel = 0;
    if (foot.planted&&!f.supports) {
      const behind = (g.u - foot.k) * facing; // how far the body has passed this foot (spots)
      heel = HEEL * smooth((behind - (facing > 0 ? 0 : 0.2)) / 0.5);
    }
    pitches.push(heel > 0 ? -Math.asin(Math.min(0.9, heel / 0.13)) : 0);
    const measured=f.supports?v.stairContact?.shoePoints.get(l.side):undefined;
    const trajectory=measured&&stairShoeTrajectory(f,g,foot,point,measured.map(p=>p.clone().applyQuaternion(bearings![i])));
    goals.push(clip.lerp(trajectory?new THREE.Vector3(trajectory.point[0],trajectory.y,trajectory.point[1]):new THREE.Vector3(point[0],foot.y+d.ankleH+heel,point[1]),w));
  });
  // pelvis: as the clip has it, lowered until both legs reach their feet at 0.97 of their length
  const hipY = (v.legs[0].upper.getWorldPosition(_hip).y + v.legs[1].upper.getWorldPosition(_knee).y) / 2;
  let target = hipY;
  v.legs.forEach((l, i) => {
    l.upper.getWorldPosition(_hip);
    const dh = Math.hypot(goals[i].x - _hip.x, goals[i].z - _hip.z);
    const reach = 0.97 * d.legLen;
    target = Math.min(target, goals[i].y + Math.sqrt(Math.max(0, reach * reach - dh * dh)));
  });
  v.spine.body.getWorldPosition(_c);
  _c.y += (target - hipY) * w;
  place(v.spine.body, _c.clone());
  const pole = _tmp.copy(_fwd).addScaledVector(UP, 0.1).clone();
  const rotation=(i:number)=>{
    return f.supports&&v.stairContact?.normals.has(v.legs[i].side)?clipRotations[i].clone().slerp(bearings![i],w):footPitch(v,i,pitches[i]);
  };
  const rotations=v.legs.map((_,i)=>f.supports?rotation(i):w>.5?rotation(i):undefined);
  v.legs.forEach((l, i) => legTo(l, v.ankle[i], goals[i], pole, 0.999, rotations[i]));
  // Composed shoes include every vertex, including shin-weighted boot uppers.
  // A long boot may overhang the
  // lower side of a tread; shift it clear of the higher riser before fitting its
  // sole to the real top triangles. The native holder/root never moves.
  if(f.supports)v.stairResiduals=v.legs.map(()=>[]);
  if(f.supports&&w>0)for(let pass=0;pass<2;pass++){
    holder.updateMatrixWorld(true);
    v.legs.forEach((l,i)=>{
      const points:THREE.Vector3[]=[];
      const refs=v.stairShoes?(v.stairShoes.complete?v.stairShoes.refs.get(l.side):undefined):v.surf.foot.get(l.side);
      for(const r of refs??[])for(const idx of r.idx)points.push(r.mesh.getVertexPosition(idx,V()).applyMatrix4(r.mesh.matrixWorld));
      const fit=stairSoleFit(f,g.feet[l.side>0?0:1],points);
      v.stairResiduals![i].push(fit);
      if(Math.abs(fit.along)<.0001&&fit.lift<.0001)return;
      goals[i].x+=f.dir[0]*fit.along;goals[i].z+=f.dir[1]*fit.along;goals[i].y+=fit.lift;
      legTo(l,v.ankle[i],goals[i],pole,.999,rotations[i]??l.foot.getWorldQuaternion(new THREE.Quaternion()));
    });
  }
  if(f.supports)v.stairGoals=goals.map(p=>[p.x,p.y,p.z]);
}

/**
 * Rack structure (frame-gait.ts): each foot to its sole point (a rung of the ladder cycle, or the bracing
 * node of a stance), the pelvis over the body point, lowered by the posture's drop (a crouch on the rod)
 * and further until both legs reach their feet at 0.97 of their length; knees forward and up.
 * `w` blends it with the clip's legs (the first 0.2 m of a climb).
 */
function frameLegs(v: View, fp: FramePose, pz: Posture, w: number) {
  const d = v.dims;
  if (!d || !v.spine || v.legs.length < 2 || !fp.feet) return;
  const goals = v.legs.map((l) => {
    const f = fp.feet![l.side > 0 ? 0 : 1];
    return l.foot.getWorldPosition(V()).lerp(new THREE.Vector3(f.p[0], f.p[1] + d.ankleH, f.p[2]), w);
  });
  const hipY = (v.legs[0].upper.getWorldPosition(_hip).y + v.legs[1].upper.getWorldPosition(_knee).y) / 2;
  let target = hipY - pz.drop;
  v.legs.forEach((l, i) => {
    l.upper.getWorldPosition(_hip);
    const dh = Math.hypot(goals[i].x - _hip.x, goals[i].z - _hip.z);
    const reach = 0.97 * d.legLen;
    target = Math.min(target, goals[i].y + Math.sqrt(Math.max(0, reach * reach - dh * dh)));
  });
  v.spine.body.getWorldPosition(_c);
  _c.y += (target - hipY) * w;
  place(v.spine.body, _c.clone());
  const pole = _tmp.copy(_fwd).addScaledVector(UP, 0.35).clone();
  v.legs.forEach((l, i) => legTo(l, v.ankle[i], goals[i], pole.clone().addScaledVector(_right, -l.side * 0.15), 0.999));
}

/**
 * Seated: lower the body so the hip joints sit PELVIS above the seat, then leg IK — thighs forward,
 * feet on the ground under the knees (the Foot bones are moved to the shin ends). Weight blends the
 * whole thing in/out (a crouch-down on the way). `cross`: one leg crossed over the other knee.
 */
function sitPose(v: View, w: number, ground: number) {
  if (!v.spine || v.legs.length < 2) return;
  const legs = v.legs;
  // leg geometry from the clip pose, before anything moves
  const ends = legs.map((l, i) => l.foot.getWorldPosition(_goals[i]).clone());
  const lens = legs.map((l) => {
    l.upper.getWorldPosition(_hip);
    l.lower.getWorldPosition(_knee);
    return _hip.distanceTo(_knee);
  });
  const hipY = legs.reduce((s, l) => s + l.upper.getWorldPosition(_hip).y, 0) / legs.length;
  const drop = Math.max(0, hipY - (ground + v.seat + PELVIS * (v.rig.template.bodyScale ?? 1))) * w; // a composed look's thighs scale with its height
  v.spine.body.getWorldPosition(_c);
  _c.y -= drop;
  place(v.spine.body, _c.clone());
  const pole = _tmp.copy(_fwd).addScaledVector(UP, 0.3).clone(); // knees forward
  // crossing leg (right when `cross`): its ankle rests beside the other shin, knee over the other knee
  const crossW = v.cross ? smooth((w - 0.6) / 0.4) : 0;
  const order = [...legs.keys()].sort((i, j) => legs[j].side - legs[i].side); // left (the support leg) first
  for (const i of order) {
    const l = legs[i];
    const foot0 = ends[i];
    l.upper.getWorldPosition(_hip);
    // sitting target: under the knee of a horizontal thigh, at the clip's ankle height
    const sitGoal = V().copy(_hip).addScaledVector(_fwd, lens[i] * 0.95);
    sitGoal.y = foot0.y;
    const goal = foot0.clone().lerp(sitGoal, w);
    let kp = pole;
    if (crossW > 0 && l.side < 0) {
      // over the support knee: ankle beside the support shin, a little up and across
      const sup = legs.find((m) => m.side > 0)!;
      const sk = sup.lower.getWorldPosition(V());
      const cross = sk.clone().addScaledVector(UP, -0.18).addScaledVector(_fwd, 0.12).addScaledVector(_right, -0.06);
      goal.lerp(cross, crossW);
      kp = pole.clone().addScaledVector(UP, 1.2 * crossW).addScaledVector(_right, -0.6 * crossW);
    }
    legTo(l, v.ankle[i], goal, kp, 0.995);
    if (crossW <= 0 || l.side > 0) fitSeatedFoot(v, i, w);
  }
}

/** Seated hand resting on its thigh (arm i). */
function handOnThigh(v: View, i: number, w: number) {
  const leg = v.legs.find((l) => l.side === v.arms[i].side) ?? v.legs[i];
  if (!leg) return;
  leg.upper.getWorldPosition(_hip);
  leg.lower.getWorldPosition(_knee);
  const goal = _hip.clone().lerp(_knee, 0.6).addScaledVector(UP, 0.1);
  armTo(v.arms[i], goal, w * 0.9, 0.97, v.rig.holder);
}

/**
 * Arms onto their targets (world points; null = that arm free), reach-honest: contact weight by
 * shoulder distance (full within 1.02 arm lengths, none beyond 1.25); a small shoulder shrug toward
 * the target height (up to 5 cm when reaching overhead). `refind` recomputes a grip point from the
 * shrugged shoulder (nearest-point grips).
 */
type ProneArms = { girdle: number; pole: (arm: Arm, t: THREE.Vector3) => THREE.Vector3 };
function reachTo(v: View, targets: (THREE.Vector3 | null)[], overhead: boolean, maxExt: number = BODY_MODEL.maxExtension, refind?: (from: THREE.Vector3, out: THREE.Vector3) => boolean, prone?: ProneArms) {
  v.reachRatio = v.arms.map(() => null);
  const contacts = v.arms.map(() => 0);
  v.arms.forEach((arm, i) => {
    const t = targets[i];
    if (!t) return;
    const len = armLen(arm);
    arm.upper.getWorldPosition(_s);
    let k = contact(_s.distanceTo(t), len);
    v.reachRatio[i] = +(_s.distanceTo(t) / len).toFixed(2);
    if (k <= 0) return;
    if (arm.shoulder) {
      // shrug: up to BODY_MODEL.shrug when the hand goes ≥ 0.5 m above the shoulder (or heels are up), 2.5 cm down
      // (weighted by the contact the shrugged shoulder would have: the shrug is what brings the top of the reach in)
      const up = t.y - _s.y;
      const full = up >= 0 ? BODY_MODEL.shrug * (overhead ? 1 : clamp01(up / 0.5)) : -0.025 * clamp01(-up / 0.4);
      const dy = full * contact(_tmp.copy(_s).addScaledVector(UP, full).distanceTo(t), len);
      // turn the clavicle until the shoulder joint has risen by dy (a swing toward a raised point only
      // gets part of the way: the joint moves on a circle about the clavicle's root)
      const y0 = _s.y + dy;
      for (let it = 0; it < 6 && Math.abs(y0 - _s.y) > 0.001; it++) {
        swing(arm.shoulder, _s.clone(), _s.clone().addScaledVector(UP, 1.5 * (y0 - _s.y)), 1);
        arm.upper.getWorldPosition(_s);
      }
      // the circle tops out after ~3 cm: the rest is the shoulder girdle elevating (the clavicle root moves up)
      if (Math.abs(y0 - _s.y) > 0.001) {
        place(arm.shoulder, arm.shoulder.getWorldPosition(V()).addScaledVector(UP, y0 - _s.y));
        arm.upper.getWorldPosition(_s);
      }
      arm.upper.getWorldPosition(_s);
      // lying prone: the shoulder girdle reaches toward the hand (protraction), only as far as the arm falls short
      if (prone) {
        const short = Math.min(prone.girdle, _s.distanceTo(t) - maxExt * len);
        if (short > 0) {
          place(arm.shoulder, arm.shoulder.getWorldPosition(V()).addScaledVector(_tmp.subVectors(t, _s).normalize(), short));
          arm.upper.getWorldPosition(_s);
        }
      }
      if (refind) refind(_s, t);
      k = contact(_s.distanceTo(t), len);
    }
    contacts[i] = k;
    armTo(arm, t, k, maxExt, v.rig.holder, prone?.pole(arm, t));
  });
  return contacts;
}

/**
 * On a bent body a free arm (no target, or its target out of reach) hangs with gravity — straight
 * down from the shoulder, a little forward — instead of keeping the clip's arm pose, which would
 * point backwards on a torso pitched 80°. Only arms with no contact at all, from ~30° of bend.
 */
const DANGLE_FROM = 0.5, DANGLE_FULL = 1.1;
function dangle(v: View, bend: number, contacts: number[], from = DANGLE_FROM, keep = 1) {
  const b = smooth((bend - from) / (DANGLE_FULL - from)) * keep; // from ~30° of bend, fully by ~63°
  if (b <= 0) return;
  v.arms.forEach((arm, i) => {
    if ((contacts[i] ?? 0) > 0) return; // touching (even partly): the reach IK owns the arm
    const w = b;
    const len = armLen(arm);
    arm.upper.getWorldPosition(_s);
    const goal = _s.clone().addScaledVector(UP, -0.9 * len).addScaledVector(_fwd, 0.08 * len);
    armTo(arm, goal, w, 0.95, v.rig.holder, _tmp.copy(_fwd).multiplyScalar(-0.3).addScaledVector(UP, -0.2).clone());
  });
}

/** Warming: hands held out, a little down, toward the fire when its edge is within WARM_REACH. */
function warmHands(v: View, w: number, at: THREE.Vector3) {
  const [fx, fz, r] = v.fire!;
  const edge = Math.hypot(fx - at.x, fz - at.z) - r;
  const k = w * clamp01((WARM_REACH - edge) / 0.2);
  if (k <= 0) return;
  const dir = new THREE.Vector3(fx - at.x, 0, fz - at.z).normalize();
  const ext = 0.6 + 0.12 * v.vary; // per-person, seeded by id
  v.arms.forEach((arm) => {
    const len = armLen(arm);
    arm.upper.getWorldPosition(_s);
    const goal = _s.clone().addScaledVector(dir, len * ext).addScaledVector(UP, -len * 0.38);
    armTo(arm, goal, k * 0.85, 0.95, v.rig.holder);
  });
}

function diagOf(v: View, g: Gait | null, flight: string, pz: Posture, targets: (THREE.Vector3 | null)[], source: Source, fp: FramePose | null, pr: ProneState | null = null): Diag {
  const r4 = (x: number) => +x.toFixed(4);
  const a3 = (q: THREE.Vector3) => [r4(q.x), r4(q.y), r4(q.z)] as [number, number, number];
  const ankleH = v.dims?.ankleH ?? 0;
  const feet = v.legs.map((l) => a3(l.foot.getWorldPosition(V())));
  const order = [...v.legs.keys()].sort((i, j) => v.legs[j].side - v.legs[i].side); // left first
  return {
    ...(v.stairShoes?{stairShoeCoverage:{vertices:v.stairShoes.vertices,complete:v.stairShoes.complete}}:{}),
    ...(v.stairGoals?{stairContacts:{goals:order.map(i=>v.stairGoals![i]),ankleErrors:order.map(i=>v.legs[i].foot.getWorldPosition(V()).distanceTo(new THREE.Vector3(...v.stairGoals![i]))),residuals:order.map(i=>v.stairResiduals?.[i]??[])}}:{}),
    gait: g ? { flight, u: r4(g.u), weight: r4(g.weight), feet: g.feet.map((f) => ({ planted: f.planted, k: f.k, top: r4(f.top) })) } : null,
    feet: order.map((i) => feet[i]),
    soles: order.map((i) => r4(feet[i][1] - ankleH)),
    hipY: r4(v.legs.length ? v.legs.reduce((s, l) => s + l.upper.getWorldPosition(V()).y, 0) / v.legs.length : 0),
    head: v.spine?.head ? a3(v.spine.head.getWorldPosition(V())) : null,
    pose: { drop: r4(pz.drop), bend: r4(pz.bend), rise: r4(pz.rise), kneel: r4(pz.kneel) },
    prone: pr ? { r: r4(pr.r), bend: r4(pr.bend), turn: r4(pr.turn), yaw: r4(pr.yaw), w: r4(pr.w), slide: r4(pr.slide), engTurn: v.proneEng?.turn !== undefined ? r4(v.proneEng.turn) : null, phaseK: v.proneEng?.k !== undefined ? r4(v.proneEng.k) : null } : null,
    frame: fp ? { kind: fp.kind, u: r4(fp.u), exit: r4(fp.exit), weight: r4(fp.weight), feet: fp.feet?.map((f) => ({ p: f.p.map(r4), planted: f.planted })) ?? null } : null,
    arms: v.arms.map((arm, i) => {
      const sh = arm.upper.getWorldPosition(V()), pm = palm(arm, V()), len = armLen(arm), t = targets[i];
      return { side: armSide(v, i), shoulder: a3(sh), palm: a3(pm), len: r4(len), target: t ? a3(t) : null, source: t ? source : null, contact: t ? r4(contact(sh.distanceTo(t), len)) : 0, err: t ? r4(pm.distanceTo(t)) : null, ratio: t ? r4(sh.distanceTo(t) / len) : null };
    }),
  };
}

const lerpPose = (a: Pose, b: Pose, t: number): Pose => ({
  p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t],
  yaw: lerpAngle(a.yaw, b.yaw, t),
  pitch: lerpAngle(a.pitch ?? 0, b.pitch ?? 0, t),
  roll: lerpAngle(a.roll ?? 0, b.roll ?? 0, t),
});

/**
 * The upright frame's two column lines (base → top): mid-thickness edges at local x = ±size/2 of
 * the part's box (entityCorners order: x, then y, then z).
 */
function columns(e: Entity): [THREE.Vector3, THREE.Vector3][] {
  const c = entityCorners(e).map((k) => new THREE.Vector3(k[0], k[1], k[2]));
  const mid = (i: number, j: number) => c[i].clone().add(c[j]).multiplyScalar(0.5);
  return [0, 4].map((x) => [mid(x, x + 1), mid(x + 2, x + 3)] as [THREE.Vector3, THREE.Vector3]);
}

/** Nearest point of an entity's catalog box (engine pose) to `from`; false when the def is unknown. */
function boxNearest(e: Entity, from: THREE.Vector3, out: THREE.Vector3) {
  const d = CATALOG[e.def];
  if (!d) return false;
  const [sx, sy, sz] = d.size;
  _m.compose(_tmp.set(e.pose.p[0], e.pose.p[1], e.pose.p[2]), _qb.setFromEuler(_eu.set(e.pose.pitch ?? 0, -e.pose.yaw, e.pose.roll ?? 0, 'YXZ')), _one);
  _mi.copy(_m).invert();
  const l = out.copy(from).applyMatrix4(_mi);
  l.set(Math.min(sx / 2, Math.max(-sx / 2, l.x)), Math.min(sy, Math.max(0, l.y)), Math.min(sz / 2, Math.max(-sz / 2, l.z)));
  out.applyMatrix4(_m);
  return true;
}
const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4(), _qb = new THREE.Quaternion(), _eu = new THREE.Euler(), _one = new THREE.Vector3(1, 1, 1);

/**
 * Hand point of an engine grip slot on part `e` (interpolated pose), nearest to `from` (a shoulder):
 * - `lift-far` / `hold-N` (raise_upright, construction/raise.ts): on the nearer column line, the point
 *   nearest the shoulder, kept ≤ LIFT_HAND (1.9 m) above the person's floor, as the engine holds it;
 * - `foot-l` / `foot-r`: the nearer column base (the engine's footers — at ground level: the body
 *   crouches for it, posture.ts);
 * - `lift-end-*` / `lift-edge-*` / `lift-corner-*` (construction/liftcrew.ts `handPoint`): that box
 *   feature at the part's underside;
 * - `lift-station`: false (a station hand, no contact; the arms hang).
 * undefined = not a slot we know (the caller falls back to the part's nearest point).
 */
function slotPoint(e: Entity, slot: string, from: THREE.Vector3, floor: number, out: THREE.Vector3, handling?: import('../../engine/world/catalog.ts').Handling): boolean | undefined {
  if (slot === STATION_SLOT) return false;
  const grips = (handling ?? CATALOG[e.def]?.capabilities?.fixtureCarry?.handling)?.grips;
  const authored = grips && Object.values(grips).flat().find((g) => g.id === slot);
  if (authored) {
    const span = authored.span ?? [0, 0, 0];
    const end = (sign: number) => new THREE.Vector3(...toWorld(e.pose, [authored.local[0] + sign * span[0], authored.local[1] + sign * span[1], authored.local[2] + sign * span[2]]));
    out.copy(nearestOnSegment(end(-0.5), end(0.5), from, floor + LIFT_HAND));
    return true;
  }
  if (slot.startsWith('lift-') && slot !== 'lift-far') {
    const h = handPoint(e, e.pose, slot);
    if (!h) return undefined;
    out.set(h.p[0], h.p[1], h.p[2]);
    return true;
  }
  const foot = slot === 'foot-l' || slot === 'foot-r';
  if (!(foot || slot === 'lift-far' || /^hold-\d+$/.test(slot))) return undefined;
  if (!CATALOG[e.def]) return undefined;
  let best = Infinity;
  for (const [a, b] of columns(e)) {
    const p = foot ? a.clone() : nearestOnSegment(a, b, from, floor + LIFT_HAND);
    const d = p.distanceTo(from);
    if (d < best) [best, out.x, out.y, out.z] = [d, p.x, p.y, p.z];
  }
  return true;
}

/** Point of segment a→b nearest `q`, then moved down the segment until it is at most `maxY` high. */
function nearestOnSegment(a: THREE.Vector3, b: THREE.Vector3, q: THREE.Vector3, maxY: number) {
  const ab = b.clone().sub(a), L2 = ab.lengthSq();
  let t = L2 > 1e-9 ? clamp01(q.clone().sub(a).dot(ab) / L2) : 0;
  const y = a.y + ab.y * t;
  if (y > maxY && Math.abs(ab.y) > 1e-6) t = clamp01(Math.min(t, (maxY - a.y) / ab.y));
  return a.clone().addScaledVector(ab, t);
}
