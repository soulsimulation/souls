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
import {resolveCandidates} from './edge/intents/strict.ts';

const common = await retainedCommonsShoreFactory().then(nativeSleepSnapshotFactoryV1);
async function setup(t: {after(fn: () => void): void}) {
  const f = fixture(':memory:', common, {durableClockV1: true}); f.souls.enableLifecycle(); f.brain.quiesce();
  await accept<unknown>(f.host, new LivingWorld(f.host).install(['Owners drive their Souls.'])); await invite(f, 'rider');
  const row = await accept<{id: string; entity_id: string}>(f.host, f.souls.create('dev:rider', {name: 'Rider', description: '1329 part 3 fixture'}));
  await accept<unknown>(f.host, f.host.installCarrierV1({id: 'eden-balloon', def: 'hot-air-balloon', label: 'Balloon', at: [-20, -9], yaw: Math.PI, route: 'commons-hop', waitSeconds: 15}));
  await invite(f, 'walker');
  const other = await accept<{id: string; entity_id: string}>(f.host, f.souls.create('dev:walker', {name: 'Walker', description: '1329 part 3 fixture, on the ground'}));
  const token = 'sim_RIDE_RESOLVE_FIXTURE', otherToken = 'sim_RIDE_RESOLVE_WALKER'; f.db.setSoulToken(row.id, hashToken(token), 'synthetic'); f.db.setSoulToken(other.id, hashToken(otherToken), 'synthetic');
  const ledger = new EdgeLedger(f.host, f.db), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, '')), ledger});
  t.after(() => { comms.close(); f.host.stop(); f.db.close(); });
  comms.objects.create({id: 'ride-test-balloon', kind: 'ride', name: 'Balloon', placeId: 'world', params: {carrier: 'eden-balloon'}});
  const call = async (path: string, body?: unknown, tok = token) => { const r = await accept(f.host, Promise.resolve(app.request(path, body === undefined ? {headers: {authorization: 'Bearer ' + tok}} : {method: 'POST', headers: {authorization: 'Bearer ' + tok, 'content-type': 'application/json'}, body: JSON.stringify(body)}))); return await r.json() as any; };
  // #1910: the resolve route is closed; the same dry run and candidates, read from the ledger
  const dry = (body: Record<string, unknown>, tok = token) => {const r = f.souls.soulFromToken(tok)!, m = f.host.minds.get(r.id)!, s = {soulId: r.id, entityId: m.entityId, name: m.name, owner: r.owner}, d = ledger.intents.dryRun(s, body as never); return {resolve: {...d, candidates: resolveCandidates(ledger, s, d)}} as any;};
  const ent = () => f.host.engine.world.entities as Record<string, any>, balloon = () => ent()['eden-balloon'].carrier;
  const tick = (n: number, until?: () => boolean) => { for (let i = 0; i < n && !until?.(); i++) f.host.tickOnce(); };
  return {f, row, ledger, comms, call, dry, balloon, tick, actor: row.entity_id, walker: other.entity_id, otherToken};
}

const rideIds = (r: any) => [r.resolve.would, ...(r.resolve.candidates ?? [])].filter(Boolean).filter((c: any) => (c.capability ?? c.id) === 'object:ride-test-balloon:start');
const pos = (q: Awaited<ReturnType<typeof setup>>, id: string) => {const p = (q.f.host.engine.world.entities as Record<string, any>)[id].pose.p; return [p[0], p[2]] as [number, number];};

test('I5: climbing in, start is not offered; from lift-off on, every tick, resolve answers start not available (ride.not-boarding)', {timeout: 180000}, async t => {
  const q = await setup(t);
  assert.equal((await q.call('/v1/edge/act', {capability: 'object:ride-test-balloon:join', clientRef: 'join'})).accepted, true);
  // climbing in: never offered as available while the body would refuse it (carrier.not-aboard on the Eden walk-in)
  let climbing = 0;
  for (let i = 0; i < 3000 && q.ledger.aboard(q.actor)?.riderPhase !== 'seated'; i++) {
    q.f.host.tickOnce();
    if (q.ledger.aboard(q.actor)?.riderPhase !== 'boarding' || i % 10) continue;
    const r = await q.dry({capability: 'start balloon ride'});
    for (const c of rideIds(r)) {assert.equal(c.available, false, `climbing in, tick ${i}: ${JSON.stringify(c)}`); assert.equal(c.blocked?.code, 'ride.climbing-in');}
    climbing += rideIds(r).length ? 1 : 0;
  }
  assert.ok(climbing >= 1, 'resolved the start at least once while climbing in');
  assert.equal(q.ledger.aboard(q.actor)?.riderPhase, 'seated');
  // seated, still boarding: the start is on offer
  const seated = await q.dry({capability: 'start balloon ride'});
  assert.ok(rideIds(seated).length, JSON.stringify(seated.resolve).slice(0, 400));
  for (const c of rideIds(seated)) assert.equal(c.available, true, JSON.stringify(c));
  q.balloon().departAtTick = q.f.host.engine.world.tick;
  let checked = 0;
  for (let i = 0; i < 200 && checked < 40; i++) {
    q.f.host.tickOnce();
    if (q.balloon().phase === 'boarding') continue;
    const r = await q.dry({capability: 'start balloon ride'}), cs = rideIds(r);
    assert.ok(cs.length, `tick ${i} (${q.balloon().phase}): ${JSON.stringify(r.resolve).slice(0, 400)}`);
    for (const c of cs) {assert.equal(c.available, false, `tick ${i} (${q.balloon().phase}): ${JSON.stringify(c)}`); assert.equal(c.blocked?.code, 'ride.not-boarding');}
    checked++;
  }
  assert.ok(checked >= 40, `checked ${checked} ticks after lift-off`);
  assert.equal((await q.call('/v1/edge/act', {capability: 'object:ride-test-balloon:start'})).code, 'ride.not-boarding');
});

test('I6: a rider is 0 m from its ride; anyone else is measured to the carrier where it is now', {timeout: 180000}, async t => {
  const q = await setup(t);
  // on the ground: the join's distance is to the basket, not to the ride's place (here the whole world's centre)
  const ground = await q.dry({capability: 'object:ride-test-balloon:join'}), d0 = ground.resolve.would.distance;
  const me = pos(q, q.actor), basket = pos(q, 'eden-balloon'), straight = Math.hypot(basket[0] - me[0], basket[1] - me[1]);
  assert.ok(typeof d0 === 'number' && d0 >= straight - 3 && d0 <= straight * 1.5 + 6, `join distance ${d0} vs ${straight.toFixed(1)} m to the basket: ${JSON.stringify(ground.resolve.would)}`);
  assert.equal((await q.call('/v1/edge/act', {capability: 'object:ride-test-balloon:join', clientRef: 'join'})).accepted, true);
  q.tick(3000, () => q.ledger.aboard(q.actor)?.riderPhase === 'seated');
  const check = async (tag: string) => {
    for (const id of ['object:ride-test-balloon:start', 'object:ride-test-balloon:leave', 'object:ride-test-balloon:join']) {
      const w = (await q.dry({capability: id})).resolve.would;
      if (!w) continue;
      assert.equal(w.distance, 0, `${tag} ${id}: ${JSON.stringify(w)}`); assert.equal(w.route, 'aboard');
    }
  };
  await check('seated');
  q.balloon().departAtTick = q.f.host.engine.world.tick; q.tick(400, () => q.balloon().phase === 'aloft'); assert.equal(q.balloon().phase, 'aloft');
  q.tick(200);
  await check('aloft');
  q.tick(600, () => q.balloon().phase !== 'aloft'); assert.equal(q.balloon().phase, 'aloft');
  // the Soul on the ground: measured to the basket where it flies now, which has left its boarding point
  const w = (await q.dry({capability: 'object:ride-test-balloon:join'}, q.otherToken)).resolve.would;
  const me2 = pos(q, q.walker), now = pos(q, 'eden-balloon'), toNow = Math.hypot(now[0] - me2[0], now[1] - me2[1]), toHome = Math.hypot(basket[0] - me2[0], basket[1] - me2[1]);
  const flown = Math.hypot(now[0] - basket[0], now[1] - basket[1]);
  assert.ok(flown > 5, `the balloon has left its boarding point: ${flown.toFixed(1)} m (walker ${toNow.toFixed(1)} m from it now, ${toHome.toFixed(1)} m from its boarding point)`);
  assert.ok(typeof w?.distance === 'number' && w.distance >= toNow - 3 && Math.abs(w.distance - toNow) < Math.abs(w.distance - toHome) && w.route !== 'aboard', `walker join distance ${w?.distance} vs ${toNow.toFixed(1)} m to the basket now: ${JSON.stringify(w)}`);
});
