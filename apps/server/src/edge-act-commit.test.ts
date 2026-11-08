// #1327: an act is committed only if the caller is told it was. The receipt row, the receipts it replaces and the
// decision event are one acceptance at the sequencer; a failed clock is refused before anything is written; a fault after
// the commit answers with the receipt; a clock that stops after the hand-off answers 202 `pending` with the receipt id.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {testPort} from '../test/test-port.ts';
const TEST_PORT = await testPort();

async function world(t: {after(fn: () => void): void}) {
  const f = fixture(':memory:'); f.brain.quiesce();
  t.after(() => { f.host.stop(); f.db.close(); });
  await invite(f, 'alice');
  const a = await accept(f.host, f.souls.create('dev:alice', {name: 'Avery', description: 'Commit fixture'}));
  const token = f.souls.pairExchange(f.souls.pairCode(a, `http://127.0.0.1:${TEST_PORT}`).code, 'scripted').token;
  const ledger = new EdgeLedger(f.host, f.db);
  const app = buildApp({cfg: {...config, port: TEST_PORT, worldPath: '/w/eden', publicUrl: `http://127.0.0.1:${TEST_PORT}/w/eden`, accountAuthRequired: false, webDir: '/nonexistent-commit-fixture', marsWebDir: '/nonexistent-commit-fixture'}, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge: ledger, hub: {clients: new Map(), refreshMe() {}} as never});
  const send = (path: string, body?: unknown, key?: string) => app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? {'idempotency-key': key} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})})
    .then(async r => ({status: r.status, data: await r.json().catch(() => null) as any}));
  // drive the sequencer while a request is out, as the tick loop does
  const req = (path: string, body?: unknown, key?: string) => accept(f.host, send(path, body, key));
  const rows = () => f.db.db.prepare('SELECT receipt_id AS id, phase, capability, client_ref AS ref FROM edge_receipts_v1 ORDER BY created_at').all() as {id: string; phase: string; capability: string; ref: string | null}[];
  return {f, ledger, app, send, req, rows, soul: a};
}

const open = (phase: string) => phase === 'waiting' || phase === 'started';

test('T1: the hand-off throws: 503, no receipt row, and the open act before it is still open (not replaced)', async t => {
  const w = await world(t), host = w.f.host as any;
  const first = await w.req('/v1/edge/act', {capability: 'read:here'});
  assert.equal(first.status, 200); assert.equal(first.data.accepted, true);
  const before = w.rows(); assert.equal(before.length, 1); assert.ok(open(before[0].phase), before[0].phase);
  const enqueue = host.enqueue, journaled = host.enqueueJournaled;
  host.enqueue = host.enqueueJournaled = () => { throw new Error('sequencer refused (test)'); };
  try {
    const second = await w.req('/v1/edge/act', {capability: 'dance:here'});
    assert.equal(second.status, 503, JSON.stringify(second.data));
    assert.equal(second.data.receipt, undefined);
    const after = w.rows();
    assert.equal(after.length, 1, 'no receipt row for the refused act');
    assert.equal(after[0].id, before[0].id); assert.ok(open(after[0].phase), `the earlier act is still open, not ${after[0].phase}`);
    // the same with a hand-off that rejects at the drain without writing (a refusal at the sequencer)
    host.enqueueJournaled = () => Promise.reject(new Error('refused at the drain (test)'));
    const third = await w.req('/v1/edge/act', {capability: 'dance:here'});
    assert.equal(third.status, 503); assert.equal(w.rows().length, 1); assert.ok(open(w.rows()[0].phase));
  } finally { host.enqueue = enqueue; host.enqueueJournaled = journaled; }
});

test('T2: a failed clock: 503 world.unavailable before anything is written', async t => {
  const w = await world(t), host = w.f.host as any;
  const first = await w.req('/v1/edge/act', {capability: 'read:here'}); assert.equal(first.status, 200);
  host.clockFailure = new Error('clock failed (test)');
  try {
    const r = await w.send('/v1/edge/act', {capability: 'dance:here'});
    assert.equal(r.status, 503); assert.equal(r.data.error.code, 'world.unavailable', JSON.stringify(r.data));
    assert.equal(w.rows().length, 1, 'no row'); assert.ok(open(w.rows()[0].phase), 'nothing replaced');
  } finally { host.clockFailure = undefined; }
});

test('T3: the decision commits, then the answer fails: 200 accepted with that receipt, never 503', async t => {
  const w = await world(t), host = w.f.host as any, ledger = w.ledger as any;
  // (a) the sequencer committed the act, then its promise rejected (a clock failure later in the same drain)
  const journaled = host.enqueueJournaled;
  host.enqueueJournaled = function (...args: unknown[]) { return journaled.apply(this, args).then(() => { throw new Error('clock failed after the commit (test)'); }); };
  try {
    const r = await w.req('/v1/edge/act', {capability: 'read:here'});
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.accepted, true);
    assert.equal(w.rows().length, 1); assert.equal(r.data.receipt.id, w.rows()[0].id);
  } finally { host.enqueueJournaled = journaled; }
  // (b) the act committed, then something on the way to the answer threw
  const noteAct = ledger.noteAct;
  ledger.noteAct = () => { throw new TypeError('answer fault (test)'); };
  try {
    const r = await w.req('/v1/edge/act', {capability: 'dance:here'});
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.accepted, true);
    const rows = w.rows(); assert.equal(rows.length, 2); assert.equal(r.data.receipt.id, rows[1].id); assert.equal(rows[1].capability, 'dance:here');
  } finally { ledger.noteAct = noteAct; }
});

test('T4: a clock that stops after the hand-off: 202 pending with the receipt id; a same-key retry is that act, never a second', async t => {
  const w = await world(t), was = process.env.SIM_ACT_COMMIT_WAIT_MS;
  process.env.SIM_ACT_COMMIT_WAIT_MS = '150'; t.after(() => { if (was === undefined) delete process.env.SIM_ACT_COMMIT_WAIT_MS; else process.env.SIM_ACT_COMMIT_WAIT_MS = was; });
  const key = 'k-1327-pending', body = {capability: 'read:here', clientRef: key};
  // nothing drains: the clock has stopped
  // bounded: without #1327 this request never answers at all
  const first = await Promise.race([w.send('/v1/edge/act', body, key), new Promise<{status: number; data: any}>(r => setTimeout(() => r({status: 0, data: 'no answer in 3 s'}), 3000).unref())]);
  assert.equal(first.status, 202, JSON.stringify(first.data)); assert.equal(first.data.accepted, true); assert.equal(first.data.pending, true);
  const id = first.data.receipt.id; assert.match(id, /^r_/); assert.equal(first.data.receipt.phase, 'pending');
  assert.equal(w.rows().length, 0, 'not recorded yet');
  const seen = await w.send(`/v1/edge/receipts/${id}`); assert.equal(seen.status, 200); assert.equal(seen.data.receipt.phase, 'pending');
  const again = await w.send('/v1/edge/act', body, key);
  assert.equal(again.status, 202); assert.equal(again.data.receipt.id, id, 'the same act');
  // the clock moves again: one receipt, under that id
  for (let i = 0; i < 5; i++) { w.f.host.drainInputs(); await turn(); }
  const rows = w.rows(); assert.equal(rows.length, 1, JSON.stringify(rows)); assert.equal(rows[0].id, id); assert.equal(rows[0].ref, key);
  const now = await w.send(`/v1/edge/receipts/${id}`); assert.equal(now.status, 200); assert.ok(open(now.data.receipt.phase) || now.data.receipt.phase === 'completed', now.data.receipt.phase);
  const third = await w.req('/v1/edge/act', body, key);
  assert.equal(third.status, 200); assert.equal(third.data.accepted, true); assert.equal(third.data.receipt.id, id);
  assert.equal(w.rows().length, 1, 'still one receipt');
});

test('an ordinary act is unchanged: accepted, one receipt, a newer act replaces it', async t => {
  const w = await world(t);
  const a = await w.req('/v1/edge/act', {capability: 'read:here'}); assert.equal(a.status, 200); assert.equal(a.data.accepted, true);
  const b = await w.req('/v1/edge/act', {capability: 'dance:here'}); assert.equal(b.status, 200);
  const rows = w.rows(); assert.equal(rows.length, 2); assert.equal(rows[0].phase, 'replaced'); assert.ok(open(rows[1].phase), rows[1].phase);
  assert.equal(b.data.receipt.id, rows[1].id);
});
