// #1381 review: stop:current aboard a flying ride is refused as stand:here is (the ride owns the body until it is down);
// the offer reads blocked with that reason, and the ride's receipt stays open.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {retainedCommonsShoreFactory, nativeSleepSnapshotFactoryV1} from '@souls/engine-mars';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {LivingWorld} from './living.ts';
import {hashToken} from './auth.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {mountEdgeRoutes, edgeSoulResolver} from './edge/routes.ts';

const common = await retainedCommonsShoreFactory().then(nativeSleepSnapshotFactoryV1);

test('#1381: aloft, stop:current never drops the rider: refused (the ride\'s own refusal, or nothing running), and nothing ends', {timeout: 180000}, async t => {
  const f = fixture(':memory:', common, {durableClockV1: true}); f.souls.enableLifecycle(); f.brain.quiesce();
  await accept<unknown>(f.host, new LivingWorld(f.host).install(['Owners drive their Souls.'])); await invite(f, 'rider');
  const row = await accept<{id: string; entity_id: string}>(f.host, f.souls.create('dev:rider', {name: 'Rider', description: '1381 fixture'}));
  await accept<unknown>(f.host, f.host.installCarrierV1({id: 'stop-balloon', def: 'hot-air-balloon', label: 'Balloon', at: [-20, -9], yaw: Math.PI, route: 'commons-hop', waitSeconds: 15}));
  const token = 'sim_STOP_RIDE_FIXTURE'; f.db.setSoulToken(row.id, hashToken(token), 'synthetic');
  const ledger = new EdgeLedger(f.host, f.db), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, '')), ledger});
  t.after(() => { comms.close(); f.host.stop(); f.db.close(); });
  comms.objects.create({id: 'ride-stop-balloon', kind: 'ride', name: 'Balloon', placeId: 'world', params: {carrier: 'stop-balloon'}});
  const call = async (path: string, body?: unknown) => { const r = await accept(f.host, Promise.resolve(app.request(path, body === undefined ? {headers: {authorization: 'Bearer ' + token}} : {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'}, body: JSON.stringify(body)}))); return await r.json() as any; };
  const balloon = () => (f.host.engine.world.entities as Record<string, any>)['stop-balloon'].carrier;
  const tick = (n: number, until?: () => boolean) => { for (let i = 0; i < n && !until?.(); i++) f.host.tickOnce(); };
  const joined = await call('/v1/edge/act', {capability: 'object:ride-stop-balloon:join', clientRef: 'join'}); assert.equal(joined.accepted, true, JSON.stringify(joined));
  tick(3000, () => ledger.aboard(row.entity_id)?.riderPhase === 'seated');
  balloon().departAtTick = f.host.engine.world.tick; tick(400, () => balloon().phase === 'aloft'); assert.equal(balloon().phase, 'aloft');
  tick(100);
  const soulId = f.host.mindByEntity.get(row.entity_id)!.soulId, open = ledger.openReceipts(soulId);
  const offer = (await call('/v1/edge/capabilities?all=1')).capabilities.find((c: any) => c.id === 'stop:current');
  // the join's receipt completes once seated: aloft, an open act (if any) is the ride's own, and the ride keeps the body
  if (open.length) {assert.ok(offer, 'offered'); assert.equal(offer.available, false); assert.match(offer.blocked.code, /^ride\./);} else assert.equal(offer, undefined, 'nothing open: not offered');
  const stop = await call('/v1/edge/act', {capability: 'stop:current'});
  assert.equal(stop.accepted, false, JSON.stringify(stop)); assert.match(stop.code, open.length ? /^ride\./ : /^act\.none-running$/);
  assert.ok(open.every(r => ledger.receipt(soulId, r.id)!.phase === r.phase), 'nothing ended');
  tick(40); assert.equal(ledger.aboard(row.entity_id)?.riderPhase, 'seated', 'still aboard'); assert.equal(balloon().phase, 'aloft');
});
