import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CONTENT_JOBS, CONTENT_WEB, FULL_EVENTS, GOD_SKILL_TESTS, JOBS, LIGHT_LABEL, LOW_RISK, SERVER_READER, WINDOW_LABELS, assignLight, changedFiles, contentOnly, greenAtHead, idleRunners, jobsFor, lowRisk, runnerFor, serverReaders, smokeFor, windowFor, windowed } from './ci-scope.mjs';
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

test('routing fallback: with CI_HEAVY_RUNNER unset every job is hosted', () => {
  for (const unset of ['', undefined]) for (const job of JOBS) assert.equal(runnerFor(job, unset), 'ubuntu-latest', job.name);
});

test('ci.yml: qualify runs-on reads the matrix flag, and smoke stays hosted (#1162)', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const runsOn = /^  qualify:[\s\S]*?^    runs-on: (.*)$/m.exec(workflow)?.[1] ?? '';
  assert.equal(runsOn, "${{ matrix.runner || (matrix.heavy && vars.CI_HEAVY_RUNNER && (startsWith(vars.CI_HEAVY_RUNNER, '[') && fromJSON(vars.CI_HEAVY_RUNNER) || vars.CI_HEAVY_RUNNER)) || 'ubuntu-latest' }}");
  assert.equal(/^  smoke:[\s\S]*?^    runs-on: (.*)$/m.exec(workflow)?.[1], 'ubuntu-latest');
});

// The light pool: a fake runner list (GET /repos/{repo}/actions/runners) and a fetch that records its calls.
const runner = (name, label, status, busy) => ({ name, status, busy, labels: [{ name: 'self-hosted' }, { name: label }] });
const listing = (...runners) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, auth: init.headers.authorization }); return Response.json({ total_count: runners.length, runners }); } }; };
const lightPlan = () => jobsFor(['tools/entry/check.mjs', 'packages/form-rules/src/index.ts']).include;

test('light pool: soul-tools is the light job; an idle online souls-light runner takes it, and nothing else moves', async () => {
  assert.deepEqual(JOBS.filter(j => j.light).map(j => j.name), ['soul-tools']);
  const api = listing(runner('souls-light-1', LIGHT_LABEL, 'online', true), runner('souls-light-2', LIGHT_LABEL, 'online', false),
    runner('souls-light-3', LIGHT_LABEL, 'offline', false), runner('souls-timed-1', 'souls-timed', 'online', false));
  const got = await idleRunners({ repo: 'o/r', token: 'tok-FAKE', fetchImpl: api.fetchImpl });
  assert.deepEqual(got, { idle: 1, online: 2, why: '1 of 2 online souls-light runner(s) idle' });
  assert.deepEqual(api.calls, [{ url: 'https://api.github.com/repos/o/r/actions/runners?per_page=100', auth: 'Bearer tok-FAKE' }]);
  const before = lightPlan(), after = assignLight(before, got.idle);
  assert.deepEqual(after.map(j => [j.name, runnerFor(j)]), [['types-web', 'ubuntu-latest'], ['web', 'ubuntu-latest'], ['soul-tools', 'souls-light']]);
  // the same matrix entry apart from `runner`: the steps, which ci.yml picks by kind, are the same on either runner
  const { runner: label, ...rest } = after.find(j => j.name === 'soul-tools');
  assert.equal(label, 'souls-light');
  assert.deepEqual(rest, before.find(j => j.name === 'soul-tools'));
  // only light jobs take the light label; heavy jobs keep CI_HEAVY_RUNNER
  const full = assignLight(jobsFor(null).include, 5);
  assert.deepEqual(full.filter(j => j.runner).map(j => j.name), ['soul-tools']);
  assert.equal(runnerFor(full.find(j => j.name === 'server-0'), 'souls-ci'), 'souls-ci');
});

test('light pool: busy or offline runners, none labelled, or no token leave every job hosted', async () => {
  for (const runners of [[runner('souls-light-1', LIGHT_LABEL, 'online', true), runner('souls-light-2', LIGHT_LABEL, 'offline', false)], [runner('souls-ci-1', 'souls-ci', 'online', false)], []]) {
    const got = await idleRunners({ repo: 'o/r', token: 'tok-FAKE', fetchImpl: listing(...runners).fetchImpl });
    assert.equal(got.idle, 0, JSON.stringify(runners));
    assert.ok(assignLight(lightPlan(), got.idle).every(j => runnerFor(j) === 'ubuntu-latest'));
  }
  const api = listing(runner('souls-light-1', LIGHT_LABEL, 'online', false));
  assert.deepEqual(await idleRunners({ repo: 'o/r', token: '', fetchImpl: api.fetchImpl }), { idle: 0, online: 0, why: 'no runner token (MERGE_TRAIN_TOKEN unset)' });
  assert.equal(api.calls.length, 0, 'no token: the API is not asked');
});

test('light pool: an API failure (refused, server error, network error, timeout, unreadable) falls back to hosted', async () => {
  const cases = [
    [async () => new Response('{"message":"Resource not accessible by personal access token"}', { status: 403 }), /^runners not readable with MERGE_TRAIN_TOKEN \(needs Administration: Read\)$/],
    [async () => new Response('', { status: 401 }), /HTTP 401/],
    [async () => new Response('', { status: 502 }), /HTTP 502/],
    [async () => { throw new TypeError('fetch failed'); }, /runner list failed: fetch failed/],
    [(url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), /timed out/],
    [async () => new Response('not json'), /runner list failed/],
    [async () => Response.json({ message: 'odd' }), /unreadable answer/],
  ];
  for (const [fetchImpl, why] of cases) {
    const got = await idleRunners({ repo: 'o/r', token: 'tok-FAKE', fetchImpl, timeoutMs: 50 });
    assert.equal(got.idle, 0);
    assert.match(got.why, why);
    assert.ok(!got.why.includes('tok-FAKE'), 'the token never reaches the log');
    assert.ok(assignLight(lightPlan(), got.idle).every(j => runnerFor(j) === 'ubuntu-latest'));
  }
});

test('light pool: the scope command with no token runs every job hosted and says why', () => {
  const env = { ...process.env, MERGE_TRAIN_TOKEN: '', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' };
  const out = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./ci-scope.mjs', import.meta.url)), '--files', 'tools/entry/check.mjs', '--event', 'pull_request', '--labels', '["ci:run"]'], { encoding: 'utf8', env }));
  assert.ok(out.matrix.includes('soul-tools'));
  assert.deepEqual(out.light.placed, []);
  assert.match(out.light.why, /no runner token/);
});

test('ci.yml: the runner reaches only runs-on; the scope step passes the runner token', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  assert.equal(workflow.match(/matrix\.runner/g)?.length, 1, 'matrix.runner is read once, in runs-on, and by no step');
  assert.match(workflow, /^          MERGE_TRAIN_TOKEN: \$\{\{ secrets\.MERGE_TRAIN_TOKEN \}\}$/m);
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

test('pushes to main and manual runs check everything; pull request runs stay scoped', () => {
  const script = fileURLToPath(new URL('./ci-scope.mjs', import.meta.url));
  const plan = event => JSON.parse(execFileSync(process.execPath, [script, '--files', 'docs/a.md', '--event', event], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } }));
  assert.deepEqual(FULL_EVENTS, ['push', 'workflow_dispatch']);
  for (const event of FULL_EVENTS) {
    const p = plan(event);
    assert.equal(p.scope, 'full', event);
    assert.deepEqual(p.matrix, JOBS.map(j => j.name), event);
    assert.equal(p.smoke, 'true', event);
  }
  for (const event of ['pull_request', 'merge_group']) {
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
  assert.ok(out.selected.includes('server-0'), 'the deferred jobs are still reported');
  const inside = run(...server, '--event', 'pull_request', '--draft', 'false', '--labels', '["ci:run"]');
  assert.deepEqual([inside.any, inside.smoke, inside.deferred], ['true', 'true', 'false']);
  assert.deepEqual(inside.matrix, names(['apps/server/src/world.ts']));
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

// Low-risk paths (Gene, 17 Nov): a change confined to entry, content, form-rules, docs or changelog fragments runs no
// server, smoke (e2e), walk (packages) or bundle (types-web) job; it keeps repo (always), the entry tests and the
// form-rules tests (soul-tools).
const SKIPPED = JOBS.filter(j => j.kind === 'server' || ['latency', 'packages', 'types-web', 'launcher', 'native', 'client-cli', 'soul-actions'].includes(j.name)).map(j => j.name);
const LOW = ['tools/entry/check.mjs', 'content/kinds/seating/bench.json', 'content/asks/a.json', 'content/moves/a.json', 'packages/form-rules/cases/kettle.json', 'docs/testing.md', 'changes/a-fragment.md', 'README.md'];

test('low-risk: a diff confined to the allowlist runs soul-tools only: no server, smoke, walk or bundle job', () => {
  // with no server test reading these paths (the server readers are tested below)
  const plan = jobsFor(LOW, undefined, { readers: () => [] });
  assert.equal(plan.scope, 'low-risk');
  assert.deepEqual(plan.include.map(j => j.name), ['soul-tools']);
  assert.equal(smokeFor(LOW), false);
  for (const f of LOW) assert.deepEqual(jobsFor([f], undefined, { readers: () => [] }).include.map(j => j.name).filter(n => SKIPPED.includes(n)), [], f);
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

test('low-risk: a change to anything eden.mjs inlines runs the inline check (soul-tools), form-rules source alone included', async () => {
  const { MODULES } = await import('../../tools/world-launcher/soul/inline.mjs');
  const inputs = MODULES.map(([f]) => new URL(f, new URL('../../tools/world-launcher/soul/', import.meta.url)).pathname.slice(new URL('../../', import.meta.url).pathname.length));
  assert.ok(inputs.includes('packages/form-rules/src/rules.ts'));
  for (const f of [...inputs, 'tools/world-launcher/soul/inline.mjs']) assert.ok(names([f]).includes('soul-tools'), f);
  assert.equal(jobsFor(['packages/form-rules/src/rules.ts']).scope, 'low-risk');
  assert.ok(!names(['packages/form-rules/src/rules.ts']).includes('launcher'), 'the launcher job stays skipped');
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/ci.yml', import.meta.url)), 'utf8');
  const tools = workflow.slice(workflow.indexOf('            soul-tools)'), workflow.indexOf('            server)'));
  assert.match(tools, /^\s*node tools\/world-launcher\/soul\/inline\.mjs --check$/m);
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
  for (const event of ['pull_request', 'merge_group']) {
    const empty = run('--files', '', '--event', event, '--labels', '["ci:run"]');
    assert.deepEqual([empty.scope, empty.matrix, empty.smoke], ['full', JOBS.map(j => j.name), 'true'], event);
  }
});

test('low-risk: a merge group of two allowlist PRs is scoped; one with a server PR in it runs everything', () => {
  const a = ['tools/entry/format.mjs', 'changes/sa-f6c.md'], b = ['content/kinds/kitchen/kettle.json', 'packages/form-rules/cases/kettle.json', 'changes/sa-d3.md'];
  const group = run('--files', [...a, ...b].join(','), '--event', 'merge_group');
  assert.deepEqual([group.scope, group.matrix, group.smoke, group.deferred, group.any], ['low-risk', names([...a, ...b]), 'false', 'false', 'true']);
  assert.deepEqual(group.matrix.filter(n => n !== 'soul-tools'), serverReaders(), 'beside soul-tools, only the server readers');
  const mixed = run('--files', [...a, ...b, 'apps/server/src/world.ts', 'changes/server.md'].join(','), '--event', 'merge_group');
  assert.deepEqual([mixed.scope, mixed.matrix, mixed.smoke], ['full', JOBS.map(j => j.name), 'true']);
});

// The gap #3061 left (Gene, 18 Nov): the server's forms adapter reads content/kinds, content/moves and
// packages/form-rules/cases/kinds, and imports packages/form-rules/src; its tests load kinds with tools/entry. A low-risk
// change there runs the server shard(s) holding a test that reads them. The content fast lane is a fixed list.
const repo = p => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const soulToolsBranch = () => { const w = readFileSync(repo('.github/workflows/ci.yml'), 'utf8'); return w.slice(w.indexOf('            soul-tools)'), w.indexOf('            server)')); };
const fakeReaders = () => ['server-3'];
const lane = (files, readers = fakeReaders) => jobsFor(files, undefined, { readers }).include.map(j => j.name).sort();
const BATTERY = JOBS.map(j => j.name).sort();
const CONTENT_DIFF = ['content/kinds/kitchen/kettle.json', 'content/kinds/kitchen/teapot.json', 'packages/form-rules/cases/kettle.json', 'changes/sa-kitchen.md'];

test('serverReaders: the shards holding a server test that reads content, cases, form-rules or tools/entry, found in the tree', () => {
  const all = ['a.test.ts', 'b.test.ts', 'god/forms-adapter.test.ts', 'owner-response-milestones.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'f.test.ts'];
  const src = { 'god/forms-adapter.test.ts': "import {loadEntries} from '../../../../tools/entry/look.mjs'; loadEntries(resolve(ROOT, 'content/kinds'))", 'owner-response-milestones.test.ts': "tags: ['entry']" };
  const got = serverReaders({ files: all, read: f => src[f] ?? 'nothing here' });
  assert.ok(got.includes('latency'), 'the latency file is its own job');
  assert.equal(got.length, 2);
  assert.match(got.find(n => n !== 'latency'), /^server-\d$/);
  assert.deepEqual(serverReaders({ files: all, read: () => 'nothing here' }), []);
  for (const marker of ['content/kinds', 'content/moves', 'packages/form-rules/cases/kinds', '@souls/form-rules', 'tools/entry/load.mjs', "from './forms-adapter.ts'", "tags: ['entry']"]) assert.match(marker, SERVER_READER, marker);
  for (const other of ['edge/content/eden-library-catalogue', "mood: 'content'", "room('entry'"]) assert.doesNotMatch(other, SERVER_READER, other);
  // the real tree: every reader found is a server job that exists
  for (const n of serverReaders()) assert.ok(JOBS.some(j => j.name === n), n);
});

test('content lane: a content-only diff runs soul-tools and the server readers, nothing else, and the list is written out', () => {
  assert.equal(contentOnly(CONTENT_DIFF), true);
  assert.equal(jobsFor(CONTENT_DIFF, undefined, { readers: fakeReaders }).scope, 'content');
  assert.deepEqual(lane(CONTENT_DIFF), ['server-3', 'soul-tools']);
  assert.deepEqual(CONTENT_JOBS, ['soul-tools']);
  assert.deepEqual(CONTENT_WEB, [], 'apps/web reads neither content/kinds nor form-rules cases');
  assert.equal(smokeFor(CONTENT_DIFF), false);
  assert.deepEqual(lane(CONTENT_DIFF, () => []), ['soul-tools'], 'with no server reader in the tree, soul-tools alone');
  // never less than the low-risk rule picks for the same files
  for (const f of CONTENT_DIFF) {
    assert.ok(lowRisk([f]), f);
    for (const n of jobsFor(['docs/x.md', f], undefined, { readers: fakeReaders }).include.map(j => j.name)) assert.ok(lane(CONTENT_DIFF).includes(n), `${f}: ${n}`);
  }
  // the soul-tools job holds what the lane promises: entry tests, form-rules tests, the inline check
  const tools = soulToolsBranch();
  for (const t of ['tools/entry/*.test.mjs', 'packages/form-rules/src/*.test.ts', 'inline.mjs --check']) assert.ok(tools.includes(t), t);
  // not a content PR: a kind outside a family folder, form-rules source, the entry tools, moves, docs
  for (const f of ['content/kinds/chair.json', 'packages/form-rules/src/rules.ts', 'tools/entry/check.mjs', 'content/moves/sit.json', 'docs/a.md'])
    assert.equal(contentOnly([...CONTENT_DIFF, f]), false, f);
  assert.equal(contentOnly(['changes/a.md']), false, 'a fragment alone is not content, and runs no job');
  assert.deepEqual(lane(['changes/a.md']), []);
});

test('content lane: every launcher test that reads content/kinds, form-rules or tools/entry runs in soul-tools', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = repo('tools/world-launcher/');
  const readers = readdirSync(dir, { recursive: true }).filter(f => /\.test\.mjs$/.test(f) && !f.includes('node_modules'))
    .filter(f => /content\/kinds|form-rules|tools\/entry\//.test(readFileSync(dir + f, 'utf8'))).map(f => `tools/world-launcher/${f}`);
  assert.ok(readers.includes('tools/world-launcher/soul/can-i.test.mjs') && readers.includes('tools/world-launcher/soul/how.test.mjs'), readers.join());
  const tools = soulToolsBranch();
  for (const f of readers) assert.ok(tools.includes(f), `${f} reads a low-risk path but only the launcher job runs it`);
});

test('content lane: a cases-only diff is a content PR', () => {
  const cases = ['packages/form-rules/cases/kinds/tap.json', 'packages/form-rules/cases/kettle.json'];
  assert.equal(jobsFor(cases, undefined, { readers: fakeReaders }).scope, 'content');
  assert.deepEqual(lane(cases), ['server-3', 'soul-tools']);
  assert.deepEqual(lane([...cases, 'changes/cases.md']), ['server-3', 'soul-tools']);
});

test('form-rules source: soul-tools, the server readers, and the web jobs (apps/web imports it)', () => {
  const src = ['packages/form-rules/src/effects.ts', 'changes/effects.md'];
  assert.equal(jobsFor(src, undefined, { readers: fakeReaders }).scope, 'low-risk');
  assert.deepEqual(lane(src), ['server-3', 'soul-tools', 'types-web', 'web']);
  for (const f of ['tools/entry/look.mjs', 'content/moves/sit.json', 'content/asks/a.json']) assert.deepEqual(lane([f]), ['server-3', 'soul-tools'], f);
  for (const f of ['docs/testing.md', 'changes/a.md', 'README.md']) assert.ok(!lane([f]).includes('server-3'), f);
});

test('a mixed diff (content beside any other file) runs the full battery', () => {
  for (const f of ['apps/server/src/god/forms-adapter.ts', 'apps/web/src/gen-mesh/vocab-look.ts', 'tools/world-launcher/soul/can-i.mjs', 'content/tunes/tunes.json', '.github/scripts/ci-scope.mjs']) {
    assert.deepEqual(lane([...CONTENT_DIFF, f]), BATTERY, f);
    assert.equal(jobsFor([...CONTENT_DIFF, f]).scope, 'full', f);
  }
  assert.equal(smokeFor([...CONTENT_DIFF, 'apps/server/src/god/forms-adapter.ts']), true);
});

test('merge train: content PRs count as low-risk, so they never wait on MIXED_CAP', () => {
  const train = readFileSync(repo('.github/scripts/merge-train.mjs'), 'utf8');
  assert.match(train, /import \{[^}]*\blowRisk\b[^}]*\} from '\.\/ci-scope\.mjs'/);
  assert.match(train, /if \(!lowRisk\(files\)\) \{\s*mixedQueued/);
  for (const f of CONTENT_DIFF) assert.ok(LOW_RISK.test(f), f);
  assert.equal(lowRisk(CONTENT_DIFF), true);
});

