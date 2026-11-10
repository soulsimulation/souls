// #1753: an owner message reaches first motion in one call. `act <id> --for <message>` with no `ack` before it acknowledges
// the message (the owner's card reads Acknowledged, then the act, then Done), and the world closes it when the act ends.
// An `ack` or `result` sent anyway is harmless: the ack is answered as a retry and writes no reply over the act.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';

test('#1753 A2, A3, A4: act --for with no ack acknowledges the message, closes it when the act ends, and a late ack or result is harmless', {timeout: 300000}, async t => {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  await invite(f, 'alice');
  const a = await accept(f.host, f.souls.create('dev:alice', {name: 'Avery', description: 'One-call owner loop'}));
  const token = f.souls.pairExchange(f.souls.pairCode(a, 'http://127.0.0.1:5966').code, 'scripted').token;
  const edge = new EdgeLedger(f.host, f.db);
  const app = buildApp({cfg: {...config, port: 5966, worldPath: '/w/eden', publicUrl: 'http://127.0.0.1:5966/w/eden', accountAuthRequired: false, webDir: '/nonexistent-loop-fixture', marsWebDir: '/nonexistent-loop-fixture'}, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge, hub: {clients: new Map(), refreshMe() {}} as never});
  const req = async (path: string, auth?: string, body?: unknown) => { const r = await app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {...(auth ? {authorization: `Bearer ${auth}`} : {}), 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}); return {status: r.status, data: await r.json() as any}; };
  const box = `/v1/edge/owner/${a.id}/inbox`, card = async () => (await req(box, 'dev:alice')).data.inbox.latest;
  const settle = async (n: number) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await new Promise(r => setImmediate(r)); f.host.drainInputs(); } };

  assert.equal((await req(box, 'dev:alice', {text: 'walk over there'})).status, 200);
  const m = (await req('/v1/edge/inbox/listen?timeoutMs=0', token)).data.backlog.at(-1);
  assert.equal((await card()).state, 'delivered', 'received: picked up, not yet acknowledged');

  const walk = (await req('/v1/edge/capabilities', token)).data.capabilities.find((c: any) => c.verb === 'walk' && c.available && c.target?.kind === 'place');
  assert.ok(walk, 'a walk is on offer');
  const act = (await accept(f.host, req('/v1/edge/act', token, {capability: walk.id, strict: true, for: m.id, clientRef: 'one-call'}))).data;
  assert.equal(act.accepted, true, JSON.stringify(act)); assert.equal(act.for, m.id);
  const doing = await card();
  assert.equal(doing.state, 'acknowledged', 'the act is the acknowledgement');
  assert.equal(doing.reply, undefined, 'no reply is invented for the agent');
  assert.equal(doing.result, undefined, 'not closed while the act runs');

  // A3: the agent sends the old loop's ack anyway: answered as a retry, and the act's link stands
  const late = await req(`/v1/edge/inbox/${m.id}/ack`, token, {reply: 'Got it: walking'});
  assert.equal(late.status, 200); assert.equal(late.data.inbox.latest.state, 'acknowledged');
  // a second listen hands the message over no more: it is in hand
  assert.equal((await req('/v1/edge/inbox/listen?timeoutMs=0', token)).data.backlog.length, 0);

  for (let i = 0; i < 6000 && ['waiting', 'started'].includes(edge.receipt(a.id, act.receipt.id)!.phase); i += 20) await settle(20);
  assert.equal(edge.receipt(a.id, act.receipt.id)!.phase, 'completed');
  const done = await card();
  assert.equal(done.outcome, 'done'); assert.ok(done.result, 'the world wrote what happened');

  // A3: a result sent anyway, twice with the same words (a retry by key), replaces the world's line once and is not refused
  const r1 = await req(`/v1/edge/inbox/${m.id}/result`, token, {outcome: 'done', text: 'Walked over there.'});
  const r2 = await req(`/v1/edge/inbox/${m.id}/result`, token, {outcome: 'done', text: 'Walked over there.'});
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal((await card()).result, 'Walked over there.');
});

test('#1753: an act refused for a message leaves it unacknowledged, so the agent still holds it', {timeout: 300000}, async t => {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  await invite(f, 'bea');
  const a = await accept(f.host, f.souls.create('dev:bea', {name: 'Bea', description: 'Refused act'}));
  const token = f.souls.pairExchange(f.souls.pairCode(a, 'http://127.0.0.1:5967').code, 'scripted').token;
  const edge = new EdgeLedger(f.host, f.db);
  const app = buildApp({cfg: {...config, port: 5967, worldPath: '/w/eden', publicUrl: 'http://127.0.0.1:5967/w/eden', accountAuthRequired: false, webDir: '/nonexistent-loop-fixture', marsWebDir: '/nonexistent-loop-fixture'}, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge, hub: {clients: new Map(), refreshMe() {}} as never});
  const req = async (path: string, auth?: string, body?: unknown) => { const r = await app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {...(auth ? {authorization: `Bearer ${auth}`} : {}), 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}); return {status: r.status, data: await r.json() as any}; };
  const box = `/v1/edge/owner/${a.id}/inbox`;
  assert.equal((await req(box, 'dev:bea', {text: 'walk to nowhere'})).status, 200);
  const m = (await req('/v1/edge/inbox/listen?timeoutMs=0', token)).data.backlog.at(-1);
  const act = (await accept(f.host, req('/v1/edge/act', token, {capability: 'walk:no-such-place', strict: true, for: m.id}))).data;
  assert.equal(act.accepted, false, JSON.stringify(act));
  assert.equal((await req(box, 'dev:bea')).data.inbox.latest.state, 'delivered');
});
