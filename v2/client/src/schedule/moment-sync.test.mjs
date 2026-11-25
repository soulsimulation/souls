// A world moment's act leaves at its moment while a sync is under way (#1960 pub flake, second cause). The daemon's
// one-second beat re-arms the world deadline; during a sync it used to clear that deadline and arm nothing, so the
// moment waited for the sync's last answer. A relay holds one sync answer across a beat and the moment, on real
// worldd serve and gatewayd; the act must be sent before the held answer is released.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decode, idText } from '../brief/copy.mjs';
import { call, DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { addEntry } from './schedule.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const TICK = 50_000;
const v2 = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const bin = (name) => process.env[name.toUpperCase()] ?? join(v2, 'target/debug', name);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await f();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

/** A TCP relay before gatewayd: server frames pass unchanged, except one sync answer held once `hold` is set. */
async function relay(port, wire) {
  const sockets = new Set();
  const r = { hold: false, heldAt: null, release: null };
  const server = createServer((down) => {
    const up = createConnection(port, '127.0.0.1');
    sockets.add(up); sockets.add(down);
    down.pipe(up);
    let data = Buffer.alloc(0), upgraded = false, plain = false;
    up.on('data', (chunk) => {
      if (plain) { down.write(chunk); return; }
      data = Buffer.concat([data, chunk]);
      if (!upgraded) {
        const end = data.indexOf('\r\n\r\n');
        if (end < 0) return;
        // A plain HTTP exchange (the daemon's entries fetch) passes through unparsed.
        if (!data.subarray(0, 12).toString('latin1').startsWith('HTTP/1.1 101')) { plain = true; down.write(data); return; }
        down.write(data.subarray(0, end + 4)); data = data.subarray(end + 4); upgraded = true;
      }
      while (data.length >= 2) {
        let size = data[1] & 127, at = 2;
        if (size === 126) { if (data.length < 4) return; size = data.readUInt16BE(2); at = 4; }
        else if (size === 127) { if (data.length < 10) return; size = Number(data.readBigUInt64BE(2)); at = 10; }
        if (data.length < at + size) return;
        const frame = data.subarray(0, at + size);
        data = data.subarray(at + size);
        if (r.hold && (frame[0] & 15) === 2 && wire.wireFrame(frame.subarray(at)).startsWith('sync ')) {
          r.hold = false; r.heldAt = Date.now();
          r.release = () => { down.write(frame); return Date.now(); };
          continue;
        }
        down.write(frame);
      }
    });
    for (const s of [up, down]) { s.on('error', () => {}); s.on('close', () => { up.destroy(); down.destroy(); }); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  r.port = server.address().port;
  r.close = () => { for (const s of sockets) s.destroy(); server.close(); };
  return r;
}

test('a world moment is sent at its moment while a sync is held across a beat', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moment-sync-')), home = join(dir, 'h'), world = join(dir, 'w'), socket = join(dir, 'w.sock');
  const SOUL = 's_moment', procs = [];
  const env = { PATH: process.env.PATH, BRAIN_MODE: 'fake', SOULS_HOME: home };
  const rt = runtimeOf(home, SOUL);
  const run = (name, args) => {
    const p = spawn(bin(name), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
    procs.push(p);
    return { p, text: () => text };
  };
  const ask = (q) => request(rt.socket, q, 30_000);
  let proxy;
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
    // The seed is one record: a 32-byte log header, a 12-byte record head, then its payload.
    const log = readFileSync(join(world, 'log')), part = decode(log.subarray(44, 44 + log.readUInt32LE(32)));
    const shop = part.get(2).flatMap((e) => e.get(7) ?? []).find((c) => c.get(1) === 1 && c.get(6)?.get(27) === 'testworld:square')?.get(2);
    assert.ok(shop, 'the seed contains the declared thing');
    const tokens = readFileSync(join(world, 'souls.tokens'), 'utf8').trim().split('\n');
    const w = run('worldd', ['serve', '--dir', world, '--socket', socket, '--rate', '1/1']);
    await waitFor(() => /listening /.test(w.text()));
    assert.match(w.text(), /worldd: clock world 0 real 0 rate 1\/1\n/, 'a fresh seed: world µs are real µs');
    const gw = run('gatewayd', ['--listen', '127.0.0.1:0', '--world', socket, '--tokens', join(world, 'tokens'), '--build', `1220${'ab'.repeat(32)}`]);
    const port = Number((await waitFor(() => /listening \S+:(\d+)\n/.exec(gw.text())))[1]);
    const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
    wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
    proxy = await relay(port, wire);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'https://example.invalid/', gateway: `ws://127.0.0.1:${proxy.port}/v2/ws` } } }));
    writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token: tokens[0] } } } }), { mode: 0o600 });
    chmodSync(join(home, 'credentials.json'), 0o600);
    // A world moment far enough ahead to hold a sync for more than one beat before it.
    const moment = Math.ceil((Date.now() + 8_000) * 1000 / TICK) * TICK;
    const entry = addEntry(join(home, 'souls', SOUL, 'memory/schedule.md'), { when: `world ${moment}us`, does: `act testworld:visit:${idText(shop)}` }, Date.now());
    await call(home, SOUL, { op: 'status' }, { pkg: PKG, within: 30_000, ms: 30_000 });
    await waitFor(async () => (await ask({ op: 'status' })).connected);
    const target = await waitFor(() => JSON.parse(readFileSync(rt.state, 'utf8')).schedule?.targets?.[entry.key]);
    assert.equal(target.realMs, moment / 1000);
    const at = target.realMs;
    // Hold a sync answer from before the moment until 0.5 s after it: at least one beat falls inside. A copy confirmed
    // within 1 s answers a look without asking (#4716), so the hold starts once the copy is older than that: the look
    // then asks, and its sync is the one held (from 2.8 s before the moment, by 1.8 s before it at the latest).
    await waitFor(async () => Date.now() >= at - 2_800 && (await ask({ op: 'status' })).age > 1_000, 30_000);
    proxy.hold = true;
    const looked = ask({ op: 'look' }).catch(() => null); // brings the copy current: a sync whose answer is held
    await waitFor(() => proxy.heldAt !== null, 5_000);
    assert.ok(proxy.heldAt <= at - 1_100, `the hold began ${at - proxy.heldAt} ms before the moment, more than a beat`);
    await waitFor(() => Date.now() >= at + 500, 30_000);
    const released = proxy.release();
    await looked;
    const mark = await waitFor(() => JSON.parse(readFileSync(rt.state, 'utf8')).schedule.marks[entry.key]?.sequence && JSON.parse(readFileSync(rt.state, 'utf8')).schedule.marks[entry.key]);
    const sends = readFileSync(join(rt.dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.k === 'send' && r.seq === mark.sequence);
    assert.equal(sends.length, 1, 'one send for the occurrence');
    assert.ok(sends[0].t >= at, `sent ${sends[0].t - at} ms after its moment, never before`);
    assert.ok(sends[0].t < released, `sent ${sends[0].t - at} ms after its moment, ${sends[0].t - released} ms after the held sync answer`);
  } finally {
    await ask({ op: 'stop' }).catch(() => {});
    proxy?.close();
    await stopThenRemove(procs, dir, { signal: 'SIGKILL' });
  }
});
