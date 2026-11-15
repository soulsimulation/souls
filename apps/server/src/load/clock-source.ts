// #1326: the main thread's view of its own clock (tick age, stalled, dilation), for code that has no monitor handle:
// the edge routes, the long-polls and the inbox listen. #2416: per world. http.ts puts its world's clock on every request
// (setClockSource), and the handlers read it from the request's context, so two worlds in one program never read each
// other's clock.
import type {Context} from 'hono';
import type {ClockState} from './shared.ts';

const KEY = 'simClock';
/** This request's world clock (http.ts, from the world's load monitor). */
export function setClockSource(c: Context, f: () => ClockState) { (c.set as (k: string, v: unknown) => void)(KEY, f); }
export function clockNow(c: Context): ClockState | null { try { return ((c.get as (k: string) => unknown)(KEY) as (() => ClockState) | undefined)?.() ?? null; } catch { return null; } }
export function stalledNow(c: Context): boolean { return !!clockNow(c)?.stalled; }
/** Calls `fire` once, the first time the request's world clock reads stalled (checked every `everyMs`). Returns the stop function. */
export function whenStalled(c: Context, fire: () => void, everyMs = 500): () => void {
  if (!(c.get as (k: string) => unknown)(KEY)) return () => {};
  const t = setInterval(() => { if (stalledNow(c)) { clearInterval(t); fire(); } }, everyMs); t.unref?.();
  return () => clearInterval(t);
}
