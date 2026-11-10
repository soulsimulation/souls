// #1649 part 3: a world clock that jumps (an owner's time zone change, a set hour on a dev world) moves the sky to the new
// time over a few seconds instead of cutting to it. The easer watches the world clock the viewer lights the sky with: a
// change of `thresholdMs` or more between frames (beyond the clock's own running) starts an ease from the time shown to
// the new one over `durationMs`, which keeps up with the clock while it runs on. Smaller steps (a frame, a re-alignment
// of seconds) pass through. The world's clock itself is never changed: this is how the viewer draws it.
export type ClockEaseOptions = { thresholdMs?: number; durationMs?: number; now?: () => number };

/** A naive local ISO datetime ("YYYY-MM-DDTHH:MM:SS[.sss]") as milliseconds of the same UTC reading, or NaN. */
const msOf = (iso: string) => Date.parse(`${iso.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?/)?.[0] ?? ''}Z`);
const smooth = (x: number) => x * x * (3 - 2 * x);

/** One easer per place the clock is drawn. Call it every frame with the clock to show; `cut` (scrubbing history,
 *  reduced motion) shows the clock as it is and ends any ease. Returns the clock to draw, in the input's format. */
export function clockEaser({ thresholdMs = 20 * 60_000, durationMs = 4000, now = () => performance.now() }: ClockEaseOptions = {}) {
  let last: number | null = null;      // the last clock given (ms)
  let shown: number | null = null;     // the last clock drawn (ms)
  let offset = 0, start = 0;           // the ease: drawn = clock + offset × (1 - smooth(progress))
  const ease = (clock: string | null, o: { cut?: boolean } = {}): string | null => {
    const ms = clock ? msOf(clock) : NaN;
    if (!clock || Number.isNaN(ms)) { last = shown = null; offset = 0; return clock; }
    const t = now();
    if (o.cut || last === null || shown === null) { last = shown = ms; offset = 0; return clock; }
    if (Math.abs(ms - last) >= thresholdMs) { offset = shown - ms; start = t; }   // a jump: ease from what is drawn now
    last = ms;
    const p = offset === 0 ? 1 : Math.min(1, (t - start) / durationMs);
    if (p >= 1) offset = 0;
    const drawn = offset === 0 ? ms : ms + offset * (1 - smooth(p));
    shown = drawn;
    if (drawn === ms) return clock;
    return new Date(Math.round(drawn)).toISOString().slice(0, Math.min(clock.length, 23));
  };
  /** An ease is under way (the sky is moving to a new time). */
  ease.active = () => offset !== 0;
  return ease;
}
