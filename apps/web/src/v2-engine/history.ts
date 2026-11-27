// R2 (0.133): past time on the old page for a moved world. The old page's rewind (LiveWorld's seek and its playing
// forward) asks for recorded chunks of a window of take ticks; for a world the new engine runs, this answers them from
// the world's public history export (history-worker.ts, copied from the v2 page): each bundle's state and motion
// samples are played through a bridge of their own (bridge.ts, the live stream's), so a past chunk is made exactly as
// a live one. Nothing here draws.
import { decode } from 'cborg';
import { BEHIND_US, V2Bridge } from './bridge.ts';
import { TICK_US, TICKS, positionAt, type Frame, type RecordedChunk } from './takes.ts';
import type { HistoryMsg, HistoryNode, Seeked } from './history-worker.ts';
import { DAY_US, dayIndexKey, yearCountsKey } from './history-keys.ts';

export const historyTick = (us: number): number => {
  if (!Number.isSafeInteger(us)) throw new Error('history timeline time is not an exact integer');
  return Math.ceil(us / TICK_US);
};

type Changes = [number, string, string, unknown][];
type Piece = { tracks: Record<string, number[][]>; changes: Changes; events: { t: number }[];
  finalState: { tick: number; entities: Record<string, unknown>; [key: string]: unknown }; [key: string]: unknown };
/** Existing bridge one-tick takes become normal one-second takes. Sampling/gesture/seat/facing
 * stays in the bridge; this combines recorded tracks and discrete changes without moving anything. */
export class HistoryTakes {
  readonly chunks = new Map<number, RecordedChunk>();
  private last = -Infinity;
  private partial: { from: number; count: number; take: Piece; values: Map<string, string | undefined>; visible: Set<string> } | null = null;
  private readonly from: number;
  private readonly to: number;
  private readonly limit: number;
  constructor(from: number, to: number, limit: number) { this.from = from; this.to = to; this.limit = limit; }
  add(piece: RecordedChunk): void {
    if (piece.fromTick <= this.last) return;
    this.last = piece.fromTick;
    const from = Math.floor(piece.fromTick / TICKS) * TICKS, offset = piece.fromTick - from;
    if (from < this.from || from + TICKS > this.to || this.chunks.size >= this.limit) return;
    const raw = piece.take as unknown as Piece;
    if (!this.partial || this.partial.from !== from) {
      if (offset !== 0) return; // as before, only complete aligned chunks are returned
      this.partial = { from, count: 0, take: { ...raw, id: `v2-${from}`, startTick: from, ticks: TICKS, keyframeEvery: TICKS,
        baselineStateHash: `v2-state-${from}`, finalStateHash: `v2-state-${from + TICKS}`, tracks: {}, changes: [], events: [],
        finalState: { ...raw.finalState, tick: from + TICKS, entities: {} } }, values: new Map(), visible: new Set() };
    }
    const p = this.partial;
    if (offset !== p.count) throw new Error('history take fragments are not contiguous');
    const change = (tick: number, entity: string, field: string, value: unknown) => {
      const key = `${entity}\0${field}`, encoded = JSON.stringify(value);
      if (!p.values.has(key) || p.values.get(key) !== encoded) { p.take.changes.push([tick, entity, field, value]); p.values.set(key, encoded); }
    };
    const visible = new Set(Object.keys(raw.tracks));
    for (const id of p.visible) if (!visible.has(id)) change(offset, id, 'present', false);
    for (const [id, samples] of Object.entries(raw.tracks)) {
      const track = p.take.tracks[id] ??= [];
      for (const s of samples) {
        const next = [offset + s[0], ...s.slice(1)];
        const last = track.at(-1);
        // Two integer keyframes at a discontinuity retain the old endpoint then the new start.
        // Existing replay holds the old value before the tick and selects the new one at it.
        if (!last || last[0] !== next[0] || last.some((v, i) => v !== next[i])) track.push(next);
      }
    }
    for (const [tick, id, field, value] of raw.changes) change(offset + tick, id, field, value);
    p.take.events.push(...raw.events.map((e) => ({ ...e, t: offset + e.t })));
    Object.assign(p.take.finalState.entities, raw.finalState.entities);
    p.visible = visible;
    if (++p.count === TICKS) {
      for (const [id, track] of Object.entries(p.take.tracks)) {
        const same = (a: number[], b: number[]) => a.slice(1).every((v, i) => v === b[i + 1]);
        p.take.tracks[id] = track.filter((s, i) => i === 0 || i === track.length - 1 || !same(track[i - 1], s) || !same(s, track[i + 1]));
      }
      p.take.changes.sort((a, b) => a[0] - b[0]);
      this.chunks.set(from, { fromTick: from, toTick: from + TICKS, take: p.take }); this.partial = null;
    }
  }
}

/** The world's history export, from the page's config: the route's `v2History`, else beside the stream's `views/`. */
export function historyBase(stream: string, config: unknown): string | null {
  const h = (config as { v2History?: unknown } | undefined)?.v2History;
  if (typeof h === 'string' && /^\/s\/[A-Za-z0-9._/-]+\/$/.test(h)) return h;
  const i = stream.indexOf('/views/');
  return i > 0 ? `${stream.slice(0, i)}/history/` : null;
}

/** Quiet look-ahead after a requested window; one-tick publication below keeps discrete changes causal. */
const STEP_US = TICKS * TICK_US;
/** How long before a moment the page's window of it starts (WorldGeometry.ts rewindWindow). */
const LEAD_US = 10_000_000;

/** One past window's chunks, made from history bundles. */
export class V2History {
  private seq = 0;
  private waiting = new Map<number, (s: Seeked | Error) => void>();
  private worker: Worker | null = null;
  readonly base: string;
  private readonly make: () => Worker;
  private readonly frame: Omit<Frame, 'datetime'>;
  /** V6 (0.133): `hour=HH:MM`, as the live bridge has it: the past is drawn in that light too, its clock unchanged. */
  private readonly hour: string | undefined;
  constructor(base: string, make: () => Worker, frame: Omit<Frame, 'datetime'>, hour?: string) { this.base = base; this.make = make; this.frame = frame; this.hour = hour; }

  /** The world's first moment (µs), else the moment asked for: no seek walks to a day before it. */
  private floor: number | undefined;
  private post(m: { seq: number; at: number; now: number; ahead?: true }): void {
    if (!this.worker) {
      this.worker = this.make();
      this.worker.onmessage = (e: MessageEvent<HistoryMsg>) => {
        const m = e.data, seq = m.t === 'seeked' ? m.s.seq : m.seq, done = this.waiting.get(seq);
        this.waiting.delete(seq);
        done?.(m.t === 'seeked' ? m.s : new Error(m.message));
      };
    }
    this.worker.postMessage({ base: new URL(this.base, location.href).href, ...m, floor: this.floor });
  }
  /** The moment `at` (µs), with the world's time `now` (µs): no seek asks for a day after now's. */
  private seek(at: number, now: number): Promise<Seeked> {
    const seq = ++this.seq;
    return new Promise((ok, no) => {
      this.waiting.set(seq, (r) => (r instanceof Error ? no(r) : ok(r)));
      this.post({ seq, at, now });
    });
  }
  /** K3: where a window from `at` (µs) starts, and the floor of its seeks' walks: a window before the world's first
   *  moment starts there, and no seek walks back through the empty days before it (a young world: each would be a
   *  404). Not known (no public events yet): no day before the asked one's. */
  private async start(at: number, endUs: number): Promise<number> {
    const known = await this.first(endUs).catch(() => null);
    if (known !== null && at < known) at = known;
    this.floor = known ?? Math.min(at, this.floor ?? Infinity);
    return at;
  }

  /** #3358: read ahead what a seek to take tick `tick` will read first (the world's first moment, the day's index and
   *  the bundle's bytes, which the worker keeps), so a seek the page can foresee waits only for that bundle to be
   *  applied: a moment link's while the page catches up to now, Back 1 min's and From the start's once the time panel
   *  is open. On soul.game a bundle is Eden whole, about 1.8 MB, and reading it was the slowest step of a cold seek
   *  (0.9 to 1.7 s of about 2.1). Nothing is applied or drawn, and nothing is said back. */
  async prepare(tick: number, nowTick?: number | null): Promise<void> {
    const now = Math.max(tick, nowTick ?? tick) * TICK_US, at = await this.start(tick * TICK_US - LEAD_US, now);
    this.post({ seq: 0, at, now, ahead: true });
  }

  /** The recorded chunks from take tick `from` to `to`, at most `limit`, as the old server's `/v1/takes` gives them.
   *  `nowTick` is the world's tick now, as the page has it (its live head); unknown, the window's end, which is then
   *  taken to be no later than now. It is the world's own clock, which for a world made through New world began at 0. */
  async chunks(from: number, to: number, limit: number, signal?: AbortSignal, nowTick?: number | null): Promise<RecordedChunk[]> {
    // one-second chunks, as the old /v1/takes gives a past window (B3-4: the live page plays half-second ones)
    const bridge = new V2Bridge(this.frame, this.hour, 1), composed = new HistoryTakes(from, to, limit), got = composed.chunks, endUs = to * TICK_US;
    const now = (nowTick ?? to) * TICK_US;
    let at = await this.start(from * TICK_US, endUs), first = true, next: number | null = null;
    let takenThrough = -Infinity;
    const take = () => {
      const pieces = bridge.view.takes.chunks; let i = pieces.length;
      while (i > 0 && pieces[i - 1].fromTick > takenThrough) i--;
      for (; i < pieces.length; i++) { composed.add(pieces[i]); takenThrough = pieces[i].fromTick; }
    };
    // Yield between ordered publications; cancellation never publishes a later batch.
    let workStart = performance.now();
    const cooperate = async () => {
      if (signal?.aborted) throw new Error('aborted');
      if (performance.now() - workStart >= 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0)); workStart = performance.now();
        if (signal?.aborted) throw new Error('aborted');
      }
    };
    const known = new Map<string, HistoryNode>(), children = new Map<string, Set<string>>();
    const remember = (n: HistoryNode) => {
      const old = known.get(n.id); if (old?.parent) children.get(old.parent)?.delete(n.id);
      known.set(n.id, n);
      if (n.parent) { let set = children.get(n.parent); if (!set) children.set(n.parent, set = new Set()); set.add(n.id); }
    };
    let cursor = -Infinity;
    const advance = async (us: number) => {
      if (!Number.isFinite(cursor)) cursor = us;
      while (cursor < us && got.size < limit) {
        cursor = Math.min(us, cursor + TICK_US);
        bridge.receive({ t: 'pointer', p: { newest: null, newestTo: null, period: 0, anchorWorld: 0, anchorWallMs: 0, quietUntil: cursor + BEHIND_US } }); take(); await cooperate();
      }
    };
    // a chunk is made once the world is the bridge's lag past it, so the bundle after the window is read too
    while (at < endUs + STEP_US && got.size < limit) {
      if (signal?.aborted) throw new Error('aborted');
      // K3: a window that begins before the world's first moment (a link to its first minute) is read from that moment
      const s = await this.seek(at, now).catch(async (e) => { const f = first ? await this.first(endUs).catch(() => null) : null; if (f === null || f <= at) throw e; at = f; return this.seek(f, now); });
      workStart = performance.now(); await cooperate();
      // the bundle's time, and the quiet after it until the next bundle: a world with no records writes no bundle, so
      // past the newest one (no next yet) the world is as that bundle left it, and a minute ago is played from there
      const until = Math.min(s.next ?? Infinity, endUs + 2 * STEP_US);
      if (!Array.isArray(s.transitions)) throw new Error('history timeline missing');
      let previous = s.at;
      for (const row of s.transitions) {
        historyTick(row.at);
        if (row.at <= s.at || row.at < previous || row.at > s.start + s.length || !Array.isArray(row.nodes) || !Array.isArray(row.removed)) throw new Error('history timeline malformed');
        previous = row.at;
      }
      const initialAt = historyTick(s.at) * TICK_US;
      if (!first) await advance(initialAt);
      const live = new Set(s.nodes.map((n) => n.id)), removed = [...known.keys()].filter((id) => !live.has(id));
      known.clear(); children.clear(); for (const n of s.nodes) remember(n);
      bridge.receive({ t: 'part', p: { number: 0, from: initialAt, to: initialAt, nodes: s.nodes.map((n) => ({ ...n, at: initialAt })), removed, samples: [], ...(s.courses ? { courses: s.courses } : {}) } });
      cursor = Math.max(cursor, initialAt); first = false;
      // Exact native times remain on s. Only the display materialization receives ceil-tick copies.
      // Motion samples are already authorized recorded paths. Read ahead within a stable frame
      // segment as the old converter did, so sparse samples still interpolate instead of becoming stairs.
      const state = new Map(s.nodes.map((n) => [n.id, n]));
      const boundaries: number[] = [];
      for (const row of s.transitions) {
        if (row.removed.length || row.nodes.some((n) => {
          const old = state.get(n.id);
          return !old || n.parent !== old.parent || n.slot !== old.slot || n.at !== row.at || !/:(body|humanoid)@/.test(n.kind);
        })) boundaries.push(row.at);
        for (const id of row.removed) state.delete(id); for (const n of row.nodes) state.set(n.id, n);
      }
      const samples = [...s.samples].sort((a, b) => a[3] - b[3]); let sampleIndex = 0, boundaryIndex = 0;
      const motion = (before: number) => {
        const part: typeof s.samples = [];
        while (sampleIndex < samples.length && samples[sampleIndex][3] < before) {
          const sample = samples[sampleIndex++];
          if (known.has(sample[0]) && known.has(sample[1])) part.push([sample[0], sample[1], sample[2], historyTick(sample[3]) * TICK_US, sample[4], sample[5], sample[6]]);
        }
        if (part.length) bridge.receive({ t: 'part', p: { number: 0, from: cursor, to: cursor, nodes: [], removed: [], samples: part } });
      };
      motion(boundaries[0] ?? until);
      for (let i = 0; i < s.transitions.length && got.size < limit; i++) {
        const row = s.transitions[i]; if (row.at >= until) break;
        const displayAt = historyTick(row.at) * TICK_US; await advance(displayAt);
        const affected = new Set<string>(), pending = row.nodes.map((n) => n.id);
        for (let j = 0; j < pending.length; j++) for (const id of children.get(pending[j]) ?? []) {
          if (!affected.has(id)) { affected.add(id); pending.push(id); }
        }
        for (const id of row.removed) { const old = known.get(id); if (old?.parent) children.get(old.parent)?.delete(id); known.delete(id); }
        for (const n of row.nodes) remember(n);
        const direct = new Set(row.nodes.map((n) => n.id)), refresh: typeof s.samples = [];
        for (const id of affected) {
          const n = known.get(id);
          if (!n?.parent || direct.has(id) || !/:(body|humanoid)@/.test(n.kind)) continue;
          // Reuse the bridge's public frame/slot composition with the recorded local path.
          const path = samples.filter((v) => v[0] === id && v[1] === n.parent && v[2] === n.slot && v[3] >= (n.at ?? s.at))
            .map((v) => ({ at: v[3], p: [v[4], v[5], v[6]] as [number, number, number] }));
          path.unshift({ at: n.at ?? s.at, p: n.pos });
          const p = positionAt(path, row.at) ?? n.pos;
          refresh.push([id, n.parent, n.slot, displayAt, ...p]);
        }
        bridge.receive({ t: 'part', p: { number: 0, from: displayAt, to: displayAt, nodes: row.nodes.map((n) => ({ ...n, at: displayAt })), removed: row.removed, samples: refresh, ...(row.courses ? { courses: row.courses } : {}) } });
        if (s.transitions[i + 1]?.at !== row.at && boundaries[boundaryIndex] === row.at) {
          while (boundaries[boundaryIndex] === row.at) boundaryIndex++;
          motion(boundaries[boundaryIndex] ?? until);
        }
        await cooperate();
      }
      await advance(until);
      next = s.next;
      if (s.next === null || s.next <= at) break;
      at = s.next;
    }
    // K3: a window in a gap (the world was stopped, or before its first served moment) has no chunks: the window as
    // long from the next bundle is played instead, so a replay goes on across the gap
    if (!got.size && next !== null && next > endUs && !signal?.aborted) {
      const from2 = Math.floor(next / TICK_US);
      return this.chunks(from2, from2 + (to - from), limit, signal, nowTick ?? to);
    }
    return [...got.values()].sort((a, b) => a.fromTick - b.fromTick).slice(0, limit);
  }

  /** K3: the world time (µs) of the history's first moment the world ran: the first bundle of the first day with
   *  public events (V4's year counts, a slot a day, read back from the year of `nowUs`), or null when there are none.
   *  A seeded world's record at time 0 (its state before it first ran) is not a moment of play. The years are read
   *  back only while they might hold more: a year whose first day with events is not its day 0 began the world's
   *  record, so the year before it is not asked for (the origin would answer 404); a world stopped across a new year
   *  therefore plays from the later year. */
  async first(nowUs: number): Promise<number | null> {
    return (this.firstAt ??= this.findFirst(nowUs));
  }
  private firstAt: Promise<number | null> | undefined;
  private async findFirst(nowUs: number): Promise<number | null> {
    const base = new URL(this.base, location.href);
    const read = async (path: string) => {
      const r = await fetch(new URL(path, base));
      return r.ok ? (decode(new Uint8Array(await r.arrayBuffer()), { useMaps: true }) as Map<number, unknown>) : null;
    };
    const top = Math.floor(Math.floor(nowUs / DAY_US) / 365);
    const daysOf = (c: Map<number, unknown>) => ((c.get(5) ?? []) as number[][]).filter((r) => r[2] > 0).map((r) => r[0]);
    let year = top, slots: number[] = [];
    // this year's counts, else last year's (a world that has had no events yet this year); then back while each year
    // read has events on its day 0
    for (let y = top; y >= 0 && y > top - 50; y--) {
      const c = await read(yearCountsKey(y)), d = c ? daysOf(c) : [];
      if (!d.length) { if (slots.length || y < top) break; continue; }
      slots = d; year = y;
      if (Math.min(...d) > 0) break;
    }
    if (!slots.length) return null;
    const day = year * 365 + Math.min(...slots);
    const index = await read(dayIndexKey(day));
    const starts = ((index?.get(3) ?? []) as unknown[][]).map((r) => Number(r[0])).filter((x) => x > 0);
    return starts.length ? Math.min(...starts) : null;
  }

  stop(): void { this.worker?.terminate(); this.worker = null; }
}

/** K3: how fast the page plays recorded time (1, 2, 4 or 8 times the world's); LiveWorld's replay reads it. */
let speed = 1;
export const playSpeed = () => speed;
export const setPlaySpeed = (x: number) => { speed = [1, 2, 4, 8].includes(x) ? x : 1; };

/** The page's past-time source while it shows a moved world (LiveWorld's rewind asks it first), else null. */
let current: V2History | null = null;
export const setV2History = (h: V2History | null) => { current?.stop(); current = h; };
export const v2History = () => current;
/** #5006 row 14: the world's history export, absolute (God Mode's edit log reads its event index), or null. */
export const v2HistoryBase = () => (current ? new URL(current.base, location.href).href : null);
