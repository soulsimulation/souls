// The camera pathfinder: given who to watch (a sampler), the world's solids and a window of time, it tries every
// move × side × framing, lets the engine's planner check each against the world (never inside a solid, never
// through one, the subject in sight) and scores what is left on how it reads: sight, faces, size in frame, smooth
// motion, nobody else cutting across the foreground, a level horizon, room ahead of a walker, some parallax. No renderer, no image, no model: the same call
// plans a shot of recorded history offline, and its moves and scores are what a live camera can hold itself to.
import { CameraWorld, nearestSolid } from '../../../mars/viewer/engine/camera/geom.ts';
import { planCameraTrack, type CameraPlan } from '../../../mars/viewer/engine/camera/plan.ts';
import type { Sampler, ShotSpec, SubjectPose } from '../../../mars/viewer/engine/camera/shots.ts';
import { CAMERA_TRACK_SCHEMA, type CameraTrackData } from '../../../mars/viewer/engine/camera/track.ts';
import type { SpatialScene } from '../../../mars/viewer/engine/spatial/types.ts';
import { anchorAt, anchorTrack, FRAMINGS, MOVES, moveSpec, type Anchor, type Framing, type MoveKind } from './moves.ts';

type Vec3 = [number, number, number];
const DEG = Math.PI / 180, clamp = (x: number) => Math.max(0, Math.min(1, x));

export type PathRequest = {
  sampler: Sampler; scene: SpatialScene | CameraWorld;
  /** Seconds; the sampler's t = 0 is the start of the shot. */
  duration: number;
  /** Who the shot is about; several ids are framed as a group. */
  subjects: readonly string[];
  /** Frame width / height (0.8 for 4:5). */
  aspect: number;
  /** Points the shot should hold with the subject at time t: the corners of what it rides or sits on. Sight and faces
   *  are still judged on the subject alone. */
  context?: (t: number) => readonly Vec3[];
  hz?: number; moves?: readonly MoveKind[]; framings?: readonly Framing[]; ground?: (x: number, z: number) => number;
  /** Shift the taste: a weight per score part (default WEIGHTS). */
  weights?: Partial<typeof WEIGHTS>;
};
/** What a shot is judged on, each 0..1, and how much each counts. */
export const WEIGHTS = { sight: 3, worst: 1, faces: 2.5, size: 1.5, smooth: 2, clean: 2, level: 0.5, lead: 0.5, parallax: 0.75, clear: 0.5 };
export type Parts = Record<keyof typeof WEIGHTS, number>;
export type Candidate = { id: string; move: MoveKind; side: 1 | -1; framing: Framing; spec: ShotSpec; plan: CameraPlan; score: number; parts: Parts; rejected?: string };
export type PathResult = { best: Candidate | null; ranked: Candidate[]; rejected: Candidate[]; anchor: { moving: boolean; meanSpeed: number; group: number } };

/** Comfortable motion: at or under `good` scores 1, at `bad` 0. */
export const COMFORT = { angVel: [16, 50], angAcc: [45, 160], linAcc: [2.5, 9], pitchDown: [26, 55], size: [0.08, 0.2, 0.8, 1.15], speed: 0.5, clearance: [0.3, 1.5] } as const;
/** A bystander counts as foreground when nearer than this fraction of the subject's distance; `body` is its half-width (m).
 *  One standing within `beside` metres of the subject, in the picture, costs `besideCost`: it reads as part of the shot and is not
 *  (unless it is mostly behind the subject: under `apart` metres to either side of it on screen). */
export const FOREGROUND = { nearer: 0.85, body: 0.35, beside: 2, besideCost: 0.6, apart: 0.7 };
/** With a context (a rider and its balloon) the subject may be this small a part of the frame height and still count as seen. */
export const CONTEXT_MIN_SIZE = 0.012;
/** A subject slower than this (m/s, on average) is standing; for one, `parallax` weighs STILL_PARALLAX. */
export const MOVING = 0.35, STILL_PARALLAX = 3;
const under = (v: number, [good, bad]: readonly [number, number]) => clamp(1 - (v - good) / (bad - good));

function frontality(position: Vec3, s: SubjectPose): number {
  const dx = position[0] - s.p[0], dz = position[2] - s.p[2], n = Math.hypot(dx, dz) || 1e-4;
  return (1 + (dx * Math.cos(s.yaw) + dz * Math.sin(s.yaw)) / n) / 2;
}

function judge(req: PathRequest, world: CameraWorld, track: readonly Anchor[], plan: CameraPlan, fov: number): Parts {
  const S = plan.samples, n = S.length, tv = Math.tan((fov * DEG) / 2);
  let faces = 0, size = 0, level = 0, lead = 0, len = 0, clean = 0, minClear: number = COMFORT.clearance[1];
  const cast = new Set(req.subjects);
  for (let i = 0; i < n; i++) {
    const s = S[i], poses = req.sampler(s.t), a = anchorAt(track, s.t), here = req.subjects.map((id) => poses[id]).filter(Boolean);
    faces += here.length ? here.reduce((x, p) => x + frontality(s.position, p), 0) / here.length : 0.5;
    const view: Vec3 = [s.target[0] - s.position[0], s.target[1] - s.position[1], s.target[2] - s.position[2]], vl = Math.hypot(...view) || 1;
    const d = Math.hypot(a.p[0] - s.position[0], a.p[1] + a.height / 2 - s.position[1], a.p[2] - s.position[2]) || 1;
    const frac = a.height / (2 * d * Math.tan((s.fov * DEG) / 2 || tv)), [z0, lo, hi, z1] = COMFORT.size;
    size += frac < lo ? clamp((frac - z0) / (lo - z0)) : frac > hi ? clamp((z1 - frac) / (z1 - hi)) : 1;
    level += under(Math.asin(Math.max(-1, Math.min(1, -view[1] / vl))) / DEG, COMFORT.pitchDown);
    // room ahead: seen from the camera, a walker sits on the side it is walking away from
    const rx = -view[2] / (Math.hypot(view[0], view[2]) || 1), rz = view[0] / (Math.hypot(view[0], view[2]) || 1);
    const off = ((a.p[0] - s.target[0]) * rx + (a.p[2] - s.target[2]) * rz) / (d * tv * req.aspect), going = Math.cos(a.heading) * rx + Math.sin(a.heading) * rz;
    lead += a.speed > 0.35 ? clamp(0.5 - off * Math.sign(going) * 4) : 0.75;
    // a bystander nearer the camera than the subject and inside the picture (or cut by its edge) spoils the shot
    let intruder = 0;
    for (const [id, o] of Object.entries(poses)) {
      if (cast.has(id) || o.kind !== 'human') continue;
      const ox = o.p[0] - s.position[0], oy = o.p[1] + (o.height ?? 1.75) / 2 - s.position[1], oz = o.p[2] - s.position[2];
      const depth = (ox * view[0] + oy * view[1] + oz * view[2]) / vl; if (depth < 0.2) continue;
      const half = depth * Math.tan((s.fov * DEG) / 2 || tv), across = Math.abs(ox * rx + oz * rz) - FOREGROUND.body;
      if (across >= half * req.aspect) continue;
      if (depth <= d * FOREGROUND.nearer) intruder = Math.max(intruder, clamp(1.5 - depth / (d * FOREGROUND.nearer) * 1.5 + 0.5));
      else if (Math.hypot(o.p[0] - a.p[0], o.p[2] - a.p[2]) < a.radius + FOREGROUND.beside && Math.abs((o.p[0] - a.p[0]) * rx + (o.p[2] - a.p[2]) * rz) > FOREGROUND.apart) intruder = Math.max(intruder, FOREGROUND.besideCost);
    }
    clean += 1 - intruder;
    if (i) len += Math.hypot(s.position[0] - S[i - 1].position[0], s.position[1] - S[i - 1].position[1], s.position[2] - S[i - 1].position[2]);
    const near = nearestSolid(world, s.position, 'collide', COMFORT.clearance[1]); if (near) minClear = Math.min(minClear, near.d);
  }
  const T = plan.report.temporal;
  return {
    sight: plan.report.meanReadability, worst: plan.report.minReadability, faces: faces / n, size: size / n,
    smooth: Math.min(under(T.maxAngVel, COMFORT.angVel), under(T.maxAngAcc, COMFORT.angAcc), under(T.maxLinAcc, COMFORT.linAcc)),
    clean: clean / n, level: level / n, lead: lead / n, parallax: clamp(len / (plan.duration * COMFORT.speed)),
    clear: clamp((minClear - COMFORT.clearance[0]) / (COMFORT.clearance[1] - COMFORT.clearance[0])),
  };
}

/** Every candidate, planned and scored. `best` is the highest-scoring one that never enters or crosses a solid, never
 *  cuts and keeps the subject in sight; `rejected` says why each of the others was thrown out. Deterministic. */
export function findPath(req: PathRequest): PathResult {
  if (!(req.duration > 0) || !req.subjects.length) throw Error('camera.path-request: a duration and at least one subject');
  const world = req.scene instanceof CameraWorld ? req.scene : new CameraWorld(req.scene);
  const hz = req.hz ?? 10, track = anchorTrack(req.sampler, req.subjects, req.duration, undefined, undefined, req.context);
  // a subject that stays where it is gives the shot no motion of its own: the camera's travel counts for more
  const present = track.filter((a) => a.present), meanSpeed = present.reduce((s, a) => s + a.speed, 0) / Math.max(1, present.length), still = meanSpeed <= MOVING;
  const weights = { ...WEIGHTS, ...(still ? { parallax: STILL_PARALLAX } : {}), ...req.weights }, total = Object.values(weights).reduce((a, b) => a + b, 0);
  const ranked: Candidate[] = [], rejected: Candidate[] = [];
  const consider = (pull: boolean) => {
    for (const move of req.moves ?? MOVES) for (const side of [1, -1] as const) for (const framing of req.framings ?? FRAMINGS) {
      const spec = moveSpec(move, track, req.subjects, { duration: req.duration, aspect: req.aspect, framing, side, ground: req.ground });
      // 'desired' only: the move itself is judged, not a rescue of it. A move the world does not allow is rejected whole.
      // Indoors (the second pass) the camera may also come in along its own line of sight to just short of the wall
      // behind it ('pull'), held for the whole shot: still one continuous move.
      const plan = planCameraTrack(spec, req.sampler, world, { duration: req.duration, hz, aspect: req.aspect, variants: pull ? ['pull'] : ['desired'], ...(req.context ? { minSize: CONTEXT_MIN_SIZE } : {}) });
      const parts = judge(req, world, track, plan, spec.fov ?? 50), R = plan.report;
      const score = (Object.keys(weights) as (keyof Parts)[]).reduce((s, k) => s + weights[k] * parts[k], 0) / total;
      const why = R.invalidSamples ? `camera.path-blocked: ${R.reasons[0] ?? 'inside or too near a solid'}` : R.sweptCrossings ? `camera.path-crosses: ${R.reasons[0] ?? 'passes through a solid'}`
        : R.cuts.length ? 'camera.path-cuts: not one continuous move' : R.readableFraction < 0.8 ? `camera.path-unseen: subject readable ${Math.round(R.readableFraction * 100)}% of the shot${R.reasons[0] ? `; ${R.reasons[0]}` : ''}` : undefined;
      const c: Candidate = { id: `${move}:${side > 0 ? 'L' : 'R'}:${framing}${pull ? ':in' : ''}`, move, side, framing, spec, plan, score, parts, ...(why ? { rejected: why } : {}) };
      (why ? rejected : ranked).push(c);
    }
  };
  consider(false);
  if (!ranked.length) consider(true); // nothing fits at its framing distance: a room. Try each move pulled inside the walls.
  const order = (a: Candidate, b: Candidate) => b.score - a.score || (a.id < b.id ? -1 : 1);
  ranked.sort(order); rejected.sort(order);
  return { best: ranked[0] ?? null, ranked, rejected, anchor: { moving: meanSpeed > MOVING, meanSpeed, group: req.subjects.length } };
}

/** The chosen move as stored camera data (`mars-camera-track/1`): sample it with the engine's `sampleTrack(data, t)`. */
export const trackOf = (c: Candidate): CameraTrackData => ({ ...c.plan, schema: CAMERA_TRACK_SCHEMA });
