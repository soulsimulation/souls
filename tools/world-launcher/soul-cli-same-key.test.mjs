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
import { intentionOf, confirmedAnswer, keyArg, sideKey, slowedSentence, stallRetries, STALL_CODES, PENDING_FILE } from './soul/eden.mjs';

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
  assert.match(slowedSentence([{ at: 1000, code: 'world.stalled', reason: 'x', ms: null, next: 'verify' }], 'requests', 2000), /I check whether it took before doing it again\.$/);
  assert.equal(confirmedAnswer({ status: 409, data: { error: { code: 'idempotency-key-reused' } } }, true), true, 'a named key used before: the world\'s refusal');
  assert.equal(sideKey('k'), 'k.f'); assert.equal(sideKey('x'.repeat(100)).length, 40);
  assert.equal(stallRetries('read', { error: { code: 'unavailable' } }, false), true);
  assert.equal(stallRetries('keyed', { error: { code: 'unavailable' } }, true), true, 'an act: its clientRef answers a repeat');
  assert.equal(stallRetries('keyed', { error: { code: 'world.stalled' } }, false), false, 'speech: nothing answers a repeat');
  assert.equal(stallRetries('keyed', { code: 'world-unavailable' }, false), true, 'refused before any route ran');
  assert.equal(stallRetries('none', { error: { code: 'unavailable' } }, true), false);
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

// #2083: two runs of one command at once are two acts, not one act and its rerun: the second never takes the key the
// first still holds, so the world's idempotency cannot answer it with the first act's receipt
test('concurrent runs of the same act send their own keys; a live run\'s pending key is not taken', { timeout: 20_000 }, async t => {
  const held = [];
  const f = await fixture(t, (req, res, s, w) => {
    if (s.url !== '/v1/edge/act') return json(res, 200, {});
    held.push(() => json(res, 200, { accepted: true, receipt: receiptFor(w.receipts, s.body.clientRef), channel: 'body' }));
    if (held.length === 2) for (const answer of held) answer();   // the first is answered only once the second has arrived
  });
  const first = f.run('act', 'wave:here');
  while (!acts(f.seen).length) await new Promise(r => setTimeout(r, 20));   // the first is out, its key kept in the folder
  const done = await Promise.all([first, f.run('act', 'wave:here')]);
  for (const r of done) assert.equal(r.code, 0, `both runs exit 0 once their acts are answered (#2092): ${r.stderr}`);
  const [x, y] = acts(f.seen);
  assert.notEqual(x.key, y.key); assert.notEqual(x.body.clientRef, y.body.clientRef);
  assert.equal(f.receipts.size, 2, 'two acts, two receipts');
});

test('two concurrent runs left unconfirmed: each rerun takes one of their keys, and neither key is dropped (#1328 with #2083)', { timeout: 30_000 }, async t => {
  let phase = 'flood'; const held = [];
  const f = await fixture(t, (req, res, s, w) => {
    if (s.url.startsWith('/v1/edge/operations/')) return json(res, 200, { state: 'unknown' });
    if (s.url !== '/v1/edge/act') return json(res, 200, {});
    if (phase === 'rerun') return json(res, 200, { accepted: true, receipt: receiptFor(w.receipts, s.body.clientRef), channel: 'body' });
    if (held.length < 2) { held.push(() => unavailable(res)); if (held.length === 2) for (const answer of held) answer(); return; }
    unavailable(res);
  });
  const first = f.run('act', 'wave:here');
  while (!acts(f.seen).length) await new Promise(r => setTimeout(r, 20));
  await Promise.all([first, f.run('act', 'wave:here')]);
  const keys = [...new Set(acts(f.seen).map(s => s.key))];
  assert.equal(keys.length, 2, 'two runs, two keys');
  phase = 'rerun';
  await f.run('act', 'wave:here'); await f.run('act', 'wave:here');
  const reruns = acts(f.seen).slice(-2).map(s => s.key);
  assert.deepEqual(reruns.sort(), [...keys].sort(), 'each rerun sent one of the unconfirmed keys');
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

test('say: world-unavailable (answered before any route runs) is waited out with the same key; --key among the trailing flags', { timeout: 20_000 }, async t => {
  let n = 0;
  const f = await fixture(t, (req, res, s) => {
    if (s.url === '/v1/edge/say') return ++n === 1 ? json(res, 503, { ok: false, code: 'world-unavailable', message: 'World temporarily unavailable.' }) : json(res, 200, { said: true });
    if (s.url.startsWith('/v1/edge/inbox/')) return unavailable(res);
    json(res, 200, {});
  });
  const said = await f.run('say', 'hello', 'there', '--key', 'my-key-1');
  assert.equal(said.code, 0, said.stderr);
  const says = () => f.seen.filter(s => s.url === '/v1/edge/say');
  assert.equal(says().length, 2); assert.deepEqual(says().map(s => s.key), ['my-key-1', 'my-key-1']);
  assert.equal(says()[0].body.text, 'hello there');
  assert.match(said.stderr, /the world could not answer; waiting/);
  for (const [args, text, key] of [[['what', '--key', 'means'], 'what', 'means'], [['hi', '--key', 'k2', '--for', 'none'], 'hi', 'k2'], [['hi', '--for', 'none', '--key', 'k3'], 'hi', 'k3']]) {
    const r = await f.run('say', ...args);
    assert.equal(r.code, 0, r.stderr); assert.equal(says().at(-1).body.text, text); assert.equal(says().at(-1).key, key);
  }
  const ack = await f.run('ack', 'msg_1', 'Got it.');
  assert.notEqual(ack.code, 0);
  assert.equal(f.seen.filter(s => s.url.startsWith('/v1/edge/inbox/')).length, 1, 'ack has no key: one try');
  const bad = await f.run('act', 'read:here', '--key', 'has space');
  assert.equal(bad.code, 1); assert.match(bad.stderr, /--key takes/);
});

test('speech the world took but answered 503 is not said again: no clientRef answers it, and the world keeps no 5xx answer', { timeout: 20_000 }, async t => {
  const spoken = [], kept = new Map();   // the idempotency table: only answers under 500 are kept
  const f = await fixture(t, (req, res, s) => {
    if (s.url.startsWith('/v1/edge/operations/')) { const k = decodeURIComponent(s.url.split('/')[4].split('?')[0]); return json(res, 200, kept.has(k) ? { state: 'recorded', status: 200, response: kept.get(k) } : { state: 'unknown' }); }
    if (s.url === '/v1/edge/say') {
      if (kept.has(s.key)) return json(res, 200, kept.get(s.key));
      spoken.push(s.body.text);
      if (spoken.length === 1) return json(res, 503, { error: { code: 'world.stalled', message: 'the world clock has stalled' } });
      kept.set(s.key, { said: true }); return json(res, 200, { said: true });
    }
    json(res, 200, {});
  });
  const got = await f.run('say', 'hello');
  assert.equal(got.code, 75, got.stderr);
  assert.deepEqual(spoken, ['hello'], 'said once: not resent on its own');
  assert.equal(got.d.unconfirmed, true);
  assert.match(got.d.reason, /may still have taken it: check `events` or `here` before doing it again/);
  assert.doesNotMatch(got.stdout, /at most once|try once more/);
  assert.match(got.d.slowed, /did not confirm it; I check whether it took before doing it again/);
});

test('an act sent again without its default --for keeps its clientRef under a key of its own', { timeout: 20_000 }, async t => {
  const f = await fixture(t, (req, res, s, w) => {
    if (s.url === '/v1/edge/act') return s.body.for ? json(res, 400, { error: { code: 'invalid', message: 'that owner message is closed' } }) : json(res, 200, { accepted: true, receipt: receiptFor(w.receipts, s.body.clientRef), channel: 'body' });
    json(res, 200, {});
  });
  const state = JSON.parse(readFileSync(join(f.dir, '.eden-agent.json'), 'utf8'));
  writeFileSync(join(f.dir, '.eden-agent.json'), JSON.stringify({ ...state, lastAcked: 'msg_1', lastAckedAt: new Date().toISOString() }), { mode: 0o600 });
  const got = await f.run('act', 'read:here', '--key', 'k-for');
  assert.equal(got.code, 0, got.stderr);
  const [a, b] = acts(f.seen);
  assert.equal(a.body.for, 'msg_1'); assert.equal(b.body.for, undefined);
  assert.equal(a.body.clientRef, 'k-for'); assert.equal(b.body.clientRef, 'k-for', 'one clientRef: one act');
  assert.equal(a.key, 'k-for'); assert.equal(b.key, 'k-for.f', 'its own key: the first answer stays the first');
  assert.equal(f.receipts.size, 1);
});

test('a key you named that was used for another write is a refusal, never that write\'s receipt', { timeout: 20_000 }, async t => {
  const f = await fixture(t, (req, res, s) => {
    if (s.url.startsWith('/v1/edge/operations/')) return json(res, 200, { state: 'recorded', status: 200, response: { accepted: true, receipt: { id: 'r_other', capability: 'wave:here', phase: 'completed' } } });
    if (s.url === '/v1/edge/act') return json(res, 409, { error: { code: 'idempotency-key-reused', message: 'this Idempotency-Key was already used with a different request body' } });
    json(res, 200, {});
  });
  const got = await f.run('act', 'read:here', '--key', 'used-before');
  assert.equal(got.code, 1);
  assert.match(got.stderr, /idempotency-key-reused/);
  assert.equal(f.seen.filter(s => s.url.startsWith('/v1/edge/operations/')).length, 1, 'looked up once');
  assert.equal(got.d, null, 'the other act\'s receipt is never reported as this one');
});

test('a named key the world holds for this same act (a rerun with a new --now) is that act\'s answer', { timeout: 20_000 }, async t => {
  const f = await fixture(t, (req, res, s) => {
    if (s.url.startsWith('/v1/edge/operations/')) return json(res, 200, { state: 'recorded', status: 200, response: { accepted: true, receipt: { id: 'r_mine', capability: 'read:here', phase: 'started' } } });
    if (s.url === '/v1/edge/act') return json(res, 409, { error: { code: 'idempotency-key-reused', message: 'this Idempotency-Key was already used with a different request body' } });
    json(res, 200, {});
  });
  const got = await f.run('act', 'read:here', '--key', 'mine', '--now', 'Reading');
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.d.checked, true); assert.equal(got.d.receipt.id, 'r_mine');
});
