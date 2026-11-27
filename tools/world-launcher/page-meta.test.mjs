// 27 Nov (first day): the new engine's page carries the world's clock, so its first frame has the world's light.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newEngineClock, withWorldClock } from './page-meta.mjs';

test('the new engine\'s clock is New York\'s wall time, as worldd\'s calendar gives it', () => {
  assert.equal(newEngineClock(Date.UTC(2026, 10, 27, 6, 40, 1, 250)), '2026-11-27T01:40:01.250', 'standard time: UTC−5');
  assert.equal(newEngineClock(Date.UTC(2026, 6, 1, 16, 0)), '2026-07-01T12:00:00.000', 'summer time: UTC−4 (noon)');
  // the switches: 2 AM local on 8 Mar 2026 (second Sunday) and 1 Nov 2026 (first Sunday)
  assert.equal(newEngineClock(Date.UTC(2026, 2, 8, 6, 59, 59)), '2026-03-08T01:59:59.000');
  assert.equal(newEngineClock(Date.UTC(2026, 2, 8, 7, 0)), '2026-03-08T03:00:00.000');
  assert.equal(newEngineClock(Date.UTC(2026, 10, 1, 5, 59, 59)), '2026-11-01T01:59:59.000');
  assert.equal(newEngineClock(Date.UTC(2026, 10, 1, 6, 0)), '2026-11-01T01:00:00.000');
  // every hour of two years agrees with the zone's own rules
  const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 3_600_000) {
    const p = Object.fromEntries(ny.formatToParts(t).map((x) => [x.type, x.value]));
    assert.equal(newEngineClock(t).slice(0, 16), `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, new Date(t).toISOString());
  }
});

test('the clock is written first in <head>, as the old world server wrote it', () => {
  const html = '<!doctype html><html><head lang="en"><script>window.__simConfig={}</script></head></html>';
  assert.equal(withWorldClock(html, '2026-11-27T01:40:01.250'), '<!doctype html><html><head lang="en"><script>window.__simWorldClock="2026-11-27T01:40:01.250";</script><script>window.__simConfig={}</script></head></html>');
  assert.equal(withWorldClock(html, 'not a clock</script>'), html, 'only a clock');
  assert.equal(withWorldClock('<p>no head</p>', '2026-11-27T01:40:01.250'), '<p>no head</p>');
});
