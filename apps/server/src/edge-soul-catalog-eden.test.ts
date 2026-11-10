// #1737 on the real Eden 2026 template (fake minds, in memory): a far spot named by its id stays on offer whatever menu
// is cached, the two public routes never name a secret place, and a god's edit to a thing is a new catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {mountCatalogRoute} from './edge/catalog/routes.ts';
import {mountLiveRoute} from './edge/catalog/live.ts';
import {SPOT_REACH} from './edge/ledger/activities.ts';
// the client's own search over the catalog, as `find` runs it
const CLIENT_CATALOG = new URL('../../../tools/world-launcher/soul/catalog.mjs', import.meta.url).href;

type Spot = {id: string; activity: string; at: [number, number]; level?: number; together?: unknown; base: string; place?: string};

test('Eden: far spots by id, and what the catalog and live picture publish', {timeout: 900_000}, async t => {
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

  await t.test('until the world first has its whole structure, the catalog asks again shortly rather than publish no acts', async () => {
    assert.equal(L.structureReady?.(), true, 'Eden after 120 ticks is whole');
    const was = L.structureReady, early = new Hono(); let whole = false;
    L.structureReady = () => whole;
    try {
      mountCatalogRoute(early, {ledger: L});
      const a = await early.request('/v1/edge/catalog');
      assert.equal(a.status, 503); assert.equal(a.headers.get('retry-after'), '2'); assert.equal(((await a.json()) as any).error.code, 'world.starting');
      whole = true; const b = await early.request('/v1/edge/catalog');
      assert.equal(b.status, 200); assert.ok(((await b.json()) as any).counts.acts > 1000);
      whole = false; assert.equal((await early.request('/v1/edge/catalog')).status, 200, 'once whole, it stays served');
    } finally {L.structureReady = was;}
  });

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

  await t.test('every act a find row names is taken, or refused with a reason of its own', async () => {
    const {indexCatalog, find: findLocal} = await import(CLIENT_CATALOG) as {indexCatalog: (c: unknown) => unknown; find: (ix: unknown, w: string, o: object) => {found: {act?: string}[]}};
    const cat = (await get('/v1/edge/catalog')).body, ix = indexCatalog(cat), me = L.body(soul.entityId).pose.p, at = [me[0], me[2]];
    const ids = new Set<string>();
    for (const words of ['swim', 'lake', 'pond', 'jetty', 'shore', 'library', 'read a book', 'sit on the floor', 'eat', 'bench', 'kitchen', 'garden', 'dance', 'sleep', 'music', 'table', 'bandstand', 'classroom', 'river', 'sea'])
      for (const row of findLocal(ix, words, {at}).found) if (row.act) ids.add(row.act);
    assert.ok(ids.size >= 40, `find names ${ids.size} acts`);
    const unknown: string[] = [];
    for (const id of ids) {L.invalidateBodies(); const no = L.offerGate(soul, {capability: id}); if (no?.code === 'capability.unknown') unknown.push(id);}
    assert.deepEqual(unknown, [], 'no find row names an act the world does not know');
  });

  await t.test('a god moves, renames and removes a thing: each is a new catalog, and an act on the removed id is refused with a reason', async () => {
    const before = await get('/v1/edge/catalog');
    assert.equal((L.spots.spots as Spot[]).filter(s => L.spotThingGone(s.id)).length, 0, 'every spot of a thing names a thing the world has (a pond is the god\'s)');
    // a thing with acts of its own, away from the Soul, that the world offers by id now
    const pick = before.body.things.find((x: any) => w.god.model.entities.has(x.id) && before.body.acts.some((a: any) => a.thing === x.id && !a.with && gate(a.id) === 'ok'));
    assert.ok(pick, 'a god thing with an act on offer by id');
    const act = before.body.acts.find((a: any) => a.thing === pick.id && !a.with && gate(a.id) === 'ok').id as string;
    const edit = async (op: object) => {const r = w.god.act({ops: [op]} as never); assert.equal(r.accepted, true, JSON.stringify(r)); await run(4); return get('/v1/edge/catalog');};

    const p0 = (w.god.model.entities.get(pick.id) as any).p as number[];   // in its slot's frame when it has one
    const dx = p0[0]! > 0 ? -1 : 1;   // a metre toward its slot's origin, so it stays inside
    const moved = await edit({op: 'move', id: pick.id, p: [p0[0]! + dx, ...p0.slice(1)]});
    assert.notEqual(moved.etag, before.etag, 'a move is a new version');
    const at = moved.body.things.find((x: any) => x.id === pick.id).at;
    assert.ok(Math.abs(Math.hypot(at[0] - pick.at[0], at[1] - pick.at[1]) - 1) < 0.2 , `the thing moved a metre, where the god put it: ${JSON.stringify([pick.at, at])}`);

    const name = 'catalog-test-renamed';
    const renamed = await edit({op: 'set', id: pick.id, name});
    assert.notEqual(renamed.etag, moved.etag, 'a rename is a new version');
    assert.match(renamed.body.things.find((x: any) => x.id === pick.id).name, new RegExp(name));

    const removed = await edit({op: 'remove', id: pick.id});
    assert.notEqual(removed.etag, renamed.etag, 'a removal is a new version');
    assert.equal(removed.body.things.some((x: any) => x.id === pick.id), false, 'the thing left the catalog');
    assert.equal(removed.body.acts.some((a: any) => a.thing === pick.id), false, 'and so did its acts');
    L.invalidateBodies();
    const no = L.offerGate(soul, {capability: act});
    assert.ok(no, `an act on the removed thing is refused: ${act}`);
    assert.equal(no.code, 'thing.gone'); assert.match(no.reason, /no longer in the world/);
    // (a strict client's act is answered by that gate, edge/routes.ts; a loose one is still not done)
    const sent = await w.edge.act(soul, {capability: act}) as any;
    assert.equal(sent.accepted, false, 'the act itself is not done');
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
});
