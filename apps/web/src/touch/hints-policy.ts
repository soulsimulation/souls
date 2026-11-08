/** #893: when the first-run touch hint may show (see hints.tsx). #1388: once up it stays readable for HINT_MIN_MS
 *  whatever the person does (a first touch is nearly always the start of a drag, which used to fade it at once), then
 *  fades on their next gesture or by itself at HINT_MS. */
export const HINT_KEY = 'sim.touch-hints', HINT_MIN_MS = 4000, HINT_MS = 10_000, HINT_DRAG_PX = 12, HINT_FADE_MS = 400;

/** Whether this page may show the hint at all (before any touch). */
export function hintsAllowed(o: { search: string; webdriver: boolean; coarse: boolean; seen: boolean }): boolean {
  const q = new URLSearchParams(o.search);
  if (!o.coarse || o.seen || q.has('shot')) return false;
  return !o.webdriver || q.get('hints') === '1';
}

/** How long after it appeared (ms) a shown hint fades: at HINT_MS by itself, or on a gesture made `gestureAt` ms after
 *  it appeared, but never before HINT_MIN_MS. */
export function hintFadeAt(gestureAt: number | null): number {
  return gestureAt == null ? HINT_MS : Math.min(HINT_MS, Math.max(HINT_MIN_MS, gestureAt));
}
