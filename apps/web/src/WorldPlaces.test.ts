import assert from 'node:assert/strict';
import test from 'node:test';
import { CURATED_WORLD_LOCATIONS, placesNamedFor } from './WorldPlaces.ts';

test('Explore names the whole-world view after the world it is in, and leaves every other list alone', () => {
  const eden2026 = placesNamedFor(CURATED_WORLD_LOCATIONS, 'Eden 2026');
  assert.equal(eden2026.find((l) => l.id === 'overview')?.label, 'All of Eden 2026');
  assert.ok(!eden2026.some((l) => l.label === 'All of Eden'), 'the scenery\'s own name is not shown beside "Explore Eden 2026"');
  // only that label changes: the same places, views and order
  assert.deepEqual(eden2026.map((l) => ({ ...l, label: l.id === 'overview' ? 'All of Eden' : l.label })), [...CURATED_WORLD_LOCATIONS]);
  assert.equal(placesNamedFor(CURATED_WORLD_LOCATIONS, 'Eden 2026'), eden2026, 'asked again at the next render: the same list');
  assert.equal(placesNamedFor(CURATED_WORLD_LOCATIONS, ' Verdelis Eden ').find((l) => l.id === 'overview')?.label, 'All of Verdelis Eden');
  // a world named Eden, a world with no name, and a list that is not the curated one (a moved world's own places)
  assert.equal(placesNamedFor(CURATED_WORLD_LOCATIONS, 'Eden'), CURATED_WORLD_LOCATIONS);
  assert.equal(placesNamedFor(CURATED_WORLD_LOCATIONS, undefined), CURATED_WORLD_LOCATIONS);
  const own = [{ id: 'context:e_1', label: 'Hillside Home 13' }, { id: 'overview', label: 'Overview deck' }];
  assert.equal(placesNamedFor(own, 'Eden 2026'), own);
});
