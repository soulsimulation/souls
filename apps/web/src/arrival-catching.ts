// 27 Nov: the pill's Catching up on a cold arrival (ViewerFrame.tsx). Its own module, read only by the viewer frame, so
// the early layer's shared chunk (viewer-arrival.ts) does not carry it.
/** 27 Nov: a moved world's cold arrival first draws its stream's checkpoint, up to an hour old, and then plays on to now
 *  (13 to 16 s on soul.game's Eden before this): until the moment drawn is within ARRIVAL_NOW_MS of the clock, the pill says
 *  Catching up, not Live. A moment more than ARRIVAL_STALE_MS back is no catch-up (a device clock far off, a world whose
 *  time is not the real time), and after ARRIVAL_CATCH_MS of drawing the arrival is over: the pill never stays on it. */
export const ARRIVAL_NOW_MS = 6000, ARRIVAL_STALE_MS = 24 * 3600_000, ARRIVAL_CATCH_MS = 60_000;
/** Whether an arrival that has not yet reached now is still catching up to it: `shownMs` the moment drawn (the real time
 *  of a moved world's tick), `nowMs` the clock, `drawnMs` how long a picture has been drawn. */
export function arrivalCatching(shownMs: number, nowMs: number, drawnMs: number): boolean {
  const behind = nowMs - shownMs;
  return behind > ARRIVAL_NOW_MS && behind <= ARRIVAL_STALE_MS && drawnMs < ARRIVAL_CATCH_MS;
}
