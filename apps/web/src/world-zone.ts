// #1649 part 3: the world's own time zone (`state.time.timeZone`) on a real-time world, for the time panel. A tiny store,
// apart from the sun model, so the frame reads it without loading the sky code.
let zone: string | null = null;
const listeners = new Set<() => void>();
/** The time zone of a real-time world, or null (no zone, or not on real time). */
export const worldZone = (): string | null => zone;
export function setWorldZone(state: unknown) {
  const t = (state as { time?: { clock?: unknown; timeZone?: unknown } } | null)?.time;
  const next = t?.clock === 'real' && typeof t.timeZone === 'string' && t.timeZone ? t.timeZone : null;
  if (next === zone) return; zone = next; for (const f of listeners) f();
}
export function subscribeWorldZone(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }
