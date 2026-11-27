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

test('a cold link opened while the stream still catches up is sought at once: now is the wall clock\'s on a real-time world', () => {
  const wallUs = 1_795_800_000e6, wall = Math.floor(wallUs / TICK_US), min = 60e6 / TICK_US;
  // the stream starts at its checkpoint 80 minutes back and the link names 30 minutes ago: now is the wall's
  assert.equal(landingNow(wall - 80 * min, wall - 30 * min, wallUs), wall);
  // the stream has reached the moment, or is about now: the page's own clock, as before
  assert.equal(landingNow(wall - 20 * min, wall - 30 * min, wallUs), wall - 20 * min);
  assert.equal(landingNow(wall - 1 * min, wall - 0.5 * min, wallUs), wall - 1 * min);
  // a moment the wall clock has not reached waits for the stream, and so does a stream a day or more behind
  assert.equal(landingNow(wall - 80 * min, wall + 5 * min, wallUs), null);
  assert.equal(landingNow(wall - 25 * 60 * min, wall - 30 * min, wallUs), null);
  // a world whose clock is its own (its day 0 whatever the date) never takes the wall's
  assert.equal(landingNow(10 * min, 40 * min, wallUs), null);
  assert.equal(landingNow(50 * min, 40 * min, wallUs), 50 * min);
});
