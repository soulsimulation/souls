// Stage 3 (#4153): the old page's data source for a world the new engine runs. It starts the v2 page's own stream reader
// (v2/web/src/source/worker.ts: the stream's pointer and parts, played on the replica's WASM in a worker), keeps the
// public nodes and body samples it hands on, and keeps the page's `takes` and Souls list as the old socket would: the
// last chunks of every Soul's body (takes.ts) and one PublicSoul a body. Nothing here draws or decides; LiveWorld does.
import { chunkEnd, chunkOf, TICKS, TICK_US, type Body, type Frame, type RecordedChunk, type WorldSample } from './takes.ts';
import { defaultLookOf, entityWithLook, legacyBodyOf, propOf, seatOf, type CatalogueBody, type Held, type Seat } from './take-bodies.ts';
import { isPublic, saidKey, speechOf, talkOf, type Said, type Talk } from './take-speech.ts';

/** What the reader's worker posts (v2/web/src/source/source.ts: NodeRec, PartRec, Pointer; only the fields read here). */
type NodeRec = { id: string; kind: string; parent: string | null; slot: number | null; pos: [number, number, number]; rot: [number, number, number, number];
  at: number | null; origin?: string; soul?: string | null; name?: string | null; sky?: Record<number, unknown>;
  /** Slots `[n, x, y, z, yaw mdeg, capacity]`, mm in its own frame. */
  slots?: number[][];
  /** Exact recorded body-kind hash (field 32); absent is the stated default. */
  body?: string };
type SampleRec = [string, string, number | null, number, number, number, number];
type PartRec = { number: number; from: number; to: number; nodes: NodeRec[]; removed: string[]; samples: SampleRec[]; said?: Said[] };
type Pointer = { newest: number | null; newestTo: number | null; period: number; anchorWorld: number; anchorWallMs: number; quietUntil: number | null };
type Msg = { t: 'pointer'; p: Pointer } | { t: 'part'; p: PartRec } | { t: 'snapshot'; s: { nodes: NodeRec[]; removed: string[] } } | { t: 'error'; message: string };

/** The page's view of the world, updated as parts arrive (read by the hook's 200 ms re-render). */
export type V2View = {
  /** Samples not drawn: in a frame the public copy cannot place. */
  unplaced: number;
  /** The last frames (node ids) a sample could not be placed in, and the slot it named, newest last: for checks. */
  unplacedFrames: string[];
  takes: { serverTick: number; chunks: RecordedChunk[]; receivedAt: number };
  souls: Map<string, { id: string; entityId: string; name: string }>;
  /** World time (µs) the parts reach. */
  newestTo: number | null;
  error: string | null;
  parts: number;
  /** What the Souls said aloud, as the old socket's edge `speech` messages (the dock and the speech layer read them as
   *  public, with the speaker's name), once each, in order, as their chunks come in (take-speech.ts). */
  speech: ReturnType<typeof speechOf>[];
};

const Q = 2 ** 30;
/** The v2 page's own lag behind the world (v2/web/src/clock/clock.ts BEHIND_US: four 0.5 s parts). */
const BEHIND_US = 2_000_000;
type Mat = { p: [number, number, number]; q: [number, number, number, number] };
const rotate = (q: Mat['q'], v: [number, number, number]): [number, number, number] => {
  const [w, x, y, z] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const mul = (a: Mat['q'], b: Mat['q']): Mat['q'] => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];

/** A body: a node with a public Soul (its body-of link), or one of a body kind. */
const isBody = (n: NodeRec) => !!n.soul || /:(humanoid|body)$/.test(n.kind.split('@')[0]);
const samePlace = (a: NodeRec, b: NodeRec) => a.parent === b.parent && a.slot === b.slot && a.pos.every((v, i) => v === b.pos[i]);
/** Chunks the page keeps, as useSouls keeps the socket's. */
const KEEP = 12;
/** Samples kept a body: a minute of world time before the oldest chunk kept. */
const KEEP_US = (KEEP * TICKS * TICK_US) + 60_000_000;

export class V2Bridge {
  readonly view: V2View = { unplaced: 0, unplacedFrames: [], takes: { serverTick: 0, chunks: [], receivedAt: 0 }, souls: new Map(), newestTo: null, error: null, parts: 0, speech: [] };
  private readonly nodes = new Map<string, NodeRec>();
  /** Each body's samples, its last record and, while the public copy cannot draw it (a frame that is not public, or it
   *  left), since when: it is not drawn from then until it is back. */
  private readonly tracks = new Map<string, { samples: WorldSample[]; node: NodeRec | null; gone: number | null; held: Held[]; said: Talk[] }>();
  /** Each held thing's holder (a body node id). */
  private readonly heldBy = new Map<string, string>();
  /** Saids kept (saidKey), and those not yet in a chunk; the talk lines' next id. */
  private readonly saidSeen = new Set<string>();
  private pendingSaid: Said[] = [];
  private talkId = 1;
  /** The v2 body catalogue by hash (`souls/bodies/1`), once given (`looks`): a body-kind hash's old-page look. */
  private catalogue: Map<string, CatalogueBody> | null = null;
  private readonly built = new Map<number, RecordedChunk>();
  private worker: Worker | null = null;
  /** World time of the first part played live: before it the reader caught up without samples, so no chunk is made. */
  private liveFrom: number | null = null;
  private readonly frame: Omit<Frame, 'datetime'>;
  private readonly hour: string | undefined;

  /** `hour` (HH:MM) shows the picture at that hour of the world's day; the world's clock is not changed. */
  constructor(frame: Omit<Frame, 'datetime'>, hour?: string) { this.frame = frame; this.hour = hour; }

  start(stream: string, make: () => Worker): void {
    this.worker = make();
    this.worker.onmessage = (e: MessageEvent<Msg>) => this.receive(e.data);
    this.worker.onerror = (e) => { this.view.error = e.message || 'the v2 reader stopped'; };
    this.worker.postMessage({ stream: new URL(stream, location.href).href });
  }

  /** The world's body catalogue (its `bodies` rows), so each body is drawn in the look the v2 world gives it. */
  looks(bodies: readonly CatalogueBody[]): void { this.catalogue = new Map(bodies.map((b) => [b.hash, b])); }

  stop(): void { this.worker?.terminate(); this.worker = null; }

  receive(m: Msg): void {
    if (m.t === 'error') { this.view.error = m.message; return; }
    // B2-3: a still world writes no part; its pointer says it is quiet up to a time (worldd view_out `idle`, every half
    // second). That is the world's time as surely as a part's end (the v2 page's clock.ts caughtUp), so the chunks it
    // completes are made, and a line said just before the world went still is shown, not held until something moves.
    if (m.t === 'pointer') {
      const q = m.p.quietUntil;
      if (typeof q === 'number' && this.liveFrom !== null && q > (this.view.newestTo ?? -Infinity)) { this.view.newestTo = q; this.publish(); }
      return;
    }
    if (m.t === 'snapshot') { this.nodesChanged(m.s.nodes, m.s.removed, this.view.newestTo ?? 0); this.publish(); return; }
    const p = m.p;
    this.liveFrom ??= p.from;
    this.nodesChanged(p.nodes, p.removed, p.from);
    for (const [id, frame, slot, at, x, y, z] of p.samples) this.sample(id, frame, slot, at, [x, y, z]);
    for (const s of p.said ?? []) if (isPublic(s) && !this.saidSeen.has(saidKey(s))) { this.saidSeen.add(saidKey(s)); this.pendingSaid.push(s); }
    this.view.newestTo = Math.max(this.view.newestTo ?? p.to, p.to);
    this.view.parts++;
    this.publish();
  }

  private nodesChanged(nodes: NodeRec[], removed: string[], at: number): void {
    for (const id of removed) { this.nodes.delete(id); const t = this.tracks.get(id); if (t) t.gone ??= at; this.letGo(id, at); }
    for (const n of nodes) {
      this.nodes.set(n.id, n);
      if (!isBody(n)) {
        // A thing whose frame is a body is in its hand (souls:hold); put down, it is not.
        const holder = n.parent && this.tracks.has(n.parent) ? n.parent : null;
        if (this.heldBy.get(n.id) !== (holder ?? undefined)) this.letGo(n.id, at);
        if (holder) { this.heldBy.set(n.id, holder); this.tracks.get(holder)!.held.push({ at, prop: propOf(n.kind) }); }
        continue;
      }
      const t = this.tracks.get(n.id);
      if (t) {
        // Every later move of its record (a frame, slot or place) with no motion sample: the body is where its record has
        // it from then on, so a body first seen standing is not held there until its next motion sample (#4217). Never
        // before the part that shows the move: a sit moves the record into the seat's slot without a motion sample, so
        // its `at` (its newest motion sample) is older than the move, and a sample there would be dropped (#4175).
        if (n.parent && (!t.node || !samePlace(t.node, n))) this.sample(n.id, n.parent, n.slot, Math.max(n.at ?? at, at), n.pos);
        t.node = n; t.gone = null;
      }
      // A placed body with no motion yet stands where its record has it.
      else if (n.parent) this.sample(n.id, n.parent, n.slot, n.at ?? 0, n.pos);
    }
  }

  /** Thing `id` leaves its holder's hand at world time `at`; the holder still holds whatever else it holds. */
  private letGo(id: string, at: number): void {
    const holder = this.heldBy.get(id);
    if (holder === undefined) return;
    this.heldBy.delete(id);
    const t = this.tracks.get(holder);
    if (!t) return;
    const other = [...this.heldBy].find(([, h]) => h === holder)?.[0];
    t.held.push({ at, prop: other ? propOf(this.nodes.get(other)?.kind ?? '') : null });
  }

  /** The world frame of a node: its parents' places and turns composed (positions µm, turns `[w, x, y, z]`); null when
   *  its chain of frames is not all public in the copy (as the v2 page: a missing frame is never the world's). */
  private world(id: string | null, depth = 0): Mat | null {
    if (id === null) return { p: [0, 0, 0], q: [1, 0, 0, 0] };
    const n = this.nodes.get(id);
    if (!n || depth > 32) return null;
    const up = this.inSlot(this.world(n.parent, depth + 1), n.parent, n.slot);
    if (!up) return null;
    const q: Mat['q'] = [n.rot[0] / Q, n.rot[1] / Q, n.rot[2] / Q, n.rot[3] / Q], r = rotate(up.q, n.pos);
    return { p: [up.p[0] + r[0], up.p[1] + r[1], up.p[2] + r[2]], q: mul(up.q, q) };
  }

  /** A frame moved to one of its node's slots: the slot's point only, as the v2 page adds it (its yaw does not turn
   *  what is in it). */
  private inSlot(f: Mat | null, id: string | null, slot: number | null): Mat | null {
    if (!f || slot === null || id === null) return f;
    const s = this.nodes.get(id)?.slots?.find((x) => x[0] === slot);
    if (!s) return f;
    const r = rotate(f.q, [s[1] * 1000, s[2] * 1000, s[3] * 1000]);
    return { p: [f.p[0] + r[0], f.p[1] + r[1], f.p[2] + r[2]], q: f.q };
  }

  /** One motion sample (µm, in `frame`'s frame) into the body's world track (mm); a sample in a frame the copy cannot
   *  place is not drawn. */
  private sample(id: string, frame: string, slot: number | null, at: number, pos: [number, number, number]): void {
    const f = this.inSlot(this.world(frame), frame, slot);
    if (!f) {
      this.view.unplaced++;
      const why = `${frame}${slot !== null ? `/${slot}` : ''}${this.nodes.has(frame) ? ' (a frame above it is not public)' : ' (not in the public copy)'}`;
      this.view.unplacedFrames = [...this.view.unplacedFrames.filter((x) => x !== why), why].slice(-16);
      return;
    }
    const r = rotate(f.q, pos);
    const p: [number, number, number] = [(f.p[0] + r[0]) / 1000, (f.p[1] + r[1]) / 1000, (f.p[2] + r[2]) / 1000];
    // In a slot a body sits (or lies) on it: the take has its feet on the floor under the seat and the seat's height.
    const thing = slot !== null ? this.nodes.get(frame) : undefined;
    let seat: Seat | undefined;
    if (thing) { seat = seatOf(thing.kind, thing.slots?.find((x) => x[0] === slot)); p[1] -= seat.height; }
    const t = this.tracks.get(id) ?? this.tracks.set(id, { samples: [], node: this.nodes.get(id) ?? null, gone: null, held: [], said: [] }).get(id)!;
    const last = t.samples[t.samples.length - 1];
    if (last && at <= last.at) { if (at === last.at) { last.p = p; last.seat = seat; } return; }
    t.samples.push(seat ? { at, p, seat } : { at, p });
  }

  private bodies(): Body[] {
    const out: Body[] = [];
    for (const [id, t] of this.tracks) {
      const n = this.nodes.get(id) ?? t.node;
      if (!n || !isBody(n)) continue;
      const w = this.nodes.has(id) ? this.world(id) : null;
      // The node's turn about +y as the old take's heading (the old model faces +x: heading = -rotation.y).
      const heading = w ? -2 * Math.atan2(w.q[2], w.q[0]) : 0;
      // The look the v2 page gives it: its body kind's, else the default person its id picks (on both pages alike).
      const look = legacyBodyOf(n.body, this.catalogue), entity = n.body ? entityOf(id) : entityWithLook(entityOf(id), defaultLookOf(id));
      out.push({ entity, soul: soulIdOf(n.soul ?? id), name: nameOf(id, n), samples: t.samples, heading, held: t.held, said: t.said,
        ...(look ? { look } : {}), ...(t.gone !== null ? { until: t.gone } : {}) });
    }
    return out;
  }

  /** Rebuilds the chunks the parts now cover in full; a chunk once whole is kept as it is. */
  private publish(): void {
    const to = this.view.newestTo;
    if (to === null) return;
    // A body's samples come at its turns and steps, not every tick: a chunk is made once the world is BEHIND_US past its
    // end (the v2 page's own lag), so the sample after it is in and a walking body is not held at its last one.
    const end = chunkEnd(to - BEHIND_US), bodies = this.bodies();
    const first = Math.max(end - KEEP * TICKS, Math.ceil((this.liveFrom ?? Infinity) / TICK_US / TICKS) * TICKS);
    const souls = new Map(bodies.map((b) => [b.soul, { id: b.soul, entityId: b.entity, name: b.name }]));
    if (JSON.stringify([...souls.values()]) !== JSON.stringify([...this.view.souls.values()])) this.view.souls = souls;
    // The page plays a little behind serverTick + the time since it came: it moves (and its time restarts) only when a
    // whole new chunk is in, so the page's estimate of the world's tick never steps back.
    if (end === this.view.takes.serverTick) return;
    this.speak(end);
    const datetime = this.datetime(end * TICK_US);
    for (let from = first; from < end; from += TICKS) if (from >= 0 && !this.built.has(from)) this.built.set(from, chunkOf(bodies, from, { ...this.frame, datetime }));
    for (const from of [...this.built.keys()]) if (from < first) this.built.delete(from);
    const cut = first * TICK_US - KEEP_US;
    for (const [id, t] of this.tracks) {
      if (t.gone !== null && t.gone < cut) { this.tracks.delete(id); continue; }
      let k = 0;
      while (k + 1 < t.samples.length && t.samples[k + 1].at < cut) k++;
      if (k) t.samples.splice(0, k);
      let h = 0;
      while (h + 1 < t.held.length && t.held[h + 1].at < cut) h++;
      if (h) t.held.splice(0, h);
      t.said = t.said.filter((l) => l.tick >= first);
    }
    this.view.takes = { serverTick: end, chunks: [...this.built.values()].sort((a, b) => a.fromTick - b.fromTick), receivedAt: performance.now() };
  }

  /** The saids before chunk tick `end` become talk lines, in world-time order, each once: on its speaker's body (the
   *  take's events) and in the page's talk, timed by the wall clock at which the page draws its tick. */
  private speak(end: number): void {
    const now = Date.now(), due = this.pendingSaid.filter((s) => s.at < end * TICK_US).sort((a, b) => a.at - b.at);
    if (!due.length) return;
    this.pendingSaid = this.pendingSaid.filter((s) => s.at >= end * TICK_US);
    for (const s of due) {
      const t = this.tracks.get(s.speaker), n = this.nodes.get(s.speaker) ?? t?.node;
      if (!t || !n) continue;
      const tick = Math.floor(s.at / TICK_US), line = talkOf(s, this.talkId++, soulIdOf(n.soul ?? s.speaker), nameOf(s.speaker, n), TICK_US, now + (tick - end) * TICK_US / 1000);
      t.said.push(line);
      this.view.speech = [...this.view.speech, speechOf(line, s.reach ?? 0)].slice(-300);
    }
  }

  /** The world's civil time at world time `t` µs, from the world node's calendar (replica::sky: origin + t · 86,400 / day). */
  private datetime(t: number): string | null {
    for (const n of this.nodes.values()) {
      if (n.parent !== null) continue; // the world's own node holds the calendar (other kinds may use fields 60, 61)
      const s = n.sky, dayS = Number(s?.[60]), origin = Number(s?.[61]);
      if (!s || !Number.isFinite(dayS) || dayS <= 0 || !Number.isFinite(origin)) continue;
      const iso = new Date((origin + Math.floor((t * 86_400) / dayS)) / 1000).toISOString();
      return this.hour ? `${iso.slice(0, 11)}${this.hour}${iso.slice(16)}` : iso;
    }
    return null;
  }
}

/** A body's name as the page lists it: its public name, else `Soul <n>` until the name is known. */
const nameOf = (id: string, n: NodeRec) => n.name ?? `Soul ${id.split('.').pop()}`;

/** The take entity id of a v2 body node (`<scope>.<counter>`). */
export const entityOf = (id: string) => `v2_${id.replace(/[^0-9a-z]/gi, '_')}`;
/** The page's public Soul id (`s_…`, what its chips, cards and follow accept) for a v2 Soul grant (`soul-<scope>-<n>`). */
export const soulIdOf = (grant: string) => `s_${grant.replace(/^soul-/, '').replace(/[^0-9a-z_-]/gi, '_')}`;
