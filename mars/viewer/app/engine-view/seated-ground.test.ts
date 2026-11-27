import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatedFootWeight, seatedSupportY } from './seated-ground.ts';

test('seated support retains the recorded platform and accepts nearby ground without snapping to a shelf', () => {
  assert.equal(seatedSupportY(.1, 0), .1);
  assert.equal(seatedSupportY(0, .05), .05);
  assert.equal(seatedSupportY(0, 1), 0);
  assert.equal(seatedSupportY(0, null), 0);
});

test('ordinary seated legs can reach support; high seats and reach boundaries preserve natural extension', () => {
  assert.equal(seatedFootWeight([0, .555, 0], [.43, .026, 0], .9, 1), 1);
  assert.equal(seatedFootWeight([0, 1.19, 0], [.43, .026, 0], .9, 1), 0);
  assert.equal(seatedFootWeight([0, .555, 0], [.43, .026, 0], .9, 0), 0);
  const a = seatedFootWeight([0, 0, 0], [.98, 0, 0], 1, 1), b = seatedFootWeight([0, 0, 0], [.981, 0, 0], 1, 1);
  assert(a > b && a < 1 && b > 0);
  for (const edge of [.97, .995]) assert(Math.abs(seatedFootWeight([0, 0, 0], [edge - 1e-7, 0, 0], 1, 1) - seatedFootWeight([0, 0, 0], [edge + 1e-7, 0, 0], 1, 1)) < 1e-8);
});
