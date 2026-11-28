// 27 Nov: the pill's Catching up on a cold arrival (ViewerFrame.tsx). Its own module, read only by the viewer frame, so
// the early layer's shared chunk (viewer-arrival.ts) does not carry it.
/** 27 Nov: a moved world's cold arrival first draws its stream's checkpoint, up to an hour old, and then plays on to now
 *  (13 to 16 s on soul.game's Eden before this): until the moment drawn is within ARRIVAL_NOW_MS of the clock, the pill says
 *  Catching up, not Live. A moment more than ARRIVAL_STALE_MS back is no catch-up (a device clock far off, a world whose
 *  time is not the real time), and after ARRIVAL_CATCH_MS of drawing the arrival is over: the pill never stays on it. */
export const ARRIVAL_NOW_MS = 6000, ARRIVAL_STALE_MS = 24 * 3600_000, ARRIVAL_CATCH_MS = 60_000;
/** Whether an arrival that has not yet reached now is still catching up to it: `shownMs` the moment drawn (the real time
 *  of a moved world's tick), `nowMs` the clock, `drawnMs` how long a picture has been drawn. */
export function arrivalCatching(shownMs: number, nowMs: number, drawnMs: number, gaining = false): boolean {
  const behind = nowMs - shownMs;
  return (behind > ARRIVAL_NOW_MS || gaining) && behind <= ARRIVAL_STALE_MS && drawnMs < ARRIVAL_CATCH_MS;
}

/** N8 (28 Nov): the picture is at now once it stops gaining on the clock, not when it first comes within ARRIVAL_NOW_MS:
 *  a cold Verdelis Eden said Live 6 s behind while the picture still played on fast to now (1 of 5 runs). Gaining is
 *  the lag falling by more than ARRIVAL_GAIN of the time over at least ARRIVAL_SPAN_MS; a picture playing at the clock's
 *  pace holds its lag. */
export const ARRIVAL_SPAN_MS = 1000, ARRIVAL_GAIN = 0.2;
export class ArrivalLag {
  private seen: [atMs: number, lagMs: number][] = [];
  /** `lagMs`, how far the moment drawn is behind the clock at `atMs`: whether it is still falling. False until it has
   *  been seen for ARRIVAL_SPAN_MS. */
  gaining(atMs: number, lagMs: number): boolean {
    const seen = this.seen;
    seen.push([atMs, lagMs]);
    while (seen.length > 2 && seen[1][0] <= atMs - ARRIVAL_SPAN_MS) seen.shift();
    const [from, lag] = seen[0], span = atMs - from;
    return span >= ARRIVAL_SPAN_MS && lag - lagMs > ARRIVAL_GAIN * span;
  }
}
