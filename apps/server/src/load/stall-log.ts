// #1750 A3: a main-thread stall over 1 s is logged, once it is over, with its wall time, its length and what ran in it.
// A 100 ms timer notices the gap (a timer cannot run during the stall; it runs late after it). Two seconds later, so the
// requests that were stuck behind or inside it have answered, one `[stall]` line is written:
//   [stall] 2026-11-10T01:16:46.123Z 1530 ms: ticks 3 (longest 1480 ms), gc 12 ms, answers edge:act 1, edge:here 2
// "answers" are the API answers (api-times.ts route ids, never a Soul or a value) whose handling overlapped the stall,
// long-polls left out (they overlap everything); "unattributed" names the share no tick or GC explains. The watchdog
// thread's stall stack (#457, stall-stack.ts) names the frame of a stall over 2 s; this line covers 1 s and up, with time.
import {PerformanceObserver} from 'node:perf_hooks';

export type StallLine = {at: number; ms: number; ticks: number; longestTickMs: number; gcMs: number; answers: Record<string, number>; unattributedMs: number};
type Span = {route: string; t0: number; t1: number};
export type StallLogOpts = {
  /** The host's tick-time ring (ms per tick, newest last) and its tick counter. */
  ticks: () => {tick: number; tickMs: number[]};
  thresholdMs?: number; everyMs?: number; settleMs?: number;
  log?: (line: string) => void;
  /** Monotonic ms (performance.now) and wall ms (Date.now), for tests. */
  mono?: () => number; wall?: () => number;
};

const LONG_POLL = new Set(['edge:listen', 'edge:wait']);
const SPANS = 256;
let active: StallLog | null = null;
/** The API answer hook (admission.ts): to the started StallLog, if any. */
export function noteAnswer(route: string, t0: number, t1: number) { active?.answer(route, t0, t1); }

export class StallLog {
  readonly lines: StallLine[] = [];
  private spans: Span[] = [];
  private gc: {t: number; ms: number}[] = [];
  private timer: NodeJS.Timeout | null = null;
  private obs: PerformanceObserver | null = null;
  private last = 0;
  private seen: {tick: number; at: number} = {tick: 0, at: 0};
  private o: Required<Omit<StallLogOpts, 'ticks'>> & Pick<StallLogOpts, 'ticks'>;
  constructor(o: StallLogOpts) {
    this.o = {thresholdMs: 1000, everyMs: 100, settleMs: 2000, log: (l) => console.log(l), mono: () => performance.now(), wall: () => Date.now(), ...o};
  }
  start() {
    if (this.timer) return;
    this.last = this.o.mono(); this.seen = {tick: this.o.ticks().tick, at: this.last};
    try { this.obs = new PerformanceObserver(list => { for (const e of list.getEntries()) this.gc.push({t: e.startTime + e.duration, ms: e.duration}); if (this.gc.length > 512) this.gc.splice(0, this.gc.length - 512); }); this.obs.observe({entryTypes: ['gc']}); } catch { this.obs = null; }
    this.timer = setInterval(() => this.check(), this.o.everyMs); this.timer.unref();
    active = this;
  }
  stop() { if (active === this) active = null; if (this.timer) clearInterval(this.timer); this.timer = null; this.obs?.disconnect(); this.obs = null; }
  /** An API answer: its route id and its handling's monotonic start and end. O(1); never throws. */
  answer(route: string, t0: number, t1: number) {
    if (LONG_POLL.has(route)) return;
    this.spans.push({route, t0, t1}); if (this.spans.length > SPANS) this.spans.shift();
  }
  /** One timer turn; public for tests. */
  check() {
    const now = this.o.mono(), gap = now - this.last - this.o.everyMs;
    const prevTick = this.seen; this.last = now; this.seen = {tick: this.o.ticks().tick, at: now};
    if (gap <= this.o.thresholdMs) return;
    const from = now - gap, wallAt = this.o.wall() - gap, ticksRan = this.seen.tick - prevTick.tick;
    const {tickMs} = this.o.ticks(), recent = tickMs.slice(Math.max(0, tickMs.length - Math.max(0, ticksRan)));
    const longestTickMs = recent.length ? Math.max(...recent) : 0;
    const report = () => {
      let gcMs = 0; for (const g of this.gc) if (g.t >= from && g.t <= now + 1) gcMs += g.ms;
      const answers: Record<string, number> = {};
      for (const s of this.spans) if (s.t0 < now && s.t1 > from) answers[s.route] = (answers[s.route] ?? 0) + 1;
      const line: StallLine = {at: wallAt, ms: Math.round(gap), ticks: ticksRan, longestTickMs: Math.round(longestTickMs), gcMs: Math.round(gcMs), answers,
        unattributedMs: Math.max(0, Math.round(gap - longestTickMs - gcMs))};
      this.lines.push(line); if (this.lines.length > 20) this.lines.shift();
      try { this.o.log(stallText(line)); } catch { /* logging never throws into the loop */ }
    };
    if (this.o.settleMs > 0) { const t = setTimeout(report, this.o.settleMs); t.unref(); } else report();
  }
}

export function stallText(l: StallLine): string {
  const a = Object.entries(l.answers).sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r} ${n}`).join(', ');
  return `[stall] ${new Date(l.at).toISOString()} ${l.ms} ms: ticks ${l.ticks}${l.ticks ? ` (longest ${l.longestTickMs} ms)` : ''}, gc ${l.gcMs} ms, answers ${a || 'none'}${l.unattributedMs ? `, unattributed ${l.unattributedMs} ms` : ''}`;
}
