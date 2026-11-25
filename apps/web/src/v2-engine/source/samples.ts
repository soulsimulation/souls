// X1 (0.134): copied from v2/web/src/clock/samples.ts, so the old page's stream reader needs nothing from v2/web.
// A body's recorded samples (V5, #2714): where it was, in its parent's frame (T4), at each sample's world time. The
// page draws it between the two samples around the clock, and never past the newest: no extrapolation, so a body never
// walks through a wall and snaps back.

export type Sample = { at: number; pos: [number, number, number] };

export class Track {
  /** In time order. */
  readonly samples: Sample[] = [];
  frame: string | null = null;

  /** Adds a sample; a sample in another frame starts the track again (a transfer is a new frame, not a slide). */
  add(at: number, pos: [number, number, number], frame: string | null): void {
    if (frame !== this.frame) {
      this.samples.length = 0;
      this.frame = frame;
    }
    const last = this.samples[this.samples.length - 1];
    if (last && at <= last.at) {
      if (at === last.at) last.pos = pos;
      return;
    }
    this.samples.push({ at, pos });
  }

  /** Drops samples no longer needed to draw at `t` or later (keeps the one at or before `t`). */
  trim(t: number): void {
    let k = 0;
    while (k + 1 < this.samples.length && this.samples[k + 1].at <= t) k++;
    if (k > 0) this.samples.splice(0, k);
  }

  /** The position at world time `t`: between the samples around it, the first before any, the newest after all. */
  at(t: number): [number, number, number] | null {
    const s = this.samples;
    if (s.length === 0) return null;
    if (t <= s[0].at) return s[0].pos;
    const last = s[s.length - 1];
    if (t >= last.at) return last.pos;
    let i = 0;
    while (s[i + 1].at <= t) i++;
    const a = s[i], b = s[i + 1];
    const f = (t - a.at) / (b.at - a.at);
    return [a.pos[0] + (b.pos[0] - a.pos[0]) * f, a.pos[1] + (b.pos[1] - a.pos[1]) * f, a.pos[2] + (b.pos[2] - a.pos[2]) * f];
  }
}
