// R21 (#3594): a real joined Soul must renew hearing even when a pre-birth hash answer reaches it after its receipt.
// The relay holds just that answer, not the receipt; no discovery command follows the receipt. Run with matching
// worldd/gatewayd/testworld binaries and replica WASM, as the other daemon integration tests do.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PKG, call, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { decode } from '../brief/copy.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (name) => process.env[name.toUpperCase()] ?? join(v2, 'target/debug', name);
const pkg = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const wire = await import(pathToFileURL(join(pkg, 'replica.js')).href);
wire.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// One observer clock for relay events and arrival of child stderr. Arrival is not the child's actual send epoch.
const observedStart = process.hrtime.bigint();
const observedUs = () => Number((process.hrtime.bigint() - observedStart) / 1000n);
async function until(f, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) { const value = await f(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await sleep(10); }
}

// Only server-to-client frames are inspected, so these have no mask. Bytes are forwarded unchanged, including
// control frames. The production encoder supplies complete unfragmented messages for these small sync answers.
async function relay(port) {
  const sockets = new Set();
  const r = { hold: false, held: null, scopeAnswers: 0, release: null, inject: null, observed: [], metadata: [], connections: [] };
  let connection = 0;
  const server = createServer((down) => {
    const up = createConnection(port, '127.0.0.1');
    sockets.add(up); sockets.add(down);
    down.pipe(up);
    let data = Buffer.alloc(0), upgraded = false;
    const state = { connection: ++connection, receivedBytes: 0, frames: 0, bufferedBytes: 0, upgraded: false };
    r.connections.push(state); if (r.connections.length > 4) r.connections.shift();
    const mark = (kind, fields = {}) => {
      state.bufferedBytes = data.length; state.upgraded = upgraded;
      state.upDestroyed = up.destroyed; state.downDestroyed = down.destroyed;
      r.metadata.push({ atUs: observedUs(), connection: state.connection, kind, ...fields });
      if (r.metadata.length > 64) r.metadata.shift();
    };
    const inject = (bytes) => {
      assert.ok(bytes.length < 126);
      down.write(Buffer.concat([Buffer.from([0x82, bytes.length]), bytes]));
    };
    let plain = false; // a plain HTTP exchange (the daemon's entries fetch, #3760) passes through, unparsed
    const observed = (frame, writeCalled) => {
      if (!frame) return;
      r.observed.push({ ...frame, writeCalled });
      if (r.observed.length > 24) r.observed.shift();
    };
    up.on('data', (chunk) => {
      state.receivedBytes += chunk.length;
      data = Buffer.concat([data, chunk]);
      mark('chunk', { bytes: chunk.length, totalBytes: state.receivedBytes, bufferedBytes: data.length });
      if (plain) { down.write(chunk); return; }
      if (!upgraded) {
        const end = data.indexOf('\r\n\r\n');
        if (end < 0) { mark('wait-upgrade', { bufferedBytes: data.length }); return; }
        if (!data.subarray(0, 12).toString('latin1').startsWith('HTTP/1.1 101')) { plain = true; down.write(data); data = Buffer.alloc(0); return; }
        down.write(data.subarray(0, end + 4)); data = data.subarray(end + 4); upgraded = true;
        r.inject = inject;
        mark('upgraded');
      }
      while (data.length >= 2) {
        let size = data[1] & 127, at = 2;
        if (size === 126) { if (data.length < 4) { mark('wait-header', { needBytes: 4 }); return; } size = data.readUInt16BE(2); at = 4; }
        else if (size === 127) { if (data.length < 10) { mark('wait-header', { needBytes: 10 }); return; } size = Number(data.readBigUInt64BE(2)); at = 10; }
        if (data.length < at + size) { mark('wait-payload', { needBytes: at + size, bufferedBytes: data.length }); return; }
        const frame = data.subarray(0, at + size), payload = frame.subarray(at);
        data = data.subarray(at + size);
        state.frames++;
        mark('complete-frame', { frame: state.frames, opcode: frame[0] & 15, fin: !!(frame[0] & 128),
          masked: !!(frame[1] & 128), bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
        let summary = null;
        if ((frame[0] & 15) === 2) {
          let value;
          try { value = decode(payload); }
          catch (error) { mark('parse-error', { parser: 'cbor' }); throw error; }
          if (value instanceof Map) {
            const answer = value.get(2), request = value.get(20);
            if (typeof request === 'number') summary = { kind: 'sync', request,
              stage: value.has(25) ? 'scope' : value.has(22) ? 'records' : value.has(21) ? 'hashes' : 'other' };
            else if (answer instanceof Map) summary = { kind: 'answer',
              sequence: typeof answer.get(2) === 'number' ? answer.get(2) : null,
              answer: typeof answer.get(3) === 'number' ? answer.get(3) : null };
          }
          mark('parsed', { category: summary?.kind ?? 'other', summary });
          if (value instanceof Map && value.has(20) && value.has(25)) r.scopeAnswers++;
          let heldSync = false;
          if (r.hold) {
            try { heldSync = wire.wireFrame(payload).startsWith('sync '); }
            catch (error) { mark('parse-error', { parser: 'wire-frame' }); throw error; }
          }
          if (r.hold && heldSync) {
            r.hold = false; r.held = frame;
            observed(summary, false); mark('held', { frame: state.frames });
            r.release = () => { down.write(r.held); observed(summary, true); r.held = null; mark('released'); };
            continue;
          }
        }
        down.write(frame);
        observed(summary, true); mark('forwarded', { frame: state.frames });
      }
      mark('parser-idle', { bufferedBytes: data.length });
    });
    for (const [side, s] of [['up', up], ['down', down]]) {
      s.on('error', (error) => { mark('error', { side, code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'other' }); });
      s.on('end', () => { mark('end', { side }); });
      s.on('close', (hadError) => { mark('close', { side, hadError, upDestroyed: up.destroyed, downDestroyed: down.destroyed }); up.destroy(); down.destroy(); });
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  r.port = server.address().port;
  r.close = () => { for (const s of sockets) s.destroy(); server.close(); };
  return r;
}

test('R21 relay: length tags, partial headers and payloads preserve exact frames', async () => {
  let accept;
  const accepted = new Promise((ok) => { accept = ok; });
  const server = createServer((socket) => { accept(socket); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  let proxy, down, up;
  try {
    proxy = await relay(server.address().port);
    down = createConnection(proxy.port, '127.0.0.1');
    let received = Buffer.alloc(0);
    down.on('data', (bytes) => { received = Buffer.concat([received, bytes]); });
    await new Promise((ok) => down.once('connect', ok));
    up = await accepted;
    const upgrade = Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    up.write(upgrade);
    await until(() => proxy.connections[0]?.upgraded && received.length === upgrade.length);
    const forwarded = [];
    for (const length of [125, 126, 127, 128, 65536]) {
      // Valid CBOR byte strings exercise the real binary-frame decoder without inventing any join answer.
      const prefix = length < 256 ? 2 : 5;
      const payload = Buffer.alloc(length, 0x55);
      payload[0] = prefix === 2 ? 0x58 : 0x5a;
      if (prefix === 2) payload[1] = length - prefix;
      else payload.writeUInt32BE(length - prefix, 1);
      const header = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10);
      header[0] = 0x82;
      header[1] = header.length === 2 ? length : header.length === 4 ? 126 : 127;
      if (header.length === 4) header.writeUInt16BE(length, 2);
      if (header.length === 10) header.writeBigUInt64BE(BigInt(length), 2);
      const frame = Buffer.concat([header, payload]);
      const first = header.length - 1;
      up.write(frame.subarray(0, first));
      await until(() => proxy.connections[0].bufferedBytes === first);
      if (header.length > 2) assert.equal(proxy.metadata.at(-1).kind, 'wait-header');
      up.write(frame.subarray(first, frame.length - 1));
      await until(() => proxy.connections[0].bufferedBytes === frame.length - 1);
      assert.equal(proxy.metadata.at(-1).kind, 'wait-payload');
      assert.equal(proxy.metadata.at(-1).needBytes, frame.length, `exact wait for payload ${length}`);
      up.write(frame.subarray(frame.length - 1));
      forwarded.push(frame);
      await until(() => proxy.connections[0].frames === forwarded.length
        && received.length === upgrade.length + forwarded.reduce((n, bytes) => n + bytes.length, 0));
      assert.deepEqual(received.subarray(upgrade.length), Buffer.concat(forwarded));
      assert.equal(proxy.connections[0].bufferedBytes, 0);
    }
    const ping = Buffer.from([0x89, 4, 1, 2, 3, 4]);
    up.write(ping); forwarded.push(ping);
    await until(() => proxy.connections[0].frames === forwarded.length
      && received.length === upgrade.length + forwarded.reduce((n, bytes) => n + bytes.length, 0));
    assert.deepEqual(received.subarray(upgrade.length), Buffer.concat(forwarded));
    assert.equal(proxy.scopeAnswers, 0);
    assert.deepEqual(proxy.observed, [], 'parser fixtures created no receipt or scope answer');
  } finally {
    down?.destroy(); up?.destroy(); proxy?.close();
    await new Promise((ok) => server.close(ok));
  }
});

test('R21: a held pre-birth sync cannot satisfy the successful join refresh; unrelated/failed answers do not trigger it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r21-'));
  const procs = [], clients = [], children = [], secrets = [];
  const redact = (value) => {
    let text = JSON.stringify(value);
    for (const token of secrets) text = text.replaceAll(token, '<token>');
    for (const path of [dir, pkg, v2, ...['worldd', 'gatewayd', 'testworld'].map(bin)]) text = text.replaceAll(path, '<fixture-path>');
    return text.replaceAll(/"pid":\d+/g, '"pid":"<fixture-process>"').replaceAll(/(?:https?|wss?):\/\/[^\s"\\]+/g, '<test-address>')
      .replaceAll(/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, '<test-address>')
      .replaceAll(/\/(?:Users|home|private|tmp|var)\/[^\s"'\\]*/g, '<path>');
  };
  const run = (name, args, ready) => new Promise((ok, fail) => {
    const env = ['worldd', 'gatewayd'].includes(name) ? { ...process.env, SOULS_JOIN_DELIVERY_TRACE: '1' } : process.env;
    const p = spawn(bin(name), args, { stdio: ['ignore', 'pipe', 'pipe'], env }); procs.push(p);
    const child = { name, exit: null, stdout: '', stderr: '', delivery: '' }; children.push(child);
    let out = '';
    let deliveryLine = '';
    const deliveryLines = [];
    let deliveryBytes = 0;
    const take = (stream, d) => {
      if (stream === 'stderr') {
        const lines = (deliveryLine + d).split('\n'); deliveryLine = lines.pop().slice(-4096);
        for (const line of lines) {
          if (!line.startsWith('worldd: join-delivery ') && !line.startsWith('gatewayd: join-delivery ')) continue;
          const complete = line + ` captured-us=${observedUs()}\n`, bytes = Buffer.byteLength(complete);
          if (bytes > 65536) continue;
          deliveryLines.push(complete); deliveryBytes += bytes;
          while (deliveryBytes > 65536) deliveryBytes -= Buffer.byteLength(deliveryLines.shift());
          child.delivery = deliveryLines.join('');
        }
      }
      child[stream] = (child[stream] + d).slice(-2048);
      out = (out + d).slice(-4096); const found = ready?.exec(out); if (found) ok(found);
    };
    p.stdout.on('data', (d) => take('stdout', d)); p.stderr.on('data', (d) => take('stderr', d));
    p.on('exit', (code, signal) => { child.exit = { code, signal }; });
    p.on('exit', (code) => ready ? fail(new Error(`${name}: ${code}: ${out}`)) : code === 0 ? ok(out) : fail(new Error(out)));
  });
  try {
    await run('testworld', ['--seed', '1', '--things', '0', '--out', dir]);
    const world = join(dir, 'world'), socket = join(world, 'gateway.sock');
    await run('worldd', ['seed', '--facts', join(dir, 'testworld-s1-t0.facts.json'), '--dir', world, '--souls', '0', '--at', '-40,30']);
    await run('worldd', ['serve', '--dir', world], /listening /);
    const principal = (n) => `${'c9'.repeat(16)}-${n}`;
    const tokens = [1, 2].map((n) => `soul-${principal(n)}.${randomBytes(32).toString('hex')}`);
    secrets.push(...tokens);
    writeFileSync(join(world, 'tokens'), tokens.map((t) => `${t.split('.')[0]} ${createHash('sha256').update(t).digest('hex')}\n`).join(''));
    const gateway = await run('gatewayd', ['--listen', '127.0.0.1:0', '--world', socket, '--tokens', join(world, 'tokens'), '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
    for (const [index, success] of [false, true].entries()) {
      const n = index + 1, soul = `s_r21_${n}`, home = join(dir, `home-${n}`), rt = runtimeOf(home, soul);
      const proxy = await relay(Number(gateway[1].split(':').pop()));
      const client = { proxy, rt, case: success ? 'successful-join' : 'expired-join', stage: 'initial-sync', sent: null, lastStatus: null };
      clients.push(client);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { gateway: `ws://127.0.0.1:${proxy.port}/v2/ws` } } }));
      writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [soul]: { local: { token: tokens[index] } } } }), { mode: 0o600 });
      await call(home, soul, { op: 'status' }, { pkg });
      const status = async () => (client.lastStatus = await request(rt.socket, { op: 'status' }));
      const before = await until(async () => { const s = await status(); return s.connected && !s.syncing && s.viewGrants === 1 && s; });
      assert.equal(before.hearing, principal(n));
      // An unrelated receipt fixture has no pending own join and grants no body or extra sync.
      proxy.inject(wire.encode_diagnostic('{2: {2: 999, 3: 1}}'));
      await until(async () => (await request(rt.socket, { op: 'read' })).events?.some((e) => e.sequence === 999));
      assert.equal((await status()).follows, before.follows);
      assert.equal((await status()).hearing, principal(n));
      client.stage = 'held-pre-birth-sync';
      proxy.hold = true;
      const oldLook = request(rt.socket, { op: 'look' });
      await until(() => proxy.held);
      const scopesBefore = proxy.scopeAnswers;
      const sent = await request(rt.socket, { op: 'act', verb: 'life:join', ...(success ? {} : { expiry: 0 }) });
      client.sent = sent; client.stage = 'await-own-join-receipt';
      await until(async () => (await status()).answered === 1);
      assert.equal((await status()).syncing, true, 'the pre-birth sync is still held across the receipt');
      const events = (await request(rt.socket, { op: 'read' })).events;
      client.receipt = events.find((e) => e.sequence === sent.sequence);
      assert.equal(events.find((e) => e.sequence === sent.sequence).answer, success ? 1 : 2);
      client.stage = 'post-birth-sync';
      proxy.release();
      await oldLook;
      if (success) {
        const after = await until(async () => { const s = await status(); return !s.syncing && s.hearing !== principal(n) && s.viewGrants === 2 && s; });
        assert.equal(after.follows, before.follows + 1);
        assert.equal(proxy.scopeAnswers, scopesBefore + 1, 'one subsequent authoritative scope sync');
        console.log('successful join: held pre-birth reply crosses receipt; one later scope sync; linked-body Follow and grant');
      } else {
        await sleep(250);
        const after = await status();
        assert.equal(after.hearing, principal(n));
        assert.equal(after.follows, before.follows);
        assert.equal(proxy.scopeAnswers, scopesBefore);
        console.log('expired join and unrelated receipt: no body grant and no refresh loop');
      }
      const stable = await status();
      await sleep(250);
      assert.equal((await status()).follows, stable.follows, 'no continuing refresh loop');
    }
  } catch (error) {
    const failureObservedUs = observedUs();
    const cases = [];
    for (const client of clients) {
      let events = [], readError = null, daemon = '';
      try { events = (await request(client.rt.socket, { op: 'read' })).events ?? []; }
      catch (e) { readError = { code: e.code, message: e.message }; }
      try { daemon = readFileSync(client.rt.log, 'utf8').slice(-4096); } catch { /* no daemon log */ }
      cases.push({ case: client.case, stage: client.stage, sent: client.sent, lastStatus: client.lastStatus,
        receipt: client.receipt ?? (client.sent?.sequence === undefined ? null : events.find((e) => e.sequence === client.sent.sequence) ?? null),
        relay: client.proxy.observed.slice(-24),
        relayMetadata: client.proxy.metadata.slice(-64), relayConnections: client.proxy.connections,
        failureObservedUs, timingLimit: 'Child stderr capture is arrival on the relay observer clock, not actual native send time; cross-process elapsed clocks have separate origins.',
        recentEvents: events.slice(-12), readError, daemon });
    }
    const kept = join(v2, '..', '.local', `r21-join-sync-failure-${randomBytes(6).toString('hex')}`);
    mkdirSync(kept, { recursive: true, mode: 0o700 });
    const worldLog = { retained: false, bytes: null, stages: 'not decoded: retained for independent intake/birth/answer inspection' };
    try {
      const path = join(dir, 'world', 'log');
      if (statSync(path).size <= 16 * 1024 * 1024) {
        const bytes = readFileSync(path);
        if (bytes.length <= 16 * 1024 * 1024) {
          writeFileSync(join(kept, 'world.log'), bytes, { mode: 0o600 });
          worldLog.retained = true; worldLog.bytes = bytes.length;
        }
      }
    } catch { /* A missing synthetic log is reported, not substituted with a stage claim. */ }
    const evidence = redact({ error: { name: error.name, message: error.message }, cases, children, worldLog });
    writeFileSync(join(kept, 'diagnostics.json'), evidence + '\n', { mode: 0o600 });
    console.error(`R21 synthetic failure diagnostics (retained under ignored scratch): ${evidence}`);
    throw error;
  } finally {
    for (const { rt, proxy } of clients) { await request(rt.socket, { op: 'stop' }).catch(() => {}); proxy.close(); }
    await stopThenRemove(procs, dir);
  }
});
