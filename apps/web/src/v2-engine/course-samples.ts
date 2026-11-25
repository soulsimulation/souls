// K4 (0.135): where a thing on a course (a balloon, field 80, #3603) is, worked out where the readers run. The stream and
// history workers hold the replica, so they call its `courseAt` and post the places with each part or bundle; the page
// never loads the replica itself. The bridge (bridge.ts) reads a node's place at any time between two posted places.

/** How far apart the posted places are, world µs: a tenth of a second, two of the take's ticks. */
export const COURSE_STEP_US = 100_000;

/** The replica's `courseAt`: `[x, y, z, vx, vy, vz]` µm and µm a second in the node's parent's frame at world time `t`
 *  µs; throws by name. */
export type CourseAt = (field: Uint8Array, t: bigint) => ArrayLike<bigint>;

/** Places by node id, flat `[t µs, x, y, z µm, ...]`, in time order; a seat that moves with its cabin (N14) by
 *  [`seatKey`]. */
export type CoursePlaces = Record<string, number[]>;

/** At most this many places a node, the newest (an hour at COURSE_STEP_US). A generation's first part runs from world
 *  time 0 to now (live bench-eden, 24 Nov: from 0 to 1.8e15 µs): stepping all of it pushed past the largest array and
 *  the part was never shown, so the page said "Catching up" for good. */
export const COURSE_MAX_PLACES = 36_000;

/** The places of every node with a course from `from` to `to` (world µs, both ends), `step` apart, the newest
 *  COURSE_MAX_PLACES of them. A node whose course the replica refuses is left out (the page then draws it where it was
 *  placed). */
/** N14: the key of slot `slot`'s places of node `id` (a ride's seat that moves with its cabin). */
export const seatKey = (id: string, slot: number) => `${id}#${slot}`;

export function coursePlaces(courseAt: CourseAt, nodes: Iterable<{ id: string; course?: Uint8Array; seats?: Record<number, Uint8Array> }>, from: number, to: number,
  step = COURSE_STEP_US): CoursePlaces {
  const out: CoursePlaces = {};
  if (!(to >= from) || !Number.isFinite(from) || !Number.isFinite(to) || !(step > 0)) return out;
  const times: number[] = [];
  for (let t = Math.max(Math.floor(from / step), Math.ceil(to / step) - COURSE_MAX_PLACES) * step; t < to; t += step) times.push(t);
  times.push(to);
  const one = (key: string, course: Uint8Array) => {
    try {
      const flat: number[] = [];
      for (const t of times) { const v = courseAt(course, BigInt(Math.floor(t))); flat.push(t, Number(v[0]), Number(v[1]), Number(v[2])); }
      out[key] = flat;
    } catch { /* a course the replica refuses is not moved */ }
  };
  for (const n of nodes) {
    if (n.course) one(n.id, n.course);
    for (const [slot, c] of Object.entries(n.seats ?? {})) one(seatKey(n.id, Number(slot)), c);
  }
  return out;
}

/** First-day round 4: how far ahead `courseLeaves` looks for a still thing to move on, world µs. */
export const LEAVES_LOOK_US = 10 * 60_000_000;

/** First-day round 4: when each node on a course that stands still at world time `at` µs moves on again (world µs, to a
 *  tenth of a second): a balloon waiting at its stop with a rider aboard takes off then. Left out when it is moving at
 *  `at`, does not move within `look`, or its course is refused. The page says "Aboard — takes off in N s" from it. */
export function courseLeaves(courseAt: CourseAt, nodes: Iterable<{ id: string; course?: Uint8Array }>, at: number,
  look = LEAVES_LOOK_US, step = 1_000_000): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Number.isFinite(at)) return out;
  for (const n of nodes) {
    if (!n.course) continue;
    const course = n.course;
    const still = (t: number) => { const v = courseAt(course, BigInt(Math.floor(t))); return Number(v[3]) === 0 && Number(v[4]) === 0 && Number(v[5]) === 0; };
    try {
      if (!still(at)) continue;
      for (let t = at + step; t <= at + look; t += step) {
        if (still(t)) continue;
        let lo = t - step, hi = t;
        while (hi - lo > 100_000) { const mid = Math.floor((lo + hi) / 2); if (still(mid)) lo = mid; else hi = mid; }
        out[n.id] = hi;
        break;
      }
    } catch { /* a course the replica refuses is not moved */ }
  }
  return out;
}

/** Adds `more` places to `held` (each node's in time order, a later one replacing an earlier one at the same time) and
 *  drops those before `cut` µs, keeping the last before it so a time just after `cut` still has a place. */
export function keepPlaces(held: Map<string, number[]>, more: CoursePlaces | undefined, cut = -Infinity): void {
  for (const [id, flat] of Object.entries(more ?? {})) {
    const had = held.get(id) ?? [];
    let i = had.length;
    while (i >= 4 && had[i - 4] >= flat[0]) i -= 4;
    held.set(id, had.slice(0, i).concat(flat));
  }
  if (cut === -Infinity) return;
  for (const [id, flat] of held) {
    let i = 0;
    while (i + 4 < flat.length && flat[i + 4] <= cut) i += 4;
    if (i) held.set(id, flat.slice(i));
  }
}

/** Where `flat`'s places have their node at world time `t` (µm): between the two around it, or the first before them
 *  and the last after; null with none. */
export function placeAt(flat: readonly number[] | undefined, t: number): [number, number, number] | null {
  if (!flat || flat.length < 4) return null;
  if (t <= flat[0]) return [flat[1], flat[2], flat[3]];
  const n = flat.length / 4;
  if (t >= flat[(n - 1) * 4]) return [flat[(n - 1) * 4 + 1], flat[(n - 1) * 4 + 2], flat[(n - 1) * 4 + 3]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (flat[mid * 4] <= t) lo = mid; else hi = mid; }
  const a = lo * 4, b = hi * 4, f = (t - flat[a]) / (flat[b] - flat[a]);
  return [flat[a + 1] + (flat[b + 1] - flat[a + 1]) * f, flat[a + 2] + (flat[b + 2] - flat[a + 2]) * f, flat[a + 3] + (flat[b + 3] - flat[a + 3]) * f];
}
