#!/usr/bin/env node
// The `merge-group-covered` marker on older pushes to main (docs/testing.md#ci-window, CI on main).
//
// Until 18 Nov 2026 a push to main whose merge_group run at the same sha had passed every qualify job ran this marker
// job instead of the heavy work, and readers of main's CI took it as full scope. Merge-group and push runs no longer
// run the `heavy: true` legs (ci-scope.mjs lightOnly); the full battery runs in the daily scheduled run and manual
// runs, so ci.yml no longer has the job. Older runs on main still carry it, and those runs were genuinely covered,
// so the readers keep accepting it: the merge train's fullScope here, and the release gate's ciEvidence, which then
// uses that merge_group run's jobs as the evidence.

/** The job a covered push run ran in place of the qualify matrix; readers of main's CI look for it by name. */
export const COVERED_JOB = 'merge-group-covered';

/** A run's jobs say the merge queue covered it: the marker job ran and succeeded (older runs only). */
export const coveredByQueue = (jobs = []) => jobs.some(j => j.name === COVERED_JOB && j.conclusion === 'success');
