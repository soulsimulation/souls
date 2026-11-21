// A phone's touch extras on Engine v2's page (0.131 parity C3, #3675), as today's site has them (apps/web/src/touch:
// hints-policy.ts, haptics.ts, soul-swipe.ts; copied arithmetic, not imported): the first-touch hints' policy, a short
// vibration when a tap follows a Soul, and a fast sideways flick while following that goes to the next or previous Soul.
// Nothing here moves anything in the world: the camera observes.

/** A short vibration (ms) on a touch screen that has one: a tap that follows, and a flight that arrives. */
export const TICK_MS = 12;
type Vibrating = { vibrate?: (ms: number) => boolean } | undefined;
const coarseNow = () => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } };

/** Vibrates once where `navigator.vibrate` exists on a touch screen; does nothing (and returns false) elsewhere. */
export function hapticTick(nav: Vibrating = typeof navigator === 'undefined' ? undefined : (navigator as Vibrating), coarse: () => boolean = coarseNow): boolean {
  try { return !!nav?.vibrate && coarse() ? nav.vibrate(TICK_MS) : false; } catch { return false; }
}

/** The hints: remembered per device under HINT_KEY once readable for HINT_MIN_MS; fade on the next gesture after that,
 *  or by themselves at HINT_MS; a drag is HINT_DRAG_PX of travel; the fade takes HINT_FADE_MS. */
export const HINT_KEY = 'sim.touch-hints', HINT_MIN_MS = 4000, HINT_MS = 10_000, HINT_DRAG_PX = 12, HINT_FADE_MS = 400;

/** Whether this page may show the hints at all: a touch screen that has not seen them, never in `?shot`, and never under
 *  automation unless `?hints=1` (so a recorded proof can show them). */
export function hintsAllowed(o: { search: string; webdriver: boolean; coarse: boolean; seen: boolean }): boolean {
  const q = new URLSearchParams(o.search);
  if (!o.coarse || o.seen || q.has('shot')) return false;
  return !o.webdriver || q.get('hints') === '1';
}

/** When (ms after they appeared) shown hints fade: at HINT_MS by themselves, or on a gesture made `gestureAt` ms after
 *  they appeared, but never before HINT_MIN_MS. */
export function hintFadeAt(gestureAt: number | null): number {
  return gestureAt == null ? HINT_MS : Math.min(HINT_MS, Math.max(HINT_MIN_MS, gestureAt));
}

/** A swipe travels more than SWIPE_MIN_PX sideways, at least SWIPE_RATIO times its vertical travel, within SWIPE_MAX_MS. */
export const SWIPE_MIN_PX = 60, SWIPE_RATIO = 2, SWIPE_MAX_MS = 400;
/** A ring older than this (ms since its last swipe) is made again on the next swipe. */
export const RING_FRESH_MS = 20_000;
/** A Soul heard (it spoke, or a named event happened to it) within this many µs of the clock is of interest. */
export const HEARD_US = 30_000_000;

/** +1 next (a flick to the left), -1 previous (to the right), 0 not a swipe. */
export function swipeStep(dx: number, dy: number, ms: number): 1 | -1 | 0 {
  if (!(ms >= 0 && ms <= SWIPE_MAX_MS) || Math.abs(dx) <= SWIPE_MIN_PX || Math.abs(dx) < SWIPE_RATIO * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}

export type RingSoul = { id: string; p: readonly [number, number, number] | readonly number[]; walking?: boolean };

/** The followed Soul first, then the others: the ones heard most recently first (within HEARD_US of `t`), then walking
 *  ones, then by distance from the followed Soul (near first), then by id. */
export function soulRing(followed: string, souls: readonly RingSoul[], heard: ReadonlyMap<string, number>, t: number): string[] {
  const from = souls.find((s) => s.id === followed);
  if (!from) return [];
  const recent = (s: RingSoul) => { const at = heard.get(s.id); return at !== undefined && at <= t && at > t - HEARD_US ? at : -Infinity; };
  const far = (s: RingSoul) => Math.hypot(s.p[0] - from.p[0], s.p[2] - from.p[2]);
  const rest = souls.filter((s) => s.id !== followed).sort((a, b) => {
    const ra = recent(a), rb = recent(b);
    if (ra !== rb) return rb > ra ? 1 : -1;
    return Number(!!b.walking) - Number(!!a.walking) || far(a) - far(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return [followed, ...rest.map((s) => s.id)];
}

/** Walks one ring across swipes (left, left, right visits three Souls and comes back); makes it again when stale. */
export class SoulSwipe {
  private ring: string[] | null = null;
  private at = -Infinity;
  /** The Soul to go to for this swipe, or null when no other Soul is here. `make` builds a fresh ring. */
  step(followed: string, present: readonly string[], dir: 1 | -1, now: number, make: () => string[]): string | null {
    const here = new Set(present);
    const stale = !this.ring || now - this.at > RING_FRESH_MS || !this.ring.includes(followed)
      || this.ring.length !== here.size || this.ring.some((id) => !here.has(id));
    if (stale) this.ring = make();
    this.at = now;
    const ring = this.ring!;
    if (ring.length < 2) return null;
    const i = ring.indexOf(followed);
    return i < 0 ? null : ring[(i + dir + ring.length) % ring.length];
  }
}

/** Tracks touch pointers on the canvas and says when one finger alone made a flick: a second finger (a pinch or a
 *  two-finger pan) spoils the gesture until every finger is up, so pinch and drag stay the camera's. */
export class Flicks {
  private down = new Set<number>();
  private start: { id: number; x: number; y: number; at: number } | null = null;
  private spoiled = false;
  /** Touch fingers down now. */
  get fingers(): number { return this.down.size; }

  pointerdown(e: { pointerId: number; pointerType: string; clientX: number; clientY: number; timeStamp: number }): void {
    if (e.pointerType !== 'touch') return;
    if (!this.down.size) this.spoiled = false;
    this.down.add(e.pointerId);
    if (this.down.size === 1) this.start = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp };
    else (this.spoiled = true), (this.start = null);
  }

  cancel(e: { pointerId: number }): void {
    this.down.delete(e.pointerId);
    if (this.start?.id === e.pointerId) this.start = null;
  }

  /** The swipe this lift ends: +1, -1, or 0 when it is not one finger's flick. */
  pointerup(e: { pointerId: number; pointerType: string; clientX: number; clientY: number; timeStamp: number }): 1 | -1 | 0 {
    if (e.pointerType !== 'touch') return 0;
    const s = this.start?.id === e.pointerId && !this.spoiled ? this.start : null;
    this.cancel(e);
    return s ? swipeStep(e.clientX - s.x, e.clientY - s.y, e.timeStamp - s.at) : 0;
  }
}
