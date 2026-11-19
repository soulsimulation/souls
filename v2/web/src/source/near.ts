// The near-live clock (Engine v2 V13, #2745): while the owner's socket is up the page draws about 150 ms behind the
// newest effect; when it drops, the clock slows (never stops, never goes back) until it is two seconds behind the world,
// where V1's files are, and plays them; when the socket is back it catches up, at most 10 % fast. A gap of more than
// CUT_US ahead (a hidden tab) is one cut forward, as V5's clock does.

/** Behind the newest effect while the socket is up. */
export const NEAR_US = 150_000;
/** Behind the world on the files (V5's clock). */
export const FILES_US = 2_000_000;
/** The slowest it plays while falling back to the files. */
export const SLOW_RATE = 0.5;
/** At most this much faster than real time while catching up. */
export const MAX_RATE = 1.1;
/** Behind its target by more than this: cut forward to it. */
export const CUT_US = 20_000_000;

export type NearState = 'starting' | 'live' | 'catching up' | 'slowing to the files' | 'files' | 'holding: no parts';

export class NearClock {
  /** The world time drawn, µs; null until there is a target. */
  t: number | null = null;
  rate = 1;
  state: NearState = 'starting';

  /**
   * Advances by `dtMs` of real time. `liveNow` is the world time now as the socket tells it (null while it is down);
   * `worldNow` the world's time from the files' pointer, `newestTo` the end of the newest file part played. On the
   * files it never passes `newestTo`; it never goes back.
   */
  step(dtMs: number, liveNow: number | null, worldNow: number | null, newestTo: number | null): number | null {
    const live = liveNow !== null;
    const target = live ? liveNow - NEAR_US : worldNow === null || newestTo === null ? null : Math.min(newestTo, worldNow - FILES_US);
    if (target === null) return this.t;
    if (this.t === null || target - this.t > CUT_US) this.t = target;
    const error = target - this.t; // > 0: behind the target
    let rate = Math.min(MAX_RATE, Math.max(0, 1 + error / 1_000_000));
    if (!live && error < 0) rate = Math.max(SLOW_RATE, rate);
    let t = this.t + dtMs * 1000 * rate;
    // On the files, the picture holds at the newest part rather than pass it. Just after a drop the clock is ahead of
    // the files: it keeps slowing (bodies stand at their newest sample) until the files overtake it.
    const held = !live && newestTo !== null && this.t <= newestTo && t > newestTo;
    if (held) t = newestTo;
    this.rate = (t - this.t) / Math.max(1e-9, dtMs * 1000);
    this.t = t;
    this.state = live
      ? Math.abs(error) < 50_000 ? 'live' : error > 0 ? 'catching up' : 'live'
      : held ? 'holding: no parts' : error < -50_000 ? 'slowing to the files' : 'files';
    return this.t;
  }
}
