import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { GodMode } from './god.ts';
import { EXERCISE_CIRCUIT } from '../../../../packages/world-compiler/src/core-kit/exercise-circuit.ts';
import { createExerciseCircuit, type ExerciseCircuitHost } from './exercise-circuit.ts';
import type { EdgeReceipt, EdgeSoul } from '../edge/contract.ts';

function setup(t: { after(fn: () => void): void }) {
  const db = new Db(':memory:'); t.after(() => db.close());
  const god = new GodMode(db, { worldId: 'exercise-circuit-test', ownerId: 'dev:owner', tick: () => 0, emit() {} });
  assert.equal(god.act({ ops: [{ op: 'define', def: EXERCISE_CIRCUIT }] }).accepted, true);
  assert.equal(god.act({ ops: [{ op: 'place', def: 'core/exercise-circuit@1', name: 'mat', p: [0, 0] }] }).accepted, true);
  const soul: EdgeSoul = { soulId: 's_ana', entityId: 'ana', name: 'Ana', owner: 'dev:ana' };
  const body = { human: {} as { holding?: string }, pose: { p: [0, 0, 2] } };
  let denied = false, refused = false;
  const host: ExerciseCircuitHost = { model: god.model, engine: { world: { entities: { ana: body } }, clearanceAtV1: () => 1 }, levelAt: () => 0,
    soul: id => id === soul.soulId ? { id, entity_id: soul.entityId, name: soul.name } : undefined,
    denied: () => denied ? { code: 'object.private', reason: 'This circuit is private.' } : null,
    commit: ops => refused ? { accepted: false } : god.act({ ops }), log() {} };
  const service = createExerciseCircuit(host);
  const receipt = (id: string, endedTick: number, phase = 'completed') => ({ id, endedTick, phase, soulId: soul.soulId, capability: `object:${god.model.get('mat')!.id}:exercise` }) as EdgeReceipt;
  return { god, service, soul, body, receipt, recreate: () => createExerciseCircuit(host), refuse: (value: boolean) => { refused = value; }, deny: (value: boolean) => { denied = value; }, state: () => god.model.get('mat')!.state! };
}

test('completion records are idempotent, monotonic and independent of later interruption', t => {
  const f = setup(t), { service, receipt } = f;
  for (const phase of ['accepted', 'started', 'cancelled', 'replaced', 'failed']) service.onReceipt(receipt('r_ignored', 10, phase));
  assert.equal(f.state().lastReceipt, '');
  service.onReceipt(receipt('r_b', 20)); assert.equal(f.state().completedRounds, 1); const saved = { ...f.state() }, seq = f.god.model.editSeq;
  for (const r of [receipt('r_b', 20), receipt('r_older', 19), receipt('r_cancel', 21, 'cancelled')]) service.onReceipt(r);
  assert.deepEqual(f.state(), saved); assert.equal(f.god.model.editSeq, seq);
  service.onReceipt(receipt('r_c', 40)); assert.equal(f.state().lastReceipt, 'r_c'); assert.equal(f.state().completedRounds, 2);
  assert.match(service.facts(f.god.model.get('mat')!.id)!.practice, /Ana.*tick 40/);
  const plan = service.plan(f.soul, f.god.model.get('mat')!.id, 'exercise'); assert.ok(plan && 'steps' in plan);
  assert.deepEqual(plan.steps.map(x => x.verb), ['stand', 'mars:walk_to', 'mars:pose_v1', 'mars:pose_v1', 'mars:pose_v1', 'stand']);
  assert.deepEqual(plan.steps.filter(x => x.verb === 'mars:pose_v1').map(x => [x.params.activity, x.params.seconds]), [['stretch', 5], ['jumping-jacks', 10], ['stretch', 5]]);
});

test('access loss, missing actor, changed or removed marker and invalid endings cannot write completion', t => {
  const f = setup(t), id = f.god.model.get('mat')!.id;
  f.deny(true); assert.equal((f.service.plan(f.soul, id, 'exercise') as { code: string }).code, 'object.private'); f.service.onReceipt(f.receipt('r_denied', 30)); assert.equal(f.state().lastReceipt, '');
  f.deny(false); f.body.human.holding = 'cup'; assert.equal((f.service.plan(f.soul, id, 'exercise') as { code: string }).code, 'object.state'); delete f.body.human.holding;
  for (const endedTick of [NaN, Infinity, -1, 1.5]) f.service.onReceipt(f.receipt('r_invalid', endedTick));
  f.service.onReceipt({ ...f.receipt('r_foreign', 30), soulId: 'missing' }); assert.equal(f.state().lastReceipt, '');
  const entity = f.god.model.entities.get(id)!, originalDef = entity.def; entity.def = 'core/rug@1';
  f.service.onReceipt(f.receipt('r_changed', 30)); assert.equal(f.state().lastReceipt, ''); entity.def = originalDef;
  const ended = f.receipt('r_gone', 30);
  assert.equal(f.god.act({ ops: [{ op: 'remove', id }] }).accepted, true);
  f.service.onReceipt(ended); assert.equal(f.service.facts(id), null);
  assert.equal(f.god.act({ ops: [{ op: 'place', def: 'core/rug@1', name: 'mat', p: [0, 0] }] }).accepted, true);
  f.service.onReceipt({ ...ended, capability: `object:${f.god.model.get('mat')!.id}:exercise` }); assert.equal(f.god.model.get('mat')!.state?.lastReceipt, undefined);
});


test('opaque IDs count distinct same-tick completions, deduplicate history and retry refused commits', t => {
  for (const ids of [['r_z', 'r_a'], ['r_9', 'r_10']]) {
    const f = setup(t), tick = 20;
    for (const id of ids) f.service.onReceipt(f.receipt(id, tick));
    assert.equal(f.state().completedRounds, 2, 'ID spelling is not completion order');
    const seq = f.god.model.editSeq;
    for (const id of [...ids, ...ids].reverse()) f.service.onReceipt(f.receipt(id, tick));
    f.service.onReceipt(f.receipt('new-but-older', tick - 1));
    assert.equal(f.state().completedRounds, 2);
    assert.equal(f.god.model.editSeq, seq, 'same-tick duplicate history is inert');
    f.service.onReceipt(f.receipt('r_0', 100));
    assert.equal(f.state().completedRounds, 3, 'numeric ticks govern monotonicity');
    f.service.onReceipt(f.receipt('r_later-spelling', 21));
    assert.equal(f.state().completedRounds, 3);
    f.refuse(true); f.service.onReceipt(f.receipt('r_retry', 100));
    assert.equal(f.state().completedRounds, 3);
    f.refuse(false); f.service.onReceipt(f.receipt('r_retry', 100));
    assert.equal(f.state().completedRounds, 4, 'refusal does not mark the ID seen');
    f.service.onReceipt(f.receipt('r_0', 100));
    assert.equal(f.state().completedRounds, 4);
    const recreated = f.recreate();
    recreated.onReceipt(f.receipt('r_retry', 100));
    assert.equal(f.state().completedRounds, 4, 'persisted latest receipt seeds duplicate protection');
    recreated.onReceipt(f.receipt('r_distinct', 100));
    recreated.onReceipt(f.receipt('r_retry', 100));
    assert.equal(f.state().completedRounds, 5);
  }
});
