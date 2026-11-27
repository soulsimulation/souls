#!/usr/bin/env node
// Picks the CI jobs a change needs, from the same path map the release gate uses (`release-gate.mjs --scope auto`).
//
//   node .github/scripts/ci-scope.mjs --base <ref|sha> [--head <ref|sha>] [--event <name>]   (or --files a,b,c for tests)
//
// The daily scheduled run on main and a manual run check everything, whatever changed: those are the full-scope runs the
// merge train reads as proof that main is green (mainCiState in merge-train.mjs). Pull request, merge_group and push
// runs (ci.yml only takes pushes to main) stay scoped to their paths (a merge group's diff is every PR in it).
// A diff confined to the low-risk paths (LOW_RISK: entry, content, form-rules, docs, changelog fragments) runs only
// their own tests; any other diff goes through the path map, where paths no rule names (root files, the lockfile, mars/,
// worlds/, vendor/, .github/ ...) run every job; docs and tools-only changes run none (ci-ok still reports). A changelog
// fragment beside other files selects nothing itself. The v2 legs each run on their own inputs (V2_PATHS).
// No diff, an unreadable one or an empty one runs every job. Writes `matrix`, `any`, `scope` and `smoke` to $GITHUB_OUTPUT.
// `smoke` (the browser local smoke, e2e/local-smoke.mjs) runs when apps/web, apps/server or e2e change, or with no diff.
//
// The CI window (docs/testing.md#ci-window): a pull request run does its heavy jobs (the qualify matrix and the smoke)
// whenever the PR is not a draft (--draft from the event), with no label, or when CI was requested for it by hand (--event request: `gh workflow run ci.yml --ref <branch> -f pr=<n>`, scoped by the PR's paths
// against main). Outside the window a run that selected heavy jobs is deferred: none run and ci-ok fails,
// so a skipped job never reads as a pass. A requested run whose head already has a green requested
// ci run (--green-at-head) has nothing left to do: no qualify leg, no smoke and no repo job (output `green`). `green --repo o/r --sha <sha> [--self <run id>] [--events a,b]` prints whether
// the head's newest ci run (of those events, when given) passed; it reads GH_TOKEN and needs no gh CLI.
// Pull request, merge_group and push runs never run the legs JOBS marks `heavy: true` (lightOnly): they run once a day
// in the scheduled full run on main, on a manual run, and before a release in the remote gate, not per change.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_STEPS, scopeFor } from '../../tools/test-harness/release-gate.mjs';
import { SERVER_SHARDS } from './server-test-files.mjs';
import { TEST_LEGS } from './test-legs.mjs';

// The qualify matrix. `steps` are the gate steps that make a job relevant, and the job runs the same command as that
// step in tools/test-harness/one-validation.sh (web: V4-web, launcher: V3-launcher-unit, client-cli: V3-client-cli);
// `assets` says whether the job pulls media first. Keep this list and the case block in ci.yml in step;
// ci-scope.test.mjs checks that every step the scope map can select has a job.
// `heavy: true` sends the job to the self-hosted pool CI_HEAVY_RUNNER when that variable is set (runnerFor, ci.yml's
// qualify runs-on): the server shards and the legs whose hosted median is over about 8 minutes. The short legs stay on
// ubuntu-latest, so one run uses both pools at once (docs/testing.md#self-hosted-runners). `native` never is heavy (#1162).
/** v2/tools/ci.sh's legs: lints and every package's tests but sim's and worldd's; sim's tests; worldd's tests; the WASM
 * build against the native answers; the client and page tests against the built binaries. */
export const V2_LEGS = ['rust', 'sim', 'worldd', 'wasm', 'client'];

/** What each v2 leg reads, so a change runs only the legs it can affect (when in doubt, a path runs the leg).
 * Every leg: the Rust workspace (v2/crates, v2/tools, the files at v2/'s root, any v2 folder not named below) and the
 * content the Rust tests and the served world load (content/kinds, moves, worlds). On top of that:
 * rust: its node steps import the client and the page (tools/origin, web/src/home); sim: the hatch step runs
 * client/src/hatch and web/src/hatch; wasm: tools/facts imports client/src/history; client: the client and page steps,
 * the served e2e and client/src/mcp's v2/docs/site/mcp.md. v2/docs outside docs/site is read by no leg.
 * Files outside v2/ and content/ that a few v2 tests import (tools/world-launcher/soul, the pairing fixture's
 * apps/server modules) select no leg, as before; the daily full run on main runs every leg. */
const V2_EVERY = String.raw`v2/(?!(?:client|web|docs)/)|content/(?:kinds|moves|worlds)/`;
const v2Paths = extra => new RegExp(`^(?:${V2_EVERY}${extra ? `|${extra}` : ''})`);
export const V2_PATHS = {
  rust: v2Paths(String.raw`v2/(?:client|web)/`),
  sim: v2Paths(String.raw`v2/(?:client|web)/src/hatch/`),
  worldd: v2Paths(''),
  wasm: v2Paths(String.raw`v2/client/src/history/`),
  client: v2Paths(String.raw`v2/(?:client|web|docs/site)/`),
};

export const JOBS = [
  // paths: a baseline or budget change is tools-only, so no step selects it, and this job is what compares it (#1117).
  { name: 'types-web', kind: 'types-web', light: true, assets: true, steps: ['V1-types', 'V2-build-root', 'V2-build-worlds', 'V3-bundle'], paths: /^tools\/test-harness\/bundle-budget\// },
  { name: 'packages', kind: 'packages', assets: true, heavy: true, steps: ['V3-packages', 'V3-walk'] },
  { name: 'web', kind: 'web', light: true, assets: true, steps: ['V4-web'] },
  // V3-launcher-unit in TEST_LEGS.launcher.legs duration-balanced legs (test-legs.mjs), each file one at a time as before.
  ...Array.from({ length: TEST_LEGS.launcher.legs }, (_, shard) => ({ name: `launcher-${shard}`, kind: 'launcher', shard, assets: true, heavy: true, steps: ['V3-launcher-unit'] })),
  { name: 'client-cli', kind: 'client-cli', light: true, assets: true, steps: ['V3-client-cli'] },
  { name: 'native', kind: 'native', assets: true, steps: ['V3-mars-engine'] },
  { name: 'latency', kind: 'latency', assets: false, steps: ['V5-server-full'] },
  // the server inventory in SERVER_SHARDS duration-balanced shards (server-test-files.mjs). Shard 0 also runs every
  // god-skill unit test (GOD_SKILL_TESTS, the replay corpus among them; none needs a browser or a live server): about
  // 35 s, and some need the pulled media, so they ride on a leg that god paths already select (#918).
  ...Array.from({ length: SERVER_SHARDS }, (_, shard) => ({ name: `server-${shard}`, kind: 'server', shard, assets: true, heavy: true, ...(shard === 0 ? { godSkill: true } : {}), steps: ['V5-server-full', 'V6-'] })),
  // No gate step on purpose: picked by its own paths, so the gate's suite tree and cached baseline stay as they are (#1061).
  // In TEST_LEGS['soul-actions'].legs duration-balanced legs (test-legs.mjs).
  ...Array.from({ length: TEST_LEGS['soul-actions'].legs }, (_, shard) => ({ name: `soul-actions-${shard}`, kind: 'soul-actions', shard, assets: false, heavy: true, steps: [], paths: /^(tools\/soul-actions|apps\/server|packages\/world-compiler|packages\/engine-[^/]+)\// })),
  // Also no gate step (#1111). soul-trace drives the thin CLI in tools/world-launcher/soul; soul-runtime's native client test uses the server's comms fixture.
  { name: 'soul-tools', kind: 'soul-tools', light: true, assets: false, steps: [], paths: /^(tools\/soul-runtime|tools\/soul-trace|tools\/world-launcher\/soul|content|packages\/form-rules|apps\/server)\// },
  // The kinds' case files (packages/form-rules/cases) and the entry gates that run them (tools/entry): only when a kind,
  // a case, the form rules or the entry tools change (`pathsOnly`: full scope on a pull request, merge group or push never
  // adds it), and in the daily full run on main.
  { name: 'kinds', kind: 'kinds', light: true, assets: false, steps: [], pathsOnly: true, paths: /^(content\/kinds|packages\/form-rules|tools\/entry)\// },
  // Engine v2 (#2635, K15 #2637): no gate step (v2/ is scope `none`), picked by its own paths. It builds and tests the
  // Rust workspace with v2/tools/ci.sh, on the toolchain v2/rust-toolchain.toml pins, without the pnpm install, in
  // V2_LEGS parallel legs (`ci.sh <leg>`): together the same checks as one `ci.sh` run, in about half the wall time.
  // Each leg by its own inputs (V2_PATHS): a client or page change skips the sim, worldd and WASM legs.
  ...V2_LEGS.map(leg => ({ name: `v2-${leg}`, kind: 'v2', leg, assets: false, steps: [], paths: V2_PATHS[leg] })),
];

/** The runner a qualify job gets, as ci.yml's runs-on computes it: a heavy job goes to CI_HEAVY_RUNNER (one label, or a
 * JSON array of labels) when it is set; a `light` job (short, no wall-time budget) goes to CI_LIGHT_RUNNER when that is
 * set; every other job (native and latency keep their wall-time budgets on hosted runners) goes to ubuntu-latest. */
export function runnerFor(job, heavyRunner = '', lightRunner = '') {
  const pool = job.heavy ? heavyRunner : job.light ? lightRunner : '';
  if (!pool) return 'ubuntu-latest';
  return pool.startsWith('[') ? JSON.parse(pool) : pool;
}

/** Events whose runs leave the `heavy: true` legs to the daily full run (Gene, 18 Nov: startup mode, merge no slower than
 * lanes implement). The scheduled run on main (06:23 UTC) and manual runs check every job (FULL_EVENTS), and the remote
 * gate runs everything before a release (docs/testing.md#ci-window). Scheduled, manual and requested runs keep them. */
export const LIGHT_EVENTS = ['pull_request', 'merge_group', 'push'];

/** The jobs a run of `event` does itself (`include`), and the names of the heavy legs it leaves to the daily run. */
export function lightOnly(include, event) {
  if (!LIGHT_EVENTS.includes(event)) return { include, daily: [] };
  return { include: include.filter(j => !j.heavy), daily: include.filter(j => j.heavy).map(j => j.name) };
}

/** The god-skill unit tests (every *.test.mjs under tools/god-skill), run by the job with `godSkill` (ci.yml). */
export const GOD_SKILL_TESTS = 'tools/god-skill/*.test.mjs tools/god-skill/lib/*.test.mjs tools/god-skill/scripts/*.test.mjs tools/god-skill/e2e/*.test.mjs';

const relevant = (job, steps) => job.steps.some(s => steps.some(step => s.endsWith('-') ? step.startsWith(s) : step === s));

const strip = ({ steps, paths, pathsOnly, ...job }) => job;

/** The low-risk paths: a change confined to them (every file) needs no server, browser smoke, walk or bundle job. Exact
 * prefixes, plus Markdown at the root other than the agent rules. Nothing in apps/server, the packages the walk audits or
 * the e2e reads them; the readers outside them are the entry and form-rules tests and card-search.test.mjs, which the
 * soul-tools job runs (ci.yml), and apps/web, which imports packages/form-rules/src (LOW_RISK_WEB). */
export const LOW_RISK = /^(?:tools\/entry|content\/(?:kinds|asks|moves)|packages\/form-rules|docs|changes)\//;
const LOW_RISK_ROOT = file => /^[^/]+\.md$/.test(file) && !['AGENTS.md', 'CLAUDE.md'].includes(file);
export const lowRisk = files => Array.isArray(files) && files.length > 0 && files.every(f => LOW_RISK.test(f) || LOW_RISK_ROOT(f));
/** apps/web/src/gen-mesh/vocab-look.ts imports packages/form-rules/src/looks.ts: a change there keeps the web
 * typecheck, build and bundle comparison (types-web) and the web unit suite. */
export const LOW_RISK_WEB = /^packages\/form-rules\/src\//;

/** Changelog fragments (changes/README.md). */
export const FRAGMENT = /^changes\//;

/** The jobs a diff needs. No diff (null: no usable base, or an unreadable one) and an empty diff run every job. A diff
 * confined to the low-risk paths runs only the jobs their own `paths` pick (soul-tools, the v2 legs for
 * content/kinds and moves) and, for form-rules source, the web jobs; any other diff is picked by the release gate's path
 * map, where an unmapped path (the lockfile, .github, content/ outside the low-risk folders ...) runs every job. */
export function jobsFor(all, reason = all === null ? 'no usable base' : 'an empty diff') {
  if (!all?.length) return { scope: 'full', steps: [...REQUIRED_STEPS], include: JOBS.map(strip), diff: { reason } };
  // A changelog fragment beside code selects nothing itself (the repo job checks fragments on every run); left in, the
  // gate's map reads changes/ as unmapped and every PR with a fragment ran every job.
  const files = all.some(f => !FRAGMENT.test(f)) ? all.filter(f => !FRAGMENT.test(f)) : all;
  if (lowRisk(files)) {
    const web = files.some(f => LOW_RISK_WEB.test(f)) ? ['types-web', 'web'] : [];
    const include = JOBS.filter(job => web.includes(job.name) || files.some(f => job.paths?.test(f))).map(strip);
    return { scope: include.length ? 'low-risk' : 'none', steps: [], include, diff: { files: files.length, lowRisk: true } };
  }
  const scope = scopeFor(files);
  const byPaths = job => files.some(f => job.paths?.test(f));
  const include = JOBS.filter(job => job.pathsOnly ? byPaths(job) : scope.resolved === 'full' || relevant(job, scope.steps) || byPaths(job));
  return { scope: scope.resolved, steps: scope.steps, include: include.map(strip), diff: scope.diff };
}

/** The local smoke job: changes under apps/web, apps/server or e2e; no diff or an empty one runs it too. */
export const SMOKE_PATHS = /^(apps\/web|apps\/server|e2e)\//;
export const smokeFor = files => !files?.length || files.some(f => SMOKE_PATHS.test(f));

/** Events whose runs check everything regardless of the changed paths. */
export const FULL_EVENTS = ['schedule', 'workflow_dispatch'];

/** Whether a run may do heavy work. Only pull_request runs are windowed, and only a draft's window is closed: every push to
 * a ready PR runs its jobs, with no label (0.132, F1). A requested run is open by definition. */
export function windowFor({ event, draft = false }) {
  if (event === 'request') return { open: true, why: 'requested for this PR' };
  if (event !== 'pull_request') return { open: true, why: `${event} runs are not windowed` };
  return draft ? { open: false, why: 'the PR is a draft' } : { open: true, why: 'a ready PR' };
}

/** Applies the window to a plan: closed with heavy work selected defers it all; nothing selected is never deferred. */
export function windowed({ include, smoke }, win, { greenAtHead = false } = {}) {
  if (win.open && greenAtHead) return { include: [], smoke: false, deferred: false, green: true, why: 'a ci run at this head already passed' };
  if (win.open || (!include.length && !smoke)) return { include, smoke, deferred: false, why: win.why };
  return { include: [], smoke: false, deferred: true, why: win.why };
}

/** The head's newest ci run (other than `self`, and of `events` when given) concluded success, and no newer one is
 * still running. A requested run reads only other requested runs: a pull_request run at the head left its heavy legs
 * to the daily run (lightOnly), so its pass says nothing about them. */
export function greenAtHead(runs = [], self = null, events = []) {
  const others = runs.filter(r => String(r.id) !== String(self ?? '') && !['cancelled', 'skipped'].includes(r.conclusion)
    && (!events.length || events.includes(r.event))).sort((a, b) => b.id - a.id);
  return others[0]?.status === 'completed' && others[0].conclusion === 'success';
}

const AGGREGATE_STEP = 'Run echo "scope=$SCOPE repo=$REPO qualify=$QUALIFY jobs_selected=$ANY smoke=$SMOKE smoke_selected=$SMOKE_SELECTED green_at_head=$GREEN"';
const RECEIPT_LOOKUP_LIMIT = 8;

function completeJobs(run, evidence, sha) {
  const jobs = evidence?.jobs;
  if (!Array.isArray(jobs) || !Number.isInteger(evidence.total_count) || evidence.total_count !== jobs.length
    || !jobs.length || jobs.length > 100 || new Set(jobs.map(j => j.name)).size !== jobs.length) return null;
  if (jobs.some(j => j.run_id !== run.id || j.head_sha !== sha || j.status !== 'completed'
    || !Array.isArray(j.steps) || (j.conclusion === 'success' && !j.steps.length)
    || j.steps.some(s => s.status !== 'completed'))) return null;
  return jobs;
}

/** Only this workflow's five-job closed-window shape proves deferral, without downloading logs. */
export function deferredOnly(run, evidence, sha) {
  const jobs = completeJobs(run, evidence, sha);
  if (!jobs || run.event !== 'pull_request' || run.conclusion !== 'failure' || jobs.length !== 5
    || jobs.map(j => j.name).sort().join(',') !== 'ci-ok,matrix.name,repo,scope,smoke') return false;
  for (const job of jobs) {
    if (['scope', 'repo'].includes(job.name)) {
      if (job.conclusion !== 'success' || job.steps.some(s => !['success', 'skipped'].includes(s.conclusion))) return false;
    } else if (['matrix.name', 'smoke'].includes(job.name)) {
      if (job.conclusion !== 'skipped' || job.steps.length) return false;
    } else {
      const expected = new Map([['Set up job', 'success'], ['Full CI deferred', 'failure'], [AGGREGATE_STEP, 'skipped'], ['Complete job', 'success']]);
      if (job.conclusion !== 'failure' || job.steps.length !== expected.size
        || new Set(job.steps.map(s => s.name)).size !== expected.size
        || job.steps.some(s => expected.get(s.name) !== s.conclusion)) return false;
    }
  }
  return true;
}

function qualifiedSuccess(run, evidence, sha) {
  const jobs = completeJobs(run, evidence, sha);
  return !!jobs && run.conclusion === 'success'
    && ['scope', 'repo', 'ci-ok'].every(name => jobs.some(j => j.name === name && j.conclusion === 'success'))
    && jobs.some(j => JOBS.some(q => q.name === j.name) && j.conclusion === 'success'
      && j.steps.some(s => s.name === 'Run assigned checks' && s.conclusion === 'success'))
    && jobs.every(j => ['success', 'skipped'].includes(j.conclusion)
      && j.steps.every(s => ['success', 'skipped'].includes(s.conclusion)));
}

/** A strict fallback only: every newer run must be proved deferred before an actual qualification receipt. */
export function deferredReceipt(runs, evidence, { sha, self = null, events = [] }) {
  const ordered = runs.filter(r => String(r.id) !== String(self ?? '') && (!events.length || events.includes(r.event)))
    .sort((a, b) => b.id - a.id);
  const deferred = [];
  for (const run of ordered.slice(0, RECEIPT_LOOKUP_LIMIT)) {
    if (!sha || run.head_sha !== sha || run.path !== '.github/workflows/ci.yml' || run.status !== 'completed'
      || !Number.isSafeInteger(run.id) || !['success', 'failure'].includes(run.conclusion)) return { green: false };
    if (!evidence.has(run.id)) return { inspect: run.id };
    if (run.conclusion === 'success') return deferred.length && qualifiedSuccess(run, evidence.get(run.id), sha)
      ? { green: true, receipt: run.id, deferred } : { green: false };
    if (!deferredOnly(run, evidence.get(run.id), sha)) return { green: false };
    deferred.push(run.id);
  }
  return { green: false };
}

/** The ci runs at `sha`, read from the REST API with `token` (GH_TOKEN). It uses fetch, not the gh CLI: the light
 * self-hosted runners have no gh, so a gh call failed there and every label run re-ran its jobs at a green head. An
 * unreadable answer throws; the caller reads that as not green, so the run does its jobs as before. */
export async function ciRunsAt(repo, sha, { token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, api = process.env.GITHUB_API_URL || 'https://api.github.com', fetch: get = fetch } = {}) {
  const res = await get(`${api}/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`ci runs at ${sha}: HTTP ${res.status}`);
  return (await res.json()).workflow_runs ?? [];
}

export async function ciJobsFor(repo, id, { token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, api = process.env.GITHUB_API_URL || 'https://api.github.com', fetch: get = fetch } = {}) {
  const res = await get(`${api}/repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`ci jobs for ${id}: HTTP ${res.status}`);
  return res.json();
}

/** The `green` subcommand's answer: 'true' or 'false', never a throw (a failed read is 'false', with a warning). */
export async function greenCommand({ repo, sha, self, events = [] }, opts = {}) {
  try {
    const runs = await ciRunsAt(repo, sha, opts);
    if (greenAtHead(runs, self, events)) {
      const passed = runs.filter(r => String(r.id) !== String(self ?? '') && !['cancelled', 'skipped'].includes(r.conclusion)
        && (!events.length || events.includes(r.event))).sort((a, b) => b.id - a.id)[0];
      return String(passed.head_sha === sha && passed.path === '.github/workflows/ci.yml');
    }
    const evidence = new Map();
    for (let read = 0; read <= RECEIPT_LOOKUP_LIMIT; read++) {
      const selected = deferredReceipt(runs, evidence, { sha, self, events });
      if (selected.inspect && read < RECEIPT_LOOKUP_LIMIT) {
        evidence.set(selected.inspect, await ciJobsFor(repo, selected.inspect, opts));
      } else {
        if (selected.green) console.error(`::notice::Reused ci receipt ${selected.receipt}; verified deferred runs ${selected.deferred.join(', ')}`);
        return String(selected.green === true);
      }
    }
    return 'false';
  }
  catch (e) { console.error(`::warning::green at head unknown, so this run does its jobs: ${e.message}`); return 'false'; }
}

/**
 * B1-8: what a merge group compiles (no tests). Two PRs green at their own heads can still combine into code that does
 * not build (#4220 + #4291), so a merge group checks that the combined code compiles: `cargo check` of the v2
 * workspace when a file it builds from changed (v2's crates and tools, and the content and packages they include), and
 * `tsc -p apps/web` when a file the web app type-checks changed. No diff (null), the workflows or this script: both.
 */
export const GROUP_RUST = /^(v2\/(?!web\/|client\/|docs\/)|content\/(moves|kinds)\/|packages\/engine-mars\/|tools\/ops\/)/;
export const GROUP_WEB = /^(apps\/web\/|packages\/|mars\/|v2\/web\/src\/|tsconfig[^/]*\.json$|package\.json$|pnpm-lock\.yaml$)/;
const GROUP_BOTH = /^\.github\/(workflows\/ci\.yml|scripts\/ci-scope\.mjs)$/;
export function groupChecks(files) {
  if (!files) return { rust: true, web: true };
  const code = files.filter((f) => !/\.md$/.test(f));
  const both = code.some((f) => GROUP_BOTH.test(f));
  return { rust: both || code.some((f) => GROUP_RUST.test(f)), web: both || code.some((f) => GROUP_WEB.test(f)) };
}

const ZERO = /^0+$/;
export function changedFiles(base, head = 'HEAD', git = (...a) => execFileSync('git', a, { encoding: 'utf8' })) {
  if (!base || ZERO.test(base)) return null; // a new branch or a missing base: run everything
  try { return git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean); }
  catch { return null; }
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'group') {
    const files = opt('--files') !== undefined ? opt('--files').split(',').filter(Boolean) : changedFiles(opt('--base'), opt('--head'));
    const out = groupChecks(files);
    console.log(JSON.stringify({ ...out, files: files?.length ?? 'all' }));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rust=${out.rust}\nweb=${out.web}\n`);
    return;
  }
  if (argv[0] === 'green') {
    console.log(await greenCommand({ repo: opt('--repo'), sha: opt('--sha'), self: opt('--self'), events: (opt('--events') ?? '').split(',').filter(Boolean) }));
    return;
  }
  const event = opt('--event');
  const files = FULL_EVENTS.includes(event) ? null
    : opt('--files') !== undefined ? opt('--files').split(',').filter(Boolean) : changedFiles(opt('--base'), opt('--head'));
  const full = FULL_EVENTS.includes(event) ? jobsFor(null, `${event} runs check everything`) : jobsFor(files);
  const win = windowFor({ event, draft: opt('--draft') === 'true' });
  const own = lightOnly(full.include, event);
  const plan = { ...full, ...windowed({ include: own.include, smoke: smokeFor(files) }, win, { greenAtHead: opt('--green-at-head') === 'true' }) };
  const out = { matrix: JSON.stringify({ include: plan.include }), any: String(plan.include.length > 0), scope: plan.scope, smoke: String(plan.smoke), deferred: String(plan.deferred), green: String(plan.green === true), window: plan.why };
  console.log(JSON.stringify({ ...out, matrix: plan.include.map(j => j.name), selected: own.include.map(j => j.name), daily: own.daily, diff: plan.diff }, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### CI scope: ${plan.scope}\n\nJobs: ${plan.include.map(j => '`' + j.name + '`').join(', ') || 'none (docs/tools only)'}; local smoke: ${out.smoke}\n` +
    (own.daily.length ? `\nLeft to the daily full run on main (06:23 UTC) and the release gate: ${own.daily.map(n => '`' + n + '`').join(', ')}\n` : '') +
    (plan.deferred ? `\n**Full CI deferred** (${plan.why}): ${own.include.length} job(s) selected, none run. Mark the PR ready for review to run them (docs/testing.md#ci-window).\n` : ''));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
