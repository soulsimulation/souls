// The page's bodies as a crowd (V6, #2715): the world view places each body where its track puts it at the clock's
// time, and this turns those places into the crowd's arrays. Speed is the distance covered over world time, smoothed;
// a body faces the way it moves and blends from idle to walk with its speed; phases run on world time, so a held clock
// holds every pose. Which pose a body is in beyond walk and idle is V7's.
import type * as THREE from 'three';
import { bakeBytes, decodeBaked, loadModel } from './bake.ts';
import type { BodyMotion } from './creature/motion.ts';
import { Crowd } from './crowd.ts';
import { ArrivalLights } from './arrival.ts';
import { HumanoidKit } from './humanoid/compose.ts';
import { LOOK_PREFIX } from './humanoid/field.ts';

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

/** The crowd with the three body files from `base` (a directory URL); humanoid looks (#3998) compose from the kit at
 *  `kit`. */
export async function loadCrowd(base: string, capacity = 1024, kit = new HumanoidKit(base + 'humanoid/')): Promise<Crowd> {
  const crowd = new Crowd(await Promise.all(BODIES.map(([name, mesh, clips]) => loadModel(name, base + mesh, base + clips, CLIPS))), capacity);
  const response = await fetch(base + 'bodies.json');
  if (!response.ok) throw new Error('body.catalogue-unavailable');
  const catalogue = await response.json() as { format: string; bodies: { hash: string; entry: string; entryHash: string }[] };
  if (catalogue.format !== 'souls/bodies/1' || !Array.isArray(catalogue.bodies)) throw new Error('body.catalogue-invalid');
  const entries = new Map<string, { file: string; hash: string }>();
  for (const entry of catalogue.bodies) {
    if (!/^[a-f0-9]{64}$/.test(entry.hash) || !/^[a-z][a-z0-9_]*\.json$/.test(entry.entry) || entries.has(entry.hash) || !/^[a-f0-9]{64}$/.test(entry.entryHash)) throw new Error('body.catalogue-invalid');
    entries.set(entry.hash, { file: entry.entry, hash: entry.entryHash });
  }
  const pending = new Map<string, Promise<Awaited<ReturnType<typeof bakeBytes>>>>();
  crowd.worn = (hash) => {
    let promise = pending.get(hash);
    if (!promise) {
      const entry = entries.get(hash);
      promise = hash.startsWith(LOOK_PREFIX) ? Promise.resolve().then(() => kit.model(JSON.parse(hash.slice(LOOK_PREFIX.length)), CLIPS))
        : entry ? verifiedKind(base, entry.file, hash, entry.hash) : Promise.reject(new Error('body.unknown-hash'));
      pending.set(hash, promise);
    }
    return promise;
  };
  return crowd;
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

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
async function verifiedFile(base: string, file: string, expected: string): Promise<Uint8Array> {
  const response = await fetch(base + file);
  if (!response.ok) throw new Error('body.asset-unavailable');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== expected) throw new Error('body.asset-hash');
  return bytes;
}
/** Only the admitted catalogue chooses a path. Every model and kind is checked before it is interpreted. */
export async function verifiedKind(base: string, entry: string, hash: string, entryHash: string) {
  const entryBytes = await verifiedFile(base, entry, entryHash);
  const k = JSON.parse(new TextDecoder().decode(entryBytes)) as { kind: string; full: string; simple: string; format?: string; rigid?: boolean; yaw?: number; motion?: BodyMotion };
  const full = /^models\/([a-f0-9]{64})\.(glb|json)$/.exec(k.full), simple = /^models\/([a-f0-9]{64})\.mesh$/.exec(k.simple);
  if (!full || !simple || !/^body:[a-z][a-z0-9_]*$/.test(k.kind)) throw new Error('body.entry-invalid');
  // The canonical kind's section13 content references must also name these exact model bytes.
  const kind = new TextDecoder().decode(await verifiedFile(base, entry.replace(/\.json$/, '.diag'), hash));
  if (!kind.includes(JSON.stringify('sha256:' + full[1])) || !kind.includes(JSON.stringify('sha256:' + simple[1]))) throw new Error('body.entry-model-mismatch');
  const [bytes, low] = await Promise.all([verifiedFile(base, k.full, full[1]), verifiedFile(base, k.simple, simple[1])]);
  if (k.format === 'baked' && full[2] === 'json') return decodeBaked(bytes);
  if ((k.format === undefined || k.format === 'gltf') && full[2] === 'glb') return bakeBytes(k.kind, bytes, low, base + 'decoder/', { rigid: k.rigid, yaw: k.yaw, motion: k.motion });
  throw new Error('body.entry-format');
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
  private defaults: number;
  private requested: (string | undefined)[] = [];
  /** N-V19 (#3677): a Soul that joins while the page watches comes down in a light. */
  readonly arrivals = new ArrivalLights();

  constructor(crowd: Crowd) {
    this.crowd = crowd; this.defaults = crowd.models.length;
    crowd.group.add(this.arrivals.mesh);
  }

  /** Starts a frame at world time `t` (µs). */
  begin(t: number): void {
    this.dt = this.last === null ? 0 : Math.max(0, (t - this.last) / 1e6);
    this.last = t;
    this.seen.fill(false);
    this.arrivals.begin(t);
  }

  /** Body `id` stands at world `x, y, z` (m) this frame. */
  place(id: string, x: number, y: number, z: number, body?: string, nowMs = performance.now()): void {
    const c = this.crowd;
    let i = this.index.get(id);
    this.arrivals.place(id, x, y, z, i === undefined, nowMs);
    if (i === undefined) {
      i = c.add(hash(id) % this.defaults);
      this.index.set(id, i);
      this.ids[i] = id;
      this.speed[i] = 0;
      c.x[i] = x; c.y[i] = y; c.z[i] = z;
      this.select(i, c.model[i]);
      c.phaseA[i] = c.phaseB[i] = (hash(id) % 1000) / 1000;

    }
    this.seen[i] = true;
    if (this.requested[i] !== body) {
      this.requested[i] = body;
      if (body === undefined) { this.select(i, hash(id) % this.defaults); c.ready[i] = 1; }
    }
    if (body !== undefined) {
      let loaded = c.bodyLoads.get(body);
      if (!loaded) {
        loaded = { state: 'loading' }; c.bodyLoads.set(body, loaded);
        const state = loaded;
        (c.worn ? c.worn(body) : Promise.reject(new Error('body.catalogue-unavailable'))).then(
          (model) => { state.model = c.addModel(model); state.state = 'ready'; },
          (error: unknown) => { state.state = 'unavailable'; state.reason = error instanceof Error ? error.message : 'body.load-failed'; },
        );
      }
      // A look is a costume over the default body: that body stands in while it loads or if it cannot be drawn.
      c.ready[i] = loaded.state === 'ready' || body.startsWith(LOOK_PREFIX) ? 1 : 0;
      if (loaded.model !== undefined && c.model[i] !== loaded.model) this.select(i, loaded.model);
    }
    const dx = x - c.x[i], dz = z - c.z[i], d = Math.hypot(dx, dz);
    if (this.dt > 0) this.speed[i] += (d / this.dt - this.speed[i]) * Math.min(1, this.dt * 6);
    if (d > 0.002) c.yaw[i] = Math.atan2(dx, dz);
    c.x[i] = x; c.y[i] = y; c.z[i] = z;
    c.blend[i] = Math.min(1, this.speed[i] / FULL_WALK);
    const model = c.models[c.model[i]];
    c.rateB[i] = model.fixedWalk ? 1 / model.clips[c.clipB[i]].seconds : model.walkSpeed ? this.speed[i] / model.walkSpeed / model.clips[c.clipB[i]].seconds : Math.max(0.3, this.speed[i] / WALK_STRIDE);
  }

  private select(i: number, model: number): void {
    const c = this.crowd; c.model[i] = model; c.liveRow[i] = -1;
    const idle = c.clip(model, 'Idle'), walk = c.clip(model, 'Walk');
    c.clipA[i] = idle < 0 ? 0 : idle; c.clipB[i] = walk < 0 ? c.clipA[i] : walk;
    c.rateA[i] = 1 / c.models[model].clips[c.clipA[i]].seconds;
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
        this.requested[i] = this.requested[moved];
        this.seen[i] = this.seen[moved];
        this.index.set(this.ids[i], i);
      }
    }
    this.ids.length = this.speed.length = this.seen.length = this.requested.length = c.count;
    c.step(this.dt);
    c.draw(camera);
    this.arrivals.draw();
  }
}
