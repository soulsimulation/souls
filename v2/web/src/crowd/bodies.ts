// The page's bodies as a crowd (V6, #2715): the world view places each body where its track puts it at the clock's
// time, and this turns those places into the crowd's arrays. Speed is the distance covered over world time, smoothed;
// a body faces the way it moves and blends from idle to walk with its speed; phases run on world time, so a held clock
// holds every pose. Which pose a body is in beyond walk and idle is V7's.
import type * as THREE from 'three';
import { loadModel } from './bake.ts';
import { Crowd } from './crowd.ts';
import { ArrivalLights } from './arrival.ts';

/** The body files of today's people (character-wire.ts's names) and the clips baked for each. */
export const BODIES: [string, string, string][] = [
  ['casual', 'animated-casual.mesh.glb', 'clips-ual.glb'],
  ['punk', 'animated-punk.mesh.glb', 'clips-ual.glb'],
  ['woman', 'animated-woman.mesh.glb', 'clips-ual-woman.glb'],
];
export const CLIPS = ['Idle', 'Walk', 'Run', 'Idle_Talking_Loop', 'Sitting_Idle_Loop'];
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
  /** N-V19 (#3677): a Soul that joins while the page watches comes down in a light. */
  readonly arrivals = new ArrivalLights();

  constructor(crowd: Crowd) {
    this.crowd = crowd;
    crowd.group.add(this.arrivals.mesh);
    this.idle = crowd.clip(0, 'Idle');
    this.walk = crowd.clip(0, 'Walk');
  }

  /** Starts a frame at world time `t` (µs). */
  begin(t: number): void {
    this.dt = this.last === null ? 0 : Math.max(0, (t - this.last) / 1e6);
    this.last = t;
    this.seen.fill(false);
    this.arrivals.begin(t);
  }

  /** Body `id` stands at world `x, y, z` (m) this frame. */
  place(id: string, x: number, y: number, z: number, nowMs = performance.now()): void {
    const c = this.crowd;
    let i = this.index.get(id);
    this.arrivals.place(id, x, y, z, i === undefined, nowMs);
    if (i === undefined) {
      i = c.add(hash(id) % c.models.length);
      this.index.set(id, i);
      this.ids[i] = id;
      this.speed[i] = 0;
      c.x[i] = x; c.y[i] = y; c.z[i] = z;
      c.clipA[i] = this.idle;
      c.clipB[i] = this.walk;
      c.phaseA[i] = c.phaseB[i] = (hash(id) % 1000) / 1000;
      c.rateA[i] = 1 / c.models[c.model[i]].clips[this.idle].seconds;
    }
    this.seen[i] = true;
    const dx = x - c.x[i], dz = z - c.z[i], d = Math.hypot(dx, dz);
    if (this.dt > 0) this.speed[i] += (d / this.dt - this.speed[i]) * Math.min(1, this.dt * 6);
    if (d > 0.002) c.yaw[i] = Math.atan2(dx, dz);
    c.x[i] = x; c.y[i] = y; c.z[i] = z;
    c.blend[i] = Math.min(1, this.speed[i] / FULL_WALK);
    c.rateB[i] = Math.max(0.3, this.speed[i] / WALK_STRIDE);
  }

  /** Ends the frame: bodies not placed leave the crowd; phases advance by the world time passed; the draws fill. */
  end(camera: THREE.Camera): void {
    const c = this.crowd;
    for (let i = c.count - 1; i >= 0; i--) {
      if (this.seen[i]) continue;
      this.index.delete(this.ids[i]);
      const moved = c.remove(i);
      if (moved >= 0) {
        this.ids[i] = this.ids[moved];
        this.speed[i] = this.speed[moved];
        this.seen[i] = this.seen[moved];
        this.index.set(this.ids[i], i);
      }
    }
    this.ids.length = this.speed.length = this.seen.length = c.count;
    c.step(this.dt);
    c.draw(camera);
    this.arrivals.draw();
  }
}
