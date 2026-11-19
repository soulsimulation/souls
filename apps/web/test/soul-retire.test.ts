import test from 'node:test';
import assert from 'node:assert/strict';
import { retireQuestion, retireSoul } from '../src/soul-retire.ts';

test('#3375 retire asks once, naming the Soul and saying it cannot come back, then calls the owner retire', async () => {
  const calls: unknown[][] = [], asked: string[] = [];
  const api = async (...a: unknown[]) => { calls.push(a); return { status: 200 }; };
  // Cancelled: nothing is sent.
  assert.equal(await retireSoul(api, { id: 's/1', name: 'Oriel' }, q => { asked.push(q); return false; }), false);
  assert.equal(calls.length, 0);
  // Confirmed: one DELETE on the existing owner route.
  assert.equal(await retireSoul(api, { id: 's/1', name: 'Oriel' }, q => { asked.push(q); return true; }), true);
  assert.deepEqual(calls, [['/v1/souls/s%2F1', undefined, 'DELETE']]);
  assert.equal(asked.length, 2);
  assert.equal(asked[0], retireQuestion('Oriel'));
  assert.match(asked[0], /Oriel/); assert.match(asked[0], /cannot come back/);
  // A refused retire reads as not done.
  assert.equal(await retireSoul(async () => ({ status: 403 }), { id: 'x', name: 'X' }, () => true), false);
});
