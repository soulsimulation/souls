// #2354: a walk resolved by place name, by a far place's id or by an object walk's label reads the Soul's walk offers
// alone (offersOfVerb, a focused build), not its whole menu (every object's actions, seats, layers: most of such an act
// at 24 Souls). The walk offers are exactly the whole menu's, in its order, and the act chooses the same walk or gives the
// same refusal. Also: a focus of the verb `sit` builds `sit:here` as the whole menu does.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { fixture, factory, invite, accept } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { offersOfVerb, explicitPlaceCapability, knownBootPlaces } from '../edge/boot/world-places.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { GroundHost } from './ground-host.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const COTTAGE = { w: 8, d: 6, floors: 1, floorHeight: 2.8, style: 'cottage', roof: 'gable', roofPitch: 32, material: 'plaster', front: 's', porch: 0, balcony: false, windows: 0.6, wallThickness: 0.22 };

async function world(t: TestContext) {
  const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit() {} });
  new GroundHost(w.db, w.host, god);
  const edge = new EdgeLedger(w.host, w.db), bridge = installEngineBridge({ host: w.host, god, edge, log() {}, worldClock: false, worldLore: false });
  t.after(() => { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); });
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  await invite(w, 'ada'); const row: any = await accept(w.host, w.souls.create('dev:ada', { name: 'Ada', description: 'curious' })); await settle(3);
  const s = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner };
  const p = (w.host.engine.world as any).entities[s.entityId].pose.p, at = [p[0], p[2]];
  const r = god.act({ ops: [
    { op: 'place', def: coreRef('cottage'), name: 'cottage', p: [Math.round(at[0] + 95), Math.round(at[1])], params: COTTAGE },
    { op: 'place', def: coreRef('bench'), name: 'bench', p: [Math.round(at[0] + 6), Math.round(at[1] + 3)] },
    { op: 'place', def: coreRef('fountain'), name: 'fountain', p: [Math.round(at[0] - 12), Math.round(at[1] + 4)] },
  ] }) as any;
  assert.equal(r.accepted, true, JSON.stringify(r)); await settle(4);
  bridge.perceive.sync(true); edge.map();   // the god-built places (the cottage and its rooms) join the places layer
  return { edge, s, settle };
}

const view = (caps: any[]) => caps.map((c) => JSON.stringify(c));

test('#2354: a walk by name, by a far place id or by an object label resolves on the whole menu\'s walk offers, with the same choice and refusals', { timeout: 300_000 }, async (t) => {
  const { edge, s, settle } = await world(t);
  const E = edge as any, walkBuilds = { n: 0 }, onDemand = { n: 0 };
  const bindFocus = E.bindFocus.bind(E); E.bindFocus = (soul: unknown, f: any) => { if (f.verbs.has('walk') && !f.ids.size) walkBuilds.n++; return bindFocus(soul, f); };
  const walkOnDemand = E.walkOnDemand; E.walkOnDemand = (...a: unknown[]) => { onDemand.n++; return walkOnDemand(...a); };

  await settle(1); edge.invalidateBodies();                     // nothing kept: the focused build runs, then the whole one
  const focused = offersOfVerb(edge, s as any, 'walk'), whole = edge.coreA.binds(s as any).caps.filter((c) => c.verb === 'walk');
  assert.ok(whole.length > 1, 'walks are offered');
  assert.deepEqual(view(focused), view(whole), 'same walk offers, same order');

  // the inputs that reach the changed lines: a far room by its place id (place.unwalkable, then its walk on demand), a
  // place by its name (a room's name holds a slash, an entity ref, and stops earlier), an object walk by its label and by "the" + label, and a name nothing has
  const places = knownBootPlaces(edge, s.soulId), room = places.find((p) => p.id.startsWith('g-cottage.') && p.id !== 'g-cottage');
  assert.ok(room, `a cottage room is a known place: ${JSON.stringify(places.map((p) => p.id))}`);
  assert.ok(!whole.some((c) => c.target?.id === room!.id), 'the room is beyond the listing (its walk is on demand)');
  const bench = whole.find((c) => c.target?.kind === 'object')!; assert.ok(bench, 'an object walk is offered');
  const cases: { asked: string; onDemand?: true }[] = [
    { asked: `walk:${room!.id}`, onDemand: true },
    { asked: 'walk:Cottage' },
    { asked: 'walk:Green field' },
    { asked: `walk:${bench.label}` },
    { asked: `walk:the ${bench.label}` },
    { asked: 'walk:the lighthouse' },
  ];
  for (const c of cases) {
    await settle(1); edge.invalidateBodies();
    const b0 = walkBuilds.n, d0 = onDemand.n;
    const got = explicitPlaceCapability(edge, s as any, c.asked);
    assert.ok(walkBuilds.n > b0, `${c.asked}: read the walk offers (the changed lines)`);
    if (c.onDemand) assert.ok(onDemand.n > d0, `${c.asked}: its walk was offered on demand`);
    edge.coreA.binds(s as any);                                  // this tick's whole menu: the offers now come from it
    const want = explicitPlaceCapability(edge, s as any, c.asked);
    assert.deepEqual(got, want, c.asked);
  }
  // what each answered, so a change of answer shows here and not only as a difference between the two reads
  await settle(1);
  const outcome = (asked: string) => { const r = explicitPlaceCapability(edge, s as any, asked) as any; return r === null ? 'offered' : r.ok ? `place ${r.chosen.place}` : r.code; };
  assert.equal(outcome(`walk:${room!.id}`), `place ${room!.id}`, 'the far room resolves to its walk on demand');
  assert.equal(outcome('walk:Green field'), 'place field');
  assert.equal(outcome('walk:Cottage'), 'place g-cottage');
  assert.equal(outcome(`walk:${bench.label}`), 'offered');
  assert.equal(outcome('walk:the lighthouse'), 'capability.unknown');
});

test('#2354 also fixed: a focus of the verb sit builds sit:here as the whole menu does', { timeout: 300_000 }, async (t) => {
  const { edge, s, settle } = await world(t);
  await settle(1); edge.invalidateBodies();
  const focused = edge.bindFocus(s as any, { ids: new Set(), verbs: new Set(['sit']), targets: new Set() }).caps;
  const whole = edge.coreA.binds(s as any).caps.filter((c) => c.verb === 'sit');
  assert.ok(whole.some((c) => c.id === 'sit:here'), 'sit:here is offered');
  assert.deepEqual(view(focused), view(whole), 'same sit offers, sit:here with the same label and target');
});
