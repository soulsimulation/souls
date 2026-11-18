#!/usr/bin/env node
// Picks the CI jobs a change needs, from what the change can reach (docs/testing.md#ci-scope).
//
//   node .github/scripts/ci-scope.mjs --base <ref|sha> [--head <ref|sha>] [--event <name>]   (or --files a,b,c for tests)
//   node .github/scripts/ci-scope.mjs local --base origin/main [--run]    the same selection for a working tree
//   node .github/scripts/ci-scope.mjs exec                                 runs a `selected` leg's commands (ci.yml)
//
// A push to main (ci.yml only takes pushes to main) and a manual run check everything, whatever changed: each merge then
// leaves a full-scope run on main, which the merge train reads as proof that main is green (mainCiState in
// merge-train.mjs). Pull request and merge_group runs (a merge group's diff is every PR in it, against main) select by
// reach: the reach map (ci-reach.mjs) says which files the diff can affect, and a job runs when one of the files it runs
// or reads (JOBS `reach`) is among them. A leg that runs a list of test files (`groups`) runs only the affected files,
// as a `selected` leg under another name, so a partial run never reads as the full leg: the merge train, ci-main.mjs
// and the release gate's CI evidence look for the full legs' names. A diff the map cannot place (the lockfile, a
// package.json or tsconfig, .github, a harness baseline, an unknown extension ...), no diff, an unreadable one or an
// empty one runs every job. Writes `matrix`, `any`, `scope` and `smoke` to $GITHUB_OUTPUT.
//
// The CI window (docs/testing.md#ci-window): a pull request run does its heavy jobs (the qualify matrix and the smoke)
// only when the PR is not a draft and carries merge:ready or ci:run (--draft, --labels from the event), or when CI was
// requested for it by hand (--event request: `gh workflow run ci.yml --ref <branch> -f pr=<n>`, scoped by the PR's
// diff against main). Outside the window a run that selected heavy jobs is deferred: none run and ci-ok fails,
// so a skipped job never reads as a pass. A run any label started (#2018), or a requested one, whose head already has a green
// ci run (--green-at-head) has nothing left to do. `green --repo o/r --sha <sha> [--self <run id>] [--events a,b]` prints
// whether the head's newest ci run (of those events, when given) passed.
// A pull request run never runs the legs JOBS marks `heavy: true` (heavyInQueue): the merge queue's merge_group run
// selects them by the same reach before the change reaches main, so each change runs them once, there.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReach, globRe, unplaceable } from './ci-reach.mjs';
import { LATENCY_TEST, SERVER_SHARDS, SERVER_TEST_CONCURRENCY, needsSerial, serverShards, serverTestDurations } from './server-test-files.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** What every job that pulls media also reads: the puller and the manifest it verifies against. */
export const ASSET_INPUTS = ['tools/assets/pull.mjs', 'tools/assets/manifest.json'];
/** The god-skill unit tests (every *.test.mjs under tools/god-skill), run by the job with `godSkill` (ci.yml). */
export const GOD_SKILL_TESTS = 'tools/god-skill/*.test.mjs tools/god-skill/lib/*.test.mjs tools/god-skill/scripts/*.test.mjs tools/god-skill/e2e/*.test.mjs';
/** The body-authoring renderer tests, on the same job (ci.yml, "Body-authoring renderer tests"). */
export const BODY_TESTS = 'tools/body-authoring/*/*.test.mjs';
/** The server legs' file groups: the inventory (server-test-files.mjs: every apps/server/src test but the latency one),
 * and on the godSkill shard the god-skill and the body-authoring tests, each run as ci.yml runs it. */
export const SERVER_GROUPS = [
  { id: 'server', globs: ['apps/server/src/**/*.test.ts'], exclude: [`apps/server/src/${LATENCY_TEST}`], cwd: 'apps/server', filter: '@souls/server', concurrency: SERVER_TEST_CONCURRENCY },
  { id: 'god', globs: GOD_SKILL_TESTS.split(' '), concurrency: 1 },
  { id: 'body', globs: [BODY_TESTS], concurrency: 1, flags: ['--experimental-transform-types'] },
];

// The qualify matrix, as ci.yml's case block runs it. `reach` lists what a job runs and reads, as globs (a pattern
// ending in `/` owns its folder, data included; `@package-tests` is every workspace package's test script but the
// viewer's and the server's, packageTests). `groups` marks a leg whose runner takes a list of test files: only the
// affected files run (jobsFor), unless one of a group's `whole` files is affected. `assets` says whether the job pulls media first; ASSET_INPUTS are then in its reach.
// Keep this list and the case block in ci.yml in step; ci-scope.test.mjs checks LOCAL_COMMANDS against it.
// `heavy: true` sends the job to the self-hosted pool CI_HEAVY_RUNNER when that variable is set (runnerFor, ci.yml's
// qualify runs-on): the server shards and the legs whose hosted median is over about 8 minutes. The short legs stay on
// ubuntu-latest, so one run uses both pools at once (docs/testing.md#self-hosted-runners). `native` never is heavy (#1162).
export const JOBS = [
  // the typecheck covers every workspace package; a bundle baseline change is a harness baseline (everything runs, #1117)
  { name: 'types-web', kind: 'types-web', light: true, assets: true, reach: ['apps/', 'packages/', 'mars/viewer/', 'tools/test-harness/bundle-budget/', 'tools/assets/mars-web.mjs'] },
  { name: 'packages', kind: 'packages', assets: true, heavy: true, reach: ['@package-tests'] },
  { name: 'web', kind: 'web', light: true, assets: true, reach: ['apps/web/', 'tools/test-harness/web-suite.sh', 'tools/test-harness/web-loader.mjs'] },
  // backup-restic.test.mjs needs the restic binary ci.yml's launcher branch installs: when it is affected, the full leg runs
  { name: 'launcher', kind: 'launcher', assets: true, heavy: true, reach: ['tools/world-launcher/*.test.mjs', 'tools/world-launcher/soul/*.test.mjs'],
    groups: [{ id: 'launcher', globs: ['tools/world-launcher/*.test.mjs', 'tools/world-launcher/soul/*.test.mjs'], concurrency: 1, whole: ['tools/world-launcher/backup-restic.test.mjs'] }] },
  { name: 'client-cli', kind: 'client-cli', light: true, assets: true, reach: ['tools/client-eval/*.test.mjs', 'tools/world-launcher/soul/*.test.mjs'],
    groups: [{ id: 'client-cli', globs: ['tools/client-eval/*.test.mjs', 'tools/world-launcher/soul/*.test.mjs'], concurrency: 1 }] },
  // pnpm test:mars: mars/viewer's test:engine, node --test engine/test/*.test.ts there
  { name: 'native', kind: 'native', assets: true, reach: ['mars/viewer/engine/test/*.test.ts'],
    groups: [{ id: 'native', globs: ['mars/viewer/engine/test/*.test.ts'], cwd: 'mars/viewer', filter: 'mars-campus-viewer' }] },
  { name: 'latency', kind: 'latency', assets: false, reach: [`apps/server/src/${LATENCY_TEST}`] },
  // #898: the generator of the reference pages (docs/site actions, api, mcp) runs against the server's code.
  { name: 'docs-reference', kind: 'docs-reference', light: true, assets: false, reach: ['tools/docs/generate.test.mjs'] },
  // the server inventory in SERVER_SHARDS duration-balanced shards (server-test-files.mjs). Shard 0 also runs every
  // god-skill unit test (GOD_SKILL_TESTS, the replay corpus among them; none needs a browser or a live server): about
  // 35 s, and some need the pulled media (#918), and the body-authoring renderer tests.
  ...Array.from({ length: SERVER_SHARDS }, (_, shard) => ({ name: `server-${shard}`, kind: 'server', shard, assets: true, heavy: true, ...(shard === 0 ? { godSkill: true } : {}), reach: SERVER_GROUPS.flatMap(g => g.globs), groups: SERVER_GROUPS })),
  // No gate step on purpose (#1061).
  { name: 'soul-actions', kind: 'soul-actions', assets: false, heavy: true, reach: ['tools/soul-actions/*.test.mjs'],
    groups: [{ id: 'soul-actions', globs: ['tools/soul-actions/*.test.mjs'], concurrency: 4 }] },
  // Also no gate step (#1111): the soul runtime and trace, the entry format and its gates, form-rules' own tests and the
  // launcher test that reads content/kinds.
  { name: 'soul-tools', kind: 'soul-tools', light: true, assets: false,
    reach: ['tools/soul-runtime/*.test.mjs', 'tools/soul-trace/*.test.mjs', 'tools/entry/*.test.mjs', 'packages/form-rules/src/*.test.ts', 'tools/world-launcher/soul/card-search.test.mjs'],
    groups: [
      { id: 'runtime', globs: ['tools/soul-runtime/*.test.mjs', 'tools/soul-trace/*.test.mjs'], concurrency: 4 },
      { id: 'entry', globs: ['tools/entry/*.test.mjs'], concurrency: 4 },
      { id: 'rules', globs: ['packages/form-rules/src/*.test.ts', 'tools/world-launcher/soul/card-search.test.mjs'], concurrency: 4 },
    ] },
];
/** The local smoke (e2e/local-smoke.mjs): builds the web app and starts the server, with the web and runtime media. */
export const SMOKE_REACH = ['e2e/local-smoke.mjs', 'e2e/config.mjs', 'apps/web/', 'apps/server/src/main.ts', ...ASSET_INPUTS];

/** The commands each full leg runs, as ci.yml's case block has them (ci-scope.test.mjs checks each line is there). */
export const LOCAL_COMMANDS = {
  'types-web': ['pnpm typecheck', 'pnpm --filter @souls/web build', 'node tools/test-harness/bundle-budget/budget.mjs --check', 'pnpm build:viewer', 'node tools/assets/mars-web.mjs --check'],
  packages: ["pnpm -r --filter '!mars-campus-viewer' --filter '!@souls/server' test"],
  native: ['pnpm test:mars'],
  web: ['pnpm --filter @souls/web build', 'bash tools/test-harness/web-suite.sh'],
  'docs-reference': ['node --test --test-concurrency=1 tools/docs/generate.test.mjs'],
  launcher: ['node --test --test-concurrency=1 tools/world-launcher/*.test.mjs tools/world-launcher/soul/*.test.mjs'],
  'client-cli': ['pnpm test:client'],
  latency: ['pnpm --filter @souls/server exec node --test --test-concurrency=1 src/owner-response-milestones.test.ts'],
  'soul-actions': ['node --test --test-concurrency=4 tools/soul-actions/*.test.mjs'],
  'soul-tools': ['node --test --test-concurrency=4 tools/soul-runtime/*.test.mjs tools/soul-trace/*.test.mjs', 'node --test --test-concurrency=4 tools/entry/*.test.mjs',
    'node --test --test-concurrency=4 packages/form-rules/src/*.test.ts tools/world-launcher/soul/card-search.test.mjs'],
};
export const SMOKE_COMMAND = 'node e2e/local-smoke.mjs --build --port 9950 --out .local/e2e/ci';

/** The runner a qualify job gets, as ci.yml's runs-on computes it: a heavy job goes to CI_HEAVY_RUNNER (one label, or a
 * JSON array of labels) when it is set; a `light` job (short, no wall-time budget) goes to CI_LIGHT_RUNNER when that is
 * set; every other job (native and latency keep their wall-time budgets on hosted runners) goes to ubuntu-latest. */
export function runnerFor(job, heavyRunner = '', lightRunner = '') {
  const pool = job.heavy ? heavyRunner : job.light ? lightRunner : '';
  if (!pool) return 'ubuntu-latest';
  return pool.startsWith('[') ? JSON.parse(pool) : pool;
}

/** Events whose runs leave the `heavy: true` legs to the merge queue. Every change reaches main through a merge_group
 * run, which is not windowed and selects those legs by the same reach, so a pull request run repeating them would
 * only run them twice (docs/testing.md#ci-window). Merge-group, push, manual and requested runs keep them. */
export const QUEUE_HEAVY_EVENTS = ['pull_request'];

/** The jobs a run of `event` does itself (`include`), and the names of the heavy legs it leaves to the merge queue. */
export function heavyInQueue(include, event) {
  if (!QUEUE_HEAVY_EVENTS.includes(event)) return { include, queued: [] };
  return { include: include.filter(j => !j.heavy), queued: include.filter(j => j.heavy).map(j => j.name) };
}

/** The low-risk paths. No longer used to pick jobs (the reach does); the merge train's mixed cap reads them
 * (merge-train.mjs). Exact prefixes, plus Markdown at the root other than the agent rules. */
export const LOW_RISK = /^(?:tools\/entry|content\/(?:kinds|asks|moves)|packages\/form-rules|docs|changes)\//;
const LOW_RISK_ROOT = file => /^[^/]+\.md$/.test(file) && !['AGENTS.md', 'CLAUDE.md'].includes(file);
export const lowRisk = files => Array.isArray(files) && files.length > 0 && files.every(f => LOW_RISK.test(f) || LOW_RISK_ROOT(f));

const strip = ({ reach, groups, ...job }) => job;

/** The test globs of the workspace packages' `test` scripts that `pnpm -r --filter '!mars-campus-viewer' --filter
 * '!@souls/server' test` runs: `node --test <globs>` (after any `cd`), and `pnpm --dir <d> <script>` read from that
 * folder's package.json. A script read no other way owns its whole package folder. */
export function packageTests(files, read) {
  const json = f => { try { return JSON.parse(read(f) ?? 'null'); } catch { return null; } };
  const globs = [];
  const parse = (script, dir, depth = 0) => {
    let cwd = dir;
    for (const part of String(script).split('&&').map(s => s.trim())) {
      let m;
      if ((m = /^cd (\S+)$/.exec(part))) cwd = posix.normalize(posix.join(cwd || '.', m[1]));
      else if ((m = /^pnpm --dir (\S+) (\S+)$/.exec(part)) && depth < 3) {
        const d = posix.normalize(posix.join(cwd || '.', m[1])), s = json(d === '.' ? 'package.json' : `${d}/package.json`)?.scripts?.[m[2]];
        if (s) parse(s, d === '.' ? '' : d, depth + 1); else globs.push(`${dir}/`);
      } else if (/^node\b/.test(part) && /\s--test\b/.test(part)) {
        for (const t of part.split(/\s+/).slice(1)) if (!t.startsWith('-')) globs.push(cwd && cwd !== '.' ? `${cwd}/${t}` : t);
      } else globs.push(`${dir}/`);
    }
  };
  for (const f of files.filter(f => /^(?:packages\/[^/]+|apps\/[^/]+|mars\/viewer)\/package\.json$/.test(f))) {
    const pkg = json(f);
    if (!pkg?.scripts?.test || ['mars-campus-viewer', '@souls/server'].includes(pkg.name)) continue;
    parse(pkg.scripts.test, posix.dirname(f));
  }
  return globs;
}

const matcher = globs => { const res = globs.map(globRe); return f => res.some(r => r.test(f)); };

/** One group's commands over `files` (repository paths), as ci.yml runs it: the server's through its package, its
 * fixed-port files after the rest one at a time (server-test-files.mjs needsSerial). */
export function groupCommands(group, files, read = f => readFileSync(join(ROOT, f), 'utf8')) {
  if (!files.length) return [];
  const node = (n, list) => ['node', ...(group.flags ?? []), '--test', ...(n ? [`--test-concurrency=${n}`] : []), ...list];
  const inPackage = argv => group.filter ? ['pnpm', '--filter', group.filter, 'exec', ...argv] : argv;
  const rel = group.cwd ? files.map(f => posix.relative(group.cwd, f)) : files;
  if (group.id !== 'server') return [inPackage(node(group.concurrency, rel))];
  const serial = rel.filter(f => { try { return needsSerial(read(`${group.cwd}/${f}`)); } catch { return true; } });
  const parallel = rel.filter(f => !serial.includes(f));
  return [parallel, serial].filter(l => l.length).map((l, i) => inPackage(node(i === 0 && parallel.length ? group.concurrency : 1, l)));
}

/** A partial server selection worth running as such: under PARTIAL_SHARE of the inventory's measured seconds. Above it
 * the full shards run, which save as much and keep the full legs' names (the release gate's CI evidence, ci-main.mjs). */
export const PARTIAL_SHARE = 0.75;
const serverWeight = (seconds = serverTestDurations()) => {
  const known = Object.values(seconds).filter(Number.isFinite).sort((a, b) => a - b), median = known.length ? known[Math.floor(known.length / 2)] : 1;
  return f => seconds[posix.relative('apps/server', f)] ?? median;
};
/** Packs a partial server selection into legs no longer than the longest full shard, by measured file seconds; the
 * god-skill and body-authoring files ride on the first, as on server-0. */
export function packServer(byGroup, everyServer = byGroup.server ?? [], seconds = serverTestDurations()) {
  const weight = serverWeight(seconds), all = byGroup.server ?? [];
  let target = 600;
  try { target = Math.max(...serverShards([...everyServer.map(f => f.replace(/^apps[/]server[/]src[/]/, '')), LATENCY_TEST], SERVER_SHARDS, seconds).map(x => x.seconds)); } catch { /* keep the default */ }
  const total = all.reduce((t, f) => t + weight(f), 0);
  const bins = Array.from({ length: Math.max(1, Math.ceil(total / target)) }, () => ({ files: [], seconds: 0 }));
  for (const f of [...all].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const b = bins.reduce((best, x, i) => (x.seconds < bins[best].seconds ? i : best), 0);
    bins[b].files.push(f); bins[b].seconds += weight(f);
  }
  return bins.map((b, i) => ({ server: b.files.sort(), ...(i === 0 ? { god: byGroup.god ?? [], body: byGroup.body ?? [] } : {}) }))
    .filter(b => Object.values(b).some(l => l.length));
}

/**
 * The jobs a diff needs. `files` null (no usable base, or an unreadable diff) or empty, or any file the reach map cannot
 * place, runs every job and the smoke. Otherwise a job runs when the diff can affect a file in its `reach`; a `groups` leg
 * whose affected test files are not all of them runs those only, as `selected` legs. `reach` is the map (treeReach).
 */
export function jobsFor(files, reason = files === null ? 'no usable base' : 'an empty diff', reach = null) {
  const full = why => ({ scope: 'full', include: JOBS.map(strip), smoke: true, diff: { files: files?.length ?? 0, full: why } });
  if (!files?.length) return full(reason);
  const outside = files.map(f => [f, unplaceable(f)]).filter(([, why]) => why);
  if (outside.length) return full(`${outside.length} file(s) outside the reach map: ${outside.slice(0, 5).map(([f, w]) => `${f} (${w})`).join(', ')}`);
  reach ??= treeReach(files);
  const { behaviour, content, chain } = reach.affected(files);
  const hit = [...new Set([...content, ...behaviour])];
  const hits = globs => { const m = matcher(globs); return hit.filter(m); };
  const read = f => { try { return readFileSync(join(ROOT, f), 'utf8'); } catch { return null; } };
  const pkgTests = packageTests([...reach.present], reach.read ?? read);
  const reachOf = job => [...job.reach.flatMap(g => g === '@package-tests' ? pkgTests : [g]), ...(job.assets ? ASSET_INPUTS : [])];
  const include = [], why = {};
  const groupFiles = groups => Object.fromEntries(groups.map(g => {
    const m = matcher(g.globs), ex = new Set(g.exclude ?? []);
    const every = [...reach.present].filter(f => m(f) && !ex.has(f)).sort();
    return [g.id, { every, picked: every.filter(f => behaviour.has(f)) }];
  }));
  let serverDone = false;
  for (const job of JOBS) {
    if (job.kind === 'server' && serverDone) continue;
    const found = hits(reachOf(job));
    if (!found.length) continue;
    why[job.kind === 'server' ? 'server' : job.name] = chain(found[0]);
    const legs = job.kind === 'server' ? JOBS.filter(j => j.kind === 'server') : [job];
    serverDone ||= job.kind === 'server';
    const sel = job.groups && !hits(ASSET_INPUTS).length ? groupFiles(job.groups) : null;
    const most = sel?.server && (w => sel.server.picked.reduce((t, f) => t + w(f), 0) >= PARTIAL_SHARE * sel.server.every.reduce((t, f) => t + w(f), 0))(serverWeight());
    const whole = sel && job.groups.some(g => (g.whole ?? []).some(f => sel[g.id].picked.includes(f)));
    if (!sel || most || whole || Object.values(sel).every(g => g.picked.length === g.every.length)) { include.push(...legs.map(strip)); continue; }
    const picked = Object.fromEntries(Object.entries(sel).map(([id, g]) => [id, g.picked]));
    const parts = job.kind === 'server' ? packServer(picked, sel.server.every) : [picked];
    parts.forEach((part, i) => {
      const commands = job.groups.flatMap(g => groupCommands(g, part[g.id] ?? [], reach.read ?? read));
      if (!commands.length) return;
      const base = job.kind === 'server' ? 'server' : job.name;
      include.push({ name: parts.length > 1 ? `${base} (selected ${i + 1}/${parts.length})` : `${base} (selected)`, kind: 'selected', of: base,
        assets: job.assets, ...(job.heavy ? { heavy: true } : {}), ...(job.light ? { light: true } : {}), files: Object.values(part).flat().length, commands });
    });
  }
  const smokeHits = hits(SMOKE_REACH);
  if (smokeHits.length) why.smoke = chain(smokeHits[0]);
  return { scope: include.length || smokeHits.length ? 'reach' : 'none', include, smoke: smokeHits.length > 0, why,
    diff: { files: files.length, affected: behaviour.size } };
}

/** The reach map of the checked-out tree (tracked files, untracked ones not ignored, and the diff's deletions). */
export function treeReach(extra = [], root = ROOT) {
  const ls = (...a) => execFileSync('git', ['-C', root, 'ls-files', ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
  const files = [...new Set([...ls(), ...ls('--others', '--exclude-standard')])];
  const read = f => { try { return readFileSync(join(root, f), 'utf8'); } catch { return null; } };
  const present = new Set(files.filter(f => read(f) !== null || !extra.includes(f)));
  const reach = buildReach({ files: [...present], extra, read });
  return { ...reach, read };
}

/** Events whose runs check everything regardless of the changed paths. */
export const FULL_EVENTS = ['push', 'workflow_dispatch'];

/** Labels that open the CI window for a ready PR. */
export const WINDOW_LABELS = ['merge:ready', 'ci:run'];

/** Whether a run may do heavy work. Only pull_request runs are windowed; a requested run is open by definition. */
export function windowFor({ event, draft = false, labels = [] }) {
  if (event === 'request') return { open: true, why: 'requested for this PR' };
  if (event !== 'pull_request') return { open: true, why: `${event} runs are not windowed` };
  if (draft) return { open: false, why: 'the PR is a draft' };
  const hit = WINDOW_LABELS.find(l => labels.includes(l));
  return hit ? { open: true, why: `labelled ${hit}` } : { open: false, why: `not labelled ${WINDOW_LABELS.join(' or ')}` };
}

/** Applies the window to a plan: closed with heavy work selected defers it all; nothing selected is never deferred. */
export function windowed({ include, smoke }, win, { greenAtHead = false } = {}) {
  if (win.open && greenAtHead) return { include: [], smoke: false, deferred: false, why: 'a ci run at this head already passed' };
  if (win.open || (!include.length && !smoke)) return { include, smoke, deferred: false, why: win.why };
  return { include: [], smoke: false, deferred: true, why: win.why };
}

/** The head's newest ci run (other than `self`, and of `events` when given) concluded success, and no newer one is
 * still running. A requested run reads only other requested runs: a pull_request run at the head left its heavy legs
 * to the merge queue (heavyInQueue), so its pass says nothing about them. */
export function greenAtHead(runs = [], self = null, events = []) {
  const others = runs.filter(r => String(r.id) !== String(self ?? '') && !['cancelled', 'skipped'].includes(r.conclusion)
    && (!events.length || events.includes(r.event))).sort((a, b) => b.id - a.id);
  return others[0]?.status === 'completed' && others[0].conclusion === 'success';
}

const ZERO = /^0+$/;
export function changedFiles(base, head = 'HEAD', git = (...a) => execFileSync('git', a, { encoding: 'utf8' })) {
  if (!base || ZERO.test(base)) return null; // a new branch or a missing base: run everything
  try { return git('diff', '--name-only', `${base}...${head}`).split('\n').filter(Boolean); }
  catch { return null; }
}

/** A working tree's changes against the merge base with `base`: committed, staged, unstaged and untracked. */
export function workingChanges(base, git = (...a) => execFileSync('git', a, { encoding: 'utf8' })) {
  try {
    const mb = git('merge-base', base, 'HEAD').trim();
    return [...new Set([...git('diff', '--name-only', mb).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean))];
  } catch { return null; }
}

const quote = a => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
/** The shell lines a plan runs locally: media first when any job pulls it, each leg's commands, then the smoke. */
export function localCommands(plan) {
  const lines = [];
  if (plan.include.some(j => j.assets) || plan.smoke) lines.push({ leg: 'media', line: 'pnpm assets:pull --quiet' });
  const seen = new Set();
  for (const job of plan.include) {
    if (job.kind === 'selected') { for (const argv of job.commands) lines.push({ leg: job.name, line: argv.map(quote).join(' ') }); continue; }
    if (job.kind === 'server') {
      if (seen.has('server')) continue;
      seen.add('server');
      const files = Object.fromEntries(SERVER_GROUPS.map(g => { const m = matcher(g.globs), ex = new Set(g.exclude ?? []); return [g.id, trackedFiles().filter(f => m(f) && !ex.has(f))]; }));
      for (const g of SERVER_GROUPS) for (const argv of groupCommands(g, files[g.id])) lines.push({ leg: 'server', line: argv.map(quote).join(' ') });
      continue;
    }
    for (const line of LOCAL_COMMANDS[job.kind] ?? []) lines.push({ leg: job.name, line });
  }
  if (plan.smoke) lines.push({ leg: 'smoke', line: SMOKE_COMMAND });
  return lines;
}
const trackedFiles = () => execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);

function local(argv, opt) {
  const base = opt('--base') ?? 'origin/main';
  const files = workingChanges(base);
  const plan = jobsFor(files, files === null ? `no merge base with ${base}` : 'no changes');
  const lines = localCommands(plan);
  console.log(`# ${files?.length ?? 0} changed file(s) against ${base}; scope ${plan.scope}${plan.diff.full ? ` (${plan.diff.full})` : ''}`);
  for (const { leg, line } of lines) console.log(`${line}    # ${leg}`);
  if (!lines.length) console.log('# nothing to run: no CI job can be affected by this change');
  if (!argv.includes('--run')) return;
  let failed = 0;
  for (const { leg, line } of lines) {
    console.log(`\n## ${leg}: ${line}`);
    const r = spawnSync('bash', ['-c', line], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) { failed++; console.log(`## ${leg} failed (exit ${r.status})`); }
  }
  process.exitCode = failed ? 1 : 0;
}

/** Runs a `selected` leg's commands (SELECTED_COMMANDS, JSON argv lists from the matrix); all run, any failure fails. */
function exec() {
  const commands = JSON.parse(process.env.SELECTED_COMMANDS || '[]');
  if (!commands.length) throw Error('no SELECTED_COMMANDS');
  let failed = 0;
  for (const [cmd, ...args] of commands) {
    console.log(JSON.stringify({ cmd, files: args.filter(a => !a.startsWith('-') && /\.test\./.test(a)).length, args }));
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'green') {
    const runs = JSON.parse(execFileSync('gh', ['api', `repos/${opt('--repo')}/actions/workflows/ci.yml/runs?head_sha=${opt('--sha')}&per_page=100`], { encoding: 'utf8' })).workflow_runs ?? [];
    console.log(String(greenAtHead(runs, opt('--self'), (opt('--events') ?? '').split(',').filter(Boolean))));
    return;
  }
  if (argv[0] === 'local') return local(argv, opt);
  if (argv[0] === 'exec') return exec();
  const event = opt('--event');
  const files = FULL_EVENTS.includes(event) ? null
    : opt('--files') !== undefined ? opt('--files').split(',').filter(Boolean) : changedFiles(opt('--base'), opt('--head'));
  const full = FULL_EVENTS.includes(event) ? jobsFor(null, `${event} runs check everything`) : jobsFor(files);
  let labels = [];
  try { const l = JSON.parse(opt('--labels') || '[]'); if (Array.isArray(l)) labels = l; } catch { /* unreadable labels: none */ }
  const win = windowFor({ event, draft: opt('--draft') === 'true', labels });
  const own = heavyInQueue(full.include, event);
  const plan = { ...full, ...windowed({ include: own.include, smoke: full.smoke }, win, { greenAtHead: opt('--green-at-head') === 'true' }) };
  const out = { matrix: JSON.stringify({ include: plan.include }), any: String(plan.include.length > 0), scope: plan.scope, smoke: String(plan.smoke), deferred: String(plan.deferred), window: plan.why };
  console.log(JSON.stringify({ ...out, matrix: plan.include.map(j => j.name), selected: own.include.map(j => j.name), queued: own.queued, diff: plan.diff, reach: full.why }, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### CI scope: ${plan.scope}\n\nJobs: ${plan.include.map(j => '`' + j.name + '`' + (j.files ? ` (${j.files} test files)` : '')).join(', ') || 'none'}; local smoke: ${out.smoke}\n` +
    (plan.diff.full ? `\nEverything runs: ${plan.diff.full}\n` : '') +
    (Object.keys(full.why ?? {}).length ? `\nWhy (one path from the diff to each job, \`node .github/scripts/ci-scope.mjs local\` reproduces it):\n\n${Object.entries(full.why).map(([k, c]) => `- \`${k}\`: ${c.join(' → ')}`).join('\n')}\n` : '') +
    (own.queued.length ? `\nLeft to the merge queue's run (heavy legs run once, there): ${own.queued.map(n => '`' + n + '`').join(', ')}\n` : '') +
    (plan.deferred ? `\n**Full CI deferred** (${plan.why}): ${own.include.length} job(s) selected, none run. Add \`ci:run\` or \`merge:ready\` to a ready PR to run them (docs/testing.md#ci-window).\n` : ''));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
