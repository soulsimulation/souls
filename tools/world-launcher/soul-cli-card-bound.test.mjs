// #2380: an act made for an owner message that fails leaves the owner's card closed or one exact close step away (A1), and
// no command outlives an agent harness's shell limit: retries and waits stop within the command's time (A2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_MS, BACKGROUND } from './soul/eden.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const busy = (res) => { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' }); res.end(JSON.stringify({ error: { code: 'world.busy', message: 'the world is busy', retry_after_s: 1 } })); };

async function fixture(t, respond) {
  const dir = mkdtempSync(join(tmpdir(), 'souls-card-bound-')), seen = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => { const s = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null }; seen.push(s); respond(req, res, s, seen); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_card', token: 'synthetic-card-token' }), { mode: 0o600 });
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = (env, ...args) => new Promise(resolve => {
    const t0 = Date.now(), child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('exit', code => { let d = null; try { d = JSON.parse(out); } catch {} resolve({ code, d, stdout: out, stderr: err, ms: Date.now() - t0 }); });
  });
  return { seen, run };
}
const results = (seen) => seen.filter(s => s.method === 'POST' && /^\/v1\/edge\/inbox\/[^/]+\/result$/.test(s.url));
const inbox = (res, s) => json(res, 200, { message: { id: 'msg_1', state: 'delivered', text: 'sit on the bench' } });

test('A2: the command time is under the harness limit, and the background commands are the only ones without it', () => {
  assert.ok(COMMAND_MS <= 90_000, `${COMMAND_MS}`);
  assert.deepEqual([...BACKGROUND].sort(), ['dashboard', 'listen', 'serve']);
});

test('A1: a refused act for a message answers the exact close step and closes nothing itself', { timeout: 20_000 }, async t => {
  const f = await fixture(t, (req, res, s) => {
    if (s.url === '/v1/edge/act') return json(res, 200, { accepted: false, code: 'spot.taken', reason: 'Someone is sitting there.' });
    if (s.url.startsWith('/v1/edge/inbox/msg_1')) return inbox(res, s);
    json(res, 200, {});
  });
  const r = await f.run({}, 'act', 'sit:e_1', '--for', 'msg_1');
  assert.equal(r.d.accepted, false, r.stderr);
  assert.equal(r.d.close, `node eden.mjs ack msg_1 "Couldn't: Someone is sitting there." --close failed`);
  assert.equal(results(f.seen).length, 0, 'another id may still serve it, and an agent close is final');
  const plain = await f.run({}, 'act', 'sit:e_1', '--for', 'none');
  assert.equal(plain.d.close, undefined, 'an act for no message has no card');
});

test('A1: an act for a message the world was too busy to take: the first answer gives the close step, a failed rerun closes the card', { timeout: 20_000 }, async t => {
  const f = await fixture(t, (req, res, s) => {
    if (s.url === '/v1/edge/act') return busy(res);
    if (s.url.startsWith('/v1/edge/operations/')) return json(res, 200, { state: 'unknown' });
    if (s.method === 'GET' && s.url === '/v1/edge/inbox/msg_1') return inbox(res, s);
    if (s.url === '/v1/edge/inbox/msg_1/result') return json(res, 200, { latest: { id: 'msg_1', result: s.body.text, outcome: s.body.outcome } });
    json(res, 200, {});
  });
  const env = { EDEN_TIME_SCALE: '0.02' };
  const first = await f.run(env, 'act', 'sit:e_1', '--for', 'msg_1');
  assert.equal(first.code, 75, first.stderr);
  assert.equal(first.d.unconfirmed, true);
  assert.match(first.d.close, /^node eden\.mjs ack msg_1 "Couldn't do it: the world was too busy to answer in time\." --close failed$/);
  assert.equal(results(f.seen).length, 0, 'a rerun may still take it');
  const again = await f.run(env, 'act', 'sit:e_1', '--for', 'msg_1');
  assert.equal(again.code, 75, again.stderr);
  assert.equal(again.d.closed, 'failed');
  assert.equal(again.d.card, "Couldn't do it: the world was too busy to answer in time.");
  assert.equal(again.d.close, undefined);
  const [closed] = results(f.seen);
  assert.deepEqual(closed.body, { outcome: 'failed', text: "Couldn't do it: the world was too busy to answer in time." });
});

test('A2: a busy world is not waited out past the command time; the answer comes back within it', { timeout: 20_000 }, async t => {
  const f = await fixture(t, (req, res, s) => {
    if (s.url === '/v1/edge/act') return busy(res);
    if (s.url.startsWith('/v1/edge/operations/')) return json(res, 200, { state: 'unknown' });
    json(res, 200, {});
  });
  const r = await f.run({ EDEN_COMMAND_MS: '1500' }, 'act', 'sit:e_1', '--for', 'none');
  assert.equal(r.code, 75, r.stderr);
  assert.equal(r.d.unconfirmed, true, 'rerun-able with the same key');
  assert.ok(r.ms < 1500 + 3000, `returned in ${r.ms} ms`);
  assert.ok(f.seen.filter(s => s.url === '/v1/edge/act').length < 4, 'fewer than the usual one try and three waits');
});

test('A2: act --wait 300 returns within the command time, still going, with how to resume', { timeout: 30_000 }, async t => {
  const f = await fixture(t, (req, res, s) => {
    if (s.url === '/v1/edge/act') return json(res, 200, { accepted: true, receipt: { id: 'r_1', capability: 'walk:far', phase: 'started' }, channel: 'body' });
    if (s.url.startsWith('/v1/edge/wait')) {
      const secs = Number(new URL(s.url, 'http://x').searchParams.get('timeout'));
      return setTimeout(() => json(res, 200, { events: [], cursor: 'c_1' }), Math.min(secs, 1) * 1000);
    }
    if (s.url === '/v1/edge/receipts/r_1') return json(res, 200, { receipt: { id: 'r_1', capability: 'walk:far', phase: 'started' } });
    json(res, 200, {});
  });
  const r = await f.run({ EDEN_COMMAND_MS: '8000' }, 'act', 'walk:far', '--for', 'none', '--wait', '300');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 8000, `returned in ${r.ms} ms`);
  assert.equal(r.d.done, false);
  assert.match(r.d.waitCapped, /the most one command waits; still going: `wait` again while done is false/);
});
