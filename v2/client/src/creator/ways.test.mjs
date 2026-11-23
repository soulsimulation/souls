// A room's ways through, for furnish (#3728): today's rule on a 0.1 m grid.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { waysOf } from './ways.mjs';

// A 6 × 3 m room with a doorway at each end (x = ±3000 mm).
const room = [[-3000, -1500], [3000, -1500], [3000, 1500], [-3000, 1500]];
const doors = [{ c: [-3000, 0], width: 1000 }, { c: [3000, 0], width: 1000 }];

test('a piece across the room cuts the way between its doors; one against a wall keeps it', () => {
  const w = waysOf(room, doors, []);
  assert.equal(w.doors, 2);
  assert.deepEqual(w.ok([], [-400, -1500, 400, 1100], [], [0, 1400]), { ok: false, why: 'would cut the way to its doors or another piece' });
  assert.deepEqual(w.ok([], [-400, -1500, 400, -1000], [], [0, -500]), { ok: true });
  // A second piece that walls in the first one's front: the first is cut off from the doors.
  const first = [-400, -1500, 400, -1000];
  assert.equal(w.ok([first], [-2000, -1000, 2000, 300], [[0, -500]], [0, 0]).ok, false);
  // A doorway on no wall of this room is not one of its ways.
  assert.equal(waysOf(room, [{ c: [9000, 0], width: 1000 }], []).doors, 0);
});
