// The arrival mark the music player waits for, carried from apps/web/src/arrival-marks.ts (V22, #3337). On Engine v2's
// page arrival is its first live frame: the sound layer marks 'first-live-frame' when the first world time is drawn.
const marked = new Set<string>();
export function arrivalMark(name: string) {
  if (marked.has(name)) return;
  marked.add(name);
  try { performance.mark('sim:' + name); } catch { /* no User Timing */ }
}
/** Whether this page's arrival is over: its first live frame was drawn (or `fallbackMs` passed, for a page that never
 *  draws one). Work nobody sees during the arrival waits for this. */
export function arrivalOver(fallbackMs = 20_000): boolean {
  if (marked.has('card-done') || marked.has('first-live-frame')) return true;
  try { return performance.now() > fallbackMs; } catch { return true; }
}
