// #1329 part 3 (Gene's Eden smoke test, bug 9): seated in the balloon in the air, `resolve "start balloon ride"`
// answered `object:<ride>:start` available with a distance of 27.6 m; `act` then refused it `ride.not-boarding`. A ride's
// phase change must reach the offers and resolutions that depend on it, and a rider's distance to its own carrier is 0.
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
async function setup(t: {after(fn: () => void): void}) {
  const f = fixture(':memory:', common, {durableClockV1: true}); f.souls.enableLifecycle(); f.brain.quiesce();
  await accept<unknown>(f.host, new LivingWorld(f.host).install(['Owners drive their Souls.'])); await invite(f, 'rider');
  const row = await accept<{id: string; entity_id: string}>(f.host, f.souls.create('dev:rider', {name: 'Rider', description: '1329 part 3 fixture'}));
  await accept<unknown>(f.host, f.host.installCarrierV1({id: 'eden-balloon', def: 'hot-air-balloon', label: 'Balloon', at: [-20, -9], yaw: Math.PI, route: 'commons-hop', waitSeconds: 15}));
  const token = 'sim_RIDE_RESOLVE_FIXTURE'; f.db.setSoulToken(row.id, hashToken(token), 'synthetic');
  const ledger = new EdgeLedger(f.host, f.db), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, '')), ledger});
  t.after(() => { comms.close(); f.host.stop(); f.db.close(); });
  comms.objects.create({id: 'ride-test', kind: 'ride', name: 'Balloon', placeId: 'world', params: {carrier: 'eden-balloon'}});
  const call = async (path: string, body?: unknown) => { const r = await accept(f.host, Promise.resolve(app.request(path, body === undefined ? {headers: {authorization: 'Bearer ' + token}} : {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'}, body: JSON.stringify(body)}))); return await r.json() as any; };
  const ent = () => f.host.engine.world.entities as Record<string, any>, balloon = () => ent()['eden-balloon'].carrier;
  const tick = (n: number, until?: () => boolean) => { for (let i = 0; i < n && !until?.(); i++) f.host.tickOnce(); };
  return {f, row, ledger, comms, call, balloon, tick, actor: row.entity_id};
}

test('probe', {timeout: 180000}, async t => {
  const q = await setup(t);
  const before = await q.call('/v1/edge/resolve', {capability: 'start balloon ride'});
  console.log('BEFORE', JSON.stringify(before.resolve).slice(0, 800));
  const joined = await q.call('/v1/edge/act', {capability: 'object:ride-test:join', clientRef: 'join'}); assert.equal(joined.accepted, true);
  q.tick(3000, () => q.ledger.aboard(q.actor)?.riderPhase === 'seated');
  q.balloon().departAtTick = q.f.host.engine.world.tick; q.tick(200, () => q.balloon().phase === 'aloft'); assert.equal(q.balloon().phase, 'aloft');
  q.tick(100);
  const r = await q.call('/v1/edge/resolve', {capability: 'start balloon ride'});
  console.log('ALOFT', JSON.stringify(r.resolve).slice(0, 1500));
  const caps = await q.call('/v1/edge/capabilities');
  console.log('CAPS', JSON.stringify(caps.capabilities.filter((c: any) => c.id.startsWith('object:ride-test'))).slice(0, 800));
  const act = await q.call('/v1/edge/act', {capability: 'object:ride-test:start'});
  console.log('ACT', JSON.stringify(act).slice(0, 300));
});
