import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, claudeAuthored, globRegExp, parseList } from './codex-files.mjs';

const rules = parseList(readFileSync(new URL('../../tools/ci/codex-files.txt', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('./codex-files.mjs', import.meta.url));

test('globRegExp: * stays in a segment, ** crosses them, {a,b} picks one; dots are literal', () => {
  assert.ok(globRegExp('a/*.ts').test('a/b.ts'));
  assert.ok(!globRegExp('a/*.ts').test('a/b/c.ts'));
  assert.ok(!globRegExp('a/*.ts').test('a/bxts'));
  assert.ok(globRegExp('a/**').test('a/b/c.rs'));
  assert.ok(globRegExp('a/**/c.rs').test('a/c.rs'));
  assert.ok(globRegExp('a/**/c.rs').test('a/b/d/c.rs'));
  assert.ok(globRegExp('x/{p,q-r}.ts').test('x/q-r.ts'));
  assert.ok(!globRegExp('x/{p,q-r}.ts').test('x/pq-r.ts'));
});

test('the checked-in list: each shared pose file fails; its tests, its neighbours and the carry files main owns do not', () => {
  const owned = [
    'mars/viewer/app/engine-view/humans.ts', 'mars/viewer/app/engine-view/posture-transition.ts',
    'mars/viewer/app/engine-view/activity-poses.ts', 'mars/viewer/app/engine-view/take-replay.ts',
    'apps/web/src/v2-engine/bridge.ts', 'apps/web/src/v2-engine/takes.ts', 'apps/web/src/v2-engine/take-gestures.ts',
  ];
  for (const file of owned) assert.equal(check({ files: [file], labels: [], rules, claude: true }).failing.length, 1, file);
  const free = [
    'mars/viewer/app/engine-view/posture.ts', 'apps/web/src/v2-engine/takes.test.ts', 'apps/web/src/v2-engine/other.ts',
    'v2/crates/replica/src/lib.rs', 'v2/crates/sim/src/stream/x.rs', 'apps/web/src/WorldEntityLayer.test.ts',
    // main's from 27 Nov: carrying and racks with their page and reader files
    'apps/web/src/v2-engine/take-parts.ts', 'apps/web/src/v2-engine/use-v2-souls.ts', 'apps/web/src/v2-engine/creator-kinds.ts',
    'apps/web/src/v2-engine/source/worker.ts', 'v2/crates/replica/src/stream/public.rs', 'apps/web/src/WorldEntityLayer.ts',
  ];
  for (const file of free) assert.deepEqual(check({ files: [file], labels: [], rules, claude: true }), { ok: true, exempt: '', failing: [], warnings: [] }, file);
});
  assert.equal(shared.ok, true);
  assert.deepEqual(shared.warnings.map(w => w.file), ['apps/web/src/WorldEntityLayer.ts']);
});

test('a lane PR (Claude trailer) touching takes.ts fails; a Codex PR with no label passes; codex:files-ok passes', () => {
  const files = ['apps/web/src/v2-engine/takes.ts', 'docs/x.md'];
  assert.equal(check({ files, labels: ['merge:ready'], rules, claude: true }).ok, false);
  assert.match(check({ files, labels: [], rules, claude: false }).exempt, /not a lane PR/);
  assert.match(check({ files, labels: ['codex:files-ok'], rules, claude: true }).exempt, /coordinator/);
});

test('claudeAuthored: any commit with a Co-Authored-By: Claude trailer, any model or case; other co-authors do not count', () => {
  assert.equal(claudeAuthored(['fix: a\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>']), true);
  assert.equal(claudeAuthored(['wip', 'fix: b\n\nco-authored-by: claude <x@y>']), true);
  assert.equal(claudeAuthored(['fix: c\n\nCo-Authored-By: Someone <a@b>', 'mentions Claude in the body']), false);
  assert.equal(claudeAuthored([]), false);
});

test('the command exits 1 on a lane PR hit and 0 with the override or for Codex, printing the file', () => {
  const run = (...args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' } }) }; }
    catch (e) { return { code: e.status, out: e.stdout }; }
  };
  const hit = run('--files', 'apps/web/src/v2-engine/takes.ts', '--claude');
  assert.equal(hit.code, 1);
  assert.match(hit.out, /takes\.ts/);
  assert.equal(run('--files', 'apps/web/src/v2-engine/takes.ts', '--claude', '--labels', 'codex:files-ok').code, 0);
  assert.equal(run('--files', 'apps/web/src/v2-engine/takes.ts').code, 0, 'a Codex PR');
  assert.equal(run('--files', 'docs/a.md').code, 0);
});
