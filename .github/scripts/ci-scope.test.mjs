import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BODY_TESTS, FULL_EVENTS, GOD_SKILL_TESTS, JOBS, LOCAL_COMMANDS, SMOKE_COMMAND, WINDOW_LABELS, changedFiles, greenAtHead, heavyInQueue, jobsFor, localCommands, packageTests, runnerFor, treeReach, windowFor, windowed } from './ci-scope.mjs';

// One reach map of this tree for the selection tests (the CLI builds its own, from the same tree).
const REACH = treeReach();
const plan = files => jobsFor(files, undefined, REACH);
const names = files => plan(files).include.map(j => j.name);
const ALL = JOBS.map(j => j.name);
const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');

test('a diff the reach map cannot place runs every job and the smoke', () => {
  for (const f of ['pnpm-lock.yaml', 'package.json', 'apps/server/package.json', '.github/workflows/ci.yml', 'tools/test-harness/walk/baseline/eden-2026.json', 'tools/test-harness/bundle-budget/baseline.json', 'vendor/x.js', 'tools/x/a.weird']) {
    const p = plan(['content/moves/pour.json', f]);
    assert.deepEqual([p.scope, p.include.map(j => j.name), p.smoke], ['full', ALL, true], f);
    assert.match(p.diff.full, /outside the reach map/, f);
  }
  for (const files of [[], null, undefined]) assert.deepEqual([plan(files).scope, names(files), plan(files).smoke], ['full', ALL, true], String(files));
});

test('content-only: a move file runs only the tests that read it, as a selected soul-tools leg; no server, smoke, walk or bundle', () => {
  const p = plan(['content/moves/pour.json']);
  assert.deepEqual(p.include.map(j => j.name), ['soul-tools (selected)']);
  assert.equal(p.smoke, false);
  const leg = p.include[0];
  assert.deepEqual([leg.kind, leg.of, leg.light, leg.assets], ['selected', 'soul-tools', true, false]);
  assert.ok(leg.commands.flat().includes('tools/entry/move.test.mjs'), JSON.stringify(leg.commands));
  assert.deepEqual(names(['changes/a-fragment.md']), [], 'a changelog fragment alone reaches no test');
});

test('a test file change runs that file alone; a server change runs the full shards, keeping their names', () => {
  const p = plan(['tools/soul-actions/bell.test.mjs']);
  assert.deepEqual(p.include.map(j => [j.name, j.heavy, j.files]), [['soul-actions (selected)', true, 1]]);
  assert.deepEqual(p.include[0].commands, [['node', '--test', '--test-concurrency=4', 'tools/soul-actions/bell.test.mjs']]);
  const server = names(['apps/server/src/world.ts']);
  for (const n of ['types-web', 'latency', 'docs-reference', ...ALL.filter(n => n.startsWith('server-'))]) assert.ok(server.includes(n), n);
});

test('a narrow server change runs its affected server files through the server package, never under a full leg\'s name', () => {
  const p = plan(['tools/god-skill/lib/upload.mjs']);
  const legs = p.include.filter(j => j.of === 'server');
  assert.ok(legs.length >= 1 && legs.every(j => j.kind === 'selected' && j.heavy && j.assets && !/^server-\d$/.test(j.name)), JSON.stringify(p.include.map(j => j.name)));
  const argv = legs.flatMap(j => j.commands);
  assert.ok(argv.some(a => a.slice(0, 5).join(' ') === 'pnpm --filter @souls/server exec node'), 'server files run in the server package');
  assert.ok(argv.some(a => a[0] === 'node' && a.some(x => x.startsWith('tools/god-skill/'))), 'the god-skill tests that reach the changed file');
});

test('the selected leg runs through ci.yml, and every full leg\'s local commands are ci.yml\'s own lines', () => {
  assert.match(workflow, /selected\)\n[^\n]*\n[^\n]*\n\s+node \.github\/scripts\/ci-scope\.mjs exec\n/);
  assert.match(workflow, /SELECTED_COMMANDS: \$\{\{ toJSON\(matrix\.commands\) \}\}/);
  for (const [kind, lines] of Object.entries(LOCAL_COMMANDS)) for (const line of lines) assert.ok(workflow.includes(line), `${kind}: ${line}`);
  assert.ok(workflow.includes(SMOKE_COMMAND));
  for (const job of JOBS.filter(j => j.kind !== 'server')) assert.ok(LOCAL_COMMANDS[job.kind], job.kind);
  assert.ok(workflow.includes(`node --test --test-concurrency=1 ${GOD_SKILL_TESTS}`) && workflow.includes(BODY_TESTS.replace('*/*', '*/*')));
});

test('local: the commands a plan runs, media first, the smoke last', () => {
  const lines = localCommands(plan(['content/moves/pour.json']));
  assert.deepEqual(lines.map(l => l.leg), ['soul-tools (selected)']);
  const web = localCommands(plan(['apps/web/src/main.tsx'])).map(l => l.line);
  assert.equal(web[0], 'pnpm assets:pull --quiet');
  assert.equal(web.at(-1), SMOKE_COMMAND);
  assert.ok(web.includes('bash tools/test-harness/web-suite.sh'));
});

test('the packages leg reads every workspace package\'s test script, the client one through the root', () => {
  const read = f => { try { return readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)), 'utf8'); } catch { return null; } };
  const globs = packageTests([...REACH.present], read);
  for (const g of ['packages/kernel/src/*.test.ts', 'packages/world-compiler/scripts/*.test.mjs', 'tools/client-eval/*.test.mjs']) assert.ok(globs.includes(g), g);
  assert.ok(!globs.some(g => g.startsWith('apps/server') || g.startsWith('mars/viewer')), 'not the server or the viewer');
});

test('pushes to main and manual runs check everything; pull request and merge group runs select by reach', () => {
  const script = fileURLToPath(new URL('./ci-scope.mjs', import.meta.url));
  const cli = event => JSON.parse(execFileSync(process.execPath, [script, '--files', 'changes/a.md', '--event', event], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } }));
  assert.deepEqual(FULL_EVENTS, ['push', 'workflow_dispatch']);
  for (const event of FULL_EVENTS) {
    const p = cli(event);
    assert.deepEqual([p.scope, p.matrix, p.smoke], ['full', ALL, 'true'], event);
  }
  for (const event of ['pull_request', 'merge_group']) assert.deepEqual([cli(event).scope, cli(event).matrix], ['none', []], event);
  assert.match(workflow, /ci-scope\.mjs --base "\$BASE" --head "\$HEAD_SHA" --event "\$EVENT"/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /github\.event\.merge_group\.base_sha/, 'a merge group is diffed against its base on main');
});

// #918: the god-skill unit tests (replay corpus included) and the body-authoring tests run on the server-0 leg.
test('god-skill unit tests: server-0 runs them all, and every god-skill test is under the globs', async () => {
  assert.deepEqual(JOBS.filter(j => j.godSkill).map(j => j.name), ['server-0']);
  assert.equal(JOBS.find(j => j.godSkill).assets, true, 'glb and upload tests read pulled media');
  assert.match(workflow, /GOD_SKILL: \$\{\{ matrix\.godSkill \|\| false \}\}/);
  assert.ok(workflow.includes(`if [ "$GOD_SKILL" = true ]; then node --test --test-concurrency=1 ${GOD_SKILL_TESTS} || god=$?; fi`));
  const { readdirSync } = await import('node:fs');
  const root = fileURLToPath(new URL('../../tools/god-skill/', import.meta.url));
  const all = readdirSync(root, { recursive: true }).filter(f => /\.test\.mjs$/.test(f) && !f.includes('node_modules')).map(f => `tools/god-skill/${f}`);
  const covered = f => GOD_SKILL_TESTS.split(' ').some(g => new RegExp(`^${g.replace(/\./g, '\\.').replace('*', '[^/]*')}$`).test(f));
  assert.deepEqual(all.filter(f => !covered(f)), [], 'god-skill tests outside GOD_SKILL_TESTS');
});

test('each job kind has a branch in ci.yml', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  for (const job of JOBS) assert.match(workflow, new RegExp(`^\\s+${job.kind}\\)$`, 'm'), job.kind);
});

test('routing: the server shards and the long legs go to CI_HEAVY_RUNNER; the short legs, native and smoke stay hosted', () => {
  const heavy = JOBS.filter(j => j.heavy).map(j => j.name).sort();
  assert.deepEqual(heavy, ['launcher', 'packages', ...JOBS.filter(j => j.kind === 'server').map(j => j.name), 'soul-actions'].sort());
  for (const job of JOBS) assert.deepEqual(runnerFor(job, '["self-hosted","souls-heavy"]'), job.heavy ? ['self-hosted', 'souls-heavy'] : 'ubuntu-latest', job.name);
  assert.equal(runnerFor(JOBS.find(j => j.kind === 'native'), '["self-hosted","souls-heavy"]'), 'ubuntu-latest');
  assert.equal(runnerFor(JOBS.find(j => j.kind === 'server'), 'souls-ci'), 'souls-ci');
  assert.ok(plan(['package.json']).include.some(j => j.heavy === true), 'the flag reaches the matrix');
});

test('routing: the short legs go to CI_LIGHT_RUNNER when set; native and latency keep their wall-time budgets hosted', () => {
  const light = JOBS.filter(j => j.light).map(j => j.name).sort();
  assert.deepEqual(light, ['client-cli', 'docs-reference', 'soul-tools', 'types-web', 'web']);
  for (const job of JOBS) assert.deepEqual(runnerFor(job, 'souls-heavy', 'souls-light'), job.heavy ? 'souls-heavy' : job.light ? 'souls-light' : 'ubuntu-latest', job.name);
  for (const kind of ['native', 'latency']) assert.equal(runnerFor(JOBS.find(j => j.kind === kind), 'souls-heavy', 'souls-light'), 'ubuntu-latest', kind);
  assert.ok(plan(['package.json']).include.some(j => j.light === true), 'the flag reaches the matrix');
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

test('matrix entries keep the shape the workflow expects', () => {
  for (const job of [...plan(['package.json']).include, ...plan(['tools/god-skill/lib/upload.mjs']).include]) {
    assert.ok(job.name && job.kind && typeof job.assets === 'boolean');
    assert.ok(!('reach' in job) && !('groups' in job));
    if (job.kind === 'selected') assert.ok(Array.isArray(job.commands) && job.commands.every(a => Array.isArray(a) && a.length > 3), job.name);
  }
});

test('no usable base means run everything', () => {
  assert.equal(changedFiles(''), null);
  assert.equal(changedFiles('0000000000000000000000000000000000000000'), null);
  assert.equal(changedFiles('abc', 'def', () => { throw Error('bad ref'); }), null);
  assert.deepEqual(changedFiles('abc', 'def', () => 'a\nb\n'), ['a', 'b']);
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
  const heavy = { include: plan(['apps/server/src/world.ts']).include, smoke: true };
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
  assert.ok(out.queued.includes('server-0'), 'and the heavy legs left to the merge queue');
  const inside = run(...server, '--event', 'pull_request', '--draft', 'false', '--labels', '["ci:run"]');
  assert.deepEqual([inside.any, inside.smoke, inside.deferred], ['true', 'true', 'false']);
  assert.deepEqual(inside.matrix, plan(['apps/server/src/world.ts']).include.filter(j => !j.heavy).map(j => j.name));
  const draft = run(...server, '--event', 'pull_request', '--draft', 'true', '--labels', '["merge:ready"]');
  assert.equal(draft.deferred, 'true');
  const requested = run(...server, '--event', 'request');
  assert.deepEqual([requested.scope, requested.deferred, requested.matrix], ['reach', 'false', names(['apps/server/src/world.ts'])], 'a request is reach-scoped, not full');
  assert.deepEqual(run(...server, '--event', 'request', '--green-at-head', 'true').matrix, []);
  const docs = run('--files', 'changes/a.md', '--event', 'pull_request', '--labels', 'null');
  assert.deepEqual([docs.deferred, docs.any, docs.smoke], ['false', 'false', 'false']);
  for (const event of FULL_EVENTS) assert.equal(run('--files', 'changes/a.md', '--event', event).deferred, 'false', event);
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

// Gene, 18 Nov: the heavy legs run once per change, in the merge queue, never on the pull request too.
const HEAVY = JOBS.filter(j => j.heavy).map(j => j.name);
const SERVER = ['--files', 'apps/server/src/world.ts'];

test('heavy legs: a pull_request run selects none; merge_group, push, manual and requested runs select them', () => {
  assert.deepEqual(HEAVY, ['packages', 'launcher', ...Array.from({ length: JOBS.filter(j => j.kind === 'server').length }, (_, i) => `server-${i}`), 'soul-actions']);
  assert.deepEqual(heavyInQueue(JOBS, 'pull_request').queued, HEAVY);
  assert.equal(heavyInQueue(JOBS, 'pull_request').include.some(j => j.heavy), false);
  for (const event of ['merge_group', 'push', 'workflow_dispatch', 'request']) assert.deepEqual(heavyInQueue(JOBS, event), { include: JOBS, queued: [] }, event);
  const pr = run(...SERVER, '--event', 'pull_request', '--draft', 'false', '--labels', '["merge:ready"]');
  assert.deepEqual(pr.matrix.filter(n => HEAVY.includes(n)), [], 'no heavy leg on the PR');
  assert.deepEqual(pr.matrix, names(['apps/server/src/world.ts']).filter(n => !HEAVY.includes(n) && !plan(['apps/server/src/world.ts']).include.find(j => j.name === n).heavy), 'the light legs the reach picks still run');
  assert.equal(pr.smoke, 'true', 'and the smoke');
  assert.deepEqual(pr.queued, plan(['apps/server/src/world.ts']).include.filter(j => j.heavy).map(j => j.name));
  const group = run(...SERVER, '--event', 'merge_group');
  assert.deepEqual(group.matrix, names(['apps/server/src/world.ts']), 'the queue runs every leg the reach picks');
  assert.ok(HEAVY.filter(n => n.startsWith('server-')).every(n => group.matrix.includes(n)));
  assert.deepEqual(group.queued, []);
  for (const event of FULL_EVENTS) assert.deepEqual(run(...SERVER, '--event', event).matrix, JOBS.map(j => j.name), event);
  // a PR whose reach picks only heavy legs has nothing of its own to run, so it is never deferred
  const only = run('--files', 'tools/soul-actions/bell.test.mjs', '--event', 'pull_request', '--draft', 'true', '--labels', '[]');
  assert.deepEqual([only.matrix, only.queued, only.deferred], [[], ['soul-actions (selected)'], 'false']);
  assert.deepEqual(run('--files', 'tools/soul-actions/bell.test.mjs', '--event', 'merge_group').matrix, ['soul-actions (selected)']);
});

test('ci-ok: a ready pull_request with only light legs green passes; a failed leg or a deferred run still fails', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const ok = workflow.slice(workflow.indexOf('\n  ci-ok:'));
  const script = ok.slice(ok.indexOf('        run: |\n', ok.indexOf('SCOPE:')) + 15).split('\n').filter(l => l.startsWith('          ')).map(l => l.slice(10)).join('\n');
  assert.match(script, /test "\$SCOPE" = success/);
  const verdict = env => { try { execFileSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, ...env }, stdio: 'ignore' }); return 'pass'; } catch { return 'fail'; } };
  const pr = run(...SERVER, '--event', 'pull_request', '--draft', 'false', '--labels', '["ci:run"]');
  assert.equal(pr.deferred, 'false', 'the deferral step does not run');
  const needs = { SCOPE: 'success', REPO: 'success', QUALIFY: 'success', ANY: pr.any, SMOKE: 'success', SMOKE_SELECTED: pr.smoke, COVERED: 'skipped', COVERED_SELECTED: 'false' };
  assert.equal(verdict(needs), 'pass');
  assert.equal(verdict({ ...needs, QUALIFY: 'failure' }), 'fail', 'a light leg that failed');
  assert.equal(verdict({ ...needs, SMOKE: 'failure' }), 'fail');
  const none = run('--files', 'tools/soul-actions/bell.test.mjs', '--event', 'pull_request', '--draft', 'false', '--labels', '["ci:run"]');
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
  for (const name of ['scope', 'repo']) assert.doesNotMatch(job(name), /^    if: /m, name);
  const ok = job('ci-ok');
  assert.doesNotMatch(ok, /^    name: /m, 'the job is always named ci-ok');
  assert.equal(ok.match(/^    if: (.*)$/m)[1], 'always()');
  // a label run queues behind the PR's running CI and never cancels it; a push still cancels
  assert.equal(workflow.match(/^  group: (.*)$/m)[1], 'ci-${{ github.event.pull_request.number || inputs.pr || github.ref }}');
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && github\.event\.action != 'labeled' \}\}/);
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
  assert.deepEqual(windowed(heavy, win, { greenAtHead: true }), { include: [], smoke: false, deferred: false, why: 'a ci run at this head already passed' });
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
