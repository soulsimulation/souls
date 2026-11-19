// R21 (#3594): a real joined Soul must renew hearing even when a pre-birth hash answer reaches it after its receipt.
// The relay holds just that answer, not the receipt; no discovery command follows the receipt. Run with matching
// worldd/gatewayd/testworld binaries and replica WASM, as the other daemon integration tests do.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PKG, call, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { decode } from '../brief/copy.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (name) => process.env[name.toUpperCase()] ?? join(v2, 'target/debug', name);
const pkg = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const wire = await import(pathToFileURL(join(pkg, 'replica.js')).href);
wire.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function until(f, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) { const value = await f(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await sleep(10); }
}

// Only server-to-client frames are inspected, so these have no mask. Bytes are forwarded unchanged, including
// control frames. The production encoder supplies complete unfragmented messages for these small sync answers.
async function relay(port) {
  const sockets = new Set();
  const r = { hold: false, held: null, scopeAnswers: 0, release: null, inject: null };
  const server = createServer((down) => {
    const up = createConnection(port, '127.0.0.1');
    sockets.add(up); sockets.add(down);
    down.pipe(up);
    let data = Buffer.alloc(0), upgraded = false;
    r.inject = (bytes) => {
      assert.ok(bytes.length < 126);
      down.write(Buffer.concat([Buffer.from([0x82, bytes.length]), bytes]));
    };
    up.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (!upgraded) {
        const end = data.indexOf('\r\n\r\n');
        if (end < 0) return;
        down.write(data.subarray(0, end + 4)); data = data.subarray(end + 4); upgraded = true;
      }
      while (data.length >= 2) {
        let size = data[1] & 127, at = 2;
        if (size === 126) { if (data.length < 4) return; size = data.readUInt16BE(2); at = 4; }
        if (size === 127) { if (data.length < 10) return; size = Number(data.readBigUInt64BE(2)); at = 10; }
        if (data.length < at + size) return;
        const frame = data.subarray(0, at + size), payload = frame.subarray(at);
        data = data.subarray(at + size);
        if ((frame[0] & 15) === 2) {
          const value = decode(payload);
          if (value instanceof Map && value.has(20) && value.has(25)) r.scopeAnswers++;
          if (r.hold && wire.wireFrame(payload).startsWith('sync ')) {
            r.hold = false; r.held = frame;
            r.release = () => { down.write(r.held); r.held = null; };
            continue;
          }
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
    const p = spawn(bin(name), args, { stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(p);
    const child = { name, exit: null, stdout: '', stderr: '' }; children.push(child);
    let out = '';
    const take = (stream, d) => {
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
    const cases = [];
    for (const client of clients) {
      let events = [], readError = null, daemon = '';
      try { events = (await request(client.rt.socket, { op: 'read' })).events ?? []; }
      catch (e) { readError = { code: e.code, message: e.message }; }
      try { daemon = readFileSync(client.rt.log, 'utf8').slice(-4096); } catch { /* no daemon log */ }
      cases.push({ case: client.case, stage: client.stage, sent: client.sent, lastStatus: client.lastStatus,
        receipt: client.receipt ?? (client.sent?.sequence === undefined ? null : events.find((e) => e.sequence === client.sent.sequence) ?? null),
        recentEvents: events.slice(-12), readError, daemon });
    }
    const evidence = redact({ error: { name: error.name, message: error.message }, cases, children });
    const kept = join(v2, '..', '.local', `r21-join-sync-failure-${randomBytes(6).toString('hex')}`);
    mkdirSync(kept, { recursive: true, mode: 0o700 });
    writeFileSync(join(kept, 'diagnostics.json'), evidence + '\n', { mode: 0o600 });
    console.error(`R21 synthetic failure diagnostics (retained under ignored scratch): ${evidence}`);
    throw error;
  } finally {
    for (const { rt, proxy } of clients) { await request(rt.socket, { op: 'stop' }).catch(() => {}); proxy.close(); }
    await Promise.all(procs.map((p) => new Promise((ok) => { if (p.exitCode !== null) return ok(); p.once('exit', ok); p.kill(); })));
    rmSync(dir, { recursive: true, force: true });
  }
});
