// `pending --check` for an owner's scheduler (Engine v2 R20, #3328), against the real directory (`directoryd`, its
// mailbox), the real gateway (`gatewayd --mailbox`) and the world's end of it (`worldd gateway-link`), as R13's
// mail.test.mjs runs them. Run from v2/ after `cargo build -p gatewayd -p worldd -p directoryd --locked`, with
// replica's wasm-bindgen package in target/wasm-load/pkg. R20_REPORT=1 prints the timings, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const CLI = join(v2, 'client/src/cli/souls.mjs');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_r20test';
const WORLD_SCOPE = '2b'.repeat(16);
const LAMP = `${WORLD_SCOPE}-3`; // the Soul's own lamp (daemon.test.mjs says why)
const GRANT = `soul-${WORLD_SCOPE}-2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-r20-'));
const home = join(dir, '.souls');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const procs = [];
const report = {};
let directory, rt;

function run(path, args, ready) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = ready.exec(out); if (m) ok(m); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out}`)));
  });
}

async function waitFor(f, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
}

const mailbox = (path, body) => fetch(`http://${directory}/v1/mailbox/${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const ask = (req, ms = 5000) => request(rt.socket, req, ms);
/** The thin command as a scheduler runs it: its exit code, what it printed, and how long it took. */
const souls = (...args) => {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: performance.now() - t0 };
};
const sent = () => JSON.parse(readFileSync(rt.state, 'utf8')).sequence;
const arrivals = () => { try { return readFileSync(join(dir, 'world', 'arrivals.txt'), 'utf8'); } catch { return ''; } };

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt'), key = join(dir, 'mailbox.key');
  writeFileSync(tokens, `${GRANT} ${createHash('sha256').update(token).digest('hex')}\n`);
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  mkdirSync(join(dir, 'world', 'receipts'), { recursive: true });
  const wl = spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--arrivals', join(dir, 'world', 'arrivals.txt'), '--roots', join(dir, 'world', 'roots.txt'), '--rooms', '1', '--bodies', '4'], { stdio: 'ignore' });
  procs.push(wl);
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  [, directory] = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.db'), '--test-sign-in', '--mailbox-key', key], /listening on (\S+)\n/);
  const [, gateway] = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'world', 'receipts'), '--mailbox', directory, '--mailbox-key', key], /listening (\S+)\n/);
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gateway}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await call(home, SOUL, { op: 'status' }, { pkg: PKG });
  await waitFor(async () => (await ask({ op: 'status' })).connected, 10_000);
});

after(async () => {
  await ask({ op: 'stop' }).catch(() => {});
  if (process.env.R20_REPORT) console.log(JSON.stringify(report));
  await stopThenRemove(procs, dir);
});

test('A1: pending --check prints nothing; it exits 1 with nothing waiting, 0 while a message waits, 1 once it is served', async () => {
  await ask({ op: 'wait', seconds: 0 }); // what happened at sign-in, taken
  const idle = souls('pending', '--check');
  assert.deepEqual([idle.code, idle.out, idle.err], [1, '', ''], 'nothing waits');
  const { id } = await mailbox('put', { soul: GRANT, text: 'switch on your lamp' });
  const due = await waitFor(() => { const r = souls('pending', '--check'); return r.code === 0 && r; });
  assert.deepEqual([due.out, due.err], ['', ''], 'a message waits: exit 0, and nothing printed');
  assert.equal(souls('pending', '--check').code, 0, 'the check took nothing: it still waits');
  // A turn reads it and serves it with the thin command, as the scheduled prompt says.
  const read = JSON.parse(souls('wait', '0').out);
  assert.ok(read.events.some((e) => e.kind === 'mail' && e.id === id), JSON.stringify(read));
  const acted = JSON.parse(souls('act', `r2:switch_on:${LAMP}`, '--for', id).out);
  assert.equal(acted.ok, true, JSON.stringify(acted));
  const closed = await waitFor(async () => { const r = await mailbox('read', { id }); return r.state !== 'open' && r; });
  assert.equal(closed.state, 'done');
  await waitFor(() => souls('pending', '--check').code === 1);
  // A wake the budget lets through waits too; the check hands nothing (the reader still gets it).
  await ask({ op: 'wake', do: 'add', rule: { when: { event: 'eden:say', toMe: true }, why: 'someone spoke to you' } });
  await ask({ op: 'event', event: { name: 'eden:say', actor: 's_ada', toMe: true } });
  assert.equal(souls('pending', '--check').code, 0, 'a wake waits');
  assert.equal((await ask({ op: 'wait', seconds: 0 })).wakes?.length, 1, 'the check did not take it');
  await ask({ op: 'look' }); // the turn confirms it
  assert.equal(souls('pending', '--check').code, 1);
});

test('A2: with the daemon stopped, pending --check starts it and sends no intent', async () => {
  await ask({ op: 'stop' });
  await waitFor(() => !existsSync(rt.lock));
  const before = { sequence: sent(), arrivals: arrivals() };
  // A message written while the daemon is down is there once it signs in.
  const { id } = await mailbox('put', { soul: GRANT, text: 'are you there?' });
  const t0 = performance.now(), first = souls('pending', '--check');
  report.coldMs = Math.round(performance.now() - t0);
  assert.equal(first.out, '');
  assert.ok(existsSync(rt.lock), 'the daemon runs');
  const st = await ask({ op: 'status' });
  assert.equal(st.connected, true);
  report.coldFirstExit = first.code;
  assert.equal(first.code, 0, 'the message written while it was down is seen on the first check');
  await sleep(500);
  assert.equal(sent(), before.sequence, 'no intent: the sequence is unchanged');
  assert.equal((await ask({ op: 'status' })).sent, 0, 'nothing sent since it started');
  assert.equal(arrivals(), before.arrivals, 'nothing reached the world');
  await ask({ op: 'act', verb: 'r2:switch_off', target: LAMP, for: id }); // served, so A5 starts with nothing waiting
  await waitFor(async () => (await mailbox('read', { id })).state !== 'open');
});

test('A5: with the daemon up, its median time is under 100 ms', async () => {
  await waitFor(() => souls('pending', '--check').code === 1);
  const ms = [];
  for (let k = 0; k < 21; k++) {
    const r = souls('pending', '--check');
    assert.equal(r.code, 1);
    ms.push(r.ms);
  }
  ms.sort((a, b) => a - b);
  report.medianMs = Math.round(ms[10]);
  report.rangeMs = [Math.round(ms[0]), Math.round(ms[20])];
  assert.ok(ms[10] < 100, `median ${ms[10]} ms`);
});

test('help schedule-wake gives the gated line for any harness, Claude Code and Codex', () => {
  const h = JSON.parse(souls('help', 'schedule-wake').out);
  assert.equal(h.ok, true);
  for (const k of ['any', 'claude', 'codex']) assert.match(h.command[k], /pending --check && /);
  assert.match(h.command.claude, /claude -p '.*' --allowedTools 'Bash\(node:\*\)'$/);
  assert.match(h.prompt, / pending\. For each message under open/);
  assert.match(h.prompt, /ack <its id>/);
  assert.match(h.prompt, /--for <its id>/);
});
