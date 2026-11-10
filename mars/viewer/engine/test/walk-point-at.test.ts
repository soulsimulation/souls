// #1428: a walker on a link leg (a stair) has no smoothed segments. pointAt read that leg as a walk leg, so another walker's
// make-way clear-of test (`way`) threw `Cannot read properties of undefined (reading 'length')` and the waiting walk ended
// engine.action-threw (seen on the Eden Tower House stair in #1366's 2x2, on main and the candidate alike). The fix is the
// prospective runtime policy stair-way/1 (`linkWayV1`); without it pointAt computes exactly what it always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointAt } from '../locomotion/walk.ts';

const link = { id: 'stair', kind: 'stairs' as const, from: { level: 0, p: [1, 2] as [number, number], y: 0 }, to: { level: 1, p: [5, 6] as [number, number], y: 3 }, width: 1 };
const walkLeg = (points: [number, number][]) => ({ kind: 'walk' as const, level: 0, points, minClearance: 0.4 });
const ex = (legs: any[], leg: number) => ({ segs: [], route: { legs } as any, leg });

test('#1428 a climber on a link leg: the way is the link exit, never a throw', () => {
  assert.deepEqual(pointAt(ex([walkLeg([[0, 0], [1, 2]]), { kind: 'link', link, ascending: true }, walkLeg([[5, 6], [9, 9]])], 1), 3, true), [5, 6]);
  assert.deepEqual(pointAt(ex([walkLeg([[9, 9], [5, 6]]), { kind: 'link', link, ascending: false }, walkLeg([[1, 2], [0, 0]])], 1), 0, true), [1, 2]);
});

test('#1428 a walk leg not yet entered is its last point, as before', () => {
  assert.deepEqual(pointAt(ex([walkLeg([[0, 0], [3, 4]])], 0), 1, true), [3, 4]);
});

test('#1428 a leg index past the route (a walk at its end) is the last place on the way', () => {
  assert.deepEqual(pointAt(ex([walkLeg([[0, 0], [3, 4]]), { kind: 'link', link, ascending: true }], 2), 0, true), [5, 6]);
  assert.deepEqual(pointAt(ex([walkLeg([[0, 0], [3, 4]])], 5), 0, true), [3, 4]);
});

test('#1428 without stair-way/1 (a history from before its event): exactly the old reads, the throw included', () => {
  assert.deepEqual(pointAt(ex([walkLeg([[0, 0], [3, 4]])], 0), 1), [3, 4], 'a walk leg not yet entered: as always');
  assert.throws(() => pointAt(ex([walkLeg([[0, 0], [1, 2]]), { kind: 'link', link, ascending: true }], 1), 0), /reading 'length'/, 'a link leg throws as it did, so old logs replay as recorded');
});
