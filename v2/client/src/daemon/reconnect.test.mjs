// A refused sign-in is not a drop: the daemon does not sign in again with the same refused token every few seconds.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { REFUSED_FIRST, REFUSED_MOST, WAIT_MOST, reconnectWait } from './reconnect.mjs';

const least = () => 0, most = () => 1;

test('a dropped socket is tried again at once, growing to 5 s', () => {
  assert.equal(reconnectWait(0, 0, most), 100);
  assert.equal(reconnectWait(3, 0, most), 800);
  assert.equal(reconnectWait(99, 0, most), WAIT_MOST);
  assert.equal(reconnectWait(99, 0, least), WAIT_MOST / 2);
});

test('a refused sign-in waits a minute, then longer, to 15 min: a few tries an hour, not hundreds', () => {
  assert.equal(reconnectWait(0, 1, least), REFUSED_FIRST / 2, 'the first refusal waits at least 30 s');
  assert.equal(reconnectWait(0, 1, most), REFUSED_FIRST);
  assert.equal(reconnectWait(0, 2, most), 2 * REFUSED_FIRST);
  assert.equal(reconnectWait(0, 50, most), REFUSED_MOST);
  // The night on soul.game: one refused daemon all night. Count its sign-ins in an hour after the first refusal.
  let t = 0, tries = 0;
  for (let refusals = 1; t < 3_600_000; refusals++) { t += reconnectWait(0, refusals); tries++; }
  assert.ok(tries <= 10, `${tries} refused sign-ins in the first hour (it was about 770)`);
});
