import test from 'node:test';
import assert from 'node:assert/strict';
import { wholeRunFailure } from './carry-native-page.mjs';
test('whole lifecycle fails exceptions and later bad contact even after an earlier passing lift', () => {
  const observer = { counts: { 'passed-native-pair': 30, 'native-release-observation': 10, 'native-inactive-observation': 20 }, failures: [], failedWitnesses: [] };
  assert.equal(wholeRunFailure(observer, []), false);
  assert.equal(wholeRunFailure({ ...observer, failures: [{ reason: 'map required' }] }, []), true);
  assert.equal(wholeRunFailure({ ...observer, failedWitnesses: [{ result: { status: 'failed-native-pair' } }] }, []), true);
  assert.equal(wholeRunFailure({ ...observer, counts: { ...observer.counts, 'failed-measurement': 1 } }, []), true);
  assert.equal(wholeRunFailure(observer, ['page error']), true);
  assert.equal(wholeRunFailure(null, []), true);
});
