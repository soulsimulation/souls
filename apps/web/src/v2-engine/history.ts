// R2 (0.133): past time on the old page for a moved world. The old page's rewind (LiveWorld's seek and its playing
// forward) asks for recorded chunks of a window of take ticks; for a world the new engine runs, this answers them from
// the world's public history export (history-worker.ts, copied from the v2 page): each bundle's state and motion
// samples are played through a bridge of their own (bridge.ts, the live stream's), so a past chunk is made exactly as
// a live one. Nothing here draws.
import { V2Bridge } from './bridge.ts';
import { TICK_US, TICKS, type Frame, type RecordedChunk } from './takes.ts';
import type { HistoryMsg, Seeked } from './history-worker.ts';

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
  constructor(base: string, make: () => Worker, frame: Omit<Frame, 'datetime'>) { this.base = base; this.make = make; this.frame = frame; }

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
      this.worker!.postMessage({ base: new URL(this.base, location.href).href, seq, at });
    });
  }

  /** The recorded chunks from take tick `from` to `to`, at most `limit`, as the old server's `/v1/takes` gives them. */
  async chunks(from: number, to: number, limit: number, signal?: AbortSignal): Promise<RecordedChunk[]> {
    const bridge = new V2Bridge(this.frame), got = new Map<number, RecordedChunk>(), endUs = to * TICK_US;
    let at = from * TICK_US, first = true;
    const take = () => { for (const c of bridge.view.takes.chunks) if (c.fromTick >= from && c.toTick <= to) got.set(c.fromTick, c); };
    // a chunk is made once the world is the bridge's lag past it, so the bundle after the window is read too
    while (at < endUs + STEP_US && got.size < limit) {
      if (signal?.aborted) throw new Error('aborted');
      const s = await this.seek(at), until = Math.min(s.next ?? s.start + s.length, endUs + 2 * STEP_US);
      // the bundle's state and its motion, then its time step by step
      bridge.receive({ t: 'part', p: { number: 0, from: first ? s.at : s.start, to: first ? s.at : s.start, nodes: s.nodes as never, removed: [], samples: s.samples } });
      first = false;
      for (let t = s.start + STEP_US; t < until + STEP_US && got.size < limit; t += STEP_US) {
        bridge.receive({ t: 'pointer', p: { newest: null, newestTo: null, period: 0, anchorWorld: 0, anchorWallMs: 0, quietUntil: Math.min(t, until) } });
        take();
      }
      if (s.next === null || s.next <= at) break;
      at = s.next;
    }
    return [...got.values()].sort((a, b) => a.fromTick - b.fromTick).slice(0, limit);
  }

  stop(): void { this.worker?.terminate(); this.worker = null; }
}

/** The page's past-time source while it shows a moved world (LiveWorld's rewind asks it first), else null. */
let current: V2History | null = null;
export const setV2History = (h: V2History | null) => { current?.stop(); current = h; };
export const v2History = () => current;
