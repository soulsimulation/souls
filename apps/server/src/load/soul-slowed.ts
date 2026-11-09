// #456: which Souls the world is slowing or refusing right now, for the public Soul (`slowed`) and so for its chip and card.
// Fed by the world's admission refusals addressed to one Soul's token (soul.slow-down, world.busy, world.crowded; never
// soul.busy, the agent overlapping itself, nor the god's), from the HTTP middleware and the read workers' port alike.
// A Soul not slowed has no entry and no field. The page clears its line at the `until` it was last sent, so a change
// re-sends that Soul's card only when the page would otherwise be wrong for long: never more than once a second per Soul.

export type SlowedReason = 'soul.slow-down' | 'world.busy' | 'world.crowded';
export type Slowed = {reason: SlowedReason; until: number};

/** The page's `until` is moved on only when the live one has gone this far past it, or the page's is about to lapse. */
const EXTEND_MS = 5_000, LAPSE_MS = 1_000, MIN_GAP_MS = 1_000;
type Entry = {live: Slowed; sentAt: number; sentUntil: number; sentReason: SlowedReason};

export class SoulSlowed {
  private by = new Map<string, Entry>();
  private readonly now: () => number;
  onChange?: (soulId: string) => void;
  constructor(now: () => number = Date.now) { this.now = now; }
  note(soulId: string, reason: SlowedReason, retryAfterS: number) {
    const t = this.now(), until = t + Math.max(1, retryAfterS) * 1000, e = this.by.get(soulId);
    if (!e || e.live.until <= t) { this.by.set(soulId, {live: {reason, until}, sentAt: t, sentUntil: until, sentReason: reason}); this.prune(t); this.onChange?.(soulId); return; }
    // the longer wait wins, with its reason; a shorter refusal inside a longer one changes nothing
    if (until >= e.live.until) e.live = {reason, until};
    const grew = e.live.until >= e.sentUntil + EXTEND_MS, gap = t - e.sentAt >= MIN_GAP_MS;
    const lapsing = e.sentUntil - t < LAPSE_MS && e.live.until > e.sentUntil;
    if (grew || (gap && (lapsing || e.live.reason !== e.sentReason))) { e.sentAt = t; e.sentUntil = e.live.until; e.sentReason = e.live.reason; this.onChange?.(soulId); }
  }
  /** The Soul's slowed state while it lasts, else null (and the entry goes). */
  get(soulId: string): Slowed | null {
    const e = this.by.get(soulId);
    if (!e) return null;
    if (e.live.until <= this.now()) { this.by.delete(soulId); return null; }
    return e.live;
  }
  private prune(t: number) { if (this.by.size > 4096) for (const [id, e] of this.by) if (e.live.until <= t) this.by.delete(id); }
}

/** The wiring: refusals the admission reports (by token) become the Soul's `slowed` on its public card, and a change marks
 *  the card to be sent. The token's Soul is looked up once a minute, not per refusal: refusals come when the main thread is
 *  busiest, and a lookup reads the database. */
export function slowedFromRefusals(o: {admission?: {onRefused?: (token: string, code: SlowedReason, retryAfterS: number) => void};
  soulOf: (token: string) => string | null; host: {markSoulDirty(id: string): void; publicSlowedOf?: (soulId: string) => Slowed | null}; now?: () => number}) {
  const slowed = new SoulSlowed(o.now), now = o.now ?? Date.now, cache = new Map<string, {id: string | null; at: number}>();
  slowed.onChange = id => o.host.markSoulDirty(id);
  o.host.publicSlowedOf = id => slowed.get(id);
  if (o.admission) o.admission.onRefused = (token, code, after) => {
    const t = now(); let hit = cache.get(token);
    if (!hit || t - hit.at > 60_000) { let id: string | null = null; try { id = o.soulOf(token); } catch { /* unknown */ } if (cache.size > 4096) cache.clear(); hit = {id, at: t}; cache.set(token, hit); }
    if (hit.id) slowed.note(hit.id, code, after);
  };
  return slowed;
}
