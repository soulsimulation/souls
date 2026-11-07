// knowledge/1 (R13): knowledge at several scales. Near is detailed (here, unchanged), the district is summarised
// (people counted, busiest places, what is on — never who), far districts are names and directions only until the Soul
// has been there (then distance and the places it visited, remembered durably), `around` (look around / explore) shows
// more. Fake minds; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {coreAWorld} from '../test/core-a-fixture.ts';
import {fixture, invite, accept, factory} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {PlaceKnowledge} from './edge/perception/knowledge.ts';

const SCALE_KEYS = ['district', 'far', 'farMore'];
const strip = (h: Record<string, unknown>) => Object.fromEntries(Object.entries(h).filter(([k]) => !SCALE_KEYS.includes(k)));

test('knowledge at scales: district summary, far names, memory of visits, look around', {timeout: 300000}, async t => {
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
  assert.ok(h1.far.every((x: string) => x.split(' · ').length === 2), 'nothing visited yet');
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

  // ---- look around
  const ar = await around(a), rawA = JSON.stringify(ar);
  assert.ok(ar.unvisited.every((x: string) => x.startsWith('walk:')), 'suggestions are offered walks');
  assert.ok(ar.places.length > 0 && ar.places.every((p: any) => p.dir && p.eta && typeof p.m === 'number'), JSON.stringify(ar.places));
  assert.ok(Array.isArray(ar.things) && ar.things.length > 0 && ar.people.some((x: string) => x.startsWith(b.name)), rawA);
  t.diagnostic(`around frame ${rawA.length} chars (~${Math.ceil(rawA.length / 4)} tokens): ${ar.places.length} places, ${ar.people.length} people, ${ar.things.length} things`);
  assert.ok(rawA.length <= 4000, `around ${rawA.length} chars`);
  assert.deepEqual(w.f.host.engine.runtime.violations, []);
});

test('#1262: a world with stored marks boots as any other: a place once marked secret is an ordinary place', {timeout: 300000}, async t => {
  const w = await coreAWorld(1); t.after(() => w.close());
  const L = w.ledger, [a] = w.souls, db = w.f.db.db;
  db.exec('CREATE TABLE IF NOT EXISTS edge_place_secrets_v1 (world_id TEXT NOT NULL, place_id TEXT NOT NULL, secret INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (world_id, place_id)) WITHOUT ROWID');
  db.prepare('INSERT INTO edge_place_secrets_v1 VALUES (?,?,1,?)').run(w.f.host.worldId, 'commons-deck', 1);
  const reopened = new EdgeLedger(w.f.host, w.f.db);
  assert.ok(reopened.map().some(p => p.id === 'commons-deck'), 'on the public map');
  assert.ok(reopened.capabilities(a).some(c => c.id === 'walk:commons-deck'), 'walked to like any place');
  assert.equal((db.prepare('SELECT count(*) n FROM edge_place_secrets_v1').get() as {n: number}).n, 1, 'left as it was: nothing reads it');
});
