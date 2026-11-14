// #1288: a repeat answers with the act under way (#1272), so a held act has to end by itself. A swim held behind a body
// treading in its way, and a go-near from deep water (ground_travel with a swim_to child), end under wait-bound/2 as a walk
// held by a wait does under wait-bound/1: route.blocked within a minute of the last headway, the swimmer left where it is.
// The real act path on a fixture world with a god's pond; the rules come from the boot adoption main runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {accept, factory, fixture, invite} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {GodMode} from './god/god.ts';
import {GroundHost, installGroundCapabilities} from './god/ground-host.ts';
import {installEngineBridge} from './god/engine-bridge.ts';
import {adoptBootRuntimePoliciesV1} from './edge-runtime-rules.ts';

// The body rule's reflexes run on the wall clock: past its sleep grace (2 min) a loaded machine sees Bo and Ann as
// disconnected and shuffles them ashore. They are not under test here, so the body rule is off.
process.env.SIM_BODY = '0';
const BOUND = 1200;
async function pond(t: {after(f: () => void): void}) {
  const w = fixture(':memory:', factory, {durableClockV1: true}); w.brain.quiesce();
  const god = new GodMode(w.db, {worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit() {}});
  new GroundHost(w.db, w.host, god); const edge = new EdgeLedger(w.host, w.db);
  installGroundCapabilities(edge as never, god, w.host); installEngineBridge({host: w.host, god, edge, log() {}, worldClock: false, worldLore: false});
  t.after(() => {w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close();});
  const tick = async (n: number) => {for (let i = 0; i < n; i++) {w.host.tickOnce(); if (i % 20 === 0) {await setImmediate(); w.host.drainInputs();}}};
  await tick(4);
  await accept<unknown>(w.host, adoptBootRuntimePoliciesV1(w.host, {edge: true, worldKey: 'eden'})); await tick(4);
  assert.equal((god.act({ops: [{op: 'place', def: 'core/pond@1', name: 'progress-pond', params: {depth: 3}, shape: {area: [[-22, -36], [-10, -36], [-10, -24], [-22, -24]]}}]} as never) as {accepted: boolean}).accepted, true); await tick(4);
  const soul = async (n: string, to: [number, number] = [-4, -30]) => {
    await invite(w, n); const row = await accept(w.host, w.souls.create('dev:' + n, {name: n, description: 'swims'})) as any; await tick(4);
    await accept(w.host, w.host.enqueue('edge-relocate', 'test:bank', {soulId: row.id, entityId: row.entity_id, to, why: 'bank'})); await tick(4);
    return {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  };
  type S = Awaited<ReturnType<typeof soul>>;
  const act = (s: S, capability: string) => accept(w.host, Promise.resolve(edge.act(s as never, {capability} as never))) as Promise<any>;
  const open = (s: S, id: string) => ['waiting', 'started'].includes(edge.receipt(s.soulId, id)!.phase);
  const body = (s: S) => (w.host.engine.world.entities as any)[s.entityId];
  /** Bo swims to the middle of the pond and treads there; nothing moves him on. */
  const bo = await soul('bo'), b = await act(bo, 'swim:progress-pond/middle'); assert.equal(b.accepted, true, JSON.stringify(b));
  for (let i = 0; i < 4000 && open(bo, b.receipt.id); i++) await tick(1);
  assert.equal(edge.receipt(bo.soulId, b.receipt.id)!.phase, 'completed'); assert.equal(body(bo).human.activity, 'tread');
  /** Runs `id` to its end, tracking the tick its body last left a 0.5 m disc (the bound's measure) and the largest step. */
  const run = async (s: S, id: string, ticks: number) => {
    let anchor = [...body(s).pose.p], headway = w.host.engine.world.tick, was = [...body(s).pose.p], jump = 0, held = false;
    for (let i = 0; i < ticks && open(s, id); i++) {
      await tick(1); const p = body(s).pose.p, r = body(s).human.task ? (w.host.engine.runtime as any).records.get(body(s).human.task) : null;
      if (r?.diagnostic?.code === 'swim.occupied') held = true;
      jump = Math.max(jump, Math.hypot(p[0] - was[0], p[2] - was[2])); was = [...p];
      if (Math.hypot(p[0] - anchor[0], p[2] - anchor[2]) > 0.5) {anchor = [...p]; headway = w.host.engine.world.tick;}
    }
    return {end: edge.receipt(s.soulId, id)!, headway, jump, held, at: [...body(s).pose.p]};
  };
  return {w, tick, soul, act, open, body, bo, run};
}
function endedHeld(r: {end: any; headway: number; jump: number; held: boolean}, b: any, who: string) {
  assert.ok(r.held, 'held behind the body treading in the way (swim.occupied)');
  assert.equal(r.end.phase, 'failed', JSON.stringify(r.end)); assert.equal(r.end.code, 'route.blocked', JSON.stringify(r.end));
  assert.match(r.end.reason, new RegExp(`^wait-bound/2: .*swim\\.occupied \\(waiting for ${who}\\)`), 'the reason names the wait and the body it waited for');
  assert.ok(r.end.endedTick - r.headway <= BOUND + 25, `ended ${r.end.endedTick - r.headway} ticks after its last headway`);
  assert.ok(r.end.endedTick - r.headway >= BOUND - 25, `not before the bound: ${r.end.endedTick - r.headway}`);
  assert.ok(r.jump < 0.3, `no teleport: the largest step was ${r.jump.toFixed(2)} m`);
  assert.equal(b.human.task, undefined, 'no task left'); assert.ok(['tread', 'idle'].includes(b.human.activity), b.human.activity);
}

test('#1288 A1/A2 swim: a swim held behind a Soul treading in its way ends route.blocked under wait-bound/2; sent again it is a new act', {timeout: 300000}, async t => {
  const {w, soul, act, body, bo, run} = await pond(t);
  const ann = await soul('ann'), a = await act(ann, 'swim:progress-pond/middle'); assert.equal(a.accepted, true, JSON.stringify(a));
  const r = await run(ann, a.receipt.id, 4000);
  endedHeld(r, body(ann), bo.entityId);
  assert.deepEqual(w.host.engine.runtime.violations, []);
  const again = await act(ann, 'swim:progress-pond/middle'); assert.equal(again.accepted, true, JSON.stringify(again));
  assert.equal(again.repeat, undefined); assert.notEqual(again.receipt.id, a.receipt.id);
});

test('#1288 A1/A2 go-near: a go-near from deep water held in the water ends route.blocked under wait-bound/2', {timeout: 300000}, async t => {
  const {w, tick, soul, act, open, body, bo, run} = await pond(t);
  // Ann swims out to the pond and treads beside Bo; Carl stands on the far bank, past Bo
  const ann = await soul('ann'), a = await act(ann, 'swim:progress-pond/middle');
  for (let i = 0; i < 4000 && open(ann, a.receipt.id); i++) await tick(1);
  const carl = await soul('carl', [-28, -30]); await tick(10);
  const gn = await act(ann, 'go-near:' + carl.soulId); assert.equal(gn.accepted, true, JSON.stringify(gn));
  const r = await run(ann, gn.receipt.id, 4000);
  endedHeld(r, body(ann), bo.entityId);
  assert.deepEqual(w.host.engine.runtime.violations, []);
});
