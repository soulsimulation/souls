// The playback clock (V5, #2714): the world time the page draws, held four parts behind the world. It runs at real
// speed; late parts slow it, it catches up at most 5 % fast, an empty buffer holds the picture, and returning far
// behind (a hidden tab) is one visible cut to the live point, never minutes of fast replay.

export const PERIOD_US = 500_000;
/** Four parts behind the world. */
export const BEHIND_US = 4 * PERIOD_US;
/** At most this much faster than real time while catching up. */
export const MAX_RATE = 1.05;
/** Behind by more than this beyond `BEHIND_US`: cut to the live point. */
export const CUT_US = 20_000_000;
/** The buffer ahead of the clock below which it slows. */
const LOW_US = PERIOD_US / 2;

export type ClockState = 'starting' | 'playing' | 'catching up' | 'slowed: parts late' | 'holding: no parts' | 'cut';

export class PlaybackClock {
  /** The world time drawn, µs; null until the first part. */
  t: number | null = null;
  rate = 1;
  state: ClockState = 'starting';
  /** World wall time of the last cut, for showing it. */
  cutAt = -Infinity;

  /**
   * Advances by `dtMs` of real time. `worldNow` is the world's time now (from the pointer's anchor), `newestTo` the end
   * of the newest part played. Never passes `newestTo`.
   */
  step(dtMs: number, worldNow: number, newestTo: number | null): number | null {
    if (newestTo === null) return this.t;
    if (this.t === null) {
      // A joiner starts once the parts it has played reach four parts behind the world, not at the stream's start.
      if (worldNow - newestTo > BEHIND_US) return null;
      this.t = Math.max(0, Math.min(newestTo, worldNow - BEHIND_US));
    }
    const behind = worldNow - this.t;
    if (behind - BEHIND_US > CUT_US) {
      this.t = Math.min(newestTo, worldNow - BEHIND_US);
      this.state = 'cut';
      this.cutAt = worldNow;
      return this.t;
    }
    // Proportional: 1 at four parts behind, up to MAX_RATE when further, slower when closer.
    let rate = Math.min(MAX_RATE, Math.max(0, 1 + (behind - BEHIND_US) / 1_000_000));
    const ahead = newestTo - this.t;
    if (ahead < LOW_US) rate *= Math.max(0, ahead / LOW_US);
    this.rate = rate;
    this.t = Math.min(newestTo, this.t + dtMs * 1000 * rate);
    this.state = newestTo - this.t < 20_000 ? 'holding: no parts' : ahead < LOW_US ? 'slowed: parts late'
      : rate > 1.001 ? 'catching up' : worldNow - this.cutAt < 3_000_000 ? 'cut' : 'playing';
    return this.t;
  }
}
