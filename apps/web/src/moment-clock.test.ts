import assert from 'node:assert/strict';
import test from 'node:test';
import { momentAgo, momentClock, momentDay } from './moment-clock.ts';

test('the moment clock reads to the second, and Back 1 min moves it back exactly one minute', () => {
  const at = Date.UTC(2026, 10, 24, 16, 31, 7);
  assert.equal(momentClock(at, 'UTC', 'en-US'), '4:31:07 PM');
  assert.equal(momentClock(at - 60_000, 'UTC', 'en-US'), '4:30:07 PM');
  assert.equal(momentClock(at, 'America/New_York', 'en-US'), '11:31:07 AM');
  assert.equal(momentDay(at, 'UTC', 'en-US'), 'Tue, Nov 24');
  assert.equal(momentClock(NaN), '');
  assert.equal(momentClock(at, 'Not/A_Zone', 'en-US').length > 0, true, 'an unknown zone falls back to the viewer\'s');
});

test('how long ago a moment was', () => {
  const now = Date.UTC(2026, 10, 24, 16, 31, 7);
  assert.equal(momentAgo(now - 3000, now), '');
  assert.equal(momentAgo(now - 30_000, now), '30 s ago');
  assert.equal(momentAgo(now - 60_000, now), '1 min ago');
  assert.equal(momentAgo(now - 125 * 60_000, now), '2 h 5 min ago');
  assert.equal(momentAgo(now - 120 * 60_000, now), '2 h ago');
  assert.equal(momentAgo(now - 3 * 86_400_000, now), '3 days ago');
});
