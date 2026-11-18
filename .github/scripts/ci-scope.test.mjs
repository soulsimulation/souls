import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FULL_EVENTS, GOD_SKILL_TESTS, JOBS, WINDOW_LABELS, changedFiles, ciRunsAt, greenAtHead, greenCommand, lightOnly, jobsFor, runnerFor, smokeFor, windowFor, windowed } from './ci-scope.mjs';
import { SCOPE_RULES, scopeFor } from '../../tools/test-harness/release-gate.mjs';

const names = files => jobsFor(files).include.map(j => j.name);

test('docs and plain tools changes run no job', () => {
  assert.deepEqual(names(['README.md', 'docs/TESTING.md', 'tools/playtest/x.mjs']), []);
  assert.equal(jobsFor(['docs/a.md']).scope, 'none');
});

test('the reference pages\' generator: checked when the server, packages, generator or the pages change; not for other docs', () => {
  for (const f of ['apps/server/src/mcp.ts', 'packages/engine-mars/src/engine.ts', 'tools/docs/generate.mjs', 'tools/docs/reference/collect.mjs', 'docs/site/api.md'])
    assert.ok(names([f]).includes('docs-reference'), f);
  assert.deepEqual(names(['tools/docs/generate.mjs']), ['docs-reference']);
  for (const f of ['docs/site/concepts.md', 'docs/README.md', 'apps/web/src/main.ts']) assert.ok(!names([f]).includes('docs-reference'), f);
  assert.ok(!('paths' in jobsFor(['tools/docs/generate.mjs']).include[0]));
});

test('web changes run the typecheck/build and the web unit suite', () => {
  assert.deepEqual(names(['apps/web/src/main.ts']), ['types-web', 'web']);
});

test('launcher and client-cli changes run their own unit tests', () => {
  const launcher = names(['tools/world-launcher/launcher.mjs']);
  assert.ok(launcher.includes('launcher'), launcher.join());
  assert.ok(!launcher.includes('web') && !launcher.includes('client-cli'));
  assert.deepEqual(names(['tools/client-eval/eval.mjs']), ['client-cli']);
  assert.deepEqual(names(['tools/edge-skill/soul.mjs']), [], '#1754: no job runs the legacy client');
});

test('every step the scope map can select is run by some job', () => {
  const selectable = new Set(SCOPE_RULES.flatMap(([prefix]) => scopeFor([`${prefix}x.ts`]).steps));
  const owned = step => JOBS.some(job => job.steps.some(s => s.endsWith('-') ? step.startsWith(s) : step === s));
  for (const step of selectable) assert.ok(owned(step), `${step} is selectable by --scope auto but no CI job runs it`);
  for (const step of ['V4-web', 'V3-launcher-unit', 'V3-client-cli']) assert.ok(selectable.has(step) && owned(step), step);
});

test('each job kind has a branch in ci.yml', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  for (const job of JOBS) assert.match(workflow, new RegExp(`^\\s+${job.kind}\\)$`, 'm'), job.kind);
});

test('server changes run server shards and latency, not native', () => {
  const picked = names(['apps/server/src/world.ts']);
  for (const n of ['latency', 'server-0', 'server-1', 'server-5', 'packages', 'types-web']) assert.ok(picked.includes(n), n);
  assert.ok(!picked.includes('native'));
});

// tools/body-authoring builds the pinned shared presets the server serves (D028): the server legs, including the
// renderer step on server-0, latency, and docs-reference, which every V5-server-full change selects since #898 because it
// runs the reference pages' generator against the server; nothing else, and no browser smoke.
test('body-authoring changes run every server shard, latency and docs-reference, and nothing else', () => {
  const files = ['tools/body-authoring/pip/robot.mjs'], server = JOBS.filter(j => j.kind === 'server').map(j => j.name);
  assert.ok(server.includes('server-0') && server.length > 1, server.join());
  assert.deepEqual(names(files).sort(), ['docs-reference', 'latency', ...server].sort());
  assert.equal(jobsFor(files).scope, 'scoped');
  assert.equal(smokeFor(files), false);
});

test('the types-web job, which runs the bundle comparison, covers what can move the bundle (#1117)', () => {
  for (const f of ['apps/web/src/App.tsx', 'packages/world-compiler/src/joints.ts', 'tools/test-harness/bundle-budget/baseline.json', 'tools/test-harness/bundle-budget/budget.mjs']) assert.ok(names([f]).includes('types-web'), f);
  assert.ok(!names(['docs/testing.md']).includes('types-web'));
  assert.match(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'), /types-web\)[^;]*@souls\/web build\n[^;]*budget\.mjs --check/);
});

test('routing: the server shards and the long legs go to CI_HEAVY_RUNNER; the short legs, native and smoke stay hosted', () => {
  const heavy = JOBS.filter(j => j.heavy).map(j => j.name).sort();
  assert.deepEqual(heavy, ['launcher', 'packages', ...JOBS.filter(j => j.kind === 'server').map(j => j.name), 'soul-actions'].sort());
  for (const job of JOBS) assert.deepEqual(runnerFor(job, '["self-hosted","souls-heavy"]'), job.heavy ? ['self-hosted', 'souls-heavy'] : 'ubuntu-latest', job.name);
  assert.equal(runnerFor(JOBS.find(j => j.kind === 'native'), '["self-hosted","souls-heavy"]'), 'ubuntu-latest');
  assert.equal(runnerFor(JOBS.find(j => j.kind === 'server'), 'souls-ci'), 'souls-ci');
  assert.ok(jobsFor(['package.json']).include.some(j => j.heavy === true), 'the flag reaches the matrix');
});

test('routing: the short legs go to CI_LIGHT_RUNNER when set; native and latency keep their wall-time budgets hosted', () => {
  const light = JOBS.filter(j => j.light).map(j => j.name).sort();
  assert.deepEqual(light, ['client-cli', 'docs-reference', 'soul-tools', 'types-web', 'web']);
  for (const job of JOBS) assert.deepEqual(runnerFor(job, 'souls-heavy', 'souls-light'), job.heavy ? 'souls-heavy' : job.light ? 'souls-light' : 'ubuntu-latest', job.name);
  for (const kind of ['native', 'latency']) assert.equal(runnerFor(JOBS.find(j => j.kind === kind), 'souls-heavy', 'souls-light'), 'ubuntu-latest', kind);
  assert.ok(jobsFor(['package.json']).include.some(j => j.light === true), 'the flag reaches the matrix');
});

test('routing fallback: with CI_HEAVY_RUNNER and CI_LIGHT_RUNNER unset every job is hosted', () => {
  for (const unset of ['', undefined]) for (const job of JOBS) assert.equal(runnerFor(job, unset, unset), 'ubuntu-latest', job.name);
});

test('ci.yml: qualify runs-on reads the matrix flag, and smoke stays hosted (#1162)', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const runsOn = /^  qualify:[\s\S]*?^    runs-on: (.*)$/m.exec(workflow)?.[1] ?? '';
  assert.equal(runsOn, "${{ matrix.heavy && vars.CI_HEAVY_RUNNER && (startsWith(vars.CI_HEAVY_RUNNER, '[') && fromJSON(vars.CI_HEAVY_RUNNER) || vars.CI_HEAVY_RUNNER) || matrix.light && vars.CI_LIGHT_RUNNER && (startsWith(vars.CI_LIGHT_RUNNER, '[') && fromJSON(vars.CI_LIGHT_RUNNER) || vars.CI_LIGHT_RUNNER) || 'ubuntu-latest' }}");
  assert.equal(/^  smoke:[\s\S]*?^    runs-on: (.*)$/m.exec(workflow)?.[1], 'ubuntu-latest');
});

test('the soul-actions job runs on its own paths, full scope included, and on nothing else (#1061)', () => {
  for (const f of ['tools/soul-actions/shared-crew.test.mjs', 'apps/server/src/edge/ledger/together.ts', 'apps/server/test/native-owner-fixture.ts', 'packages/world-compiler/src/model.ts', 'packages/engine-mars/src/x.ts']) assert.ok(names([f]).includes('soul-actions'), f);
  for (const f of ['apps/web/src/App.tsx', 'docs/testing.md', 'tools/world-launcher/launcher.mjs', 'packages/edge-cli/x.ts']) assert.ok(!names([f]).includes('soul-actions'), f);
  assert.ok(names(['pnpm-lock.yaml']).includes('soul-actions'));
  assert.ok(!('paths' in jobsFor(['tools/soul-actions/x.test.mjs']).include.find(j => j.name === 'soul-actions')));
});

test('the soul-tools job runs on its own paths, full scope included, and on nothing else (#1111)', () => {
  for (const f of ['tools/soul-runtime/run.test.mjs', 'tools/soul-trace/tap.mjs', 'tools/world-launcher/soul/eden.mjs', 'apps/server/src/edge/comms/testing.ts', 'tools/entry/check.mjs', 'content/kinds/chair.json', 'packages/form-rules/src/index.ts']) assert.ok(names([f]).includes('soul-tools'), f);
  for (const f of ['apps/web/src/App.tsx', 'docs/testing.md', 'tools/world-launcher/launcher.mjs', 'tools/edge-skill/client.mjs', 'tools/soul-actions/shared-crew.test.mjs']) assert.ok(!names([f]).includes('soul-tools'), f);
  assert.ok(names(['pnpm-lock.yaml']).includes('soul-tools'));
  assert.ok(!('paths' in jobsFor(['tools/soul-trace/x.test.mjs']).include.find(j => j.name === 'soul-tools')));
});

test('a v2/-only change runs the v2 job alone, scope none; v2 runs on nothing else (K15, #2637)', () => {
  for (const files of [['v2/x.rs'], ['v2/crates/seed/src/lib.rs', 'v2/docs/TRUNK.md', 'v2/Cargo.lock']]) {
    assert.deepEqual(names(files), ['v2'], files.join());
    assert.equal(jobsFor(files).scope, 'none');
    assert.equal(smokeFor(files), false);
  }
  for (const f of ['apps/server/src/world.ts', 'apps/web/src/App.tsx', 'docs/testing.md', 'tools/v2/x.mjs']) assert.ok(!names([f]).includes('v2'), f);
  assert.ok(names(['pnpm-lock.yaml']).includes('v2'), 'full scope includes it');
  assert.ok(!('paths' in jobsFor(['v2/x.rs']).include[0]));
});

test('ci.yml: the v2 job skips the pnpm install and runs v2/tools/ci.sh on the pinned toolchain', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const qualify = /^  qualify:[\s\S]*?(?=^  \S)/m.exec(workflow)?.[0] ?? '';
  assert.match(qualify, /if: matrix\.kind != 'v2'\n\s+run: pnpm install --frozen-lockfile/);
  assert.match(qualify, /^\s+v2\)\n.*\n\s+bash v2\/tools\/ci\.sh$/m);
  assert.match(qualify, /rust-toolchain\.toml/);
  assert.match(qualify, /key: v2-cargo-.*hashFiles\('v2\/rust-toolchain\.toml', 'v2\/Cargo\.lock'\)/);
});

test('unmapped paths (lockfile, .github, mars) run every job', () => {
  for (const f of ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'mars/viewer/x.js']) assert.equal(names([f]).length, JOBS.length, f);
});

test('matrix entries keep the shape the workflow expects', () => {
  for (const job of jobsFor(['package.json']).include) {
    assert.ok(job.name && job.kind && typeof job.assets === 'boolean');
    assert.ok(!('steps' in job));
  }
});

test('no usable base means run everything', () => {
  assert.equal(changedFiles(''), null);
  assert.equal(changedFiles('0000000000000000000000000000000000000000'), null);
  assert.equal(changedFiles('abc', 'def', () => { throw Error('bad ref'); }), null);
  assert.deepEqual(changedFiles('abc', 'def', () => 'a\nb\n'), ['a', 'b']);
});

test('the local smoke runs for web, server and e2e changes, or with no base', () => {
  for (const f of ['apps/web/src/main.ts', 'apps/server/src/world.ts', 'e2e/local-smoke.mjs']) assert.equal(smokeFor([f]), true, f);
  for (const f of ['docs/testing.md', 'packages/kernel/src/x.ts', 'tools/playtest/x.mjs', 'apps/webby/x']) assert.equal(smokeFor([f]), false, f);
  assert.equal(smokeFor(null), true);
});

// Music source changes must retain the web generation/composition checks after leaving vendor/.
test('owned music source selects web build, web tests and package checks', () => {
  const names = jobsFor(['packages/music/source/site/pieces/pixel-town.js']).include.map(j => j.name);
  assert.deepEqual(names.sort(), ['packages', 'types-web', 'web']);
});

test('the daily run and manual runs check everything; pull request, merge group and push runs stay scoped', () => {
  const script = fileURLToPath(new URL('./ci-scope.mjs', import.meta.url));
  const plan = event => JSON.parse(execFileSync(process.execPath, [script, '--files', 'docs/a.md', '--event', event], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } }));
  assert.deepEqual(FULL_EVENTS, ['schedule', 'workflow_dispatch']);
  for (const event of FULL_EVENTS) {
    const p = plan(event);
    assert.equal(p.scope, 'full', event);
    assert.deepEqual(p.matrix, JOBS.map(j => j.name), event);
    assert.equal(p.smoke, 'true', event);
  }
  for (const event of ['pull_request', 'merge_group', 'push']) {
    const p = plan(event);
    assert.equal(p.scope, 'none', event);
    assert.deepEqual(p.matrix, [], event);
  }
  // ci.yml passes the event to the scope step, and only takes pushes to main.
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /ci-scope\.mjs --base "\$BASE" --head "\$HEAD_SHA" --event "\$EVENT"/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
});

// #918: the god-skill unit tests (replay corpus included) run on the one job carrying godSkill.
test('god-skill unit tests: one job runs them, and god or god-skill changes select it', async () => {
  assert.deepEqual(JOBS.filter(j => j.godSkill).map(j => j.name), ['server-0']);
  assert.equal(JOBS.find(j => j.godSkill).assets, true, 'glb and upload tests read pulled media');
  const god = files => jobsFor(files).include.filter(j => j.godSkill).map(j => j.name);
  for (const f of ['tools/god-skill/lib/upload.mjs', 'tools/god-skill/replay-corpus.test.mjs', 'apps/server/src/god/buildsafe-rule.ts']) assert.deepEqual(god([f]), ['server-0'], f);
  assert.deepEqual(god(['docs/testing.md']), []);
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /GOD_SKILL: \$\{\{ matrix\.godSkill \|\| false \}\}/);
  assert.ok(workflow.includes(`if [ "$GOD_SKILL" = true ]; then node --test --test-concurrency=1 ${GOD_SKILL_TESTS} || god=$?; fi`));
  assert.match(workflow, /exit \$\(\( server \|\| god \)\)/);
  // every god-skill *.test.mjs is covered by the globs (the e2e/*.test.mjs are fixture unit tests: no browser)
  const { readdirSync } = await import('node:fs');
  const root = fileURLToPath(new URL('../../tools/god-skill/', import.meta.url));
  const all = readdirSync(root, { recursive: true }).filter(f => /\.test\.mjs$/.test(f) && !f.includes('node_modules')).map(f => `tools/god-skill/${f}`);
  const covered = f => GOD_SKILL_TESTS.split(' ').some(g => new RegExp(`^${g.replace(/\./g, '\\.').replace('*', '[^/]*')}$`).test(f));
  assert.deepEqual(all.filter(f => !covered(f)), [], 'god-skill tests outside GOD_SKILL_TESTS');
});

// The CI window (#913, docs/testing.md#ci-window).
const script = fileURLToPath(new URL('./ci-scope.mjs', import.meta.url));
const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } }));

test('window: a ready PR labelled merge:ready or ci:run is open; drafts and unlabelled PRs are closed; other events are never windowed', () => {
  assert.deepEqual(WINDOW_LABELS, ['merge:ready', 'ci:run']);
  assert.equal(windowFor({ event: 'pull_request', labels: ['ci:run'] }).open, true);
  assert.equal(windowFor({ event: 'pull_request', labels: ['area:ci', 'merge:ready'] }).open, true);
  assert.equal(windowFor({ event: 'pull_request', labels: ['area:ci'] }).open, false);
  assert.equal(windowFor({ event: 'pull_request', draft: true, labels: ['ci:run'] }).open, false);
  for (const event of ['push', 'workflow_dispatch', 'merge_group', 'request']) assert.equal(windowFor({ event }).open, true, event);
});

test('window: closed with heavy jobs selected defers them all; nothing selected is never deferred', () => {
  const heavy = { include: jobsFor(['apps/server/src/world.ts']).include, smoke: true };
  const closed = windowFor({ event: 'pull_request', labels: [] }), open = windowFor({ event: 'pull_request', labels: ['ci:run'] });
  assert.deepEqual(windowed(heavy, closed), { include: [], smoke: false, deferred: true, why: closed.why });
  assert.deepEqual(windowed(heavy, open), { ...heavy, deferred: false, why: open.why });
  assert.equal(windowed({ include: [], smoke: false }, closed).deferred, false);
  assert.equal(windowed({ include: [], smoke: true }, closed).deferred, true, 'the smoke alone is heavy work too');
  const already = windowed(heavy, windowFor({ event: 'request' }), { greenAtHead: true });
  assert.deepEqual([already.include, already.smoke, already.deferred], [[], false, false]);
  assert.equal(windowed(heavy, closed, { greenAtHead: true }).deferred, true, 'an earlier green never opens a closed window');
});

test('window CLI: the outputs ci.yml reads, for a PR push outside and inside the window and for a requested run', () => {
  const server = ['--files', 'apps/server/src/world.ts'];
  const out = run(...server, '--event', 'pull_request', '--draft', 'false', '--labels', '["area:ci"]');
  assert.deepEqual([out.matrix, out.any, out.smoke, out.deferred], [[], 'false', 'false', 'true']);
  assert.ok(out.selected.includes('latency'), 'the deferred jobs are still reported');
  assert.ok(out.daily.includes('server-0'), 'and the heavy legs left to after the merge');
  const inside = run(...server, '--event', 'pull_request', '--draft', 'false', '--labels', '["ci:run"]');
  assert.deepEqual([inside.any, inside.smoke, inside.deferred], ['true', 'true', 'false']);
  assert.deepEqual(inside.matrix, names(['apps/server/src/world.ts']).filter(n => !JOBS.find(j => j.name === n).heavy));
  const draft = run(...server, '--event', 'pull_request', '--draft', 'true', '--labels', '["merge:ready"]');
  assert.equal(draft.deferred, 'true');
  const requested = run(...server, '--event', 'request');
  assert.deepEqual([requested.scope, requested.deferred, requested.matrix], ['scoped', 'false', names(['apps/server/src/world.ts'])], 'a request is path-scoped, not full');
  assert.deepEqual(run(...server, '--event', 'request', '--green-at-head', 'true').matrix, []);
  const docs = run('--files', 'docs/a.md', '--event', 'pull_request', '--labels', 'null');
  assert.deepEqual([docs.deferred, docs.any, docs.smoke], ['false', 'false', 'false']);
  for (const event of FULL_EVENTS) assert.equal(run('--files', 'docs/a.md', '--event', event).deferred, 'false', event);
});

test('greenAtHead: the newest uncancelled ci run at the head passed, and none newer is running', () => {
  const r = (id, status, conclusion = null) => ({ id, status, conclusion });
  assert.equal(greenAtHead([]), false);
  assert.equal(greenAtHead([r(1, 'completed', 'success')]), true);
  assert.equal(greenAtHead([r(1, 'completed', 'success'), r(2, 'completed', 'failure')]), false, 'a deferred or failed newer run');
  assert.equal(greenAtHead([r(1, 'completed', 'success'), r(2, 'completed', 'cancelled')]), true, 'cancelled says nothing');
  assert.equal(greenAtHead([r(1, 'completed', 'success'), r(2, 'in_progress')]), false, 'a newer run is still going');
  assert.equal(greenAtHead([r(1, 'completed', 'success'), r(2, 'in_progress')], 2), true, 'a run never counts itself');
});

// Gene, 18 Nov (startup mode): the heavy legs run in the daily full run on main and before a release, not per change.
const HEAVY = JOBS.filter(j => j.heavy).map(j => j.name);
const SERVER = ['--files', 'apps/server/src/world.ts'];

test('heavy legs: pull_request, merge_group and push runs select none; the daily, manual and requested runs select them', () => {
  assert.deepEqual(HEAVY, ['packages', 'launcher', ...Array.from({ length: JOBS.filter(j => j.kind === 'server').length }, (_, i) => `server-${i}`), 'soul-actions']);
  for (const event of ['pull_request', 'merge_group', 'push']) {
    assert.deepEqual(lightOnly(JOBS, event).daily, HEAVY, event);
    assert.equal(lightOnly(JOBS, event).include.some(j => j.heavy), false, event);
  }
  for (const event of ['schedule', 'workflow_dispatch', 'request']) assert.deepEqual(lightOnly(JOBS, event), { include: JOBS, daily: [] }, event);
  const light = ['types-web', 'latency', 'docs-reference', 'soul-tools'];
  const pr = run(...SERVER, '--event', 'pull_request', '--draft', 'false', '--labels', '["merge:ready"]');
  assert.deepEqual(pr.matrix, light, 'the light legs the paths pick still run on the PR');
  assert.equal(pr.smoke, 'true', 'and the smoke');
  assert.deepEqual(pr.daily, names(['apps/server/src/world.ts']).filter(n => HEAVY.includes(n)));
  const group = run(...SERVER, '--event', 'merge_group');
  assert.deepEqual([group.matrix, group.smoke, group.deferred], [light, 'true', 'false'], 'the queue runs the same light legs and the smoke');
  assert.deepEqual(group.daily, pr.daily);
  const push = run(...SERVER, '--event', 'push');
  assert.deepEqual([push.matrix, push.smoke, push.daily], [light, 'true', pr.daily], 'a push to main runs the same light set as its merge group');
  for (const event of FULL_EVENTS) {
    const main = run(...SERVER, '--event', event);
    assert.deepEqual([main.matrix, main.daily], [JOBS.map(j => j.name), []], `${event}: every heavy leg runs`);
  }
  // a change whose paths pick only heavy legs has nothing of its own to run, so it is never deferred
  const only = run('--files', 'tools/soul-actions/a.test.mjs', '--event', 'pull_request', '--draft', 'true', '--labels', '[]');
  assert.deepEqual([only.matrix, only.daily, only.deferred], [[], ['soul-actions'], 'false']);
  assert.deepEqual(run('--files', 'tools/soul-actions/a.test.mjs', '--event', 'merge_group').matrix, []);
});

test('ci-ok: a ready pull_request with only light legs green passes; a failed leg or a deferred run still fails', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const ok = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  const script = ok.slice(ok.indexOf('        run: |\n', ok.indexOf('SCOPE:')) + 15).split('\n').filter(l => l.startsWith('          ')).map(l => l.slice(10)).join('\n');
  assert.match(script, /test "\$SCOPE" = success/);
  const verdict = env => { try { execFileSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' }); return 'pass'; } catch { return 'fail'; } };
  const pr = run(...SERVER, '--event', 'pull_request', '--draft', 'false', '--labels', '["ci:run"]');
  assert.equal(pr.deferred, 'false', 'the deferral step does not run');
  const needs = { SCOPE: 'success', REPO: 'success', QUALIFY: 'success', ANY: pr.any, SMOKE: 'success', SMOKE_SELECTED: pr.smoke };
  assert.equal(verdict(needs), 'pass');
  assert.equal(verdict({ ...needs, QUALIFY: 'failure' }), 'fail', 'a light leg that failed');
  assert.equal(verdict({ ...needs, SMOKE: 'failure' }), 'fail');
  const none = run('--files', 'tools/soul-actions/a.test.mjs', '--event', 'pull_request', '--draft', 'false', '--labels', '["ci:run"]');
  assert.equal(verdict({ ...needs, ANY: none.any, QUALIFY: 'skipped', SMOKE_SELECTED: none.smoke, SMOKE: 'skipped' }), 'pass', 'nothing of its own to run');
  assert.match(ok, /if: needs\.scope\.outputs\.deferred == 'true'[\s\S]*?exit 1/, 'outside the window a deferred run still fails');
});

test('green at head: a requested run reads only requested runs, since a pull_request pass covers no heavy leg', () => {
  const r = (id, event, conclusion = 'success') => ({ id, event, status: 'completed', conclusion });
  const runs = [r(1, 'workflow_dispatch', 'failure'), r(2, 'pull_request')];
  assert.equal(greenAtHead(runs), true, 'a label run repeats the newest result');
  assert.equal(greenAtHead(runs, null, ['workflow_dispatch']), false);
  assert.equal(greenAtHead([r(1, 'workflow_dispatch'), r(2, 'pull_request', 'failure')], null, ['workflow_dispatch']), true);
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /EVENTS: \$\{\{ github\.event_name == 'workflow_dispatch' && 'workflow_dispatch' \|\| '' \}\}/);
  assert.match(workflow, /--self "\$GITHUB_RUN_ID" --events "\$EVENTS"/);
});

test('ci.yml: every label starts a real pull_request run with ci-ok, queued in the PR group (#2018)', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const job = name => workflow.slice(workflow.indexOf(`\n  ${name}:\n`) + 1).split(/\n  [a-z-]+:\n/)[0];
  // the queue reads only the newest ci run at a head: no label may leave one without a real ci-ok
  assert.doesNotMatch(workflow, /github\.event\.label\.name|other-label/);
  assert.doesNotMatch(job('scope'), /^    if: /m);
  assert.equal(job('repo').match(/^    if: (.*)$/m)[1], "needs.scope.outputs.green != 'true'", 'repo skips only on a green head');
  const ok = job('ci-ok');
  assert.doesNotMatch(ok, /^    name: /m, 'the job is always named ci-ok');
  assert.equal(ok.match(/^    if: (.*)$/m)[1], 'always()');
  // a label run queues behind the PR's running CI and never cancels it; a push still cancels
  assert.match(workflow.match(/^  group: (.*)$/m)[1], /format\('ci-\{0\}', github\.event\.pull_request\.number \|\| inputs\.pr \|\| github\.ref\)/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'push' \|\| \(github\.event_name == 'pull_request' && github\.event\.action != 'labeled'\) \}\}/);
  // a label on a green head does no heavy work, and the head is the PR's, not the merge commit
  assert.match(job('scope'), /if: github\.event\.action == 'labeled' \|\| \(github\.event_name == 'workflow_dispatch'/);
  assert.match(job('scope'), /green --repo "\$GITHUB_REPOSITORY" --sha "\$HEAD_SHA" --self/);
});

test('#2018: merge:ready then approved:maintainer keeps a passing ci-ok without heavy work', () => {
  const server = ['--files', 'apps/server/src/world.ts', '--event', 'pull_request', '--draft', 'false'];
  const ready = run(...server, '--labels', '["merge:ready"]');
  assert.deepEqual([ready.any, ready.deferred], ['true', 'false'], 'merge:ready runs the heavy jobs');
  const green = String(greenAtHead([{ id: 1, status: 'completed', conclusion: 'failure' }, { id: 2, status: 'completed', conclusion: 'success' }], 3));
  assert.equal(green, 'true', 'the merge:ready run passed at this head');
  const approved = run(...server, '--labels', '["merge:ready","approved:maintainer"]', '--green-at-head', green);
  assert.deepEqual([approved.any, approved.smoke, approved.deferred], ['false', 'false', 'false'], 'ci-ok passes on scope and repo alone');
});

test('a window label opens the window on its own pull_request run, and green at the head does no heavy work', () => {
  const heavy = { include: [{ name: 'server-0' }], smoke: true };
  const win = windowFor({ event: 'pull_request', labels: ['ci:run'] });
  assert.equal(win.open, true);
  assert.deepEqual(windowed(heavy, win, { greenAtHead: true }), { include: [], smoke: false, deferred: false, green: true, why: 'a ci run at this head already passed' });
  assert.deepEqual(windowed(heavy, win).include, heavy.include);
  assert.equal(windowed(heavy, windowFor({ event: 'pull_request', draft: true, labels: ['ci:run'] })).deferred, true, 'a draft stays deferred');
});

test('ci.yml: the window reaches the scope step, and a deferred run fails ci-ok', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /--draft "\$DRAFT" --labels "\$LABELS" --green-at-head "\$GREEN"/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review, labeled\]/);
  const ok = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  assert.match(ok, /if: needs\.scope\.outputs\.deferred == 'true'[\s\S]*?exit 1/);
  const labels = readFileSync(fileURLToPath(new URL('../labels.yml', import.meta.url)), 'utf8');
  for (const l of WINDOW_LABELS) assert.match(labels, new RegExp(`name: "${l}"`));
});

// Low-risk paths (Gene, 17 Nov): a change confined to entry, content, form-rules, docs or changelog fragments runs no
// server, smoke (e2e), walk (packages) or bundle (types-web) job; it keeps repo (always), the entry tests and the
// form-rules tests (soul-tools).
const SKIPPED = JOBS.filter(j => j.kind === 'server' || ['latency', 'packages', 'types-web', 'launcher', 'native', 'client-cli', 'soul-actions'].includes(j.name)).map(j => j.name);
const LOW = ['tools/entry/check.mjs', 'content/kinds/seating/bench.json', 'content/asks/a.json', 'content/moves/a.json', 'packages/form-rules/cases/kettle.json', 'docs/testing.md', 'changes/a-fragment.md', 'README.md'];

test('low-risk: a diff confined to the allowlist runs soul-tools only: no server, smoke, walk or bundle job', () => {
  const plan = jobsFor(LOW);
  assert.equal(plan.scope, 'low-risk');
  assert.deepEqual(plan.include.map(j => j.name), ['soul-tools']);
  for (const n of SKIPPED) assert.ok(!names(LOW).includes(n), n);
  assert.equal(smokeFor(LOW), false);
  for (const f of LOW) assert.deepEqual(names([f]).filter(n => SKIPPED.includes(n)), [], f);
  assert.deepEqual(names(['changes/a.md']), [], 'a fragment alone runs no job');
  assert.deepEqual(names(['docs/site/api.md']), ['docs-reference'], 'the reference pages still run their generator');
  // the soul-tools job runs the entry tests, the form-rules tests and the launcher test that reads content/kinds
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const tools = workflow.slice(workflow.indexOf('            soul-tools)'), workflow.indexOf('            server)'));
  for (const t of ['tools/entry/*.test.mjs', 'packages/form-rules/src/*.test.ts', 'tools/world-launcher/soul/card-search.test.mjs']) assert.ok(tools.includes(t), t);
});

test('low-risk: form-rules source keeps the web jobs, because apps/web imports it', () => {
  assert.deepEqual(names(['packages/form-rules/src/looks.ts']).sort(), ['soul-tools', 'types-web', 'web']);
  const importer = readFileSync(fileURLToPath(new URL('../../apps/web/src/gen-mesh/vocab-look.ts', import.meta.url)), 'utf8');
  assert.match(importer, /packages\/form-rules\/src\/looks\.ts/);
});

test('low-risk: exact prefixes; one file outside the allowlist runs the full battery', () => {
  for (const f of ['content/other/a.json', 'contents/kinds/a.json', 'tools/entryx/a.mjs', 'packages/form-rules-x/a.ts', 'AGENTS.md', 'CLAUDE.md', 'apps/docs/a.md'])
    assert.notEqual(jobsFor([...LOW, f]).scope, 'low-risk', f);
  // a PR carries a changelog fragment, which the path map does not name: beside any outside file, every job runs
  for (const f of ['apps/server/src/world.ts', 'tools/proof/tier.mjs', 'AGENTS.md', 'pnpm-lock.yaml', '.github/workflows/ci.yml'])
    assert.deepEqual(names([...LOW, f]), JOBS.map(j => j.name), f);
  assert.deepEqual(names(['tools/entry/check.mjs', 'mars/viewer/x.js']), JOBS.map(j => j.name), 'an unmapped path, no fragment');
  assert.equal(smokeFor([...LOW, 'apps/server/src/world.ts']), true);
});

test('low-risk: an empty, missing or unreadable diff runs the full battery', () => {
  for (const files of [[], null, undefined]) {
    assert.equal(jobsFor(files).scope, 'full', String(files));
    assert.deepEqual(names(files), JOBS.map(j => j.name), String(files));
    assert.equal(smokeFor(files), true, String(files));
  }
  assert.equal(changedFiles('abc', 'def', () => { throw Error('bad object'); }), null);
  const light = JOBS.filter(j => !j.heavy).map(j => j.name);
  for (const [event, matrix] of [['pull_request', light], ['merge_group', light], ['push', light], ['schedule', JOBS.map(j => j.name)]]) {
    const empty = run('--files', '', '--event', event, '--labels', '["ci:run"]');
    assert.deepEqual([empty.scope, empty.matrix, empty.smoke], ['full', matrix, 'true'], event);
  }
});

test('low-risk: a merge group of two allowlist PRs is scoped; one with a server PR in it runs every light leg', () => {
  const a = ['tools/entry/format.mjs', 'changes/sa-f6c.md'], b = ['content/kinds/kitchen/kettle.json', 'packages/form-rules/cases/kettle.json', 'changes/sa-d3.md'];
  const group = run('--files', [...a, ...b].join(','), '--event', 'merge_group');
  assert.deepEqual([group.scope, group.matrix, group.smoke, group.deferred, group.any], ['low-risk', ['soul-tools'], 'false', 'false', 'true']);
  const mixed = run('--files', [...a, ...b, 'apps/server/src/world.ts', 'changes/server.md'].join(','), '--event', 'merge_group');
  assert.deepEqual([mixed.scope, mixed.matrix, mixed.smoke], ['full', JOBS.filter(j => !j.heavy).map(j => j.name), 'true']);
});


// A label run at a head whose newest ci run passed: only scope and ci-ok run (18 Nov). The green step used the gh CLI,
// which the light self-hosted runners lack, so it always answered nothing and every label re-ran the light legs.
test('green at head: read with fetch and GH_TOKEN, no gh CLI; a failed read is not green', async () => {
  const runs = [{ id: 1, event: 'pull_request', status: 'completed', conclusion: 'success' }, { id: 2, event: 'pull_request', status: 'in_progress', conclusion: null }];
  let seen;
  const get = async (url, init) => { seen = { url, auth: init.headers.authorization }; return { ok: true, json: async () => ({ workflow_runs: runs }) }; };
  assert.deepEqual(await ciRunsAt('o/r', 'abc', { token: 't', api: 'https://api.example', fetch: get }), runs);
  assert.deepEqual(seen, { url: 'https://api.example/repos/o/r/actions/workflows/ci.yml/runs?head_sha=abc&per_page=100', auth: 'Bearer t' });
  assert.equal(await greenCommand({ repo: 'o/r', sha: 'abc', self: 2 }, { token: 't', fetch: get }), 'true', 'the label run itself never counts');
  assert.equal(await greenCommand({ repo: 'o/r', sha: 'abc', self: 9 }, { token: 't', fetch: get }), 'false', 'a newer run still going');
  const warn = console.error; console.error = () => {};
  try {
    assert.equal(await greenCommand({ repo: 'o/r', sha: 'abc' }, { fetch: async () => ({ ok: false, status: 403 }) }), 'false');
    assert.equal(await greenCommand({ repo: 'o/r', sha: 'abc' }, { fetch: async () => { throw new Error('offline'); } }), 'false');
  } finally { console.error = warn; }
  assert.doesNotMatch(readFileSync(fileURLToPath(new URL('./ci-scope.mjs', import.meta.url)), 'utf8'), /execFileSync\('gh'/);
});

test('green at head: a label run selects nothing and outputs green; a push, a closed window or a red head runs as today', () => {
  const ready = [...SERVER, '--event', 'pull_request', '--draft', 'false', '--labels', '["merge:ready","approved:maintainer"]'];
  const green = run(...ready, '--green-at-head', 'true');
  assert.deepEqual([green.matrix, green.any, green.smoke, green.deferred, green.green], [[], 'false', 'false', 'false', 'true']);
  const red = run(...ready, '--green-at-head', 'false');
  assert.deepEqual([red.any, red.smoke, red.green], ['true', 'true', 'false'], 'a head that was not green runs its jobs');
  const closed = run(...SERVER, '--event', 'pull_request', '--draft', 'false', '--labels', '["area:ci"]', '--green-at-head', 'true');
  assert.deepEqual([closed.deferred, closed.green], ['true', 'false'], 'an earlier green never opens a closed window');
  for (const event of ['merge_group', 'push']) assert.equal(run(...SERVER, '--event', event).green, 'false', event);
  // ci.yml only asks on a label or a requested run: a synchronize, a merge group and a push never read green at head
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /- id: green\n        name: Already green at this head\n        if: github\.event\.action == 'labeled' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.pr != ''\)\n/);
  assert.match(workflow, /^      green: \$\{\{ steps\.scope\.outputs\.green \}\}$/m);
});

test('ci-ok: on a green head it passes with repo, qualify and smoke skipped; a skipped repo fails anywhere else', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const ok = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  assert.match(ok, /GREEN: \$\{\{ needs\.scope\.outputs\.green \}\}/);
  const script = ok.slice(ok.indexOf('        run: |\n', ok.indexOf('SCOPE:')) + 15).split('\n').filter(l => l.startsWith('          ')).map(l => l.slice(10)).join('\n');
  const verdict = env => { try { execFileSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' }); return 'pass'; } catch { return 'fail'; } };
  const g = run(...SERVER, '--event', 'pull_request', '--draft', 'false', '--labels', '["merge:ready"]', '--green-at-head', 'true');
  const skipped = { SCOPE: 'success', REPO: 'skipped', QUALIFY: 'skipped', ANY: g.any, SMOKE: 'skipped', SMOKE_SELECTED: g.smoke, GREEN: g.green };
  assert.equal(verdict(skipped), 'pass');
  assert.equal(verdict({ ...skipped, GREEN: 'false' }), 'fail', 'repo skipped without a green head');
  assert.equal(verdict({ ...skipped, SCOPE: 'failure' }), 'fail');
  assert.equal(verdict({ ...skipped, REPO: 'success', GREEN: '' }), 'pass', 'an ordinary run, green unset');
});
