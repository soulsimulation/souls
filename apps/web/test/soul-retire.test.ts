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

test('0.137: on a world the new engine runs, the confirmed retire goes to the directory, never the old route', async () => {
  const calls: unknown[][] = [], directory: string[] = [];
  const api = async (...a: unknown[]) => { calls.push(a); return { status: 409 }; };
  const byDirectory = async (id: string) => { directory.push(id); return true; };
  assert.equal(await retireSoul(api, { id: 's_1', name: 'Fern' }, () => false, byDirectory), false);
  assert.deepEqual(directory, [], 'cancelled: nothing is sent');
  assert.equal(await retireSoul(api, { id: 's_1', name: 'Fern' }, () => true, byDirectory), true);
  assert.deepEqual(directory, ['s_1']);
  assert.deepEqual(calls, [], 'the old process\'s DELETE (409 world.new-engine there) is not sent');
  assert.equal(await retireSoul(api, { id: 's_1', name: 'Fern' }, () => true, async () => false), false, 'refused reads as not done');
});
