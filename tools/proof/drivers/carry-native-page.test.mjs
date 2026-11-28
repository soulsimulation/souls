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


test('setup approval binds the new screenshot and nonce; abort and fixed deadline win over matching approval', async () => {
  const { validateSetupApproval } = await import('./carry-native-page.mjs');
  const ready = { nonce: 'current-run', screenshotSHA256: 'current-image', deadline: 25000 };
  const approval = { approved: true, nonce: ready.nonce, screenshotSHA256: ready.screenshotSHA256 };
  const signal = new AbortController().signal;
  assert.equal(validateSetupApproval(ready, approval, signal, 24999), true);
  for (const bad of [{ ...approval, nonce: 'earlier-run' }, { ...approval, screenshotSHA256: 'earlier-image' }, { ...approval, approved: false }, {}])
    assert.throws(() => validateSetupApproval(ready, bad, signal, 24999), /setup-review-mismatch/);
  assert.throws(() => validateSetupApproval(ready, approval, signal, 25000), /setup-review-timeout/);
  assert.throws(() => validateSetupApproval(ready, approval, signal, 25001), /setup-review-timeout/);
  const aborted = new AbortController(); aborted.abort(Error('owner-aborted'));
  assert.throws(() => validateSetupApproval(ready, approval, aborted.signal, 24000), /owner-aborted/);
});

test('setup publishes source-bound readiness only after screenshot completion and accepts only its matching approval', async () => {
  const fs = await import('node:fs'), { join } = await import('node:path');
  const { setupGate } = await import('./carry-native-page.mjs');
  const root = new URL('../../../.local/', import.meta.url); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(new URL('carry-setup-gate-', root));
  fs.writeFileSync(join(dir, 'native-page-provenance.json'), JSON.stringify({ sourceHead: 'fixture-source', artifactPin: { hash: 'fixture-artifact' } }));
  let release; const screenshot = new Promise(ok => { release = ok; });
  const run = setupGate({ paths: { dir } }, { screenshot: async ({ path }) => { await screenshot; fs.writeFileSync(path, 'new screenshot'); } }, new AbortController().signal);
  assert.equal(fs.existsSync(join(dir, 'setup-ready.json')), false);
  release();
  try {
    while (!fs.existsSync(join(dir, 'setup-ready.json'))) await new Promise(ok => setTimeout(ok, 1));
    const ready = JSON.parse(fs.readFileSync(join(dir, 'setup-ready.json')));
    assert.equal(ready.source.product, 'fixture-source'); assert.equal(ready.source.artifactSHA256, 'fixture-artifact');
    assert.match(ready.screenshotSHA256, /^[a-f0-9]{64}$/); assert.match(ready.source.driverSHA256, /^[a-f0-9]{64}$/);
    assert.match(ready.source.oracleSHA256, /^[a-f0-9]{64}$/); assert.ok(ready.deadline - Date.now() <= 600000 && ready.deadline - Date.now() > 25000);
    fs.writeFileSync(join(dir, 'setup-approval.json'), JSON.stringify({ approved: true, nonce: ready.nonce, screenshotSHA256: ready.screenshotSHA256 }));
    await run;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('the setup window is 600 s by default, CARRY_SETUP_WINDOW_S seconds within 25 to 1800 when set', async () => {
  const { setupWindowMs } = await import('./carry-native-page.mjs');
  assert.equal(setupWindowMs({}), 600000);
  assert.equal(setupWindowMs({ CARRY_SETUP_WINDOW_S: '120' }), 120000);
  assert.equal(setupWindowMs({ CARRY_SETUP_WINDOW_S: '25' }), 25000);
  assert.equal(setupWindowMs({ CARRY_SETUP_WINDOW_S: '1800' }), 1800000);
  assert.equal(setupWindowMs({ CARRY_SETUP_WINDOW_S: '5' }), 25000);
  assert.equal(setupWindowMs({ CARRY_SETUP_WINDOW_S: '99999' }), 1800000);
  assert.equal(setupWindowMs({ CARRY_SETUP_WINDOW_S: 'soon' }), 600000);
});
test('a served file whose body never arrives is a cancelled load in bounded time, never an endless wait', async () => {
  const { readAsset } = await import('./carry-native-page.mjs');
  const state = { loaded: {} };
  await readAsset(state, '/assets/whole.js', { body: async () => Buffer.from('whole') });
  await readAsset(state, '/assets/never.js', { body: () => new Promise(() => {}) }, 20);
  assert.equal(Object.keys(state.loaded).join(), '/assets/whole.js');
  assert.deepEqual(state.cancelledLoads, [{ path: '/assets/never.js', error: 'Error: carry-proof.asset-body-timeout' }]);
});
