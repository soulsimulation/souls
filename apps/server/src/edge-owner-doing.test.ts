// #1313 over HTTP: the owner's card reads thinking, then the act under way with its live phase, then a refusal, from the
// world's records; the agent's own answers never carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {testPort} from '../test/test-port.ts';
const TEST_PORT = await testPort();

test('#1313 P1, P2, P4, P6: thinking, running, done and refused on the owner view only', {timeout: 300000}, async t => {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  await invite(f, 'alice');
  const a = await accept(f.host, f.souls.create('dev:alice', {name: 'Avery', description: 'Owner card fixture'}));
  const token = f.souls.pairExchange(f.souls.pairCode(a, `http://127.0.0.1:${TEST_PORT}`).code, 'scripted').token;
  const edge = new EdgeLedger(f.host, f.db);
  const app = buildApp({cfg: {...config, port: TEST_PORT, worldPath: '/w/eden', publicUrl: `http://127.0.0.1:${TEST_PORT}/w/eden`, accountAuthRequired: false, webDir: '/nonexistent-card-fixture', marsWebDir: '/nonexistent-card-fixture'}, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge, hub: {clients: new Map(), refreshMe() {}} as never});
  const req = async (path: string, auth?: string, body?: unknown) => {
    const r = await app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {...(auth ? {authorization: `Bearer ${auth}`} : {}), 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: r.status, data: await r.json() as any};
  };
  const box = `/v1/edge/owner/${a.id}/inbox`, owner = async () => (await req(box, 'dev:alice')).data.inbox;
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await new Promise(r => setImmediate(r)); f.host.drainInputs(); } };

  const sent = await req(box, 'dev:alice', {text: 'walk somewhere'});
  assert.equal(sent.status, 200); assert.equal(sent.data.inbox.doing, undefined, 'P5: not picked up: nothing');
  const listen = await req('/v1/edge/inbox/listen?timeoutMs=0', token), msg = listen.data.backlog[0];
  assert.equal(listen.data.inbox.doing, undefined, 'P6: the agent\'s own view never carries it');
  assert.deepEqual((await owner()).doing?.phase, 'thinking', 'P4: picked up, no answer yet, agent here');
  f.db.db.prepare('UPDATE agent_inbox_v1 SET listened_at=0').run();
  assert.equal((await owner()).doing, undefined, 'P4: an away agent gets no thinking claim');
  await req('/v1/edge/inbox/listen?timeoutMs=0', token);

  const ack = await req(`/v1/edge/inbox/${msg.id}/ack`, token, {reply: 'On my way'});
  assert.equal(ack.status, 200); assert.equal(ack.data.inbox.doing, undefined, 'P6: not on the ack answer');
  assert.equal((await owner()).doing, undefined, 'P4: acknowledged, no act yet: nothing claimed');

  const walk = (await req('/v1/edge/capabilities', token)).data.capabilities.find((c: any) => c.verb === 'walk' && c.available && c.target?.kind === 'place');
  assert.ok(walk, 'a walk is on offer');
  const act = (await accept(f.host, req('/v1/edge/act', token, {capability: walk.id, for: msg.id}))).data;
  assert.equal(act.accepted, true, JSON.stringify(act)); assert.equal(act.inbox?.doing, undefined, 'P6: not on the act answer');
  const running = (await owner()).doing;
  assert.equal(running.phase, 'running', JSON.stringify(running)); assert.equal(typeof running.text, 'string'); assert.ok(running.text.length > 0);
  for (let i = 0; i < 60 && ['waiting', 'started'].includes(edge.receipt(a.id, act.receipt.id)!.phase); i++) await ticks(100);
  const end = edge.receipt(a.id, act.receipt.id)!.phase;
  assert.equal((await owner()).doing.phase, end === 'completed' ? 'done' : end === 'failed' ? 'failed' : 'cut', 'P1: the line follows the receipt to its end');

  const refused = (await req('/v1/edge/act', token, {capability: 'fly:the-moon'})).data;
  assert.notEqual(refused.accepted, true);
  const r = (await owner()).doing;
  assert.equal(r.phase, 'refused', JSON.stringify(r)); assert.equal(typeof r.reason, 'string');
  assert.equal((await req(box, 'dev:bob')).status === 200, false, 'P6: another account gets no owner view');
});
