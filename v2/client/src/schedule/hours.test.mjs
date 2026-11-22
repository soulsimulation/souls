// #3699: a place's opening hours as people write them, and back, in E7's rows (replica::schedule::Hours).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hoursRows, hoursText } from './hours.mjs';

const H = 3_600_000_000;

test('today\'s forms make weekly rows, every day unless days are named', () => {
  assert.deepEqual(hoursRows(['07:00-15:00']), [[2, 127, 7 * H, 15 * H]]);
  assert.deepEqual(hoursRows(['09:00-13:00@sat,sun']), [[2, 0b1100000, 9 * H, 13 * H]]);
  assert.deepEqual(hoursRows(['09:30-17:00@mon-fri']), [[2, 0b0011111, 9.5 * H, 17 * H]]);
  assert.deepEqual(hoursRows(['18:00-02:00@fri-mon']), [[2, 0b1110001, 18 * H, 26 * H]], 'past midnight, days wrapping');
  assert.deepEqual(hoursRows(['00:00-24:00']), [[2, 127, 0, 24 * H]]);
  assert.deepEqual(hoursRows([]), []);
});

test('a malformed span is refused by name', () => {
  for (const bad of ['7-15', '25:00-26:00', '09:00-13:00@someday', '09:00-24:30']) {
    assert.throws(() => hoursRows([bad]), (e) => e.code === 'hours.malformed', bad);
  }
});

test('rows read back as written, and anything else is not hours', () => {
  for (const s of ['07:00-15:00', '09:00-13:00@sat,sun', '18:00-02:00@mon,fri,sat,sun']) {
    assert.deepEqual(hoursText(hoursRows([s])), [s]);
  }
  assert.deepEqual(hoursText([[1n, 5n, 9n]]), ['world 5us-9us']);
  assert.equal(hoursText('x'), null);
  assert.equal(hoursText([[3, 1]]), null);
});
