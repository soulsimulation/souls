// wind-down/1 (#2295, maintainer 13 Nov 2026; tranche #2241). A Soul moves only when its agent tells it to, until its
// agent has been silent for an hour. Then the world takes the body back, walks it out of town and puts it to sleep, where
// it stays until its agent acts again. Every time is a world tick (20 a second):
//
//   Owned    from each agent act: nothing is issued. An act is a logged `decision` of the Soul with trigger `edge-act:*` or
//            `shared-commit:*` (every body act and every plan step) that does not carry `reflex: true`. Listening,
//            reading and the client's away note are not acts.
//   Wander   `wanderTicks` after the last act: whatever is held ends and the body stands; then every `legMin`–`legMax`
//            ticks one slow walk of `legM` metres whose end is farther from the town's centre than its start.
//   Zombie   `zombieTicks` after Wander starts: one shuffle to its sleeping spot, the nearest open ground outside the
//            built area at least `spotGapM` from another Soul's spot. A body that cannot move now tries again every
//            `legMin` ticks.
//   Asleep   on arrival (or at the latest `boundTicks` after Wander started, where it stands): it lies down in one held
//            sleep with no end. Nothing is issued again.
//   Woken    the next agent act ends the rule's hold; the act itself runs.
//
// The rule reads no wall clock and no presence. Its inputs are the tick, the log and world state; its choices come from a
// hash of the Soul's id and a counter, never from the world RNG. Every move is an ordinary logged decision (trigger
// `edge-body`) carrying the rule's state (`windDown`), so the state is rebuilt from the log at boot; `edge_body_v1` is a
// cache of it and of the public body. The public words stay those of LINK BODY: Owned is `awake`, Wander is `idle`,
// Zombie is `zombie`, Asleep is `asleep`.
import type {Program} from '@souls/engine-contract';

export type BodyState = 'awake' | 'idle' | 'zombie' | 'asleep';
export type BodyDoing = 'standing' | 'sitting' | 'dozing' | 'drifting' | 'floating' | null;
export type BodyView = {state: BodyState; doing: BodyDoing; since: number};
export type BodyKnobs = {wanderTicks: number; zombieTicks: number; legMinTicks: number; legMaxTicks: number; boundTicks: number;
  legMinM: number; legMaxM: number; spotGapM: number; spotSearchM: number};
/** The maintainer's defaults (13 Nov 2026). A test world (SIM_BODY_KNOBS) or a TEST Soul (op-souls.ts) may shorten them. */
export const BODY_KNOBS: Readonly<BodyKnobs> = Object.freeze({
  wanderTicks: 72_000, zombieTicks: 36_000, legMinTicks: 2_400, legMaxTicks: 4_800, boundTicks: 60_000,
  legMinM: 5, legMaxM: 15, spotGapM: 3, spotSearchM: 80,
});
export const BODY_PATH_SAMPLE_M = 0.25;
/** Ticks before the bound at which a body still walking is stopped, so it lies down before the bound. */
const SETTLE_TICKS = 100;
/** How the body is held right now (read from the engine by the ledger). `standby`: a rolling body in its upright rest. */
export type Posture = 'standing' | 'moving' | 'seated' | 'lying' | 'standby' | 'water' | 'basket' | 'other';
export type BodySoul = {soulId: string; entityId: string; name: string; owner: string};
export type WindDownPhase = 'wander' | 'leg' | 'zombie' | 'asleep';
/** The rule's state, carried by every decision it logs: enough to rebuild it from the log. */
export type WindDown = {rule: 'wind-down/1'; phase: WindDownPhase; at: number; last: number; wander: number; zombie: number | null; spot?: [number, number] | null};

/** What the rule needs from the world (the Ledger implements it; tests may fake it). */
export type BodyPort = {
  /** Live owned Souls whose body is in this world now (not away by travel). */
  souls(): BodySoul[];
  pose(entityId: string): {x: number; z: number; level: number} | null;
  posture(entityId: string): Posture;
  /** The body is held by an act that is not the rule's (an open receipt, a waiting act, an invitation, hands held). */
  busy(soulId: string): boolean;
  running(entityId: string): boolean;
  /** False until the initial enclosed-place index is published. */
  spatialReady?(): boolean;
  /** Dry standing ground here (no water, no wading). */
  dry(x: number, z: number): boolean;
  /** Free room for a body here; `lying`: room to lie down. */
  clear(x: number, z: number, level: number, lying?: boolean): boolean;
  /** The enclosed places (rooms, buildings) containing this point, as one key; '' outdoors. */
  places(x: number, z: number, level: number): string;
  /** The town's centre on the ground. */
  centre(): [number, number];
  /** A body that cannot lie down (a rolling body): it sleeps where it stands. */
  upright?(entityId: string): boolean;
  decide(soul: BodySoul, option: string, label: string, steps: Program['steps'], windDown: WindDown): void;
  stop(soul: BodySoul): void;
  publish(soulId: string, view: BodyView): void;
  /** The wall time of a world tick, for the public `since` only (never read by the rule). */
  wallMs(tick: number): number;
};

type SqlDb = {exec(sql: string): void; prepare(sql: string): {get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown; iterate?(...a: unknown[]): Iterable<unknown>}};
/** One Soul's rule state. `wander` null: Owned. `zombie`: the tick its walk out was issued. */
type St = {last: number; wander: number | null; zombie: number | null; slept: boolean; next: number | null; spot: [number, number] | null};
type Row = {soul_id: string; state: BodyState; doing: BodyDoing; since: number; rule: string | null; last_act: number; wander_at: number | null; zombie_at: number | null; slept: number | null;
  anchor_x: number | null; anchor_z: number | null; knobs: string | null};

const mix = (s: string, n: number) => {let h = 2166136261 ^ n; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296;};
/** An agent act in the log: a body act or plan step of the Soul, not marked as the client's own reflex. */
export const isAgentAct = (kind: string, p: {trigger?: unknown; reflex?: unknown} | null | undefined) =>
  kind === 'decision' && typeof p?.trigger === 'string' && /^(edge-act:|shared-commit:)/.test(p.trigger) && p.reflex !== true;

export class BodyRule {
  private readonly db: SqlDb; private readonly worldId: string; private readonly port: BodyPort; private readonly base: BodyKnobs;
  private readonly st = new Map<string, St>();
  private booted = false;
  /** Waking limit (load/waking.ts): no longer consulted. A Soul wakes only by its own act, which the limit refuses upstream. */
  mayWake?: (soulId: string) => boolean;
  constructor(db: SqlDb, worldId: string, port: BodyPort, options: {knobs?: Partial<BodyKnobs>} = {}) {
    this.db = db; this.worldId = worldId; this.port = port; this.base = {...BODY_KNOBS, ...clean(options.knobs ?? {})};
    db.exec(`CREATE TABLE IF NOT EXISTS edge_body_v1 (world_id TEXT NOT NULL, soul_id TEXT NOT NULL, state TEXT NOT NULL, doing TEXT, since INTEGER NOT NULL,
      anchor_x REAL, anchor_z REAL, last_act INTEGER NOT NULL, poke_at INTEGER NOT NULL, woke_at INTEGER NOT NULL, busy_at INTEGER NOT NULL,
      idle_from INTEGER NOT NULL, next_at INTEGER NOT NULL, n INTEGER NOT NULL, knobs TEXT, PRIMARY KEY (world_id, soul_id)) WITHOUT ROWID`);
    // wind-down/1: the LINK BODY table gains the rule's own columns; a row with `rule` NULL is the old rule's
    const have = new Set((db.prepare('PRAGMA table_info(edge_body_v1)').all() as {name: string}[]).map(c => c.name));
    for (const [c, t] of [['rule', 'TEXT'], ['wander_at', 'INTEGER'], ['zombie_at', 'INTEGER'], ['slept', 'INTEGER']]) if (!have.has(c)) db.exec(`ALTER TABLE edge_body_v1 ADD COLUMN ${c} ${t}`);
  }
  private row(soulId: string) {return this.db.prepare('SELECT * FROM edge_body_v1 WHERE world_id=? AND soul_id=?').get(this.worldId, soulId) as Row | undefined;}
  private save(soulId: string, s: St, view?: {state: BodyState; doing: BodyDoing; since: number}) {
    const old = this.row(soulId), v = view ?? (old ? {state: old.state, doing: old.doing, since: old.since} : this.viewOf(s, 0));
    this.db.prepare(`INSERT INTO edge_body_v1 (world_id,soul_id,state,doing,since,anchor_x,anchor_z,last_act,poke_at,woke_at,busy_at,idle_from,next_at,n,knobs,rule,wander_at,zombie_at,slept)
      VALUES (?,?,?,?,?,?,?,?,0,0,0,0,?,0,?,'wind-down/1',?,?,?) ON CONFLICT (world_id,soul_id) DO UPDATE SET state=excluded.state,doing=excluded.doing,since=excluded.since,
      anchor_x=excluded.anchor_x,anchor_z=excluded.anchor_z,last_act=excluded.last_act,next_at=excluded.next_at,rule=excluded.rule,wander_at=excluded.wander_at,zombie_at=excluded.zombie_at,slept=excluded.slept`)
      .run(this.worldId, soulId, v.state, v.doing, v.since, s.spot?.[0] ?? null, s.spot?.[1] ?? null, s.last, s.next ?? -1, old?.knobs ?? null, s.wander, s.zombie, s.slept ? 1 : 0);
  }
  knobs(soulId: string, r = this.row(soulId)): BodyKnobs {
    if (!r?.knobs) return this.base;
    try {return {...this.base, ...clean(JSON.parse(r.knobs) as Partial<BodyKnobs>)};} catch {return this.base;}
  }
  /** TEST Souls only (op-souls.ts) or test worlds: shorten this Soul's clocks. `null` restores the defaults. */
  setKnobs(soulId: string, knobs: Partial<BodyKnobs> | null) {
    const c = clean(knobs ?? {});
    if (!this.row(soulId)) this.save(soulId, this.st.get(soulId) ?? {last: 0, wander: null, zombie: null, slept: false, next: null, spot: null}, {state: 'awake', doing: null, since: 0});
    this.db.prepare('UPDATE edge_body_v1 SET knobs=? WHERE world_id=? AND soul_id=?').run(knobs && Object.keys(c).length ? JSON.stringify(c) : null, this.worldId, soulId);
    const s = this.st.get(soulId); if (s) s.next = this.due(soulId, s, this.now);
    return this.knobs(soulId);
  }
  /** The public body (contract `body`), or null for a Soul the rule has not seen. */
  view(soulId: string): BodyView | null {const r = this.row(soulId); return r ? {state: r.state, doing: r.doing, since: r.since} : null;}
  /** Bodies the rule holds (ambient life leaves them alone): anything but Owned. */
  reflexOwns(soulId: string) {const s = this.st.get(soulId); return !!s && s.wander !== null;}
  /** #2297 `moveTick`: the next tick at which the rule moves a body, or null when none is due (every Soul asleep). */
  nextMoveTick(): number | null {let t: number | null = null; for (const s of this.st.values()) if (s.next !== null && (t === null || s.next < t)) t = s.next; return t;}

  /** A logged event was applied (live, never during replay): an agent act makes its Soul Owned from this tick. */
  applied(e: {tick: number; kind: string; payload: unknown}) {
    const p = e.payload as {soulId?: string; trigger?: unknown; reflex?: unknown} | null;
    if (!p?.soulId || !(isAgentAct(e.kind, p) || e.kind === 'birth')) return;
    const s: St = {last: e.tick, wander: null, zombie: null, slept: false, next: null, spot: null};
    s.next = this.due(p.soulId, s, e.tick); this.st.set(p.soulId, s);
    this.publishIf(p.soulId, s, e.tick);
  }
  /** LINK migration (a Soul the old idle beam took, now back as a body): it enters Wander at its next tick (A7). */
  restoreAsleep(soul: BodySoul) {this.migrate.add(soul.soulId);}
  private readonly migrate = new Set<string>();
  private now = 0;

  /** Every tick: nothing to do unless a move is due; new Souls are looked for once a second. */
  tick(tick: number) {
    this.now = tick;
    if (!this.booted) {this.booted = true; this.boot(tick);}
    const due = this.nextMoveTick();
    if (tick % 20 !== 0 && (due === null || tick < due) && !this.migrate.size) return;
    const here = this.port.souls(), ids = new Set(here.map(x => x.soulId));
    for (const id of [...this.st.keys()]) if (!ids.has(id)) this.st.delete(id);
    for (const soul of here) {
      const migrate = this.migrate.delete(soul.soulId);
      if (migrate || !this.st.has(soul.soulId)) this.adopt(soul, tick, migrate);
      const s = this.st.get(soul.soulId)!;
      if (s.next === null || tick < s.next) continue;
      if (this.port.spatialReady?.() === false) {s.next = tick + 1; continue;}
      try {this.step(soul, s, tick);} catch (e) {console.error('[body]', soul.soulId, e instanceof Error ? e.message : e); s.next = tick + this.knobs(soul.soulId).legMinTicks;}
    }
  }
  /** Boot: every Soul's state from the log, newest first: its last agent act, or the rule's own last decision after it. */
  private boot(tick: number) {
    const want = new Set(this.port.souls().map(s => s.soulId)), found = new Map<string, St>();
    if (want.size) {
      const q = this.db.prepare(`SELECT tick, kind, payload FROM events WHERE world_id=? AND kind IN ('decision','birth') ORDER BY seq DESC`);
      const rows = (q.iterate ? q.iterate(this.worldId) : q.all(this.worldId)) as Iterable<{tick: number; kind: string; payload: string}>;
      for (const r of rows) {
        let p: {soulId?: string; trigger?: unknown; reflex?: unknown; windDown?: WindDown};
        try {p = JSON.parse(r.payload) as typeof p;} catch {continue;}
        const id = p.soulId; if (!id || !want.has(id) || found.has(id)) continue;
        const w = p.trigger === 'edge-body' ? p.windDown : undefined;
        if (w?.rule === 'wind-down/1') found.set(id, {last: w.last, wander: w.wander, zombie: w.zombie, slept: w.phase === 'asleep', next: null, spot: w.spot ?? null});
        else if (isAgentAct(r.kind, p) || r.kind === 'birth') found.set(id, {last: r.tick, wander: null, zombie: null, slept: false, next: null, spot: null});
        else continue;
        if (found.size === want.size) break;
      }
    }
    for (const [id, s] of found) {
      // the cache may know more than the log of the same act (a wander start the guard refused is not logged)
      const r = this.row(id), kn = this.knobs(id);
      // a Wander the cache started earlier than the hour after this act: an A7 migration whose first decision the log missed
      if (r?.rule === 'wind-down/1' && s.wander === null && r.wander_at !== null && r.wander_at >= s.last && r.wander_at < s.last + kn.wanderTicks) Object.assign(s, {last: r.last_act, wander: r.wander_at, zombie: r.zombie_at, slept: !!r.slept});
      else if (r && r.rule === null && r.state !== 'awake') this.enterWander(s, tick);   // A7: the old rule's idle, zombie or asleep body
      if (s.wander === null && tick > s.last + kn.wanderTicks) s.wander = s.last + kn.wanderTicks;
      if (!s.spot && r?.rule === 'wind-down/1' && r.last_act === s.last && r.anchor_x !== null && r.anchor_z !== null) s.spot = [r.anchor_x, r.anchor_z];
      s.next = this.due(id, s, tick); this.st.set(id, s);
    }
  }
  /** A Soul the log does not name (a new Soul whose birth is not in this log, or a migration): its state starts now. */
  private adopt(soul: BodySoul, tick: number, migrate: boolean) {
    const r = this.row(soul.soulId), mine = r?.rule === 'wind-down/1';
    const s: St = this.st.get(soul.soulId) ?? {last: mine ? r.last_act : tick, wander: mine ? r.wander_at : null, zombie: mine ? r.zombie_at : null, slept: mine && !!r.slept, next: null,
      spot: mine && r.anchor_x !== null && r.anchor_z !== null ? [r.anchor_x, r.anchor_z] : null};
    if (migrate || (r && r.rule === null && r.state !== 'awake')) this.enterWander(s, tick);
    s.next = this.due(soul.soulId, s, tick); this.st.set(soul.soulId, s); this.publishIf(soul.soulId, s, tick);
  }
  /** A7: a body the old rule held enters Wander at this tick (as if its agent's last act were an hour ago). */
  private enterWander(s: St, tick: number) {Object.assign(s, {last: tick - this.base.wanderTicks, wander: null, zombie: null, slept: false});}

  /** The tick of Wander's k-th leg (k ≥ 1), from the Soul's id and the tick Wander started. */
  private leg(soulId: string, wander: number, k: number, kn: BodyKnobs) {
    let t = wander; for (let j = 1; j <= k; j++) t += kn.legMinTicks + Math.floor((kn.legMaxTicks - kn.legMinTicks + 1) * mix(`${soulId}:${wander}`, j)); return t;
  }
  /** The next tick at which the rule acts on this Soul at or after `from`, or null (asleep). */
  private due(soulId: string, s: St, from: number): number | null {
    const kn = this.knobs(soulId);
    if (s.slept) return null;
    if (s.wander === null) return Math.max(from, s.last + kn.wanderTicks);
    const zombieAt = s.wander + kn.zombieTicks, stopAt = s.wander + kn.boundTicks - SETTLE_TICKS, lieAt = stopAt + SETTLE_TICKS / 2;
    if (from < zombieAt) {let k = 1, t = this.leg(soulId, s.wander, k, kn); while (t < from) t = this.leg(soulId, s.wander, ++k, kn); return Math.min(t, zombieAt);}
    if (s.zombie === null) {const n = Math.ceil(Math.max(0, from - zombieAt) / kn.legMinTicks), t = zombieAt + n * kn.legMinTicks; return from >= stopAt ? Math.max(from, lieAt) : Math.min(t, stopAt);}
    // walking out: look once a second for its arrival; stop it before the bound
    const look = Math.ceil(from / 20) * 20;
    return from <= stopAt ? Math.min(look, stopAt) : Math.max(look, lieAt);
  }
  private step(soul: BodySoul, s: St, tick: number) {
    const kn = this.knobs(soul.soulId), id = soul.soulId;
    if (s.wander === null) {   // Wander starts: whatever is held ends and the body stands
      s.wander = tick;
      if (this.port.running(soul.entityId)) this.port.stop(soul);
      if (this.port.posture(soul.entityId) !== 'water') this.decide(soul, s, 'wander', 'body:wander', 'Standing up, at a loose end', [{verb: 'stand', params: {}}], tick);
    } else if (tick < s.wander + kn.zombieTicks) this.wanderLeg(soul, s, tick, kn);
    else if (s.zombie === null && tick < s.wander + kn.boundTicks - SETTLE_TICKS) this.walkOut(soul, s, tick, kn);
    else if (s.zombie !== null && tick < s.wander + kn.boundTicks - SETTLE_TICKS) {if (!this.port.running(soul.entityId)) this.lieDown(soul, s, tick);}
    else if (tick < s.wander + kn.boundTicks - SETTLE_TICKS / 2) {if (this.port.running(soul.entityId)) this.port.stop(soul);}   // the bound: stop where it is
    else this.lieDown(soul, s, tick);
    s.next = this.due(id, s, tick + 1); this.save(id, s); this.publishIf(id, s, tick);
  }
  private free(soul: BodySoul) {const p = this.port.posture(soul.entityId); return !this.port.busy(soul.soulId) && !this.port.running(soul.entityId) && p !== 'basket' && p !== 'water';}
  /** One slow walk of 5–15 m whose end is farther from the town's centre than its start; none when the body cannot move now. */
  private wanderLeg(soul: BodySoul, s: St, tick: number, kn: BodyKnobs) {
    const at = this.port.pose(soul.entityId); if (!at || !this.free(soul)) return;
    const [cx, cz] = this.port.centre(), d0 = Math.hypot(at.x - cx, at.z - cz), out = d0 > 1e-6 ? Math.atan2(at.z - cz, at.x - cx) : 0;
    for (let n = 0; n < 12; n++) {
      const ang = out + (mix(`${soul.soulId}:a:${tick}`, n) - 0.5) * (d0 > 1e-6 ? Math.PI * 0.9 : Math.PI * 2), d = kn.legMinM + (kn.legMaxM - kn.legMinM) * mix(`${soul.soulId}:d:${tick}`, n);
      const x = round(at.x + Math.cos(ang) * d), z = round(at.z + Math.sin(ang) * d);
      if (Math.hypot(x - cx, z - cz) <= d0 || !this.port.dry(x, z) || !this.port.clear(x, z, 0)) continue;
      this.decide(soul, s, 'leg', 'body:wander-walk', 'Wandering off', [{verb: 'walk_to', params: {to: [x, z], pace: 'shuffle'}}], tick);
      return;
    }
  }
  /** The walk out: one shuffle to the sleeping spot (where it stands when that is the spot). */
  private walkOut(soul: BodySoul, s: St, tick: number, kn: BodyKnobs) {
    const at = this.port.pose(soul.entityId); if (!at || !this.free(soul)) return;
    const spot = this.spot(soul, at, kn) ?? [at.x, at.z];
    s.zombie = tick; s.spot = spot;
    if (Math.hypot(spot[0] - at.x, spot[1] - at.z) < 0.5) return this.lieDown(soul, s, tick);
    this.decide(soul, s, 'zombie', 'body:zombie-walk', 'Shuffling off to sleep', [{verb: 'walk_to', params: {to: spot, pace: 'shuffle'}}], tick);
  }
  /** Asleep: one held sleep with no end (none in water, a basket or on a body that cannot lie down). */
  private lieDown(soul: BodySoul, s: St, tick: number) {
    if (s.zombie === null) s.zombie = tick;
    s.slept = true;
    if (!s.spot) {const at = this.port.pose(soul.entityId); if (at) s.spot = [round(at.x), round(at.z)];}   // where it lies is its spot
    const p = this.port.posture(soul.entityId);
    if (p === 'water' || p === 'basket' || this.port.upright?.(soul.entityId)) {this.save(soul.soulId, s); return;}
    const up: Program['steps'] = p === 'seated' ? [{verb: 'stand', params: {}}] : [];
    this.decide(soul, s, 'asleep', 'body:asleep', 'Sleeping', [...up, {verb: 'mars:pose_v1', params: {activity: 'nap', seconds: 3600, endless: true}}], tick);
  }
  /** The nearest open ground outside the built area: outdoors with 3 m of outdoors around it, dry, room to lie down, and
   *  `spotGapM` from every other Soul's spot. Rings around the body, each starting at an angle from the Soul's id. */
  private spot(soul: BodySoul, at: {x: number; z: number; level: number}, kn: BodyKnobs): [number, number] | null {
    const others: [number, number][] = [];
    for (const [id, o] of this.st) if (id !== soul.soulId && o.spot) others.push(o.spot);
    const open = (x: number, z: number) => this.port.places(x, z, 0) === '' && [[3, 0], [-3, 0], [0, 3], [0, -3]].every(([dx, dz]) => this.port.places(x + dx, z + dz, 0) === '')
      && this.port.dry(x, z) && this.port.clear(x, z, 0, true) && others.every(([ox, oz]) => Math.hypot(ox - x, oz - z) >= kn.spotGapM);
    const a0 = mix(soul.soulId + ':spot', 0) * Math.PI * 2;
    if (at.level === 0 && open(round(at.x), round(at.z))) return [round(at.x), round(at.z)];
    for (let r = 1.5; r <= kn.spotSearchM; r += 1.5) {
      const n = Math.ceil(2 * Math.PI * r / 1.5);
      for (let i = 0; i < n; i++) {const a = a0 + i * 2 * Math.PI / n, x = round(at.x + Math.cos(a) * r), z = round(at.z + Math.sin(a) * r); if (open(x, z)) return [x, z];}
    }
    return null;
  }
  private decide(soul: BodySoul, s: St, phase: WindDownPhase, option: string, label: string, steps: Program['steps'], tick: number) {
    this.port.decide(soul, option, label, steps, {rule: 'wind-down/1', phase, at: tick, last: s.last, wander: s.wander!, zombie: s.zombie, ...(s.spot ? {spot: s.spot} : {})});
  }
  private viewOf(s: St, tick: number, entityId?: string): BodyView {
    const p = entityId ? this.port.posture(entityId) : 'standing';
    if (s.wander === null) return {state: 'awake', doing: null, since: this.port.wallMs(s.last)};
    if (s.slept) return {state: 'asleep', doing: p === 'water' ? 'floating' : p === 'seated' || p === 'basket' ? 'sitting' : this.port.upright?.(entityId ?? '') ? 'standing' : 'dozing', since: this.port.wallMs(s.zombie ?? tick)};
    if (s.zombie !== null) return {state: 'zombie', doing: 'drifting', since: this.port.wallMs(s.zombie)};
    return {state: 'idle', doing: p === 'water' ? 'floating' : 'drifting', since: this.port.wallMs(s.wander)};
  }
  private publishIf(soulId: string, s: St, tick: number) {
    const soul = this.port.souls().find(x => x.soulId === soulId), v = this.viewOf(s, tick, soul?.entityId), r = this.row(soulId);
    if (r && r.state === v.state && r.doing === v.doing && r.rule !== null) {this.save(soulId, s); return;}
    this.save(soulId, s, v); this.port.publish(soulId, v);
  }
}
const round = (v: number) => Math.round(v * 100) / 100;
function clean(k: Partial<BodyKnobs>): Partial<BodyKnobs> {
  const out: Partial<BodyKnobs> = {};
  for (const [key, v] of Object.entries(k)) if (key in BODY_KNOBS && typeof v === 'number' && Number.isFinite(v) && v >= 0) (out as Record<string, number>)[key] = v;
  return out;
}
