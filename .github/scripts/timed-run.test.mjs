// timed-run.mjs (#1943): the per-command allowlist, the argument check, the start-load gate and the scrubbed staging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInputs, checkArgs, commandLine, parseCpuList, parseProcStat, loadFacts, stage, snapshot, newEntries, globTest, LOAD_GATE } from './timed-run.mjs';

const ENV = { INPUT_REF: 'main', INPUT_COMMAND: 'walk', INPUT_REPEATS: '1', INPUT_ARGS: '' };

test('inputs: ref, command and repeats are checked before anything runs', () => {
  assert.deepEqual(parseInputs(ENV), { ref: 'main', command: 'walk', repeats: 1, args: [] });
  assert.equal(parseInputs({ ...ENV, INPUT_REF: 'agent/1943-timed-run', INPUT_COMMAND: 'eval-scripted', INPUT_REPEATS: '3' }).repeats, 3);
  for (const [k, v] of [['INPUT_REF', 'feature/x'], ['INPUT_REF', 'agent/../main'], ['INPUT_REF', '$(id)'], ['INPUT_COMMAND', 'gate'], ['INPUT_COMMAND', 'walk;id'],
    ['INPUT_COMMAND', ''], ['INPUT_REPEATS', '0'], ['INPUT_REPEATS', '4'], ['INPUT_REPEATS', '2 x']])
    assert.throws(() => parseInputs({ ...ENV, [k]: v }), new RegExp(`input ${k.slice(6).toLowerCase()}=`), `${k}=${v}`);
});

test('args: only each command\'s own allowlisted flags, with checked values, once each', () => {
  assert.deepEqual(checkArgs('walk', ' --world fuzz,bench-hamlet '), ['--world', 'fuzz,bench-hamlet']);
  assert.deepEqual(checkArgs('eval-scripted', '--items bench-sit,music --warm-sec 40'), ['--items', 'bench-sit,music', '--warm-sec', '40']);
  for (const [c, a] of [['walk', '--write'], ['walk', '--from x'], ['walk', '--world nowhere'], ['walk', '--world fuzz,fuzz'], ['walk', '--world fuzz --world fuzz'], ['walk', '--world'],
    ['walk', '--items a'], ['eval-scripted', '--seat tools/playtest/eval/seats/claude-sonnet.json'], ['eval-scripted', '--max-usd 1'], ['eval-scripted', '--out /x'],
    ['eval-scripted', '--world https://example.org'], ['eval-scripted', '--items A;B'], ['eval-scripted', '--warm-sec 0'], ['eval-scripted', '--warm-sec 900'], ['eval-scripted', 'x --items a']])
    assert.throws(() => checkArgs(c, a), /input args/, `${c} ${a}`);
  assert.throws(() => parseInputs({ ...ENV, INPUT_ARGS: '--seat x' }), /not allowed for walk/);
});

test('command line: walk once per repeat; the eval runs its own repeats with a scripted seat, on the given port', () => {
  assert.deepEqual(commandLine(parseInputs({ ...ENV, INPUT_ARGS: '--world fuzz' }), { out: 'o', port: 1 }), ['tools/test-harness/walk/walk.mjs', '--world', 'fuzz']);
  const e = commandLine(parseInputs({ ...ENV, INPUT_COMMAND: 'eval-scripted', INPUT_REPEATS: '2' }), { out: 'o', port: 4321 });
  assert.deepEqual(e, ['tools/playtest/eval/soul-eval.mjs', 'run', '--repeats', '2', '--out', join('o', 'eval'), '--port', '4321']);
  assert.ok(!e.includes('--seat') && !e.includes('--max-usd'));
});

test('start load: the runner\'s own cores against the gate, the whole machine recorded beside them', () => {
  assert.deepEqual(parseCpuList('0-3,8,10-11'), [0, 1, 2, 3, 8, 10, 11]);
  // user nice system idle iowait irq softirq steal
  const s = (rows) => parseProcStat(`cpu  0 0 0 0 0 0 0 0\n${rows.map(([b, i], c) => `cpu${c} ${b} 0 0 ${i} 0 0 0 0 0 0`).join('\n')}\nintr 1`);
  const a = s([[0, 0], [0, 0], [0, 0], [0, 0]]);
  const quietOwn = loadFacts(a, s([[10, 90], [10, 90], [100, 0], [100, 0]]), [0, 1]);
  assert.deepEqual([quietOwn.ownCores, quietOwn.ownBusy, quietOwn.machineCores, quietOwn.machineBusy, quietOwn.overGate], [2, 0.1, 4, 0.55, false]);
  const busyOwn = loadFacts(a, s([[10, 90], [10, 90], [100, 0], [100, 0]]), [2, 3]);
  assert.deepEqual([busyOwn.ownBusy, busyOwn.overGate, busyOwn.gate], [1, true, LOAD_GATE]);
  assert.equal(loadFacts(a, s([[0, 100]]), [7]).overGate, true, 'own cores that cannot be read do not pass the gate');
});

test('stage: only allowlisted files, scrubbed; a Soul token refuses the whole upload', () => {
  const d = mkdtempSync(join(tmpdir(), 'timed-')), out = join(d, 'out'), dest = join(d, 'art');
  try {
    mkdirSync(join(out, 'eval', 'episodes', '001-x-r1', 'seat'), { recursive: true });
    writeFileSync(join(out, 'timed-run.json'), '{"ran":"/srv/runner-x/_work/souls/src"}');
    writeFileSync(join(out, 'eval', 'result.json'), '{"host":"buildbox"}');
    writeFileSync(join(out, 'eval', 'REPORT.md'), '# r');
    writeFileSync(join(out, 'eval', 'episodes', '001-x-r1', 'episode.json'), '{}');
    writeFileSync(join(out, 'eval', 'episodes', '001-x-r1', 'seat', '.eden-agent.json'), '{"token":"tok-FAKE-fixture-0000"}');
    const sw = { paths: [['/srv/runner-x/_work/souls/src', '.']], names: [['buildbox', '<host>']] };
    assert.deepEqual(stage({ out, dest, scrubWith: sw }), ['timed-run.json', 'eval/result.json', 'eval/REPORT.md']);
    assert.equal(readFileSync(join(dest, 'timed-run.json'), 'utf8'), '{"ran":"."}');
    assert.equal(readFileSync(join(dest, 'eval', 'result.json'), 'utf8'), '{"host":"<host>"}');
    assert.ok(!existsSync(join(dest, 'eval', 'episodes')));
    writeFileSync(join(out, 'eval', 'REPORT.md'), 'leaked tok-FAKE-fixture-0000');
    rmSync(dest, { recursive: true });
    assert.throws(() => stage({ out, dest, scrubWith: sw }), /eval\/REPORT\.md holds a Soul token/);
    assert.ok(!existsSync(dest), 'nothing is staged when one file holds a token');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('strays: entries new since the start snapshot, outside allowed dirs, runner installs and excluded globs', () => {
  const d = mkdtempSync(join(tmpdir(), 'timed-')), touch = (p) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), ''); };
  try {
    const opts = { allow: [join(d, 'home/per-run')], exclude: [join(d, 'tmp/clr-debug-pipe-*')], uid: process.getuid?.() ?? null };
    const roots = [join(d, 'home'), join(d, 'tmp'), join(d, 'missing')];
    touch('home/.cache/old');
    const before = snapshot(roots, opts);
    utimesSync(join(d, 'home/.cache/old'), new Date(), new Date());   // an old entry rewritten is not new
    for (const p of ['home/.cache/new', 'home/per-run/x', 'home/runner2/.runner', 'home/runner2/_work/y', 'tmp/clr-debug-pipe-1-in', 'tmp/stray/f']) touch(p);
    assert.deepEqual(newEntries(before, snapshot(roots, opts)), [join(d, 'home/.cache/new'), join(d, 'tmp/stray'), join(d, 'tmp/stray/f')]);
    assert.equal(snapshot(roots, { ...opts, uid: -1 }).length, 0, 'another account\'s entries are never listed');
    assert.ok(globTest('/tmp/cerr-*')('/tmp/cerr-ab12') && !globTest('/tmp/cerr-*')('/tmp/cerr-ab/agg.json') && !globTest('/tmp/cerr-*')('/tmpXcerr-a'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
