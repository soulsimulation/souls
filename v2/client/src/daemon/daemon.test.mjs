// The resident daemon (Engine v2 R6, #2700) against the real gateway (`gatewayd`, I1) and the world's stand-in end
// of it (`worldd gateway-link`), through a TCP relay that the test cuts to force drops. Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// R6_REPORT=1 prints each drop's time and the memory, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request, start } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_r6test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-r6-'));
const home = join(dir, '.souls');
const scope = randomBytes(16).toString('hex');
const secret = randomBytes(32).toString('hex'); // the canary: the token's secret part
const token = `soul-${scope}-7.${secret}`;
const procs = [];
const outputs = []; // every answer and message a command printed
let relay, arrivals, rt;

/**
 * A TCP relay to the gateway: `cut()` closes every connection; `deaf` drops what the gateway sends meanwhile;
 * `refuse` closes each new connection at once.
 */
function makeRelay(port) {
  const pairs = new Set();
  const r = { deaf: false, refuse: false, port: 0, cut: () => { for (const [a, b] of pairs) { a.destroy(); b.destroy(); } pairs.clear(); } };
  const server = createServer((down) => {
    if (r.refuse) { down.destroy(); return; }
    const up = createConnection(port, '127.0.0.1');
    pairs.add([down, up]);
    down.on('data', (d) => up.write(d));
    up.on('data', (d) => { if (!r.deaf) down.write(d); });
    for (const s of [down, up]) { s.on('error', () => {}); s.on('close', () => { down.destroy(); up.destroy(); }); }
  });
  r.server = server;
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { r.port = server.address().port; ok(r); }));
}

function run(bin, args, ready) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = ready.exec(out); if (m) ok(m); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => fail(new Error(`${bin} ended (${c}): ${out}`)));
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

const status = async () => { const s = await request(rt.socket, { op: 'status' }); outputs.push(JSON.stringify(s)); return s; };
const taken = () => readFileSync(arrivals, 'utf8').split('\n').filter(Boolean);

before(async () => {
  const world = join(dir, 'w.sock');
  arrivals = join(dir, 'arrivals.txt');
  const tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `soul-${scope}-7 ${createHash('sha256').update(token).digest('hex')}\n`);
  const lineage = randomBytes(16).toString('hex');
  const wl = spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', lineage, '--epoch', '1', '--arrivals', arrivals, '--room', '1000'], { stdio: 'ignore' });
  procs.push(wl);
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const [, addr] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  relay = await makeRelay(Number(addr.split(':').pop()));
  spawnSync('mkdir', ['-p', home]);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://127.0.0.1:${relay.port}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
});

after(async () => {
  await request(rt.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  relay?.server.close();
  relay?.cut();
  rmSync(dir, { recursive: true, force: true });
});

test('A1: the first command starts it, and it outlives the command that started it', async () => {
  const cli = join(v2, 'client/src/daemon/client.mjs');
  const first = spawnSync(process.execPath, [cli, 'status'], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8' });
  outputs.push(first.stdout, first.stderr);
  const said = JSON.parse(first.stdout);
  assert.equal(said.started, true, first.stdout);
  assert.equal(first.status, 0);
  // The command has ended; the daemon still answers, and signs in to the gateway.
  const s = await waitFor(async () => { const s = await status(); return s.connected && s; });
  assert.equal(s.pid, said.pid);
});

test('A3: a second start for the same Soul is refused by name', async () => {
  const s = await status();
  const second = spawnSync(process.execPath, [join(v2, 'client/src/daemon/daemon.mjs'), '--home', home, '--soul', SOUL, '--pkg', PKG], { encoding: 'utf8', timeout: 10_000 });
  outputs.push(second.stdout, second.stderr);
  assert.equal(second.status, 3);
  assert.match(second.stderr, new RegExp(`^daemon-already-running: ${SOUL} has a daemon, pid ${s.pid}\\n$`));
  assert.equal((await status()).pid, s.pid, 'the first keeps running');
  // Through the client as well: start() spawns one, it refuses itself, and the first still answers.
  start(home, SOUL, PKG);
  await sleep(500);
  assert.equal((await status()).pid, s.pid);
});

test('A2: after each of ten forced drops it is current within 2 s, and no intent is sent twice', async () => {
  const times = [];
  for (let k = 0; k < 10; k++) {
    // An intent answered while connected.
    const a = await request(rt.socket, { op: 'act', verb: 'eden:wave' });
    outputs.push(JSON.stringify(a));
    await waitFor(async () => (await status()).unanswered.length === 0);
    // Another, whose answer the world gives while the relay drops what comes back; then the drop.
    relay.deaf = true;
    const b = await request(rt.socket, { op: 'act', verb: 'eden:wave' });
    outputs.push(JSON.stringify(b));
    await waitFor(() => taken().length === b.sequence);
    await sleep(50);
    const dropped = performance.now();
    relay.cut();
    relay.deaf = false;
    // Current: signed in again, every intent the world took is answered, and the cursor is the newest answer's.
    const s = await waitFor(async () => {
      const s = await status();
      return s.connected && s.unanswered.length === 0 && s.answered === taken().length && s;
    }, 5000);
    times.push(performance.now() - dropped);
    const events = (await request(rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer');
    assert.equal(events.at(-1).sequence, b.sequence);
    assert.equal(s.cursor, events.at(-1).version);
  }
  const s = await status();
  assert.ok(s.drops >= 10, `drops ${s.drops}`);
  assert.equal(s.resumed, s.connects - 1, 'every sign-in after the first resumed');
  // Sent once each: 20 acts, 20 sends, and the world took sequences 1..20 once each, in order.
  assert.equal(s.sent, 20);
  assert.deepEqual(taken().map((l) => Number(l.split(' ')[1])), Array.from({ length: 20 }, (_, i) => i + 1));
  if (process.env.R6_REPORT) console.log(JSON.stringify({ dropsMs: times.map((t) => Math.round(t)), rssBytes: s.rssBytes, heapBytes: s.heapBytes, connects: s.connects, resumed: s.resumed }));
  for (const t of times) assert.ok(t < 2000, `current ${Math.round(t)} ms after a drop`);
});

test('R5b A2, A3: told stream.cannot-resume, it compares and descends through the gateway, ends current and resumes', async () => {
  const before = await status();
  const snapshot = before.syncs.find((x) => x.kind === 'snapshot');
  assert.ok(snapshot, 'its first sign-in took its scope whole');
  // A cut long enough that resume fails: the relay drops all the gateway sends while the world answers more intents
  // than the gateway keeps for a grant (256), then the connection is cut.
  relay.deaf = true;
  const n = 300, already = taken().length;
  for (let k = 0; k < n; k++) outputs.push(JSON.stringify(await request(rt.socket, { op: 'act', verb: 'eden:wave' })));
  await waitFor(() => taken().length === already + n, 20_000);
  await sleep(50);
  const cut = performance.now();
  relay.cut();
  relay.deaf = false;
  const s = await waitFor(async () => { const s = await status(); return s.connected && s.cannotResume > before.cannotResume && s; }, 10_000);
  const currentMs = performance.now() - cut;
  const resync = s.syncs.at(-1);
  assert.equal(resync.kind, 'resync');
  assert.equal(s.cannotResume, before.cannotResume + 1);
  // Current: its copy's hash of the place is the world's after the last intent the world took.
  assert.deepEqual(Object.values(s.roots), [taken().at(-1).split(' ')[2]]);
  // A3: fewer records and bytes than a snapshot of the same scope.
  assert.ok(resync.fetched < resync.held, `fetched ${resync.fetched} of ${resync.held}`);
  assert.ok(resync.got < resync.heldBytes, `got ${resync.got} B, a snapshot ${resync.heldBytes} B`);
  // The stream carries on from the hashes' version: an intent is answered, and the next drop resumes.
  const answered = s.answered;
  const a = await request(rt.socket, { op: 'act', verb: 'eden:wave' });
  outputs.push(JSON.stringify(a));
  await waitFor(async () => (await status()).answered === answered + 1);
  relay.cut();
  const after = await waitFor(async () => { const x = await status(); return x.connected && x.resumed > s.resumed && x; });
  assert.equal(after.cannotResume, s.cannotResume, 'resumed, not synced again');
  assert.equal(after.syncs.length, s.syncs.length);
  if (process.env.R5B_REPORT) console.log(JSON.stringify({ snapshot, resync, currentMs: Math.round(currentMs) }));
});

test('R10 A1, A2, A3: every answer carries its age; a copy cut off for 30 s says so within 10 s; then asleep, not stale', async () => {
  const ask = async (req) => { const t = performance.now(); const a = await request(rt.socket, req, 10_000); outputs.push(JSON.stringify(a)); return { ...a, ms: Math.round(performance.now() - t) }; };
  const seen = []; // the transcript of answers, for the PR
  const keep = (op, t0, a) => seen.push({ s: Math.round((performance.now() - t0) / 100) / 10, op, age: a.age, ...(a.gap ? { gap: a.gap } : {}), ...(a.asleep ? { asleep: a.asleep } : {}) });
  // A1: every answer, of every command, carries a numeric age.
  const { answered } = await waitFor(async () => { const s = await status(); return s.connected && s; });
  const act = await ask({ op: 'act', verb: 'eden:wave' });
  await waitFor(async () => (await status()).answered > answered);
  for (const req of [{ op: 'status' }, { op: 'look' }, { op: 'find', words: 'cup' }, { op: 'wait', seconds: 0 }, { op: 'read' }, { op: 'stats' }, { op: 'nonsense' }]) {
    const a = await ask(req);
    assert.equal(typeof a.age, 'number', `${req.op}: ${JSON.stringify(a).slice(0, 200)}`);
  }
  assert.equal(typeof act.age, 'number');
  const fresh = await ask({ op: 'look' });
  assert.equal(fresh.gap, undefined);
  assert.ok(fresh.age < 2000, `age ${fresh.age}`);
  // A2: cut off for 30 s. First a black hole (the socket stays open, nothing comes back), then the connection cut
  // and every new one refused.
  const t0 = performance.now();
  relay.deaf = true;
  let firstSaid = null;
  while (performance.now() - t0 < 30_000) {
    if (!relay.refuse && performance.now() - t0 > 15_000) { relay.refuse = true; relay.cut(); }
    const a = await ask({ op: 'look' });
    keep('look', t0, a);
    if (a.gap && a.stale && firstSaid === null) firstSaid = performance.now() - t0;
    // Once it has said so, every answer says so, and the gap only grows.
    if (firstSaid !== null) {
      assert.ok(a.stale && a.gap, JSON.stringify(a).slice(0, 300));
      const before = seen.at(-2);
      if (before?.gap) assert.ok(a.gap.ms >= before.gap.ms, `${a.gap.ms} after ${before.gap.ms}`);
    }
    await sleep(1000);
  }
  assert.ok(firstSaid !== null && firstSaid < 10_000, `said so ${Math.round(firstSaid)} ms after the cut`);
  const last = seen.at(-1);
  assert.ok(last.gap.ms > 25_000 && last.age > 25_000, JSON.stringify(last));
  // Restored: current again, and since this world has written nothing for over 30 s, asleep since then, not stale.
  relay.refuse = false; relay.deaf = false; relay.cut();
  const back = await waitFor(async () => { const a = await ask({ op: 'look' }); return !a.gap && a; }, 15_000);
  keep('look', t0, back);
  assert.equal(back.stale, undefined);
  assert.ok(back.age < 2000, `age ${back.age}`);
  assert.ok(back.asleep?.sinceMs > 30_000, JSON.stringify(back.asleep));
  // A3: stats over what this daemon did: every achieved intent's commands, bytes and first send.
  const st = await ask({ op: 'stats' });
  assert.ok(st.achieved >= 21, `achieved ${st.achieved}`);
  // Each has its commands and bytes; the one after R5b's 300 sends whose answers the cut lost has an unanswered first send.
  assert.ok(st.last.every((x) => x.commands >= 1 && x.bytes > 0 && x.tokens.estimate && x.turns === undefined), JSON.stringify(st.last));
  assert.deepEqual(Object.keys(st.firstSend).filter((c) => st.firstSend[c] > 0).sort(), ['accepted-first', 'unanswered']);
  assert.equal(st.firstSend.unanswered, 1);
  assert.equal(st.harness.startsWith('not opted in'), true);
  if (process.env.R10_REPORT) console.log(JSON.stringify({ firstSaidMs: Math.round(firstSaid), answers: seen, stats: { ...st, last: st.last.slice(-2) } }));
});

test('A4: the token is in no output, argument, environment variable or file but credentials.json', async () => {
  const { pid } = await status();
  const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  assert.match(args, /daemon\.mjs/);
  assert.ok(!args.includes(secret), 'not in its arguments');
  // `ps e` shows a process's environment after its arguments, on macOS and Linux alike.
  const env = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  assert.ok(!env.includes(secret), 'not in its environment');
  assert.ok(!env.includes('SOULS_HOME'), 'it was given none of the caller\'s variables');
  for (const o of outputs) assert.ok(!String(o).includes(secret), 'not in any output');
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(home);
  const named = files.filter((f) => !f.endsWith('credentials.json'));
  assert.ok(named.some((f) => f.endsWith('daemon.log')) && named.some((f) => f.endsWith('daemon.json')));
  for (const f of named) assert.ok(!readFileSync(f, 'latin1').includes(secret), `not in ${f.slice(home.length)}`);
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
});
