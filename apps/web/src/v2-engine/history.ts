// R2 (0.133): past time on the old page for a moved world. The old page's rewind (LiveWorld's seek and its playing
// forward) asks for recorded chunks of a window of take ticks; for a world the new engine runs, this answers them from
// the world's public history export (history-worker.ts, copied from the v2 page): each bundle's state and motion
// samples are played through a bridge of their own (bridge.ts, the live stream's), so a past chunk is made exactly as
// a live one. Nothing here draws.
import { decode } from 'cborg';
import { V2Bridge } from './bridge.ts';
import { TICK_US, TICKS, type Frame, type RecordedChunk } from './takes.ts';
import type { HistoryMsg, Seeked } from './history-worker.ts';
import { DAY_US, dayIndexKey, yearCountsKey } from './history-keys.ts';

/** The world's history export, from the page's config: the route's `v2History`, else beside the stream's `views/`. */
export function historyBase(stream: string, config: unknown): string | null {
  const h = (config as { v2History?: unknown } | undefined)?.v2History;
  if (typeof h === 'string' && /^\/s\/[A-Za-z0-9._/-]+\/$/.test(h)) return h;
  const i = stream.indexOf('/views/');
  return i > 0 ? `${stream.slice(0, i)}/history/` : null;
}

/** How far the bridge is moved on at a time, so it makes every chunk on the way (it keeps its newest twelve). */
const STEP_US = 6 * TICKS * TICK_US;

/** One past window's chunks, made from history bundles. */
export class V2History {
  private seq = 0;
  private waiting = new Map<number, (s: Seeked | Error) => void>();
  private worker: Worker | null = null;
  private readonly base: string;
  private readonly make: () => Worker;
  private readonly frame: Omit<Frame, 'datetime'>;
  /** V6 (0.133): `hour=HH:MM`, as the live bridge has it: the past is drawn in that light too, its clock unchanged. */
  private readonly hour: string | undefined;
  constructor(base: string, make: () => Worker, frame: Omit<Frame, 'datetime'>, hour?: string) { this.base = base; this.make = make; this.frame = frame; this.hour = hour; }

  /** The world's first moment (µs), else the moment asked for: no seek walks to a day before it. */
  private floor: number | undefined;
  private seek(at: number): Promise<Seeked> {
    if (!this.worker) {
      this.worker = this.make();
      this.worker.onmessage = (e: MessageEvent<HistoryMsg>) => {
        const m = e.data, seq = m.t === 'seeked' ? m.s.seq : m.seq, done = this.waiting.get(seq);
        this.waiting.delete(seq);
        done?.(m.t === 'seeked' ? m.s : new Error(m.message));
      };
    }
    const seq = ++this.seq;
    return new Promise((ok, no) => {
      this.waiting.set(seq, (r) => (r instanceof Error ? no(r) : ok(r)));
      this.worker!.postMessage({ base: new URL(this.base, location.href).href, seq, at, floor: this.floor });
    });
  }

  /** The recorded chunks from take tick `from` to `to`, at most `limit`, as the old server's `/v1/takes` gives them. */
  async chunks(from: number, to: number, limit: number, signal?: AbortSignal): Promise<RecordedChunk[]> {
    // one-second chunks, as the old /v1/takes gives a past window (B3-4: the live page plays half-second ones)
    const bridge = new V2Bridge(this.frame, this.hour, TICKS), got = new Map<number, RecordedChunk>(), endUs = to * TICK_US;
    let at = from * TICK_US, first = true, next: number | null = null;
    // K3: a window before the world's first moment starts there, and no seek walks back through the empty days before
    // it (a young world: each would be a 404). Not known (no public events yet): no day before the asked one's.
    const known = await this.first(endUs).catch(() => null);
    if (known !== null && at < known) at = known;
    this.floor = known ?? Math.min(at, this.floor ?? Infinity);
    const take = () => { for (const c of bridge.view.takes.chunks) if (c.fromTick >= from && c.toTick <= to) got.set(c.fromTick, c); };
    // a chunk is made once the world is the bridge's lag past it, so the bundle after the window is read too
    while (at < endUs + STEP_US && got.size < limit) {
      if (signal?.aborted) throw new Error('aborted');
      // K3: a window that begins before the world's first moment (a link to its first minute) is read from that moment
      const s = await this.seek(at).catch(async (e) => { const f = first ? await this.first(endUs).catch(() => null) : null; if (f === null || f <= at) throw e; at = f; return this.seek(f); });
      // the bundle's time, and the quiet after it until the next bundle: a world with no records writes no bundle, so
      // past the newest one (no next yet) the world is as that bundle left it, and a minute ago is played from there
      const until = Math.min(s.next ?? Infinity, endUs + 2 * STEP_US);
      // the bundle's state and its motion, then its time step by step
      bridge.receive({ t: 'part', p: { number: 0, from: first ? s.at : s.start, to: first ? s.at : s.start, nodes: s.nodes as never, removed: [], samples: s.samples, ...(s.courses ? { courses: s.courses } : {}) } });
      first = false;
      for (let t = s.start + STEP_US; t < until + STEP_US && got.size < limit; t += STEP_US) {
        bridge.receive({ t: 'pointer', p: { newest: null, newestTo: null, period: 0, anchorWorld: 0, anchorWallMs: 0, quietUntil: Math.min(t, until) } });
        take();
      }
      next = s.next;
      if (s.next === null || s.next <= at) break;
      at = s.next;
    }
    // K3: a window in a gap (the world was stopped, or before its first served moment) has no chunks: the window as
    // long from the next bundle is played instead, so a replay goes on across the gap
    if (!got.size && next !== null && next > endUs && !signal?.aborted) {
      const from2 = Math.floor(next / TICK_US);
      return this.chunks(from2, from2 + (to - from), limit, signal);
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
