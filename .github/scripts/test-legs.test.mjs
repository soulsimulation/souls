import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_LEGS, legTestFiles, legFiles, testLegs } from './test-legs.mjs';
import { JOBS } from './ci-scope.mjs';

test('each kind\'s legs cover its test files exactly once, one CI job per leg', () => {
  for (const [kind, { legs }] of Object.entries(TEST_LEGS)) {
    const all = legTestFiles(kind), flat = Array.from({ length: legs }, (_, i) => legFiles(kind, i)).flat();
    assert.ok(all.length > legs, kind);
    assert.equal(new Set(flat).size, flat.length, `${kind}: no file in two legs`);
    assert.deepEqual(flat.sort(), all, `${kind}: every file in a leg`);
    assert.deepEqual(JOBS.filter(j => j.kind === kind).map(j => j.shard), Array.from({ length: legs }, (_, i) => i), kind);
  }
  assert.ok(legTestFiles('launcher').includes('tools/world-launcher/soul/card-search.test.mjs'), 'the soul/ files too');
  assert.throws(() => legFiles('launcher', TEST_LEGS.launcher.legs), /Invalid launcher leg/);
});

test('the split balances by measured seconds; unmeasured files weigh one second', () => {
  const legs = testLegs(['a', 'b', 'c', 'd', 'new'], 2, { a: 10, b: 6, c: 3, d: 2 });
  assert.deepEqual(legs.map(l => l.files), [['a', 'new'], ['b', 'c', 'd']]);
  assert.deepEqual(legs.map(l => l.seconds), [11, 11]);
});
