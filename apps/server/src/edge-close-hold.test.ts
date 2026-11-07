// #1295: the world never records an owner message as finished while an act linked to it runs, and every message still
// reaches a close. Hello-hamlet, a real genesis, the real routes over HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {AgentInbox} from './inbox.ts';
import {OwnerLoop, ownerLinkStore} from './edge/owner-loop.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
const WALK = 'walk:cottage/bench', FAR = 'walk:knoll';

async function world(t: {after(f: () => void): void}, env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const app = buildApp({cfg: {...config, port: 5966, worldPath: '/w/eden', publicUrl: 'http://127.0.0.1:5966/w/eden', accountAuthRequired: false, webDir: '/nonexistent-close-hold', marsWebDir: '/nonexistent-close-hold'}, db: w.db, host: w.host, auth: w.auth, brain: w.brain, souls: w.souls, edge: w.edge, hub: {clients: new Map(), refreshMe() {}} as never});
  for (const k of Object.keys(env)) delete process.env[k];
  const token = w.souls.pairExchange(w.souls.pairCode(w.db.soul(w.soul.soulId)!, 'http://127.0.0.1:5966').code, 'scripted').token;
  const req = async (path: string, auth?: string, body?: unknown) => {const r = await app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {...(auth ? {authorization: `Bearer ${auth}`} : {}), 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}); return {status: r.status, data: await r.json() as any};};
  const box = `/v1/edge/owner/${w.soul.soulId}/inbox`;
  const take = async (text: string, ack = true) => {assert.equal((await req(box, 'dev:ana', {text})).status, 200); const m = (await req('/v1/edge/inbox/listen?timeoutMs=0', token)).data.backlog.at(-1); if (ack) assert.equal((await req(`/v1/edge/inbox/${m.id}/ack`, token, {reply: 'On it'})).status, 200); return m.id as string;};
  const act = async (capability: string, extra: Record<string, unknown> = {}) => {const out = (await accept(w.host, req('/v1/edge/act', token, {capability, ...extra}))).data; assert.equal(out.accepted, true, JSON.stringify(out)); return out;};
  const phase = (id: string) => w.edge.receipt(w.soul.soulId, id)!.phase;
  const until = async (ok: () => boolean, ticks = 6000) => {for (let i = 0; i < ticks && !ok(); i += 10) await w.settle(10); assert.ok(ok(), 'reached in time');};
  const row = (id: string) => w.db.db.prepare('SELECT result,outcome,result_by,progress FROM soul_inbox_queue_v1 WHERE id=?').get(id) as {result: string | null; outcome: string | null; result_by: string | null; progress: string | null};
  const result = (id: string, outcome = 'done', text = 'Arrived') => req(`/v1/edge/inbox/${id}/result`, token, {outcome, text});
  const events = () => (w.db.db.prepare('SELECT COUNT(*) n FROM events WHERE world_id=?').get(w.host.worldId) as {n: number}).n;
  return {w, req, take, act, phase, until, row, result, token, events};
}

test('#1295 A1 A3 A8: a close while the linked walk runs is refused and writes nothing; the walk\'s end closes it, then the agent\'s words replace the line', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row, result, req, token, events} = await world(t);
  const m = await take('walk to the bench');
  const walk = await act(WALK, {for: m}); await w.settle(10);
  assert.equal(phase(walk.receipt.id), 'started');
  const before = events();
  const no = await result(m);
  assert.equal(no.status, 409, JSON.stringify(no.data)); assert.equal(no.data.code, 'message.act-running');
  assert.equal(no.data.receipt, walk.receipt.id); assert.equal(no.data.capability, WALK); assert.match(no.data.message, /^not closed: /);
  assert.equal((await result(m, 'failed', 'Gave up')).status, 409, 'failed is a close too');
  assert.deepEqual({...row(m)}, {result: null, outcome: null, result_by: null, progress: null}, 'nothing written');
  assert.equal(events(), before, 'a refused close logs nothing in the world');
  // a Soul's ack that carries an outcome is a close too
  const n = await take('and wave when you get there', false);
  await act(WALK, {for: n});   // a repeat (#1286): the second message rides the same receipt
  const ack = await req(`/v1/edge/inbox/${n}/ack`, token, {reply: 'Will do', outcome: 'done'});
  assert.equal(ack.status, 409, JSON.stringify(ack.data)); assert.equal(row(n).outcome, null);
  await until(() => phase(walk.receipt.id) === 'completed');
  assert.equal(row(m).result_by, 'server'); assert.equal(row(m).outcome, 'done'); assert.equal(row(n).result_by, 'server');
  assert.equal((await result(m, 'done', 'At the bench')).status, 200, 'with the act ended the agent closes as before');
  assert.equal(row(m).result, 'At the bench'); assert.equal(row(m).result_by, null);
  assert.equal((await result(m, 'done', 'something else')).status, 409, 'a second agent result is refused as before');
});

test('#1295 A2: a look linked to the message mid-walk doesn\'t close it; the walk\'s end does', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row, req, token} = await world(t);
  const m = await take('walk to the bench and look at the cottage');
  const walk = await act(WALK, {for: m}); await w.settle(10);
  // an attention act ends as it is accepted, without replacing the walk: before #1295 its end closed the message mid-walk
  const look = (await accept(w.host, req('/v1/edge/act', token, {verb: 'look', target: 'cottage', for: m}))).data;
  assert.equal(look.accepted, true, JSON.stringify(look)); assert.equal(look.channel, 'attention');
  assert.equal(phase(look.receipt.id), 'completed'); assert.equal(phase(walk.receipt.id), 'started', 'the look did not replace the walk');
  assert.equal(row(m).result, null, 'not closed mid-walk'); assert.match(row(m).progress ?? '', /still going$/);
  await until(() => phase(walk.receipt.id) === 'completed');
  assert.equal(row(m).result_by, 'server'); assert.equal(row(m).outcome, 'done');
});

test('#1295 A4: a linked walk replaced by another act linked to the same message: that act closes it', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row} = await world(t);
  const n = await take('walk to the knoll, no, the bench');
  const b = await act(FAR, {for: n}); await w.settle(10);
  const c = await act(WALK, {for: n}); assert.equal(phase(b.receipt.id), 'replaced');
  await w.settle(80);
  assert.equal(row(n).result, null, 'the replacing act serves the message: no failed line');
  await until(() => phase(c.receipt.id) === 'completed');
  assert.equal(row(n).outcome, 'done'); assert.equal(row(n).result_by, 'server');
});

test('#1295 A4: with nothing serving it, the world closes a replaced walk\'s message failed, saying so', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row} = await world(t);
  const m = await take('walk to the knoll');
  const a = await act(FAR, {for: m}); await w.settle(10);
  await act('rest:here', {params: {seconds: 30}});
  assert.equal(phase(a.receipt.id), 'replaced'); assert.equal(row(m).result, null, 'the replacing act gets its chance first');
  await w.settle(80);
  assert.equal(row(m).outcome, 'failed'); assert.equal(row(m).result_by, 'server'); assert.match(row(m).result!, /replaced/);
  // a world line written first is replaced by the real outcome of an act linked to the message later
  const again = await act(WALK, {for: m});
  await until(() => phase(again.receipt.id) === 'completed');
  assert.equal(row(m).outcome, 'done'); assert.equal(row(m).result_by, 'server');
});

test('#1295 A4 (review): a short act linked to the message that replaces its walk keeps its real close past the window', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row} = await world(t);
  const m = await take('walk to the knoll, or just stand there');
  const walk = await act(FAR, {for: m}); await w.settle(10);
  const stand = await act('stand:here', {for: m});
  assert.equal(phase(walk.receipt.id), 'replaced');
  await until(() => phase(stand.receipt.id) === 'completed', 400);
  assert.equal(row(m).outcome, 'done', 'the stand closed it');
  await w.settle(120);
  assert.equal(row(m).outcome, 'done', 'the replaced walk does not write over it'); assert.doesNotMatch(row(m).result!, /replaced/);
});

test('#1295 A5: an open-ended sit holds nothing once seated; a timed one runs until it ends', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row, result} = await world(t);
  const SIT = 'sit:cottage/part-outdoor-bench';
  const m = await take('sit on the bench');
  const sit = await act(SIT, {for: m}); await w.settle(4);
  assert.equal((await result(m, 'done', 'Sitting')).status, 409, 'not seated yet: refused');
  await until(() => (w.edge as any).holding(w.soul.soulId, sit.receipt.id) === true);
  assert.equal(phase(sit.receipt.id), 'started', 'the sit goes on');
  assert.equal((await result(m, 'done', 'Sitting on the bench')).status, 200, 'held: the agent closes it');
  const n = await take('lie down for a bit');
  const lie = await act('lie:here', {params: {seconds: 4}, for: n});
  await until(() => (w.edge as any).holding(w.soul.soulId, lie.receipt.id) === true);
  assert.equal((await result(n, 'done', 'Lying down')).status, 409, 'a timed lie runs until it ends');
  await until(() => phase(lie.receipt.id) === 'completed');
  assert.equal(row(n).result_by, 'server'); assert.equal(row(n).outcome, 'done');
});

test('#1295 A6: a linked act past the hold limit has its message closed failed, never done; its real end replaces the line', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row, result} = await world(t, {SIM_OWNER_HOLD_S: '3'});
  const m = await take('walk to the knoll');
  const walk = await act(FAR, {for: m});
  await until(() => row(m).result !== null, 200);
  assert.equal(phase(walk.receipt.id), 'started', 'still walking');
  assert.equal(row(m).outcome, 'failed'); assert.match(row(m).result!, /hadn't finished/);
  assert.equal((await result(m, 'done', 'Arrived')).status, 409, 'still never done while it runs');
  await until(() => phase(walk.receipt.id) === 'completed');
  assert.equal(row(m).outcome, 'done'); assert.equal(row(m).result_by, 'server');
});

test('#1295 A7: links survive a restart; one whose receipt is gone pins nothing; one that ended while down closes at boot', {timeout: 300000}, async t => {
  const {w, take, act, phase, until, row, result} = await world(t);
  // stand-in for a restart: two loops in turn over the same database, the first one silenced
  const inbox = new AgentInbox(w.db, w.host.worldId), store = ownerLinkStore(w.db, w.host.worldId);
  const loopOf = (live: {on: boolean}) => new OwnerLoop(inbox, (soul, id) => w.edge.receipt(soul, id) as never, l => w.edge.onReceipt(r => {if (live.on) l(r);}), null, {store});
  const first = {on: true}; const a = loopOf(first);
  const scope = {scope: `soul:${w.soul.soulId}`, owner: w.soul.owner};
  const m = await take('walk to the bench'), walk = await act(WALK); a.link(w.soul as never, walk.receipt, m);
  first.on = false;
  const second = {on: true}, b = loopOf(second);
  assert.throws(() => inbox.result(scope, m, 'Arrived', 'done'), /not closed/, 'the guard holds after the restart');
  await until(() => phase(walk.receipt.id) === 'completed');
  assert.equal(row(m).result_by, 'server', 'and the close lands');
  // an act that ended while the process was down closes its message at the next sweep
  second.on = false;
  const n = await take('walk to the knoll'), far = await act(FAR); b.link(w.soul as never, far.receipt, n);
  await act('stand:here'); await until(() => phase(far.receipt.id) !== 'started');
  const c = loopOf({on: true}), at = w.host.engine.world.tick - (w.host.engine.world.tick % 20) + 20;
  c.sweep(at); c.sweep(at + 60);   // the end it missed, then (a replaced act) the close once nothing serves it
  assert.notEqual(row(n).result, null, 'closed after the restart'); assert.notEqual(row(n).outcome, 'done');
  // a rewind or restore that lost the receipt: its link pins nothing and is dropped
  const o = await take('come here');
  store.save('r_gone', w.soul.soulId, JSON.stringify({scope, message: o}));
  const d = loopOf({on: true});
  assert.equal(d.running(scope, o), null);
  assert.equal((await result(o, 'done', 'Here')).status, 200);
  assert.equal((w.db.db.prepare("SELECT COUNT(*) n FROM edge_owner_links_v1 WHERE receipt_id='r_gone'").get() as {n: number}).n, 0);
});
