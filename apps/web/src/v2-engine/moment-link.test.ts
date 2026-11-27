import assert from 'node:assert/strict';
import test from 'node:test';
import { landingNow, momentLink, momentTick, seekTick } from './moment-link.ts';
import { TICK_US } from './takes.ts';

test('X3: a moment link names the world time and opens a day later at that moment while the history keeps it', () => {
  const hour = 3600e6 / TICK_US, day = 24 * hour, shown = 1_000 * day + 1234;
  const link = momentLink('https://soul.example/w/eden?x=1#old', shown);
  assert.equal(link, `https://soul.example/w/eden?x=1#t=${shown * TICK_US}`);
  const at = momentTick(new URL(link).hash);
  assert.equal(at, shown);
  // opened a day later: a moved world's history reaches it; a world without one keeps the last hour
  assert.equal(seekTick(at!, shown + day, hour, true), shown);
  assert.equal(seekTick(at!, shown + day, hour, false), shown + day - hour);
  // a time not reached yet shows now; no time, a bad time or a negative one is no moment
  assert.equal(seekTick(shown + 10, shown, hour, true), shown);
  for (const h of ['', '#', '#t=', '#t=abc', '#t=-5', '#t=1.5']) assert.equal(momentTick(h), null, h);
});

test('a link to a past moment of a real-time world is sought at once: now is the wall clock\'s, whatever the stream has shown', () => {
  const wallUs = 1_795_800_000e6, wall = Math.floor(wallUs / TICK_US), min = 60e6 / TICK_US;
  // nothing drawn yet, and a stream that starts at its checkpoint 80 minutes back while the link names 30 minutes ago
  assert.equal(landingNow(null, wall - 30 * min, wallUs), wall);
  assert.equal(landingNow(wall - 80 * min, wall - 30 * min, wallUs), wall);
  // a viewer's clock a little slow: never earlier than what the stream has shown
  assert.equal(landingNow(wall + 2 * min, wall - 30 * min, wallUs), wall + 2 * min);
  // a moment the wall clock has not reached waits for the stream: its clock at the moment, or about now
  assert.equal(landingNow(null, wall + 5 * min, wallUs), null);
  assert.equal(landingNow(wall - 80 * min, wall + 5 * min, wallUs), null);
  assert.equal(landingNow(wall - 1 * min, wall + 5 * min, wallUs), wall - 1 * min);
  assert.equal(landingNow(wall + 6 * min, wall + 5 * min, wallUs), wall + 6 * min);
  // a world whose clock is its own (its day 0 whatever the date) never takes the wall's: it waits for its stream
  assert.equal(landingNow(null, 40 * min, wallUs), null);
  assert.equal(landingNow(10 * min, 40 * min, wallUs), null);
  assert.equal(landingNow(50 * min, 40 * min, wallUs), 50 * min);
});
