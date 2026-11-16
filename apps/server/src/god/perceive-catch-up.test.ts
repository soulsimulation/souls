// #2501: a world catching up the ticks it owes (a release handover's or a restart's boot, before its clock starts) is
// served: the god layer's first perception pass runs in slices there, as on a running world, never whole inside one
// catch-up tick (on Eden 2026 the whole pass held /healthz and every viewer's welcome ~0.9 s of each release's pause).
// A world stepped by hand (no clock, nothing owed) still runs it whole at once, as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function world(t: any) {
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(f.host, f.db);
  const bridge = installEngineBridge({ host: f.host, god, edge, log: () => {} });
  const { Hono } = await import('hono');
  const { mountEdgeRoutes, edgeSoulResolver } = await import('../edge/routes.ts');
  const comms = mountEdgeRoutes(new Hono(), { host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, () => undefined), ledger: edge } as never);
  f.brain.quiesce();
  t.after(() => { comms.close(); f.brain.quiesce(); f.host.stop(); f.db.close(); });
  const r = god.act({ ops: [
    { op: 'place', def: coreRef('fountain'), name: 'fountain', p: [0, 0] },
    { op: 'place', def: 'core-sign@1', name: 'notice', p: [-4, 2], state: { text: 'Welcome' } },
    { op: 'place', def: coreRef('roundhouse'), name: 'hut', p: [-20, 20] },
  ] } as never) as any;
  assert.equal(r.accepted, true, JSON.stringify(r));
  // which way the first pass runs: whole (sync) or a slice (step), and whether a catch-up was under way then
  const P = bridge.perceive as any, calls: { how: 'whole' | 'slice'; owed: number }[] = [];
  const sync = P.sync.bind(P), step = P.step.bind(P);
  P.sync = (force?: boolean) => { calls.push({ how: 'whole', owed: f.host.owedTicks }); return sync(force); };
  P.step = (budget?: number) => { calls.push({ how: 'slice', owed: f.host.owedTicks }); return step(budget); };
  return { f, P, calls };
}

test('#2501: the first perception pass runs in slices during a boot catch-up, and whole on a world stepped by hand', async (t) => {
  await t.test('catching up owed ticks (the clock not started): sliced, and done by the end', async (t) => {
    const { f, P, calls } = await world(t);
    const ran = await f.host.catchUp(120, () => setImmediate());
    assert.equal(ran, 120, 'every owed tick runs (world time never stops)');
    const during = calls.filter((c) => c.owed > 0);
    assert.ok(during.some((c) => c.how === 'slice'), `the pass ran in slices during the catch-up (${JSON.stringify(calls.slice(0, 5))})`);
    assert.equal(during.filter((c) => c.how === 'whole').length, 0, 'never whole inside a catch-up tick');
    assert.ok(P.stats.runs >= 1 && !P.pending(), 'the first pass is done by the end of the catch-up');
  });
  await t.test('stepped by hand (no clock, nothing owed): whole at once, as before', async (t) => {
    const { f, P, calls } = await world(t);
    for (let i = 0; i < 40 && !P.stats.runs; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); }
    assert.ok(P.stats.runs >= 1, 'the first pass ran');
    assert.equal(calls.find((c) => c.how === 'whole' || c.how === 'slice')?.how, 'whole', 'whole, in one tick');
  });
});
