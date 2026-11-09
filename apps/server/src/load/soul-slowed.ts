// #456: which Souls the world is slowing or refusing right now, for the public Soul (`slowed`) and so for its chip and card.
// Fed by the admission middleware's refusals addressed to one Soul's token (soul.slow-down, world.busy, world.crowded),
// never by anything world-wide. A Soul not slowed has no entry and no field. A change re-sends that Soul's public card once;
// the end needs no event, since the viewer clears it at `until` and the next card leaves it out.

export type SlowedReason = 'soul.slow-down' | 'world.busy' | 'world.crowded';
export type Slowed = {reason: SlowedReason; until: number};

/** A refusal that only lengthens the wait by less than this re-sends nothing: a Soul retrying politely makes no events. */
const EXTEND_MS = 5_000;

export class SoulSlowed {
  private by = new Map<string, Slowed>();
  onChange?: (soulId: string) => void;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  note(soulId: string, reason: SlowedReason, retryAfterS: number) {
    const t = this.now(), until = t + Math.max(1, retryAfterS) * 1000, old = this.get(soulId);
    if (old && old.reason === reason && until <= old.until + EXTEND_MS) { if (until > old.until) old.until = until; return; }
    this.by.set(soulId, {reason, until});
    if (this.by.size > 4096) for (const [id, s] of this.by) if (s.until <= t) this.by.delete(id);
    this.onChange?.(soulId);
  }
  /** The Soul's slowed state while it lasts, else null (and the entry goes). */
  get(soulId: string): Slowed | null {
    const s = this.by.get(soulId);
    if (!s) return null;
    if (s.until <= this.now()) { this.by.delete(soulId); return null; }
    return s;
  }
}
