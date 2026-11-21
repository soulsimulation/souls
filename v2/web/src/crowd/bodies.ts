// The page's bodies as a crowd (V6, #2715): the world view places each body where its track puts it at the clock's
// time, and this turns those places into the crowd's arrays. Speed is the distance covered over world time, smoothed;
// a body faces the way it moves and blends from idle to walk with its speed; phases run on world time, so a held clock
// holds every pose. Which pose a body is in beyond walk and idle is V7's. A seated body sits; a gesture from the
// stream's move records (`./gestures.ts`, #3741) plays over the posture by its weight and returns to it. A body whose
// stance is lie plays today's lying pose, whole body, blending in and out (`./lying.ts`, #3791).
import type * as THREE from 'three';
import { loadModel } from './bake.ts';
import { Crowd } from './crowd.ts';
import { GESTURE_CLIP_NAMES, Gestures } from './gestures.ts';
import { FADE, LIE_CLIP, Lying } from './lying.ts';

/** The body files of today's people (character-wire.ts's names) and the clips baked for each. */
export const BODIES: [string, string, string][] = [
  ['casual', 'animated-casual.mesh.glb', 'clips-ual.glb'],
  ['punk', 'animated-punk.mesh.glb', 'clips-ual.glb'],
  ['woman', 'animated-woman.mesh.glb', 'clips-ual-woman.glb'],
];
export const CLIPS = ['Idle', 'Walk', 'Run', 'Idle_Talking_Loop', 'Sitting_Idle_Loop', LIE_CLIP, ...GESTURE_CLIP_NAMES];
/** Metres one cycle of the walk clip covers, so a phase rate is speed / WALK_STRIDE. */
export const WALK_STRIDE = 1.3;
/** Speed (m/s) at which a body is all walk. */
const FULL_WALK = 0.9;

/** The crowd with the three body files from `base` (a directory URL). */
export async function loadCrowd(base: string, capacity = 1024): Promise<Crowd> {
  return new Crowd(await Promise.all(BODIES.map(([name, mesh, clips]) => loadModel(name, base + mesh, base + clips, CLIPS))), capacity);
}

/** The crowd with one body kind someone authored (B13, #2744): `entry` is the importer's `<name>.json` under `base`,
 *  naming the kind's full model (its own clips) and its simple model (paths from the entry's folder), the simple one
 *  drawn as the farthest level. */
export async function loadKind(base: string, entry: string, capacity = 1024): Promise<Crowd> {
  const r = await fetch(base + entry);
  if (!r.ok) throw new Error(`${entry}: ${r.status}`);
  const k = (await r.json()) as { kind: string; full: string; simple: string; clips: string[] };
  const clips = ['Idle', 'Walk'].filter((c) => k.clips.includes(c)), at = base + entry.slice(0, entry.lastIndexOf('/') + 1);
  return new Crowd([await loadModel(k.kind, at + k.full, at + k.full, clips, at + k.simple)], capacity);
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export class CrowdBodies {
  readonly crowd: Crowd;
  private index = new Map<string, number>();
  private ids: string[] = [];
  private seen: boolean[] = [];
  private speed: number[] = [];
  private last: number | null = null;
  private dt = 0;
  private idle: number;
  private walk: number;
  private sit: number;
  private lie: number;
  /** Who lies, as the page saw each body's stance (`./lying.ts`). */
  readonly lying = new Lying();
  /** Each body's idle and walk phases (cycles), advanced on world time: the crowd's two slots carry other clips while
   *  a body gestures. */
  private idlePhase: number[] = [];
  private walkPhase: number[] = [];
  private t = 0;
  /** The move records the page has played (`./gestures.ts`). */
  readonly gestures: Gestures;

  constructor(crowd: Crowd, gestures = new Gestures()) {
    this.crowd = crowd;
    this.gestures = gestures;
    this.idle = crowd.clip(0, 'Idle');
    this.walk = crowd.clip(0, 'Walk');
    this.sit = crowd.clip(0, 'Sitting_Idle_Loop');
    this.lie = crowd.clip(0, LIE_CLIP);
  }

  /** Starts a frame at world time `t` (µs). */
  begin(t: number): void {
    this.dt = this.last === null ? 0 : Math.max(0, (t - this.last) / 1e6);
    this.last = t;
    this.t = t;
    this.seen.fill(false);
  }

  /** Body `id` stands (or, `seated`, sits) at world `x, y, z` (m) this frame; `lie`: its stance is lie, along `yaw`
   *  (radians, a bed's) when given, else the way it faced. */
  place(id: string, x: number, y: number, z: number, seated = false, lie: { yaw?: number } | null = null): void {
    const c = this.crowd;
    let i = this.index.get(id);
    // A body first seen lying is drawn lying from that frame (a page opened while it sleeps).
    if (lie) this.lying.down(id, i === undefined ? this.t - FADE * 1e6 : this.t);
    else this.lying.up(id, this.t);
    if (i === undefined) {
      i = c.add(hash(id) % c.models.length);
      this.index.set(id, i);
      this.ids[i] = id;
      this.speed[i] = 0;
      c.x[i] = x; c.y[i] = y; c.z[i] = z;
      c.clipA[i] = this.idle;
      c.clipB[i] = this.walk;
      this.idlePhase[i] = this.walkPhase[i] = (hash(id) % 1000) / 1000;
    }
    this.seen[i] = true;
    const dx = x - c.x[i], dz = z - c.z[i], d = Math.hypot(dx, dz);
    if (this.dt > 0) this.speed[i] += (d / this.dt - this.speed[i]) * Math.min(1, this.dt * 6);
    if (lie?.yaw !== undefined) c.yaw[i] = lie.yaw;
    else if (d > 0.002) c.yaw[i] = Math.atan2(dx, dz);
    c.x[i] = x; c.y[i] = y; c.z[i] = z;
    const model = c.models[c.model[i]], walk = Math.min(1, this.speed[i] / FULL_WALK);
    const base = seated && this.sit >= 0 ? this.sit : this.idle;
    this.idlePhase[i] = (this.idlePhase[i] + this.dt / model.clips[base].seconds) % 1;
    this.walkPhase[i] = (this.walkPhase[i] + this.dt * Math.max(0.3, this.speed[i] / WALK_STRIDE)) % 1;
    // Phases are set here each frame, so the crowd's own step leaves them.
    c.rateA[i] = c.rateB[i] = 0;
    const seconds = (name: string) => model.clips.find((k) => k.name === name)?.seconds;
    const g = this.gestures.at(id, this.t, seated, seconds);
    const lying = this.lie >= 0 && model.clips[this.lie]?.name === LIE_CLIP ? this.lying.at(id, this.t) : 0;
    if (lying > 0) {
      // Lying is the whole body, over the posture it lay down from (or rises to).
      c.clipA[i] = base;
      c.phaseA[i] = this.idlePhase[i];
      c.clipB[i] = this.lie;
      c.phaseB[i] = 0;
      c.blend[i] = lying;
    } else if (g && g.weight > 0) {
      // The gesture is clip B over the posture: whole body standing still; above the hips only (blend from 2) while
      // seated or walking, so the legs keep the seat or the stride.
      const walking = !seated && walk > 0.5;
      c.clipA[i] = walking ? this.walk : base;
      c.phaseA[i] = walking ? this.walkPhase[i] : this.idlePhase[i];
      c.clipB[i] = model.clips.findIndex((k) => k.name === g.clip);
      c.phaseB[i] = g.phase;
      c.blend[i] = seated || walk > 0 ? 2 + g.weight : g.weight;
    } else {
      c.clipA[i] = base;
      c.phaseA[i] = this.idlePhase[i];
      c.clipB[i] = this.walk;
      c.phaseB[i] = this.walkPhase[i];
      c.blend[i] = seated ? 0 : walk;
    }
  }

  /** Ends the frame: bodies not placed leave the crowd; phases advance by the world time passed; the draws fill. */
  end(camera: THREE.Camera): void {
    const c = this.crowd;
    for (let i = c.count - 1; i >= 0; i--) {
      if (this.seen[i]) continue;
      this.index.delete(this.ids[i]);
      this.lying.forget(this.ids[i]);
      const moved = c.remove(i);
      if (moved >= 0) {
        this.ids[i] = this.ids[moved];
        this.speed[i] = this.speed[moved];
        this.idlePhase[i] = this.idlePhase[moved];
        this.walkPhase[i] = this.walkPhase[moved];
        this.seen[i] = this.seen[moved];
        this.index.set(this.ids[i], i);
      }
    }
    this.ids.length = this.speed.length = this.seen.length = this.idlePhase.length = this.walkPhase.length = c.count;
    c.step(this.dt);
    c.draw(camera);
  }
}
