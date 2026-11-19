// R15b (#3517): the literal pub at 08:00 and an opening read from E7's published hours, on real worldd serve.
// Only the isolated seed's calendar/shop facts are set up; worldd owns its real clock, mapping, rate and ticks.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decode, idText } from '../brief/copy.mjs';
import { clockOf, worldNow } from '../clock/clock.mjs';
import { call, DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { encode } from '../history/day.mjs';
import { addEntry, parseLine } from './schedule.mjs';
import { calendarOf, nextWorldTime, realDeadline, worldDue } from './world.mjs';

const TICK = 50_000, HOUR = 3_600_000_000;
const v2 = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const bin = (name) => process.env[name.toUpperCase()] ?? join(v2, 'target/debug', name);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fieldsCopy = (fields) => ({ roots: () => '{"root":"hash"}', record: () => encode(new Map([[6, fields]])) });

test('world times use the published calendar, with rising-line rounding and offset changes', () => {
  const cal = calendarOf(fieldsCopy(new Map([[60, 43_200], [61, 0], [62, [[0, -HOUR], [12 * HOUR, 0]]]])));
  assert.equal(nextWorldTime('08:00', cal, 3 * HOUR), 4.5 * HOUR, 'a half-length day and local offset');
  assert.equal(nextWorldTime('08:00', cal, 12 * HOUR), 16 * HOUR, 'the next local day, with its new offset');
  assert.equal(realDeadline({ world: 100, real: 1000, rate: [3, 2] }, 102), 2, 'inverse rounds up to a real ms');
  assert.equal(nextWorldTime('08:00', null, 0), null, 'no calendar means no invented local time');
});

test('a world occurrence persists across rates, is once-only, and retains R15 missed/until rules', () => {
  const entries = [
    parseLine('- s1 · world 10000000us · act x'),
    parseLine('- s2 · world 10000000us · act x · missed drop'),
    parseLine('- s3 · world 10000000us · act x · missed late 20s'),
    parseLine('- s4 · world 10000000us · act x · until 1970-01-01T00:00:01Z'),
  ];
  const targets = {}, clock = { world: 0, real: 0, rate: [1, 1] };
  assert.equal(worldDue(entries, {}, targets, clock, null, 0).next, 10_000);
  const faster = { world: 2_000_000, real: 2_000_000, rate: [2, 1] };
  assert.equal(worldDue(entries, {}, targets, faster, null, 2000).next, 6000);
  assert.deepEqual(worldDue(entries, {}, targets, faster, null, 6000).fire.map((f) => f.e.id), ['s1', 's2', 's3']);
  assert.equal(targets[entries[0].key].worldUs, 10_000_000, 'the occurrence does not move to another day');
  const later = { world: 30_000_000, real: 16_000_000, rate: [1, 1] };
  const missed = worldDue(entries, {}, targets, later, null, 16_000, [7000, 16_000]);
  assert.deepEqual(missed.missed.map((m) => [m.e.id, m.told, m.late]), [['s1', true, 10_000], ['s2', false, 10_000]]);
  assert.deepEqual(missed.fire.map((f) => f.e.id), ['s3']);
  assert.equal(worldDue(entries, Object.fromEntries(entries.map((e) => [e.key, { at: 6000 }])), targets, faster, null, 6000).fire.length, 0);
  assert.equal(worldDue(entries, {}, targets, null, null, 6000).fire.length, 0, 'no published mapping, no send');
});

// The canonical log framing in sim::log::record: a 32-byte header and 12-byte heads, salted chained CRC32C.
function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return (~crc) >>> 0;
}
function records(file) {
  const bytes = readFileSync(file), out = [];
  assert.equal(bytes.subarray(0, 8).toString(), 'souls-lg');
  assert.equal(crc32c(bytes.subarray(0, 28)), bytes.readUInt32LE(28));
  const salt = bytes.subarray(28, 32);
  let prev = bytes.readUInt32LE(28);
  for (let at = 32; at + 12 <= bytes.length;) {
    const len = bytes.readUInt32LE(at), end = at + 12 + len;
    if (end > bytes.length) break; // a later tick may still be appending; every complete record must check
    assert.equal(bytes.readUInt32LE(at + 4), prev);
    const payload = bytes.subarray(at + 12, end);
    assert.equal(crc32c(Buffer.concat([salt, bytes.subarray(at, at + 8), payload])), bytes.readUInt32LE(at + 8));
    prev = bytes.readUInt32LE(at + 8);
    out.push(decode(payload));
    at = end;
  }
  return out;
}

/** Only a fresh one-record seed: add normal published calendar and shop hours to its genesis changes. */
function publishFixture(file, target) {
  const original = readFileSync(file), parts = records(file);
  assert.equal(parts.length, 1, 'only a fresh seed can be configured');
  const part = parts[0], effect = part.get(2)[0], root = effect.get(6);
  assert.ok(effect.get(7), 'the seed starts with ordinary changes');
  const fields = new Map([[60, 86_400], [61, 8 * HOUR - target], [62, [[0, 0]]], [63, [[0, 'souls:day']]], [64, 1]]);
  const shop = part.get(2).flatMap((e) => e.get(7) ?? [])
    .find((c) => c.get(1) === 1 && c.get(6)?.get(27) === 'testworld:square')?.get(2);
  assert.ok(shop, 'the seed contains the declared shop');
  const hours = [[1, target + 2_000_000, target + HOUR]];
  const settings = new Map(effect);
  settings.set(1, part.get(2).length);
  settings.set(7, [...fields].map(([field, value]) => new Map([[1, 4], [2, root], [3, field], [4, value]])));
  part.get(2).push(settings);
  const shopSettings = new Map(settings);
  shopSettings.set(1, part.get(2).length);
  shopSettings.set(6, shop);
  shopSettings.set(7, [new Map([[1, 4], [2, shop], [3, 81], [4, hours]])]);
  part.get(2).push(shopSettings); // each settings entry owns its node; no time effect is added or changed
  const payload = Buffer.from(encode(part)), head = Buffer.alloc(12);
  head.writeUInt32LE(payload.length, 0);
  head.writeUInt32LE(original.readUInt32LE(28), 4);
  head.writeUInt32LE(crc32c(Buffer.concat([original.subarray(28, 32), head.subarray(0, 8), payload])), 8);
  writeFileSync(file, Buffer.concat([original.subarray(0, 32), head, payload]));
  assert.equal(records(file).length, 1, 'the configured seed retains canonical framing');
  return { root: idText(root), shop: idText(shop), fields, hours };
}

async function waitFor(f, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await f();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

/** An independent observer grant reads an actual gateway scope into WASM Copy; it never displaces the agent. */
async function snapshot(wire, gateway, token) {
  return new Promise((ok, fail) => {
    const socket = new WebSocket(gateway), copy = new wire.Copy();
    socket.binaryType = 'arraybuffer';
    let step = 'hello', n = 1;
    const timer = setTimeout(() => { socket.close(); fail(new Error('snapshot timed out')); }, 30_000);
    socket.onopen = () => socket.send(wire.wireHello());
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data === 'string') return;
        const bytes = new Uint8Array(data);
        if (step === 'hello') { wire.wireWorldBuild(bytes); socket.send(wire.wireSignIn(token, new Uint8Array())); step = 'outcome'; return; }
        const [kind, answer, reason] = wire.wireFrame(bytes).split(' ');
        if (kind === 'outcome') {
          assert.notEqual(answer, 'token.refused');
          step = 'hashes'; socket.send(wire.wireSyncScope(BigInt(n))); return;
        }
        if (kind !== 'sync') return;
        assert.equal(reason, '-');
        if (step === 'hashes') copy.onHashes(bytes); else copy.onRecords(bytes);
        const next = copy.next(BigInt(++n));
        if (next.length) { step = 'records'; socket.send(next); }
        else { copy.finish(); clearTimeout(timer); socket.close(); ok(copy); }
      } catch (err) { clearTimeout(timer); socket.close(); fail(err); }
    };
    socket.onerror = () => { clearTimeout(timer); fail(new Error('snapshot socket failed')); };
  });
}

test('A1/A2: the pub at 08:00 and published shop opening fire within one world tick across a served rate change', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r15b-')), home = join(dir, 'h'), world = join(dir, 'w'), socket = join(dir, 'w.sock');
  const SOUL = 's_r15b', procs = [], output = [];
  const env = { PATH: process.env.PATH, BRAIN_MODE: 'fake', SOULS_HOME: home };
  const rt = runtimeOf(home, SOUL);
  const run = (name, args) => {
    const p = spawn(bin(name), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
    procs.push(p); output.push(() => text);
    return { p, text: () => text };
  };
  const kill = (p) => new Promise((ok) => { if (p.exitCode !== null || p.signalCode !== null) return ok(); p.once('exit', ok); p.kill('SIGKILL'); });
  const serve = async (rate) => {
    const w = run('worldd', ['serve', '--dir', world, '--socket', socket, '--rate', rate]);
    const match = await waitFor(() => /worldd: clock world (-?\d+) real (-?\d+) rate (\d+)\/(\d+)\n/.exec(w.text()));
    await waitFor(() => /listening /.test(w.text()));
    return { ...w, clock: { world: Number(match[1]), real: Number(match[2]), rate: [Number(match[3]), Number(match[4])] } };
  };
  const ask = (q) => request(rt.socket, q, 30_000);
  try {
    let made = spawnSync(bin('testworld'), ['--out', join(dir, 'tw')], { env, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const facts = join(dir, 'tw/testworld-s1-t0.facts.json');
    const input = JSON.parse(readFileSync(facts, 'utf8'));
    input.things[0].entry = 'testworld:square';
    writeFileSync(facts, JSON.stringify(input));
    mkdirSync(join(dir, 'entries'));
    writeFileSync(join(dir, 'entries/shop.json'), JSON.stringify({ format: 'souls-entry/1', kind: 'testworld:square', owner: 'thing',
      state: { visited: { n: 90, type: 'int', default: 0, audience: { rule: 'everyone' } } },
      forms: { visit: { who: 'anyone', starts: 'act', needs: [], steps: [], effects: [{ change: 'set', field: 'visited', to: 1 }] } } }));
    made = spawnSync(bin('worldd'), ['seed', '--facts', facts, '--dir', world, '--souls', '2', '--entries', join(dir, 'entries')], { env, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    // Literal 08:00, twenty seconds ahead on a full-length published calendar. The world clock is untouched.
    const target = Math.ceil((Date.now() * 1000 + 20_000_000) / TICK) * TICK;
    const fixture = publishFixture(join(world, 'log'), target);
    const tokens = readFileSync(join(world, 'souls.tokens'), 'utf8').trim().split('\n');
    let w = await serve('1/1');
    const { address } = await lookup('localhost', { family: 4 });
    const gw = run('gatewayd', ['--listen', `${address}:0`, '--world', socket, '--tokens', join(world, 'tokens'), '--build', `1220${'ab'.repeat(32)}`]);
    const match = await waitFor(() => /listening (\S+)\n/.exec(gw.text())), gateway = `ws://${match[1]}/v2/ws`;
    const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
    wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
    const before = await snapshot(wire, gateway, tokens[1]);
    const record = (copy, id) => {
      const todo = Object.values(JSON.parse(copy.roots()));
      while (todo.length) {
        const r = decode(copy.record(todo.pop()));
        if (idText(r.get(1)) === id) return r;
        for (const h of r.get(10) ?? []) todo.push(Buffer.from(h).toString('hex'));
      }
      return null;
    };
    const rootRecord = (copy) => record(copy, fixture.root);
    const beforeFields = rootRecord(before).get(6);
    for (const [field, value] of fixture.fields) assert.deepEqual(beforeFields.get(field), value, `published fixture field ${field}`);
    assert.deepEqual(clockOf(before), w.clock);
    assert.equal(nextWorldTime('08:00', calendarOf(before), worldNow(w.clock)), target);
    // E7's actual published one-off hours: the opening, in world µs, is the scheduler's input.
    const shop = record(before, fixture.shop);
    assert.ok(shop, 'the served shop holds the declared entry');
    assert.equal(shop.get(6).get(27), 'testworld:square');
    assert.deepEqual(shop.get(6).get(81), fixture.hours, 'the opening comes from the shop, not a local schedule constant');
    const opening = shop.get(6).get(81)[0][1];
    const act = `act testworld:visit:${idText(shop.get(1))}`;
    const schedule = join(home, 'souls', SOUL, 'memory/schedule.md');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'https://example.invalid/', gateway } } }));
    writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token: tokens[0] } } } }), { mode: 0o600 });
    chmodSync(join(home, 'credentials.json'), 0o600);
    const pub = addEntry(schedule, { when: '08:00', does: act }, Date.now());
    const opens = addEntry(schedule, { when: `world ${opening}us`, does: act }, Date.now());
    await call(home, SOUL, { op: 'status' }, { pkg: PKG, within: 30_000, ms: 30_000 });
    await waitFor(async () => (await ask({ op: 'status' })).connected);
    await waitFor(() => JSON.parse(readFileSync(rt.state, 'utf8')).schedule?.targets?.[pub.key]);
    const prior = JSON.parse(readFileSync(rt.state, 'utf8')).schedule.targets[pub.key];
    await kill(w.p);
    w = await serve('2/1');
    await waitFor(async () => {
      await ask({ op: 'look' });
      return (await ask({ op: 'status' })).clock?.rate[0] === 2;
    });
    const after = await snapshot(wire, gateway, tokens[1]);
    assert.deepEqual(clockOf(after), w.clock, 'new actual published mapping after restart');
    for (const [field, value] of fixture.fields) assert.deepEqual(rootRecord(after).get(6).get(field), value, `field ${field} survives restart`);
    const current = JSON.parse(readFileSync(rt.state, 'utf8')).schedule.targets[pub.key];
    assert.equal(current.worldUs, prior.worldUs);
    assert.ok(current.realMs < prior.realMs, 'rate two advances the real deadline');
    const answers = [];
    await waitFor(async () => {
      answers.push(...(await ask({ op: 'read' })).events.filter((e) => e.kind === 'answer'));
      const marks = JSON.parse(readFileSync(rt.state, 'utf8')).schedule.marks;
      return [pub, opens].every((e) => marks[e.key]?.sequence && answers.some((a) => a.sequence === marks[e.key].sequence && a.answer === 1));
    });
    const trace = readFileSync(join(rt.dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const marks = JSON.parse(readFileSync(rt.state, 'utf8')).schedule.marks;
    const delivered = records(join(world, 'log'));
    assert.deepEqual(record(after, fixture.shop).get(6).get(81), fixture.hours);
    const report = { before: { clock: clockOf(before), calendar: [...fixture.fields], hours: fixture.hours },
      after: { clock: clockOf(after), calendar: [...fixture.fields.keys()].map((f) => [f, rootRecord(after).get(6).get(f)]),
        hours: record(after, fixture.shop).get(6).get(81) }, triggers: [] };
    for (const [e, at] of [[pub, target], [opens, opening]]) {
      const sequence = marks[e.key].sequence, sends = trace.filter((r) => r.k === 'send' && r.seq === sequence);
      assert.equal(sends.length, 1, 'exactly one actual send per persisted occurrence');
      const sentWorldUs = worldNow(w.clock, sends[0].t * 1000), lateWorldUs = sentWorldUs - at;
      assert.ok(lateWorldUs >= 0 && lateWorldUs <= TICK, `${e.id}: actual send ${lateWorldUs} world µs after its moment`);
      const receipt = delivered.find((part) => Array.isArray(part.get(3)) && part.get(3).some((r) => r.get(2) === sequence
        && idText(r.get(1)[1]) === tokens[0].split('.')[0].slice(5)));
      assert.ok(receipt, 'the exact sequence has a durable answer');
      report.triggers.push({ id: e.id, targetWorldUs: at, sentWorldUs, lateWorldUs, sequence, receiptWorldTick: receipt.get(5), receiptWorldUs: receipt.get(5) * TICK });
    }
    console.log(JSON.stringify(report));
  } catch (err) {
    err.message += `\n${output.map((out) => out()).join('\n')}`;
    throw err;
  } finally {
    await ask({ op: 'stop' }).catch(() => {});
    for (const p of procs) await kill(p);
    if (!process.env.R15B_KEEP) rmSync(dir, { recursive: true, force: true });
    else console.log(`retained fixture ${dir}`);
  }
});
