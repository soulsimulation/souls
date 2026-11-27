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

test('ci.yml: nothing stands in for main\'s full run; pushes run newest only, the daily run in its own uncancelled group', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /\n  merge-group-covered:\n/, 'no marker job: nothing stands in for a full run');
  assert.doesNotMatch(workflow, /ci-main\.mjs --repo/, 'the push asks no one whether it may skip');
  assert.doesNotMatch(workflow, /steps\.queued|outputs\.covered/);
  const ok = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  assert.match(ok, /needs: \[scope, repo, codex-files, qualify, smoke, group-check\]/);
  // push runs share one group and the newest cancels the older: only the newest main commit is tested. The daily full
  // run has its own group, which nothing cancels (cancel-in-progress is false for schedule).
  assert.match(workflow, /\n  schedule:\n    - cron: '23 6 \* \* \*'\n/);
  assert.equal(workflow.match(/^  group: (.*)$/m)[1], "${{ github.event_name == 'push' && 'ci-main' || github.event_name == 'schedule' && 'ci-daily' || format('ci-{0}', github.event.pull_request.number || inputs.pr || github.ref) }}");
  assert.equal(workflow.match(/^  cancel-in-progress: (.*)$/m)[1], "${{ github.event_name == 'push' || github.event_name == 'pull_request' }}");
  assert.ok(workflow.includes('.github/scripts/ci-main.test.mjs'), 'the repo job runs this test');
});

test('main reads the newest completed full run, the daily or a manual one; light and cancelled push runs never prove it', () => {
  const run = (id, conclusion, event = 'push') => ({ id, event, status: 'completed', conclusion });
  const light = jobs(['scope', 'repo', ...JOBS.filter(j => !j.heavy).map(j => j.name), 'ci-ok']);
  const full = r => fullScope(r, light);
  assert.equal(fullScope({ event: 'push' }, light), false, 'a light push is not full scope');
  assert.equal(fullScope({ event: 'schedule' }, []), true);
  assert.equal(fullScope({ event: 'workflow_dispatch' }, []), true);
  assert.deepEqual(mainCiState([run(1, 'success', 'schedule'), run(2, 'success'), run(3, 'cancelled')], full), { conclusion: 'success', since: null });
  assert.deepEqual(mainCiState([run(1, 'failure', 'schedule'), run(2, 'success'), run(3, 'success', 'workflow_dispatch')], full), { conclusion: 'success', since: null });
  assert.deepEqual(mainCiState([run(1, 'failure', 'schedule'), run(2, 'success')], full), { conclusion: 'failure', since: 1 }, 'a red daily run stays red under light greens');
  assert.equal(mainCiState([run(1, 'success', 'schedule'), run(2, 'failure')], full).conclusion, 'failure', 'a red light push counts');
  assert.equal(mainCiState([run(2, 'success'), run(3, 'success')], full).conclusion, 'unproven');
  assert.equal(fullScope({ event: 'push' }, all), true, 'an older full push run still proves main');
});
