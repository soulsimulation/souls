// Stage 3 (#4153): the old page's data source for a world the new engine runs. It starts the v2 page's own stream reader
// (v2/web/src/source/worker.ts: the stream's pointer and parts, played on the replica's WASM in a worker), keeps the
// public nodes and body samples it hands on, and keeps the page's `takes` and Souls list as the old socket would: the
// last chunks of every Soul's body (takes.ts) and one PublicSoul a body. Nothing here draws or decides; LiveWorld does.
import { chunkEnd, chunkOf, positionAt, TICK_US, type Body, type Frame, type RecordedChunk, type Thing, type WorldSample } from './takes.ts';
import { defaultLookOf, entityWithLook, legacyBodyOf, lookBodyOf, propOf, seatOf, type CatalogueBody, type Held, type Seat } from './take-bodies.ts';
import { earshotOf, hearersOf, isPublic, saidKey, speechOf, talkOf, type Said, type Talk } from './take-speech.ts';
import { cut as cutGestures, endGesture, gestureFrom, type Gesture } from './take-gestures.ts';
import { keepPlaces, placeAt, seatKey, type CourseAt, type CoursePlaces } from './course-samples.ts';
import { privateTurnOf, tickerOf, turnKey } from './take-talk.ts';
import type { Heard } from './member-turns.ts';
import { reloadForFormat } from './stream-format.ts';

/** What the reader's worker posts (v2/web/src/source/source.ts: NodeRec, PartRec, Pointer; only the fields read here). */
type NodeRec = { id: string; kind: string; parent: string | null; slot: number | null; pos: [number, number, number]; rot: [number, number, number, number];
  at: number | null; origin?: string; soul?: string | null; name?: string | null; description?: string | null; sky?: Record<number, unknown>;
  /** Slots `[n, x, y, z, yaw mdeg, capacity]`, mm in its own frame. */
  slots?: number[][];
  /** Exact recorded body-kind hash (field 32); absent is the stated default. */
  body?: string;
  /** V3: the Soul's own look's params (field 33, G2's `life:look`), JSON. */
  look?: string;
  /** A moving node's course (field 80, #3603), its canonical bytes, for the replica's `courseAt`. */
  course?: Uint8Array;
  /** N14: the courses of a ride's seats that move with their cabins (field 88), by slot, for `courseAt`. */
  seats?: Record<number, Uint8Array> };
export type { CourseAt };
type SampleRec = [string, string, number | null, number, number, number, number];
/** A world record (sound/record.ts Happened); only the fields read here (B3-3). */
type Happened = { at: number; node: string; name?: string };
type PartRec = { number: number; from: number; to: number; nodes: NodeRec[]; removed: string[]; samples: SampleRec[]; said?: Said[]; happened?: Happened[];
  moves?: { body: string; name: string; start: number; ends: number[]; target?: string | null; run?: string; ended?: { at: number; how: string } }[]; runEnds?: { body: string; at: number }[];
  /** K4 (0.135): where each node on a course is over the part, as the reader's worker worked it out (course-samples.ts). */
  courses?: CoursePlaces };
type Pointer = { newest: number | null; newestTo: number | null; period: number; anchorWorld: number; anchorWallMs: number; quietUntil: number | null; asleep?: true; stillUntil?: number | null;
  /** N14: the courses' places up to the time a still world is still to (the worker's), since it writes no part. */
  courses?: CoursePlaces };
type Msg = { t: 'pointer'; p: Pointer } | { t: 'part'; p: PartRec } | { t: 'snapshot'; s: { nodes: NodeRec[]; removed: string[] } } | { t: 'error'; message: string } | { t: 'format'; format: number };

/** N14: the def of a cabin a seat that moves with its cabin is drawn in (WorldRideCars, by LiveWorld). */
export const CABIN = 'ride-cabin';

/** The page's view of the world, updated as parts arrive (read by the hook's 200 ms re-render). */
export type V2View = {
  /** Samples not drawn: in a frame the public copy cannot place. */
  unplaced: number;
  /** The last frames (node ids) a sample could not be placed in, and the slot it named, newest last: for checks. */
  unplacedFrames: string[];
  /** `playDelay`: the ticks the page plays behind serverTick (LiveWorld's live delay for this source, B3-4). */
  takes: { serverTick: number; chunks: RecordedChunk[]; receivedAt: number; playDelay: number };
  souls: Map<string, V2Soul>;
  /** World time (µs) the parts reach. */
  newestTo: number | null;
  error: string | null;
  /** #4535: the stream's format this bundle cannot read, while the page shows its notice and reloads (stream-format.ts). */
  reloading?: number;
  parts: number;
  /** What the Souls said aloud, as the old socket's edge `speech` messages (the dock and the speech layer read them as
   *  public, with the speaker's name), once each, in order, as their chunks come in (take-speech.ts). */
  speech: ReturnType<typeof speechOf>[];
  /** R3 (take-talk.ts): private turns as the dock shows them to anyone (members, a `…` line a turn), and the ticker. */
  conversations: (NonNullable<ReturnType<typeof privateTurnOf>>[number] | TurnLine)[];
  ticker: { tick: number; text: string }[];
  /** G1 (0.133): the world's own node (the one with no parent), for the creator panel's weather. */
  world: string | null;
};

/** R3b: a private turn with its words, for a member's page (an edge `conversation.turn`, dialogue-threads.ts). */
type Who = { soulId: string; name: string };
type TurnLine = { type: 'edge'; conversation: string; tick: number; at: number }
  & ({ kind: 'conversation.start'; private: true; from: Who } | { kind: 'conversation.turn'; turn: { seq: string; from: Who; text: string; at: number; tick: number } });

/** One Soul as the old page's card shows it (B3-3): its public name and description, and what it is doing now. */
export type V2Soul = { id: string; entityId: string; name: string; description: string; doing: Doing; state: 'awake' | Wound };
/** What a Soul is doing, derived from the copy as the v2 page derives its status (v2/web/src/souls/souls.ts), never sent. */
export type Doing = 'speaking' | 'seated' | 'walking' | 'standing' | Wound;
type Wound = 'idle' | 'zombie' | 'asleep';
const WOUND = new Map<string, Wound | 'awake'>([['souls:awake', 'awake'], ['souls:idle', 'idle'], ['souls:zombie', 'zombie'], ['souls:asleep', 'asleep']]);
/** Walking while its track has a sample within this long of the time shown (souls.ts WALKING_US). */
const WALKING_US = 1_000_000;

/** Speaking while a sentence of its own is on at `t`; then the world's wind-down word (B16); seated while in a slot;
 *  walking while it has a sample ahead of `t` or within the last second; else standing (souls.ts `status`). */
export function doingOf(n: NodeRec | null, samples: readonly { at: number }[], t: number, speaking: boolean, wound: { at: number; word: Wound | 'awake' } | undefined): Doing {
  if (speaking) return 'speaking';
  if (wound && wound.at <= t && wound.word !== 'awake') return wound.word;
  if (n && n.slot !== null) return 'seated';
  const last = samples[samples.length - 1];
  return samples.length > 1 && last && last.at > t - WALKING_US ? 'walking' : 'standing';
}

const Q = 2 ** 30;
/** How far behind the newest part a chunk is made (B3-4): past a walker's next sample, which comes every 0.2 s (p99
 *  0.25 s at 100 Souls), so a walking body is never held at its last one; was the v2 page's 2 s, which with LiveWorld's
 *  1.5 s and one-second chunks showed an act about 3.5 s after the world's answer. A part ends on the half-second grid
 *  the chunks are on, so from 0.25 s to one chunk it makes the same chunk (PL, measured with 16 and 20 Souls walking);
 *  0.1 s adds holds (a pointer's quiet time is not on the grid), and none at all draws a walker held short of where it
 *  is in 10 % of its frames. */
export const BEHIND_US = 300_000;
/** Ticks a chunk (B3-4): half a second, one stream part, so a new chunk is in as often as a part comes. */
export const CHUNK = 10;
/** Ticks the page plays behind the newest chunk's end (LiveWorld's live delay for this source, B3-4): one chunk and 0.1 s
 *  for a part that comes late, where the old socket's one-second chunks need 30. The least that holds no more frames
 *  (PL, measured: parts come 0.49 to 0.51 s apart nine times in ten; 11 ticks doubles the 0.1 s and longer holds). */
export const PLAY_DELAY = 12;
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
/** World time the page keeps in chunks: 12 s, as useSouls keeps the socket's twelve one-second ones. */
const KEEP_CHUNKS_US = 12_000_000;

export class V2Bridge {
  readonly view: V2View = { unplaced: 0, unplacedFrames: [], takes: { serverTick: 0, chunks: [], receivedAt: 0, playDelay: PLAY_DELAY }, souls: new Map(), newestTo: null, error: null, parts: 0, speech: [], conversations: [], ticker: [], world: null };
  private readonly nodes = new Map<string, NodeRec>();
  /** Each body's samples, its last record and, while the public copy cannot draw it (a frame that is not public, or it
   *  left), since when: it is not drawn from then until it is back. */
  private readonly tracks = new Map<string, { samples: WorldSample[]; node: NodeRec | null; gone: number | null; held: Held[]; said: Talk[]; gestures: Gesture[] }>();
  /** Each held thing's holder (a body node id). */
  private readonly heldBy = new Map<string, string>();
  /** Saids kept (saidKey), and those not yet in a chunk; the talk lines' next id. */
  private readonly saidSeen = new Set<string>();
  private pendingSaid: Said[] = [];
  private talkId = 1;
  /** The v2 body catalogue by hash (`souls/bodies/1`), once given (`looks`): a body-kind hash's old-page look. */
  private catalogue: Map<string, CatalogueBody> | null = null;
  private readonly built = new Map<number, RecordedChunk>();
  /** Public sentences still on (the last minute), and each body's newest wind-down record (B3-3). */
  private said: Said[] = [];
  private readonly wound = new Map<string, { at: number; word: Wound | 'awake' }>();
  private worker: Worker | null = null;
  /** World time of the first part played live: before it the reader caught up without samples, so no chunk is made. */
  private liveFrom: number | null = null;
  /** Wall time, ms (tests set it). */
  wallNow: () => number = () => Date.now();
  /** K4 (0.135): where each node on a course is, as the reader's worker posts it with the parts (course-samples.ts); the
   *  page never loads the replica itself. A thing on a course stands where it was placed until its places come. */
  private readonly places = new Map<string, number[]>();
  /** K4: a `courseAt` to read a course with directly where no places were posted (a test's stand-in); `onCourse` is
   *  called once, when the first node with a course arrives. */
  courseAt: CourseAt | null = null;
  onCourse: (() => void) | null = null;
  /** K4: the page's entity id for a thing, given its `origin` and where it was placed (world metres): the layer's thing
   *  of that id, else the one standing there (a world whose page scenery was made apart from its engine world has its
   *  own ids); undefined while the page cannot say. Unset: the origin. */
  thingKey: ((origin: string | undefined, at: [number, number, number]) => string | undefined) | null = null;
  private readonly thingKeys = new Map<string, string>();

  /** The world time a pointer says the world is still up to: its quiet time, or, while it sleeps (S4p, #4264), the
   *  world's time now (one second a second from the pointer's anchors, as the v2 page's main.ts) up to its next due
   *  change, `stillUntil` (none: no end). Nothing in a sleeping world changes before then, so it plays as still. */
  private stillTo(p: Pointer): number | null {
    if (!p.asleep) return p.quietUntil;
    const now = p.anchorWorld + (this.wallNow() - p.anchorWallMs) * 1000;
    const t = p.stillUntil == null ? now : Math.min(now, p.stillUntil);
    return p.quietUntil === null ? t : Math.max(p.quietUntil, t);
  }
  private readonly frame: Omit<Frame, 'datetime'>;
  private readonly hour: string | undefined;

  /** `hour` (HH:MM) shows the picture at that hour of the world's day; the world's clock is not changed. */
  /** Ticks a chunk: the live page's half second (CHUNK); a past window's one second, as the old `/v1/takes` (history.ts). */
  private readonly chunk: number;
  private readonly keep: number;
  constructor(frame: Omit<Frame, 'datetime'>, hour?: string, chunk = CHUNK) {
    this.frame = frame; this.hour = hour; this.chunk = chunk; this.keep = Math.round(KEEP_CHUNKS_US / (chunk * TICK_US));
  }

  start(stream: string, make: () => Worker): void {
    this.worker = make();
    this.worker.onmessage = (e: MessageEvent<Msg>) => this.receive(e.data);
    this.worker.onerror = (e) => { this.view.error = e.message || 'the v2 reader stopped'; };
    this.worker.postMessage({ stream: new URL(stream, location.href).href });
  }

  /** The world's body catalogue (its `bodies` rows), so each body is drawn in the look the v2 world gives it. */
  looks(bodies: readonly CatalogueBody[]): void { this.catalogue = new Map(bodies.map((b) => [b.hash, b])); }

  stop(): void { this.worker?.terminate(); this.worker = null; }

  /** #4535: reload the page for a stream format its bundle cannot read (stream-format.ts); a test replaces it. */
  reloadFor: (format: number) => boolean = (format) => reloadForFormat(format);

  receive(m: Msg): void {
    if (m.t === 'error') { this.view.error = m.message; return; }
    // #4535: the worker posts this at each try at a baseline it cannot read; a reload refused (one a minute ago for the
    // same format) is tried again at a later one
    if (m.t === 'format') { if (this.view.reloading === undefined && this.reloadFor(m.format)) this.view.reloading = m.format; return; }
    // B2-3: a still world writes no part; its pointer says it is quiet up to a time (worldd view_out `idle`, every half
    // second). That is the world's time as surely as a part's end (the v2 page's clock.ts caughtUp), so the chunks it
    // completes are made, and a line said just before the world went still is shown, not held until something moves.
    if (m.t === 'pointer') {
      keepPlaces(this.places, m.p.courses);
      const q = this.stillTo(m.p);
      if (typeof q !== 'number' || q <= (this.view.newestTo ?? -Infinity)) return;
      // B2-4: a world already still when the page opens plays no part (the reader posts a quiet time only once it has
      // played every part there is): its first quiet time makes the current chunk from the snapshot, once, so its Souls
      // and things are drawn where they are, not when something next moves
      if (this.liveFrom === null) { if (!this.nodes.size) return; this.liveFrom = (chunkEnd(q - BEHIND_US, this.chunk) - this.chunk) * TICK_US; }
      this.view.newestTo = q;
      this.publish();
      return;
    }
    if (m.t === 'snapshot') { this.nodesChanged(m.s.nodes, m.s.removed, this.view.newestTo ?? 0); this.publish(); return; }
    const p = m.p;
    this.liveFrom ??= p.from;
    for (const id of p.removed) for (const k of [...this.places.keys()]) if (k === id || k.startsWith(`${id}#`)) this.places.delete(k);
    keepPlaces(this.places, p.courses);
    // K2: a record that changes a body's frame or slot (a sit, a stand, a step inside) lands after the part's own motion
    // samples of that body (its walk there), so the walk's last sample never draws a seated body standing again
    const moved = this.nodesChanged(p.nodes, p.removed, p.from, true);
    for (const [id, frame, slot, at, x, y, z] of p.samples) this.sample(id, frame, slot, at, [x, y, z]);
    for (const n of moved) this.sample(n.id, n.parent!, n.slot, Math.max(n.at ?? p.from, p.from, this.tracks.get(n.id)?.samples.at(-1)?.at ?? -Infinity), n.pos);
    // A gesture move plays on its body (take-gestures.ts); a run that ends early ends its gesture then, and a held move
    // let go (its record again, ended: 0.134 T2) ends that move's gesture when it was let go.
    for (const m of p.moves ?? []) {
      const t = this.tracks.get(m.body);
      if (!t) continue;
      if (m.ended) { endGesture(t.gestures, m.start, m.ended.at); continue; }
      const g = gestureFrom(m, this.toward(m.target));
      if (g) t.gestures.push(g);
    }
    for (const e of p.runEnds ?? []) { const t = this.tracks.get(e.body); if (t) cutGestures(t.gestures, e.at); }
    for (const h of p.happened ?? []) {
      const word = h.name === undefined ? undefined : WOUND.get(h.name);
      if (word && (this.wound.get(h.node)?.at ?? -Infinity) <= h.at) this.wound.set(h.node, { at: h.at, word });
    }
    this.said = [...this.said, ...(p.said ?? []).filter((x) => x.words !== null)].filter((x) => x.at + x.length > p.to - 60_000_000);
    for (const s of p.said ?? []) if (isPublic(s) && !this.saidSeen.has(saidKey(s))) { this.saidSeen.add(saidKey(s)); this.pendingSaid.push(s); }
    this.talk(p);
    this.view.newestTo = Math.max(this.view.newestTo ?? p.to, p.to);
    this.view.parts++;
    this.publish();
  }

  /** `defer`: a body's record that changes its frame or slot is returned, to be sampled after the part's motion samples. */
  private nodesChanged(nodes: NodeRec[], removed: string[], at: number, defer = false): NodeRec[] {
    const moved: NodeRec[] = [];
    for (const id of removed) { this.nodes.delete(id); const t = this.tracks.get(id); if (t) t.gone ??= at; this.letGo(id, at); }
    // V5 (0.133): every record first, so a body listed before the seat or room it is in is placed in it (a history
    // bundle's state lists a seated body before its bench: it was drawn nowhere for the whole bundle)
    for (const n of nodes) this.nodes.set(n.id, n);
    if (this.onCourse && nodes.some((n) => n.course || n.seats)) { const f = this.onCourse; this.onCourse = null; f(); }
    for (const n of nodes) {
      if (n.parent === null) this.view.world = n.id;
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
        if (n.parent && (!t.node || !samePlace(t.node, n))) { if (defer && t.node && (t.node.parent !== n.parent || t.node.slot !== n.slot)) moved.push(n); else this.sample(n.id, n.parent, n.slot, Math.max(n.at ?? at, at), n.pos); }
        t.node = n; t.gone = null;
      }
      // A placed body with no motion yet stands where its record has it.
      else if (n.parent) this.sample(n.id, n.parent, n.slot, n.at ?? 0, n.pos);
    }
    return moved;
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
  /** An aimed move's target, where it stands now: world x and z, mm (the takes' units); null when it is none or the copy
   *  cannot place it. */
  private toward(target: string | null | undefined): [number, number] | null {
    const w = target ? this.world(target) : null;
    return w ? [w.p[0] / 1000, w.p[2] / 1000] : null;
  }

  /** `t` (world time µs): a node on a course is where its course has it then (K4); without, where it was placed. */
  private world(id: string | null, depth = 0, t?: number): Mat | null {
    if (id === null) return { p: [0, 0, 0], q: [1, 0, 0, 0] };
    const n = this.nodes.get(id);
    if (!n || depth > 32) return null;
    const up = this.inSlot(this.world(n.parent, depth + 1, t), n.parent, n.slot, t);
    if (!up) return null;
    const q: Mat['q'] = [n.rot[0] / Q, n.rot[1] / Q, n.rot[2] / Q, n.rot[3] / Q], r = rotate(up.q, (t !== undefined && this.coursePos(n, t)) || n.pos);
    return { p: [up.p[0] + r[0], up.p[1] + r[1], up.p[2] + r[2]], q: mul(up.q, q) };
  }

  /** Where node `n`'s course has it at world time `t` (µm, its parent's frame); null with no course or no reader yet. */
  private coursePos(n: NodeRec, t: number): [number, number, number] | null {
    if (!n.course) return null;
    const posted = placeAt(this.places.get(n.id), t);
    if (posted) return posted;
    const read = this.courseAt;
    if (!read) return null;
    try { const v = read(n.course, BigInt(Math.floor(t))); return [Number(v[0]), Number(v[1]), Number(v[2])]; } catch { return null; }
  }

  /** N14: where slot `slot` of node `id`, a ride's seat that moves with its cabin, is at world time `t` (µm, the node's
   *  frame): from its posted places, else its course read directly; null with no course or no reader yet. */
  private seatPos(id: string, slot: number, t: number): [number, number, number] | null {
    const course = this.nodes.get(id)?.seats?.[slot];
    if (!course) return null;
    const posted = placeAt(this.places.get(seatKey(id, slot)), t);
    if (posted) return posted;
    const read = this.courseAt;
    if (!read) return null;
    try { const v = read(course, BigInt(Math.floor(t))); return [Number(v[0]), Number(v[1]), Number(v[2])]; } catch { return null; }
  }

  /** Whether node `id` or a frame above it is on a course (it moves with no sample of its own); with `slot`, also
   *  whether that slot of `id` is a seat that moves with its cabin (N14). */
  private onCourseFrame(id: string | null, slot: number | null = null): boolean {
    if (id !== null && slot !== null && this.nodes.get(id)?.seats?.[slot]) return true;
    for (let n = id ? this.nodes.get(id) : undefined, d = 0; n && d < 32; n = n.parent ? this.nodes.get(n.parent) : undefined, d++) if (n.course) return true;
    return false;
  }

  /** K4: the things on a course (a balloon), each where its course has it, as the takes carry them; keyed by the old
   *  page's entity id (the node's `origin`) where it has one, so the layer that draws it and the camera find it. */
  private things(): Thing[] {
    const out: Thing[] = [];
    for (const n of this.nodes.values()) {
      if (!n.course || isBody(n)) continue;
      const id = n.id;
      let entity = this.thingKeys.get(id);
      if (!entity && this.thingKey) {
        const home = this.world(id);
        const k = home ? this.thingKey(n.origin, [home.p[0] / 1e6, home.p[1] / 1e6, home.p[2] / 1e6]) : undefined;
        if (k) this.thingKeys.set(id, (entity = k));
      }
      const plain = n.kind.split('@')[0].split(':').pop()!;
      out.push({ entity: entity ?? n.origin ?? entityOf(id), label: n.name ?? plain.replace(/_/g, ' '), def: plain, carrier: true,
        at: (t) => { const w = this.world(id, 0, t); return w ? { p: [w.p[0] / 1000, w.p[1] / 1000, w.p[2] / 1000], yaw: -2 * Math.atan2(w.q[2], w.q[0]) } : null; } });
    }
    // N14: each seat of a ride that moves with its cabin, a cabin the page draws where the seat's course has it (its
    // rider sits in it, `sample`); keyed by the ride's entity id and the slot.
    for (const n of this.nodes.values()) {
      if (!n.seats || isBody(n)) continue;
      const id = n.id, plain = n.kind.split('@')[0].split(':').pop()!;
      for (const slot of Object.keys(n.seats).map(Number)) {
        // its floor under the seat, where its rider's feet are (`sample`)
        const under = seatOf(n.kind, n.slots?.find((x) => x[0] === slot)).height;
        out.push({ entity: `${n.origin ?? entityOf(id)}#cabin-${slot}`, label: `${n.name ?? plain.replace(/_/g, ' ')} cabin`, def: CABIN, carrier: true,
          at: (t) => { const w = this.inSlot(this.world(id, 0, t), id, slot, t); return w ? { p: [w.p[0] / 1000, w.p[1] / 1000 - under, w.p[2] / 1000], yaw: -2 * Math.atan2(w.q[2], w.q[0]) } : null; } });
      }
    }
    return out;
  }

  /** A frame moved to one of its node's slots: the slot's point only, as the v2 page adds it (its yaw does not turn
   *  what is in it). */
  private inSlot(f: Mat | null, id: string | null, slot: number | null, t?: number): Mat | null {
    if (!f || slot === null || id === null) return f;
    // N14: a seat that moves with its cabin is where its course has it at `t`
    const run = t !== undefined ? this.seatPos(id, slot, t) : null;
    const s = this.nodes.get(id)?.slots?.find((x) => x[0] === slot);
    if (!s && !run) return f;
    const r = rotate(f.q, run ?? [s![1] * 1000, s![2] * 1000, s![3] * 1000]);
    return { p: [f.p[0] + r[0], f.p[1] + r[1], f.p[2] + r[2]], q: f.q };
  }

  /** One motion sample (µm, in `frame`'s frame) into the body's world track (mm); a sample in a frame the copy cannot
   *  place is not drawn. */
  private sample(id: string, frame: string, slot: number | null, at: number, pos: [number, number, number]): void {
    // K4: in a frame on a course (a balloon's rider) the body is where the course has its frame at each time
    const moving = this.onCourseFrame(frame, slot);
    const placeAt = (t?: number): [number, number, number] | null => {
      const f = this.inSlot(this.world(frame, 0, t), frame, slot, t);
      if (!f) return null;
      const r = rotate(f.q, pos);
      return [(f.p[0] + r[0]) / 1000, (f.p[1] + r[1]) / 1000, (f.p[2] + r[2]) / 1000];
    };
    const f = this.inSlot(this.world(frame, 0, moving ? at : undefined), frame, slot, moving ? at : undefined);
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
    // a slot of a thing on a course is a ride's place: the body stands in it and rides (take-bodies.ts postureOf)
    if (thing) { seat = thing.course ? { height: 0, lie: false, ride: true } : seatOf(thing.kind, thing.slots?.find((x) => x[0] === slot)); p[1] -= seat.height; }
    const on = moving ? (t: number) => { const q = placeAt(t); if (q && seat) q[1] -= seat.height; return q; } : undefined;
    const t = this.tracks.get(id) ?? this.tracks.set(id, { samples: [], node: this.nodes.get(id) ?? null, gone: null, held: [], said: [], gestures: [] }).get(id)!;
    const last = t.samples[t.samples.length - 1];
    if (last && at <= last.at) { if (at === last.at) { last.p = p; last.seat = seat; last.on = on; } return; }
    t.samples.push({ at, p, ...(seat ? { seat } : {}), ...(on ? { on } : {}) });
  }

  private bodies(): (Body & { node: string; description: string })[] {
    const out: (Body & { node: string; description: string })[] = [];
    for (const [id, t] of this.tracks) {
      const n = this.nodes.get(id) ?? t.node;
      if (!n || !isBody(n)) continue;
      const w = this.nodes.has(id) ? this.world(id) : null;
      // The node's turn about +y as the old take's heading (the old model faces +x: heading = -rotation.y).
      const heading = w ? -2 * Math.atan2(w.q[2], w.q[0]) : 0;
      // The look the v2 page gives it: its body kind's, else its own look (field 33, V3) drawn by the old page's look code,
      // else the default person its id picks (on both pages alike).
      const own = n.body ? null : lookBodyOf(n.look);
      const look = legacyBodyOf(n.body, this.catalogue) ?? own, entity = n.body || own ? entityOf(id) : entityWithLook(entityOf(id), defaultLookOf(id));
      out.push({ node: id, entity, soul: soulIdOf(n.soul ?? id), name: nameOf(id, n), description: n.description ?? '', samples: t.samples, heading, held: t.held, said: t.said, gestures: t.gestures,
        ...(look ? { look } : {}), ...(t.gone !== null ? { until: t.gone } : {}) });
    }
    return out;
  }

  /** Rebuilds the chunks the parts now cover in full; a chunk once whole is kept as it is. */
  private publish(): void {
    const to = this.view.newestTo;
    if (to === null) return;
    // A body's samples come at its turns and steps, not every tick: a chunk is made once the world is BEHIND_US past its
    // end, so the sample after it is in and a walking body is not held at its last one.
    const end = chunkEnd(to - BEHIND_US, this.chunk), bodies = this.bodies(), things = this.things();
    const first = Math.max(end - this.keep * this.chunk, Math.ceil((this.liveFrom ?? Infinity) / TICK_US / this.chunk) * this.chunk);
    // what each is doing at the time the page shows (the world's newest time less the page's lag)
    const shown = to - BEHIND_US;
    const souls = new Map(bodies.map((b) => {
      const doing = doingOf(this.nodes.get(b.node) ?? null, b.samples, shown, this.said.some((x) => x.speaker === b.node && x.at <= shown && shown < x.at + x.length), this.wound.get(b.node));
      const state = doing === 'idle' || doing === 'zombie' || doing === 'asleep' ? doing : 'awake';
      return [b.soul, { id: b.soul, entityId: b.entity, name: b.name, description: b.description, doing, state } satisfies V2Soul];
    }));
    if (JSON.stringify([...souls.values()]) !== JSON.stringify([...this.view.souls.values()])) this.view.souls = souls;
    // The page plays a little behind serverTick + the time since it came: it moves (and its time restarts) only when a
    // whole new chunk is in, so the page's estimate of the world's tick never steps back.
    if (end === this.view.takes.serverTick) return;
    this.speak(end);
    const datetime = this.datetime(end * TICK_US);
    for (let from = first; from < end; from += this.chunk) if (from >= 0 && !this.built.has(from)) this.built.set(from, chunkOf(bodies, from, { ...this.frame, datetime }, this.chunk, things));
    for (const from of [...this.built.keys()]) if (from < first) this.built.delete(from);
    // samples kept a body: a minute of world time before the oldest chunk kept
    const cut = first * TICK_US - KEEP_CHUNKS_US - 60_000_000;
    keepPlaces(this.places, undefined, cut);
    for (const [id, t] of this.tracks) {
      if (t.gone !== null && t.gone < cut) { this.tracks.delete(id); continue; }
      let k = 0;
      while (k + 1 < t.samples.length && t.samples[k + 1].at < cut) k++;
      if (k) t.samples.splice(0, k);
      let h = 0;
      while (h + 1 < t.held.length && t.held[h + 1].at < cut) h++;
      if (h) t.held.splice(0, h);
      t.said = t.said.filter((l) => l.tick >= first);
      t.gestures = t.gestures.filter((g) => g.end >= cut);
    }
    this.view.takes = { serverTick: end, chunks: [...this.built.values()].sort((a, b) => a.fromTick - b.fromTick), receivedAt: performance.now(), playDelay: PLAY_DELAY };
  }

  /** R3: a part's private turns (take-talk.ts) and what its bodies did (the ticker), each once. */
  private talk(p: PartRec): void {
    const who = (id: string) => { const n = this.nodes.get(id) ?? this.tracks.get(id)?.node; return n ? { soulId: soulIdOf(n.soul ?? id), name: nameOf(id, n) } : null; };
    for (const s of p.said ?? []) {
      if (!s.private || this.saidSeen.has(saidKey(s))) continue;
      this.saidSeen.add(saidKey(s));
      const p = s.private as { conversation: string };
      const turn = privateTurnOf(s, Math.floor(s.at / TICK_US), Date.now(), who)
        ?.filter((m) => m.kind !== 'conversation.talking' || !this.heardSeen.has(turnKey(p.conversation, s.speaker, s.at))); // R3b: its words are shown
      if (turn) this.view.conversations = [...this.view.conversations, ...turn].slice(-300);
    }
    const did = [...(p.moves ?? []).map((m) => ({ node: m.body, name: m.name, at: m.start })), ...(p.happened ?? []).filter((h) => h.name).map((h) => ({ node: h.node, name: h.name!, at: h.at }))];
    for (const d of did) {
      const n = this.nodes.get(d.node), key = `${d.node}|${d.name}|${d.at}`;
      if (!n || !isBody(n) || this.tickerSeen.has(key)) continue;
      this.tickerSeen.add(key);
      const line = tickerOf(Math.floor(d.at / TICK_US), nameOf(d.node, n), d.name);
      if (line) this.view.ticker = [...this.view.ticker, line].slice(-40);
    }
  }
  private readonly tickerSeen = new Set<string>();

  /** R3b (member-turns.ts): a private turn one of the signed-in person's Souls heard, with its words, as the old page
   *  showed a member its conversation (a `conversation.turn`); its public record then adds no `…` line. Once each. */
  heard(h: Heard): void {
    const k = turnKey(h.conversation, h.speaker, h.at), n = this.nodes.get(h.speaker) ?? this.tracks.get(h.speaker)?.node;
    if (this.heardSeen.has(k) || !n || this.isSoulAudience(h.conversation)) return;
    this.heardSeen.add(k);
    const tick = Math.floor(h.at / TICK_US), from = { soulId: soulIdOf(n.soul ?? h.speaker), name: nameOf(h.speaker, n) };
    const conversation = `v2:${h.conversation}`, at = Date.now();
    // its thread is private (as the old page drew a member's sealed conversation), then the line with its words
    const lines: TurnLine[] = [{ type: 'edge', kind: 'conversation.start', conversation, private: true, from, tick, at },
      { type: 'edge', kind: 'conversation.turn', conversation, turn: { seq: k, from, text: h.words, at, tick }, tick, at }];
    this.view.conversations = [...this.view.conversations, ...lines].slice(-300);
    this.publish();
  }
  private readonly heardSeen = new Set<string>();
  /** Whether audience `id` is a Soul's own or its body's (a whisper to it, B11), not a conversation's. */
  private isSoulAudience(id: string): boolean {
    const n = this.nodes.get(id), soul = soulIdOf(`soul-${id.replace('.', '-')}`);
    return (!!n && isBody(n)) || [...this.nodes.values()].some((x) => !!x.soul && soulIdOf(x.soul) === soul);
  }

  /** R3b: the bodies the stream says the Souls of `grants` (the view token's) drive, as the page keys them. */
  bodiesOf(grants: readonly string[]): string[] {
    const souls = new Set(grants.map(soulIdOf));
    return [...this.nodes.values()].filter((n) => isBody(n) && n.soul && souls.has(soulIdOf(n.soul))).map((n) => n.id);
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
      const others = [...this.tracks].filter(([id, o]) => id !== s.speaker && (o.gone === null || o.gone > s.at))
        .flatMap(([id, o]) => { const m = this.nodes.get(id) ?? o.node; return m && isBody(m) ? [{ soul: soulIdOf(m.soul ?? id), p: positionAt(o.samples, s.at) }] : []; });
      const heardBy = hearersOf(positionAt(t.samples, s.at), earshotOf(s.reach ?? 0) * 1000, others).filter((h) => h !== line.from);
      this.view.speech = [...this.view.speech, speechOf(line, s.reach ?? 0, heardBy)].slice(-300);
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
