// The generic horizon ring (WorldEntityLayer.buildHorizon) takes the world's ground: grass keeps its own green, a desert
// world gets a desert horizon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundBaseFor, horizonBaseFor } from './ground-palette.ts';

test('the horizon ring is near the world\'s ground colour; grass, none or an unknown palette keep the ring\'s green', () => {
  for (const p of [undefined, 'grass', 'lava']) assert.equal(horizonBaseFor(p), '#6f8f6a', String(p));
  for (const p of ['desert', 'playa', 'snow']) assert.equal(horizonBaseFor(p), groundBaseFor(p), p);
  assert.equal(horizonBaseFor('desert'), '#d8b27a');
});
