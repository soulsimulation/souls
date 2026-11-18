import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_PIECES, assertExactlyOnce, launcherPieceFiles, launcherPieces, launcherTestDurations, launcherTestFiles } from './launcher-test-files.mjs';
import { JOBS, jobsFor } from './ci-scope.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The globs the single launcher job ran before the split, expanded by the shell, independently of the module's listing.
const GLOBS = 'tools/world-launcher/*.test.mjs tools/world-launcher/soul/*.test.mjs';
const globbed = (cwd = ROOT) => execFileSync('bash', ['-c', `LC_ALL=C; shopt -s nullglob; printf '%s\\n' ${GLOBS}`], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);

test('every launcher test file is in exactly one piece: the union of the pieces is the shell glob, with no duplicates', () => {
  const all = globbed();
  assert.ok(all.length > 100, `${all.length} launcher test files`);
  assert.deepEqual(launcherTestFiles(ROOT), all, 'the module lists what the globs expand to');
  const pieces = Array.from({ length: LAUNCHER_PIECES }, (_, i) => launcherPieceFiles(i, { all: launcherTestFiles(ROOT) })), flat = pieces.flat();
  assert.equal(new Set(flat).size, flat.length, 'no file in two pieces');
  assert.deepEqual([...flat].sort(), [...all].sort(), 'no file left out');
  for (const p of pieces) assert.ok(p.length > 0, 'no empty piece');
});

test('a new, unmeasured test file lands in a piece; a plan that drops or repeats a file fails closed', t => {
  const root = mkdtempSync(join(tmpdir(), 'launcher-pieces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const f of ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'helper.mjs', 'soul/d.test.mjs', 'soul/new-file.test.mjs', 'soul/deep/e.test.mjs']) {
    mkdirSync(join(root, 'tools/world-launcher', f, '..'), { recursive: true }); writeFileSync(join(root, 'tools/world-launcher', f), '');
  }
  const all = launcherTestFiles(root), seconds = { 'tools/world-launcher/a.test.mjs': 100, 'tools/world-launcher/b.test.mjs': 1, 'tools/world-launcher/soul/d.test.mjs': 1 };
  assert.deepEqual(all, globbed(root), 'helpers and nested directories are not test files, as with the globs');
  const flat = [0, 1, 2].flatMap(i => launcherPieceFiles(i, { all, pieces: 3, seconds }));
  assert.deepEqual(flat.sort(), all, 'the new file is assigned without being listed anywhere');
  assert.deepEqual(launcherPieces(all, 3, seconds).find(p => p.files.includes('tools/world-launcher/a.test.mjs')).files, ['tools/world-launcher/a.test.mjs'], 'the heaviest file gets a piece to itself');
  const plan = launcherPieces(all, 3, seconds);
  assert.throws(() => assertExactlyOnce(all, [{ files: plan[0].files }, { files: plan[1].files }]), /missing \[/);
  assert.throws(() => assertExactlyOnce(all, [...plan, { files: [plan[0].files[0]] }]), /twice \[tools/);
  assert.throws(() => assertExactlyOnce(all, [...plan, { files: ['tools/world-launcher/gone.test.mjs'] }]), /unknown \[tools/);
  assert.throws(() => launcherPieceFiles(3, { all, pieces: 3, seconds }), /Invalid launcher piece/);
  assert.throws(() => launcherPieceFiles(-1, { all, pieces: 3, seconds }), /Invalid launcher piece/);
  assert.throws(() => launcherPieces(all.slice(0, 2), 3, seconds), /Empty launcher piece/);
});

test('the CLI prints one piece; an out-of-range piece fails the job instead of running nothing', () => {
  const out = execFileSync(process.execPath, ['.github/scripts/launcher-test-files.mjs', '0'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  assert.deepEqual(out, launcherPieceFiles(0, { all: launcherTestFiles(ROOT) }));
  for (const bad of [String(LAUNCHER_PIECES), '', 'x']) {
    assert.throws(() => execFileSync(process.execPath, ['.github/scripts/launcher-test-files.mjs', bad], { cwd: ROOT, stdio: 'ignore' }), bad || 'empty');
  }
});

test('CI runs every piece wherever it ran the launcher job, and ci.yml runs the piece it is given', () => {
  const pieces = JOBS.filter(j => j.kind === 'launcher');
  assert.deepEqual(pieces.map(j => [j.name, j.piece]), Array.from({ length: LAUNCHER_PIECES }, (_, i) => [`launcher-${i}`, i]));
  for (const files of [null, [], ['tools/world-launcher/launcher.mjs'], ['tools/world-launcher/soul/eden.mjs'], ['package.json'], ['.github/workflows/ci.yml']]) {
    const picked = jobsFor(files).include.filter(j => j.kind === 'launcher').map(j => j.name);
    assert.deepEqual(picked, pieces.map(j => j.name), JSON.stringify(files));
  }
  for (const files of [['apps/web/src/main.ts'], ['docs/testing.md']]) assert.deepEqual(jobsFor(files).include.filter(j => j.kind === 'launcher'), [], JSON.stringify(files));
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /LAUNCHER_PIECE: \$\{\{ matrix\.piece \}\}/);
  assert.match(ci, /files=\$\(node \.github\/scripts\/launcher-test-files\.mjs "\$LAUNCHER_PIECE"\)\n\s+node --test --test-concurrency=1 \$files\n/);
});

test('balanced by measured time: most files measured, and the slowest piece under 10 minutes summed', t => {
  const all = launcherTestFiles(ROOT), d = launcherTestDurations(), pieces = launcherPieces(all);
  assert.deepEqual(pieces, launcherPieces(all), 'deterministic');
  const measured = all.filter(f => Number.isFinite(d[f])).length;
  assert.ok(measured / all.length > 0.8, `${measured}/${all.length} files measured`);
  const max = Math.max(...pieces.map(p => p.seconds));
  assert.ok(max < 10 * 60, `slowest piece ${max} s summed; add a piece or regenerate launcher-test-durations.json`);
  t.diagnostic(pieces.map((p, i) => `launcher-${i}: ${p.files.length} files, ${p.seconds} s`).join('; '));
});
