// The resident daemon (Engine v2 R6, #2700) against the real gateway (`gatewayd`, I1) and the world's end of it
// (`worldd gateway-link`, I4's world of lamps), through a TCP relay that the test cuts to force drops. Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// R6_REPORT=1 prints each drop's time and the memory, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request, start } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_r6test';
// The Soul is the world's first body, beside its own lamp: `worldd gateway-link`'s world mints from scope 2b, the
// place first, then the room, then each body and its lamp (`worldd::checkers::toggles`).
const WORLD_SCOPE = '2b'.repeat(16);
const LAMP = `${WORLD_SCOPE}-3`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A replaced daemon asks whether the Soul is free this often (5 min in use).
process.env.SOULS_REPLACED_RETRY_MS = '1500';

const dir = mkdtempSync(join(tmpdir(), 'souls-r6-'));
const home = join(dir, '.souls');
const scope = WORLD_SCOPE;
const secret = randomBytes(32).toString('hex'); // the canary: the token's secret part
const token = `soul-${scope}-2.${secret}`; // the world's first body
const procs = [];
const outputs = []; // every answer and message a command printed
let relay, arrivals, roots, rt;

/**
 * A TCP relay to the gateway: `cut()` closes every connection; `deaf` drops what the gateway sends meanwhile;
 * `refuse` closes each new connection at once; `stall(true)` moves no byte either way on any connection, new ones too,
 * and closes none (a stalled network), until `stall(false)` lets what waited through.
 */
function makeRelay(port) {
  const pairs = new Set();
  const r = {
    deaf: false, refuse: false, stalled: false, port: 0,
    cut: () => { for (const [a, b] of pairs) { a.destroy(); b.destroy(); } pairs.clear(); },
    stall: (on) => { r.stalled = on; for (const pair of pairs) for (const s of pair) if (on) s.pause(); else s.resume(); },
  };
  const server = createServer((down) => {
    if (r.refuse) { down.destroy(); return; }
    const up = createConnection(port, '127.0.0.1');
    pairs.add([down, up]);
    if (r.stalled) { down.pause(); up.pause(); }
    down.on('data', (d) => up.write(d));
    up.on('data', (d) => { if (!r.deaf) down.write(d); });
    for (const s of [down, up]) { s.on('error', () => {}); s.on('close', () => { down.destroy(); up.destroy(); }); }
  });
  r.server = server;
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { r.port = server.address().port; ok(r); }));
}

const printed = {}; // each process's output, by binary name, for a timeout's message
function run(bin, args, ready) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  const name = bin.split('/').pop();
  printed[name] = '';
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; printed[name] += d; const m = ready.exec(out); if (m) ok(m); });
    p.stderr.on('data', (d) => { out += d; printed[name] += d; });
    p.on('exit', (c) => fail(new Error(`${bin} ended (${c}): ${out}`)));
  });
}

/** The last lines of the daemon's log and of each process's output: what a timeout says, so CI shows why. */
function tails(n = 40) {
  const last = (text) => text.split('\n').slice(-n).join('\n');
  let daemon = '';
  try { daemon = readFileSync(rt.log, 'utf8'); } catch { /* not started yet */ }
  return [`daemon.log:\n${last(daemon)}`, ...Object.entries(printed).map(([k, v]) => `${k}:\n${last(v)}`)].join('\n');
}

async function waitFor(f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out\n${tails()}`);
    await sleep(10);
  }
}

const status = async () => { const s = await request(rt.socket, { op: 'status' }); outputs.push(JSON.stringify(s)); return s; };
const taken = () => readFileSync(arrivals, 'utf8').split('\n').filter(Boolean);
const changes = () => readFileSync(roots, 'utf8').split('\n').filter(Boolean); // one line per tick that changed the world
const placeHash = () => changes().at(-1)?.split(' ')[1];

before(async () => {
  const world = join(dir, 'w.sock');
  arrivals = join(dir, 'arrivals.txt');
  roots = join(dir, 'roots.txt');
  const tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `soul-${scope}-2 ${createHash('sha256').update(token).digest('hex')}\n`);
  const lineage = randomBytes(16).toString('hex');
  const wl = spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', lineage, '--epoch', '1', '--arrivals', arrivals, '--roots', roots, '--rooms', '1', '--bodies', '500'], { stdio: 'ignore' });
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
  relay?.server.close();
  relay?.cut();
  await stopThenRemove(procs, dir);
});

test('A1: the first command starts it, and it outlives the command that started it', async () => {
  const cli = join(v2, 'client/src/daemon/client.mjs');
  const first = spawnSync(process.execPath, [cli, 'status'], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG, SOULS_REPLACED_RETRY_MS: process.env.SOULS_REPLACED_RETRY_MS }, encoding: 'utf8' });
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
  const second = spawnSync(process.execPath, [join(v2, 'client/src/daemon/daemon.mjs'), '--home', home, '--soul', SOUL, '--pkg', PKG], { encoding: 'utf8', timeout: 30_000 });
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
    // An intent answered while connected: its lamp on.
    const a = await request(rt.socket, { op: 'act', verb: 'r2:switch_on', target: LAMP });
    outputs.push(JSON.stringify(a));
    await waitFor(async () => (await status()).unanswered.length === 0);
    // Another, whose answer the world gives while the relay drops what comes back; then the drop.
    relay.deaf = true;
    const b = await request(rt.socket, { op: 'act', verb: 'r2:switch_off', target: LAMP });
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
    }, 30_000);
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
  assert.equal(changes().length, 20, 'each act switched the lamp, in a tick of its own');
  if (process.env.R6_REPORT) console.log(JSON.stringify({ dropsMs: times.map((t) => Math.round(t)), rssBytes: s.rssBytes, heapBytes: s.heapBytes, connects: s.connects, resumed: s.resumed }));
  // A speed bar (real time): asserted only in the speed-bar step (ci.sh, V2_SPEED_BARS=1); R6_REPORT prints it.
  if (process.env.V2_SPEED_BARS) for (const t of times) assert.ok(t < 2000, `current ${Math.round(t)} ms after a drop`);
});

test('R5b A2, A3: told stream.cannot-resume, it compares and descends through the gateway, ends current and resumes', async () => {
  // The previous answer can precede its replica update: establish the current OFF root before missing the next ON.
  const before = await waitFor(async () => {
    const s = await status(), roots = Object.values(s.roots);
    return s.connected && roots.length === 1 && roots[0] === placeHash() && s;
  }, 30_000);
  const snapshot = before.syncs.find((x) => x.kind === 'snapshot');
  assert.ok(snapshot, 'its first sign-in took its scope whole');
  // A cut long enough that resume fails: the relay drops all the gateway sends while the world answers more intents
  // than the gateway keeps for a grant (256), then the connection is cut. The first switches the Soul's lamp on, so
  // the place changes while it is away; the rest find it on already and are refused.
  relay.deaf = true;
  const n = 300, already = taken().length, was = placeHash();
  for (let k = 0; k < n; k++) outputs.push(JSON.stringify(await request(rt.socket, { op: 'act', verb: 'r2:switch_on', target: LAMP })));
  await waitFor(() => taken().length === already + n, 20_000);
  await waitFor(() => placeHash() !== was);
  await sleep(50);
  const cut = performance.now();
  relay.cut();
  relay.deaf = false;
  const s = await waitFor(async () => { const s = await status(); return s.connected && s.cannotResume > before.cannotResume && s; }, 30_000);
  const currentMs = performance.now() - cut;
  const resync = s.syncs.at(-1);
  assert.equal(resync.kind, 'resync');
  assert.equal(s.cannotResume, before.cannotResume + 1);
  // Current: its copy's hash of the place is the world's after the last intent the world took.
  assert.deepEqual(Object.values(s.roots), [placeHash()]);
  // A3: fewer records and bytes than a snapshot of the same scope, and what changed among them.
  assert.ok(resync.changed > 0 && resync.fetched > 0, `changed ${resync.changed}, fetched ${resync.fetched}`);
  assert.ok(resync.fetched < resync.held, `fetched ${resync.fetched} of ${resync.held}`);
  assert.ok(resync.got < resync.heldBytes, `got ${resync.got} B, a snapshot ${resync.heldBytes} B`);
  // The stream carries on from the hashes' version: an intent is answered, and the next drop resumes.
  const a = await request(rt.socket, { op: 'act', verb: 'r2:switch_off', target: LAMP });
  outputs.push(JSON.stringify(a));
  const answer = await waitFor(async () =>
    (await request(rt.socket, { op: 'read' })).events.find((e) => e.kind === 'answer' && e.sequence === a.sequence));
  assert.equal(answer.answer, 1, JSON.stringify(answer));
  relay.cut();
  const after = await waitFor(async () => { const x = await status(); return x.connected && x.resumed > s.resumed && x; });
  assert.equal(after.cannotResume, s.cannotResume, 'resumed, not synced again');
  assert.equal(after.syncs.length, s.syncs.length);
  if (process.env.R5B_REPORT) console.log(JSON.stringify({ snapshot, resync, currentMs: Math.round(currentMs) }));
});

test('R10 A1, A2, A3: every answer carries its age; a copy cut off for 30 s says so within 10 s; then asleep, not stale', async () => {
  const ask = async (req) => { const t = performance.now(); const a = await request(rt.socket, req, 30_000); outputs.push(JSON.stringify(a)); return { ...a, ms: Math.round(performance.now() - t) }; };
  const seen = []; // the transcript of answers, for the PR
  const keep = (op, t0, a) => seen.push({ s: Math.round((performance.now() - t0) / 100) / 10, op, age: a.age, ...(a.gap ? { gap: a.gap } : {}), ...(a.unchangedMs ? { unchangedMs: a.unchangedMs } : {}) });
  // A1: every answer, of every command, carries a numeric age.
  const { answered } = await waitFor(async () => { const s = await status(); return s.connected && s; });
  const act = await ask({ op: 'act', verb: 'eden:wave' });
  await waitFor(async () => (await status()).answered > answered);
  for (const req of [{ op: 'status' }, { op: 'look' }, { op: 'find', words: 'item' }, { op: 'wait', seconds: 0 }, { op: 'read' }, { op: 'stats' }, { op: 'nonsense' }]) {
    const a = await ask(req);
    assert.equal(typeof a.age, 'number', `${req.op}: ${JSON.stringify(a).slice(0, 200)}`);
  }
  assert.equal(typeof act.age, 'number');
  // A drop left by the tests before (R5b's forced ones) may still be resyncing: the fresh look is the first current one.
  const fresh = await waitFor(async () => { const a = await ask({ op: 'look' }); return !a.gap && a; }, 10_000);
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
  const back = await waitFor(async () => { const a = await ask({ op: 'look' }); return !a.gap && a; }, 30_000);
  keep('look', t0, back);
  assert.equal(back.stale, undefined);
  assert.ok(back.age < 2000, `age ${back.age}`);
  assert.ok(back.unchangedMs > 30_000, `unchangedMs ${JSON.stringify(back)} ${JSON.stringify(seen.slice(-4))}`);
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

test('R8 A3, A4: checked on the copy and at send time; only a current copy refuses; unknown never blocks; basis is what was shown', async () => {
  const ask = async (req) => { const a = await request(rt.socket, req, 30_000); outputs.push(JSON.stringify(a)); return a; };
  // A kind entry for the world's lamps: field 1 named, and a form that needs it unset. The Soul's own lamp is lit, the
  // rest are not.
  mkdirSync(join(home, 'kinds'), { recursive: true });
  writeFileSync(join(home, 'kinds', 'lamp.json'), JSON.stringify({ format: 'souls-entry/1', kind: 'r2:lamp', owner: 'thing',
    state: { mark: { n: 1, type: 'int', default: 0, audience: { rule: 'everyone' } } },
    forms: { fresh: { who: 'anyone', starts: 'act', needs: [{ need: 'state', field: 'mark', is: 0 }], effects: [] } } }));
  await waitFor(async () => (await status()).connected);
  const lit = (await status()).answered;
  await ask({ op: 'act', verb: 'r2:switch_on', target: LAMP });
  await waitFor(async () => (await status()).answered > lit);
  const { found } = await ask({ op: 'find', words: 'lamp', limit: 50 });
  const verdicts = [];
  for (const f of [{ id: LAMP }, ...found.filter((x) => x.id !== LAMP)]) verdicts.push({ id: f.id, ...(await ask({ op: 'can', intent: { verb: 'eden:wave', this: f.id, form: 'fresh' } })) });
  const marked = verdicts.find((v) => v.can === 'no'), unmarked = verdicts.find((v) => v.can === 'yes');
  assert.ok(marked && unmarked, JSON.stringify(verdicts.slice(0, 3)));
  assert.equal(marked.reason, 'field_differs');
  assert.equal(marked.current, true);
  assert.equal(typeof marked.age, 'number');
  const cand = (v) => ({ verb: 'eden:wave', this: v.id, form: 'fresh' });
  // A current `no`: stopped locally, with what changed, and nothing sent.
  const before = (await status()).sent;
  const stop = await ask({ op: 'act', verbs: [cand(marked)] });
  assert.equal(stop.code, 'stopped-locally', JSON.stringify(stop));
  assert.equal(stop.dropped[0].reason, 'field_differs');
  assert.ok('changed' in stop);
  assert.equal((await status()).sent, before);
  // A ranked list: the dead candidate leaves, the live one goes.
  const two = await ask({ op: 'act', verbs: [cand(marked), cand(unmarked)] });
  assert.equal(two.ok, true, JSON.stringify(two));
  assert.equal(two.checked, true);
  assert.equal(two.dropped.length, 1);
  // Unknown never blocks: a bare verb, a thing not in the copy, a kind with no entry held (the room).
  const room = (await ask({ op: 'find', words: 'room' })).found[0];
  const unknowns = [['eden:wave'], [{ verb: 'eden:wave', this: 'nowhere-1', form: 'fresh' }], ...(room ? [[{ verb: 'eden:wave', this: room.id, form: 'fresh' }]] : [])];
  for (const verbs of unknowns) {
    const a = await ask({ op: 'act', verbs });
    assert.equal(a.ok, true, JSON.stringify(a));
  }
  // Not current (the gateway cut, every connection refused): the same dead candidate is sent; the world decides.
  relay.refuse = true; relay.cut();
  await waitFor(async () => !(await status()).connected);
  const blind = await ask({ op: 'act', verbs: [cand(marked)] });
  assert.equal(blind.ok, true, JSON.stringify(blind));
  assert.equal(blind.checked, false);
  assert.ok(blind.gap && blind.stale);
  relay.refuse = false;
  await waitFor(async () => { const s = await status(); return s.connected && s.queued === 0; }, 30_000);
  // A4: the basis is the version the model was last shown, not the one the send-time check brought the copy to.
  const shown = await ask({ op: 'look' });
  const moved = await ask({ op: 'act', verb: 'r2:switch_off', target: LAMP }); // the world moves on
  await waitFor(async () => !(await status()).unanswered.includes(moved.sequence));
  const later = await ask({ op: 'act', verbs: [cand(unmarked)] });
  assert.equal(later.basis, shown.at + 0, JSON.stringify(later));
  assert.ok(later.at > shown.at, `${later.at} after ${shown.at}`);
  if (process.env.R8_REPORT) console.log(JSON.stringify({ can: marked, stop, two, blind: { ok: blind.ok, checked: blind.checked, gap: blind.gap }, basis: later.basis, at: later.at }));
});

test('#3604: the thin set-down command reaches the world and is answered once, refused by name when nothing is held', async () => {
  const bad = await request(rt.socket, { op: 'set-down', this: 'no-id' });
  assert.equal(bad.code, 'set-down-names-a-thing', JSON.stringify(bad));
  const a = await request(rt.socket, { op: 'set-down', this: LAMP, word: 'here' });
  outputs.push(JSON.stringify(a));
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.verb, 'hands:set-down');
  const answer = await waitFor(async () =>
    (await request(rt.socket, { op: 'read' })).events.find((e) => e.kind === 'answer' && e.sequence === a.sequence));
  // This world's Soul holds no lamp: a refusal by name (`setdown-off` where the world runs no engine), never a move.
  assert.equal(answer.answer, 2, JSON.stringify(answer));
  assert.ok(['not-held', 'setdown-off', 'intent.no-body'].includes(answer.reason), JSON.stringify(answer));
});

test('#3346: answers that share a version are counted as seen, so a resume gives none of them twice', async () => {
  // The lamp on (a new version), then three refusals at that same version; every answer taken.
  const acts = [];
  for (let k = 0; k < 4; k++) acts.push((await request(rt.socket, { op: 'act', verb: 'r2:switch_on', target: LAMP })).sequence);
  await waitFor(async () => { const s = await status(); return acts.every((q) => !s.unanswered.includes(q)); });
  const versions = new Set((await request(rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer' && acts.includes(e.sequence)).map((e) => e.version));
  assert.equal(versions.size, 1, `the four answers at one version: ${[...versions]}`);
  const { resumed } = await status();
  relay.cut();
  await waitFor(async () => { const s = await status(); return s.connected && s.resumed > resumed; });
  await sleep(300);
  const again = (await request(rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer' && acts.includes(e.sequence));
  assert.deepEqual(again, [], 'no answer given twice');
});

test('#4700: a copy confirmed within 1 s answers at once, the world not asked; a still copy is confirmed with no command', async () => {
  await waitFor(async () => { const s = await status(); return s.connected && !s.syncing; });
  assert.equal((await request(rt.socket, { op: 'look' })).stale, undefined);
  // The gateway's answers dropped: a look just after a confirmed one does not wait on the world (before, it waited its
  // refresh's 2 s and said stale). A follow under way in a busy world is the case this stands for.
  relay.deaf = true;
  try {
    const t = performance.now(), a = await request(rt.socket, { op: 'look' });
    outputs.push(JSON.stringify(a));
    assert.ok(performance.now() - t < 1000, `answered in ${Math.round(performance.now() - t)} ms`);
    assert.equal(a.stale, undefined, JSON.stringify(a).slice(0, 300));
    assert.ok(a.age < 1000, `age ${a.age}`);
  } finally {
    relay.deaf = false;
  }
  // No command for 9 s in a still world: an act's answer, which does not ask, comes from a copy the daemon confirmed
  // by itself seconds ago, not one `unconfirmed` since the last command (FRESH_MS, 8 s).
  await sleep(9000);
  const act = await request(rt.socket, { op: 'act', verb: 'eden:wave' });
  outputs.push(JSON.stringify(act));
  assert.equal(act.stale, undefined, JSON.stringify(act).slice(0, 300));
  assert.ok(act.age < 6000, `age ${act.age}`);
});

test('another client of the Soul takes it: this one is told so, never takes it from the live one, takes it once that one has gone or at its own next command', async () => {
  await waitFor(async () => (await status()).connected);
  const other = join(dir, 'other', '.souls');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'config.json'), readFileSync(join(home, 'config.json')));
  writeFileSync(join(other, 'credentials.json'), readFileSync(join(home, 'credentials.json')), { mode: 0o600 });
  const otherRt = runtimeOf(other, SOUL);
  const otherStatus = () => request(otherRt.socket, { op: 'status' }).catch(() => null);
  const startOther = async () => {
    start(other, SOUL, PKG);
    await waitFor(async () => (await otherStatus())?.connected, 60_000);
  };
  const stopOther = async () => {
    const pid = (await otherStatus())?.pid;
    await request(otherRt.socket, { op: 'stop' }).catch(() => {});
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 10_000);
  };
  try {
    await startOther();
    const s = await waitFor(async () => { const s = await status(); return s.replaced && !s.connected && s; }, 10_000);
    assert.match(s.replaced.say, /Another client of this Soul connected/);
    // Reading what came and asking for a receipt do not take it back, nor do its asks whether the Soul is free
    // (every REPLACED_RETRY_MS: 1.5 s here). Two clients took the Soul from each other about seven times a second.
    await request(rt.socket, { op: 'read' });
    await request(rt.socket, { op: 'receipt' });
    await sleep(4000);
    const later = await status();
    assert.ok(later.replaced && !later.connected, 'still off while the other holds the Soul');
    assert.ok(later.connects >= s.connects + 2, `asked whether the Soul is free: ${later.connects - s.connects} times`);
    assert.equal((await otherStatus()).connected, true, 'the other keeps the Soul');
    // The other goes: this one signs in again by itself, at its next ask.
    await stopOther();
    await waitFor(async () => { const s = await status(); return s.connected && !s.replaced; }, 10_000);
    // Taken again; its own agent's next command takes it back, and the other, replaced in turn, never takes it.
    await startOther();
    await waitFor(async () => { const s = await status(); return s.replaced && !s.connected; }, 10_000);
    const a = await request(rt.socket, { op: 'act', verb: 'r2:switch_on', target: LAMP });
    outputs.push(JSON.stringify(a));
    // (An earlier test's wave is never answered by this world of lamps: only this act's answer is waited for.)
    await waitFor(async () => { const s = await status(); return s.connected && !s.replaced && !s.unanswered.includes(a.sequence); }, 30_000);
    await waitFor(async () => (await otherStatus())?.replaced, 10_000);
    const held = await status();
    await sleep(4000);
    const after4 = await status();
    assert.ok(after4.connected && !after4.replaced, 'this one keeps the Soul');
    assert.equal(after4.connects, held.connects, 'and never lost it to the other\'s asks');
    assert.ok((await otherStatus()).connects >= 3, 'the other asked');
  } finally {
    await stopOther().catch(() => {});
  }
});

test('#4980: a socket given up over a stalled network is let go at once; an act then is held, sent at the next sign-in and answered once; that sign-in is not held back', async () => {
  await waitFor(async () => { const s = await status(); return s.connected && !s.syncing && s; });
  const said = () => readFileSync(rt.log, 'utf8').split('\n');
  relay.stall(true);
  let a, letGoMs;
  const t0 = performance.now();
  try {
    // A look asks the world once the copy is over 1 s old; the stalled network never answers, and in 10 s the daemon
    // gives the socket up.
    await sleep(1500);
    request(rt.socket, { op: 'look' }, 30_000).catch(() => {});
    await waitFor(async () => !(await status()).connected, 20_000);
    letGoMs = Math.round(performance.now() - t0);
    assert.ok(letGoMs < 15_000, `let go ${letGoMs} ms into the stall`);
    a = await request(rt.socket, { op: 'act', verb: 'r2:switch_on', target: LAMP });
    outputs.push(JSON.stringify(a));
    assert.equal(a.sent, false, `held while the socket is let go: ${JSON.stringify(a).slice(0, 300)}`);
    await sleep(3000);
    assert.equal((await status()).connected, false, 'still not connected while the network is stalled');
  } finally {
    relay.stall(false);
  }
  const t1 = performance.now(), from = said().length;
  await waitFor(async () => (await status()).connected, 10_000);
  const backMs = performance.now() - t1;
  // Not held back by the old socket's close (a sign-in left connecting for its whole 5 s).
  assert.ok(backMs < 3000, `signed in ${Math.round(backMs)} ms after the network came back`);
  const answers = await waitFor(async () => {
    const r = (await request(rt.socket, { op: 'receipt', sequence: a.sequence })).receipt;
    return r?.answers.some((x) => x.answer !== 'accepted') && r.answers;
  }, 30_000);
  await sleep(1000);
  const finals = (await request(rt.socket, { op: 'receipt', sequence: a.sequence })).receipt.answers.filter((x) => x.answer !== 'accepted');
  assert.equal(finals.length, 1, `answered once: ${JSON.stringify(answers)}`);
  const givenUpAfter = said().slice(from).filter((l) => /not signed in within/.test(l)).length;
  console.log(JSON.stringify({ issue: 4980, letGoMs, backMs: Math.round(backMs), givenUpAfter, finals: finals.length }));
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
