// The things' effects on the v2 page (0.131 parity C8, #3679): flames on every flame part (campfires, fireplaces,
// hearths, torches, candles), steam over a heated kettle or a fresh cup, and a fountain's jets and falling water, as
// today's entity layer mounts them (`apps/web/src/fx/flames.ts`, `steam.ts`, `water-jets.ts`, `water.ts`). Which thing
// gets what comes from its kind and its baked model (`model.ts`): a model with flame clusters burns, a fountain's water
// falls between its water discs. Effects follow the thing's state: a fire burns while it is lit, a fountain runs while
// it is on, a kettle steams on today's heating clock from when it was switched on, a cup on today's cooling clock from
// when it was poured. The stream carries no such field yet, so each starts from its kind's default (a fire lit, a
// fountain on, a kettle and a cup cold); `state` sets it. Detail drops with distance (today's reaches) and on the phone
// tier (no embers or smoke, a third of the fountain's drops, half the steam).
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { createFire, seedOf, type Fire, type FireKind } from './fire.ts';
import { modelFx, type ModelFx } from './model.ts';
import { cupSteam, kettleSteam, setSteam, steam, type SteamKind } from './steam.ts';
import { fallingWaterSheets, fountainJets, fountainPlan } from './water-jets.ts';
import { tickFx } from './clock.ts';
import { givesLight, nightStrength } from '../draw/night.ts';
import { Halos, type HaloSource } from './halos.ts';
import { Lighthouse } from './lighthouse.ts';

/** A thing's state as the effects read it. `lit`: a fire burns (from `litAt`, world s, it catches over IGNITE s);
 *  `on`: a fountain runs; `heatedAt`: a kettle was switched on; `pouredAt`: a cup was poured (world s). */
export type FxState = { lit?: boolean; litAt?: number; on?: boolean; heatedAt?: number; pouredAt?: number };
export type FxKind = 'fire' | 'fountain' | 'kettle' | 'cup' | 'light' | 'lighthouse';

const FIRE_WORDS = /(^|[^a-z])(fire|campfire|bonfire|firepit|fire-pit|fire-bowl|torch|brazier|hearth|fireplace|candle|candelabra|candlestick|forge|kiln|furnace|flame|lantern)/;
/** What a kind may draw, by its name and its state table (V17's `models.json`): flames are confirmed by the model. */
export function fxKind(kind: string, states?: Record<string, string[]>): FxKind | null {
  const k = kind.split('@')[0].toLowerCase(), name = k.slice(k.indexOf(':') + 1);
  if (/(^|[_-])lighthouse$/.test(name)) return 'lighthouse'; // the tower, not its painted bands
  if (/fountain/.test(name)) return /drinking/.test(name) ? null : 'fountain';
  if (/(^|[_-])kettle($|[_-])/.test(name)) return 'kettle';
  if (/(^|[_-])(cup|mug|teacup|tea-cup)($|[_-])/.test(name) && !/pack/.test(name)) return 'cup';
  if (states?.lit || FIRE_WORDS.test(name)) return 'fire';
  return givesLight(states) ? 'light' : null;
}

/** Reach (m) of each fire detail level by size class, today's `REACH`: [flames, embers and smoke]. */
export const REACH: Record<FireKind, [number, number]> = { candle: [14, 14], torch: [50, 22], full: [110, 40] };
export const fireKindOf = (r: number): FireKind => (r < 0.05 ? 'candle' : r < 0.2 ? 'torch' : 'full');
/** Today's detail of a fire `d` m away: 2 everything, 1 flames only, 0 none (the model's own flame stands in). */
export function fireLevel(kind: FireKind, d: number, phone: boolean): 0 | 1 | 2 {
  const [r1, r2] = REACH[kind];
  return d < r2 && !phone ? 2 : d < r1 ? 1 : 0;
}
/** A fire lit by hand catches and grows to full over IGNITE s (today's catch-up). */
export const IGNITE = 1.6;
export function fireStrength(state: FxState, t: number): number {
  if (state.lit === false) return 0;
  if (state.litAt === undefined || !(t >= state.litAt)) return state.litAt === undefined ? 1 : 0.12;
  const k = Math.min(1, (t - state.litAt) / IGNITE);
  return 0.12 + 0.88 * k * k * (3 - 2 * k);
}
/** How far (m) the water and the steam are drawn. */
export const WATER_REACH = 120, STEAM_REACH: Record<SteamKind, number> = { kettle: 40, cup: 25 };
/** Today's kettle spout (the core kettle's frame) and the direction its steam leaves in. */
const KETTLE_SPOUT = new THREE.Vector3(0.268, 0.196, 0), KETTLE_JET = new THREE.Vector3(Math.cos(0.66), Math.sin(0.66), 0).multiplyScalar(0.25);

type Mounted = { fire: Fire; kind: FireKind; level: -1 | 0 | 1 | 2 };
type Entry = {
  id: string; kind: FxKind; origin: string; hash: string; model: ModelFx | null; root: THREE.Group | null;
  fires: Mounted[]; burning?: boolean; steam: THREE.Points | null; water: THREE.Object3D[]; state: FxState;
  /** A lighthouse's beams, and the halo a light gives: a fire's or a lamp's, by its kind's name as its pool is (A2, #3724). */
  beam?: Lighthouse; glow: 'fire' | 'lamp';
};

/** Which lights glow as fires: the night pools' rule (`draw/night.ts`). */
const GLOW_FIRE = /fire|hearth|brazier|campfire|torch/;
/** Today's lantern room: up 0.83 of the lighthouse's height (`world-env.ts`, of its box; here of its model's top). */
export const LANTERN_UP = 0.83;
/** A light's halo as today's god world places it (`world-env.ts`): a fire's at its foot (the halo kind lifts it 0.55 m),
 *  a lamp's at its head. Today's lamp is 3.4 s m tall with its head 0.2 m below its top, so `s` is the model's height
 *  (`top`, world m) over 3.4: today's 3.4 m street lamp is scale 1, its glow 3.2 m up. */
export function haloOf(kind: 'fire' | 'lamp', foot: THREE.Vector3, top: number): HaloSource {
  return kind === 'fire' ? [foot.x, foot.y, foot.z, 'fire', 1] : [foot.x, foot.y, foot.z, 'lamp', Math.max(0.15, (top - foot.y) / 3.4)];
}
export type FxOptions = {
  /** The thing's frame (the thing layer's: its node's frame, scaled). */
  frame(id: string): THREE.Matrix4 | null;
  /** V17's index, once the page has it: a thing's model and its kind's state table. */
  index(): { things: Record<string, string>; states: Map<string, Record<string, string[]>> } | null;
  /** A model's bytes, by hash. */
  fetch(hash: string): Promise<ArrayBuffer>;
  /** Hides a fire's static flame parts while it burns, shows them when it does not (the thing layer's `standIns`). */
  standIns?(id: string, shown: boolean): void;
  /** The phone tier (`quality-tier.ts`). */
  phone: boolean;
  reducedMotion?: boolean;
};

export class FxLayer {
  readonly group = new THREE.Group();
  readonly things = new Map<string, Entry>();
  private readonly models = new Map<string, ModelFx | null | Promise<void>>();
  private readonly at = new THREE.Vector3();
  /** Fires mounted and near the camera now, for the inspector and the proof. */
  stats = { fires: 0, near: 0, steaming: 0, fountains: 0, lights: 0, lighthouses: 0 };
  /** The world time (s) of the last frame, to set a state from now (`state(id, { heatedAt: fx.time })`). */
  time = 0;
  readonly opts: FxOptions;
  /** Every lit light's glow at night, today's `halos` (A2, #3724). */
  readonly halos = new Halos(2048);
  private frames = 0;
  constructor(opts: FxOptions) {
    this.opts = opts;
    this.group.name = 'effects';
    this.group.add(this.halos.mesh);
  }

  /** Follows the parts the page plays: things that may draw an effect come and go. */
  apply(nodes: readonly NodeRec[], removed: readonly string[]): void {
    for (const id of removed) (this.remove(id), this.pending.delete(id));
    const index = this.opts.index();
    for (const n of nodes) {
      if (n.at !== null || !n.origin) continue;
      if (index) this.consider(n, index);
      else this.pending.set(n.id, n);
    }
  }

  private readonly pending = new Map<string, NodeRec>();
  /** A thing draws an effect when its kind says so (its name, or its state table's `lit`). */
  private consider(n: NodeRec, index: NonNullable<ReturnType<FxOptions['index']>>): void {
    const hash = index.things[n.origin!] ?? null, kind = hash ? fxKind(n.kind, index.states.get(hash)) : null;
    const old = this.things.get(n.id);
    if (old && old.hash === hash && old.kind === kind) return;
    if (old) this.remove(n.id);
    if (hash && kind) this.things.set(n.id, { id: n.id, kind, origin: n.origin!, hash, model: null, root: null, fires: [], steam: null, water: [], state: {}, glow: GLOW_FIRE.test(n.kind) ? 'fire' : 'lamp' });
  }

  /** Sets a thing's state (merged); a fire lit now catches from `litAt`. */
  state(id: string, s: FxState): void {
    const e = this.things.get(id);
    if (e) Object.assign(e.state, s);
  }

  /** Is a thing's fire lit (its light pool shows)? True for anything the effects do not know as put out. */
  lit(id: string): boolean {
    return this.things.get(id)?.state.lit !== false;
  }

  remove(id: string): void {
    const e = this.things.get(id);
    if (!e) return;
    this.things.delete(id);
    if (e.burning) this.opts.standIns?.(id, true);
    e.beam?.dispose();
    if (e.root) this.group.remove(e.root);
    for (const f of e.fires) f.fire.dispose();
    for (const o of [e.steam, ...e.water]) if (o) ((o as THREE.Mesh).material as THREE.Material).dispose();
    for (const o of e.water) if ((o as THREE.Mesh).geometry?.type === 'CylinderGeometry') (o as THREE.Mesh).geometry.dispose();
  }

  /** Once a frame: `t` world seconds (null while nothing plays), `eye` the camera. */
  update(t: number | null, eye: THREE.Vector3): void {
    const now = t ?? 0;
    this.time = now;
    tickFx(this.opts.reducedMotion ? 7.3 : now);
    const index = this.opts.index();
    if (!index) return;
    const s = { fires: 0, near: 0, steaming: 0, fountains: 0, lights: 0, lighthouses: 0 };
    const night = nightStrength(), halos: HaloSource[] | null = this.frames++ % 30 === 0 ? [] : null;
    if (this.pending.size) {
      for (const n of this.pending.values()) this.consider(n, index);
      this.pending.clear();
    }
    for (const e of this.things.values()) {
      const frame = this.opts.frame(e.id);
      if (!frame) continue;
      if (!e.root) {
        const m = this.models.get(e.hash);
        e.model = m instanceof Promise || m === undefined ? null : m;
        if (m === undefined) { this.load(e.hash); continue; }
        if (m === null || m instanceof Promise) { if (m === null) this.things.delete(e.id); continue; }
        if (!this.mount(e, m, frame)) { this.things.delete(e.id); continue; }
      }
      const root = e.root!;
      root.matrix.copy(frame);
      root.matrixWorldNeedsUpdate = true;
      if (e.beam) (s.lighthouses++, e.beam.update(this.opts.reducedMotion ? 0 : now, night, 0));
      if (halos && (e.kind === 'fire' || e.kind === 'light') && e.state.lit !== false) {
        const foot = new THREE.Vector3().setFromMatrixPosition(frame), top = new THREE.Vector3(0, e.model?.top ?? 0, 0).applyMatrix4(frame).y;
        halos.push(haloOf(e.glow, foot, top));
        s.lights++;
      }
      const d = this.at.setFromMatrixPosition(frame).distanceTo(eye);
      if (e.kind === 'fire') {
        const strength = fireStrength(e.state, now);
        for (const f of e.fires) {
          s.fires++;
          f.fire.group.updateWorldMatrix(true, false);
          const fd = this.at.setFromMatrixPosition(f.fire.group.matrixWorld).distanceTo(eye);
          const level = strength > 0 ? fireLevel(f.kind, fd, this.opts.phone) : 0;
          if (level !== f.level) { f.level = level; f.fire.setDetail(level); }
          if (level > 0) (s.near++, f.fire.update(this.opts.reducedMotion ? 7.3 : now, strength));
          else f.fire.group.visible = false;
        }
        // the static flame parts stand in for a lit fire drawn too far off to animate (today's); an unlit fire has no flame
        const hide = strength === 0 || e.fires.some((f) => f.level > 0);
        if (hide !== e.burning) (e.burning = hide, this.opts.standIns?.(e.id, !hide));
      } else if (e.kind === 'fountain') {
        const on = e.state.on !== false && d < WATER_REACH;
        for (const o of e.water) o.visible = on;
        if (on) s.fountains++;
      } else if (e.steam) {
        const kind = e.kind as SteamKind;
        const heat = d > STEAM_REACH[kind] ? 0
          : kind === 'kettle' ? (e.state.heatedAt === undefined ? 0 : kettleSteam(now - e.state.heatedAt))
          : e.state.pouredAt === undefined ? 0 : cupSteam(now - e.state.pouredAt);
        setSteam(e.steam, heat);
        if (e.steam.visible) s.steaming++;
      }
    }
    if (halos) this.halos.setSources(halos);
    this.halos.update(this.opts.reducedMotion ? 0 : now, night);
    this.stats = halos ? s : { ...s, lights: this.stats.lights };
  }

  private load(hash: string): void {
    const p = this.opts.fetch(hash).then((b) => void this.models.set(hash, modelFx(b)), (err) => {
      console.warn('effects: model', hash.slice(0, 12), err);
      this.models.set(hash, null);
    });
    this.models.set(hash, p);
  }

  /** Builds a thing's effects in its model's frame; false when its model has none of them. */
  private mount(e: Entry, m: ModelFx, frame: THREE.Matrix4): boolean {
    const root = new THREE.Group(), cheap = this.opts.phone;
    root.name = `effects ${e.id}`;
    root.matrixAutoUpdate = false;
    e.model = m;
    if (e.kind === 'lighthouse') {
      // today's beams sweep in world metres from the lantern; they are not scaled or turned with the tower
      e.beam = new Lighthouse(new THREE.Vector3(0, m.top * LANTERN_UP, 0).applyMatrix4(frame));
      this.group.add(e.beam.group);
    } else if (e.kind === 'light') {
      // a glow only: no mesh of its own
    } else if (e.kind === 'fire') {
      let i = 0;
      for (const part of m.flames) {
        const pivot = new THREE.Group();
        pivot.matrixAutoUpdate = false;
        pivot.matrix.copy(part.matrix);
        for (const c of part.clusters) {
          const kind = fireKindOf(c.r), fire = createFire(seedOf(`${e.origin}#${i++}`), c.r * 1.05, kind, c.h * 1.05);
          fire.group.position.set(c.p[0], c.p[1], c.p[2]);
          fire.group.visible = false;
          pivot.add(fire.group);
          e.fires.push({ fire, kind, level: -1 });
        }
        root.add(pivot);
      }
      if (!e.fires.length) e.kind = 'light'; // a light with no flame clusters still glows
    } else if (e.kind === 'fountain') {
      const plan = fountainPlan(m.discs, m.top);
      if (!plan) return false;
      e.water.push(fountainJets(plan, cheap), ...fallingWaterSheets(m.discs));
      root.add(...e.water);
    } else {
      const kind = e.kind as SteamKind, p = steam(kind, cheap);
      if (kind === 'kettle') p.position.copy(KETTLE_SPOUT.y < m.top + 0.05 ? KETTLE_SPOUT : new THREE.Vector3(0, m.top, 0));
      else p.position.set(0, m.top, 0);
      setSteam(p, 0, kind === 'kettle' ? KETTLE_JET : new THREE.Vector3(0, 0.02, 0));
      e.steam = p;
      root.add(p);
    }
    e.root = root;
    this.group.add(root);
    return true;
  }
}
