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

test('observer evaluation records success and a bounded stalled evaluation without manufacturing installation', async () => {
  const { installContactObserver } = await import('./carry-native-page.mjs');
  const stages = [], config = { kitURL: '/assets/people-kit-fixture.js' };
  const page = { url: () => 'https://example.test/world/', evaluate: async (_factory, value) => { assert.equal(value, config); return { installed: true }; } };
  assert.deepEqual(await installContactObserver(page, config, { record: stage => stages.push(stage) }), { installed: true });
  assert.deepEqual(stages, ['evaluate-begin', 'evaluate-return']);
  stages.length = 0; let failure = 0;
  await assert.rejects(installContactObserver({ ...page, evaluate: () => new Promise(() => {}) }, config,
    { timeoutMs: 5, record: stage => stages.push(stage), onFailure: async () => { failure++; } }), /observer-install-timeout/);
  assert.deepEqual(stages, ['evaluate-begin', 'evaluate-error']); assert.equal(failure, 1);
});
