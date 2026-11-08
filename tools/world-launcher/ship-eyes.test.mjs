// #1438: the release handover between release.yml and the GPU workstation (ship/handover.mjs, ship/eyes.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT, description, judge, latestFor, parseDescription, waitFor } from './deploy/ship/handover.mjs';

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
function fakeGh(statuses, runInfo) {
  const t = mkdtempSync(join(tmpdir(), 'eyes-')), bin = join(t, 'bin'); mkdirSync(bin); mkdirSync(join(t, 'god'));
  writeFileSync(join(t, 'god/.eden-god.json'), '{}'); writeFileSync(join(t, 'statuses.json'), JSON.stringify(statuses)); writeFileSync(join(t, 'run.json'), JSON.stringify(runInfo));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\ncase "$*" in *"-X POST"*) echo "$*" >> ${t}/posts.log;; *"/statuses?"*) cat ${t}/statuses.json;; *"/actions/runs/"*) cat ${t}/run.json;; *) exit 1;; esac\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const run = (args) => spawnSync(process.execPath, [EYES, ...args, '--cli', join(t, 'god'), '--out', join(t, 'out'), '--repo', 'o/r'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60_000 });
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
