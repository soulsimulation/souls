// #3738: the Explore list's views and search. Choosing a view flies the camera only (a PoseFlight, tested in
// tour.test.ts); nothing here touches a world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDEN_VIEWS } from '../welcome/views.ts';
import { EDEN_STOPS } from '../welcome/stops.ts';
import { matchViews, searchKey } from '../welcome/explore.ts';

test('A1: Explore lists today\'s Eden views in today\'s order: the places, then the interiors, then the districts', () => {
  assert.equal(EDEN_VIEWS.length, 95);
  assert.equal(new Set(EDEN_VIEWS.map((v) => v.id)).size, EDEN_VIEWS.length);
  assert.equal(EDEN_VIEWS[0].id, 'gallery');
  assert.equal(EDEN_VIEWS.findIndex((v) => v.id.startsWith('int-')), 34);
  assert.equal(EDEN_VIEWS.findIndex((v) => v.id.startsWith('region-')), 34 + EDEN_VIEWS.filter((v) => v.id.startsWith('int-')).length);
  for (const v of EDEN_VIEWS) {
    assert.ok(v.label.trim(), v.id);
    assert.ok(Math.hypot(v.p[0] - v.target[0], v.p[1] - v.target[1], v.p[2] - v.target[2]) > 0.5, v.id);
  }
  // The tour's stops are the same views, pose for pose.
  for (const s of EDEN_STOPS) assert.deepEqual(EDEN_VIEWS.find((v) => v.id === s.id), s, s.id);
});

test('A1: the search is by name, case- and accent-blind; empty shows every view; order is kept', () => {
  assert.equal(matchViews(EDEN_VIEWS, '').length, EDEN_VIEWS.length);
  assert.equal(matchViews(EDEN_VIEWS, '   ').length, EDEN_VIEWS.length);
  assert.ok(matchViews(EDEN_VIEWS, 'cafe').some((v) => v.id === 'int-cafe'));
  assert.deepEqual(matchViews(EDEN_VIEWS, 'CAFÉ'), matchViews(EDEN_VIEWS, 'cafe'));
  const lib = matchViews(EDEN_VIEWS, 'library').map((v) => v.id);
  assert.ok(lib.includes('library') && lib.includes('gallery') && lib.includes('int-library'));
  assert.deepEqual(lib, EDEN_VIEWS.filter((v) => lib.includes(v.id)).map((v) => v.id));
  assert.deepEqual(matchViews(EDEN_VIEWS, 'no such view'), []);
  assert.equal(searchKey('Makers’ Yard Café'), 'makers’ yard cafe');
});
