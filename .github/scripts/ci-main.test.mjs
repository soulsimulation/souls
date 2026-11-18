import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVERED_JOB, coveredByQueue } from './ci-main.mjs';
import { JOBS } from './ci-scope.mjs';
import { fullScope, mainCiState } from './merge-train.mjs';

const jobs = names => names.map(name => ({ name, conclusion: 'success' }));
const all = jobs(['scope', 'repo', ...JOBS.map(j => j.name), 'ci-ok']);

test('readers of main still take an older run\'s marker job as full scope: merge train and release gate', () => {
  assert.equal(coveredByQueue(jobs(['scope', 'repo', COVERED_JOB, 'ci-ok'])), true);
  assert.equal(coveredByQueue([{ name: COVERED_JOB, conclusion: 'skipped' }]), false);
  assert.equal(fullScope({ event: 'push' }, jobs(['scope', 'repo', COVERED_JOB, 'ci-ok'])), true);
  assert.equal(fullScope({ event: 'push' }, jobs(['scope', 'repo', 'ci-ok'])), false);
  const gate = readFileSync(new URL('../../tools/test-harness/release-gate.mjs', import.meta.url), 'utf8');
  assert.ok(gate.includes(`j.name === '${COVERED_JOB}' && j.conclusion === 'success'`), 'release-gate ciEvidence names the marker job');
});

test('ci.yml: a light merge_group run never covers main; every push runs everything, the newest push only', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /\n  merge-group-covered:\n/, 'no marker job: nothing stands in for the push run');
  assert.doesNotMatch(workflow, /ci-main\.mjs --repo/, 'the push asks no one whether it may skip');
  assert.doesNotMatch(workflow, /steps\.queued|outputs\.covered/);
  const ok = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  assert.match(ok, /needs: \[scope, repo, qualify, smoke\]/);
  // push runs share one group and the newest cancels the older: only the newest main commit is tested
  assert.equal(workflow.match(/^  group: (.*)$/m)[1], "${{ github.event_name == 'push' && 'ci-main' || format('ci-{0}', github.event.pull_request.number || inputs.pr || github.ref) }}");
  assert.equal(workflow.match(/^  cancel-in-progress: (.*)$/m)[1], "${{ github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.action != 'labeled') }}");
  assert.ok(workflow.includes('.github/scripts/ci-main.test.mjs'), 'the repo job runs this test');
});

test('a push run cancelled by a newer one says nothing: main reads the newest completed full push run', () => {
  const run = (id, conclusion) => ({ id, event: 'push', status: 'completed', conclusion });
  const full = () => true;
  assert.deepEqual(mainCiState([run(1, 'success'), run(2, 'cancelled')], full), { conclusion: 'success', since: null });
  assert.deepEqual(mainCiState([run(1, 'failure'), run(2, 'cancelled'), run(3, 'success')], full), { conclusion: 'success', since: null });
  assert.equal(mainCiState([run(1, 'success'), run(2, 'cancelled'), run(3, 'failure')], full).conclusion, 'failure');
  assert.equal(fullScope({ event: 'push' }, all), true);
});
