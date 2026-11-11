import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkRenames, fileStep, main, tapTitle, testTitles } from './gate-renames.mjs';

const Q = { schemaVersion: 1, entries: [], scopeExclusions: [{ step: 'V7', owner: 'o', reason: 'r' }, { step: 'V8', owner: 'o', reason: 'r' }] };
const R = (...entries) => ({ schemaVersion: 1, entries });
const ren = (step, from, to, pr = '#9') => ({ step, from, to, reason: 'fixture rename', pr });
const src = body => `import test, { describe, it } from 'node:test';\n${body}\n`;
const WEB = 'apps/web/src/widget.test.ts';

test('fileStep follows the gate commands in one-validation.sh; files the gate does not run are ignored', () => {
  const cases = {
    'apps/server/src/a.test.ts': 'V5-server-full', 'apps/server/src/god/nested/b.test.ts': 'V5-server-full',
    'apps/web/src/x.test.tsx': 'V4-web', 'apps/web/test/y.test.ts': 'V4-web',
    'packages/kernel/src/k.test.ts': 'V3-packages', 'packages/world-compiler/src/core-kit/c.test.ts': 'V3-packages',
    'mars/viewer/engine/test/m.test.ts': 'V3-mars-engine', 'tools/client-eval/c.test.mjs': 'V3-client-cli',
    'tools/world-launcher/l.test.mjs': 'V3-launcher-unit', 'tools/test-harness/h.test.mjs': 'V3-harness',
    'tools/test-harness/walk/walk-gate.test.mjs': 'V3-walk', 'tools/test-harness/bundle-budget/budget.test.mjs': 'V3-bundle',
  };
  for (const [path, step] of Object.entries(cases)) assert.equal(fileStep(path)?.step, step, path);
  assert.equal(fileStep('packages/kernel/src/k.test.ts').prefix, 'kernel');
  for (const path of ['packages/engine-mars/src/project/p.test.ts', 'packages/client/src/c.test.ts', 'tools/soul-actions/a.test.mjs',
    'tools/god-skill/e2e/scenarios.mjs', 'tools/world-launcher/soul/s.test.mjs', 'apps/server/src/a.ts', 'docs/x.md', 'tools/test-harness/walk/other.test.mjs', 'tools/edge-skill/e.test.mjs'])
    assert.equal(fileStep(path), null, path);
});

test('testTitles reads literal titles, suites, options and skips; strings and comments never count; run-time titles are counted', () => {
  const r = testTitles(src(`
// test('in a comment', () => {})
const s = "test('in a string')";
describe('a suite', () => {
  it('a \\'quoted\\' test #1', () => {});
  test(\`a template title\`, { timeout: 5 }, () => {});
  test.skip('skipped', () => {});
  test('opt skip', { skip: true }, () => {});
  test('conditional', { skip: process.env.X !== '1' }, () => {});
  test('not skipped', { skip: false }, () => {});
  test.todo('later');
  test(\`dynamic \${1 + 1}\`, () => {});
  for (const n of [1, 2]) test(name(n), () => {});
  test('outer', async t => { await t.test('sub', () => {}); });
  if (/x/.test('not a title')) FIXED.test('nor this');
});`));
  const by = Object.fromEntries(r.calls.map(c => [c.title, c]));
  assert.deepEqual(Object.keys(by), ['a suite', "a 'quoted' test #1", 'a template title', 'skipped', 'opt skip', 'conditional', 'not skipped', 'later', 'outer', 'sub']);
  assert.equal(by['a suite'].kind, 'suite'); assert.equal(by.sub.kind, 'test');
  assert.deepEqual(['skipped', 'opt skip', 'later'].map(t => by[t].skip), ['always', 'always', 'always']);
  assert.equal(by.conditional.skip, 'conditional'); assert.equal(by['not skipped'].skip, 'none'); assert.equal(by['a template title'].skip, 'none');
  assert.equal(r.dynamic, 2);
  assert.equal(testTitles("test('no import', () => {})").unread, true);
  assert.equal(tapTitle("a #1 \\ b"), 'a \\#1 \\\\ b');
});

test('a rename with its entry passes; without one it fails naming the file, the title and the step', () => {
  const files = [{ path: WEB, base: src("test('old name', () => {}); test('kept', () => {});"), head: src("test('new name', () => {}); test('kept', () => {});") }];
  const bad = checkRenames(files, R(), Q);
  assert.equal(bad.ok, false); assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0].why, /"old name" \(apps\/web\/src\/widget\.test\.ts\) ran in V4-web/);
  const good = checkRenames(files, R(ren('V4-web', 'old name', 'new name')), Q);
  assert.equal(good.ok, true, JSON.stringify(good.problems)); assert.deepEqual(good.declared.map(d => d.title), ['old name']); assert.deepEqual(good.notes, []);
  // the entry must name the same step, and a nested id matches by its last segment
  assert.equal(checkRenames(files, R(ren('V5-server-full', 'old name', 'new name')), Q).ok, false);
  assert.equal(checkRenames(files, R(ren('V4-web', 'outer > old name', 'outer > new name')), Q).ok, true);
  // a typo in `to` is reported
  assert.match(checkRenames(files, R(ren('V4-web', 'old name', 'nwe name')), Q).notes[0], /"nwe name".*not a test title/);
});

test('a moved test is not removed; a deleted file needs every title; a package entry needs its package prefix', () => {
  const moved = [{ path: WEB, base: src("test('moves', () => {});"), head: src('') }, { path: 'apps/web/src/other.test.ts', base: null, head: src("test('moves', () => {});") }];
  assert.equal(checkRenames(moved, R(), Q).ok, true);
  const deleted = checkRenames([{ path: WEB, base: src("test('a', () => {}); test('b', () => {});"), head: null }], R(ren('V4-web', 'a', 'x')), Q);
  assert.deepEqual(deleted.problems.map(p => p.title), ['b']);
  const pkg = [{ path: 'packages/kernel/src/k.test.ts', base: src("test('k old', () => {});"), head: src("test('k new', () => {});") }];
  assert.equal(checkRenames(pkg, R(ren('V3-packages', 'k old', 'k new')), Q).ok, false);
  assert.equal(checkRenames(pkg, R(ren('V3-packages', 'kernel > k old', 'kernel > k new')), Q).ok, true);
  assert.equal(checkRenames(pkg, R(ren('V3-packages', 'music > k old', 'music > k new')), Q).ok, false);
});

test('a renamed suite needs entries under it; run-time titles are reported as unchecked and never fail', () => {
  const suite = [{ path: WEB, base: src("describe('old suite', () => { it('t', () => {}); });"), head: src("describe('new suite', () => { it('t', () => {}); });") }];
  const r = checkRenames(suite, R(), Q);
  assert.equal(r.problems[0].kind, 'suite-gone'); assert.match(r.problems[0].why, /every test inside it changed id/);
  assert.equal(checkRenames(suite, R(ren('V4-web', 'old suite > t', 'new suite > t')), Q).ok, true);
  const dyn = checkRenames([{ path: WEB, base: src('test(`case ${n}`, () => {});'), head: src('') }], R(), Q);
  assert.equal(dyn.ok, true); assert.match(dyn.unchecked[0].why, /built at run time/);
});

test('a literal title that becomes a run-time one (a table loop) is unchecked, not failed (review)', () => {
  const files = [{ path: WEB, base: src("test('case a', () => {}); test('case b', () => {});"), head: src("for (const c of ['a', 'b']) test(`case ${c}`, () => {});") }];
  const r = checkRenames(files, R(), Q);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.unchecked.filter(u => u.side === 'base').map(u => u.why.split('"')[1]), ['case a', 'case b']);
  // a static file elsewhere in the step does not hide a removal in a file with no run-time titles... unless the step's head has them
  const stat = [{ path: WEB, base: src("test('gone', () => {});"), head: src('') }];
  assert.equal(checkRenames(stat, R(), Q).ok, false);
  // `{ skip }` shorthand is a conditional skip, noted, never failed
  const sh = checkRenames([{ path: WEB, base: src("test('a', () => {});"), head: src("const skip = !process.env.X; test('a', { skip }, () => {});") }], R(), Q);
  assert.equal(sh.ok, true); assert.match(sh.notes[0], /conditional skip/);
});

test('a newly unconditional skip or todo needs a quarantine entry; an existing or conditional one does not', () => {
  const skipped = [{ path: WEB, base: src("test('a', () => {});"), head: src("test('a', { skip: 'flaky' }, () => {});") }];
  const r = checkRenames(skipped, R(), Q);
  assert.equal(r.problems[0].kind, 'skip'); assert.match(r.problems[0].why, /newly skipped or todo in V4-web/);
  const q = { ...Q, entries: [{ step: 'V4-web', id: 'a', status: 'skip', reason: 'known flake', owner: 'fixture' }] };
  assert.equal(checkRenames(skipped, R(), q).ok, true);
  assert.equal(checkRenames([{ path: WEB, base: src("test.skip('a', () => {});"), head: src("test.skip('a', () => {}); test('b', () => {});") }], R(), Q).ok, true);
  const cond = checkRenames([{ path: WEB, base: src("test('a', () => {});"), head: src("test('a', { skip: !process.env.X }, () => {});") }], R(), Q);
  assert.equal(cond.ok, true); assert.match(cond.notes[0], /conditional skip/);
});

test('main compares the merge base with the head in git, reads the head lists, and does nothing without a base', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-renames-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = m => { g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m); return g('rev-parse', 'HEAD'); };
  g('init', '-q', '-b', 'main');
  put(WEB, src("test('old name', () => {});")); put('tools/test-harness/quarantine.json', JSON.stringify(Q));
  const base = commit('base');
  put(WEB, src("test('new name', () => {});")); const bare = commit('rename');
  const lines = [], cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(main(['--base', base, '--head', bare], l => lines.push(l)), 1);
    assert.match(lines.join('\n'), /PROBLEM: "old name"/);
    put('tools/test-harness/renames.json', JSON.stringify(R(ren('V4-web', 'old name', 'new name')))); const listed = commit('list it');
    assert.equal(main(['--base', base, '--head', listed], () => {}), 0);
    lines.length = 0;
    assert.equal(main(['--base', '0'.repeat(40), '--head', listed], l => lines.push(l)), 0); assert.match(lines[0], /no usable base/);
  } finally { process.chdir(cwd); }
});
