// #1329 part 2 (Gene's Eden smoke test, bug 8): `ride:join` completed at boarding and closed the owner's message, while
// the ride had not left the ground. A ride join linked to an owner message now keeps it open ("aboard") until the body is
// back on the ground, then closes it with the ride's outcome; a Soul that leaves before departure closes it failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Hono} from 'hono';
import {retainedCommonsShoreFactory, nativeSleepSnapshotFactoryV1} from '@souls/engine-mars';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {LivingWorld} from './living.ts';
import {hashToken} from './auth.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {mountEdgeRoutes, edgeSoulResolver} from './edge/routes.ts';
import {Db} from './db.ts';
import {AgentInbox} from './inbox.ts';
import * as ownerLoop from './edge/owner-loop.ts';
const {OwnerLoop} = ownerLoop, RIDE_TICKS = (ownerLoop as {RIDE_TICKS?: number}).RIDE_TICKS ?? 30 * 60 * 20;
import type {EdgeReceipt} from './edge/contract.ts';

function unit(t: {after(fn: () => void): void}) {
  const dir = mkdtempSync(join(tmpdir(), 'souls-1329-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const db = new Db(join(dir, 'fixture.db')); t.after(() => db.close());
  const inbox = new AgentInbox(db, 'w1'), soul = {soulId: 's_kino', entityId: 'h_kino', name: 'Kino', owner: 'gene'}, scope = {scope: 'soul:s_kino', owner: 'gene'};
  let emit: (r: EdgeReceipt) => void = () => {}, aboard: {phase: string} | null = null, tick = 100;
  const rec = (id: string, capability: string, phase: EdgeReceipt['phase']) => ({id, soulId: 's_kino', capability, phase, acceptedTick: 90, startedTick: 90, endedTick: phase === 'completed' || phase === 'failed' ? tick : null, code: null, reason: phase === 'failed' ? 'The balloon has left.' : null, programId: null} as EdgeReceipt);
  const phases = new Map<string, EdgeReceipt['phase']>(), caps = new Map<string, string>();
  const loop = new OwnerLoop(inbox, (_s, id) => rec(id, caps.get(id) ?? 'object:ride-eden-balloon:join', phases.get(id) ?? (id === 'r_j' || id.startsWith('r_') ? 'started' : 'completed')), l => { emit = l; },
    {stepTarget: () => null, actTarget: () => null, placePath: () => null, posOf: () => null, rideName: id => id === 'ride-eden-balloon' ? 'balloon' : null, aboard: () => aboard});
  const row = (id: string) => db.db.prepare('SELECT result,outcome,result_by,progress FROM soul_inbox_queue_v1 WHERE id=?').get(id) as {result: string | null; outcome: string | null; result_by: string | null; progress: string | null};
  const message = (text: string) => { inbox.send(scope, text); const m = inbox.takeBacklog(scope)[0]; inbox.acknowledge(scope, m.id, 'On it'); return m.id; };
  const end = (id: string, phase: EdgeReceipt['phase'] = 'completed') => { phases.set(id, phase); emit(rec(id, 'object:ride-eden-balloon:join', phase)); };
  const sweep = (n = 1) => { for (let i = 0; i < n; i++) { tick += 20; loop.sweep(tick); } };
  const endOther = (id: string, capability: string) => { phases.set(id, 'completed'); caps.set(id, capability); emit(rec(id, capability, 'completed')); };
  return {loop, soul, row, message, end, endOther, sweep, inbox, scope, set: (a: {phase: string} | null) => { aboard = a; }, tick: () => tick, jump: (n: number) => { tick += n; }};
}

test('R1, R2: a ride join keeps the message open while aboard ("not back on the ground yet") and closes it done after the step-out', t => {
  const u = unit(t), id = u.message('Take a balloon ride');
  assert.deepEqual(u.loop.link(u.soul, {id: 'r_join', soulId: 's_kino', capability: 'object:ride-eden-balloon:join', phase: 'started'} as EdgeReceipt, id, true), {open: true}, 'the join is boarding, not the ride');
  u.set({phase: 'boarding'}); u.end('r_join');
  let r = u.row(id); assert.equal(r.result, null, 'not closed at boarding'); assert.equal(r.progress, 'now: aboard the balloon; not back on the ground yet');
  u.sweep(3); assert.equal(u.row(id).result, null);
  u.set({phase: 'aloft'}); u.sweep(3); u.set({phase: 'landed'}); u.sweep(2); assert.equal(u.row(id).result, null, 'still stepping out');
  u.set(null); u.sweep(1);
  r = u.row(id); assert.equal(r.result, 'Rode the balloon and stepped out on the ground.'); assert.equal(r.outcome, 'done'); assert.equal(r.result_by, 'server');
});

test('R2: leaving before the ride departs closes the message failed; R4: a ride still aboard after 30 minutes closes it failed', t => {
  const u = unit(t), a = u.message('Take a balloon ride');
  u.loop.link(u.soul, {id: 'r_a', soulId: 's_kino', capability: 'object:ride-eden-balloon:join', phase: 'started'} as EdgeReceipt, a);
  u.set({phase: 'boarding'}); u.end('r_a'); u.sweep(2); u.set(null); u.sweep(1);
  assert.deepEqual([u.row(a).result, u.row(a).outcome], ['Left the balloon before it departed.', 'failed']);
  const b = u.message('Take a balloon ride');
  u.loop.link(u.soul, {id: 'r_b', soulId: 's_kino', capability: 'object:ride-eden-balloon:join', phase: 'started'} as EdgeReceipt, b);
  u.set({phase: 'aloft'}); u.end('r_b'); u.sweep(1); assert.equal(u.row(b).result, null);
  u.jump(RIDE_TICKS); u.sweep(1);
  assert.deepEqual([u.row(b).result, u.row(b).outcome], ['Still on the balloon after 30 minutes.', 'failed']);
});

test('R3: a refused or failed join closes the message as any act does; an act that is not a ride join is unchanged', t => {
  const u = unit(t), a = u.message('Take a balloon ride');
  assert.deepEqual(u.loop.link(u.soul, {id: 'r_f', soulId: 's_kino', capability: 'object:ride-eden-balloon:join', phase: 'started'} as EdgeReceipt, a), {open: true});
  u.end('r_f', 'failed');
  assert.equal(u.row(a).outcome, 'failed'); assert.match(u.row(a).result!, /failed: The balloon has left\./);
  const b = u.message('Read here');
  assert.deepEqual(u.loop.link(u.soul, {id: 'r_read', soulId: 's_kino', capability: 'object:chess-1:join', phase: 'started'} as EdgeReceipt, b), {open: false}, 'not a ride: closes as before');
});

// The native balloon of the RIDE-EXIT fixture, through the real act route with `for`
const common = await retainedCommonsShoreFactory().then(nativeSleepSnapshotFactoryV1);
test('native: join with for, seated: the message stays open; flown and landed: closed done once the Soul is on the ground', {timeout: 180000}, async t => {
  const f = fixture(':memory:', common, {durableClockV1: true}); f.souls.enableLifecycle(); f.brain.quiesce();
  await accept<unknown>(f.host, new LivingWorld(f.host).install(['Owners drive their Souls.'])); await invite(f, 'rider');
  const row = await accept<{id: string; entity_id: string}>(f.host, f.souls.create('dev:rider', {name: 'Rider', description: '1329 fixture'}));
  await accept<unknown>(f.host, f.host.installCarrierV1({id: 'eden-balloon', def: 'hot-air-balloon', label: 'Balloon', at: [-20, -9], yaw: Math.PI, route: 'commons-hop', waitSeconds: 15}));
  const token = 'sim_RIDE_JOIN_MESSAGE_FIXTURE'; f.db.setSoulToken(row.id, hashToken(token), 'synthetic');
  const inbox = new AgentInbox(f.db, f.host.worldId), ledger = new EdgeLedger(f.host, f.db), app = new Hono();
  // the owner loop's view of the inbox only: no listen presence, so the LINK body rule (no agent listening: the body
  // rests) stays out of this ride
  const box = {hasMessage: inbox.hasMessage.bind(inbox), serverResult: inbox.serverResult.bind(inbox), messageText: inbox.messageText?.bind(inbox), serverProgress: inbox.serverProgress?.bind(inbox), onSoulSend: () => {}};
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, '')), ledger, ownerInbox: box} as never);
  t.after(() => { comms.close(); f.host.stop(); f.db.close(); });
  comms.objects.create({id: 'ride-test', kind: 'ride', name: 'Balloon', placeId: 'world', params: {carrier: 'eden-balloon'}});
  const scope = {scope: `soul:${row.id}`, owner: 'dev:rider'};
  inbox.send(scope, 'Take a balloon ride'); const msg = inbox.takeBacklog(scope)[0]; inbox.acknowledge(scope, msg.id, 'On my way');
  const r = await accept(f.host, Promise.resolve(app.request('/v1/edge/act', {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'}, body: JSON.stringify({capability: 'object:ride-test:join', clientRef: 'join', for: msg.id})})));
  const joined = await r.json() as {accepted: boolean; open?: boolean; receipt: {id: string}};
  assert.equal(joined.accepted, true, JSON.stringify(joined)); assert.equal(joined.open, true, 'the act answer says the message stays open');
  const ent = () => f.host.engine.world.entities as Record<string, any>, balloon = () => ent()['eden-balloon'].carrier;
  const tick = (n: number, until?: () => boolean) => { for (let i = 0; i < n && !until?.(); i++) f.host.tickOnce(); };
  const result = () => (f.db.db.prepare('SELECT result,outcome,progress FROM soul_inbox_queue_v1 WHERE id=?').get(msg.id) as {result: string | null; outcome: string | null; progress: string | null});
  tick(3000, () => ledger.aboard(row.entity_id)?.riderPhase === 'seated'); assert.equal(ledger.aboard(row.entity_id)?.riderPhase, 'seated');
  // as the RIDE-EXIT fixture: it departs at once (this fixture's rider steps out again if it waits)
  balloon().departAtTick = f.host.engine.world.tick; tick(200, () => balloon().phase === 'aloft'); assert.equal(balloon().phase, 'aloft');
  tick(200, () => ledger.receipt(row.id, joined.receipt.id)?.phase === 'completed'); tick(40);
  assert.equal(ledger.receipt(row.id, joined.receipt.id)?.phase, 'completed', 'the join receipt completes once seated, as before');
  assert.equal(result().result, null, 'the join completed: the message is still open'); assert.equal(result().progress, 'now: aboard the Balloon; not back on the ground yet');
  assert.equal(result().result, null, 'aloft: open');
  balloon().elapsed = 1e9; tick(200, () => balloon().phase === 'landed'); tick(1200, () => !ledger.aboard(row.entity_id)); tick(40);
  assert.equal(ledger.aboard(row.entity_id), null, 'on the ground');
  assert.deepEqual([result().result, result().outcome], ['Rode the Balloon and stepped out on the ground.', 'done']);
});

test('review: while aboard the join counts as running: the agent\'s own result is refused and another linked act posts progress, never closes', t => {
  const u = unit(t), id = u.message('Take a balloon ride');
  u.loop.link(u.soul, {id: 'r_j', soulId: 's_kino', capability: 'object:ride-eden-balloon:join', phase: 'started'} as EdgeReceipt, id);
  u.set({phase: 'boarding'}); u.end('r_j');
  // the agent tries to close it at boarding
  assert.throws(() => u.inbox.result(u.scope, id, 'Boarded the balloon', 'done'), /running|act/i, 'refused while the ride runs');
  assert.equal(u.row(id).result, null);
  // another act linked to the same message (an early start) ends mid-ride
  u.loop.link(u.soul, {id: 'r_start', soulId: 's_kino', capability: 'object:ride-eden-balloon:start', phase: 'started'} as EdgeReceipt, id);
  u.set({phase: 'aloft'}); u.endOther('r_start', 'object:ride-eden-balloon:start');
  assert.equal(u.row(id).result, null, 'not closed mid-flight'); assert.match(u.row(id).progress!, /object:ride-eden-balloon:join still going/);
  u.sweep(2); u.set(null); u.sweep(1);
  assert.deepEqual([u.row(id).result, u.row(id).outcome], ['Rode the balloon and stepped out on the ground.', 'done'], 'closed once, at the step-out');
});
