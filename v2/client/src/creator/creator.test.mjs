// The creator's command (Engine v2 G7, #2796) against the real gateway (`gatewayd`, I1) and a world with a creator
// (`worldd gateway-link --creator`, G1b), through a TCP relay that counts what the daemon sends up. A creator's
// daemon holds a creator token, describes the world, checks batches on its copy with no frame to the world (A4),
// places a room and a thing in it, moves, sets and removes, each answered once, and a refusal prints its code, the
// failing operation and a fix. No command's output, the daemon's log or its trace holds the token (A5). Run from v2/
// after `cargo build -p gatewayd -p worldd --locked`, with replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createHttp } from 'node:http';
import { DEFAULT_PKG } from '../daemon/client.mjs';
import { readSeat } from '../home/home.mjs';
import { pair } from '../pair/pair.mjs';
import { opsOf, requestOf } from './souls-god.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const GOD = join(here, 'souls-god.mjs');
// The world `worldd gateway-link --creator` pins (`worldd::checkers::toggles::kinds`): the creator's kinds text.
const KINDS = `{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "souls:item", 2: "thing"}
{1: "r2:lamp", 2: "thing"}
`;

const dir = mkdtempSync(join(tmpdir(), 'souls-g7-'));
const home = join(dir, '.souls');
const creatorScope = randomBytes(16).toString('hex');
const secret = randomBytes(32).toString('hex'); // the canary: the token's secret part
const grant = `creator-${creatorScope}-1`;
const token = `${grant}.${secret}`;
const ME = `c_${creatorScope}-1`;
const procs = [];
const printed = []; // every line a command printed
let relay;

function makeRelay(port) {
  const r = { up: 0, port: 0 };
  const server = createServer((down) => {
    const upstream = createConnection(port, '127.0.0.1');
    down.on('data', (d) => { r.up += d.length; upstream.write(d); });
    upstream.on('data', (d) => down.write(d));
    for (const s of [down, upstream]) { s.on('error', () => {}); s.on('close', () => { down.destroy(); upstream.destroy(); }); }
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

/** One run of the creator's command; its answer. Asynchronous: the relay runs in this process. */
function god(...args) {
  return new Promise((ok) => {
    execFile(process.execPath, [GOD, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } }, (_, stdout) => {
      printed.push(stdout);
      ok(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
  });
}

async function connected() {
  for (const until = Date.now() + 15_000; Date.now() < until;) {
    const s = await god('status');
    if (s.connected) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`not connected: ${readFileSync(join(home, 'souls', ME, 'runtime', 'daemon.log'), 'utf8')}`);
}

before(async () => {
  const world = join(dir, 'w.sock');
  const tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `${grant} ${createHash('sha256').update(token).digest('hex')}\n`);
  const lineage = randomBytes(16).toString('hex');
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', lineage, '--epoch', '1', '--rooms', '1', '--bodies', '1', '--creator', `${creatorScope}-1`, '--no-measures'], { stdio: 'ignore' }));
  for (const until = Date.now() + 10_000; ;) {
    try { if (statSync(world).isSocket()) break; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error('no world socket');
    await new Promise((r) => setTimeout(r, 20));
  }
  const [, addr] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  relay = await makeRelay(Number(addr.split(':').pop()));
  mkdirSync(join(home, 'kinds'), { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://127.0.0.1:${relay.port}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [ME]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  writeFileSync(join(home, 'kinds', 'local.kinds'), KINDS);
});

after(async () => {
  await god('stop').catch(() => {});
  for (const p of procs) p.kill();
  relay?.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the verbs make G1 batches, and a refusal names its usage', () => {
  assert.deepEqual(opsOf('place', ['room', '--in', 'aa-0', '--at', '1,0,2']), [{ op: 'place', name: 1, kind: 'room', in: 'aa-0', at: [1, 0, 2] }]);
  assert.deepEqual(opsOf('set', ['aa-3', '1', 'true']), [{ op: 'set', node: 'aa-3', field: 1, value: true }]);
  assert.deepEqual(requestOf(['check', 'remove', 'aa-3']).req, { op: 'check', ops: [{ op: 'remove', node: 'aa-3' }] });
  assert.throws(() => opsOf('move', ['aa-3']), /move <id> --at/);
});

test('a creator describes, checks on its copy alone, and builds a room with a thing in it', async () => {
  const s = await connected();
  assert.equal(s.world, 'local');
  const d = await god('describe');
  const place = d.nodes.find((n) => n.kind === 'souls:place');
  assert.ok(place, JSON.stringify(d));
  assert.deepEqual(d.kinds['souls:place'].admits, ['souls:room']);

  // A4: check runs on the copy and sends nothing to the world.
  const before = relay.up;
  const bad = await god('check', 'place', 'lamp', '--in', place.id);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'edit.child-not-admitted');
  assert.equal(bad.op, 0);
  assert.match(bad.fix, /admits/);
  const good = await god('check', 'batch', JSON.stringify([
    { op: 'place', name: 1, kind: 'room', in: place.id },
    { op: 'place', name: 2, kind: 'lamp', in: 1, at: [500, 0, 500] },
  ]));
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.kinds, true);
  const missing = await god('check', 'remove', `${creatorScope}-999`);
  assert.equal(missing.code, 'edit.node-missing');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(relay.up, before, 'check sent nothing to the world');
  console.log(`check: 3 checks, ${relay.up - before} bytes sent to the world`);

  // The edits, one answer each, the receipt naming the minted ids.
  const room = await god('place', 'room', '--in', place.id);
  assert.equal(room.ok, true, JSON.stringify(room));
  const roomId = room.names['1'];
  assert.match(roomId, /^[0-9a-f]{32}-\d+$/);
  const lamp = await god('place', 'lamp', '--in', roomId, '--at', '1000,0,1000');
  assert.equal(lamp.ok, true, JSON.stringify(lamp));
  const lampId = lamp.names['1'];
  const d2 = await god('describe');
  assert.equal(d2.nodes.find((n) => n.id === lampId)?.parent, roomId, 'the copy holds the new thing in the new room');
  assert.equal((await god('move', lampId, '--at', '2000,0,1000')).ok, true);
  assert.equal((await god('remove', lampId)).ok, true);
  // What is gone is refused on the copy, before anything is sent.
  const gone = await god('set', lampId, '1', '1');
  assert.equal(gone.ok, false);
  assert.equal(gone.code, 'edit.node-missing');
  assert.equal(gone.sent, false);
  assert.match(gone.fix, /describe/);
  // Without the kinds text the copy checks only the nodes, and the world's own refusal comes back with the operation
  // that failed and a fix.
  const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
  wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
  const lampKind = Object.keys(JSON.parse(wire.editKinds(KINDS))).find((k) => k.startsWith('r2:'));
  renameSync(join(home, 'kinds', 'local.kinds'), join(dir, 'kinds.away'));
  const world = await god('batch', JSON.stringify([{ op: 'set', node: place.id, field: 1, value: 1 }, { op: 'place', name: 1, kind: lampKind, in: place.id }]));
  renameSync(join(dir, 'kinds.away'), join(home, 'kinds', 'local.kinds'));
  assert.equal(world.ok, false, JSON.stringify(world));
  assert.equal(world.local, undefined, 'refused by the world, not the copy');
  assert.equal(world.code, 'edit.child-not-admitted');
  assert.equal(world.op, 1);
  assert.match(world.fix, /admits/);
  const all = await god('status');
  assert.deepEqual(all.unanswered, []);
  console.log(`edits: ${all.sent} sent, ${all.answered} answered`);
});

test('pairing asks for the creator scope and keeps the creator\'s token', async () => {
  const asked = [];
  const server = createHttp((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pair/request') { asked.push(JSON.parse(body)); return res.end(JSON.stringify({ code: 'BCDF-GHJK', link: 'x', interval: 5 })); }
      res.end(JSON.stringify({ token: `creator-${'ab'.repeat(16)}-4.${'cd'.repeat(32)}`, grant: `creator-${'ab'.repeat(16)}-4` }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const at = join(dir, 'paired', '.souls');
  try {
    const out = await pair({ home: at, directory: `http://127.0.0.1:${server.address().port}`, world: 'w', gateway: 'ws://x', device: 'd', label: 'l',
      creator: `creator-${'ab'.repeat(16)}-4`, unit: 1, sleep: async () => {} });
    assert.equal(out.soul, `c_${'ab'.repeat(16)}-4`);
  } finally { server.close(); }
  assert.equal(asked[0].scope, 'creator');
  assert.equal(asked[0].soul, `creator-${'ab'.repeat(16)}-4`);
  assert.equal(asked[0].new, undefined);
  const seat = readSeat(at, `c_${'ab'.repeat(16)}-4`);
  assert.deepEqual(seat.grant, { actor: 'creator', scope: 'ab'.repeat(16), counter: 4n });
});

test('no output, log or trace holds the token', () => {
  const runtime = join(home, 'souls', ME, 'runtime');
  const files = readdirSync(runtime).filter((f) => statSync(join(runtime, f)).isFile()).map((f) => readFileSync(join(runtime, f), 'utf8'));
  for (const text of [...printed, ...files]) assert.ok(!text.includes(secret), 'the token was printed or logged');
  console.log(`token: absent from ${printed.length} outputs and ${files.length} runtime files`);
});
