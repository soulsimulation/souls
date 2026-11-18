// timed-run.mjs (#1943, #1970): the per-command allowlist, the argument check, the start-load gate, the scrubbed staging
// and the world/load core split; the counted scenario cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseInputs, checkArgs, commandLine, parseCpuList, parseProcStat, loadFacts, stage, snapshot, newEntries, sortStrays, globTest, splitCores, descendants, isWorld, isLauncher, parseCorePlan, groupBusy, SPLIT, WIDE, LOAD_GATE, WIDE_MAX_GATE, COUNTED, target, countedSteps, checkBenchArgs, benchBins, benchLines, allowlist, V2_PREPS } from './timed-run.mjs';

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
  assert.deepEqual(checkArgs('viewers', '--viewers 200,500,1000,2000'), ['--viewers', '200,500,1000,2000']);
  assert.deepEqual(checkArgs('viewers', '--viewers 0,50,200 --souls 24 --act-sec 10 --arrive-per-sec 20 --arrive-burst 300@40 --dwell-sec 60').length, 12);   // #2511
  assert.deepEqual(checkArgs('viewers', '--viewers 2000,5000,10000 --drivers 4 --slow-readers 50 --restart-at 40 --stub --stub-kb 50').length, 11);   // #2512
  for (const a of ['--viewers 10001', '--drivers 17', '--drivers 0', '--slow-readers 501', '--restart-at 4', '--stub yes', '--viewers 00', '--viewers 0,0', '--viewers 1,2,3,4,5', '--viewers 05', '--souls 101', '--arrive-burst 300', '--arrive-burst 3000@10', '--arrive-per-sec 0']) assert.throws(() => checkArgs('viewers', a), /input args/, a);
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

test('stage: eval-load publishes each world\'s own log, never its data or the Soul folders', () => {
  const d = mkdtempSync(join(tmpdir(), 'timed-')), out = join(d, 'out'), dest = join(d, 'art');
  try {
    for (const p of ['eval-load/n100-r1/server/data', 'eval-load/n100-r1/souls/s0']) mkdirSync(join(out, p), { recursive: true });
    writeFileSync(join(out, 'eval-load', 'n100-r1', 'server', 'world.log'), '[load] amber→red');
    writeFileSync(join(out, 'eval-load', 'n100-r1', 'server', 'data', 'live.json'), '{}');
    writeFileSync(join(out, 'eval-load', 'n100-r1', 'souls', 's0', 'credentials.json'), '{"token":"tok-FAKE-fixture-0001"}');
    assert.deepEqual(stage({ out, dest, command: 'eval-load', scrubWith: { paths: [], names: [] } }), ['eval-load/n100-r1/server/world.log']);
    assert.equal(readFileSync(join(dest, 'eval-load', 'n100-r1', 'server', 'world.log'), 'utf8'), '[load] amber→red');
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
  for (const [c, a] of [['eval-load', '--souls 0'], ['eval-load', '--souls 501'], ['eval-load', '--raw-from 0'], ['eval-load', '--shape lumpy'], ['eval-load', '--souls 6,6'], ['eval-load', '--keep-data'], ['eval-load', '--server-root /x'],
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
  assert.deepEqual(SPLIT, ['eval-load', 'bench-client', 'meetup', 'slopes-profile', 'viewers', 'page']);
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

test('core plan (#2507): cores is accepted for the split commands, validated, recorded in the inputs, and refused at the start gate when it does not fit', () => {
  const V = { ...ENV, INPUT_COMMAND: 'viewers' };
  assert.deepEqual(parseInputs({ ...V, INPUT_CORES: 'world=2,launcher=1' }).cores, { world: 2, launcher: 1 });
  assert.deepEqual(parseInputs({ ...V, INPUT_CORES: ' world=6 ' }).cores, { world: 6, launcher: 0 });
  assert.ok(!('cores' in parseInputs({ ...V, INPUT_CORES: '' })), 'no plan: the inputs are as before');
  for (const v of ['world=0', 'world=2,launcher=0', 'launcher=1', 'world=2,launcher=1,load=1', 'world=65', 'world=2 launcher=1', 'world=x', 'world=2;id'])
    assert.throws(() => parseInputs({ ...V, INPUT_CORES: v }), /input cores=.*world=N or world=N,launcher=M/, v);
  assert.throws(() => parseInputs({ ...ENV, INPUT_CORES: 'world=2' }), /input cores=.*for eval-load, .*viewers, page only/, 'walk takes no plan');
  assert.equal(parseCorePlan('world=2,launcher=1').launcher, 1);
  const smt = (c) => [c % 8, (c % 8) + 8], three = [5, 6, 7, 13, 14, 15];
  assert.deepEqual(splitCores(three, smt, { world: 1, launcher: 1 }), { physicalCores: 3, plan: 'world=1,launcher=1', layout: '1+1+1', world: '5,13', launcher: '6,14', load: '7,15' });
  assert.deepEqual(splitCores([0, 1, 2, 3, 4, 5, 6, 7], (c) => [c], { world: 6, launcher: 1 }), { physicalCores: 8, plan: 'world=6,launcher=1', layout: '6+1+1', world: '0,1,2,3,4,5', launcher: '6', load: '7' });
  assert.deepEqual(splitCores([0, 1, 2, 3, 4, 5], (c) => [c], { world: 2, launcher: 0 }), { physicalCores: 6, plan: 'world=2', layout: '2+4', world: '0,1', load: '2,3,4,5' }, 'a plan lifts the 3-or-4 rule');
  assert.throws(() => splitCores(three, smt, { world: 2, launcher: 1 }), /the core plan world=2,launcher=1 needs 4 physical cores \(at least one for the load drivers\); this runner has 3 of its own/);
  assert.throws(() => splitCores(three, smt, { world: 3, launcher: 0 }), /world=3 needs 4/);
  assert.deepEqual(splitCores(three, smt, null), splitCores(three, smt), 'no plan: the split of today');
  assert.ok(isLauncher(['/usr/bin/node', '/w/src/tools/world-launcher/launcher.mjs', '--port', '1'].join('\0')));
  for (const c of ['node\0apps/server/src/main.ts', 'node\0tools/world-launcher/launcher.test.mjs', 'node\0tools/bench/capacity/viewers/viewers.mjs']) assert.ok(!isLauncher(c), c);
  const a = parseProcStat('cpu0 10 0 0 90 0 0 0 0\ncpu1 0 0 0 100 0 0 0 0\ncpu2 50 0 0 50 0 0 0 0\n'), b = parseProcStat('cpu0 60 0 0 140 0 0 0 0\ncpu1 10 0 0 190 0 0 0 0\ncpu2 150 0 0 50 0 0 0 0\n');
  assert.deepEqual(groupBusy(a, b, { world: '0,1', load: '2' }), { world: 0.3, load: 1 });
});

const CNT_WIDE = { INPUT_REF: 'agent/1367-x', INPUT_COMMAND: 'counted', INPUT_REPEATS: '1', INPUT_ARGS: '--scenario stair-foot', INPUT_BASE: 'main', INPUT_CELL: 'cand-1', INPUT_CORES: '' };
test('wide runner (D5): souls-wide takes the split commands with a core plan and settled; 5,000 and 10,000 viewers run there only', () => {
  const W = { ...ENV, INPUT_RUNNER: 'souls-wide', INPUT_CORES: 'world=6,launcher=1' };
  assert.deepEqual(parseInputs({ ...W, INPUT_COMMAND: 'viewers', INPUT_ARGS: '--viewers 5000,10000' }), { ref: 'main', command: 'viewers', repeats: 1, args: ['--viewers', '5000,10000'], cores: { world: 6, launcher: 1 }, runner: 'souls-wide' });
  assert.equal(parseInputs({ ...W, INPUT_COMMAND: 'eval-load', INPUT_ARGS: '--souls 500 --raw-from 20' }).runner, 'souls-wide');
  assert.equal(parseInputs({ ...W, INPUT_COMMAND: 'settled', INPUT_CORES: '' }).runner, 'souls-wide', 'settled is not split: no plan');
  assert.deepEqual(WIDE, [...SPLIT, 'settled']);
  for (const command of ['walk', 'eval-scripted', 'load', 'hundred', 'colocate', 'clip'])
    assert.throws(() => parseInputs({ ...W, INPUT_COMMAND: command, INPUT_CORES: '' }), /input runner="souls-wide": souls-wide runs eval-load, .*viewers, page, settled only/, command);
  assert.throws(() => parseInputs({ ...W, ...CNT_WIDE }), /input runner="souls-wide"/, 'counted');
  assert.throws(() => parseInputs({ ...W, INPUT_COMMAND: 'viewers', INPUT_CORES: '' }), /input cores="": souls-wide needs a core plan/);
  for (const v of ['5000', '200,10000']) {
    assert.throws(() => parseInputs({ ...ENV, INPUT_COMMAND: 'viewers', INPUT_ARGS: `--viewers ${v}` }), /input runner="souls-timed": viewer arms above 2000 run on souls-wide only/, v);
    assert.throws(() => parseInputs({ ...ENV, INPUT_COMMAND: 'viewers', INPUT_ARGS: `--viewers ${v}`, INPUT_CORES: 'world=1,launcher=1' }), /souls-wide only/, `${v} with a plan`);
  }
  assert.deepEqual(parseInputs({ ...ENV, INPUT_COMMAND: 'viewers', INPUT_ARGS: '--viewers 0,2000' }).args, ['--viewers', '0,2000'], 'up to 2,000 stays on souls-timed');
  for (const a of ['--viewers 10001', '--viewers 05000']) assert.throws(() => parseInputs({ ...W, INPUT_COMMAND: 'viewers', INPUT_ARGS: a }), /input args/, a);
  // the union of four timed instances' CPUs: 12 physical cores (SMT pairs c, c+24), and a 16-core one
  const smt = (c) => [c % 24, (c % 24) + 24], twelve = [...parseCpuList('6-17'), ...parseCpuList('30-41')];
  assert.deepEqual(splitCores(twelve, smt, { world: 6, launcher: 1 }), { physicalCores: 12, plan: 'world=6,launcher=1', layout: '6+1+5',
    world: '6,30,7,31,8,32,9,33,10,34,11,35', launcher: '12,36', load: '13,37,14,38,15,39,16,40,17,41' });
  assert.equal(splitCores(parseCpuList('0-15'), (c) => [c], { world: 6, launcher: 1 }).layout, '6+1+9');
  assert.throws(() => splitCores(twelve, smt), /12 physical core\(s\).*needs 3 or 4/, 'no plan: refused, as parseInputs says first');
  assert.throws(() => splitCores(twelve, smt, { world: 8, launcher: 4 }), /needs 13 physical cores/);
});

test('wide runner (D5): the start gate also refuses while any one of its CPUs is busy (a narrow job on shared cores)', () => {
  const s = (rows) => parseProcStat(rows.map(([b, i], c) => `cpu${c} ${b} 0 0 ${i} 0 0 0 0 0 0`).join('\n'));
  const a = s(Array.from({ length: 24 }, () => [0, 0]));
  // a narrow job busy on 4 of the wide runner's 24 CPUs: the mean (0.15) passes, the busiest CPU (0.9) does not
  const b = s(Array.from({ length: 24 }, (_, c) => (c < 4 ? [90, 10] : [0, 100])));
  const own = Array.from({ length: 24 }, (_, c) => c);
  assert.deepEqual([loadFacts(a, b, own).ownBusy, loadFacts(a, b, own).overGate], [0.15, false], 'the narrow gate alone lets it start');
  const wide = loadFacts(a, b, own, LOAD_GATE, WIDE_MAX_GATE);
  assert.deepEqual([wide.ownBusy, wide.ownBusyMax, wide.maxGate, wide.overGate], [0.15, 0.9, 0.5, true]);
  assert.equal(loadFacts(a, s(Array.from({ length: 24 }, () => [20, 80])), own, LOAD_GATE, WIDE_MAX_GATE).overGate, false, 'quiet: every CPU at 0.2');
});

test('world pinning: only world servers under the run\'s own process tree', () => {
  assert.deepEqual(descendants([[10, 1], [11, 10], [12, 11], [13, 1], [14, 12]], 10).sort(), [11, 12, 14]);
  assert.deepEqual(descendants([[10, 1]], 99), []);
  assert.ok(isWorld(['/usr/bin/node', '--max-old-space-size=2048', '/w/src/apps/server/src/main.ts', ''].join('\0')));
  assert.ok(isWorld(['node', 'apps/server/src/main.ts'].join('\0')));
  assert.ok(isWorld(['node', '/w/src/tools/bench/capacity/viewers/stub.mjs', '--port', '1'].join('\0')));   // #2512
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

test('v2-bench: --bin and plain tokens after --; the bin must be a [[bin]] of the ref\'s bench manifest; build, then cargo run per repeat', () => {
  const inp = parseInputs({ ...ENV, INPUT_REF: 'agent/2697-view-tier', INPUT_COMMAND: 'v2-bench', INPUT_REPEATS: '2', INPUT_ARGS: '--bin view-tier -- 400 2' });
  assert.deepEqual(inp, { ref: 'agent/2697-view-tier', command: 'v2-bench', repeats: 2, args: ['--bin', 'view-tier', '--', '400', '2'], runner: 'souls-timed' });
  assert.deepEqual(benchLines(inp), { build: ['build', '-p', 'bench', '--release', '--locked', '--bin', 'view-tier'], run: ['run', '-p', 'bench', '--release', '--locked', '--bin', 'view-tier', '--', '400', '2'] });
  assert.deepEqual(benchLines(parseInputs({ ...ENV, INPUT_COMMAND: 'v2-bench', INPUT_ARGS: '--bin tree' })).run, ['run', '-p', 'bench', '--release', '--locked', '--bin', 'tree']);
  assert.deepEqual(checkBenchArgs('--bin tree -- --rows=10 target/x a.b_c'), ['--bin', 'tree', '--', '--rows=10', 'target/x', 'a.b_c']);
  for (const a of ['', '400 2', '--bin', '--bin ../x', '--bin View', '--bin a;b', '--bin tree 400', '--bin tree -- $(id)', '--bin tree -- a;b', '--bin tree -- `id`', '--bin tree -- a|b',
    '--bin tree -- "x"', '--bin tree -- a&&b', '--bin tree -- a~b', '--bin tree -- a>b',`--bin tree -- ${Array(21).fill('1').join(' ')}`])
    assert.throws(() => checkBenchArgs(a), /input args/, a);
  assert.throws(() => parseInputs({ ...ENV, INPUT_COMMAND: 'v2-bench', INPUT_ARGS: '--bin tree', INPUT_RUNNER: 'hosted' }), /input runner=/);
  assert.throws(() => parseInputs({ ...ENV, INPUT_COMMAND: 'v2-bench', INPUT_ARGS: '--bin tree', INPUT_RUNNER: 'souls-wide' }), /input runner=/);
  const toml = '[package]\nname = "bench"\n\n[[bin]]\nname = "tree"\npath = "src/tree.rs"\n\n[[bin]] # R3\nname="view-tier"\n\n[dependencies]\nname = "not-a-bin"\n[[example]]\nname = "ex"\n';
  assert.deepEqual(benchBins(toml), ['tree', 'view-tier']);
  assert.deepEqual(benchBins('[package]\nname = "bench"\n'), []);
});

test('v2-bench --prep: an allowlisted prep; @<output> only of that prep, filled with its file in the per-run directory, shown as written', () => {
  const inp = parseInputs({ ...ENV, INPUT_REF: 'agent/3167-corner-cost', INPUT_COMMAND: 'v2-bench', INPUT_ARGS: '--bin walkers --prep eden-facts -- @facts @labels uniform 1 1000 600' });
  assert.deepEqual(inp.args, ['--bin', 'walkers', '--prep', 'eden-facts', '--', '@facts', '@labels', 'uniform', '1', '1000', '600']);
  assert.deepEqual(benchLines(inp).build, ['build', '-p', 'bench', '--release', '--locked', '--bin', 'walkers']);
  assert.deepEqual(benchLines(inp).run.slice(7), ['--', '@facts', '@labels', 'uniform', '1', '1000', '600']);
  assert.deepEqual(benchLines(inp, join('/p', 'prep')).run.slice(7), ['--', join('/p', 'prep', V2_PREPS['eden-facts'].facts), join('/p', 'prep', V2_PREPS['eden-facts'].labels), 'uniform', '1', '1000', '600']);
  assert.deepEqual(checkBenchArgs('--bin walkers --prep eden-facts'), ['--bin', 'walkers', '--prep', 'eden-facts']);
  for (const a of ['--bin walkers --prep', '--bin walkers --prep other -- @facts', '--bin walkers -- @facts', '--bin walkers --prep eden-facts -- @nope', '--bin walkers --prep eden-facts @facts', '--bin walkers --prep eden-facts -- @facts;id', '--prep eden-facts --bin walkers'])
    assert.throws(() => checkBenchArgs(a), /input args/, a);
});

test('stage, v2-bench: the record, the build log and each repeat\'s log; the target dir and the bench\'s own files stay', () => {
  const d = mkdtempSync(join(tmpdir(), 'timed-')), out = join(d, 'out'), put = (f, t) => { mkdirSync(join(out, f, '..'), { recursive: true }); writeFileSync(join(out, f), t); };
  try {
    for (const f of ['timed-run.json', 'v2-bench-prep.log', 'v2-bench-build.log', 'v2-bench-r1.log', 'v2-bench-r2.log', 'target/release/view-tier', 'view-tier/log.bin', 'prep/labels.json']) put(f, 'x');
    assert.deepEqual(allowlist(out, 'v2-bench'), ['timed-run.json', 'v2-bench-prep.log', 'v2-bench-build.log', 'v2-bench-r1.log', 'v2-bench-r2.log']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
