import assert from 'node:assert/strict';
import test from 'node:test';
import { momentLink, momentTick, seekTick } from './moment-link.ts';
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
