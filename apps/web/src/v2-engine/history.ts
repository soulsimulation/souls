// R2 (0.133): past time on the old page for a moved world. The old page's rewind (LiveWorld's seek and its playing
// forward) asks for recorded chunks of a window of take ticks; for a world the new engine runs, this answers them from
// the world's public history export (history-worker.ts, copied from the v2 page): each bundle's state and motion
// samples are played through a bridge of their own (bridge.ts, the live stream's), so a past chunk is made exactly as
// a live one. Nothing here draws.
import { decode } from 'cborg';
import type {CarriedParts} from './take-parts.ts';
import { V2Bridge } from './bridge.ts';
import { TICK_US, TICKS, type Frame, type RecordedChunk } from './takes.ts';
import type { HistoryMsg, Seeked } from './history-worker.ts';
import { DAY_US, dayIndexKey, headerKey, yearCountsKey } from './history-keys.ts';

/** The world's history export, from the page's config: the route's `v2History`, else beside the stream's `views/`. */
export function historyBase(stream: string, config: unknown): string | null {
  const h = (config as { v2History?: unknown } | undefined)?.v2History;
  if (typeof h === 'string' && /^\/s\/[A-Za-z0-9._/-]+\/$/.test(h)) return h;
  const i = stream.indexOf('/views/');
  return i > 0 ? `${stream.slice(0, i)}/history/` : null;
}

/** How far the bridge is moved on at a time, so it makes every chunk on the way (it keeps its newest twelve). */
const STEP_US = 6 * TICKS * TICK_US;
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
  private carryWindows:{from:number;to:number;parts:CarriedParts;bodies:ReadonlyMap<string,string>}[]=[];
  carry(at:number){for(let i=this.carryWindows.length-1;i>=0;i--){const w=this.carryWindows[i];if(w.from<=at&&at<=w.to)return w;}return null;}
  private readonly parts:CarriedParts|undefined;
  constructor(base: string, make: () => Worker, frame: Omit<Frame, 'datetime'>, hour?: string,parts?:CarriedParts) { this.base = base; this.make = make; this.frame = frame; this.hour = hour; this.parts=parts; }

  /** The world's first moment (µs), else the moment asked for: no seek walks to a day before it. */
  private floor: number | undefined;
  private headerAsked = false;
  private post(m: { seq: number; at: number; now: number; ahead?: true; floor?: number }): void {
    if (!this.worker) {
      this.worker = this.make();
      this.worker.onmessage = (e: MessageEvent<HistoryMsg>) => {
        const m = e.data, seq = m.t === 'seeked' ? m.s.seq : m.seq, done = this.waiting.get(seq);
        this.waiting.delete(seq);
        done?.(m.t === 'seeked' ? m.s : new Error(m.message));
      };
    }
    this.worker.postMessage({ base: new URL(this.base, location.href).href, ...m, floor: m.floor ?? this.floor });
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
   *  (0.9 to 1.7 s of about 2.1). Nothing is applied or drawn, and nothing is said back.
   *  The world's header is asked for here too, once: the worker reads it at its first seek (0.25 to 0.5 s on soul.game),
   *  and it is immutable, so that read is then answered from the browser's cache.
   *  `atOnce` (a link's moment, asked for as the page starts): the worker is asked before the world's first moment is
   *  known (two requests one after the other, 0.5 to 0.7 s on soul.game), for the moment's own day only, so it never
   *  walks back over days a young world does not have; asked again only when the first moment moves the window. */
  async prepare(tick: number, nowTick?: number | null, atOnce = false): Promise<void> {
    if (!this.headerAsked) { this.headerAsked = true; void fetch(new URL(headerKey(), new URL(this.base, location.href))).then((r) => r.arrayBuffer()).catch(() => {}); }
    const now = Math.max(tick, nowTick ?? tick) * TICK_US, wanted = tick * TICK_US - LEAD_US;
    if (atOnce && wanted >= 0) this.post({ seq: 0, at: wanted, now, ahead: true, floor: wanted - (wanted % DAY_US) });
    const at = await this.start(wanted, now);
    if (!atOnce || at !== wanted || wanted < 0) this.post({ seq: 0, at, now, ahead: true });
  }

  /** The recorded chunks from take tick `from` to `to`, at most `limit`, as the old server's `/v1/takes` gives them.
   *  `nowTick` is the world's tick now, as the page has it (its live head); unknown, the window's end, which is then
   *  taken to be no later than now. It is the world's own clock, which for a world made through New world began at 0. */
  async chunks(from: number, to: number, limit: number, signal?: AbortSignal, nowTick?: number | null): Promise<RecordedChunk[]> {
    // one-second chunks, as the old /v1/takes gives a past window (B3-4: the live page plays half-second ones)
    const bridge = new V2Bridge(this.frame, this.hour, TICKS), got = new Map<number, RecordedChunk>(), endUs = to * TICK_US;
    const parts=this.parts?.fork(),bodies=new Map<string,string>();
    const now = (nowTick ?? to) * TICK_US;
    let at = await this.start(from * TICK_US, endUs), first = true, next: number | null = null;
    const take = () => { for(const [node,entity]of bridge.nativeBodies)bodies.set(node,entity);for (const c of bridge.view.takes.chunks) if (c.fromTick >= from && c.toTick <= to) got.set(c.fromTick, c); };
    // a chunk is made once the world is the bridge's lag past it, so the bundle after the window is read too
    while (at < endUs + STEP_US && got.size < limit) {
      if (signal?.aborted) throw new Error('aborted');
      // K3: a window that begins before the world's first moment (a link to its first minute) is read from that moment
      const s = await this.seek(at, now).catch(async (e) => { const f = first ? await this.first(endUs).catch(() => null) : null; if (f === null || f <= at) throw e; at = f; return this.seek(f, now); });
      // the bundle's time, and the quiet after it until the next bundle: a world with no records writes no bundle, so
      // past the newest one (no next yet) the world is as that bundle left it, and a minute ago is played from there
      const until = Math.min(s.next ?? Infinity, endUs + 2 * STEP_US);
      // A validated timeline starts with an as-at baseline, then exact source-ordered replacements/removals.
      // Do not apply future births, frames or membership to the baseline; collect bridge chunks as each change lands.
      const feed=(time:number,nodes:Seeked['nodes'],removed:string[],samples:Seeked['samples'],carryChanges:Seeked['carryChanges'])=>{
        const message={t:'part' as const,p:{number:0,from:time,to:time,nodes,removed,samples,carryChanges,...(s.courses?{courses:s.courses}:{})}};
        bridge.receive(message);parts?.receive(message);take();
      };
      if(s.timeline){
        const origin=s.timeline.from,changes=s.carryChanges??[];
        // Initial nodes already include every effect <= origin. Earlier carry events retain assignment provenance only.
        feed(origin,s.nodes,[],s.samples,changes.filter(c=>c.at<=origin&&!c.pose));
        let last=origin;
        for(const t of s.timeline.transitions){
          for(let q=last+STEP_US;q<t.at;q+=STEP_US){bridge.receive({t:'pointer',p:{newest:null,newestTo:null,period:0,anchorWorld:0,anchorWallMs:0,quietUntil:q}});take();}
          feed(t.at,t.nodes,t.removed,t.samples,changes.filter(c=>last<c.at&&c.at<=t.at));last=t.at;
        }
        const remaining=changes.filter(c=>c.at>last);if(remaining.length)feed(Math.max(last,...remaining.map(c=>c.at)),[],[],[],remaining);
      }else{
        if(parts)throw Error('history: validated node timeline required for native carry playback');
        feed(first?s.at:s.start,s.nodes,[],s.samples,s.carryChanges);
      }
      first = false;
      for (let t = (s.timeline?.transitions.at(-1)?.at ?? s.start) + STEP_US; t < until + STEP_US && got.size < limit; t += STEP_US) {
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
      return this.chunks(from2, from2 + (to - from), limit, signal, nowTick ?? to);
    }
    if(parts&&got.size){const values=[...got.values()];this.carryWindows.push({from:Math.min(...values.map(c=>c.fromTick))*TICK_US,to:Math.max(...values.map(c=>c.toTick))*TICK_US,parts,bodies});if(this.carryWindows.length>12)this.carryWindows.shift();}
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
