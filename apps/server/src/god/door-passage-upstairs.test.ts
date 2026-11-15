// Review of #2397, item 1: a Soul upstairs in a building whose only door out is a closed hand door gets out with one plain
// walk: the passage is planned from her own floor (the first leg's walk down the stairs to the door), opened by hand,
// passed and closed behind. Reach and the connectivity audit agree that upstairs is joined to the world by that door.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {fixture, factory, invite, accept} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../edge/routes.ts';
import {GodMode} from './god.ts';
import {installEngineBridge} from './engine-bridge.ts';
import {doorFit} from './door-fit.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Vec2 = [number, number];
const AT: Vec2 = [10, 10], PARAMS = {floors: 2};

test('upstairs behind a closed front door: one walk out, through the door by hand', {timeout: 300_000}, async t => {
  const w = fixture(':memory:', factory, {durableClockV1: true}); w.brain.quiesce();
  const god = new GodMode(w.db, {worldId: w.host.worldId, ownerId: 'dev:admin', tick: () => w.host.engine.world.tick, emit() {}});
  const edge = new EdgeLedger(w.host, w.db, undefined, {ambient: false});
  installEngineBridge({host: w.host, god, edge, log() {}, worldClock: false, worldLore: false});
  const comms = mountEdgeRoutes(new Hono(), {host: w.host, db: w.db, souls: w.souls, ledger: edge, soul: () => undefined as never});
  t.after(() => {w.brain.quiesce(); w.host.stop(); comms.close(); w.db.close();});
  const tick = async (n = 4) => {for (let i = 0; i < n; i++) {w.host.tickOnce(); await setImmediate(); w.host.drainInputs();}};
  const E = w.host.engine as any;
  const fit = doorFit('core/cottage@1', PARAMS, AT, 0, 'house')!;
  assert.ok(fit.doors.length >= 1);
  const r: any = god.engineAct([{op: 'place', def: fit.ref, name: 'house', p: AT, r: 0, params: PARAMS}, ...fit.doors.map(d => ({...d, state: {open: false}})),
    {op: 'place', def: 'core/floor-lamp@2', name: 'outside-lamp', p: [AT[0] + 2, AT[1] - 14]}] as any, 'test: a house');
  assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 600));
  await tick(20);
  const door = () => [...god.model.entities.values()].find((e: any) => e.name === 'house-door-1') as any;
  assert.equal(door().state.open, false, 'the front door stands closed');
  const BED: Vec2 = [8.08, 11.005], OUT: Vec2 = [AT[0] + 2, AT[1] - 12];   // the upstairs bedroom (floor 1), the street
  // reach and the audit: upstairs is one ground door from the world (#2383 upstairs join); the walk graph walls the gap
  assert.equal(E.reachV1({p: BED, level: 1}, {p: OUT, level: 0}).ok, true, 'reach: upstairs to the street through the door');
  assert.equal(E.reachV1({p: OUT, level: 0}, {p: BED, level: 1}).ok, true, 'reach: and back up');
  assert.equal(E.navCheckV1([{id: 'bed', p: BED, level: 1, tol: 0.6}])[0].ok, true, 'audit: upstairs is joined to the world');
  await invite(w, 'ana');
  const row: any = await accept(w.host, w.souls.create('dev:ana', {name: 'Ana', description: 'upstairs door test'}));
  const ana = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await tick(3);
  const body = () => E.world.entities[ana.entityId];
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:put', {soulId: ana.soulId, entityId: ana.entityId, to: BED, godWalkout: true, released: [], level: 1}));
  await tick(6);
  assert.equal(body().human.level, 1, 'she stands upstairs');
  assert.equal(E.navRescueV1(ana.entityId, Infinity), null, 'joined: no step-out');
  const res: any = await accept(w.host, edge.act(ana, {capability: 'walk:outside-lamp'}));
  assert.equal(res.accepted, true, JSON.stringify(res).slice(0, 600));
  assert.match(res.receipt.reason ?? '', /Through house-door-1/, 'the walk goes down and out through the door by hand');
  let e: any;
  for (let n = 0; n < 3000; n++) {e = edge.receipt(ana.soulId, res.receipt.id); if (['failed', 'completed', 'replaced'].includes(e?.phase)) break; await tick(1);}
  assert.equal(e.phase, 'completed', JSON.stringify(e).slice(0, 600));
  assert.equal(body().human.level ?? 0, 0, 'on the ground');
  assert.ok(Math.hypot(body().pose.p[0] - AT[0] - 2, body().pose.p[2] - AT[1] + 14) < 2.5, 'outside, at the lamp');
  assert.equal(door().state.open, false, 'closed behind');
  assert.deepEqual(E.runtime.violations, []);
});
