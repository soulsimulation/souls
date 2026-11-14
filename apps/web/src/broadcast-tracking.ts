/** #2202 (B2): Broadcast's moving tracking shots on gatherings and activity.
 *
 * A gathering (a group, a game, a talk circle, a conversation of three or more) or a Soul busy at something is filmed
 * with one of the tour's moves (orbit, dolly, crane-up, push; `WorldTour.makeMove`, eased in and out) around the
 * hotspot's centre, smoothed with a CENTRE_EMA-second exponential average so one member stepping away does not shift
 * it. The move is carried along with the centre as it moves. A move runs MOVE_MIN..MOVE_MAX seconds; the next one is
 * the type shown least recently, and glides in from where the camera is over GLIDE seconds (eased), or cuts when that
 * glide would cross scenery.
 *
 * Never through scenery: before a move runs, its whole path is checked against the drawn scenery (the eye clear at
 * each sample, the segment between samples unobstructed, the hotspot in sight); while it runs, the next second of the
 * path is re-checked every CHECK seconds, and every frame's eye is clear and sees the hotspot; a blocked move re-solves
 * to the next one. Under a roof, or when no move is clear (indoors, a narrow street), `pose` returns null and Broadcast
 * keeps its framing solver. Cameras observe; nothing here moves a body.
 * Pure over the two scenery queries, so it is unit-tested without a renderer. */
import { makeMove, rng, type MoveType, type TourMove, type TourPose, type TourView } from './WorldTour.ts';

export const TRACK_TYPES: readonly MoveType[] = ['orbit', 'dolly', 'crane-up', 'push'];
export const CENTRE_EMA = 1.5, CHECK = 1, GLIDE = 2.5, MOVE_MIN = 10, MOVE_MAX = 20, RETRY = 3;
/** Planning a move is spread over frames: at most STEPS checks a frame (a check is at most four scenery queries), so a
 *  frame makes at most FRAME_QUERIES queries in all (with the frame's own clear and sightline check and the glide in). */
export const STEPS = 3, FRAME_QUERIES = STEPS * 4 + 5;
/** AIM: the height the shot aims at above the centre's feet. SKY: open sky needed above the hotspot. SIGHT_EVERY: the
 *  sightline is re-cast this often (seconds), at the decision rate. REPLANS: re-solves allowed in RETRY s. SAMPLES: where a move's
 *  path is checked. (The eye clearance radius is the scenery's.) */
const AIM = 1.2, SKY = 40, SIGHT_EVERY = .1, REPLANS = 3, LEAD = 1, SAMPLES = [0, .2, .4, .6, .8, 1];

export type TrackChoice = { key: string; label: string; members: readonly string[] };
/** Gatherings and activity get a moving shot: a group, a game, a talk circle, a Soul busy at something, and a conversation
 *  of three or more or held among a crowd (`crowd`: people within 6 m of its centre, itself included). A pair talking on
 *  their own (the two-shot), a paired gesture, a presenter, a rider, an arrival and a walker keep the framing solver. */
export const tracked = (c: TrackChoice, crowd = 0) => /^(group|game|talk):/.test(c.key) || c.label === 'busy' ||
  (c.key.startsWith('conversation:') && (c.members.length >= 3 || crowd >= 3));

/** The scenery the moves are checked against: is the eye clear here, and how far a segment reaches before it is blocked. */
export type Scenery = { clear(p: readonly number[]): boolean; reach(a: readonly number[], b: readonly number[]): number };
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp3 = (a: readonly number[], b: readonly number[], k: number): [number, number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const ease = (k: number) => .5 - .5 * Math.cos(Math.PI * Math.min(1, Math.max(0, k)));
const open = (s: Scenery, a: readonly number[], b: readonly number[]) => s.reach(a, b) >= dist(a, b) - .05;
/** The hotspot is in sight: torso and head height over its centre (`aim` is AIM above the feet; the points are the
 *  solver's visibility probes, 0.6 and 0.95 of a 1.75 m body), each reached to within a body's width. */
const sees = (s: Scenery, eye: readonly number[], aim: readonly number[]) =>
  [-.15, .46].every(dy => { const at = [aim[0], aim[1] + dy, aim[2]]; return s.reach(eye, at) >= dist(eye, at) - .3; });

/** The authored-style view a move is built on: the eye `r` (7 to 13 m) out at `azimuth`, a little above head height,
 *  looking at the hotspot's head height. Wider for a spread-out gathering. */
export function hotspotView(centre: readonly number[], spread: number, azimuth: number): TourView {
  const r = Math.min(13, Math.max(7, 7 + spread)), h = 1.3 + .12 * r, t: [number, number, number] = [centre[0], centre[1] + AIM, centre[2]];
  return { id: 'hotspot', label: 'hotspot', target: t, p: [t[0] + Math.cos(azimuth) * r, t[1] + h, t[2] + Math.sin(azimuth) * r] };
}
const shift = (p: TourPose, d: readonly number[]): TourPose => ({ position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]], target: [p.target[0] + d[0], p.target[1] + d[1], p.target[2] + d[2]], fov: p.fov });

/** A move's path from k0 to k1, carried by `d`, is clear: the eye clear at each sample, each segment open, the target in sight. */
export function pathClear(m: TourMove, d: readonly number[], k0: number, k1: number, s: Scenery): boolean {
  const ks = [k0, ...SAMPLES.filter(k => k > k0 && k < k1), k1];
  let prev: TourPose | null = null;
  for (const k of ks) {
    const pose = shift(m.at(k), d);
    if (!s.clear(pose.position) || !sees(s, pose.position, [m.view.target[0] + d[0], m.view.target[1] + d[1], m.view.target[2] + d[2]])) return false;
    if (prev && !open(s, prev.position, pose.position)) return false;
    prev = pose;
  }
  return true;
}

/** The tour's crane rises about 8 m, made for a town view; on people it rises CRANE of that, so they stay in the shot. */
export const CRANE = .45;
function trackMove(m: TourMove): TourMove {
  if (m.type !== 'crane-up') return m;
  const lo = m.at(0), aim = m.view.target[1];
  return { ...m, at: k => { const p = m.at(k); return { ...p, position: [p.position[0], lo.position[1] + (p.position[1] - lo.position[1]) * CRANE, p.position[2]], target: [p.target[0], aim + (p.target[1] - aim) * CRANE, p.target[2]] }; } };
}

export class Tracker {
  private random: () => number;
  constructor(seed: number = Date.now()) { this.random = rng(seed); }
  private key = '';
  private centre: number[] | null = null;
  private at = 0;
  private move: TourMove | null = null;
  private start = 0;
  /** The centre when the move started: the move is carried by (centre − origin). */
  private origin: readonly number[] = [0, 0, 0];
  private checked = 0;
  private from: { pose: TourPose; at: number } | null = null;
  private last: TourPose | null = null;
  private failed = -Infinity;
  private shown = new Map<MoveType, number>();
  get type(): MoveType | null { return this.move?.type ?? null; }
  reset() { this.planning = null; this.blocked = false; this.seen = -Infinity; this.replans = []; this.key = ''; this.centre = null; this.move = null; this.from = null; this.last = null; this.failed = -Infinity; }

  /** The tracking pose for hotspot `key` (members' raw centre and spread) at `now` seconds; `'pending'` while the first
   *  move is being planned (Broadcast holds the shot it had); null when no move is clear (Broadcast's solver takes it). */
  pose(key: string, raw: readonly number[], spread: number, now: number, s: Scenery): { pose: TourPose; type: MoveType; cut: boolean } | 'pending' | null {
    if (key !== this.key || !this.centre) { this.reset(); this.key = key; this.centre = [...raw]; this.at = now; }
    else { const w = 1 - Math.exp(-Math.max(0, Math.min(1, now - this.at)) / CENTRE_EMA); for (let i = 0; i < 3; i++) this.centre[i] += (raw[i] - this.centre[i]) * w; this.at = now; }
    const c = this.centre;
    if (!this.move && !this.planning && now < this.failed) return null;
    const d = () => [c[0] - this.origin[0], c[1] - this.origin[1], c[2] - this.origin[2]];
    let steps = STEPS;
    // The next move is planned ahead, LEAD seconds before this one ends, so it is ready when this one comes to rest.
    if (!this.move) { if (!this.planning) this.begin(c, spread, now, false); }
    else if (!this.planning && (now - this.start) / this.move.seconds >= 1 - LEAD / this.move.seconds) this.begin(c, spread, now, false);
    else if (!this.planning && now - this.checked >= CHECK) {
      // The next second of the path, still at most STEPS samples in this frame.
      this.checked = now;
      const k = (now - this.start) / this.move.seconds;
      steps -= 3;
      if (!pathClear(this.move, d(), k, Math.min(1, k + CHECK / this.move.seconds), s)) { this.blocked = true; this.begin(c, spread, now, true); }
    }
    let cut = false;
    if (this.planning) {
      if (this.step(steps, s) === false) { this.move = null; this.from = null; this.planning = null; this.failed = now + RETRY; return null; }
      // A ready move takes over when this one has come to rest at its end (or is blocked, or there is none yet).
      const ready = this.planning?.ready;
      if (ready && (!this.move || this.blocked || now - this.start >= this.move.seconds)) { this.commit(ready, now, s); cut = !this.from; }
    }
    if (!this.move) return 'pending';
    // A blocked move holds its last good pose until the next one is planned; a finished one rests at its end.
    let pose = this.blocked && this.last ? this.last : this.at_(Math.min(1, (now - this.start) / this.move.seconds), d(), now);
    // Every frame's eye is clear (clear points are cached by the scenery) and, at the decision rate, sees the hotspot:
    // between the path's samples a post can cross the sightline and the centre moves. Such a frame holds the last good
    // pose while the next move is planned; after REPLANS re-plans in RETRY s, Broadcast's solver takes over for RETRY s.
    if (!(this.blocked && this.last) && !this.good(pose.position, c, now, s)) {
      if (!this.last) return 'pending';
      pose = this.last; this.blocked = true;
      if (!this.planning) {
        this.replans = this.replans.filter(t => now - t < RETRY);
        if (this.replans.length >= REPLANS) { this.move = null; this.from = null; this.failed = now + RETRY; return null; }
        this.replans.push(now); this.begin(c, spread, now, true);
      }
    }
    this.last = pose;
    return { pose, type: this.move.type, cut };
  }
  private seen = -Infinity;
  private replans: number[] = [];
  private blocked = false;
  /** A plan in progress: the candidate moves (built at the centre `c`), which one and which path sample is next. */
  private planning: { c: number[]; cands: TourMove[]; i: number; j: number; sky: boolean; prev: TourPose | null; ready?: TourMove } | null = null;
  private good(eye: readonly number[], c: readonly number[], now: number, s: Scenery) {
    if (!s.clear(eye)) return false;
    if (now - this.seen < SIGHT_EVERY && now >= this.seen) return true;
    if (!sees(s, eye, [c[0], c[1] + AIM, c[2]])) return false;
    this.seen = now; return true;
  }
  private at_(k: number, d: readonly number[], now: number): TourPose {
    const pose = shift(this.move!.at(k), d);
    if (!this.from) return pose;
    const b = ease((now - this.from.at) / GLIDE);
    if (b >= 1) { this.from = null; return pose; }
    return { position: lerp3(this.from.pose.position, pose.position, b), target: lerp3(this.from.pose.target, pose.target, b), fov: this.from.pose.fov + (pose.fov - this.from.pose.fov) * b };
  }

  /** The ready move runs from now, gliding in from the current pose when that glide is clear (two queries), else a cut. */
  private commit(m: TourMove, now: number, s: Scenery) {
    const previous = this.last, begin = m.at(0);
    this.move = m; this.start = now; this.checked = now; this.origin = this.planning!.c; this.shown.set(m.type, now); this.planning = null; this.blocked = false;
    this.from = previous && s.clear(lerp3(previous.position, begin.position, .5)) && open(s, previous.position, begin.position) ? { pose: previous, at: now } : null;
  }
  /** Starts planning the next move: the types shown least recently first, two azimuths each, from where the camera is. */
  private begin(c: readonly number[], spread: number, now: number, blocked: boolean) {
    const previous = this.last, current = this.move?.type;
    const types = [...TRACK_TYPES].map(t => ({ t, age: now - (this.shown.get(t) ?? -Infinity), r: this.random() }))
      .sort((a, b) => b.age - a.age || a.r - b.r).map(x => x.t).filter(t => t !== current || TRACK_TYPES.length === 1);
    const base = previous ? Math.atan2(previous.position[2] - c[2], previous.position[0] - c[0]) : this.random() * 2 * Math.PI;
    const cands: TourMove[] = [];
    for (const type of types) for (const turn of [0, (this.random() < .5 ? 1 : -1) * Math.PI / 3])
      cands.push(trackMove(makeMove(hotspotView(c, spread, base + turn), type, MOVE_MIN + this.random() * (MOVE_MAX - MOVE_MIN), this.random() < .5 ? 1 : -1)));
    this.planning = { c: [...c], cands, i: 0, j: 0, sky: false, prev: null };
    if (blocked) this.blocked = true;
  }
  /** Up to `steps` checks of the plan in progress (one check: the sky above the hotspot, one path sample of a candidate,
   *  each at most four scenery queries). true: a move is ready; false: none is clear (or a roof); null: still planning. */
  private step(steps: number, s: Scenery): boolean | null {
    const pl = this.planning!;
    if (pl.ready) return true;
    for (; steps > 0; steps--) {
      if (!pl.sky) {
        // Under a roof (a pavilion, a hall, a tent) a moving shot has no room: the framing solver is better there.
        const head = [pl.c[0], pl.c[1] + AIM + .5, pl.c[2]];
        if (s.reach(head, [head[0], head[1] + SKY, head[2]]) < SKY - 1) return false;
        pl.sky = true; continue;
      }
      if (pl.i >= pl.cands.length) return false;
      const m = pl.cands[pl.i], pose = m.at(SAMPLES[pl.j]);
      if (s.clear(pose.position) && sees(s, pose.position, m.view.target) && (!pl.prev || open(s, pl.prev.position, pose.position))) {
        pl.prev = pose;
        if (++pl.j < SAMPLES.length) continue;
        pl.ready = m; return true;
      }
      pl.i++; pl.j = 0; pl.prev = null;
    }
    return null;
  }
}
