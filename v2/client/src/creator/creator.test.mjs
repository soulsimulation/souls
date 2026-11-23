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
import { crc32, deflateSync } from 'node:zlib';
import { DEFAULT_PKG } from '../daemon/client.mjs';
import { readSeat } from '../home/home.mjs';
import { pair } from '../pair/pair.mjs';
import { areaOf, buildOf, eventOps, layerOf, opsOf, outlineOf, planRow, requestOf, resolve as resolveRelation } from './souls-god.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const ASSETS_CHECK = process.env.ASSETS_CHECK ?? join(dirname(GATEWAYD), 'assets-check');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const GOD = join(here, 'souls-god.mjs');
const SOULS = join(here, '../cli/souls.mjs');
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
// #3697 gap 2: a Soul of the same world, its first body (the toggles world mints from scope 2b: place, room, then each
// body and its lamp), in a home of its own.
const soulHome = join(dir, 'soul', '.souls');
const soulToken = `soul-${'2b'.repeat(16)}-2.${randomBytes(32).toString('hex')}`;
const procs = [];
const printed = []; // every line a command printed
let relay;

function makeRelay(port) {
  // `target` is the gateway it forwards to; `posts` are the plain HTTP connections (uploads), which a test that moves
  // `target` closes, so the daemon's next upload opens a new one to the new gateway.
  const r = { up: 0, port: 0, target: port, posts: new Set() };
  const server = createServer((down) => {
    const upstream = createConnection(r.target, '127.0.0.1');
    let entries = null; // the daemon's entries fetch at sign-in (#3760) is not a request to the world
    down.on('data', (d) => {
      entries ??= d.subarray(0, 15).toString('latin1') === 'GET /v2/entries';
      if (d.subarray(0, 5).toString('latin1') === 'POST ') r.posts.add(down);
      if (!entries) r.up += d.length;
      upstream.write(d);
    });
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

/** One run of the Soul's thin command (`souls.mjs`) in the Soul's home; its answer. */
function soul(...args) {
  return new Promise((ok) => {
    execFile(process.execPath, [SOULS, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: soulHome, SOULS_REPLICA_PKG: PKG } }, (_, stdout) => {
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
  writeFileSync(tokens, [token, soulToken].map((t) => `${t.split('.')[0]} ${createHash('sha256').update(t).digest('hex')}\n`).join(''));
  const lineage = randomBytes(16).toString('hex');
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', lineage, '--epoch', '1', '--rooms', '1', '--bodies', '1', '--creator', `${creatorScope}-1`, '--sky', String(Date.UTC(2026, 10, 21) * 1000), '3695', '--no-measures', '--www', join(dir, 'www')], { stdio: 'ignore' }));
  for (const until = Date.now() + 10_000; ;) {
    try { if (statSync(world).isSocket()) break; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error('no world socket');
    await new Promise((r) => setTimeout(r, 20));
  }
  const [, addr] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`,
    '--uploads', join(dir, 'uploads'), '--assets-check', ASSETS_CHECK], /listening (\S+)\n/);
  relay = await makeRelay(Number(addr.split(':').pop()));
  mkdirSync(join(home, 'kinds'), { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://127.0.0.1:${relay.port}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [ME]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  writeFileSync(join(home, 'kinds', 'local.kinds'), KINDS);
  mkdirSync(soulHome, { recursive: true });
  writeFileSync(join(soulHome, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://127.0.0.1:${relay.port}/v2/ws` } } }));
  writeFileSync(join(soulHome, 'credentials.json'), JSON.stringify({ souls: { s_bell: { local: { token: soulToken } } } }), { mode: 0o600 });
  chmodSync(join(soulHome, 'credentials.json'), 0o600);
});

after(async () => {
  await god('stop').catch(() => {});
  await soul('quit').catch(() => {});
  for (const p of procs) p.kill();
  relay?.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the verbs make G1 batches, and a refusal names its usage', () => {
  assert.deepEqual(opsOf('place', ['room', '--in', 'aa-0', '--at', '1,0,2']), [{ op: 'place', name: 1, kind: 'room', in: 'aa-0', at: [1, 0, 2] }]);
  assert.deepEqual(opsOf('set', ['aa-3', '1', 'true']), [{ op: 'set', node: 'aa-3', field: 1, value: true }]);
  assert.deepEqual(requestOf(['check', 'remove', 'aa-3']).req, { op: 'check', ops: [{ op: 'remove', node: 'aa-3' }] });
  assert.throws(() => opsOf('move', ['aa-3']), /move <id> --at/);
  assert.deepEqual(opsOf('hours', ['aa-3', '--open', '09:00-13:00@sat,sun']), [{ op: 'set', node: 'aa-3', field: 81, value: [[2, 96, 9 * 3_600_000_000, 13 * 3_600_000_000]] }]);
  assert.deepEqual(opsOf('hours', ['aa-3', '--closed']), [{ op: 'set', node: 'aa-3', field: 81, value: [] }]);
  assert.throws(() => opsOf('hours', ['aa-3']), /hours <id> --open/);
  // A creator's look is G10's shot of a place, thing or Soul by name or id; its usage is checked before anything runs.
  assert.deepEqual(requestOf(['look', 'market', '--out', 'm.jpg', '--size', '640x360']), { look: ['market', '--out', 'm.jpg', '--size', '640x360'], creator: undefined });
  assert.throws(() => requestOf(['look']), (e) => e.code === 'usage');
  assert.throws(() => requestOf(['look', 'market', '--out', 'm.gif']), /png or .jpg/);
  assert.throws(() => requestOf(['look', 'picture', 'f.png']), /look <place/);
  assert.deepEqual(requestOf(['free', '10x8', '--near', 'plaza']), { space: 'free', args: ['10x8', '--near', 'plaza'], creator: undefined });
  assert.throws(() => requestOf(['clear', 'plaza']), (e) => e.code === 'usage');
  // #3699: an event is one calendar entry, its start next HH:MM on the world's calendar or given in world µs.
  assert.deepEqual(requestOf(['event', 'aa-3', 'market', '--when', '09:00', '--for', '240']).event, { into: 'aa-3', words: 'market', when: '09:00', minutes: 240 });
  assert.deepEqual(eventOps({ into: 'aa-3', words: 'market', start: 5, minutes: 2, at: [1, 0, 2] }),
    [{ op: 'place', name: 1, kind: 'eden:calendar_entry', in: 'aa-3', at: [1, 0, 2], fields: { 28: 5, 29: 120_000_005, 30: { words: 'market' } } }]);
  for (const bad of [['aa-3', 'm'], ['aa-3', '', '--when', '09:00'], ['aa-3', 'm', '--when', '9am'], ['aa-3', 'm', '--when', '09:00', '--for', '0']]) {
    assert.throws(() => requestOf(['event', ...bad]), (e) => e.code === 'usage', bad.join(' '));
  }
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

/** The world node's fields as the page's stream source reads them: the world's public stream (`--www`) played on
 *  replica's StreamPlayer and its changed nodes read, as `web/src/source/worker.ts` does. */
let wasm = null;
async function pageWorld() {
  const wire = wasm ??= await import(pathToFileURL(join(PKG, 'replica.js')).href).then((w) => (w.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) }), w));
  const { decode } = await import('../brief/copy.mjs'), { encode } = await import('../history/day.mjs');
  const pointers = (f) => readdirSync(f, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? pointers(join(f, d.name)) : d.name === 'pointer' && f.endsWith('/everyone') ? [f] : []));
  for (const stream of pointers(join(dir, 'www'))) {
    const pointer = decode(readFileSync(join(stream, 'pointer')));
    if (!pointer.has(1)) continue;
    const header = readFileSync(resolve(stream, '../../../headers', Buffer.from(pointer.get(3)).toString('hex')));
    const generation = pointer.get(8);
    const parts = generation === undefined ? stream : join(stream, 'g', Buffer.from(generation).toString('hex'));
    const player = generation === undefined ? new wire.StreamPlayer(header) : wire.StreamPlayer.fromBaseline(header, readFileSync(join(parts, 'baseline')));
    try {
      // As the worker plays a part (`playOne`): the nodes changed since version 0 (query 5), each read by its id
      // (query 1), and the world node's fields read by `skyFields`.
      for (let n = Number(player.next()); n <= pointer.get(1); n++) player.play(readFileSync(join(parts, String(n))));
      const q = (m) => decode(player.query(encode(m)));
      for (const [id] of q(new Map([[1, 5], [2, 0]]))) {
        const f = q(new Map([[1, 1], [2, id]])).get(6);
        if (f instanceof Map && f.has(60)) return { fields: f };
      }
    } finally { player.free(); }
  }
  return null;
}

test('time stages the hour the page shows; the page source reads it; the world clock and calendar are unchanged; trace lists each command', async () => {
  await connected();
  const { readSky, skyFields } = await import('../../../web/src/sky/record.ts');
  const CLOCK = [60, 61, 62, 66, 67, 68]; // the calendar and the clock's mapping (`replica::sky`, `replica::time`)
  const clockOf = (f) => JSON.stringify(CLOCK.map((k) => f.get(k)), (_, v) => (typeof v === 'bigint' ? String(v) : v));
  const settled = async (want) => {
    for (const until = Date.now() + 15_000; Date.now() < until;) {
      const w = await pageWorld();
      if (w && want(readSky(skyFields(w.fields)))) return w;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the page source never read it');
  };
  const before = await settled((r) => r !== null);
  assert.equal(readSky(skyFields(before.fields)).skyHour, null, 'no staged hour: the world\'s own time');

  const dry = await god('check', 'time', '18:30');
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.deepEqual(dry.ops.map((o) => [o.field, o.value]), [[91, 18.5 * 3_600_000_000]]);
  const staged = await god('time', '18:30');
  assert.equal(staged.ok, true, JSON.stringify(staged));
  const shown = await settled((r) => r?.skyHour === 18.5 * 3_600_000_000);
  assert.equal(clockOf(shown.fields), clockOf(before.fields), 'the calendar and the world clock\'s mapping are unchanged');
  for (const [args, code] of [[['time', '25:00'], 'time.form'], [['time'], 'time.form'], [['time', '--speed', '2'], 'time.never-stops'], [['time', '--pause'], 'time.never-stops']]) {
    const r = await god(...args);
    assert.equal(r.code, code, JSON.stringify(r));
    assert.ok(r.fix, 'a refusal says what to do');
  }
  assert.equal((await god('time', 'live')).ok, true);
  const live = await settled((r) => r !== null && r.skyHour === null);
  assert.equal(clockOf(live.fields), clockOf(before.fields));

  // trace: the commands above, newest first, each with its time, verb, result and refusal; reads are not in it.
  const t = await god('trace', '7');
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.deepEqual(t.rows.map((r) => [r.verb, r.ok, r.code ?? null]), [
    ['time', true, null], ['time', false, 'time.never-stops'], ['time', false, 'time.never-stops'], ['time', false, 'time.form'],
    ['time', false, 'time.form'], ['time', true, null], ['check time', true, null],
  ]);
  assert.ok(t.rows.every((r) => !Number.isNaN(Date.parse(r.at))), 'each row has its time');
  assert.match(t.rows[3].detail, /time <HH:MM \| live>/, 'a refusal keeps its reason');
  assert.equal(t.most, 200);
  // The ring is on disk beside the daemon's state: a restart keeps it.
  await god('stop');
  await connected();
  const again = await god('trace', '7');
  assert.deepEqual(again.rows, t.rows);
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
  // #3699: the room's opening hours, published as E7's field and read back from the copy as written.
  const hours = await god('hours', roomId, '--open', '09:00-17:00@mon-fri', '--open', '10:00-14:00@sat,sun');
  assert.equal(hours.ok, true, JSON.stringify(hours));
  const d3 = await god('describe');
  assert.deepEqual(d3.nodes.find((n) => n.id === roomId)?.hours, ['09:00-17:00@mon,tue,wed,thu,fri', '10:00-14:00@sat,sun']);
  assert.equal((await god('hours', roomId, '--open', '9-5')).code, 'hours.malformed');
  // #3699: words in a creator's edit are kept by the world and the edit is taken (a world with no body for the creator).
  const said = await god('batch', JSON.stringify([{ op: 'set', node: lampId, field: 30, value: { words: 'market on the green at nine' } }]));
  assert.equal(said.ok, true, JSON.stringify(said));
  assert.equal((await god('event', roomId, 'market', '--when', '09:00')).code, 'when.no-calendar', 'this world publishes no calendar');
  assert.equal((await god('event', roomId, 'market', '--when', '5us')).code, 'edit.kind-unknown', 'and has no calendar entry kind');
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

test('a relation resolves on describe: beside, on a free slot, facing (#3694)', () => {
  const world = {
    nodes: [
      { id: 'a-1', kind: 'souls:room', parent: 'a-0', at: [0, 0, 0] },
      { id: 'a-2', kind: 'souls:item', parent: 'a-1', at: [1000, 0, 2000] },
      { id: 'a-3', kind: 'r2:shelf', parent: 'a-1', at: [0, 0, 0] },
      { id: 'a-4', kind: 'souls:item', parent: 'a-3', slot: 0 },
    ],
    kinds: { 'r2:shelf@00': { admits: ['thing'], slots: { 0: { admits: 'thing' }, 1: { admits: 'thing' } } } },
  };
  const of = (...a) => { const r = requestOf(a); return resolveRelation(r.req, r.relation, world).ops[0]; };
  assert.deepEqual(of('place', 'lamp', '--beside', 'a-2', '--dir', 'n', '--dist', '500'), { op: 'place', name: 1, kind: 'lamp', in: 'a-1', at: [1000, 0, 1500] });
  assert.deepEqual(of('place', 'lamp', '--on', 'a-3'), { op: 'place', name: 1, kind: 'lamp', in: 'a-3', slot: 1, at: [0, 0, 0] });
  assert.deepEqual(of('move', 'a-2', '--facing', 'e'), { op: 'move', node: 'a-2', yaw: 90000, at: [1000, 0, 2000] });
  assert.equal(of('place', 'lamp', '--in', 'a-1', '--at', '1000,0,0', '--facing', 'a-2').yaw, 0, 'facing +z toward the other');
  assert.throws(() => of('place', 'lamp', '--beside', 'a-9'), /no a-9/);
  assert.deepEqual(requestOf(['place', 'room', '--in', 'a-0', '--build', 'hut', '--step', 'shell']).req, { op: 'edit', ops: [{ op: 'place', name: 1, kind: 'room', in: 'a-0' }], build: 'hut', step: 'shell' });
  assert.throws(() => requestOf(['remove', 'a-2', '--build', 'hut']), /both/);
});

test('undo and redo step the world\'s history, a build is undone whole, and a relation places beside (#3694)', async () => {
  await connected();
  const place = (await god('describe')).nodes.find((n) => n.kind === 'souls:place');
  assert.equal((await god('undo', '--build', 'hut')).code, 'undo.not-the-build');
  // A build of two steps, then a thing beside the lamp that is no step.
  const room = await god('place', 'room', '--in', place.id, '--build', 'hut', '--step', 'shell');
  assert.equal(room.ok, true, JSON.stringify(room));
  assert.deepEqual([room.build, room.step], ['hut', 'shell']);
  const roomId = room.names['1'];
  const lamp = await god('place', 'lamp', '--in', roomId, '--at', '1000,0,1000', '--build', 'hut', '--step', 'lamp');
  assert.equal(lamp.ok, true, JSON.stringify(lamp));
  const beside = await god('place', 'item', '--beside', lamp.names['1'], '--dir', 's', '--dist', '500');
  assert.equal(beside.ok, true, JSON.stringify(beside));
  const at = (d, id) => d.nodes.find((n) => n.id === id);
  assert.deepEqual(at(await god('describe'), beside.names['1'])?.at, [1000, 0, 1500], 'beside the lamp, 500 mm south');
  // Undo takes the newest away and says what changed; redo gives it back with the same id.
  const undone = await god('undo');
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(undone.undone, true);
  assert.ok(undone.changed, 'the answer says what changed');
  assert.equal(at(await god('describe'), beside.names['1']), undefined);
  assert.equal((await god('redo')).ok, true);
  assert.ok(at(await god('describe'), beside.names['1']), 'redone with its id');
  assert.equal((await god('undo')).ok, true);
  // The build, both steps, at once.
  const build = await god('undo', '--build', 'hut');
  assert.equal(build.ok, true, JSON.stringify(build));
  assert.equal(build.steps, 2);
  const d = await god('describe');
  assert.equal(at(d, roomId), undefined, 'the build is gone whole');
  console.log(`undo: a build of 2 steps undone in one command; redo gave back ${beside.names['1']}`);
});

test('#3701: build words, today\'s plan file in the world\'s units, and a claim over a plan\'s plots', () => {
  assert.deepEqual(buildOf(['district']), { act: 'districts' });
  assert.deepEqual(buildOf(['district', 'market', '--file', 'p.json']), { act: 'record', id: 'market', file: 'p.json' });
  assert.deepEqual(buildOf(['claim', 'house', '--area', '0,-10,10,10']), { act: 'claim', part: 'house', area: [0, -10, 10, 10] });
  assert.deepEqual(buildOf(['claim', 'house', '--district', 'market', '--plots', 'a,b']), { act: 'claim', part: 'house', district: 'market', plots: ['a', 'b'] });
  assert.deepEqual(buildOf(['release', 'k1a2b3c4d']), { act: 'release', claim: 'c:k1a2b3c4d' });
  assert.throws(() => buildOf(['claim', 'house', '--area', '5,0,1,1']), /x0 < x1/);
  assert.throws(() => buildOf(['claim', 'house']), /--area .* --district/);
  assert.deepEqual(requestOf(['place', 'room', '--in', 'aa-0', '--claim', 'k1a2b3c4d']).req.claim, 'c:k1a2b3c4d');
  const row = planRow('Market', { title: 'Market Quarter', plots: [{ id: 'a', at: [2, 2], size: [2, 2], use: 'Bakery' }], roads: [{ id: 'main', width: 6, path: [[-5, 0], [5, 0]] }], chapters: [['a']] });
  assert.deepEqual(row, ['d:market', 'title:market-quarter', [['p:a', 2000, 2000, 2000, 2000, 0, 'use:bakery']], [['road:main', 6000, [-5000, 0, 5000, 0]]], [['p:a']]]);
  assert.deepEqual(areaOf(row[2]), [1000, 1000, 3000, 3000]);
  // A quarter turn swaps a plot's width and depth on the ground.
  assert.deepEqual(areaOf([['p:b', 0, 0, 4000, 2000, 90_000]]), [-1000, -2000, 1000, 2000]);
});

test('#3701: a creator records a district plan, claims its first chapter, builds inside it and is refused outside', async () => {
  await connected();
  const place = (await god('describe')).nodes.find((n) => n.kind === 'souls:place');
  const file = join(dir, 'market.json');
  writeFileSync(file, JSON.stringify({ id: 'market', title: 'Market quarter', plots: [{ id: 'a', at: [2, 2], size: [2, 2] }, { id: 'b', at: [10, 2], size: [2, 2] }], chapters: [['a'], ['b']] }));
  const recorded = await god('build', 'district', 'market', '--file', file);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal((await god('build', 'district', 'market', '--file', file)).code, 'district.exists');
  const plan = await god('build', 'district', 'market');
  assert.deepEqual(plan.district.plots.map((p) => p.status), ['planned', 'planned']);
  assert.deepEqual(plan.district.next.plots, ['a']);
  assert.deepEqual((await god('build', 'district')).districts, [{ id: 'market', title: 'market-quarter', counts: { plots: 2, claimed: 0, planned: 2 } }]);

  const claimed = await god('build', 'claim', 'house', '--district', 'market');
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const c = claimed.claim.id;
  assert.deepEqual(claimed.claim.area, [1000, 1000, 3000, 3000]);
  const after = await god('build', 'district', 'market');
  assert.deepEqual(after.district.plots.map((p) => p.status), ['claimed', 'planned']);
  assert.deepEqual(after.district.next.plots, ['b']);

  // Under the claim: inside builds, outside is refused by the world with the operation and a fix.
  const inside = await god('place', 'room', '--in', place.id, '--at', '2000,0,2000', '--claim', c);
  assert.equal(inside.ok, true, JSON.stringify(inside));
  const outside = await god('place', 'room', '--in', place.id, '--at', '10000,0,2000', '--claim', c);
  assert.deepEqual([outside.ok, outside.code, outside.op], [false, 'edit.outside-claim', 0], JSON.stringify(outside));
  assert.match(outside.fix, /inside its area/);
  // Not under it: its area is refused, the rest of the world is free.
  const into = await god('remove', inside.names['1']);
  assert.deepEqual([into.ok, into.code], [false, 'edit.claimed'], JSON.stringify(into));
  assert.equal((await god('place', 'room', '--in', place.id, '--at', '20000,0,2000')).ok, true);
  assert.equal((await god('place', 'room', '--in', place.id, '--claim', 'c:k0000000')).code, 'edit.claim-unknown');
  // Released, the area is the lead's again.
  assert.deepEqual((await god('build', 'claims')).claims.map((x) => x.id), [c]);
  assert.equal((await god('build', 'release', c)).ok, true);
  assert.deepEqual((await god('build', 'claims')).claims, []);
  assert.equal((await god('remove', inside.names['1'])).ok, true);
  assert.equal((await god('build', 'release', c)).code, 'claim.unknown');
});

test('#3700: own, access and zone words make today\'s marks in the world\'s units', () => {
  const soul = `${'ab'.repeat(16)}-4`;
  assert.deepEqual(layerOf('own', ['aa-1', soul, '--private']), { act: 'own', node: 'aa-1', owner: soul, access: 2 });
  assert.deepEqual(layerOf('own', ['aa-1', 'god']), { act: 'own', node: 'aa-1', owner: 'owner:god' });
  assert.deepEqual(layerOf('own', ['aa-1', 'none', '--public']), { act: 'own', node: 'aa-1', owner: 0, access: 1 });
  assert.deepEqual(layerOf('access', ['aa-1', 'none']), { act: 'access', node: 'aa-1', access: 0 });
  assert.throws(() => layerOf('own', ['aa-1', 'Ana']), /soul id/);
  assert.throws(() => layerOf('access', ['aa-1', 'secret']), /private\|public\|none/);
  assert.deepEqual(outlineOf({ rect: '0,0,20,10' }), [-10, -5, 10, -5, 10, 5, -10, 5]);
  assert.equal(outlineOf({ circle: '0,0,1000' }).length, 24);
  assert.throws(() => layerOf('zone', ['market', 'casino', '--rect', '0,0,1,1']), /residential\|commercial/);
  assert.deepEqual(requestOf(['secret']).layer, { act: 'secret' });
});

test('#3700: a creator marks a room private to a Soul, zones the land, and secret places stay off', async () => {
  await connected();
  const place = (await god('describe')).nodes.find((n) => n.kind === 'souls:place');
  const room = await god('place', 'room', '--in', place.id, '--at', '40000,0,40000');
  assert.equal(room.ok, true, JSON.stringify(room));
  const id = room.names['1'], soul = `${'ab'.repeat(16)}-4`;
  const owned = await god('own', id, soul, '--private');
  assert.equal(owned.ok, true, JSON.stringify(owned));
  const marks = (await god('describe')).nodes.find((n) => n.id === id).marks;
  assert.deepEqual(marks, { owner: soul, access: 2 });
  assert.deepEqual((await god('layers')).marked.find((m) => m.id === id), { id, kind: 'souls:room', owner: soul, access: 'private' });
  assert.equal((await god('access', id, 'public')).ok, true);
  assert.equal((await god('describe')).nodes.find((n) => n.id === id).marks.access, 1);
  // A mark that does not read is the world's refusal, with a fix.
  const bad = await god('set', id, '144', '7');
  assert.deepEqual([bad.ok, bad.code], [false, 'edit.owner-malformed'], JSON.stringify(bad));
  assert.match(bad.fix, /access <id>/);

  const zoned = await god('zone', 'Market Square', 'commercial', '--rect', '0,0,20000,10000');
  assert.equal(zoned.ok, true, JSON.stringify(zoned));
  assert.ok(zoned.suits.includes('building.commercial'));
  assert.equal((await god('zone', 'park', 'park', '--circle', '50000,0,8000')).ok, true);
  const L = await god('layers');
  assert.deepEqual(L.zones.map((z) => [z.name, z.use, z.outline.length]), [['market-square', 'commercial', 4], ['park', 'park', 12]]);
  assert.deepEqual((await god('zone-suggest', 'wild')).categories.slice(0, 2), ['vegetation.tree', 'terrain.landform']);
  const secret = await god('secret');
  assert.deepEqual([secret.ok, secret.code], [false, 'secret.off']);
  assert.match(secret.fix, /every place is on every Soul/);
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

test('#3727: helper and rewind words', () => {
  assert.deepEqual(buildOf(['claim', 'house', '--area', '0,0,10,10', '--helper', '--ttl', '30']), { act: 'claim', part: 'house', area: [0, 0, 10, 10], helper: true, ttl: 30 });
  assert.throws(() => buildOf(['claim', 'house', '--area', '0,0,10,10', '--ttl', '30']), /needs --helper/);
  assert.deepEqual(buildOf(['rewind', 'hut', '--to', 'shell', '--dry']), { act: 'rewind', build: 'hut', to: 'shell', dry: true });
  assert.throws(() => buildOf(['rewind', 'hut']), /--to <step>/);
});

test('#3727: a helper builds only inside its claim, never undoes, and a build rewinds to a step', async () => {
  await connected();
  const place = (await god('describe')).nodes.find((n) => n.kind === 'souls:place');
  const claimed = await god('build', 'claim', 'yard', '--area', '40000,0,50000,10000', '--helper', '--ttl', '5');
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.match(claimed.claim.helper, /^[0-9a-f]{32}-\d+$/);
  const helperHome = claimed.helper.home;
  const helperToken = JSON.parse(readFileSync(join(helperHome, 'credentials.json'), 'utf8')).souls[`c_${claimed.claim.helper}`].local.token;
  assert.ok(!JSON.stringify(claimed).includes(helperToken.split('.')[1]), 'the helper token is not printed');
  // The helper's own home: every edit goes under its claim, so inside builds and outside is refused by the world.
  const helper = (...args) => new Promise((ok) => {
    execFile(process.execPath, [GOD, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: helperHome, SOULS_REPLICA_PKG: PKG } }, (_, stdout) => {
      printed.push(stdout);
      ok(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
  });
  for (const until = Date.now() + 15_000; !(await helper('status')).connected && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  const inside = await helper('place', 'room', '--in', place.id, '--at', '45000,0,5000');
  assert.equal(inside.ok, true, JSON.stringify(inside));
  const outside = await helper('place', 'room', '--in', place.id, '--at', '60000,0,5000');
  assert.deepEqual([outside.ok, outside.code], [false, 'edit.outside-claim'], JSON.stringify(outside));
  assert.equal((await helper('undo')).code, 'edit.not-the-creator', 'an undo is the lead\'s');
  // The lead may not undo into the helper's claim: the helper's room is in it.
  await helper('stop');
  assert.equal((await god('build', 'release', claimed.claim.id)).ok, true);
  // A build of three steps, rewound to its first: the two later steps go, newest first.
  const shell = await god('place', 'room', '--in', place.id, '--at', '70000,0,0', '--build', 'barn', '--step', 'shell');
  assert.equal(shell.ok, true, JSON.stringify(shell));
  const roof = await god('place', 'lamp', '--in', shell.names['1'], '--at', '0,0,0', '--build', 'barn', '--step', 'roof');
  const door = await god('place', 'lamp', '--in', shell.names['1'], '--at', '500,0,0', '--build', 'barn', '--step', 'door');
  assert.equal(roof.ok && door.ok, true);
  assert.deepEqual((await god('build', 'rewind', 'barn', '--to', 'shell', '--dry')).would, ['roof', 'door']);
  const rewound = await god('build', 'rewind', 'barn', '--to', 'shell');
  assert.equal(rewound.ok, true, JSON.stringify(rewound));
  assert.equal(rewound.steps, 2);
  const d = await god('describe');
  assert.ok(d.nodes.some((n) => n.id === shell.names['1']), 'the shell stays');
  assert.ok(!d.nodes.some((n) => n.id === roof.names['1'] || n.id === door.names['1']), 'its later steps are gone');
  assert.equal((await god('build', 'rewind', 'barn', '--to', 'porch')).code, 'rewind.no-step');
  console.log(`helper ${claimed.claim.helper}: built inside its claim, refused outside, no undo; barn rewound 2 steps to shell`);
});

test('no output, log or trace holds the token', () => {
  const runtime = join(home, 'souls', ME, 'runtime');
  const files = readdirSync(runtime).filter((f) => statSync(join(runtime, f)).isFile()).map((f) => readFileSync(join(runtime, f), 'utf8'));
  for (const text of [...printed, ...files]) assert.ok(!text.includes(secret), 'the token was printed or logged');
  console.log(`token: absent from ${printed.length} outputs and ${files.length} runtime files`);
});

test('#3697: a creator defines a kind and a kit of its own, places one and is refused by name', async () => {
  await connected();
  const d = await god('describe');
  const place = d.nodes.find((n) => n.kind === 'souls:place');
  const room = await god('place', 'room', '--in', place.id);
  assert.equal(room.ok, true, JSON.stringify(room));
  const roomId = room.names['1'];
  // define-kit: today's kit (metres, radians) is a record with geometry.parts (mm, mdeg), defined in the world.
  const kit = join(dir, 'birdbath.kit.json');
  writeFileSync(kit, JSON.stringify({ name: 'birdbath', version: 1, tags: ['garden'], box: [1, 1.2, 1], layer: 'solid', actions: {},
    shapes: [{ kind: 'cyl', at: [0, 0.4, 0], r: 0.18, h: 0.8, material: 'stone' },
      { kind: 'lathe', at: [0, 0.8, 0], profile: [[0, 0], [0.45, 0.05], [0.5, 0.15]], yaw: Math.PI / 2, material: 'stone' }] }));
  const defined = await god('define-kit', kit, '--ns', 'garden');
  assert.equal(defined.ok, true, JSON.stringify(defined));
  assert.equal(defined.defines.length, 1);
  const full = defined.defines[0];
  assert.match(full, /^garden:birdbath@1220[0-9a-f]{64}$/);
  assert.deepEqual(defined.not_carried, ['actions'], 'what a kit does is reported, never dropped silently');
  // The copy holds it: describe lists it, and a thing of it is placed by its plain name.
  const d2 = await god('describe');
  assert.ok(d2.kinds[full], JSON.stringify(Object.keys(d2.kinds)));
  const kindNode = d2.nodes.find((n) => n.kind === 'souls:kind');
  assert.equal(kindNode?.parent, place.id, 'the definition is a node at the root');
  const bath = await god('place', 'garden:birdbath', '--in', roomId, '--at', '1000,0,1000');
  assert.equal(bath.ok, true, JSON.stringify(bath));
  const bathId = bath.names['1'];
  assert.equal((await god('describe')).nodes.find((n) => n.id === bathId)?.kind, 'garden:birdbath');
  // define: a record of the content format, over the agents' frame limit, goes by the creator route; its forms pass.
  const record = join(dir, 'bell.json');
  writeFileSync(record, JSON.stringify({ format: 'souls-entry/1', kind: 'garden:bell', owner: 'thing',
    geometry: { bounds_mm: [300, 400, 300] }, text: { name: 'bell', description: 'a garden bell. '.repeat(400) } }));
  const bell = await god('define', record);
  assert.equal(bell.ok, true, JSON.stringify(bell));
  assert.match(bell.defines[0], /^garden:bell@/);
  // Each refusal by name: the copy refuses what it can see, before anything is sent.
  const again = await god('define-kit', kit, '--ns', 'garden');
  assert.equal(again.code, 'kind.collision');
  assert.equal(again.sent, false);
  assert.match(again.fix, /defined already/);
  const theirs = await god('define-kit', kit, '--ns', 'eden');
  assert.equal(theirs.code, 'kind.namespace');
  const inUse = await god('remove', kindNode.id);
  assert.equal(inUse.code, 'kind.in-use');
  const program = join(dir, 'row.kit.json');
  writeFileSync(program, JSON.stringify({ name: 'row', shapes: [{ kind: 'box', at: [0, 0.5, 0], size: [1, 1, 1], repeat: { n: 3, step: [2, 0, 0] } }] }));
  assert.equal((await god('define-kit', program)).code, 'kit.program');
  // Removing the thing and its kind together is fine.
  const both = await god('batch', JSON.stringify([{ op: 'remove', node: bathId }, { op: 'remove', node: kindNode.id }]));
  assert.equal(both.ok, true, JSON.stringify(both));
  const d3 = await god('describe');
  assert.equal(d3.kinds[full], undefined, 'a removed definition is no longer a kind here');
});

test('#3697 gap 2: a Soul finds a creator\'s kind, its inspect lists the form, act runs it, and a wrong act is refused by name', async () => {
  await connected();
  const d = await god('describe');
  const room = d.nodes.find((n) => n.kind === 'souls:room');
  // The creator defines a bell with one form, ring, which sets its field rung, and places one in the Soul's room.
  const record = join(dir, 'chime.json');
  writeFileSync(record, JSON.stringify({ format: 'souls-entry/1', kind: 'garden:chime', owner: 'thing',
    state: { rung: { n: 1, type: 'bool', default: false, audience: { rule: 'everyone' } } },
    geometry: { bounds_mm: [300, 400, 300] },
    forms: { ring: { who: 'anyone', starts: 'act', needs: [{ need: 'state', field: 'rung', is: false }], effects: [{ change: 'set', field: 'rung', to: true, event: 'rang' }] } },
    text: { name: 'chime', description: 'a garden chime' } }));
  const defined = await god('define', record);
  assert.equal(defined.ok, true, JSON.stringify(defined));
  const placed = await god('place', 'garden:chime', '--in', room.id, '--at', '500,0,500');
  assert.equal(placed.ok, true, JSON.stringify(placed));
  const chime = placed.names['1'];

  // The Soul's daemon signs in; its copy holds the chime and the record that defines it.
  for (const until = Date.now() + 20_000; ;) {
    const s = await soul('status');
    if (s.connected && !s.syncing) break;
    if (Date.now() > until) throw new Error(`the Soul did not connect: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const found = await soul('find', 'chime');
  assert.ok(found.found?.some((f) => f.id === chime), JSON.stringify(found));
  const seen = await soul('inspect', chime);
  assert.equal(seen.ok, true, JSON.stringify(seen));
  assert.equal(seen.kind, 'garden:chime');
  const ring = seen.offers.find((o) => o.name === 'ring');
  assert.ok(ring, JSON.stringify(seen.offers));
  assert.equal(ring.act, `ring:${chime}`);
  console.log(`inspect ${chime}: ${JSON.stringify(seen.offers)}; state ${JSON.stringify(seen.state)}`);
  // The Soul's own check reads the creator's kind as the world does: ring is allowed while rung is false.
  const can = await soul('can', `ring:${chime}`);
  assert.equal(can.can, 'yes', JSON.stringify(can));

  // act runs it: the receipt is done, and the field is set.
  const sent = await soul('act', ring.act);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const receipt = async (sequence) => {
    for (const until = Date.now() + 20_000; ;) {
      const r = await soul('receipt', String(sequence));
      const end = r.receipt?.answers?.find((a) => a.answer === 'receipt' || a.answer === 'refused');
      if (end || Date.now() > until) return { ...r, end };
      await new Promise((ok) => setTimeout(ok, 200));
    }
  };
  const done = await receipt(sent.sequence);
  console.log(`act ${ring.act}: ${JSON.stringify(done)}`);
  assert.equal(done.end?.answer, 'receipt', `the receipt is done: ${JSON.stringify(done)}`);
  for (const until = Date.now() + 10_000; ;) {
    await soul('look'); // brings the copy current; inspect reads it as it is
    const after = await soul('inspect', chime);
    if (after.state?.rung === true || after.state?.rung === 1) { console.log(`after the ring: state ${JSON.stringify(after.state)}`); break; }
    if (Date.now() > until) assert.fail(`rung not set: ${JSON.stringify(after)}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Refused by name, exactly as a built-in form is: a form the kind does not have, and a form whose need fails.
  const lamp = `${'2b'.repeat(16)}-3`;
  const names = [];
  for (const act of [`toll:${chime}`, `toll:${lamp}`]) {
    const s = await soul('act', act);
    const r = await receipt(s.sequence);
    console.log(`act ${act}: ${JSON.stringify(r)}`);
    names.push(`${r.end?.answer} ${r.end?.reason}`);
  }
  assert.equal(names[0], names[1], `an unknown form is refused as a built-in kind's is: ${JSON.stringify(names)}`);
  assert.match(names[0], /^refused \S+/);
  // The Soul's own check (the rules port) reads the creator's kind too: a second ring, its need failed, is stopped
  // before it is sent, by the need's name.
  const again = await soul('act', ring.act);
  console.log(`act ${ring.act} again: ${JSON.stringify(again)}`);
  assert.equal(again.code, 'stopped-locally', JSON.stringify(again));
  assert.equal(again.dropped?.[0]?.reason, 'field_differs');
});

/** An 8 by 8 RGBA PNG whose tEXt chunk carries `text`. */
function png(text) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from(text)),
    chunk('IDAT', deflateSync(Buffer.alloc(8 * 33))), chunk('IEND', Buffer.alloc(0))]);
}

test('#3697: a creator uploads a picture through the check and hold point; an allowed one is served by hash', async () => {
  await connected();
  const file = join(dir, 'mural.png');
  writeFileSync(file, png('GPSLatitude 52.52 N'));
  const up = await god('upload', file);
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(up.state, 'allowed');
  assert.match(up.hash, /^1220[0-9a-f]{64}$/);
  assert.ok(up.url.endsWith(`/v2/uploads/${up.hash}`), up.url);
  const served = await fetch(up.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.ok(!bytes.includes('GPSLatitude'), 'the metadata is stripped');
  // A file the check refuses, by its name, with a fix; a file that is no model or picture, by the command.
  const junk = join(dir, 'junk.png');
  writeFileSync(junk, 'not a picture');
  const bad = await god('upload', junk);
  assert.equal(bad.ok, false);
  assert.match(bad.code, /^upload\./, JSON.stringify(bad));
  assert.equal((await god('upload', join(dir, 'notes.txt'))).code, 'usage');
});

test('K3: a kind whose look is an uploaded model names an allowed upload; any other hash is refused by name and nothing is sent', async () => {
  await connected();
  const file = join(dir, 'k3-model.png');
  writeFileSync(file, png('the model stand-in'));
  const up = await god('upload', file);
  assert.equal(up.state, 'allowed', JSON.stringify(up));
  let n = 0;
  const record = (model) => {
    const f = join(dir, `k3-statue-${n++}.json`);
    writeFileSync(f, JSON.stringify({ format: 'souls-entry/1', kind: 'k3:statue', owner: 'thing', geometry: { bounds_mm: [500, 1500, 500] }, looks: { model }, text: { card: 'A statue.' } }));
    return f;
  };
  const unknown = await god('define', record(`upload:1220${'0'.repeat(64)}`));
  assert.equal(unknown.code, 'kind.model-unknown', JSON.stringify(unknown)); assert.equal(unknown.sent, false); assert.match(unknown.fix, /upload the model first/);
  const wrong = await god('define', record('upload:not-a-hash'));
  assert.equal(wrong.code, 'kind.model', JSON.stringify(wrong)); assert.equal(wrong.sent, false);
  assert.equal(unknown.local, true, 'refused here, before anything went to the world (the gateway was asked for the upload)');
  const ok = await god('define', record(`upload:${up.hash}`));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(ok.defines[0], /^k3:statue@1220[0-9a-f]{64}$/);
  // a thing of it is placed; the page draws it from the kind's record, which names the model (V1, creator-kinds.ts)
  const place = (await god('describe')).nodes.find((x) => x.kind === 'souls:place');
  const room = await god('place', 'room', '--in', place.id);
  const statue = await god('place', 'k3:statue', '--in', room.names['1'], '--at', '2000,0,2000');
  assert.equal(statue.ok, true, JSON.stringify(statue));
  const d = await god('describe');
  assert.equal(d.nodes.find((x) => x.id === statue.names['1'])?.kind, 'k3:statue');
  assert.ok(d.kinds[ok.defines[0]], 'the definition is in the world');
});

test('#4022: in a world that holds uploads for review, souls-god reports a held upload as held, and it is not served', async () => {
  await connected();
  // A second gateway that holds every upload (`--uploads-hold`), its own uploads folder; the upload asks no world. Its
  // tokens file is a copy in its own folder, since a gateway's control socket is kept beside its tokens file.
  const held = join(dir, 'held-gateway');
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, 'tokens.txt'), readFileSync(join(dir, 'tokens.txt')));
  const [, addr] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', join(held, 'no-world.sock'), '--tokens', join(held, 'tokens.txt'),
    '--build', `1220${'ab'.repeat(32)}`, '--uploads', join(dir, 'uploads-held'), '--assets-check', ASSETS_CHECK, '--uploads-hold'], /listening (\S+)\n/);
  const port = Number(addr.split(':').pop()), was = relay.target;
  for (const c of relay.posts) c.destroy();
  relay.posts.clear();
  relay.target = port;
  const file = join(dir, 'poster.png');
  writeFileSync(file, png('a poster for review'));
  let up;
  try { up = await god('upload', file); } finally { relay.target = was; for (const c of relay.posts) c.destroy(); }
  console.log(`held upload: ${JSON.stringify(up)}`);
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(up.state, 'held', 'reported as held');
  assert.ok(typeof up.reason === 'string' && up.reason.length > 0, 'with its reason');
  assert.match(up.hash, /^1220[0-9a-f]{64}$/);
  assert.equal(up.url, undefined, 'a held upload has no url to show');
  assert.equal((await fetch(`http://127.0.0.1:${port}/v2/uploads/${up.hash}`)).status, 404, 'a held upload is not served');
  assert.ok(statSync(join(dir, 'uploads-held', 'held', up.hash)).isFile(), 'kept apart for the owner\'s review');
});
