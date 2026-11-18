// #1774 A4: a dev world's per-request record (load/request-record.ts): one line per Soul-facing request with the world's
// own times and the ids in the answer; never a token, a body or a query value; and nothing at all unless switched on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {idsOf, requestRecordFile, requestRecordMiddleware, timingOf} from './load/request-record.ts';

const app = (lines: string[] | null) => {
  const a = new Hono();
  if (lines) a.use('*', requestRecordMiddleware('unused', async (l) => { lines.push(l); }));
  a.post('/v1/edge/act', (c) => { c.header('Server-Timing', 'world;dur=12.5, queue;dur=3.0'); return c.json({accepted: true, receipt: {id: 'rcpt_abc', phase: 'accepted'}, for: 'msg_1'}); });
  a.get('/v1/edge/owner/s_1/inbox', (c) => c.json({inbox: {latest: {id: 'msg_2', text: 'secret owner words'}}}));
  a.get('/healthz', (c) => c.json({ok: true}));
  return a;
};
const call = (a: Hono, path: string, init: RequestInit = {}) => a.request(path, init);
const settle = () => new Promise((r) => setTimeout(r, 10));

test('off unless a DEV_AUTH world names a file', () => {
  assert.equal(requestRecordFile({}, true), null);
  assert.equal(requestRecordFile({SIM_REQUEST_RECORD: '/x/requests.jsonl'}, false), null);
  assert.equal(requestRecordFile({SIM_REQUEST_RECORD: ''}, true), null);
  assert.equal(requestRecordFile({SIM_REQUEST_RECORD: '/x/requests.jsonl'}, true), '/x/requests.jsonl');
});

test('a recorded answer is the same answer, byte for byte', async () => {
  const lines: string[] = [];
  for (const [path, init] of [['/v1/edge/act', {method: 'POST', body: '{}'}], ['/v1/edge/owner/s_1/inbox', {}]] as const) {
    const a = await call(app(null), path, init), b = await call(app(lines), path, init);
    assert.equal(b.status, a.status);
    assert.deepEqual([...b.headers].sort(), [...a.headers].sort());
    assert.equal(await b.text(), await a.text());
  }
});

test('one line per Soul-facing request: route, arrival, times, key and ids; no token, body or query value', async () => {
  const lines: string[] = [], a = app(lines);
  await call(a, '/v1/edge/act?soul=s_hidden', {method: 'POST', body: '{"capability":"walk:x"}', headers: {authorization: 'Bearer tok_supersecret', 'idempotency-key': 'op_123', 'content-type': 'application/json'}});
  await call(a, '/v1/edge/owner/s_1/inbox', {headers: {authorization: 'Bearer dev:agent-1'}});
  await call(a, '/healthz');
  await settle();
  assert.equal(lines.length, 2, 'healthz is not a Soul-facing route');
  const [act, inbox] = lines.map((l) => JSON.parse(l));
  assert.equal(act.v, 'world-request/1'); assert.equal(act.method, 'POST'); assert.equal(act.path, '/v1/edge/act'); assert.equal(act.status, 200);
  assert.equal(act.worldMs, 12.5); assert.equal(act.queueMs, 3); assert.equal(act.key, 'op_123');
  assert.deepEqual(act.receipts, ['rcpt_abc']); assert.deepEqual(act.messages, ['msg_1']);
  assert.ok(Number.isFinite(act.at) && Number.isFinite(act.ms));
  assert.deepEqual(inbox.messages, ['msg_2']);
  const all = lines.join('');
  for (const leak of ['tok_supersecret', 'agent-1', 's_hidden', 'secret owner words', 'walk:x', 'authorization']) assert.ok(!all.includes(leak), `${leak} kept`);
});

test('timingOf and idsOf read what they can and nothing else', () => {
  assert.deepEqual(timingOf(null), {});
  assert.deepEqual(timingOf('world;dur=0.4'), {worldMs: 0.4});
  assert.deepEqual(idsOf(null), {}); assert.deepEqual(idsOf([1]), {});
  assert.deepEqual(idsOf({events: [{receipt: {id: 'rcpt_1'}}, {receipt: {id: 'bad id with spaces'}}]}), {receipts: ['rcpt_1']});
});
