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
    let entries = null; // the daemon's entries fetch at sign-in (#3760) is not a request to the world
    down.on('data', (d) => { entries ??= d.subarray(0, 15).toString('latin1') === 'GET /v2/entries'; if (!entries) r.up += d.length; upstream.write(d); });
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
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', lineage, '--epoch', '1', '--rooms', '1', '--bodies', '1', '--creator', `${creatorScope}-1`, '--sky', String(Date.UTC(2026, 10, 21) * 1000), '3695', '--no-measures'], { stdio: 'ignore' }));
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
  // #3695: the world's verbs go to the daemon as words; it makes their sets on the world node from its copy.
  assert.deepEqual(requestOf(['weather', '--kind', 'storm', '--minutes', '30']).req, { op: 'edit', world: { verb: 'weather', kind: 'storm', minutes: '30' } });
  assert.deepEqual(requestOf(['check', 'strike', '12,-4']).req, { op: 'check', world: { verb: 'strike', at: '12,-4' } });
  assert.deepEqual(requestOf(['sky', '--palette', 'dusk']).req, { op: 'edit', world: { verb: 'sky', palette: 'dusk' } });
  assert.throws(() => requestOf(['weather', '--fog', '1']), /unknown words/);
});

test('#3695: a creator sets the weather and the sky palette and strikes lightning; each has a dry run and a refusal', async () => {
  await connected();
  const dry = await god('check', 'weather', '--kind', 'storm', '--minutes', '30');
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.local, true);
  assert.match(dry.would, /storm: clouds 100%, rain 90%, wind 80% for 30 world minutes/);
  assert.deepEqual(dry.ops.map((o) => o.field), [75, 76, 77, 78, 65]);
  const storm = await god('weather', '--kind', 'storm', '--minutes', '30');
  assert.equal(storm.ok, true, JSON.stringify(storm));
  const softer = await god('weather', '--rain', '0.4');
  assert.equal(softer.ok, true, JSON.stringify(softer));
  assert.match(softer.did, /storm: clouds 100%, rain 40%/, 'the kind in force is kept');
  for (const [args, code] of [[['weather', '--clouds', '2'], 'weather.level'], [['weather', '--kind', 'snow'], 'weather.kind-unknown'], [['weather', '--kind', 'rain', '--minutes', '600'], 'weather.minutes']]) {
    const r = await god(...args);
    assert.equal(r.code, code, JSON.stringify(r));
    assert.ok(r.fix && r.detail, 'a refusal says why and what to do');
  }
  assert.equal((await god('check', 'sky', '--palette', 'dusk')).ok, true);
  const sky = await god('sky', '--palette', 'mars-desert');
  assert.equal(sky.ok, true, JSON.stringify(sky));
  assert.equal((await god('sky', '--palette', 'purple')).code, 'sky.palette-unknown');
  assert.equal((await god('sky', '--palette', 'dusk', '--sun', '0.3')).code, 'sky.sun-follows-time');
  const dryStrike = await god('check', 'strike', '12,-4');
  assert.equal(dryStrike.ok, true, JSON.stringify(dryStrike));
  assert.deepEqual(dryStrike.ops[0].value.slice(0, 2), [12000, -4000]);
  const strike = await god('strike', '12,-4');
  assert.equal(strike.ok, true, JSON.stringify(strike));
  assert.equal((await god('strike', 'nowhere')).code, 'strike.where');
});

test('a creator describes, checks on its copy alone, and builds a room with a thing in it', async () => {
  const s = await connected();
  assert.equal(s.world, 'local');
  const d = await god('describe');
  const place = d.nodes.find((n) => n.kind === 'souls:place');
  assert.ok(place, JSON.stringify(d));
  const placeKind = Object.keys(d.kinds).find((k) => k.startsWith('souls:place@'));
  assert.deepEqual(d.kinds[placeKind].admits, ['souls:room']);

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

test('boot-body admission is shared by describe and local checks without revising kind pins', async () => {
  await connected();
  const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
  wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
  const original = JSON.parse(wire.editKinds(KINDS));
  const placeKind = Object.keys(original).find((n) => n.startsWith('souls:place@'));
  const itemKind = Object.keys(original).find((n) => n.startsWith('souls:item@'));
  assert.ok(!original[placeKind].admits.includes('body'));
  const file = join(home, 'kinds', 'local.kinds'), source = KINDS + `# souls-boot-body ${placeKind}\n`;
  const initial = await god('describe'), place = initial.nodes.find((n) => n.kind === 'souls:place');
  assert.ok(place, JSON.stringify(initial));
  assert.equal((await god('check', 'place', 'souls:body', '--in', place.id)).code, 'edit.child-not-admitted');
  writeFileSync(file, source);
  try {
    const described = await god('describe');
    assert.deepEqual(Object.keys(described.kinds).sort(), Object.keys(original).sort(), 'all full hashes remain unchanged');
    assert.deepEqual(described.kinds[placeKind].admits, ['body', 'souls:room']);
    const before = relay.up;
    const checked = await god('check', 'place', 'souls:body', '--in', place.id);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(checked.kinds, true);
    assert.equal(relay.up, before, 'the boot admission is checked locally without a world request');
    const copy = new wire.Copy();
    const ops = JSON.stringify([{ op: 'remove', node: place.id }]);
    for (const annotation of ['# souls-boot-body', '# souls-boot-body unknown@pin', `# souls-boot-body ${itemKind}`, `# souls-boot-body ${placeKind} thing`]) {
      const invalid = KINDS + annotation + '\n';
      assert.throws(() => wire.editKinds(invalid), /kinds-text/);
      assert.equal(JSON.parse(wire.editCheck(copy, ops, invalid)).code, 'edit.kinds-text');
    }
    copy.free();
  } finally {
    writeFileSync(file, KINDS);
  }
  assert.deepEqual(JSON.parse(wire.editKinds(KINDS)), original, 'absent-annotation behavior is unchanged');
});

test('runtime activity projection shares exact pins and boot admissions across describe and checks', async () => {
  await connected();
  const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
  wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
  const original = JSON.parse(wire.editKinds(KINDS));
  const placeKind = Object.keys(original).find((n) => n.startsWith('souls:place@'));
  const itemKind = Object.keys(original).find((n) => n.startsWith('souls:item@'));
  const pins = [`creator:activity@1220${'ab'.repeat(32)}`, `creator:activity@1220${'cd'.repeat(32)}`];
  const source = KINDS + `# souls-boot-body ${placeKind}\n` + pins.map((pin) => `# souls-boot-activity ${placeKind} ${pin}\n`).join('');
  const projected = JSON.parse(wire.editKinds(source));
  const file = join(home, 'kinds', 'local.kinds');
  writeFileSync(file, source);
  try {
    const described = await god('describe');
    const place = described.nodes.find((n) => n.kind === 'souls:place');
    assert.deepEqual(Object.keys(described.kinds).sort(), [...Object.keys(original), ...pins].sort());
    for (const pin of pins) {
      assert.deepEqual(projected[pin], { owner: 'activity', admits: [], slots: {} });
      assert.deepEqual(described.kinds[pin], { admits: [] });
    }
    assert.deepEqual(described.kinds[placeKind].admits, ['body', 'creator:activity', 'souls:room']);
    for (const [name, kind] of Object.entries(original)) if (name !== placeKind) assert.deepEqual(projected[name], kind);
    const before = relay.up;
    for (const pin of pins) {
      const checked = await god('check', 'batch', JSON.stringify([
        { op: 'place', name: 1, kind: pin, in: place.id },
        { op: 'move', node: 1, at: [1, 0, 1] },
      ]));
      assert.equal(checked.ok, true, JSON.stringify(checked));
    }
    assert.equal(relay.up, before, 'runtime admission checks ask the world nothing');
    const copy = new wire.Copy(), ops = JSON.stringify([{ op: 'remove', node: place.id }]);
    const invalid = [
      '# souls-boot-activity', `# souls-boot-activity ${placeKind} creator:activity`,
      `# souls-boot-activity ${placeKind} creator:activity@pin`,
      `# souls-boot-activity ${placeKind} creator:activity@1220${'AB'.repeat(32)}`,
      `# souls-boot-activity unknown@pin ${pins[0]}`, `# souls-boot-activity ${itemKind} ${pins[0]}`,
      `# souls-boot-activity ${placeKind} ${itemKind}`, // existing wrong-owner collision
      `# souls-boot-activity ${placeKind} ${placeKind}`, // existing place collision
      `# souls-boot-activity ${placeKind} ${pins[0]} extra`,
    ];
    for (const annotation of invalid) {
      assert.throws(() => wire.editKinds(KINDS + annotation + '\n'), /kinds-text/);
      assert.equal(JSON.parse(wire.editCheck(copy, ops, KINDS + annotation + '\n')).code, 'edit.kinds-text');
    }
    assert.deepEqual(JSON.parse(wire.editKinds(source + `# souls-boot-activity ${placeKind} ${pins[0]}\n`)), projected, 'identical repeated projection is harmless');
    copy.free();
  } finally { writeFileSync(file, KINDS); }
  assert.deepEqual(JSON.parse(wire.editKinds(KINDS)), original, 'absent annotation behavior is unchanged');
});

test('coexisting pinned revisions stay described and checkable by full name', async () => {
  const revisions = '{1: "creator:fixture", 2: "thing", 19: "first"}\n{1: "creator:fixture", 2: "thing", 19: "second"}\n';
  const file = join(home, 'kinds', 'local.kinds');
  writeFileSync(file, KINDS + revisions);
  try {
    const d = await god('describe');
    assert.equal(d.ok, true, JSON.stringify(d));
    const names = Object.keys(d.kinds).filter((n) => n.startsWith('creator:fixture@'));
    assert.equal(names.length, 2);
    const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
    wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
    const separately = revisions.trim().split('\n').flatMap((line) => Object.keys(JSON.parse(wire.editKinds(line))));
    assert.deepEqual(names.sort(), separately.sort(), 'exported revisions keep their original hashes');
    const room = d.nodes.find((n) => n.kind === 'souls:room');
    for (const kind of names) {
      const check = await god('check', 'place', kind, '--in', room.id);
      assert.equal(check.ok, true, JSON.stringify(check));
      assert.equal(check.kinds, true);
    }
    const ambiguous = await god('check', 'place', 'creator:fixture', '--in', room.id);
    assert.equal(ambiguous.code, 'edit.kind-unknown');
    assert.match(ambiguous.detail, /ambiguous; copy a full pinned name from describe/);
    assert.throws(() => wire.editKinds(KINDS + revisions + '{1: "creator:fixture", 2: 42}'), /kinds-text/);
    // Ordinary sets still name cross-kind references together rather than line by line.
    const references = '{1: "creator:base", 2: "thing"}\n{1: "creator:linked", 2: "thing", 10: {1: "creator:base"}}';
    assert.equal(Object.keys(JSON.parse(wire.editKinds(references))).length, 2);
  } finally {
    writeFileSync(file, KINDS);
  }
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
