// #2136: with the strict gate on, an offered id is checked against the parameters the offer itself advertises.
// read:here and lie:here advertise `seconds` 5..1800 (edge/ledger/activities.ts secondsParam): a value inside is accepted,
// one below is refused as capability.params naming `seconds`. A ride join advertises `with` (edge/ledger/ledger.ts
// `listed`): accepted with or without it. Every act goes through POST /v1/edge/act with `strict: true`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {retainedCommonsShoreFactory, nativeSleepSnapshotFactoryV1} from '@souls/engine-mars';
import {Hono} from 'hono';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {LivingWorld} from './living.ts';
import {hashToken} from './auth.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {mountEdgeRoutes, edgeSoulResolver} from './edge/routes.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);

test('#2136 read:here and lie:here: seconds inside the offer\'s own bounds is accepted; below them is refused naming seconds', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const app = buildApp({cfg: {...config, port: 5967, worldPath: '/w/eden', publicUrl: 'http://127.0.0.1:5967/w/eden', accountAuthRequired: false, webDir: '/nonexistent-2136', marsWebDir: '/nonexistent-2136'}, db: w.db, host: w.host, auth: w.auth, brain: w.brain, souls: w.souls, edge: w.edge, hub: {clients: new Map(), refreshMe() {}} as never});
  const token = w.souls.pairExchange(w.souls.pairCode(w.db.soul(w.soul.soulId)!, 'http://127.0.0.1:5967').code, 'scripted').token;
  const act = async (capability: string, params?: Record<string, unknown>) => {
    const r = await accept(w.host, Promise.resolve(app.request('/v1/edge/act', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify({capability, ...(params ? {params} : {}), strict: true})})));
    assert.equal(r.status, 200); return await r.json() as any;
  };
  for (const id of ['read:here', 'lie:here']) {
    const offer = w.edge.capabilities(w.soul).find(c => c.id === id);
    const seconds = (offer?.params as {seconds?: {min: number; max: number}} | undefined)?.seconds;
    assert.deepEqual([seconds?.min, seconds?.max], [5, 1800], `${id} advertises seconds 5..1800: ${JSON.stringify(offer)}`);
    const below = await act(id, {seconds: seconds!.min - 1});
    assert.equal(below.accepted, false, JSON.stringify(below));
    assert.equal(below.code, 'capability.params');
    assert.match(below.reason, /^seconds must be integer, 5\.\.1800\.$/, 'the refusal names the parameter and its advertised bounds');
    assert.equal(below.params.seconds.min, 5, 'the refusal carries the offer\'s schema');
    const inside = await act(id, {seconds: seconds!.min});
    assert.equal(inside.accepted, true, JSON.stringify(inside)); assert.equal(inside.receipt.capability, id);
    const stand = await act('stand:here'); assert.equal(stand.accepted, true, JSON.stringify(stand));
  }
});

for (const ride of ['ride-test', 'ride-eden-balloon']) test(`#2136 object:${ride}:join: accepted with no params and with the \`with\` it advertises`, {timeout: 300000}, async t => {
  const f = fixture(':memory:', await retainedCommonsShoreFactory().then(nativeSleepSnapshotFactoryV1), {durableClockV1: true}); f.souls.enableLifecycle(); f.brain.quiesce(); t.after(() => {f.host.stop(); f.db.close();});
  await accept<unknown>(f.host, new LivingWorld(f.host).install(['Owners drive their Souls.'])); for (let i = 0; i < 4; i++) f.host.tickOnce();
  await accept(f.host, f.host.installCommonsProvisionsV1()); await accept(f.host, f.host.installRetainedCommonsShoreV1());
  for (const p of [f.host.enableYieldTimeoutV1(), f.host.enableSpreadV2(), f.host.enableReflexTimeoutV1(), f.host.enableContinuousDayV1(), f.host.enableEdgeMotionV1()]) await accept<unknown>(f.host, p);
  const rows: {id: string}[] = []; for (const n of ['ana', 'ben', 'cy']) {await invite(f, n); rows.push(await accept(f.host, f.souls.create('dev:' + n, {name: n, description: 'rider'})));}
  const tokens = rows.map((r, i) => {const tok = 'sim_STRICT_PARAMS_TEST_TOKEN_' + i; f.db.setSoulToken(r.id, hashToken(tok), 'synthetic'); return tok;});
  await accept<unknown>(f.host, f.host.installCarrierV1({id: 'eden-balloon', def: 'hot-air-balloon', label: 'Red balloon', at: [-20, -9], yaw: Math.PI, route: 'commons-hop', waitSeconds: 60}));
  const ledger = new EdgeLedger(f.host, f.db, undefined, {ambient: true}), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, '')), ledger}); t.after(() => comms.close());
  comms.objects.create({id: ride, kind: 'ride', name: 'Red balloon', placeId: 'world', params: {carrier: 'eden-balloon'}});
  const pump = async <T>(p: Promise<T>) => {let done = false; p.then(() => done = true, () => done = true); for (let i = 0; i < 400 && !done; i++) {await setImmediate(); f.host.drainInputs();} assert.ok(done, 'request settled'); return p;};
  const act = async (i: number, params?: Record<string, unknown>) => {
    const r = await pump(Promise.resolve(app.request('/v1/edge/act', {method: 'POST', headers: {authorization: 'Bearer ' + tokens[i], 'content-type': 'application/json'}, body: JSON.stringify({capability: `object:${ride}:join`, ...(params ? {params} : {}), strict: true})})));
    assert.equal(r.status, 200); return await r.json() as any;
  };
  const id = `object:${ride}:join`, offer = ledger.capabilities(f.host.minds.get(rows[0]!.id)! as never).find(c => c.id === id);
  assert.ok((offer?.params as Record<string, unknown> | undefined)?.with, `${id} advertises with: ${JSON.stringify(offer)}`);
  const plain = await act(0); assert.equal(plain.accepted, true, JSON.stringify(plain)); assert.equal(plain.receipt.capability, id);
  const withCy = await act(1, {with: [rows[2]!.id]}); assert.equal(withCy.accepted, true, JSON.stringify(withCy)); assert.equal(withCy.receipt.capability, id);
});
