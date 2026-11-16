#!/usr/bin/env node
// Whether a push to main is a commit the merge queue already tested in full (docs/testing.md#ci-window, CI on main).
//
//   node .github/scripts/ci-main.mjs --repo <owner/repo> --sha <sha>      (ci.yml, the scope job, on a push to main)
//
// The merge queue fast-forwards main to the commit its merge_group run tested, so the push carries the same sha and
// tree. When a successful merge_group ci.yml run at that sha passed every qualify job, the push run does no heavy work:
// ci.yml runs the `merge-group-covered` job instead, and ci-ok reports on scope, repo and that job. Any other push (a
// direct push, a revert, a merge group that ran only some jobs) still runs everything. Readers of main's CI take the
// marker job as full scope: the merge train's fullScope and the release gate's ciEvidence, which then uses the
// merge_group run's jobs as the evidence. Prints `true` or `false` and writes `covered` and `run` to $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS } from './ci-scope.mjs';

/** The job a covered push run runs in place of the qualify matrix; readers of main's CI look for it by name. */
export const COVERED_JOB = 'merge-group-covered';

/**
 * The merge_group ci.yml run that covers a push at `sha`: completed, successful, at exactly that head, and every name
 * in `qualify` (the qualify matrix, ci-scope.mjs JOBS) succeeded in it. `jobsOf(id)` reads one run's latest jobs.
 * Returns { covered, run, why }.
 */
export function queueCovered(runs = [], { sha, qualify = [], jobsOf }) {
  if (!qualify.length) return { covered: false, run: null, why: 'no qualify jobs to compare' };
  const tested = runs.filter(r => r.event === 'merge_group' && r.head_sha === sha && r.status === 'completed' && r.conclusion === 'success'
    && (r.path ?? '.github/workflows/ci.yml') === '.github/workflows/ci.yml').sort((a, b) => b.id - a.id);
  if (!tested.length) return { covered: false, run: null, why: `no successful merge_group run at ${sha}` };
  for (const run of tested) {
    const ok = new Set(jobsOf(run.id).filter(j => j.conclusion === 'success').map(j => j.name));
    const missing = qualify.filter(n => !ok.has(n));
    if (!missing.length) return { covered: true, run: run.id, why: `merge_group run ${run.id} passed every qualify job at this sha` };
  }
  return { covered: false, run: null, why: `the merge_group run(s) at ${sha} did not run every qualify job` };
}

/** A run's jobs say the merge queue covered it: the marker job ran and succeeded. */
export const coveredByQueue = (jobs = []) => jobs.some(j => j.name === COVERED_JOB && j.conclusion === 'success');

function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = opt('--repo'), sha = opt('--sha');
  const gh = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  let result;
  try {
    const runs = gh(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=merge_group&per_page=100`).workflow_runs ?? [];
    result = queueCovered(runs, { sha, qualify: JOBS.map(j => j.name), jobsOf: id => gh(`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`).jobs ?? [] });
  } catch (e) {
    // unreadable runs: not covered, so the push runs everything
    result = { covered: false, run: null, why: `could not read CI runs: ${String(e.message).split('\n')[0]}` };
  }
  console.error(`ci-main: ${result.why}`);
  console.log(String(result.covered));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `covered=${result.covered}\nrun=${result.run ?? ''}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
