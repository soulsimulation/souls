// #1737 on the real Eden 2026 template (fake minds, in memory): a far spot named by its id stays on offer whatever menu
// is cached, a place with a stored secret mark is in both public routes as any place (#1262: no place is secret), and a
// god's edit to a thing or a place is a new catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {mountCatalogRoute} from './edge/catalog/routes.ts';
import {mountLiveRoute} from './edge/catalog/live.ts';
import {SPOT_REACH} from './edge/ledger/activities.ts';
import {coreRef} from '@souls/world-compiler';
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

  // #1262: a stored mark, as the god's route left one, hides nothing
  const markSecret = (id: string) => L.db.db.prepare('INSERT INTO edge_place_secrets_v1 (world_id, place_id, secret, at) VALUES (?,?,1,0) ON CONFLICT(world_id, place_id) DO UPDATE SET secret=1').run(host.worldId, id);

  await t.test('the catalog is served by tag, and a place with a stored secret mark stays in it', async () => {
    const first = await get('/v1/edge/catalog');
    assert.equal(first.status, 200); assert.equal(first.body.contract, 'soul-catalog/1');
    assert.equal((await get('/v1/edge/catalog', {'if-none-match': first.etag!})).status, 304);
    const hide = first.body.places.find((p: any) => p.kind === 'building' && first.body.things.some((x: any) => x.place === p.id) && !L.placePathOf(soul.soulId).some((q: any) => q.id === p.id));
    assert.ok(hide, 'a building with things in it, away from the Soul');
    markSecret(hide.id);
    const second = await get('/v1/edge/catalog');
    assert.equal(second.body.places.some((p: any) => p.id === hide.id), true);
    assert.equal(second.body.things.some((x: any) => x.place === hide.id), true);
    assert.equal(second.body.acts.some((a: any) => a.place === hide.id), first.body.acts.some((a: any) => a.place === hide.id));
  });

  await t.test('a thing upstairs is in the room it stands in', async () => {
    const ents = (host.engine.world as any).entities as Record<string, {pose?: {p: number[]}}>, y = (id: string) => ents[id]?.pose?.p[1] ?? 0;
    const cat = (await get('/v1/edge/catalog')).body, placeOf = new Map<string, any>(cat.places.map((p: any) => [p.id, p]));
    const upstairs = cat.things.filter((x: any) => y(x.id) > 1.5 && (placeOf.get(x.place)?.level ?? 0) > 0);
    assert.ok(upstairs.length >= 50, `things standing on upper floors are in upper-floor rooms: ${upstairs.length}`);
    // a room upstairs with things in it, away from the Soul (as the reviewer's probe: g-alpine-chalet-1.bedroom)
    const room = L.places.byId.get(upstairs.find((x: any) => !L.placePathOf(soul.soulId).some((q: any) => q.id === x.place)).place);
    const mine = cat.things.filter((x: any) => x.place === room.id);
    assert.ok(mine.length && mine.every((x: any) => y(x.id) > 1.5), `${room.id} lists its own things: ${mine.map((x: any) => x.id)}`);
  });

  await t.test('every act a find row names is taken, or refused with a reason of its own', async () => {
    const {indexCatalog, find: findLocal} = await import(CLIENT_CATALOG) as {indexCatalog: (c: unknown) => unknown; find: (ix: unknown, w: string, o: object) => {found: {act?: string}[]}};
    const cat = (await get('/v1/edge/catalog')).body, ix = indexCatalog(cat), me = L.body(soul.entityId).pose.p, at = [me[0], me[2]];
    const ids = new Set<string>();
    for (const words of ['swim', 'lake', 'pond', 'jetty', 'shore', 'library', 'read a book', 'sit on the floor', 'eat', 'bench', 'kitchen', 'garden', 'dance', 'sleep', 'music', 'table', 'bandstand', 'classroom', 'river', 'sea'])
      for (const row of findLocal(ix, words, {at}).found) if (row.act) ids.add(row.act);
    assert.ok(ids.size >= 40, `find names ${ids.size} acts`);
    const unknown: string[] = [], unbound: string[] = [];
    for (const id of ids) {
      L.invalidateBodies(); const no = L.offerGate(soul, {capability: id}); if (no?.code === 'capability.unknown') unknown.push(id);
      // and the act itself reads it as that very offer (lane M3: the gate let a far `sit:<bench>` through, the act then refused it)
      // (a walk to a place by its id is the act's own place path, before any offer is read)
      else if (!no && !L.places.byId.has(id.slice(id.indexOf(':') + 1)) && L.resolveIdV1(soul, id).kind !== 'exact') unbound.push(id);
    }
    assert.deepEqual(unknown, [], 'no find row names an act the world does not know');
    assert.deepEqual(unbound, [], 'no find row names an act the gate passes and the act does not take');
    assert.ok([...ids].filter(id => id.startsWith('sit:e_')).length >= 5, 'find names seats by their thing ids');
  });

  await t.test('a god moves, renames and removes a thing: each is a new catalog, and an act on the removed id is refused with a reason', async () => {
    const before = await get('/v1/edge/catalog');
    assert.equal((L.spots.spots as Spot[]).filter(s => L.spotThingGone(s.id)).length, 0, 'every spot of a thing names a thing the world has (a pond is the god\'s)');
    // a thing with acts of its own, away from the Soul, that the world offers by id now
    const picks = before.body.things.filter((x: any) => w.god.model.entities.has(x.id) && before.body.acts.some((a: any) => a.thing === x.id && !a.with && gate(a.id) === 'ok'));
    assert.ok(picks.length, 'a god thing with an act on offer by id');
    const edit = async (op: object) => {const r = w.god.act({ops: [op]} as never); assert.equal(r.accepted, true, JSON.stringify(r)); await run(4); return get('/v1/edge/catalog');};

    // a metre toward its slot's origin, so it stays inside (p is in its slot's frame when it has one). The first such thing the god
    // may move a metre: one beside a solid (a kitchen counter by its house's stairs, #628) is refused overlap.solid, rightly
    const nudge = (id: string) => {const p0 = (w.god.model.entities.get(id) as any).p as number[]; return {op: 'move', id, p: [p0[0]! + (p0[0]! > 0 ? -1 : 1), ...p0.slice(1)]};};
    const pick = picks.find((x: any) => w.god.preview({ops: [nudge(x.id)]} as never).accepted);   // a dry run
    assert.ok(pick, 'a god thing on offer by id that can be moved a metre');
    const act = before.body.acts.find((a: any) => a.thing === pick.id && !a.with && gate(a.id) === 'ok').id as string;
    const moved = await edit(nudge(pick.id));
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

  await t.test('a god adds, renames and removes a place: each is a new catalog, and the place enters, changes and leaves it', async () => {
    const edit = async (op: object) => {const r = w.god.act({ops: [op]} as never); assert.equal(r.accepted, true, JSON.stringify(r)); await run(4); w.bridge.perceive.sync(true); await run(2); return get('/v1/edge/catalog');};
    const before = await get('/v1/edge/catalog'), me = L.body(soul.entityId).pose.p, [x, z] = [Math.round(me[0]) + 6, Math.round(me[2]) + 6];
    const added = await edit({op: 'place', def: coreRef('plaza'), name: 'catalog-test-square', shape: {area: [[x, z], [x + 8, z], [x + 8, z + 8], [x, z + 8]]}});
    assert.notEqual(added.etag, before.etag, 'an added place is a new version');
    const square = added.body.places.find((p: any) => p.id === 'g-catalog-test-square');
    assert.ok(square, `the new place is in the catalog: ${added.body.places.filter((p: any) => /catalog-test/.test(p.id)).map((p: any) => p.id)}`);
    assert.equal(square.kind, 'plaza');
    const entity = [...w.god.model.entities.values()].find((e: any) => e.name === 'catalog-test-square') as {id: string};
    const renamed = await edit({op: 'set', id: entity.id, name: 'catalog-test-green'});
    assert.notEqual(renamed.etag, added.etag, 'a renamed place is a new version');
    assert.deepEqual(renamed.body.places.filter((p: any) => /catalog-test/.test(p.id)).map((p: any) => [p.id, p.name]), [['g-catalog-test-green', 'Catalog test green']], 'under its new name only');
    const removed = await edit({op: 'remove', id: entity.id});
    assert.notEqual(removed.etag, renamed.etag, 'a removed place is a new version');
    assert.equal(removed.body.places.some((p: any) => /catalog-test/.test(p.id)), false, 'and it left the catalog');
    assert.equal(removed.body.acts.some((a: any) => /catalog-test/.test(a.place ?? '')), false);
  });

  await t.test('a seat a find row names by its thing id (`sit:<thing>`) is taken from anywhere, not only the nearest few', async () => {
    const cat = (await get('/v1/edge/catalog')).body, me = L.body(soul.entityId).pose.p, away = (x: any) => Math.hypot(x.at[0] - me[0], x.at[1] - me[2]);
    // the things the catalog says are seats (the client names `sit:<id>` for these only): of each kind, the farthest
    const byKind = new Map<string, any>();
    for (const x of cat.things) if (x.seat && away(x) > (byKind.has(x.kind) ? away(byKind.get(x.kind)) : -1)) byKind.set(x.kind, x);
    const named = cat.things.filter((x: any) => /bench|stool/.test(x.kind)), notSeats = named.filter((x: any) => !x.seat).map((x: any) => x.kind);
    assert.ok(notSeats.includes('eden-weight-bench'), `a gym bench is named a bench but has no seat: not a seat in the catalog (${[...new Set(notSeats)]})`);
    const far = cat.things.filter((x: any) => x.seat && /bench/.test(x.kind) && away(x) > 250).sort((a: any, b: any) => away(a) - away(b)).slice(0, 8);
    assert.ok(far.length >= 5 && byKind.size >= 5, `benches past 250 m: ${far.length}; seat kinds: ${[...byKind.keys()]}`);
    const unbound = [...byKind.values(), ...far].map((x: any) => `sit:${x.id}`).filter(id => {L.invalidateBodies(); return L.resolveIdV1(soul, id).kind !== 'exact';});
    assert.deepEqual(unbound, [], 'each is the world\'s own offer by that id');
    L.binds(soul); assert.equal(L.resolveIdV1(soul, `sit:${far[0].id}`).kind, 'exact', 'with the whole menu kept too');
    const from = [me[0], me[2]], acting = w.edge.act(soul, {capability: `sit:${far[0].id}`}) as Promise<any>;
    await run(20); const sent = await acting;
    assert.equal(sent.accepted, true, JSON.stringify(sent).slice(0, 400));
    await run(60); const now = L.body(soul.entityId).pose.p;
    assert.ok(Math.hypot(now[0] - from[0]!, now[2] - from[1]!) > 1, 'and the Soul is on its way');
  });

  await t.test('the live picture names where a Soul is, in a place with a stored secret mark too', async () => {
    const place = L.placePathOf(soul.soulId).find((p: any) => p.kind !== 'occupier').id as string;
    hear({kind: 'speech', id: 'sp_open', tick: host.engine.world.tick, at: 1, from: {soulId: soul.soulId, name: soul.name}, channel: {kind: 'earshot', placeId: place}, text: 'hello out here'});
    await run(10);
    const open = await get('/v1/edge/live'), row = open.body.souls.find((s: any) => s.id === soul.soulId);
    assert.equal(open.body.contract, 'soul-live/1'); assert.equal(open.body.catalog, catalog.version());
    assert.equal(row.place, place); assert.equal(row.at.length, 2);
    assert.deepEqual(open.body.speech.map((s: any) => [s.id, s.place, s.untrusted]), [['sp_open', place, true]]);
    markSecret(place);
    hear({kind: 'speech', id: 'sp_marked', tick: host.engine.world.tick, at: 2, from: {soulId: soul.soulId, name: soul.name}, channel: {kind: 'earshot', placeId: place}, text: 'said in the marked place'});
    await run(10);
    const marked = await get('/v1/edge/live'), still = marked.body.souls.find((s: any) => s.id === soul.soulId);
    assert.equal(still.place, place, 'where the Soul is is said'); assert.equal(still.at.length, 2);
    assert.deepEqual(marked.body.speech.map((s: any) => [s.id, s.place]), [['sp_open', place], ['sp_marked', place]], 'and what is said there');
  });
});
