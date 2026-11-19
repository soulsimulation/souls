// The broadcast camera (V20, #2764): a camera that chooses whom to watch. It picks its subject from the record's named
// events (who spoke, what happened to whom) on a timer, at most twice a second, never by casting rays each frame
// (today's director spends 20 to 24 % of a frame on them, V9). The shot itself is a follow of that body (`follow.ts`),
// so walls are handled the same way, and it drifts slowly round its subject so a long hold is not a still.
// Only what is drawn is chosen: an event counts once the clock has reached it (the stream runs two seconds behind).
import * as THREE from 'three';
import type { PartRec } from '../source/source.ts';

/** Cuts (s): the least a subject is held before a newer event takes the camera, and the most a subject is held with
 *  no event of its own before the camera moves on. */
export const CUT = { least: 8, longest: 30 };
/** How often (s) the subject is reconsidered. */
export const DECIDE = 0.5;
/** The broadcast shot: distance (m), elevation (radians above level) and drift (radians a second). */
export const SHOT = { distance: 14, elevation: (22 * Math.PI) / 180, drift: 0.04 };
/** Named events older than this (µs behind the clock) are forgotten. */
const KEEP_US = 30_000_000;

/** What the broadcast needs to know of the bodies drawn at the clock. */
export type Drawn = { has(id: string): boolean; walking(id: string): boolean; ids(): Iterable<string> };

export class Broadcast {
  subject: string | null = null;
  /** Cuts made, for the shot's heading and the measure. */
  cuts = 0;
  private events: { at: number; id: string }[] = [];
  private clock = 0;
  private heldFrom = 0;
  private decidedAt = -Infinity;
  private next = 0;

  /** Keeps a part's named events: who spoke, and each named happening's node. */
  heard(p: Pick<PartRec, 'said' | 'happened'>): void {
    for (const s of p.said ?? []) this.events.push({ at: s.at, id: s.speaker });
    for (const h of p.happened ?? []) if (h.name) this.events.push({ at: h.at, id: h.node });
  }

  /** The subject at world time `t`, `dt` seconds on; `cut` when it changed this frame. */
  pick(t: number, dt: number, drawn: Drawn): { id: string | null; cut: boolean } {
    this.clock += dt;
    const lost = this.subject !== null && !drawn.has(this.subject);
    if (!lost && this.subject !== null && this.clock - this.decidedAt < DECIDE) return { id: this.subject, cut: false };
    this.decidedAt = this.clock;
    this.events = this.events.filter((e) => e.at > t - KEEP_US);
    const held = this.clock - this.heldFrom;
    // The newest event the clock has reached, of a body drawn now.
    let newest: { at: number; id: string } | null = null;
    for (const e of this.events) if (e.at <= t && drawn.has(e.id) && (!newest || e.at >= newest.at)) newest = e;
    let choice: string | null = this.subject;
    if (this.subject === null || lost) choice = newest?.id ?? this.another(drawn);
    else if (newest && newest.id !== this.subject && newest.at > t - CUT.least * 1e6 && held >= CUT.least) choice = newest.id;
    else if (held >= CUT.longest && !(newest && newest.id === this.subject && newest.at > t - CUT.longest * 1e6)) choice = this.another(drawn) ?? this.subject;
    if (choice === this.subject && !lost) return { id: choice, cut: false };
    this.subject = choice;
    this.heldFrom = this.clock;
    if (choice !== null) this.cuts++;
    return { id: choice, cut: choice !== null };
  }

  /** Another drawn body than the subject: a walking one first, in turn. */
  private another(drawn: Drawn): string | null {
    const ids = [...drawn.ids()].filter((id) => id !== this.subject && drawn.has(id));
    if (!ids.length) return null;
    const walking = ids.filter((id) => drawn.walking(id)), from = walking.length ? walking : ids;
    return from[this.next++ % from.length];
  }

  /** The shot's offset from its subject's target for the cut just made: each cut from another side. */
  offset(): THREE.Vector3 {
    const heading = this.cuts * 2.4, e = SHOT.elevation;
    return new THREE.Vector3(Math.sin(heading) * Math.cos(e), Math.sin(e), Math.cos(heading) * Math.cos(e)).multiplyScalar(SHOT.distance);
  }
}
