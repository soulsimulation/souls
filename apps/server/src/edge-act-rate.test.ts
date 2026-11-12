// #2083: an act over the Soul's act limit is refused naming the limit and carries no other act's receipt; a retry of an
// act the world took (same Idempotency-Key and clientRef) still gets that act's own receipt, over the limit or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {testPort} from '../test/test-port.ts';
const TEST_PORT = await testPort();

test('acts over the limit: each is 429 rate-limited naming 60 a minute, with no receipt; a keyed retry gets its own receipt', async t => {
  const f = fixture(':memory:'); f.brain.quiesce();
  t.after(() => { f.host.stop(); f.db.close(); });
  await invite(f, 'alice');
  const a = await accept(f.host, f.souls.create('dev:alice', {name: 'Avery', description: 'Act rate fixture'}));
  const token = f.souls.pairExchange(f.souls.pairCode(a, `http://127.0.0.1:${TEST_PORT}`).code, 'scripted').token;
  const app = buildApp({cfg: {...config, port: TEST_PORT, worldPath: '/w/eden', publicUrl: `http://127.0.0.1:${TEST_PORT}/w/eden`, accountAuthRequired: false, webDir: '/nonexistent-rate-fixture', marsWebDir: '/nonexistent-rate-fixture'}, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge: new EdgeLedger(f.host, f.db), hub: {clients: new Map(), refreshMe() {}} as never});
  // as eden.mjs sends an act: its own Idempotency-Key, and the same value as its clientRef
  const act = (ref: string, capability: string) => accept(f.host, Promise.resolve(app.request('/v1/edge/act', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': ref}, body: JSON.stringify({capability, clientRef: ref})}))
    .then(async r => ({status: r.status, replay: r.headers.get('idempotent-replay') === 'true', data: await r.json() as any})));

  const taken: {ref: string; receipt: string}[] = [];
  for (let i = 0; i < 60; i++) {
    const ref = `flood-${i}`, r = await act(ref, i % 2 ? 'wave:here' : 'read:here');
    assert.equal(r.status, 200, `act ${i}: ${JSON.stringify(r.data)}`); assert.equal(r.data.accepted, true);
    taken.push({ref, receipt: r.data.receipt.id});
  }
  const receipts = new Set(taken.map(x => x.receipt));
  for (let i = 60; i < 80; i++) {
    const r = await act(`flood-${i}`, i % 2 ? 'wave:here' : 'read:here');
    assert.equal(r.status, 429, `act ${i} over the limit: ${JSON.stringify(r.data)}`);
    assert.equal(r.replay, false);
    assert.equal(r.data.error.code, 'rate-limited');
    assert.match(r.data.error.message, /more than 60 acts a minute: this act was not taken/);
    assert.equal(r.data.error.limit, 60); assert.equal(r.data.error.window_s, 60);
    assert.equal(r.data.accepted, undefined); assert.equal(r.data.receipt, undefined, 'no receipt on a refusal');
    const text = JSON.stringify(r.data); assert.ok(![...receipts].some(id => text.includes(id)), 'no earlier act\'s receipt');
  }
  // a retry of a taken act, still over the limit, is that act's answer: its own receipt, not another's
  for (const {ref, receipt} of [taken[0], taken[31], taken[59]]) {
    const r = await act(ref, Number(ref.split('-')[1]) % 2 ? 'wave:here' : 'read:here');
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.replay, true);
    assert.equal(r.data.receipt.id, receipt);
  }
});
