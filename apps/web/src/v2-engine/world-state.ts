// Stage 4 (#4176): things' state and the weather of a world the new engine runs, on the old page. The old page draws
// Eden's things from its entity layer (WorldEntityLayer: a snapshot, then `world-diff` edge messages); a door's leaf
// turns with its entity's `state.open` and a lamp lights with `state.on` (gen-mesh/vocab-look.ts, world-env.ts), and
// the sky's weather is the layer's `state.weather` (world-env.ts setWeatherOf). This module keeps what the v2 stream says
// of them (the reader worker's node records: a thing's kind state fields, the world node's sky fields) and, when the
// layer draws something else, makes the one `world-diff` that brings it to v2's state. Nothing here draws; the layer
// does, as it draws any diff. The world's clock (calendar fields 60, 61) already rides the chunks (bridge.ts datetime).
// A thing a Soul sets down elsewhere (B2-2: its node's parent or place changed since the stream first showed it, or,
// before the page opened, its first place is not where the captured scene has it) is moved to where v2 has it: an upsert at its world pose, which the layer eases there as it eases any moved thing. A
// thing in a body's hand is not (the bodies' adapter draws what is held).
import { TICK_US } from './takes.ts';

/** The reader's node record, the fields read here (v2/web/src/source/source.ts NodeRec). */
type NodeLike = { id: string; kind: string; parent: string | null; origin?: string; sky?: Record<number, unknown>; fields?: Record<number, unknown>;
  slot?: number | null; pos?: [number, number, number]; rot?: [number, number, number, number]; soul?: string | null; slots?: number[][] };
type Msg = { t: 'part'; p: { nodes: NodeLike[]; removed: string[] } } | { t: 'snapshot'; s: { nodes: NodeLike[]; removed: string[] } } | { t: string };

/** Doors and lamps: a kind's state fields (`content/kinds`, by `n`) and the entity state key the old page draws them by
 *  (the entry's own name: `open`, `on`, `lit`, `level`). */
const STATE: Record<string, [n: number, key: string, type: 'bool' | 'int'][]> = {
  door: [[6, 'open', 'bool']],
  bollard_light: [[28, 'on', 'bool']], desk_lamp: [[28, 'on', 'bool']], pendant: [[28, 'on', 'bool']], lamp_post: [[28, 'on', 'bool']],
  string_lights: [[28, 'on', 'bool']], twinkle_lights: [[28, 'on', 'bool']], floor_lamp: [[28, 'level', 'int']], crank_lamp: [[29, 'on', 'bool']],
  oil_lantern: [[29, 'lit', 'bool']], candle: [[28, 'lit', 'bool']], candle_stand: [[28, 'lit', 'bool']],
};
/** import-eden's field 27: the entry a thing borrows (a Mars chair is an `eden:chair`). */
const F_ENTRY = 27;
/** E6's weather fields (v2/web/src/sky/record.ts F): the kind, cloud, rain and wind 0 to 100, the next change (µs). */
const F_WEATHER = 75, F_CLOUD = 76, F_RAIN = 77, F_WIND = 78, F_WEATHER_NEXT = 79, F_DAY = 60, F_LIGHT = 70;
const KINDS = new Set(['clear', 'cloudy', 'rain', 'wind', 'fog', 'storm']);

const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : null);
const plainName = (k: string) => k.split('@')[0].split(':').pop() ?? '';

/** A door's or lamp's state as the old page's entity holds it, from its v2 fields; null for any other thing, or one
 *  that holds none of its fields yet (it is drawn as the layer has it). */
export function thingState(n: NodeLike): Record<string, boolean | number> | null {
  const entry = typeof n.fields?.[F_ENTRY] === 'string' ? (n.fields[F_ENTRY] as string) : n.kind;
  // a door by its kind or entry (`eden:door`, or a `…_door` kind); field 6 alone is not one: another kind may use it
  const name = plainName(entry), defs = STATE[name] ?? (name.endsWith('_door') ? STATE.door : undefined);
  if (!defs || !n.fields) return null;
  let out: Record<string, boolean | number> | null = null;
  for (const [f, key, type] of defs) {
    const v = whole(n.fields[f]);
    if (v !== null) (out ??= {})[key] = type === 'bool' ? v !== 0 : v;
  }
  return out;
}

/** The weather as the old page's world state holds a god's set weather (channels 0 to 1), from the world node's fields
 *  75-79; null before the world node holds its calendar. A wet kind ends at v2's next change (field 79, as a take tick). */
export type OldWeather = { kind: string; clouds: number; rain: number; wind: number; fog: number; intensity: number; until?: number };
export function weatherOf(sky: Record<number, unknown> | undefined | null): OldWeather | null {
  if (!sky || (!(F_DAY in sky) && !(F_LIGHT in sky))) return null;
  const name = typeof sky[F_WEATHER] === 'string' ? plainName(sky[F_WEATHER] as string) : 'clear';
  const level = (f: number) => Math.max(0, Math.min(1, (whole(sky[f]) ?? 0) / 100));
  const kind = KINDS.has(name) ? name : 'manual', next = whole(sky[F_WEATHER_NEXT]);
  const w: OldWeather = { kind, clouds: level(F_CLOUD), rain: level(F_RAIN), wind: level(F_WIND), fog: kind === 'fog' ? 1 : 0, intensity: 1 };
  // WEATHER-RULES: a wet setting is in force only before its `until`
  if (kind === 'rain' || kind === 'storm' || (kind === 'manual' && w.rain > 0.1)) w.until = next !== null ? Math.ceil(next / TICK_US) : Number.MAX_SAFE_INTEGER;
  return w;
}

/** Where a moved thing is now, in the old page's world frame (the same as v2's: metres, yaw about +y). */
export type Placed = { p: [number, number, number]; yaw: number };
type Q4 = [number, number, number, number];
const Q = 2 ** 30;
const rotate = (q: Q4, v: [number, number, number]): [number, number, number] => {
  const [w, x, y, z] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const mul = (a: Q4, b: Q4): Q4 => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
/** A body (bridge.ts isBody): a node with a public Soul, or one of a body kind. */
const isBody = (n: NodeLike) => !!n.soul || /:(humanoid|body)$/.test(n.kind.split('@')[0]);
const placeOf = (n: NodeLike) => JSON.stringify([n.parent, n.slot ?? null, n.pos, n.rot]);

/** A node's world pose from its chain of frames (positions µm, a slot adds its point, as bridge.ts V2Bridge.world), or
 *  null when a frame is not in the copy or one is a body (a thing in a hand). */
export function placedOf(nodes: ReadonlyMap<string, NodeLike>, id: string): Placed | null {
  let p: [number, number, number] = [0, 0, 0], q: Q4 = [1, 0, 0, 0];
  for (let n = nodes.get(id), depth = 0; ; depth++) {
    if (!n || !n.pos || !n.rot || depth > 32 || isBody(n)) return null;
    // this frame's pose in its parent's, then the parent's slot point, composed from the inside out
    const nq: Q4 = [n.rot[0] / Q, n.rot[1] / Q, n.rot[2] / Q, n.rot[3] / Q], r0 = rotate(nq, p);
    p = [n.pos[0] + r0[0], n.pos[1] + r0[1], n.pos[2] + r0[2]]; q = mul(nq, q);
    if (n.parent === null) break;
    const up = nodes.get(n.parent), slot = n.slot, s = slot != null ? up?.slots?.find((x) => x[0] === slot) : undefined;
    if (s) p = [p[0] + s[1] * 1000, p[1] + s[2] * 1000, p[2] + s[3] * 1000];
    n = up;
  }
  return { p: [p[0] / 1e6, p[1] / 1e6, p[2] / 1e6], yaw: 2 * Math.atan2(q[2], q[0]) };
}

/** The entity layer, the parts read here (WorldEntityLayer's model and diff sequence, private there, read as world-env.ts
 *  reads them). */
type EntityLike = { id: string; state?: Record<string, unknown>; in?: { parent: string; slot?: string }; p?: number[]; r?: number | number[]; s?: number };
export type LayerLike = { seq?: unknown; model?: { entities: Map<string, EntityLike>; state?: { weather?: unknown };
  worldPose?(e: EntityLike): { x: number; y: number; z: number; yaw: number; s: number }; readPass?<T>(fn: () => T): T } | null };
export type WorldDiff = { type: 'edge'; kind: 'world-diff'; seq: number; at: number; by: 'engine'; tick?: number;
  diff: { upserts: unknown[]; removes: string[]; defs: unknown[]; tiles: string[]; world?: { weather: OldWeather } } };

/** Whether the layer draws a thing at a place already: at the world's root there, to the millimetre and the milliradian. */
const turnBetween = (a: number, b: number) => Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
const placedAt = (e: EntityLike, to: Placed) => {
  const p = e.p, yaw = Array.isArray(e.r) ? e.r[0] : e.r ?? 0;
  return e.in?.parent === 'world' && p?.length === 3 && p.every((v, k) => Math.abs(v - to.p[k]) < 1e-3) && turnBetween(yaw, to.yaw) < 1e-3;
};
/** How far a first place may be from the captured scene's and still be the same place: import-eden rounds to the
 *  millimetre and the millidegree; a thing a Soul has set down elsewhere is further. */
const SAME_M = 0.02, SAME_RAD = 0.02;

const sameWeather = (a: unknown, b: OldWeather) => {
  const o = a as Partial<OldWeather> | null | undefined;
  return !!o && (Object.keys(b) as (keyof OldWeather)[]).every((k) => o[k] === b[k]) && (o.until === undefined) === (b.until === undefined);
};

/** The one diff that brings the layer to v2's state (next in its sequence), or null when it draws it already (or has no
 *  model yet). A thing whose entity the layer does not hold is left out. `ticks`: the take tick each thing's state (and,
 *  under '', the weather) was read at; the diff carries the latest, so the layer draws a door's or lamp's change when the
 *  page's picture reaches it (light-diff-clock.ts), not seconds before the bodies around it. */
export function worldDiff(layer: LayerLike | null | undefined, things: ReadonlyMap<string, Record<string, boolean | number>>, weather: OldWeather | null, at: number,
  ticks: ReadonlyMap<string, number> = new Map(), moved: ReadonlyMap<string, Placed> = new Map()): WorldDiff | null {
  const m = layer?.model, seq = layer?.seq;
  if (!m || typeof seq !== 'number') return null;
  const upserts: unknown[] = [];
  let tick = 0;
  for (const id of new Set([...things.keys(), ...moved.keys()])) {
    const e = m.entities.get(id), want = things.get(id), to = moved.get(id);
    if (!e) continue;
    let next: EntityLike = e;
    if (want && !Object.entries(want).every(([k, v]) => e.state?.[k] === v)) next = { ...next, state: { ...e.state, ...want } };
    if (to && !placedAt(e, to)) {
      // at the root of the world, where v2 has it: the layer's world pose of a root thing is its own (WorldModel.worldPose)
      const tilt = Array.isArray(e.r) ? e.r.slice(1) : [], s = e.in?.parent !== 'world' && m.worldPose ? m.worldPose(e).s : e.s;
      next = { ...next, in: { parent: 'world' }, p: [...to.p], r: tilt.length ? [to.yaw, ...tilt] : to.yaw, ...(s !== undefined ? { s } : {}) };
    }
    if (next === e) continue;
    upserts.push(next);
    tick = Math.max(tick, ticks.get(id) ?? 0);
  }
  const world = weather && !sameWeather(m.state?.weather, weather) ? { weather } : undefined;
  if (world) tick = Math.max(tick, ticks.get('') ?? 0);
  if (!upserts.length && !world) return null;
  return { type: 'edge', kind: 'world-diff', seq: seq + 1, at, by: 'engine', ...(tick > 0 ? { tick } : {}), diff: { upserts, removes: [], defs: [], tiles: [], ...(world ? { world } : {}) } };
}

/** What the v2 stream says of things' state and the weather, kept from the reader worker's messages. */
export class WorldState {
  /** Old entity id (a node's `origin`) → its door or lamp state. */
  readonly things = new Map<string, Record<string, boolean | number>>();
  private readonly origins = new Map<string, string>();
  /** Every node the stream holds (the frames a moved thing's world pose is composed through). */
  private readonly nodes = new Map<string, NodeLike>();
  /** Each thing's place (parent, slot, position, turn) when the stream first showed it: the captured world's. */
  private readonly first = new Map<string, string>();
  /** Things first shown and not yet compared with the captured scene (the layer's world pose of their entity). */
  private readonly unchecked = new Set<string>();
  /** Old entity id → where v2 has a thing that has moved since, while it is not in a hand. */
  readonly moved = new Map<string, Placed>();
  /** The take tick each state was read at (a part's end; 0 from a snapshot); '' is the weather's. */
  private readonly ticks = new Map<string, number>();
  /** The sequence number of the last diff handed to the page: each is sent once (the layer applies the first of a seq). */
  private sent: number | null = null;
  weather: OldWeather | null = null;

  /** Listens to the reader worker beside the bridge (which takes its `onmessage`); returns it. */
  watch<W extends { addEventListener(type: 'message', fn: (e: MessageEvent) => void): void }>(w: W): W {
    w.addEventListener('message', (e: MessageEvent) => this.receive(e.data as Msg));
    return w;
  }

  receive(m: Msg): void {
    const c = m.t === 'part' ? (m as { p: { nodes: NodeLike[]; removed: string[]; to?: number } }).p : m.t === 'snapshot' ? (m as { s: { nodes: NodeLike[]; removed: string[] } }).s : null;
    if (!c) return;
    // a node record does not say when in its part it changed: its end, so a change is never drawn before it happened
    const tick = 'to' in c && typeof c.to === 'number' ? Math.ceil(c.to / TICK_US) : 0;
    for (const id of c.removed) {
      this.nodes.delete(id);
      const o = this.origins.get(id); if (o) { this.things.delete(o); this.moved.delete(o); this.ticks.delete(o); this.origins.delete(id); }
    }
    let moves = false;
    for (const n of c.nodes) {
      this.nodes.set(n.id, n);
      if (n.parent === null && n.sky) { const w = weatherOf(n.sky); if (w) { this.weather = w; this.ticks.set('', tick); } }
      if (!n.origin) continue;
      const s = thingState(n);
      if (s) { this.things.set(n.origin, s); this.ticks.set(n.origin, tick); this.origins.set(n.id, n.origin); }
      // a thing of the captured world (an old entity id, not a building's room or floor) whose place has changed
      if (!n.pos || n.origin.includes('/')) continue;
      const at = placeOf(n), was = this.first.get(n.id);
      if (was === undefined) { this.first.set(n.id, at); this.unchecked.add(n.id); }
      else if (was !== at || this.moved.has(n.origin)) { this.origins.set(n.id, n.origin); this.ticks.set(n.origin, tick); moves = true; }
    }
    // a moved thing's world pose, again with every part that moves one (its frame may be what moved); while it is in a
    // hand it is left where it was last at rest
    if (moves) for (const [id, o] of this.origins) {
      const n = this.nodes.get(id);
      if (!n?.pos || (!this.moved.has(o) && this.first.get(id) === placeOf(n))) continue;
      const w = placedOf(this.nodes, id);
      if (w) this.moved.set(o, w);
    }
  }

  /** Things moved before the page opened: a resting thing whose first place in the stream is not where the layer's
   *  captured scene has it. Each is compared once, when the layer has its model. */
  private check(layer: LayerLike | null | undefined): void {
    const m = layer?.model;
    if (!m?.worldPose || !this.unchecked.size) return;
    const pass = () => {
      for (const id of this.unchecked) {
        const n = this.nodes.get(id), e = n?.origin ? m.entities.get(n.origin) : undefined;
        // a path or an area is world-frame geometry, not a thing set down
        if (!n?.origin || !e || (e as { shape?: unknown }).shape) continue;
        let was: ReturnType<NonNullable<typeof m.worldPose>>;
        try { was = m.worldPose!(e); } catch { continue; }
        const w = placedOf(this.nodes, id);
        if (!w || (Math.hypot(w.p[0] - was.x, w.p[1] - was.y, w.p[2] - was.z) < SAME_M && turnBetween(w.yaw, was.yaw) < SAME_RAD)) continue;
        this.moved.set(n.origin, w); this.origins.set(id, n.origin);
      }
      this.unchecked.clear();
    };
    if (m.readPass) m.readPass(pass); else pass();
  }

  /** The diff for the page's entity layer now, or null (see worldDiff). */
  diff(layer: LayerLike | null | undefined, at: number): WorldDiff | null { this.check(layer); return worldDiff(layer, this.things, this.weather, at, this.ticks, this.moved); }

  /** The diff to append to the page's edge log now, or null: once per sequence number (while the layer has not applied
   *  it, the same seq is not sent again; whatever is still unlike v2 after it goes in the next). */
  next(layer: LayerLike | null | undefined, at: number): WorldDiff | null {
    const d = this.diff(layer, at);
    if (!d || d.seq === this.sent) return null;
    this.sent = d.seq;
    return d;
  }
}

/** The page's edge log with one message appended, kept as the old socket keeps it (useSouls.ts: the last 300). */
export function appendEdge<T>(log: readonly T[], m: T): T[] { return [...log, m].slice(-300);
}

/** B2-4: the page's one edge log on a v2 world: what the Souls said aloud (the bridge's speech, replaced whole as it
 *  grows) and the world diffs (appended), together. A diff stays in it until it falls out of the last 300, however
 *  often the speech changes: the layer may hold one until the picture reaches its tick (applyEdge), and it is sent once. */
export class EdgeLog<T = unknown> {
  private world: T[] = [];
  private speech: readonly T[] | null = null;
  edge: readonly T[] = [];
  step(speech: readonly T[], diff: T | null): readonly T[] {
    if (diff) this.world = appendEdge(this.world, diff);
    if (diff || speech !== this.speech) { this.speech = speech; this.edge = [...speech, ...this.world]; }
    return this.edge;
  }
}
