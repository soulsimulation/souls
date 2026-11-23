// Stage 4 (#4176): things' state and the weather of a world the new engine runs, on the old page. The old page draws
// Eden's things from its entity layer (WorldEntityLayer: a snapshot, then `world-diff` edge messages); a door's leaf
// turns with its entity's `state.open` and a lamp lights with `state.on` (gen-mesh/vocab-look.ts, world-env.ts), and
// the sky's weather is the layer's `state.weather` (world-env.ts setWeatherOf). This module keeps what the v2 stream says
// of them (the reader worker's node records: a thing's kind state fields, the world node's sky fields) and, when the
// layer draws something else, makes the one `world-diff` that brings it to v2's state. Nothing here draws; the layer
// does, as it draws any diff. The world's clock (calendar fields 60, 61) already rides the chunks (bridge.ts datetime).
import { TICK_US } from './takes.ts';

/** The reader's node record, the fields read here (v2/web/src/source/source.ts NodeRec). */
type NodeLike = { id: string; kind: string; parent: string | null; origin?: string; sky?: Record<number, unknown>; fields?: Record<number, unknown> };
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

/** The entity layer, the parts read here (WorldEntityLayer's model and diff sequence, private there, read as world-env.ts
 *  reads them). */
export type LayerLike = { seq?: unknown; model?: { entities: Map<string, { id: string; state?: Record<string, unknown> }>; state?: { weather?: unknown } } | null };
export type WorldDiff = { type: 'edge'; kind: 'world-diff'; seq: number; at: number; by: 'engine'; tick?: number;
  diff: { upserts: unknown[]; removes: string[]; defs: unknown[]; tiles: string[]; world?: { weather: OldWeather } } };

const sameWeather = (a: unknown, b: OldWeather) => {
  const o = a as Partial<OldWeather> | null | undefined;
  return !!o && (Object.keys(b) as (keyof OldWeather)[]).every((k) => o[k] === b[k]) && (o.until === undefined) === (b.until === undefined);
};

/** The one diff that brings the layer to v2's state (next in its sequence), or null when it draws it already (or has no
 *  model yet). A thing whose entity the layer does not hold is left out. `ticks`: the take tick each thing's state (and,
 *  under '', the weather) was read at; the diff carries the latest, so the layer draws a door's or lamp's change when the
 *  page's picture reaches it (light-diff-clock.ts), not seconds before the bodies around it. */
export function worldDiff(layer: LayerLike | null | undefined, things: ReadonlyMap<string, Record<string, boolean | number>>, weather: OldWeather | null, at: number,
  ticks: ReadonlyMap<string, number> = new Map()): WorldDiff | null {
  const m = layer?.model, seq = layer?.seq;
  if (!m || typeof seq !== 'number') return null;
  const upserts: unknown[] = [];
  let tick = 0;
  for (const [id, want] of things) {
    const e = m.entities.get(id);
    if (!e || Object.entries(want).every(([k, v]) => e.state?.[k] === v)) continue;
    upserts.push({ ...e, state: { ...e.state, ...want } });
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
    for (const id of c.removed) { const o = this.origins.get(id); if (o) { this.things.delete(o); this.ticks.delete(o); this.origins.delete(id); } }
    for (const n of c.nodes) {
      if (n.parent === null && n.sky) { const w = weatherOf(n.sky); if (w) { this.weather = w; this.ticks.set('', tick); } }
      if (!n.origin) continue;
      const s = thingState(n);
      if (s) { this.things.set(n.origin, s); this.ticks.set(n.origin, tick); this.origins.set(n.id, n.origin); }
    }
  }

  /** The diff for the page's entity layer now, or null (see worldDiff). */
  diff(layer: LayerLike | null | undefined, at: number): WorldDiff | null { return worldDiff(layer, this.things, this.weather, at, this.ticks); }

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
