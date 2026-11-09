// #1515: the walk listing keeps three pure answers instead of recomputing them on every read (at 12 Souls the read path
// outweighed the whole tick): a standing point's main-ground verdict per static epoch (GodNav.connOk), the service points
// in a room per service list (GodNav.servicesIn), and an outdoor region's interiors per place-index version
// (outdoorRegionExclusions). The oracle: on Eden 2026, at every step (Souls walking, a god edit, a ride moving, navigation
// cold and warm again), the walk offers built with what was kept equal the walk offers built with nothing kept, and every
// kept answer equals the engine's or the function's fresh one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {accept, invite} from '../test/native-owner-fixture.ts';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {outdoorRegionExclusions, outdoorRegionExclusionsFreshV1} from './edge/ledger/region-arrival.ts';
import {GodNav} from './god/nav.ts';
import type {EdgeCapability, EdgeSoul} from './edge/contract.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json';
type Kept = {goals: Map<string, unknown>; connMemo: {ep: number; m: Map<string, boolean | undefined>} | null; serviceMemo: unknown};
type Eng = {navWarmV1(ms: number): boolean; staticEpochV1(): number; readPassV1<T>(fn: () => T): T; navCheckV1(p: {id: string; p: [number, number]; level: number}[]): {ok: boolean}[]};

test('Eden 2026: walk offers built from kept verdicts equal ones built afresh, across walks, a god edit and a ride', {timeout: 900_000, skip: NO_EDEN}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const host = w.host, E = host.engine as unknown as Eng, nav = w.bridge.nav, kept = nav as unknown as Kept, L = w.edge;
  const run = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}} await setImmediate(); host.drainInputs();};
  const souls: EdgeSoul[] = [w.soul];
  for (const name of ['bea', 'cy']) {
    await invite(w, name);
    const row = await accept(host, w.souls.create(`dev:${name}`, {name, description: 'memo oracle'})) as {id: string; entity_id: string; name: string; owner: string};
    souls.push({soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner});
  }
  await run(20);
  for (let i = 0; i < 4000 && !E.navWarmV1(0); i++) host.tickOnce();
  assert.ok(E.navWarmV1(0), 'navigation is warm (the main-ground checks run)');
  const offers = (s: EdgeSoul) => {
    kept.goals.clear();   // every goal is made now, from what is kept (the 50-tick goal cache is not what is under test)
    const caps: EdgeCapability[] = [], plans = new Map();
    E.readPassV1(() => nav.capabilities(s, caps, plans));
    return JSON.stringify([caps, [...plans]]);
  };
  let steps = 0, verdicts = 0;
  const check = (what: string) => {
    for (const s of souls) {
      const withKept = offers(s);
      kept.connMemo = null; kept.serviceMemo = null;
      const fresh = offers(s);
      assert.equal(withKept, fresh, `${what}: ${s.name}'s walk offers from kept answers are the fresh ones`);
    }
    // every kept verdict of this static epoch is the engine's own
    const memo = kept.connMemo;
    if (memo) for (const [k, ok] of memo.m) {
      const [level, xz] = k.split('|'), [x, z] = xz!.split(',').map(Number);
      assert.equal(ok, E.navCheckV1([{id: 'oracle', p: [x!, z!], level: Number(level)}])[0]?.ok, `${what}: kept verdict ${k}`); verdicts++;
    }
    for (const id of L.places.byId.keys()) assert.deepEqual(outdoorRegionExclusions(L.places, id), outdoorRegionExclusionsFreshV1(L.places, id), `${what}: ${id}'s interiors`);
    steps++;
  };
  check('settled');
  assert.ok(kept.connMemo && kept.connMemo.m.size > 0, 'the listing asked main-ground verdicts');
  // Souls walking: the reads move cells every few ticks
  for (const s of souls.slice(0, 2)) {
    const walk = L.capabilities(s).filter(c => c.verb === 'walk' && c.available && c.target?.kind === 'place')[3];
    assert.ok(walk, `${s.name} has somewhere to walk`);
    const out = await accept(host, Promise.resolve(L.act(s, {capability: walk.id}))) as {accepted?: boolean}; assert.ok(out.accepted, `${s.name} walks to ${walk.id}`);
  }
  for (let i = 0; i < 4; i++) {await run(30); check(`walking (${i})`);}
  // a god edit over a point whose verdict is kept (main ground, away from the Souls): a new static epoch, new places,
  // new things, and that point no longer standing room
  const ep0 = E.staticEpochV1(), bodies = souls.map(s => host.engine.world.entities[s.entityId]!.pose.p);
  const under = [...kept.connMemo!.m].map(([k, ok]) => ({k, ok, p: k.split('|')[1]!.split(',').map(Number) as [number, number]}))
    .find(x => x.ok && x.k.startsWith('0|') && bodies.every(b => Math.hypot(b[0] - x.p[0], b[2] - x.p[1]) > 15));
  assert.ok(under, 'a kept main-ground verdict away from the Souls');
  const block = {schema: 'def/1', name: 'memo-block', version: 1, layer: 'solid', size: {box: [3, 3, 3]}, make: {kind: 'gen', gen: 'kit/2', args: {shapes: [{kind: 'box', at: [0, 1.5, 0], size: [3, 3, 3]}]}}};
  const placed = w.god.act({ops: [{op: 'define', def: block}, {op: 'place', def: 'memo-block@1', name: 'memo-oracle-block', p: under.p}]} as never) as {accepted: boolean};
  assert.ok(placed.accepted, `the block is placed: ${JSON.stringify(placed).slice(0, 300)}`);
  await run(10);
  assert.notEqual(E.staticEpochV1(), ep0, 'the edit moved the static epoch');
  // asked straight after the edit, before anything else could replace what was kept: the new epoch's verdict
  const now = E.navCheckV1([{id: 'oracle', p: under.p, level: 0}])[0]?.ok;
  assert.notEqual(now, true, 'the block stands on the point whose verdict was kept');
  assert.equal((nav as unknown as {connOk(id: string, g: {p: [number, number]; level: number}): boolean | undefined}).connOk('oracle', {p: under.p, level: 0}), now, 'the kept verdict is not the one from before the edit');
  check('after a god edit (as soon as seen)');
  for (let i = 0; i < 4000 && !E.navWarmV1(0); i++) host.tickOnce();
  check('after a god edit (warm again)');
  // a ride moving (#901): the static epoch moves and the labels go cold, then warm again
  const ents = host.engine.world.entities as Record<string, {pose: {p: number[]}}>;
  const ride = ['eden-balloon', 'resort-carousel', 'resort-ferris-wheel'].map(id => ents[id]).find(Boolean);
  assert.ok(ride, 'Eden runs a ride');
  const ep1 = E.staticEpochV1(); ride.pose.p[0] += 0.01;
  assert.notEqual(E.staticEpochV1(), ep1, 'the ride moved the static epoch');
  check('a ride moved (cold)');
  for (let i = 0; i < 4000 && !E.navWarmV1(0); i++) host.tickOnce();
  check('a ride moved (warm again)');
  t.diagnostic(`${steps} oracle steps, ${verdicts} kept verdicts checked against the engine`);
});

test('GodNav.connOk: one engine check per point and static epoch; a new epoch asks again', () => {
  let epoch = 1, calls = 0;
  const engine = {world: {tick: 1, entities: {}, regions: {}}, staticEpochV1: () => epoch,
    navCheckV1: (pts: {p: [number, number]; level: number}[]) => {calls++; return pts.map(q => ({ok: q.p[0] > 0}));}};
  const nav = new GodNav({engine} as never) as unknown as {connOk(id: string, g: {p: [number, number]; level: number}): boolean | undefined};
  assert.equal(nav.connOk('a', {p: [1, 2], level: 0}), true);
  assert.equal(nav.connOk('b', {p: [1, 2], level: 0}), true, 'the same point, another caller: kept');
  assert.equal(calls, 1);
  assert.equal(nav.connOk('a', {p: [1, 2], level: 1}), true, 'another level is another point');
  assert.equal(nav.connOk('a', {p: [-1, 2], level: 0}), false);
  assert.equal(calls, 3);
  epoch = 2; assert.equal(nav.connOk('a', {p: [1, 2], level: 0}), true); assert.equal(calls, 4, 'a new static epoch asks the engine again');
  const plain = new GodNav({engine: {...engine, staticEpochV1: undefined}} as never) as unknown as typeof nav;
  plain.connOk('a', {p: [1, 2], level: 0}); plain.connOk('a', {p: [1, 2], level: 0}); assert.equal(calls, 6, 'no static epoch: never kept');
});
