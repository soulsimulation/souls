import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_PIECES, SOUL_ACTIONS_PIECES, SUITES, assertExactlyOnce, pieceFiles, pieces, suiteDurations, suiteTestFiles } from './test-pieces.mjs';
import { JOBS, jobsFor } from './ci-scope.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The globs each suite's single job ran before the split, expanded by the shell, independently of the module's listing.
const GLOBS = { launcher: 'tools/world-launcher/*.test.mjs tools/world-launcher/soul/*.test.mjs', 'soul-actions': 'tools/soul-actions/*.test.mjs' };
const globbed = (globs, cwd = ROOT) => execFileSync('bash', ['-c', `LC_ALL=C; shopt -s nullglob; printf '%s\\n' ${globs}`], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
// The command each suite's job ran before the split, now run once per piece (ci.yml).
const RUN = { launcher: 'node --test --test-concurrency=1 $files', 'soul-actions': 'node --test --test-concurrency=4 $files' };

test('the suites and their piece counts are the ones ci-scope and the release gate read', () => {
  assert.deepEqual(Object.keys(SUITES), Object.keys(GLOBS));
  assert.equal(SUITES.launcher.pieces, LAUNCHER_PIECES); assert.equal(SUITES['soul-actions'].pieces, SOUL_ACTIONS_PIECES);
  const src = readFileSync(join(ROOT, '.github/scripts/test-pieces.mjs'), 'utf8');
  for (const name of ['LAUNCHER_PIECES', 'SOUL_ACTIONS_PIECES']) assert.match(src, new RegExp(`^export const ${name} = \\d+;$`, 'm'), `${name} stays a literal`);
});

for (const suite of Object.keys(SUITES)) {
  test(`${suite}: every test file is in exactly one piece: the union of the pieces is the shell glob, with no duplicates`, () => {
    const all = globbed(GLOBS[suite]), n = SUITES[suite].pieces;
    assert.ok(all.length > 50, `${all.length} ${suite} test files`);
    assert.deepEqual(suiteTestFiles(suite, ROOT), all, 'the module lists what the globs expand to');
    const plan = Array.from({ length: n }, (_, i) => pieceFiles(suite, i, { all: suiteTestFiles(suite, ROOT) })), flat = plan.flat();
    assert.equal(new Set(flat).size, flat.length, 'no file in two pieces');
    assert.deepEqual([...flat].sort(), [...all].sort(), 'no file left out');
    for (const p of plan) assert.ok(p.length > 0, 'no empty piece');
  });

  test(`${suite}: CI runs every piece wherever it ran the old job, each with the old command on its own files`, () => {
    const jobs = JOBS.filter(j => j.kind === suite), n = SUITES[suite].pieces;
    assert.deepEqual(jobs.map(j => [j.name, j.piece]), Array.from({ length: n }, (_, i) => [`${suite}-${i}`, i]));
    for (const files of [null, [], ['package.json'], ['.github/workflows/ci.yml'], [`${SUITES[suite].dirs[0]}/x.test.mjs`]]) {
      assert.deepEqual(jobsFor(files).include.filter(j => j.kind === suite).map(j => j.name), jobs.map(j => j.name), JSON.stringify(files));
    }
    assert.deepEqual(jobsFor(['docs/testing.md']).include.filter(j => j.kind === suite), []);
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /TEST_PIECE: \$\{\{ matrix\.piece \}\}/);
    assert.ok(ci.includes(`files=$(node .github/scripts/test-pieces.mjs ${suite} "$TEST_PIECE")\n`), 'the job asks for its piece');
    const branch = ci.slice(ci.indexOf(`            ${suite})`)), end = branch.indexOf(';;');
    assert.ok(branch.slice(0, end).includes(`files=$(node .github/scripts/test-pieces.mjs ${suite} "$TEST_PIECE")\n              ${RUN[suite]}\n`), `${suite} runs ${RUN[suite]}`);
    assert.ok(!branch.slice(0, end).includes(`${RUN[suite].replace(' $files', '')} ${GLOBS[suite].split(' ')[0]}`), 'the job no longer runs the whole glob');
  });

  test(`${suite}: balanced by measured time, deterministic, most files measured`, t => {
    const all = suiteTestFiles(suite, ROOT), d = suiteDurations(suite), plan = pieces(all, SUITES[suite].pieces, d);
    assert.deepEqual(plan, pieces(all, SUITES[suite].pieces, d), 'deterministic');
    const measured = all.filter(f => Number.isFinite(d[f])).length;
    assert.ok(measured / all.length > 0.8, `${measured}/${all.length} files measured`);
    t.diagnostic(plan.map((p, i) => `${suite}-${i}: ${p.files.length} files, ${p.seconds} s`).join('; '));
  });
}

test('a new, unmeasured test file lands in a piece; a plan that drops or repeats a file fails closed', t => {
  const root = mkdtempSync(join(tmpdir(), 'test-pieces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const f of ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'helper.mjs', 'soul/d.test.mjs', 'soul/new-file.test.mjs', 'soul/deep/e.test.mjs']) {
    mkdirSync(join(root, 'tools/world-launcher', f, '..'), { recursive: true }); writeFileSync(join(root, 'tools/world-launcher', f), '');
  }
  const all = suiteTestFiles('launcher', root), seconds = { 'tools/world-launcher/a.test.mjs': 100, 'tools/world-launcher/b.test.mjs': 1, 'tools/world-launcher/soul/d.test.mjs': 1 };
  assert.deepEqual(all, globbed(GLOBS.launcher, root), 'helpers and nested directories are not test files, as with the globs');
  const flat = [0, 1, 2].flatMap(i => pieceFiles('launcher', i, { all, n: 3, seconds }));
  assert.deepEqual(flat.sort(), all, 'the new file is assigned without being listed anywhere');
  const plan = pieces(all, 3, seconds);
  assert.deepEqual(plan.find(p => p.files.includes('tools/world-launcher/a.test.mjs')).files, ['tools/world-launcher/a.test.mjs'], 'the heaviest file gets a piece to itself');
  assert.throws(() => assertExactlyOnce(all, [{ files: plan[0].files }, { files: plan[1].files }]), /missing \[/);
  assert.throws(() => assertExactlyOnce(all, [...plan, { files: [plan[0].files[0]] }]), /twice \[tools/);
  assert.throws(() => assertExactlyOnce(all, [...plan, { files: ['tools/world-launcher/gone.test.mjs'] }]), /unknown \[tools/);
  assert.throws(() => pieceFiles('launcher', 3, { all, n: 3, seconds }), /Invalid piece/);
  assert.throws(() => pieceFiles('launcher', -1, { all, n: 3, seconds }), /Invalid piece/);
  assert.throws(() => pieces(all.slice(0, 2), 3, seconds), /Empty piece/);
  assert.throws(() => suiteTestFiles('nope', root), /Unknown test suite/);
});

test('the CLI prints one piece; an unknown suite or out-of-range piece fails the job instead of running nothing', () => {
  const cli = args => execFileSync(process.execPath, ['.github/scripts/test-pieces.mjs', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.deepEqual(cli(['soul-actions', '0']).split('\n').filter(Boolean), pieceFiles('soul-actions', 0, { all: suiteTestFiles('soul-actions', ROOT) }));
  for (const bad of [['launcher', String(LAUNCHER_PIECES)], ['launcher', ''], ['launcher', 'x'], ['nope', '0'], ['soul-actions']]) {
    assert.throws(() => cli(bad), bad.join(' '));
  }
});
