// #1326: the main thread's view of its own clock (tick age, stalled, dilation), for code that has no monitor handle:
// the edge routes, the long-polls and the inbox listen. http.ts sets the source from the load monitor.
import type {ClockState} from './shared.ts';

let source: (() => ClockState) | null = null;
export function setClockSource(f: (() => ClockState) | null) { source = f; }
export function clockNow(): ClockState | null { try { return source?.() ?? null; } catch { return null; } }
export function stalledNow(): boolean { return !!clockNow()?.stalled; }
/** Calls `fire` once, the first time the clock reads stalled (checked every `everyMs`). Returns the stop function. */
export function whenStalled(fire: () => void, everyMs = 500): () => void {
  if (!source) return () => {};
  const t = setInterval(() => { if (stalledNow()) { clearInterval(t); fire(); } }, everyMs); t.unref?.();
  return () => clearInterval(t);
}
