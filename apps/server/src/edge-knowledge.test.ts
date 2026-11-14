// knowledge/1 (R13): knowledge at several scales. Near is detailed (here, unchanged), the district is summarised
// (people counted, busiest places, what is on — never who), far districts are names and directions only until the Soul
// has been there (then distance and the places it visited, remembered durably), `around` (look around / explore) shows
// more. No place is secret (#1262): a stored secret mark hides nothing. Fake minds; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {coreRef} from '@souls/world-compiler';
import {coreAWorld} from '../test/core-a-fixture.ts';
import {fixture, invite, accept, factory} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {GodMode} from './god/god.ts';
import {installEngineBridge} from './god/engine-bridge.ts';
import {PlaceKnowledge, edgeDistance} from './edge/perception/knowledge.ts';

const SCALE_KEYS = ['district', 'far', 'farMore'];
const strip = (h: Record<string, unknown>) => Object.fromEntries(Object.entries(h).filter(([k]) => !SCALE_KEYS.includes(k)));

test('edgeDistance: inside 0-ish, outside by the outline', () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(edgeDistance([15, 5], sq), 5); assert.equal(edgeDistance([5, 5], sq), 5); assert.equal(Math.round(edgeDistance([13, 14], sq)), 5);
});

test('knowledge at scales: district summary, far names, memory of visits, look around; a stored secret mark hides nothing', {timeout: 300000}, async t => {
  const w = await coreAWorld(3); t.after(() => w.close());
  const [a, b, c] = w.souls, L = w.ledger;
  const here = async (s: typeof a) => {const r = await w.http(s, 'GET', '/v1/edge/here'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.here;};
  const around = async (s: typeof a) => {const r = await w.http(s, 'GET', '/v1/edge/around'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.around;};
  const caps = async (s: typeof a) => (await w.http(s, 'GET', '/v1/edge/capabilities')).body.capabilities as {id: string}[];

  // ---- near/district/far on the commons
  await w.put(a, [14, 14]); await w.put(b, [-20, 20]); await w.put(c, [30, 20]); await w.ticks(12);
  const h1 = await here(a), raw1 = JSON.stringify(h1), before = JSON.stringify(strip(h1));
  assert.equal(h1.me.place, 'field'); assert.equal(h1.district.name, 'Commons ground');
  assert.equal(h1.district.people, 1, 'B is out on the commons; C is in another district; I am not counted');
  assert.ok(!JSON.stringify(h1.district).includes(b.name), 'counts and place names only, never who');
  assert.ok(Array.isArray(h1.far) && h1.far.length === 6 && h1.farMore > 0, JSON.stringify(h1.far));
  const east1 = h1.far.find((x: string) => x.startsWith('Eden east'));
  assert.equal(east1, 'Eden east · E', 'never been there: a name and a direction only');
  // #1281: a line ends with the walk on offer; a place no walk reaches (Eden east is scenery) keeps its line without one
  assert.ok(h1.far.every((x: string) => {const [, , go, more] = x.split(' · '); return more === undefined && (go === undefined || go.startsWith('walk:'));}), `nothing visited yet: ${JSON.stringify(h1.far)}`);
  const go = h1.far.map((x: string) => x.split(' · ')[2]).filter(Boolean); assert.ok(go.length > 0, JSON.stringify(h1.far));
  for (const id of go) assert.equal(w.ledger.intents.dryRun(a, {capability: id}).ok, true, id);
  const added = raw1.length - before.length;
  t.diagnostic(`here frame ${before.length} chars (~${Math.ceil(before.length / 4)} tokens) before, ${raw1.length} (~${Math.ceil(raw1.length / 4)} tokens) with scales: +${added} chars (~${Math.ceil(added / 4)} tokens)`);
  assert.ok(added <= 420, `scales cost ${added} chars`);

  // ---- memory of visits: A walks (is put) into Eden east's housing, then comes back
  await w.put(a, [30, 20]); await w.ticks(12);
  assert.deepEqual(L.placePathOf(a.soulId).map(p => p.id), ['eden-housing', 'eden-east', 'eden']);
  const inEast = await here(a); assert.equal(inEast.district.name, 'Eden east'); assert.ok(inEast.district.people >= 1, 'C is out in Eden east');
  await w.put(a, [14, 14]); await w.ticks(12);
  const h2 = await here(a), east2 = h2.far.find((x: string) => x.startsWith('Eden east'));
  assert.match(east2, /^Eden east · E \d+m · been: /, east2); assert.ok(east2.includes(L.places.byId.get('eden-housing')!.name), east2);
  assert.ok(L.knowledge.memory(a.soulId).get('eden-east')!.visits >= 1);
  // durable: a fresh reader of the same database remembers
  assert.ok(new PlaceKnowledge(L).memory(a.soulId).has('eden-housing'), 'visits are stored, not only cached');
  // B never went: its far list still has the bare name
  assert.equal((await here(b)).far.find((x: string) => x.startsWith('Eden east')), 'Eden east · E');

  // ---- #1262: no place is secret. Stored marks on the deck north of A (≈15 m) and the park district, as the god's
  // route left them, hide nothing: every listing names them as before
  const mark = L.db.db.prepare('INSERT INTO edge_place_secrets_v1 (world_id, place_id, secret, at) VALUES (?,?,1,0)');
  for (const id of ['commons-deck', 'region-park']) mark.run(L.host.worldId, id);
  L.knowledge.changed();   // as a restart or a god edit: nothing read before the marks is kept
  assert.deepEqual(L.knowledge.secrets(), [], 'nothing is secret');
  const mapIds = L.map().map(p => p.id); assert.ok(mapIds.includes('commons-deck') && mapIds.includes('region-park'), 'on the public map');
  const hs = await here(a);
  assert.ok(JSON.stringify(hs.exits).includes('commons-deck'), 'an exit');
  assert.deepEqual([hs.far, hs.farMore], [h2.far, h2.farMore], 'the park district is far-listed as before');
  for (const s of [a, c]) assert.ok((await caps(s)).some(x => x.id === 'walk:commons-deck'), `the walk is offered to ${s.name}`);

  // ---- look around
  const ar = await around(a), rawA = JSON.stringify(ar);
  assert.equal(ar.found, undefined, 'nothing to find');
  assert.ok(ar.places.some((p: any) => p.id === 'commons-deck' && p.secret === undefined && p.walk === 'walk:commons-deck'), 'listed as any place, walkable');
  assert.ok(ar.unvisited.every((x: string) => x.startsWith('walk:')), 'suggestions are offered walks');
  assert.ok(ar.places.length > 0 && ar.places.every((p: any) => p.dir && p.eta && typeof p.m === 'number'), JSON.stringify(ar.places));
  assert.ok(Array.isArray(ar.things) && ar.things.length > 0 && ar.people.some((x: string) => x.startsWith(b.name)), rawA);
  t.diagnostic(`around frame ${rawA.length} chars (~${Math.ceil(rawA.length / 4)} tokens): ${ar.places.length} places, ${ar.people.length} people, ${ar.things.length} things`);
  assert.ok(rawA.length <= 4000, `around ${rawA.length} chars`);
  assert.deepEqual(w.f.host.engine.runtime.violations, []);
});

test('god world: a place is walked to by name (walk:<ref> offers, plain words)', {timeout: 300000}, async t => {
  const f = fixture(':memory:', factory, {durableClockV1: true});
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {}});
  const L = new EdgeLedger(f.host, f.db), bridge = installEngineBridge({host: f.host, god, edge: L, log: () => {}});
  const settle = async (n = 4) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
  f.brain.quiesce(); t.after(() => {f.brain.quiesce(); f.host.stop(); f.db.close();});
  await settle(2);
  const built = god.act({ops: [
    {op: 'place', def: coreRef('plaza'), name: 'plaza', shape: {area: [[-8, -25], [8, -25], [8, -11], [-8, -11]]}},
    {op: 'place', def: coreRef('lawn'), name: 'grove', shape: {area: [[17, -23], [27, -23], [27, -13], [17, -13]]}},
    {op: 'place', def: coreRef('lawn'), name: 'orchard', shape: {area: [[-40, -40], [-28, -40], [-28, -28], [-40, -28]]}},
  ]}, 'a plaza, a grove beside it, an orchard') as {accepted: boolean};
  assert.equal(built.accepted, true, JSON.stringify(built));
  await settle(4); bridge.perceive.sync(true);
  await invite(f, 'ana');
  const row = await accept(f.host, f.souls.create('dev:ana', {name: 'Ana', description: 'curious'})) as {id: string; entity_id: string; name: string; owner: string};
  await settle(3);
  const soul = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  const act = async (capability: string) => await accept(f.host, L.act(soul, {capability})) as {accepted: boolean; code?: string; reason?: string; receipt?: {capability: string}};

  // god-world walks are walk:<ref> (nav.ts), their target the god place g-<ref>
  const caps0 = L.capabilities(soul);
  assert.deepEqual(caps0.find(c => c.id === 'walk:grove')?.target, {id: 'g-grove', kind: 'place'});
  assert.ok(caps0.find(c => c.id === 'walk:orchard')?.available, 'the orchard (an everyday word for a grove) is walkable');

  // plain words reach it
  const known = await act('walk to the grove');
  assert.equal(known.accepted, true, JSON.stringify(known)); assert.equal(known.receipt?.capability, 'walk:grove');
});
