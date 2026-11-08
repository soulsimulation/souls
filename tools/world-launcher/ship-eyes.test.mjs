// #1438: the release handover between release.yml and the GPU workstation (ship/handover.mjs, ship/eyes.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT, description, judge, latestFor, parseDescription, safeDetail, sameRun, waitFor } from './deploy/ship/handover.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EYES = join(HERE, 'deploy/ship/eyes.mjs'), HANDOVER = join(HERE, 'deploy/ship/handover.mjs');
const SHA = 'a'.repeat(40);
const st = (context, state, d) => ({ context, state, description: d });

test('descriptions: run id and mode round-trip, the 140-character limit holds, anything else is not ours', () => {
  assert.deepEqual(parseDescription(description(42, 'waiting-for-eyes', { mode: 'no-switch' })), { run: '42', mode: 'no-switch', word: 'waiting-for-eyes', detail: '' });
  assert.deepEqual(parseDescription(description(7, 'fail', { detail: 'probe walks-verdict' })), { run: '7', mode: null, word: 'fail', detail: 'probe walks-verdict' });
  assert.ok(description(1, 'fail', { detail: 'x'.repeat(300) }).length <= 140);
  for (const d of ['', 'pass', 'run=abc pass', 'run=1 mode=prod pass', null]) assert.equal(parseDescription(d), null, String(d));
  assert.throws(() => description('12a', 'pass'));
  assert.deepEqual(parseDescription('run=42.3 ready'), { run: '42.3', mode: null, word: 'ready', detail: '' });
});

test('a re-run keeps the run id, so the attempt decides; public details lose paths and stack text', () => {
  assert.ok(sameRun('42.2', '42.2')); assert.ok(!sameRun('42.1', '42.2')); assert.ok(sameRun('42.1', '42')); assert.ok(!sameRun('421.1', '42'));
  const list = [st(CONTEXT.eyes, 'pending', 'run=42.1 ready')];
  assert.equal(latestFor(list, CONTEXT.eyes, '42.2'), null, 'attempt 1 is never attempt 2');
  const d = description('42.2', 'fail', { detail: "eyes crashed: ENOENT open '/home/someone/x/probe/report.json' at <anonymous>" });
  assert.doesNotMatch(d, /\/|<|'/); assert.match(d, /^run=42\.2 fail: eyes crashed: ENOENT open home someone x probe report.json at anonymous$/);
  assert.equal(safeDetail('probe(noBuild=2,errorPages=1) stall-verdict'), 'probe(noBuild=2,errorPages=1) stall-verdict');
});

test('latestFor: the newest status of the context for this run; another run or context never counts', () => {
  const list = [st(CONTEXT.eyes, 'success', 'run=9 pass'), st(CONTEXT.ship, 'success', 'run=8 released'), st(CONTEXT.eyes, 'failure', 'run=8 fail: stall-verdict'), st(CONTEXT.eyes, 'pending', 'run=8 ready'), st(CONTEXT.eyes, 'success', 'stray text')];
  assert.equal(latestFor(list, CONTEXT.eyes, 8).state, 'failure');
  assert.equal(latestFor(list, CONTEXT.eyes, '9').word, 'pass');
  assert.equal(latestFor(list, CONTEXT.eyes, 10), null);
  assert.equal(latestFor(list, CONTEXT.ship, null).run, '8');
});

test('judge: waits fail closed; a failure ends every wait, and only the wanted word passes', () => {
  const p = (state, d) => ({ state, ...parseDescription(d) });
  assert.equal(judge(null, 'final'), 'wait');
  assert.equal(judge(p('pending', 'run=1 ready'), 'final'), 'wait');
  assert.equal(judge(p('success', 'run=1 pass'), 'final'), 'yes');
  assert.equal(judge(p('failure', 'run=1 fail: probe'), 'final'), 'no');
  assert.equal(judge(p('pending', 'run=1 ready'), 'ready'), 'yes');
  assert.equal(judge(p('success', 'run=1 pass'), 'ready'), 'no', 'a pass that never said ready is not a handover');
  assert.equal(judge(p('failure', 'run=1 fail: the probe exited'), 'ready'), 'no');
  assert.equal(judge(p('success', 'run=1 released'), 'released'), 'yes');
  assert.equal(judge(p('failure', 'run=1 stopped: rehearse'), 'released'), 'no');
  assert.equal(judge(p('pending', 'run=1 mode=ship waiting-for-eyes'), 'waiting'), 'yes');
  assert.equal(judge(p('success', 'run=1 released'), 'waiting'), 'wait');
});

test('B1: a ready counts only while fresh: a stale or undated ready is not a probe watching now', () => {
  const now = Date.parse('2026-11-08T22:00:00Z');
  const at = (iso) => ({ state: 'pending', ...parseDescription('run=5.1 ready'), at: Date.parse(iso) });
  assert.equal(judge(at('2026-11-08T21:59:00Z'), 'ready', { now, maxAgeMs: 180_000 }), 'yes');
  assert.equal(judge(at('2026-11-08T21:50:00Z'), 'ready', { now, maxAgeMs: 180_000 }), 'wait');
  assert.equal(judge({ ...at('x'), at: null }, 'ready', { now, maxAgeMs: 180_000 }), 'wait');
  assert.equal(judge(at('2026-11-08T21:50:00Z'), 'ready', { now }), 'yes', 'no bound asked: the old reading');
  assert.equal(latestFor([{ context: CONTEXT.eyes, state: 'pending', description: 'run=5.1 ready', updated_at: '2026-11-08T21:59:00Z' }], CONTEXT.eyes, '5.1').at, Date.parse('2026-11-08T21:59:00Z'));
});

test('waitFor: polls until the status appears, stops at a failure, times out closed, backs off on 403', async () => {
  let t = 0; const now = () => t, sleep = async (ms) => { t += ms; };
  const seq = [[], [st(CONTEXT.eyes, 'pending', 'run=5 ready')], [st(CONTEXT.eyes, 'success', 'run=5 pass')]];
  let r = await waitFor({ repo: 'o/r', sha: SHA, context: CONTEXT.eyes, run: 5, want: 'final', timeoutMs: 600_000, everyMs: 30_000, now, sleep, list: async () => seq.shift() ?? [] });
  assert.equal(r.ok, true); assert.equal(t, 60_000);
  t = 0; r = await waitFor({ repo: 'o/r', sha: SHA, context: CONTEXT.eyes, run: 5, want: 'final', timeoutMs: 100_000, everyMs: 30_000, now, sleep, list: async () => [st(CONTEXT.eyes, 'pending', 'run=5 ready')] });
  assert.equal(r.ok, false); assert.equal(r.timedOut, true); assert.ok(t <= 100_000);
  t = 0; r = await waitFor({ repo: 'o/r', sha: SHA, context: CONTEXT.eyes, run: 5, want: 'final', timeoutMs: 600_000, now, sleep, list: async () => [st(CONTEXT.eyes, 'failure', 'run=5 fail: stall-verdict'), st(CONTEXT.eyes, 'success', 'run=4 pass')] });
  assert.equal(r.ok, false); assert.equal(r.status.detail, 'stall-verdict'); assert.equal(t, 0);
  t = 0; let calls = 0; r = await waitFor({ repo: 'o/r', sha: SHA, context: CONTEXT.eyes, run: 5, want: 'final', timeoutMs: 3_600_000, everyMs: 30_000, now, sleep, list: async () => { if (calls++ === 0) throw Error('HTTP 403: API rate limit exceeded'); return [st(CONTEXT.eyes, 'success', 'run=5 pass')]; } });
  assert.equal(r.ok, true); assert.equal(t, 300_000, 'a 403 waits five minutes');
});

// a fake `gh`: statuses and runs from files, every POST appended to posts.log
function fakeGh(statuses, runInfo, after = null, { delayReads = 0 } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'eyes-')), bin = join(t, 'bin'); mkdirSync(bin); mkdirSync(join(t, 'god'));
  writeFileSync(join(t, 'god/.eden-god.json'), '{}'); writeFileSync(join(t, 'statuses.json'), JSON.stringify(statuses)); writeFileSync(join(t, 'run.json'), JSON.stringify(runInfo));
  // after: the job's next status (released or stopped), served once eyes has posted ready
  if (after) writeFileSync(join(t, 'after.json'), JSON.stringify([after, ...statuses]));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\ncase "$*" in *"-X POST"*) echo "$*" >> ${t}/posts.log;; *"/statuses?"*) if [ -e ${t}/after.json ] && grep -q ' ready ' ${t}/posts.log 2>/dev/null && [ "$(echo x >> ${t}/reads; wc -l < ${t}/reads)" -gt ${delayReads} ]; then cat ${t}/after.json; else cat ${t}/statuses.json; fi;; *"/actions/runs/"*) cat ${t}/run.json;; *) exit 1;; esac\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const run = (args, env = {}) => spawnSync(process.execPath, [EYES, ...args, '--cli', join(t, 'god'), '--out', join(t, 'out'), '--repo', 'o/r', '--poll-s', '0.1'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { t, run, posts: () => (existsSync(join(t, 'posts.log')) ? readFileSync(join(t, 'posts.log'), 'utf8') : '') };
}

test('eyes refuses a short sha, a missing god folder, and a run that ships another sha; it posts nothing then', () => {
  let r = spawnSync(process.execPath, [EYES, '--sha', 'abc123'], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /full 40-hex/);
  r = spawnSync(process.execPath, [EYES, '--sha', SHA, '--cli', join(tmpdir(), 'no-such-god-folder')], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /no release-probe god folder/);
  const f = fakeGh([st(CONTEXT.ship, 'pending', 'run=77 mode=ship waiting-for-eyes')], { head_sha: 'b'.repeat(40), path: '.github/workflows/release.yml', status: 'in_progress' });
  r = f.run(['--sha', SHA]);
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, /REFUSED: run 77 .* not release\.yml shipping aaaaaaaaaaaa/);
  assert.equal(f.posts(), '', 'nothing posted for a run it refused');
  const g = fakeGh([st(CONTEXT.ship, 'pending', 'run=77 mode=ship waiting-for-eyes')], { head_sha: SHA, path: '.github/workflows/release.yml', status: 'in_progress' });
  r = g.run(['--sha', SHA, '--run', '78', '--find-min', '0']);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /no release run is waiting for eyes/);
  assert.equal(g.posts(), '');
});

test('handover.mjs CLI: posts only well-formed statuses, and wait exits 1 on a failure', () => {
  const f = fakeGh([st(CONTEXT.eyes, 'failure', 'run=3 fail: probe')], {});
  const env = { ...process.env, PATH: `${join(f.t, 'bin')}:${process.env.PATH}` };
  let r = spawnSync(process.execPath, [HANDOVER, 'post', SHA, CONTEXT.ship, 'success', 'released'], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  r = spawnSync(process.execPath, [HANDOVER, 'post', SHA, CONTEXT.ship, 'success', 'run=3 released', '--repo', 'o/r'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(f.posts(), /statuses\/a{40} -f state=success -f context=release\/ship -f description=run=3 released/);
  r = spawnSync(process.execPath, [HANDOVER, 'wait', SHA, CONTEXT.eyes, '--run', '3', '--want', 'final', '--repo', 'o/r'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stdout, /release\/eyes failure: run=3 fail: probe/);
});

// stand-in deploy tools for eyes (EYES_DEPLOY_DIR): a probe that waits for released or stop, browser tools that log, a
// checks.mjs that fails the verdict FAKE_FAIL_CHECK names
function fakeDeploy(t) {
  const d = join(t, 'deploy'), log = join(t, 'tools.log'); mkdirSync(join(d, 'ship'), { recursive: true });
  writeFileSync(join(d, 'release-probe.mjs'), `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2), out = a[a.indexOf('--out') + 1]; mkdirSync(out, { recursive: true });
appendFileSync(${JSON.stringify(log)}, 'probe ' + a[a.indexOf('--expect-build') + 1] + '\\n'); writeFileSync(out + '/ready', '');
if (process.env.FAKE_PROBE_DIE) { await new Promise((r) => setTimeout(r, 500)); appendFileSync(${JSON.stringify(log)}, 'probe died\\n'); process.exit(9); }
const end = Date.now() + 30000; while (Date.now() < end && !existsSync(out + '/released') && !existsSync(out + '/stop')) await new Promise((r) => setTimeout(r, 50));
appendFileSync(${JSON.stringify(log)}, existsSync(out + '/stop') ? 'probe stopped\\n' : 'probe released\\n');
writeFileSync(out + '/report.json', JSON.stringify({ bar: JSON.parse(process.env.FAKE_PROBE_BAR || '{"pass":true}') }));
process.exit(Number(process.env.FAKE_PROBE_RC || 0));`);
  for (const f of ['walk.mjs', 'poster.mjs', 'stall.mjs']) writeFileSync(join(d, 'ship', f), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, '${f}\\n');`);
  writeFileSync(join(d, 'ship', 'checks.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, 'checks ' + process.argv[2] + '\\n'); process.exit(process.argv[2] === process.env.FAKE_FAIL_CHECK ? 1 : 0);`);
  writeFileSync(join(d, 'ship', 'poster-count.py'), '');
  return { EYES_DEPLOY_DIR: d, tools: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}
const WAITING = st(CONTEXT.ship, 'pending', 'run=77.1 mode=ship waiting-for-eyes'), RUN = { head_sha: SHA, path: '.github/workflows/release.yml', status: 'in_progress', run_attempt: 1 };
const posted = (f) => f.posts().split('\n').filter(Boolean).map((l) => l.match(/state=(\w+) -f context=(\S+) -f description=(.*?) --silent/).slice(1).join(' '));

test('eyes end to end (stand-in tools): ready, then the checks after released, then pass', () => {
  const f = fakeGh([WAITING], RUN, st(CONTEXT.ship, 'success', 'run=77.1 released')), d = fakeDeploy(f.t);
  const r = f.run(['--sha', SHA], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(posted(f), ['pending release/eyes run=77.1 ready', 'success release/eyes run=77.1 pass']);
  assert.deepEqual(d.tools().trim().split('\n'), [`probe we-${SHA.slice(0, 12)}`, 'probe released', 'walk.mjs', 'walk.mjs', 'checks walks', 'poster.mjs', 'checks poster', 'stall.mjs', 'checks stall']);
});

test('A6: a failing bar fails eyes, which posts failure naming it; a probe miss names the bar item', () => {
  let f = fakeGh([WAITING], RUN, st(CONTEXT.ship, 'success', 'run=77.1 released')), d = fakeDeploy(f.t);
  let r = f.run(['--sha', SHA], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR, FAKE_FAIL_CHECK: 'stall' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(posted(f), ['pending release/eyes run=77.1 ready', 'failure release/eyes run=77.1 fail: stall-verdict']);
  f = fakeGh([WAITING], RUN, st(CONTEXT.ship, 'success', 'run=77.1 released')); d = fakeDeploy(f.t);
  r = f.run(['--sha', SHA], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR, FAKE_PROBE_RC: '1', FAKE_PROBE_BAR: JSON.stringify({ pass: false, errorPages: 0, noBuild: ['a', 'b'], reconnectMaxMs: 9000 }) });
  assert.equal(r.status, 1);
  assert.equal(posted(f)[1], 'failure release/eyes run=77.1 fail: probe(noBuild=2,reconnectMaxMs=9000)');
  assert.ok(existsSync(join(f.t, 'out/probe-bar.json')));
});

test('A4: a ship that stops before the release fails eyes without walks, and the probe is told to stop', () => {
  const f = fakeGh([WAITING], RUN, st(CONTEXT.ship, 'failure', 'run=77.1 stopped: ship.sh exit 1 before the release')), d = fakeDeploy(f.t);
  const r = f.run(['--sha', SHA], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(posted(f), ['pending release/eyes run=77.1 ready', 'failure release/eyes run=77.1 fail: ship stopped before the release (ship.sh exit 1 before the release)']);
  assert.match(d.tools(), /probe stopped/); assert.doesNotMatch(d.tools(), /walk\.mjs|stall\.mjs/);
});

test('A10: a waiting status of an earlier attempt, or of a finished run, is skipped; nothing is posted for it', () => {
  let f = fakeGh([WAITING], { ...RUN, run_attempt: 2 }), d = fakeDeploy(f.t);
  let r = f.run(['--sha', SHA, '--find-min', '0.01'], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR });
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /not the live attempt/); assert.equal(f.posts(), ''); assert.equal(d.tools(), '');
  f = fakeGh([WAITING], { ...RUN, status: 'completed' }); d = fakeDeploy(f.t);
  r = f.run(['--sha', SHA, '--find-min', '0.01'], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR });
  assert.equal(r.status, 1); assert.equal(f.posts(), '');
  // the newest status of that attempt already says it stopped: not waiting any more
  f = fakeGh([st(CONTEXT.ship, 'failure', 'run=77.1 stopped: no eyes'), WAITING], RUN); d = fakeDeploy(f.t);
  r = f.run(['--sha', SHA, '--find-min', '0.01'], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR });
  assert.equal(r.status, 1); assert.equal(f.posts(), '');
});

test('B1: a probe that dies after ready fails eyes at once, before any release, and runs no walk', () => {
  const f = fakeGh([WAITING], RUN), d = fakeDeploy(f.t);
  const r = f.run(['--sha', SHA], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR, FAKE_PROBE_DIE: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(posted(f), ['pending release/eyes run=77.1 ready', 'failure release/eyes run=77.1 fail: the probe exited before the release']);
  assert.doesNotMatch(d.tools(), /walk\.mjs/);
});

test('B1: while it waits for the release, eyes re-posts ready every heartbeat', () => {
  const f = fakeGh([WAITING], RUN, st(CONTEXT.ship, 'success', 'run=77.1 released'), { delayReads: 12 }), d = fakeDeploy(f.t);
  const r = f.run(['--sha', SHA, '--heartbeat-s', '0.2'], { EYES_DEPLOY_DIR: d.EYES_DEPLOY_DIR });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = posted(f); assert.ok(p.filter((x) => x === 'pending release/eyes run=77.1 ready').length >= 3, p.join(' | '));
  assert.equal(p.at(-1), 'success release/eyes run=77.1 pass');
});
