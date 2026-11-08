// #1328 (with #1327's client half): one intention, one key. A write the world did not confirm keeps its key until it is
// confirmed, a rerun sends the same key (and, for act, the same clientRef), and the client looks the write up by its key
// before it advises anything. `unavailable` and `world.stalled` are waited out with the same key; unkeyed writes never repeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intentionOf, confirmedAnswer, keyArg, slowedSentence, STALL_CODES, PENDING_FILE } from './soul/eden.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const unavailable = (res) => json(res, 503, { error: { code: 'unavailable', message: 'the ledger could not answer; retry' } });

// A small world that keeps receipts by clientRef, as the edge ledger does (`actOnce`: a known clientRef answers its receipt).
async function fixture(t, respond) {
  const dir = mkdtempSync(join(tmpdir(), 'souls-same-key-')), seen = [], receipts = new Map();
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => { const s = { method: req.method, url: req.url, key: req.headers['idempotency-key'] ?? null, body: body ? JSON.parse(body) : null }; seen.push(s); respond(req, res, s, { seen, receipts }); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_key', token: 'synthetic-key-token' }), { mode: 0o600 });
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = (...args) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, EDEN_TIME_SCALE: '0.02' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('exit', code => { let d = null; try { d = JSON.parse(out); } catch {} resolve({ code, d, stdout: out, stderr: err }); });
  });
  return { dir, seen, receipts, run };
}
const receiptFor = (receipts, ref) => { if (!receipts.has(ref)) receipts.set(ref, { id: `r_${receipts.size + 1}`, capability: 'read:here', phase: 'started' }); return receipts.get(ref); };
const acts = (seen) => seen.filter(s => s.method === 'POST' && s.url === '/v1/edge/act');

test('helpers: the intention leaves out key, clientRef, now and the message served; --key is a world key; stall codes', () => {
  assert.equal(intentionOf('/v1/edge/act', { capability: 'read:here', params: { b: 1, a: 2 }, strict: true, clientRef: 'x', now: 'n', for: 'msg_1', forDefault: true }),
    intentionOf('/v1/edge/act?x=1', { strict: true, params: { a: 2, b: 1 }, capability: 'read:here' }));
  assert.notEqual(intentionOf('/v1/edge/act', { capability: 'read:here' }), intentionOf('/v1/edge/act', { capability: 'wave:here' }));
  assert.notEqual(intentionOf('/v1/edge/act', { capability: 'read:here' }), intentionOf('/v1/edge/say', { capability: 'read:here' }));
  for (const [status, data, want] of [[200, {}, true], [400, {}, true], [0, {}, false], [503, {}, false], [502, {}, false], [429, {}, false], [409, { error: { code: 'idempotency-key-reused' } }, false], [409, { error: { code: 'other' } }, true]])
    assert.equal(confirmedAnswer({ status, data }), want, `${status}`);
  assert.equal(keyArg('k-1.2_3'), 'k-1.2_3');
  for (const bad of ['', 'has space', 'x'.repeat(101), undefined]) assert.throws(() => keyArg(bad), /--key takes/);
  for (const c of ['unavailable', 'world.unavailable', 'world.stalled']) assert.ok(STALL_CODES.has(c), c);
  const s = slowedSentence([{ at: 1000, code: 'unavailable', reason: 'the ledger could not answer', ms: null, next: 'check' }], 'requests', 2000);
  assert.doesNotMatch(s, /try once more/);
  assert.match(s, /did not confirm it; the same command again checks first and sends the same key, so the world acts at most once\.$/);
});

test('the Eden shape: an act taken but answered 503, run again, is answered with the first receipt under the same key; one receipt', { timeout: 20_000 }, async t => {
  let lookups = 0;
  const f = await fixture(t, (req, res, s, w) => {
    if (s.url.startsWith('/v1/edge/operations/')) { lookups++; return json(res, 200, { state: 'unknown', note: 'No retained outcome found.' }); }
    if (s.url === '/v1/edge/act') {
      const r = receiptFor(w.receipts, s.body.clientRef);   // the world takes it every time it hears it…
      return acts(w.seen).length <= 4 ? unavailable(res) : json(res, 200, { accepted: true, receipt: r, channel: 'body' });   // …but its first four answers are lost
    }
    json(res, 200, {});
  });
  const first = await f.run('act', 'read:here');
  assert.equal(first.code, 75, first.stderr);
  assert.equal(acts(f.seen).length, 4, 'one try and three waits on unavailable, like a busy world');
  assert.equal(lookups, 1, 'looked up by its key before advising');
  const lookup = f.seen.find(s => s.url.startsWith('/v1/edge/operations/'));
  assert.equal(lookup.url, `/v1/edge/operations/${encodeURIComponent(acts(f.seen)[0].key)}?route=${encodeURIComponent('POST /v1/edge/act')}`);
  assert.equal(first.d.unconfirmed, true); assert.equal(first.d.code, 'unavailable'); assert.equal(first.d.accepted, undefined, 'neither accepted nor refused');
  assert.match(first.d.reason, /did not confirm this act \(unavailable\).*same key, so the world acts at most once/);
  assert.doesNotMatch(first.stdout, /try once more/);
  assert.match(first.d.slowed, /did not confirm it; the same command again checks first and sends the same key/);
  assert.ok(existsSync(join(f.dir, PENDING_FILE)), 'the key is kept for a rerun');

  const again = await f.run('act', 'read:here');
  assert.equal(again.code, 0, again.stderr);
  const all = acts(f.seen);
  assert.equal(all.length, 5);
  assert.ok(all.every(s => s.key === all[0].key && s.body.clientRef === all[0].key), 'one key and clientRef for the act and its rerun');
  assert.equal(f.receipts.size, 1, 'the world has one receipt');
  assert.equal(again.d.receipt.id, 'r_1'); assert.equal(again.d.resent, true);
  assert.ok(!existsSync(join(f.dir, PENDING_FILE)), 'confirmed: the key is let go');

  const fresh = await f.run('act', 'read:here');   // a new act after a confirmed one is a new intention
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.notEqual(acts(f.seen).at(-1).key, all[0].key);
  assert.equal(fresh.d.resent, undefined);
});

test('check first: an unconfirmed act the world has a record of is reported with its receipt and phase, and not sent again', { timeout: 20_000 }, async t => {
  const f = await fixture(t, (req, res, s, w) => {
    if (s.url.startsWith('/v1/edge/operations/')) {
      const key = decodeURIComponent(s.url.split('/')[4].split('?')[0]), r = w.receipts.get(key);
      return json(res, 200, r ? { state: 'recorded', evidence: 'action-receipt', status: 200, response: { accepted: true, receipt: r } } : { state: 'unknown' });
    }
    if (s.url === '/v1/edge/act') { receiptFor(w.receipts, s.body.clientRef); return res.socket.destroy(); }   // taken, then the answer is lost
    json(res, 200, {});
  });
  const got = await f.run('act', 'read:here');
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.d.accepted, true); assert.equal(got.d.checked, true);
  assert.deepEqual(got.d.receipt, { id: 'r_1', capability: 'read:here', phase: 'started' });
  assert.equal(f.receipts.size, 1);
  assert.ok(acts(f.seen).every(s => s.key === acts(f.seen)[0].key), 'the transport retries kept the key');
  assert.ok(!existsSync(join(f.dir, PENDING_FILE)), 'found: nothing left pending');
  assert.doesNotMatch(got.stdout, /try once more/);
});

test('world.stalled is waited out with the same key and then answers; say and --key; an unkeyed write is never repeated', { timeout: 20_000 }, async t => {
  let n = 0;
  const f = await fixture(t, (req, res, s) => {
    if (s.url === '/v1/edge/say') return ++n === 1 ? json(res, 503, { error: { code: 'world.stalled', message: 'the world clock has stalled' } }) : json(res, 200, { said: true });
    if (s.url.startsWith('/v1/edge/inbox/')) return unavailable(res);
    json(res, 200, {});
  });
  const said = await f.run('say', 'hello', 'there', '--key', 'my-key-1');
  assert.equal(said.code, 0, said.stderr);
  const says = f.seen.filter(s => s.url === '/v1/edge/say');
  assert.equal(says.length, 2); assert.deepEqual(says.map(s => s.key), ['my-key-1', 'my-key-1']);
  assert.equal(says[0].body.text, 'hello there');
  assert.match(said.stderr, /the world's clock has stalled; waiting/);
  const speech = await f.run('say', 'what', '--key', 'means');   // only a trailing --key is a flag
  assert.equal(f.seen.filter(s => s.url === '/v1/edge/say').at(-1).body.text, 'what');
  assert.equal(speech.code, 0);
  const ack = await f.run('ack', 'msg_1', 'Got it.');
  assert.notEqual(ack.code, 0);
  assert.equal(f.seen.filter(s => s.url.startsWith('/v1/edge/inbox/')).length, 1, 'ack has no key: one try');
  const bad = await f.run('act', 'read:here', '--key', 'has space');
  assert.equal(bad.code, 1); assert.match(bad.stderr, /--key takes/);
});
