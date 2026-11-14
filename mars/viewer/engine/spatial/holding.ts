// Holding spots (stair lease, #2263; docs/design/stair-traffic.md §2): where a walker waits for a single-file flight
// without standing in its doorway. For each end of a link: up to three spots on that end's floor, each with standing room
// and a straight clear walk to the end's approach point, out of the flight's way: a waiting body never overlaps a body on
// the flight, on its way between the flight and the approach point, or standing at either point. Nothing moves a body
// here: this only reads the level grid, in a fixed order (rings outward, then angle), so the answer is a pure function of
// the link and the grid.
import { hypot, rot2, type Vec2 } from '../core/math.ts';
import { clearanceAt, segmentClearance, type LevelGrid } from './grid.ts';
import { linkApproach, PLAN_MARGIN } from './path.ts';
import { HUMAN_PROFILE, type Link } from './types.ts';

export const HOLDING_MAX = 3;
const RINGS = [0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.25, 2.5, 2.75, 3, 3.5, 4];   // m from the approach point
const ANGLES = 32;

/** A single-file link: usable by a body (the planner's own width test) but too narrow for two to pass. */
export function singleFile(link: Link, radius = HUMAN_PROFILE.radius): boolean {
  const r = radius + PLAN_MARGIN;
  return link.usable && link.width >= 2 * r && link.width < 4 * r && (link.kind === 'stairs' || link.kind === 'ladder' || link.kind === 'ramp');
}

/** Horizontal distance from q to a polyline. */
function distToLine(pts: Vec2[], q: Vec2): number {
  let best = pts.length === 1 ? hypot(q[0] - pts[0][0], q[1] - pts[0][1]) : Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], n = dx * dx + dz * dz;
    const t = n ? Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / n)) : 0;
    best = Math.min(best, hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz));
  }
  return best;
}

/**
 * A flight's walking line as a body standing on `level` meets it, seen from above: at an end on that level, its approach
 * point and entry; and the steps from a step below that floor to head height above it. A floor stacked over or under
 * the flight's far end does not read that end's points. Empty when the flight has no end on `level`.
 */
export function flightLine(link: Link, level: number): Vec2[] {
  const floor = link.from.level === level ? link.from.y : link.to.level === level ? link.to.y : undefined;
  if (floor === undefined) return [];
  const steps = link.path.filter((s) => s[1] >= floor - 0.3 && s[1] <= floor + HUMAN_PROFILE.height).map((s): Vec2 => [s[0], s[2]]);
  const head = link.from.level === level ? [linkApproach(link, true).approach, link.from.p] : [];
  const foot = link.to.level === level ? [link.to.p, linkApproach(link, false).approach] : [];
  return [...head, ...steps, ...foot];
}

/** Room, centre to centre, a waiting body keeps from a flight's walking line: half its width plus its own radius. */
export const flightClear = (link: Link, radius = HUMAN_PROFILE.radius) => link.width / 2 + radius;

/**
 * Up to HOLDING_MAX holding spots at one end of `link` (`ascending`: the bottom end, where climbers enter; else the top),
 * on `g`, that end's level grid. A spot has standing room (the planner's radius), a straight walk to the approach point
 * with room for the body, and keeps a body width (centre to centre) from the approach and entry points, `flightClear`
 * from the walking line on this end's floor (flightLine) of every flight in `flights` (default: this one; a floor two flights share passes both), and
 * a body width plus a margin from the other spots. Nearest first; [] when the floor has no such room.
 */
export function holdingSpots(link: Link, ascending: boolean, g: LevelGrid, opts: { radius?: number; flights?: Link[] } = {}): Vec2[] {
  const radius = opts.radius ?? HUMAN_PROFILE.radius, r = radius + PLAN_MARGIN, body = 2 * radius;
  const { entry, approach } = linkApproach(link, ascending);
  const flights = (opts.flights ?? [link]).map((f) => ({ line: flightLine(f, entry.level), clear: flightClear(f, radius) })).filter((f) => f.line.length);
  const out: Vec2[] = [];
  for (const d of RINGS) {
    for (let k = 0; k < ANGLES; k++) {
      const q = rot2([d, 0], (k * 2 * Math.PI) / ANGLES), s: Vec2 = [approach[0] + q[0], approach[1] + q[1]];
      if (clearanceAt(g, s) < r) continue;
      if (hypot(s[0] - approach[0], s[1] - approach[1]) < body || hypot(s[0] - entry.p[0], s[1] - entry.p[1]) < body) continue;
      if (flights.some((f) => distToLine(f.line, s) < f.clear)) continue;
      if (out.some((o) => hypot(s[0] - o[0], s[1] - o[1]) < body + 0.1)) continue;
      if (segmentClearance(g, s, approach) < radius) continue;
      out.push(s);
      if (out.length === HOLDING_MAX) return out;
    }
  }
  return out;
}
