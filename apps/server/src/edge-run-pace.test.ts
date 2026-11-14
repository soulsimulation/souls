// #2283: Souls can run. `pace: "run"` on walk-to:here (and a walk) is the same engine walk_to at the run gait: the body
// publishes activity 'run', covers ground faster than the walking cap, arrives, and breaks no invariant. The same
// world and the same act give the same ticks and the same end pose (deterministic). A pace on anything but a walk, or a
// pace that is not walk or run, is refused and the body stays put. Running costs more energy than walking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { advanceNeeds, newLife } from '@souls/brain';
import { coreRef } from '@souls/world-compiler';
import { fixture, invite, accept, factory } from '../test/native-owner-fixture.ts';
import { GodMode } from './god/god.ts';
import { installEngineBridge } from './god/engine-bridge.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { paramsProblem, paramsByVerb } from './edge/intents/offer-schema.ts';
import { WALK_SPEED_CAP } from '../../../mars/viewer/engine/locomotion/walk.ts';
import { existsSync } from 'node:fs';
import { bootEden } from '../test/eden-capabilities-timing.ts';

const EDEN = new URL('../../../worlds/templates/eden-2026.json', import.meta.url);

type Act = { accepted?: boolean; code?: string; reason?: string; receipt?: { id: string; capability: string } };

async function boot() {
  const w = fixture(':memory:'); w.brain.quiesce();
  const edge = new EdgeLedger(w.host, w.db);
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  await settle(3);
  await invite(w, 'ana'); const row: any = await accept(w.host, w.souls.create('dev:ana', { name: 'Ana', description: 'curious' })); await settle(3);
  const soul = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner };
  const close = () => { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); };
  return { w, edge, soul, settle, close, body: () => w.host.engine.world.entities[soul.entityId]! };
}

/** Walk-to [x+dx, z] at a pace; the activities seen, the fastest step (m/s), ticks taken and the end pose. */
async function walkTo(pace: 'walk' | 'run', dx = 12) {
  const b = await boot();
  try {
    const p0 = b.body().pose.p, at: [number, number] = [p0[0] + dx, p0[2]];
    const out = await accept(b.w.host, Promise.resolve(b.edge.act(b.soul, { capability: 'walk-to:here', params: { at, pace } }))) as Act;
    assert.equal(out.accepted, true, JSON.stringify(out));
    const seen = new Set<string>(), t0 = b.w.host.engine.world.tick;
    let phase = 'accepted', fastest = 0, prev = b.body().pose.p;
    while (['accepted', 'waiting', 'started'].includes(phase) && b.w.host.engine.world.tick - t0 < 60 * 20) {
      await b.settle(1);
      const p = b.body().pose.p; fastest = Math.max(fastest, Math.hypot(p[0] - prev[0], p[2] - prev[2]) * 20); prev = p;
      seen.add(b.body().human!.activity);
      phase = b.edge.receipt(b.soul.soulId, out.receipt!.id)!.phase;
    }
    const end = b.body().pose.p;
    return { phase, seen, fastest, ticks: b.w.host.engine.world.tick - t0, end: [end[0], end[1], end[2]], off: Math.hypot(end[0] - at[0], end[2] - at[1]), violations: b.w.host.engine.runtime.violations };
  } finally { b.close(); }
}

test('#2283 A1/A2: walk-to:here at pace run runs (activity run, faster than walking), arrives, and is deterministic', { timeout: 300_000 }, async () => {
  const walk = await walkTo('walk'), run = await walkTo('run'), again = await walkTo('run');
  for (const r of [walk, run]) { assert.equal(r.phase, 'completed', JSON.stringify(r)); assert.ok(r.off <= 1, `ended ${r.off.toFixed(2)} m off`); assert.deepEqual(r.violations, []); }
  assert.ok(run.seen.has('run') && !walk.seen.has('run'), `run seen: ${[...run.seen]}; walk seen: ${[...walk.seen]}`);
  assert.ok(run.fastest > WALK_SPEED_CAP + 0.1 && walk.fastest <= WALK_SPEED_CAP * 1.05, `fastest run ${run.fastest.toFixed(2)}, walk ${walk.fastest.toFixed(2)} m/s`);
  assert.ok(run.ticks < walk.ticks, `run ${run.ticks} ticks, walk ${walk.ticks}`);
  assert.deepEqual({ ticks: again.ticks, end: again.end }, { ticks: run.ticks, end: run.end }, 'same act, same world: same ticks and end pose');
});

test('#2283 A1: a pace that is not walk or run, or a pace on anything but a walk, is refused and the body stays put', { timeout: 120_000 }, async () => {
  const b = await boot();
  try {
    const p0 = b.body().pose.p, at: [number, number] = [p0[0] + 5, p0[2]];
    const bad = await accept(b.w.host, Promise.resolve(b.edge.act(b.soul, { capability: 'walk-to:here', params: { at, pace: 'sprint' } }))) as Act;
    assert.equal(bad.accepted, false); assert.equal(bad.code, 'capability.params', JSON.stringify(bad));
    const wave = await accept(b.w.host, Promise.resolve(b.edge.act(b.soul, { capability: 'wave:here', params: { pace: 'run' } }))) as Act;
    assert.equal(wave.accepted, false); assert.equal(wave.code, 'capability.params', JSON.stringify(wave));
    await b.settle(10); const p1 = b.body().pose.p;
    assert.deepEqual([p1[0], p1[2]], [p0[0], p0[2]], 'the body never moved');
  } finally { b.close(); }
});

test('#2283 A1: pace is in the walk and walk-to schemas (walk or run), and checked', () => {
  const by = paramsByVerb(['walk', 'walk-to']);
  assert.deepEqual(by.walk!.pace!.enum, ['walk', 'run']); assert.deepEqual(by['walk-to']!.pace!.enum, ['walk', 'run']);
  assert.equal(paramsProblem({ id: 'walk:mill', verb: 'walk' }, { pace: 'run' }), null);
  assert.equal(paramsProblem({ id: 'walk-to:here', verb: 'walk-to' }, { at: [1, 2], pace: 'run' }), null);
  assert.match(String(paramsProblem({ id: 'walk:mill', verb: 'walk' }, { pace: 'fly' })), /pace must be/);
});

test('#2283 A3: running spends energy faster than walking', () => {
  const walk = newLife(0), run = newLife(0);
  advanceNeeds(walk, 7200, 'walk', false); advanceNeeds(run, 7200, 'run', false);
  assert.ok(run.needs.energy < walk.needs.energy, `run ${run.needs.energy}, walk ${walk.needs.energy}`);
});

test('#2283 A1/A2 (review): walk:<place> at pace run runs the walk\'s own route and arrives', { timeout: 300_000 }, async () => {
  const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(w.host, w.db); installEngineBridge({ host: w.host, god, edge, log() {}, worldClock: false, worldLore: false });
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  try {
    const built = god.act({ ops: [{ op: 'place', def: coreRef('pavilion'), name: 'bandstand', p: [18, 6] }] });
    assert.equal(built.accepted, true, JSON.stringify(built)); await settle();
    await invite(w, 'ana'); const row: any = await accept(w.host, w.souls.create('dev:ana', { name: 'Ana', description: 'curious' })); await settle(3);
    const soul = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner }, body = () => w.host.engine.world.entities[soul.entityId]!;
    const walk = edge.capabilities(soul).find(c => c.verb === 'walk' && c.available && /bandstand/.test(c.id));
    assert.ok(walk, 'a walk to the bandstand is offered');
    const out = await accept(w.host, Promise.resolve(edge.act(soul, { capability: walk!.id, params: { pace: 'run' } }))) as Act;
    assert.equal(out.accepted, true, JSON.stringify(out));
    const seen = new Set<string>(), t0 = w.host.engine.world.tick; let phase = 'accepted';
    while (['accepted', 'waiting', 'started'].includes(phase) && w.host.engine.world.tick - t0 < 60 * 20) { await settle(1); seen.add(body().human!.activity); phase = edge.receipt(soul.soulId, out.receipt!.id)!.phase; }
    assert.equal(phase, 'completed'); assert.ok(seen.has('run'), `seen: ${[...seen]}`);
    assert.deepEqual(w.host.engine.runtime.violations, []);
  } finally { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); }
});

test('#2283 (clip finding): a run to a room upstairs runs its indoor and upstairs legs too (mars:walk_to carries the gait)', { timeout: 300_000, skip: existsSync(EDEN) ? false : 'needs worlds/templates/eden-2026.json' }, async (t) => {
  const w = await bootEden(); t.after(() => w.close());
  const out = await accept(w.host, Promise.resolve(w.edge.act(w.soul, { capability: 'walk:region-campus-east-hall/classroom-1', params: { pace: 'run' } }))) as Act;
  assert.equal(out.accepted, true, JSON.stringify(out)); await w.settle(2);
  const plan = JSON.parse((w.db.db.prepare('SELECT plan FROM edge_receipts_v1 WHERE receipt_id=?').get(out.receipt!.id) as { plan: string }).plan) as { steps: { verb: string; params: { gait?: string; level?: number } }[] };
  const walks = plan.steps.filter(s => s.verb === 'walk_to' || s.verb === 'mars:walk_to');
  assert.ok(walks.some(s => s.verb === 'mars:walk_to' && s.params.level), `a leg on the upper floor: ${JSON.stringify(plan.steps)}`);
  assert.ok(walks.every(s => s.params.gait === 'run'), `every walk leg runs: ${JSON.stringify(plan.steps)}`);
});
