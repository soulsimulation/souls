// #2263 (stair lease, task 1): holding spots off each end of a single-file flight. Read-only geometry; nothing moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrids, clearanceAt, segmentClearance } from '../spatial/grid.ts';
import { holdingSpots, HOLDING_MAX, singleFile } from '../spatial/holding.ts';
import { linkApproach, PLAN_MARGIN } from '../spatial/path.ts';
import { HUMAN_PROFILE, type Link, type SpatialScene } from '../spatial/types.ts';
import type { Vec2 } from '../core/math.ts';

const R = HUMAN_PROFILE.radius, BODY = 2 * R;
const obb = (c: Vec2, half: Vec2) => ({ c, half, yaw: 0 });
// A straight flight from (0, 0) on the ground up to (3, 0) on a floor 3 m up, eight steps.
const stair = (width: number): Link => ({
  id: 'stair', kind: 'stairs', from: { level: 0, p: [0, 0], y: 0 }, to: { level: 1, p: [3, 0], y: 3 }, width, heading: 0, usable: true,
  path: Array.from({ length: 8 }, (_, i): [number, number, number] => [0.3 + i * 0.35, 0.35 * (i + 1), 0]),
});
const scene = (upperHalf: Vec2, link: Link): SpatialScene => ({
  bounds: [-8, -8, 12, 8],
  levels: [{ id: 0, y: 0, label: 'ground' }, { id: 1, y: 3, label: 'floor' }],
  surfaces: [{ id: 'g', level: 0, y: 0, obb: obb([0, 0], [6, 6]) }, { id: 'f', level: 1, y: 3, obb: obb([3 + upperHalf[0] - 0.4, 0], upperHalf) }],
  obstacles: [], links: [link],
} as SpatialScene);

const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// The flight as a body on `level` meets it, built here from the link's own fields (not holding.ts): that floor's entry and
// approach points and the steps from a step below the floor to head height above it.
const flightOn = (link: Link, level: number): Vec2[] => {
  const y = link.from.level === level ? link.from.y : link.to.y;
  const steps = link.path.filter(s => s[1] >= y - 0.3 && s[1] <= y + HUMAN_PROFILE.height).map((s): Vec2 => [s[0], s[2]]);
  return [...(link.from.level === level ? [linkApproach(link, true).approach, link.from.p] : []), ...steps, ...(link.to.level === level ? [link.to.p, linkApproach(link, false).approach] : [])];
};
const lineDist = (pts: Vec2[], q: Vec2) => Math.min(...pts.slice(1).map((b, i) => {
  const a = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], n = dx * dx + dz * dz, t = n ? Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / n)) : 0;
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz);
}));

test('#2263 each end of a flight on roomy floors has three holding spots, out of its way', () => {
  const link = stair(0.8), grids = buildGrids(scene([3, 3], link), 0.1);
  assert.equal(singleFile(link), true);
  for (const ascending of [true, false]) {
    const { entry, approach } = linkApproach(link, ascending), g = grids.levels.get(entry.level)!;
    const spots = holdingSpots(link, ascending, g);
    assert.equal(spots.length, HOLDING_MAX, `${ascending ? 'bottom' : 'top'}: ${JSON.stringify(spots)}`);
    for (const s of spots) {
      assert.ok(clearanceAt(g, s) >= R + PLAN_MARGIN, 'standing room');
      assert.ok(d(s, approach) >= BODY && d(s, entry.p) >= BODY, 'a body width from the approach and entry points');
      const line = flightOn(link, entry.level); assert.ok(line.length > 2);
      assert.ok(lineDist(line, s) >= link.width / 2 + R, 'clear of the flight');
      assert.ok(segmentClearance(g, s, approach) >= R, 'a clear walk to the approach point');
      for (const o of spots) if (o !== s) assert.ok(d(s, o) >= BODY, 'apart from each other');
    }
    assert.deepEqual(holdingSpots(link, ascending, g), spots, 'the same answer every time');
  }
});

test('#2263 a landing with no room beside the flight has no holding spot; a wide flight is not single-file', () => {
  const link = stair(0.8), grids = buildGrids(scene([0.45, 0.45], link), 0.1);
  assert.deepEqual(holdingSpots(link, false, grids.levels.get(1)!), []);
  assert.equal(singleFile(stair(1.6)), false, 'two bodies can pass');
  assert.equal(singleFile({ ...stair(0.8), usable: false }), false, 'unusable');
});
