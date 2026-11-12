// #2174: the strict gate binds against the Soul's current offers. An offer that appears with a state change (hands joined,
// a thing picked up) is accepted by id straight after, with no catalog read in between.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {fixture, invite, accept, factory} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {mountEdgeRoutes} from './edge/routes.ts';

test('let-go:here is accepted by the strict gate straight after the hands join, with no catalog read', {timeout: 300000}, async t => {
  const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul: any;
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul} as never);
  t.after(() => {comms.close(); f.host.stop(); f.db.close();});
  const tick = async (n = 5) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
  await tick();
  const join = async (id: string, name: string) => {await invite(f, id); const row = await accept(f.host, f.souls.create('dev:' + id, {name, description: 'Strict fresh offer test'})) as any; await tick(); return {soulId: row.id, entityId: row.entity_id ?? row.entityId, name, owner: 'dev:' + id};};
  const ana = await join('ana', 'Ana'), ben = await join('ben', 'Ben');
  const body = (s: {entityId: string}) => f.host.engine.world.entities[s.entityId] as any;
  const [ax, , az] = body(ana).pose.p;
  await accept(f.host, f.host.enqueue('edge-relocate', `edge:${ben.soulId}`, {soulId: ben.soulId, entityId: ben.entityId, to: [ax, az + 1.6], why: 'test placement'})); await tick(20);
  const act = async (s: any, capability: string, strict = false) => {soul = s; const r = await accept(f.host, Promise.resolve(app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({capability, ...(strict ? {strict: true} : {})})}))); return r.json() as Promise<any>;};
  const until = async (cond: () => boolean, limit = 1200) => {for (let n = 0; n < limit; n++) {if (cond()) return n; await tick(1);} return -1;};
  const ended = (s: any, b: any) => ['completed', 'failed', 'cancelled', 'replaced'].includes(edge.receipt(s.soulId, b.receipt.id)?.phase as string);
  // the catalog is read before the hand-hold, as a client does: a menu without let-go is built and kept
  assert.ok(!edge.capabilities(ana as never).some(c => c.id === 'let-go:here'));
  const h1 = await act(ben, 'hold hands with Ana'); assert.equal(h1.accepted, true, JSON.stringify(h1));
  assert.ok(await until(() => edge.together.invitesFor(ana.soulId).length > 0, 400) >= 0);
  const h2 = await act(ana, 'accept:' + edge.together.invitesFor(ana.soulId)[0]!.id, true); assert.equal(h2.accepted, true, JSON.stringify(h2));
  assert.ok(await until(() => !!edge.together.handsWith(ana.entityId)) >= 0, 'the hands join');
  // straight after: the one-offer build finds what the whole menu offers, and the gate takes it
  assert.equal(edge.bindOneOracleV1(ana as never, 'let-go:here'), null);
  const lg = await act(ana, 'let-go:here', true);
  assert.equal(lg.accepted, true, 'let-go:here straight after the hand-hold: ' + JSON.stringify(lg).slice(0, 400));
  assert.ok(await until(() => ended(ana, lg)) >= 0); assert.equal(edge.receipt(ana.soulId, lg.receipt.id)?.phase, 'completed');
  assert.ok(!edge.together.handsWith(ana.entityId) && !edge.together.handsWith(ben.entityId), 'they let go');
  // again, with Ana's catalog read every tick until the hands join: a menu kept from before the join is not reused after it
  await tick(60);
  const h4 = await act(ben, 'hold hands with Ana'); assert.equal(h4.accepted, true, JSON.stringify(h4));
  assert.ok(await until(() => edge.together.invitesFor(ana.soulId).length > 0, 400) >= 0);
  const h5 = await act(ana, 'accept:' + edge.together.invitesFor(ana.soulId)[0]!.id, true); assert.equal(h5.accepted, true, JSON.stringify(h5));
  assert.ok(await until(() => {edge.capabilities(ana as never); return !!edge.together.handsWith(ana.entityId);}) >= 0, 'the hands join again');
  assert.ok(edge.capabilities(ana as never).some(c => c.id === 'let-go:here'), 'the catalog offers let-go:here once the hands join');
  const lg2 = await act(ana, 'let-go:here', true);
  assert.equal(lg2.accepted, true, 'let-go:here with the catalog read up to the join: ' + JSON.stringify(lg2).slice(0, 400));
  assert.ok(await until(() => ended(ana, lg2)) >= 0); assert.equal(edge.receipt(ana.soulId, lg2.receipt.id)?.phase, 'completed');
  // an offered hand is withdrawn by its id straight after the offer
  await tick(60);
  const h3 = await act(ana, 'offer Ben my hand'); assert.equal(h3.accepted, true, JSON.stringify(h3));
  assert.ok(await until(() => edge.together.invitesFor(ben.soulId).length > 0, 400) >= 0);
  const wd = await act(ana, 'withdraw:' + edge.together.invitesFor(ben.soulId)[0]!.id, true);
  assert.equal(wd.accepted, true, 'withdraw straight after the offer: ' + JSON.stringify(wd).slice(0, 400));
  assert.ok(await until(() => ended(ana, h3)) >= 0);
  // sit, then stand straight after sitting, by id, with no catalog read in between
  await tick(60);
  const sit = await act(ana, 'sit-ground:here', true); assert.equal(sit.accepted, true, JSON.stringify(sit));
  assert.ok(await until(() => /sit/.test(String(body(ana).human.activity ?? ''))) >= 0, 'Ana sits');
  const stand = await act(ana, 'stand:here', true); assert.equal(stand.accepted, true, 'stand:here straight after sitting: ' + JSON.stringify(stand).slice(0, 400));
  assert.ok(await until(() => !/sit/.test(String(body(ana).human.activity ?? ''))) >= 0, 'Ana stands');
});
