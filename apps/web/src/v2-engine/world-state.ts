// Stage 4 (#4176): things' state and the weather of a world the new engine runs, on the old page. The old page draws
// Eden's things from its entity layer (WorldEntityLayer: a snapshot, then `world-diff` edge messages); a door's leaf
// turns with its entity's `state.open`, a lamp lights and a fire burns with `state.on` or `state.lit`
// (gen-mesh/vocab-look.ts, world-env.ts), a basket fills with `state.fruit`: each thing's kind state fields (its
// `content/kinds` entry's, by number) are named by its entry and given to its old def by the def's own keys
// (`drawnState`: an entry's `lit` is an older def's `on`), and the sky's weather is the layer's `state.weather`
// (world-env.ts setWeatherOf). This module keeps what the v2 stream says
// of them (the reader worker's node records: a thing's kind state fields, the world node's sky fields) and, when the
// layer draws something else, makes the one `world-diff` that brings it to v2's state. Nothing here draws; the layer
// does, as it draws any diff. The world's clock (calendar fields 60, 61) already rides the chunks (bridge.ts datetime).
// A thing a Soul sets down elsewhere (B2-2: its node's parent or place changed since the stream first showed it, or,
// before the page opened, its first place is not where the captured scene has it) is moved to where v2 has it: an upsert at its world pose, which the layer eases there as it eases any moved thing. A
// thing in a body's hand is not: the bodies' adapter draws what is held, so the layer's copy is removed while it is
// held (a book picked up from a table is not also drawn on the table), and drawn again, where v2 has it, once it is
// set down. A thing the stream no longer holds (eaten, put away) is removed from the layer too.
import { TICK_US } from './takes.ts';

/** The reader's node record, the fields read here (v2/web/src/source/source.ts NodeRec). */
type NodeLike = { id: string; kind: string; parent: string | null; origin?: string; sky?: Record<number, unknown>; fields?: Record<number, unknown>;
  tint?: [string, number][]; slot?: number | null; pos?: [number, number, number]; rot?: [number, number, number, number]; soul?: string | null; slots?: number[][] };
type Msg = { t: 'part'; p: { nodes: NodeLike[]; removed: string[] } } | { t: 'snapshot'; s: { nodes: NodeLike[]; removed: string[] } } | { t: string };

/** A content kind's state fields a look can read, by the entry's own name (`lit`, `on`, `open`, `fruit`): its field
 *  number `n`, its type, its default (a bool as 0 or 1; what a node that never set it holds) and an enum's values
 *  (the build's `kind-state.json` from `content/kinds`: kind-bounds.ts). */
export type KindFields = Record<string, [n: number, type: string, dflt?: number | string | null, values?: string[]]>;
/** Without the build's table (tests, a page built before it): doors, lamps, fires and a radio. */
const FALLBACK: Record<string, KindFields> = {
  door: { open: [6, 'bool'] },
  bollard_light: { on: [28, 'bool'] }, desk_lamp: { on: [28, 'bool'] }, pendant: { on: [28, 'bool'] }, lamp_post: { on: [28, 'bool'] },
  string_lights: { on: [28, 'bool'] }, twinkle_lights: { on: [28, 'bool'] }, floor_lamp: { level: [28, 'int'] }, crank_lamp: { on: [29, 'bool'] },
  oil_lantern: { lit: [29, 'bool'] }, candle: { lit: [28, 'bool'] }, candle_stand: { lit: [28, 'bool'] }, campfire: { lit: [28, 'bool', 0] },
  // R3: a radio, on and its station (`content/kinds/music/radio.json`), which the old page's sound and dial read.
  radio: { on: [28, 'bool'], station: [29, 'enum'] },
};
/** The build's table by plain kind name (`eden:campfire` and `mars:campfire` are both `campfire`'s; the full name wins). */
const byPlain = (kinds: Record<string, KindFields>) => {
  const out: Record<string, KindFields> = {};
  for (const [k, f] of Object.entries(kinds)) { const p = k.split(':').pop()!; if (!out[p] || k.startsWith('eden:')) out[p] = f; }
  return out;
};
/** The content kinds' state fields the page names things' fields by (`setKindFields`); until they are here, FALLBACK. */
let TABLE: Record<string, KindFields> = {}, PLAIN: Record<string, KindFields> = {};
/** The build's table of each content kind's state fields, once fetched (use-v2-souls.ts). */
export function setKindFields(t: Record<string, KindFields>): void { TABLE = t; PLAIN = byPlain(t); }
/** import-eden's field 27: the entry a thing borrows (a Mars chair is an `eden:chair`). */
const F_ENTRY = 27;
/** E6's weather fields (v2/web/src/sky/record.ts F): the kind, cloud, rain and wind 0 to 100, the next change (µs). */
const F_WEATHER = 75, F_CLOUD = 76, F_RAIN = 77, F_WIND = 78, F_WEATHER_NEXT = 79, F_DAY = 60, F_LIGHT = 70;
const KINDS = new Set(['clear', 'cloudy', 'rain', 'wind', 'fog', 'storm']);

const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : null);
const plainName = (k: string) => k.split('@')[0].split(':').pop() ?? '';

/** R4 (0.134): a creator's tint as the entity's `state.tint` (gen-mesh/vocab-look.ts draws it): `#rrggbb` for the whole
 *  thing, then `<part>=#rrggbb` for each part, space-separated; '' once undone (no tint); undefined when the thing was
 *  never recoloured, so its state is left as the layer has it. */
export function tintState(rows: [string, number][] | undefined): string | undefined {
  if (!rows) return undefined;
  const hex = (c: number) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
  const whole = rows.filter(([p]) => p === 'tint:whole').map(([, c]) => hex(c));
  const parts = rows.filter(([p]) => p.startsWith('part:')).map(([p, c]) => `${p.slice(5)}=${hex(c)}`);
  return [...whole, ...parts].join(' ');
}

/** A thing's kind state by its entry's names (`{lit: false}`), from its v2 fields, and a creator's tint on any thing;
 *  null for a thing with neither, or one that holds none of its fields yet (it is drawn as the layer has it). `kinds`:
 *  the content kinds' state fields by full kind name (default the build's, `setKindFields`; else a fallback for doors,
 *  lamps and fires). */
export function thingState(n: NodeLike, kinds?: Record<string, KindFields>): Record<string, boolean | number | string> | null {
  const tint = tintState(n.tint), out = kindFields(n, kinds);
  return tint === undefined ? out : { ...out, tint };
}

function kindFields(n: NodeLike, kinds?: Record<string, KindFields>): Record<string, boolean | number | string> | null {
  const fields = n.fields ?? {}, entry = typeof fields[F_ENTRY] === 'string' ? (fields[F_ENTRY] as string) : n.kind;
  // by its kind or entry (`eden:campfire`, a Mars chair's `eden:chair`); a door also by a `…_door` kind (field 6 alone is
  // not one: another kind may use it)
  const full = entry.split('@')[0], name = plainName(entry), plain = kinds ? byPlain(kinds) : PLAIN;
  const pick = (t: Record<string, KindFields>, p: Record<string, KindFields>) => t[full] ?? p[name] ?? (name.endsWith('_door') ? t['eden:door'] ?? p.door : undefined);
  const defs = pick(kinds ?? TABLE, plain) ?? pick({}, FALLBACK);
  if (!defs) return null;
  let out: Record<string, boolean | number | string> | null = null;
  // a field the node does not hold is its entry's default (a campfire never lit is out), where the table has one
  for (const [key, [f, type, dflt]] of Object.entries(defs)) {
    const held = fields[f] ?? dflt ?? undefined;
    if (type === 'enum') { if (typeof held === 'string') (out ??= {})[key] = plainName(held); continue; }
    const v = whole(held);
    if (v !== null) (out ??= {})[key] = type === 'bool' ? v !== 0 : v;
  }
  return out;
}

/** The state keys a thing's old def is drawn by, its parts' `when`s, lights and sounds (`state.on`, `state.open`). */
export type OldDef = { state?: Record<string, { type: string; values?: readonly string[] }> };
/** Bools that say a thing burns or runs: the entry and the old def may name the same thing differently (a campfire's
 *  entry says `lit`, today's def `on`). */
const POWER = ['on', 'lit', 'playing', 'running'];
/** A thing's kind state (its entry's names) as its old def draws it: a key the def has, as the def's type; a burning or
 *  running bool by the def's own name for it; a lamp's brightness `level` as its `on`. A key the def does not draw is
 *  left out (no redraw for it); with no def known, the state is kept as it is. A creator's tint is always kept. */
export function drawnState(v2: Record<string, boolean | number | string>, def: OldDef | null | undefined): Record<string, boolean | number | string> {
  if (!def) return v2;
  const has = def.state ?? {}, out: Record<string, boolean | number | string> = {};
  if (v2.tint !== undefined) out.tint = v2.tint;
  const put = (k: string, v: boolean | number | string) => {
    const t = has[k]?.type;
    if (t === 'bool') out[k] = typeof v === 'string' ? v !== '' : typeof v === 'number' ? v !== 0 : v;
    else if ((t === 'number' || t === 'int') && typeof v !== 'string') out[k] = Number(v);
    else if (t === 'enum' && typeof v === 'string') { const s = has[k].values?.find((x) => x === v || x === v.replace(/_/g, ' ')); if (s !== undefined) out[k] = s; }
    else if (t === 'string' && typeof v === 'string') out[k] = v;
  };
  for (const [k, v] of Object.entries(v2)) if (k !== 'tint' && has[k]) put(k, v);
  const power = POWER.find((k) => typeof v2[k] === 'boolean'), drawnBy = POWER.find((k) => has[k]?.type === 'bool');
  if (drawnBy && !(drawnBy in out)) {
    if (power) put(drawnBy, v2[power]);
    else if (typeof v2.level === 'number' && !has.level) put(drawnBy, v2.level > 0);
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

/** Where a moved thing is now, in the old page's world frame (the same as v2's: metres, yaw about +y). K5 (0.135): a
 *  turn that is not about +y alone (a 6 m frame carried laid flat) also has `tilt`, its turns about x and z: the layer's
 *  `r: [yaw, x, z]`, three's 'XYZ' order. */
export type Placed = { p: [number, number, number]; yaw: number; tilt?: [number, number] };
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
/** Whether a node is in a hand: a frame it rides in, at any depth, is a body. */
export function inHand(nodes: ReadonlyMap<string, NodeLike>, id: string): boolean {
  let n = nodes.get(id);
  for (let depth = 0; n?.parent != null && depth <= 32; depth++) { n = nodes.get(n.parent); if (n && isBody(n)) return true; }
  return false;
}

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
  const at: [number, number, number] = [p[0] / 1e6, p[1] / 1e6, p[2] / 1e6];
  return Math.abs(q[1]) < 1e-6 && Math.abs(q[3]) < 1e-6 ? { p: at, yaw: 2 * Math.atan2(q[2], q[0]) } : { p: at, ...eulerOf(q) };
}

/** A turn as three's Euler angles in 'XYZ' order (Euler.setFromQuaternion): `yaw` its y, `tilt` its x and z. */
export function eulerOf([w, x, y, z]: Q4): { yaw: number; tilt: [number, number] } {
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - w * z), m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x), m32 = 2 * (y * z + w * x), m33 = 1 - 2 * (x * x + y * y);
  const yaw = Math.asin(Math.max(-1, Math.min(1, m13)));
  return Math.abs(m13) < 0.9999999 ? { yaw, tilt: [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] } : { yaw, tilt: [Math.atan2(m32, m22), 0] };
}

/** The layer's `r` for a placed thing: its yaw, or `[yaw, x, z]` when it is tilted or `was` (it was drawn tilted, so its
 *  tilt goes back to none). */
export const turnOf = (to: Placed, was: boolean): number | number[] => (to.tilt || was ? [to.yaw, ...(to.tilt ?? [0, 0])] : to.yaw);

/** The entity layer, the parts read here (WorldEntityLayer's model and diff sequence, private there, read as world-env.ts
 *  reads them). */
type EntityLike = { id: string; def?: string; state?: Record<string, unknown>; in?: { parent: string; slot?: string }; p?: number[]; r?: number | number[]; s?: number };
export type LayerLike = { seq?: unknown; model?: { entities: Map<string, EntityLike>; state?: { weather?: unknown }; resolvedDef?(ref: string): OldDef | undefined;
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

/** Each thing's kind state as its old def draws it, kept while neither changes (worldDiff runs five times a second). */
const translated = new WeakMap<object, { def: unknown; out: Record<string, boolean | number | string> }>();
function asDrawn(want: Record<string, boolean | number | string> | undefined, e: EntityLike, m: NonNullable<LayerLike['model']>) {
  if (!want) return undefined;
  const def = e.def && m.resolvedDef ? m.resolvedDef(e.def) : undefined, was = translated.get(want);
  if (was && was.def === def) return was.out;
  const out = drawnState(want, def);
  translated.set(want, { def, out });
  return out;
}

/** The one diff that brings the layer to v2's state (next in its sequence), or null when it draws it already (or has no
 *  model yet). A thing whose entity the layer does not hold is left out. `ticks`: the take tick each thing's state (and,
 *  under '', the weather) was read at; the diff carries the latest, so the layer draws a door's or lamp's change when the
 *  page's picture reaches it (light-diff-clock.ts), not seconds before the bodies around it. */
export function worldDiff(layer: LayerLike | null | undefined, things: ReadonlyMap<string, Record<string, boolean | number | string>>, weather: OldWeather | null, at: number,
  ticks: ReadonlyMap<string, number> = new Map(), moved: ReadonlyMap<string, Placed> = new Map(), tilted: Set<string> = new Set(),
  hidden: ReadonlyMap<string, number> = new Map(), stash: Map<string, EntityLike> = new Map()): WorldDiff | null {
  const m = layer?.model, seq = layer?.seq;
  if (!m || typeof seq !== 'number') return null;
  const upserts: unknown[] = [], removes: string[] = [];
  let tick = 0;
  // a thing in a hand or gone is removed from the layer, its entity kept (`stash`) to draw it again once it is set down
  for (const [id, at] of hidden) {
    const e = m.entities.get(id);
    if (!e) continue;
    stash.set(id, e); removes.push(id); tick = Math.max(tick, at);
  }
  for (const id of stash.keys()) if (!hidden.has(id) && m.entities.has(id)) stash.delete(id);
  for (const id of new Set([...things.keys(), ...moved.keys(), ...stash.keys()])) {
    if (hidden.has(id)) continue;
    const back = !m.entities.has(id), e = m.entities.get(id) ?? stash.get(id), to = moved.get(id);
    if (!e) continue;
    const want = asDrawn(things.get(id), e, m);
    let next: EntityLike = e;
    if (want && !Object.entries(want).every(([k, v]) => e.state?.[k] === v)) next = { ...next, state: { ...e.state, ...want } };
    // K5: a thing v2 turns off its feet (carried laid flat) is drawn so, and stood up again when it is set down so
    const drawn = Array.isArray(e.r) ? e.r.slice(1).map(Number) : [];
    if (!to?.tilt && !drawn.some((v) => Math.abs(v) > 1e-3)) tilted.delete(id);
    const tiltMoved = !!to && (to.tilt ? !(drawn.length === 2 && to.tilt.every((v, k) => turnBetween(drawn[k], v) < 1e-3)) : tilted.has(id));
    if (to && (!placedAt(e, to) || tiltMoved)) {
      // at the root of the world, where v2 has it: the layer's world pose of a root thing is its own (WorldModel.worldPose)
      const tilt = Array.isArray(e.r) ? e.r.slice(1) : [], s = e.in?.parent !== 'world' && m.worldPose ? m.worldPose(e).s : e.s;
      const r = to.tilt || tilted.has(id) ? turnOf(to, true) : tilt.length ? [to.yaw, ...tilt] : to.yaw;
      if (to.tilt) tilted.add(id);
      next = { ...next, in: { parent: 'world' }, p: [...to.p], r, ...(s !== undefined ? { s } : {}) };
    }
    if (next === e && !back) continue;
    upserts.push(next);
    tick = Math.max(tick, ticks.get(id) ?? 0);
  }
  const world = weather && !sameWeather(m.state?.weather, weather) ? { weather } : undefined;
  if (world) tick = Math.max(tick, ticks.get('') ?? 0);
  if (!upserts.length && !removes.length && !world) return null;
  return { type: 'edge', kind: 'world-diff', seq: seq + 1, at, by: 'engine', ...(tick > 0 ? { tick } : {}), diff: { upserts, removes, defs: [], tiles: [], ...(world ? { world } : {}) } };
}

/** What the v2 stream says of things' state and the weather, kept from the reader worker's messages. */
export class WorldState {
  /** Old entity id (a node's `origin`) → its door or lamp state. */
  readonly things = new Map<string, Record<string, boolean | number | string>>();
  private readonly origins = new Map<string, string>();
  /** Every node the stream holds (the frames a moved thing's world pose is composed through). */
  private readonly nodes = new Map<string, NodeLike>();
  /** Each thing's place (parent, slot, position, turn) when the stream first showed it: the captured world's. */
  private readonly first = new Map<string, string>();
  /** Things first shown and not yet compared with the captured scene (the layer's world pose of their entity). */
  private readonly unchecked = new Set<string>();
  /** Old entity id → where v2 has a thing that has moved since, while it is not in a hand. */
  readonly moved = new Map<string, Placed>();
  /** K5: the things this has drawn tilted (worldDiff stands them up again when v2 does). */
  private readonly tilted = new Set<string>();
  /** Old entity id → the take tick from which it is in a hand or gone from the stream: not drawn by the layer. */
  readonly hidden = new Map<string, number>();
  /** The layer's entities of hidden things, to draw them again once set down (worldDiff). */
  private readonly stash = new Map<string, EntityLike>();
  /** Node id → its old entity id, for every thing of the captured world the stream has shown. */
  private readonly captured = new Map<string, string>();
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
      const was = this.captured.get(id); if (was) { this.hidden.set(was, tick); this.captured.delete(id); }
    }
    let moves = false;
    for (const n of c.nodes) {
      if (n.origin && n.pos && !n.origin.includes('/')) this.captured.set(n.id, n.origin);
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
    // once every frame of this message is in: a thing of the captured world in a hand is not drawn by the layer
    for (const n of c.nodes) {
      const o = this.captured.get(n.id);
      if (!o) continue;
      if (inHand(this.nodes, n.id)) { if (!this.hidden.has(o)) this.hidden.set(o, tick); }
      else this.hidden.delete(o);
    }
    if (moves) this.place();
  }

  /** Every thing's state read again from its fields (the kinds' state table has arrived: `setKindFields`). */
  restate(): void {
    for (const n of this.nodes.values()) {
      if (!n.origin) continue;
      const s = thingState(n);
      if (s) { this.things.set(n.origin, s); this.origins.set(n.id, n.origin); if (!this.ticks.has(n.origin)) this.ticks.set(n.origin, 0); }
    }
  }

  /** A moved thing's world pose, again with every part that moves one (its frame may be what moved); while it is in a
   *  hand it is left where it was last at rest. */
  private place(): void {
    for (const [id, o] of this.origins) {
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
  diff(layer: LayerLike | null | undefined, at: number): WorldDiff | null {
    this.check(layer);
    return worldDiff(layer, this.things, this.weather, at, this.ticks, this.moved, this.tilted, this.hidden, this.stash);
  }

  /** K5 (0.135): the moving frames as they stand at the time the page draws (take-parts.ts CarriedParts.frames): a
   *  carry's node where its samples have it, a load lifted or set down only once the picture reaches it. A thing of the
   *  captured world carried in one is moved with it, not left where it was lifted until it is set down. */
  frames(nodes: readonly NodeLike[]): void {
    let moves = false;
    for (const n of nodes) {
      const was = this.nodes.get(n.id);
      if (!was) continue;
      this.nodes.set(n.id, { ...was, ...n, origin: was.origin });
      moves = true;
    }
    if (moves) this.place();
  }

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
