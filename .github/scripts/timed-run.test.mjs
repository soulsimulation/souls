// timed-run.mjs (#1943, #1970): the per-command allowlist, the argument check, the start-load gate, the scrubbed staging
// and the world/load core split; the counted scenario cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseInputs, checkArgs, commandLine, parseCpuList, parseProcStat, loadFacts, stage, snapshot, newEntries, sortStrays, globTest, splitCores, descendants, isWorld, SPLIT, LOAD_GATE, COUNTED, target, countedSteps } from './timed-run.mjs';

const ENV = { INPUT_REF: 'main', INPUT_COMMAND: 'walk', INPUT_REPEATS: '1', INPUT_ARGS: '' };

test('inputs: ref, command and repeats are checked before anything runs', () => {
  assert.deepEqual(parseInputs(ENV), { ref: 'main', command: 'walk', repeats: 1, args: [], runner: 'souls-timed' });
  assert.equal(parseInputs({ ...ENV, INPUT_REF: 'agent/1943-timed-run', INPUT_COMMAND: 'eval-scripted', INPUT_REPEATS: '3' }).repeats, 3);
  for (const [k, v] of [['INPUT_REF', 'feature/x'], ['INPUT_REF', 'agent/../main'], ['INPUT_REF', '$(id)'], ['INPUT_COMMAND', 'gate'], ['INPUT_COMMAND', 'walk;id'],
    ['INPUT_COMMAND', ''], ['INPUT_REPEATS', '0'], ['INPUT_REPEATS', '4'], ['INPUT_REPEATS', '2 x']])
    assert.throws(() => parseInputs({ ...ENV, [k]: v }), new RegExp(`input ${k.slice(6).toLowerCase()}=`), `${k}=${v}`);
});

test('args: only each command\'s own allowlisted flags, with checked values, once each', () => {
  assert.deepEqual(checkArgs('walk', ' --world fuzz,bench-hamlet '), ['--world', 'fuzz,bench-hamlet']);
  assert.deepEqual(checkArgs('eval-scripted', '--items bench-sit,music --warm-sec 40'), ['--items', 'bench-sit,music', '--warm-sec', '40']);
  assert.deepEqual(checkArgs('eval-scripted', '--battery hostile-v1 --seat scripted --items act-spam'), ['--battery', 'hostile-v1', '--seat', 'scripted', '--items', 'act-spam']);
  for (const [c, a] of [['eval-scripted', '--seat claude-sonnet'], ['eval-scripted', '--battery ../x'], ['eval-scripted', '--battery tools/playtest/eval/battery/m4-v1.json'], ['eval-scripted', '--battery'],
    ['walk', '--write'], ['walk', '--from x'], ['walk', '--world nowhere'], ['walk', '--world fuzz,fuzz'], ['walk', '--world fuzz --world fuzz'], ['walk', '--world'],
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
    assert.deepEqual(stage({ out, dest, command: 'eval-scripted', scrubWith: sw }), ['timed-run.json', 'eval/result.json', 'eval/REPORT.md']);
    assert.equal(readFileSync(join(dest, 'timed-run.json'), 'utf8'), '{"ran":"."}');
    assert.equal(readFileSync(join(dest, 'eval', 'result.json'), 'utf8'), '{"host":"<host>"}');
    assert.ok(!existsSync(join(dest, 'eval', 'episodes')));
    writeFileSync(join(out, 'eval', 'REPORT.md'), 'leaked tok-FAKE-fixture-0000');
    rmSync(dest, { recursive: true });
    assert.throws(() => stage({ out, dest, command: 'eval-scripted', scrubWith: sw }), /eval\/REPORT\.md holds a Soul token/);
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

test('strays: other jobs\' temp dirs and npm debug logs are a warning; the measured code\'s own strays still fail', () => {
  const d = mkdtempSync(join(tmpdir(), 'timed-')), touch = (p) => { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), ''); };
  try {
    const roots = [join(d, 'home'), join(d, 'tmp')], opts = { uid: process.getuid?.() ?? null };
    touch('home/.npm/_logs/old-debug-0.log');
    const before = snapshot(roots, opts);
    // other jobs on this account: a unit test's mkdtemp dirs in /tmp, npm's own debug log in the home
    for (const p of ['tmp/b-port-8ICb1z/world.sqlite', 'tmp/eden-truth-live-RTrR4X/.soul-live.json', 'home/.npm/_logs/2026-11-11T22_54_17_780Z-debug-0.log']) touch(p);
    // the measured code: a file in the home and one at a fixed /tmp path
    for (const p of ['home/.souls/world.json', 'tmp/stray/f', 'tmp/report.txt']) touch(p);
    const { strays, others } = sortStrays(newEntries(before, snapshot(roots, opts)), { home: join(d, 'home'), tmp: join(d, 'tmp') });
    assert.deepEqual(strays, ['home/.souls', 'home/.souls/world.json', 'tmp/report.txt', 'tmp/stray', 'tmp/stray/f'].map((p) => join(d, p)));
    assert.deepEqual(others, ['home/.npm/_logs/2026-11-11T22_54_17_780Z-debug-0.log', 'tmp/b-port-8ICb1z', 'tmp/b-port-8ICb1z/world.sqlite',
      'tmp/eden-truth-live-RTrR4X', 'tmp/eden-truth-live-RTrR4X/.soul-live.json'].map((p) => join(d, p)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// #1970
const cap = (command, args = '') => parseInputs({ ...ENV, INPUT_REPEATS: '2', INPUT_COMMAND: command, INPUT_ARGS: args });

test('the four capacity commands: their own allowlisted args (bare flags included), refused otherwise', () => {
  assert.deepEqual(cap('eval-load', '--souls 6,12 --duration-sec 60 --card-sec 30').args, ['--souls', '6,12', '--duration-sec', '60', '--card-sec', '30']);
  assert.deepEqual(cap('bench-client', '--arms n1,n100 --short --profile stress --raw-from 4').args, ['--arms', 'n1,n100', '--short', '--profile', 'stress', '--raw-from', '4']);
  assert.deepEqual(cap('meetup', '--short --profile even').args, ['--short', '--profile', 'even']);
  assert.deepEqual(cap('slopes-profile').args, []);
  for (const [c, a] of [['eval-load', '--souls 0'], ['eval-load', '--souls 101'], ['eval-load', '--souls 6,6'], ['eval-load', '--keep-data'], ['eval-load', '--server-root /x'],
    ['eval-load', '--duration-sec 5'], ['eval-load', '--out /x'], ['bench-client', '--arms hostile'], ['bench-client', '--arms n0'], ['bench-client', '--profile x'],
    ['bench-client', '--cpus 0-1'], ['bench-client', '--slice id'], ['bench-client', '--root /x'], ['bench-client', '--short --short'], ['bench-client', '--world-env A=1'],
    ['meetup', '--profile slopes'], ['meetup', '--active-min 19'], ['meetup', '--browser'], ['meetup', '--qualifying-executor'], ['meetup', '--short x'],
    ['slopes-profile', '--axis quiet'], ['slopes-profile', '--short']])
    assert.throws(() => cap(c, a), /input args/, `${c} ${a}`);
});

test('command lines: each bench with its repeats, its own output dir under out and its ports; slopes is the walkers profile', () => {
  const o = { out: 'o', port: 30000 };
  assert.deepEqual(commandLine(cap('eval-load', '--souls 6'), o), ['tools/playtest/eval/soul-eval.mjs', 'load', '--repeats', '2', '--out', join('o', 'eval-load'), '--port', '30000', '--keep-data', '--souls', '6']);
  assert.deepEqual(commandLine(cap('bench-client', '--arms n6 --short'), o), ['tools/bench/capacity/bench.mjs', '--load', 'client', '--via-launcher', '--repeats', '2', '--out', join('o', 'bench'), '--port', '30000', '--child-range', '30001-30002', '--arms', 'n6', '--short']);
  assert.deepEqual(commandLine(cap('meetup', '--profile even'), o), ['tools/bench/capacity/meetup/meetup.mjs', '--repeats', '2', '--out', join('o', 'meetup'), '--port', '30000', '--range', '30001-30030', '--profile', 'even']);
  assert.deepEqual(commandLine(cap('slopes-profile'), o), ['tools/bench/capacity/slopes/slopes.mjs', '--axis', 'walkers', '--cpu-prof', '--repeats', '2', '--out', join('o', 'slopes'), '--port', '30000']);
  assert.deepEqual(SPLIT, ['eval-load', 'bench-client', 'meetup', 'slopes-profile']);
});

test('stage, each capacity command: its own files only, scrubbed; a Soul token anywhere under out refuses the upload', () => {
  const layouts = {
    'eval-load': [['eval-load/load-result.json', 'eval-load/LOAD.md', 'eval-load.log'], ['eval-load/n6-r1/trace/s0.jsonl', 'eval-load/n6-r1/server/data/sim.db'], 'eval-load/n6-r1/souls/s0'],
    'bench-client': [['bench/receipt.json', 'bench/REPORT.md', 'bench/n6-r1/result.json', 'bench-client.log'], ['bench/n6-r1/commands.jsonl', 'bench/n6-r1/world.log', 'bench/bench.log'], 'bench/n6-r1/souls/s0'],
    meetup: [['meetup/summary.json', 'meetup/VERDICT.md', 'meetup/even-r1/receipt.json', 'meetup/even-r1/result.json', 'meetup/even-r1/REPORT.md', 'meetup.log'], ['meetup/even-r1/ops.jsonl', 'meetup/even-r1/samples.jsonl', 'meetup/meetup.log'], 'meetup/even-r1/souls/s0'],
    'slopes-profile': [['slopes/receipt.json', 'slopes/results.json', 'slopes/REPORT.md', 'slopes/walk0-r1/result.json', 'slopes-profile.log'], ['slopes/walk0-r1/calls.jsonl', 'slopes/walk0-r1/profile-walk.cpuprofile', 'slopes/walk0-r1/tick-spans.jsonl'], 'slopes/walk0-r1/souls/s0'],
  };
  const sw = { paths: [['/srv/runner-x/_work', '<runner-work>']], names: [['buildbox', '<host>']] };
  for (const [command, [pub, keep, soul]] of Object.entries(layouts)) {
    const d = mkdtempSync(join(tmpdir(), 'timed-')), out = join(d, 'out'), dest = join(d, 'art'), put = (f, t) => { mkdirSync(join(out, f, '..'), { recursive: true }); writeFileSync(join(out, f), t); };
    try {
      put('timed-run.json', '{"ran":"/srv/runner-x/_work/souls/src"}');
      for (const f of [...pub.slice(1), ...keep]) put(f, 'on buildbox');
      put(pub[0], '{"host":"buildbox"}');
      put(`${soul}/.eden-agent.json`, '{"token":"tok-FAKE-fixture-1970"}');
      assert.deepEqual(stage({ out, dest, command, scrubWith: sw }), ['timed-run.json', ...pub], command);
      assert.equal(readFileSync(join(dest, 'timed-run.json'), 'utf8'), '{"ran":"<runner-work>/souls/src"}');
      assert.equal(readFileSync(join(dest, pub[0]), 'utf8'), '{"host":"<host>"}', command);
      for (const f of keep) assert.ok(!existsSync(join(dest, f)), `${command}: ${f} stays on the runner`);
      rmSync(dest, { recursive: true });
      put(pub.at(-1), 'joined with tok-FAKE-fixture-1970');
      assert.throws(() => stage({ out, dest, command, scrubWith: sw }), /holds a Soul token/, command);
      assert.ok(!existsSync(dest), `${command}: nothing staged`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('core split: two physical cores for the world, the rest (two of four, one of three) for the load generator; else refused', () => {
  const smt = (c) => [c % 8, (c % 8) + 8];   // cpu c and c+8 are one physical core
  assert.deepEqual(splitCores([4, 5, 6, 7, 12, 13, 14, 15], smt), { physicalCores: 4, layout: '2+2', world: '4,12,5,13', load: '6,14,7,15' });
  assert.deepEqual(splitCores([0, 1, 2, 3], (c) => [c]), { physicalCores: 4, layout: '2+2', world: '0,1', load: '2,3' });
  assert.deepEqual(splitCores([3, 1, 2, 0], () => []), { physicalCores: 4, layout: '2+2', world: '0,1', load: '2,3' }, 'unreadable topology: one core per CPU');
  assert.deepEqual(splitCores([5, 6, 7, 13, 14, 15], smt), { physicalCores: 3, layout: '2+1', world: '5,13,6,14', load: '7,15' }, 'the timed runners: 6 logical CPUs, 3 cores');
  assert.throws(() => splitCores([4, 5, 12, 13], smt), /2 physical core\(s\).*needs 3 or 4/);
  assert.throws(() => splitCores([0, 1, 2, 3, 4, 5], (c) => [c]), /6 physical core/);
});

test('world pinning: only world servers under the run\'s own process tree', () => {
  assert.deepEqual(descendants([[10, 1], [11, 10], [12, 11], [13, 1], [14, 12]], 10).sort(), [11, 12, 14]);
  assert.deepEqual(descendants([[10, 1]], 99), []);
  assert.ok(isWorld(['/usr/bin/node', '--max-old-space-size=2048', '/w/src/apps/server/src/main.ts', ''].join('\0')));
  assert.ok(isWorld(['node', 'apps/server/src/main.ts'].join('\0')));
  for (const c of ['node\0tools/world-launcher/launcher.mjs', 'node\0tools/bench/capacity/bench.mjs', 'grep\0apps/server/src/main.ts.bak'])
    assert.ok(!isWorld(c), c);
});

// counted scenario cells
const CNT = { ...ENV, INPUT_REF: 'agent/1367-x', INPUT_COMMAND: 'counted', INPUT_REPEATS: '2', INPUT_ARGS: '--scenario stair-foot', INPUT_BASE: 'main', INPUT_CELL: 'cand-2', INPUT_RUNNER: 'hosted' };

test('counted: one cell per job, base-k on the base branch and cand-k on the ref; hosted runners for counted only', () => {
  const c = parseInputs(CNT);
  assert.deepEqual([c.cell, c.arm, c.base, c.scenario, c.runner, target(c)], ['cand-2', 'cand', 'main', 'stair-foot', 'hosted', 'refs/heads/agent/1367-x']);
  assert.equal(target(parseInputs({ ...CNT, INPUT_CELL: 'base-1' })), 'refs/heads/main');
  assert.deepEqual(parseInputs({ ...CNT, INPUT_ARGS: '--scenario stair-foot --loop-sec 300' }).args, ['--scenario', 'stair-foot', '--loop-sec', '300']);
  for (const [k, v] of [['INPUT_CELL', 'cand-3'], ['INPUT_CELL', 'all'], ['INPUT_CELL', 'ref-1'], ['INPUT_CELL', ''], ['INPUT_BASE', ''], ['INPUT_BASE', 'feature/x'], ['INPUT_BASE', 'agent/../main'],
    ['INPUT_ARGS', ''], ['INPUT_ARGS', '--scenario nowhere'], ['INPUT_ARGS', '--scenario stair-foot --loop-sec 5'], ['INPUT_ARGS', '--scenario stair-foot --port 1'], ['INPUT_RUNNER', 'ubuntu-latest']])
    assert.throws(() => parseInputs({ ...CNT, [k]: v }), /^Error: input /, `${k}=${v}`);
  assert.equal(parseInputs({ ...CNT, INPUT_RUNNER: '' }).runner, 'souls-timed');
  for (const command of ['walk', 'eval-scripted', 'eval-load', 'bench-client', 'meetup', 'slopes-profile'])
    assert.throws(() => parseInputs({ ...ENV, INPUT_COMMAND: command, INPUT_RUNNER: 'hosted' }), /input runner="hosted": .* souls-timed only/, command);
  assert.equal(target(parseInputs(ENV)), 'refs/heads/main');
});

test('counted: the kit runs the cell, scores it and classifies it, writing the workstation session\'s files under out', () => {
  const steps = countedSteps(parseInputs(CNT), { kit: 'k', out: 'o', port: 30000 });
  assert.deepEqual(steps.map((s) => [s.step, s.argv, s.stdout, s.stderr ?? null]), [
    ['run', [join('k', 'run.mjs'), 'cand', '.', '30000', join('o', 'counted', 'cand-2')], null, null],
    ['score', [join('k', 'score-frozen.mjs'), join('o', 'counted', 'cand-2', 'run.json')], join('o', 'counted', 'cand-2.scores.json'), null],
    ['classify', [join('k', 'classify-frozen.mjs'), join('o', 'counted', 'cand-2'), '.', '30000'], join('o', 'counted', 'cand-2.class.json'), join('o', 'counted', 'cand-2.class.err')],
  ]);
  // the stair kit is the one #1367's declaration names, byte for byte
  const declared = { 'run.mjs': '02f63c203908290b8ca430f5fcc8858b822fb429ea2ba0d5d5af19b0b1dcbd04', 'score-frozen.mjs': 'dc3b317b622f5be062925244b1a35669c38997b1f00b44f98c8f6c4037c1e64d',
    'classify-frozen.mjs': '408ef102aa3da67cff0a1657e5dd8d5ae4b04c132b12ff1d62da7838e5258889', 'replay.mjs': 'f18536f28efad26dc6848959d52914d74b3bd3c3234747bc91f9b78e49bd0a1b', 'probe.mjs': 'b3a224c15a5051dae473808eeab22be65b1ef2f0059e16b1a7c9f7b709cd12ae' };
  const kit = COUNTED['stair-foot'];
  assert.deepEqual(Object.fromEntries(kit.files.map((f) => [f, createHash('sha256').update(readFileSync(join(import.meta.dirname, '../..', kit.dir, f))).digest('hex')])), declared);
});

test('stage, counted: the record, log, score, class and probe log only; world data and Soul homes stay; a home\'s token refuses the upload', () => {
  const d = mkdtempSync(join(tmpdir(), 'timed-')), out = join(d, 'out'), dest = join(d, 'art'), put = (f, t) => { mkdirSync(join(out, f, '..'), { recursive: true }); writeFileSync(join(out, f), t); };
  const sw = { paths: [['/srv/runner-x/_work', '<runner-work>']], names: [['buildbox', '<host>']] };
  try {
    const pub = ['counted/cand-2/run.json', 'counted/cand-2.log', 'counted/cand-2.scores.json', 'counted/cand-2.class.json', 'counted/cand-2.class.err', 'counted/cand-2/probe.log'];
    put('timed-run.json', '{"ran":"/srv/runner-x/_work/souls/src"}');
    for (const f of pub) put(f, 'on buildbox');
    for (const f of ['counted/cand-2/data/sim.db', 'counted/cand-2/s-Ana/x.json']) put(f, 'world');
    put('counted/cand-2/h-Ana/credentials.json', '{"souls":{"s_1":{"w":{"token":"tok-FAKE-fixture-counted"}}}}');
    assert.deepEqual(stage({ out, dest, command: 'counted', scrubWith: sw }), ['timed-run.json', ...pub]);
    assert.equal(readFileSync(join(dest, 'counted/cand-2.log'), 'utf8'), 'on <host>');
    for (const f of ['counted/cand-2/data/sim.db', 'counted/cand-2/h-Ana/credentials.json']) assert.ok(!existsSync(join(dest, f)), f);
    rmSync(dest, { recursive: true });
    put('counted/cand-2/run.json', '{"err":"tok-FAKE-fixture-counted"}');
    assert.throws(() => stage({ out, dest, command: 'counted', scrubWith: sw }), /run\.json holds a Soul token/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
