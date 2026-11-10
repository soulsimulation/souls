// #1737 on the real Eden 2026 template (fake minds, in memory): a far spot named by its id stays on offer whatever menu
// is cached, and the two public routes never name a secret place.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {mountCatalogRoute} from './edge/catalog/routes.ts';
import {mountLiveRoute} from './edge/catalog/live.ts';
import {SPOT_REACH} from './edge/ledger/activities.ts';

type Spot = {id: string; activity: string; at: [number, number]; level?: number; together?: unknown; base: string; place?: string};

test('Eden: far spots by id, and what the catalog and live picture publish (things worked by hand too, #1751)', {timeout: 900_000}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge as any, host = w.host, soul = w.soul;
  const run = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}} await setImmediate(); host.drainInputs();};
  await run(120);
  const me = L.body(soul.entityId).pose.p, away = (s: Spot) => Math.hypot(s.at[0] - me[0], s.at[1] - me[2]);
  const gate = (id: string) => L.offerGate(soul, {capability: id})?.code ?? 'ok';
  // far spots the world will take: beyond the listing's reach, on the ground, alone, offered when asked cold
  const far: string[] = [];
  for (const s of (L.spots.spots as Spot[]).filter(s => away(s) > SPOT_REACH + 100 && !s.level && !s.together && s.base !== 'lie').sort((a, b) => away(a) - away(b))) {
    const id = `${s.activity}:${s.id}`; L.invalidateBodies();
    if (gate(id) === 'ok') far.push(id);
    if (far.length === 3) break;
  }
  assert.equal(far.length, 3, 'three far spots are on offer when asked for by id');

  await t.test('a far spot stays on offer after the whole menu is built, in the same tick and in later ones', async () => {
    L.binds(soul);
    assert.equal(gate(far[0]!), 'ok', 'same tick as a whole-menu build');
    await run(3); L.capabilities(soul); await run(1);
    assert.equal(gate(far[1]!), 'ok', 'with a kept whole menu');
  });

  await t.test('a refusal does not poison the next far spot', () => {
    assert.equal(gate('eat:eat.e_no-such-spot'), 'capability.unknown');
    assert.equal(gate(far[2]!), 'ok');
    assert.equal(gate(far[0]!), 'ok');
  });

  await t.test('an activity that spot does not have is unknown, with no borrowed reason', () => {
    const [, spotId] = /^[^:]+:(.+)$/.exec(far[0]!)!;
    assert.equal(gate(`juggle:${spotId}`), 'capability.unknown');
  });

  const app = new Hono(); let hear: (m: object) => void = () => {};
  const catalog = mountCatalogRoute(app, {ledger: L});
  mountLiveRoute(app, {ledger: L}, {onSpectator: (l: (m: object) => void) => {hear = l;}} as never, catalog.version);
  const get = async (path: string, headers: Record<string, string> = {}) => {const r = await app.request(path, {headers}); return {status: r.status, etag: r.headers.get('etag'), body: r.status === 200 ? await r.json() as any : null};};

  await t.test('the catalog is served by tag, and a place made secret leaves it', async () => {
    const first = await get('/v1/edge/catalog');
    assert.equal(first.status, 200); assert.equal(first.body.contract, 'soul-catalog/1');
    assert.equal((await get('/v1/edge/catalog', {'if-none-match': first.etag!})).status, 304);
    const hide = first.body.places.find((p: any) => p.kind === 'building' && first.body.things.some((x: any) => x.place === p.id) && !L.placePathOf(soul.soulId).some((q: any) => q.id === p.id));
    assert.ok(hide, 'a building with things in it, away from the Soul');
    L.knowledge.setSecret(hide.id, true);
    const second = await get('/v1/edge/catalog');
    assert.notEqual(second.etag, first.etag, 'a new version');
    assert.equal(second.body.places.some((p: any) => p.id === hide.id), false);
    assert.equal(second.body.things.some((x: any) => x.place === hide.id), false);
    assert.equal(second.body.acts.some((a: any) => a.place === hide.id), false);
    assert.equal((await get('/v1/edge/catalog', {'if-none-match': first.etag!})).status, 200, 'the old tag no longer matches');
  });

  await t.test('the live picture names where a Soul is, and never a secret place', async () => {
    const place = L.placePathOf(soul.soulId).find((p: any) => p.kind !== 'occupier').id as string;
    hear({kind: 'speech', id: 'sp_open', tick: host.engine.world.tick, at: 1, from: {soulId: soul.soulId, name: soul.name}, channel: {kind: 'earshot', placeId: place}, text: 'hello out here'});
    await run(10);
    const open = await get('/v1/edge/live'), row = open.body.souls.find((s: any) => s.id === soul.soulId);
    assert.equal(open.body.contract, 'soul-live/1'); assert.equal(open.body.catalog, catalog.version());
    assert.equal(row.place, place); assert.equal(row.at.length, 2);
    assert.deepEqual(open.body.speech.map((s: any) => [s.id, s.place, s.untrusted]), [['sp_open', place, true]]);
    L.knowledge.setSecret(place, true);
    hear({kind: 'speech', id: 'sp_hidden', tick: host.engine.world.tick, at: 2, from: {soulId: soul.soulId, name: soul.name}, channel: {kind: 'earshot', placeId: place}, text: 'said in the secret place'});
    await run(10);
    const shut = await get('/v1/edge/live'), hidden = shut.body.souls.find((s: any) => s.id === soul.soulId);
    assert.deepEqual([hidden.at, hidden.place, hidden.doing], [null, null, null], 'in the world, but where is not said');
    assert.equal(shut.body.speech.some((s: any) => s.id === 'sp_hidden'), false);
    assert.equal(JSON.stringify(shut.body).includes('said in the secret place'), false);
  });

  // #1751: things worked by hand, their state, and their acts from anywhere
  await t.test('a kind worked by hand is in the catalog with its acts, and a thing\'s changed state reaches the live picture', async () => {
    const cat = (await get('/v1/edge/catalog')).body;
    const lamp = cat.kinds['core-desk-lamp'];
    assert.ok(lamp, 'desk lamps are worked by hand on Eden 2026');
    assert.deepEqual(lamp.acts.map((a: any) => a.verb).sort(), ['switch-off', 'switch-on']);
    assert.equal(typeof lamp.state.on, 'boolean');
    const far = cat.things.filter((x: any) => x.kind === 'core-desk-lamp').map((x: any) => ({...x, d: Math.hypot(x.at[0] - me[0], x.at[1] - me[2])})).sort((a: any, b: any) => b.d - a.d)[0];
    assert.ok(far.d > 40, `a lamp beyond the old 30 m sight (${Math.round(far.d)} m)`);
    // (a far act by id walks there: actuators-catalog.test.ts; this harness has no object framework)
    const before = (await get('/v1/edge/live')).body;
    assert.equal(before.things[far.id], undefined, 'a thing in its default state is not in the live picture');
    w.god.engineAct([{op: 'set', id: far.id, state: {on: !lamp.state.on}}] as never, 'test: switch');
    await run(12);
    assert.deepEqual((await get('/v1/edge/live')).body.things[far.id], {on: !lamp.state.on}, 'only the field that differs');
    // a thing a shut container keeps out of sight is in neither answer, and the catalog follows it
    const was = L.concealedThing, v1 = catalog.version(); L.concealedThing = (id: string) => id === far.id || !!was?.(id);
    try {
      await run(12);
      const c2 = (await get('/v1/edge/catalog')).body;
      assert.notEqual(catalog.version(), v1, 'a new catalog version');
      assert.equal(c2.things.some((x: any) => x.id === far.id), false);
      assert.equal((await get('/v1/edge/live')).body.things[far.id], undefined);
    } finally { L.concealedThing = was; }
    assert.equal(catalog.version(), v1, 'shown again: the first version');
  });
});
