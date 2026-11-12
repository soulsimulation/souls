import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVERED_JOB, coveredByQueue, queueCovered } from './ci-main.mjs';
import { JOBS } from './ci-scope.mjs';
import { fullScope } from './merge-train.mjs';

const SHA = 'a'.repeat(40), qualify = JOBS.map(j => j.name);
const mg = (id, over = {}) => ({ id, event: 'merge_group', head_sha: SHA, status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', ...over });
const jobs = names => names.map(name => ({ name, conclusion: 'success' }));
const all = jobs(['scope', 'repo', ...qualify, 'ci-ok']);

test('a push whose merge_group run at the same sha passed every qualify job is covered', () => {
  const r = queueCovered([mg(5)], { sha: SHA, qualify, jobsOf: () => all });
  assert.deepEqual([r.covered, r.run], [true, 5]);
});

test('anything else runs everything: no queue run, another sha, a failed or narrow merge group, a push run', () => {
  const of = map => id => map[id] ?? all;
  const cases = {
    'a direct push or revert (no merge_group run)': [[], of({})],
    'another sha': [[mg(1, { head_sha: 'b'.repeat(40) })], of({})],
    'a failed merge group': [[mg(1, { conclusion: 'failure' })], of({})],
    'still running': [[mg(1, { status: 'in_progress', conclusion: null })], of({})],
    'a narrow merge group (docs only)': [[mg(1)], of({ 1: jobs(['scope', 'repo', 'ci-ok']) })],
    'a qualify job failed': [[mg(1)], of({ 1: [...all.filter(j => j.name !== 'server-0'), { name: 'server-0', conclusion: 'failure' }] })],
    'a push run is not queue evidence': [[mg(1, { event: 'push' })], of({})],
    'another workflow': [[mg(1, { path: '.github/workflows/security.yml' })], of({})],
  };
  for (const [why, [runs, jobsOf]] of Object.entries(cases)) assert.equal(queueCovered(runs, { sha: SHA, qualify, jobsOf }).covered, false, why);
  assert.equal(queueCovered([mg(1)], { sha: SHA, qualify: [], jobsOf: () => all }).covered, false, 'no qualify list never covers');
});

test('any full merge_group run at the sha covers it, the newest first', () => {
  const r = queueCovered([mg(1), mg(2)], { sha: SHA, qualify, jobsOf: id => (id === 2 ? jobs(['scope']) : all) });
  assert.deepEqual([r.covered, r.run], [true, 1]);
});

test('readers of main take the marker job as full scope: merge train and release gate', () => {
  assert.equal(coveredByQueue(jobs(['scope', 'repo', COVERED_JOB, 'ci-ok'])), true);
  assert.equal(coveredByQueue([{ name: COVERED_JOB, conclusion: 'skipped' }]), false);
  assert.equal(fullScope({ event: 'push' }, jobs(['scope', 'repo', COVERED_JOB, 'ci-ok'])), true);
  assert.equal(fullScope({ event: 'push' }, jobs(['scope', 'repo', 'ci-ok'])), false);
  const gate = readFileSync(new URL('../../tools/test-harness/release-gate.mjs', import.meta.url), 'utf8');
  assert.ok(gate.includes(`j.name === '${COVERED_JOB}' && j.conclusion === 'success'`), 'release-gate ciEvidence names the marker job');
});

test('ci.yml: a push asks ci-main, a covered push runs the marker instead of heavy jobs, and ci-ok checks it', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: github\.event_name == 'push'\n[\s\S]*?ci-main\.mjs --repo "\$GITHUB_REPOSITORY" --sha "\$GITHUB_SHA"/);
  assert.match(workflow, /GREEN: \$\{\{ steps\.green\.outputs\.green \|\| steps\.queued\.outputs\.covered \|\| false \}\}/);
  assert.match(workflow, new RegExp(`\\n  ${COVERED_JOB}:\\n    needs: scope\\n    if: needs\\.scope\\.outputs\\.covered == 'true'\\n`));
  const ok = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  assert.match(ok, new RegExp(`needs: \\[scope, repo, qualify, smoke, ${COVERED_JOB}\\]`));
  assert.match(ok, /if \[ "\$COVERED_SELECTED" = true \]; then test "\$COVERED" = success; else test "\$COVERED" = skipped; fi/);
  assert.ok(workflow.includes('.github/scripts/ci-main.test.mjs'), 'the repo job runs this test');
});
