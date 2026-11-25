// The live page's clock (LiveWorld's live tick): the tick the page draws while live, a set delay behind the server.
// It runs at the world's rate by real time, not by frames, so slow frames never leave it behind. Behind its target it
// plays faster, at most MAX_RATE; ahead of it, slower: a late chunk or a stalled frame is caught up smoothly, never
// skipped. Only when it is more than CUT_S behind or ahead (a hidden tab, a reconnect) does it cut, once, to the
// target. It never draws past the newest chunk or before the oldest.

/** At most this much faster than the world while catching up. */
export const MAX_RATE = 2;
/** The seconds of lag at which it plays at MAX_RATE; less lag, proportionally less fast. */
export const CATCH_S = 2;
/** Further than this from its target, s: one cut to it. */
export const CUT_S = 20;
/** Real time a frame may stand for, s: a longer gap (a tab hidden, a debugger) is caught up or cut, not replayed. */
export const MAX_FRAME_S = 1;

export class LiveClock {
  /** The tick drawn; null until the first step. */
  tick: number | null = null;
  /** The rate of the last step, world ticks per tick of real time. */
  rate = 1;
  /** How many cuts it has made (one each time it is more than CUT_S off its target). */
  cuts = 0;

  /** Starts again at the next step's target (going live from a replay). */
  reset(): void { this.tick = null; this.rate = 1; }

  /**
   * Advances by `dtS` real seconds toward `target` (the server's tick now less the live delay), at `tps` ticks a
   * second (0 while paused), within the chunks held (`first`, `last`; null when there are none).
   */
  step(dtS: number, target: number, tps: number, first: number | null, last: number | null): number {
    const dt = Math.max(0, Math.min(MAX_FRAME_S, dtS));
    if (this.tick === null || tps <= 0 || Math.abs(target - this.tick) > CUT_S * tps) {
      if (this.tick !== null && tps > 0) this.cuts++;
      this.tick = target;
      this.rate = 1;
    } else {
      // how far it would be from the target after this frame at the world's own rate
      const lag = (target - (this.tick + dt * tps)) / tps;
      this.rate = Math.max(0, Math.min(MAX_RATE, 1 + (lag / CATCH_S) * (MAX_RATE - 1)));
      this.tick += dt * tps * this.rate;
    }
    if (first !== null && last !== null) this.tick = Math.max(first, Math.min(last, this.tick));
    return this.tick;
  }
}
