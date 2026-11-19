// The history clock (V9, #2719): the world time the page draws while it plays the past. It plays at a chosen speed or
// is paused, and never passes what it has loaded. "Back to live" plays fast towards the live point (four parts behind
// the world, as V5's clock holds it) and hands over there, so the picture never jumps; from further back than
// `FAR_US` it makes one visible cut instead of minutes of fast play.
import { BEHIND_US } from '../clock/clock.ts';

/** How much faster than real time "back to live" plays. */
export const FAST = 8;
/** Further behind the live point than this, "back to live" is one cut (15 s of fast play at most). */
export const FAR_US = 120_000_000;

export type HistoryState = 'paused' | 'playing' | 'holding: loading' | 'returning' | 'waiting for live' | 'live';

export class HistoryClock {
  t: number;
  speed = 1;
  paused = false;
  returning = false;
  state: HistoryState = 'playing';
  /** Set when "back to live" cut instead of playing fast. */
  cut = false;

  constructor(at: number) {
    this.t = at;
  }

  /**
   * Advances by `dtMs` of real time, never past `loadedTo` (the end of what history or the live stream has delivered).
   * While returning, `liveNow` is the world's time now and `liveTo` the end of the live stream's newest part; the
   * result says when to hand the clock over to V5's live clock.
   */
  step(dtMs: number, loadedTo: number, liveNow: number | null = null, liveTo: number | null = null): { t: number; live: boolean } {
    if (this.returning && liveNow !== null) {
      const target = liveNow - BEHIND_US;
      if (target - this.t > FAR_US) {
        // One visible cut, once the live stream reaches the live point.
        if (liveTo === null || liveTo < target) return (this.state = 'waiting for live', { t: this.t, live: false });
        this.cut = true;
        this.t = target;
        return (this.state = 'live', { t: this.t, live: true });
      }
      // A stalled frame (a large part applied) plays at most 100 ms of it fast: slower, never a jump.
      const to = Math.max(loadedTo, liveTo ?? -Infinity);
      this.t = Math.min(target, to, this.t + Math.min(dtMs, 100) * 1000 * FAST);
      // Handed over only once the live stream has played to the time drawn, so V5's clock never steps back.
      if (this.t >= target - 1000 && liveTo !== null && liveTo >= this.t) return (this.state = 'live', { t: this.t, live: true });
      this.state = this.t >= to ? 'waiting for live' : 'returning';
      return { t: this.t, live: false };
    }
    if (this.paused) return (this.state = 'paused', { t: this.t, live: false });
    const next = this.t + dtMs * 1000 * this.speed;
    this.state = next > loadedTo ? 'holding: loading' : 'playing';
    this.t = Math.max(this.t, Math.min(next, loadedTo));
    return { t: this.t, live: false };
  }
}
