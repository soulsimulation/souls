// #1649: a real-time world is lit by an equator sun on its local clock: daylight around 06:00–18:00 local, all year.
import test from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, sunTimes } from '../../../mars/viewer/engine/env/sun.ts';
import { realClockOf, setEquatorSun, sunSite } from './sun-site.ts';

const hours = (iso: string | null) => { const t = iso!.slice(11, 16); return Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60; };

test('equator sun: sunrise near 06:00 and sunset near 18:00 local in every season', () => {
  setEquatorSun(true);
  try {
    for (const date of ['2026-12-21', '2027-03-20', '2027-06-21', '2027-09-22', '2026-11-09']) {
      const noon = `${date}T12:00`, t = sunTimes(noon, ...sunSite(noon));
      assert.ok(Math.abs(hours(t.sunriseLocal) - 6) <= 0.5, `${date} sunrise ${t.sunriseLocal}`);
      assert.ok(Math.abs(hours(t.sunsetLocal) - 18) <= 0.5, `${date} sunset ${t.sunsetLocal}`);
      assert.ok(solarPosition(noon, ...sunSite(noon)).elevationDeg > 60, `${date}: high sun at local noon`);
      const night = `${date}T23:00`;
      assert.ok(solarPosition(night, ...sunSite(night)).elevationDeg < -30, `${date}: deep night at 23:00`);
    }
  } finally { setEquatorSun(false); }
});

test('other worlds keep the Bombay Beach sun; the state decides', () => {
  assert.deepEqual(sunSite('2027-06-21T12:00'), [undefined, undefined]);
  const summer = sunTimes('2027-06-21T12:00');
  assert.ok(hours(summer.sunsetLocal) > 19.5, `a long Californian summer day: ${summer.sunsetLocal}`);
  assert.equal(realClockOf({ time: { clock: 'real' } }), true);
  assert.equal(realClockOf({ time: { clock: 'accelerated' } }), false);
  assert.equal(realClockOf({ time: {} }), false);
  assert.equal(realClockOf(null), false);
});
