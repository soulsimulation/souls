import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { GodMode } from './god.ts';
import { OUTDOOR_LAPS } from '../../../../packages/world-compiler/src/core-kit/outdoor-laps.ts';
import { createOutdoorLaps } from './outdoor-laps.ts';
import type { EdgeReceipt, EdgeSoul } from '../edge/contract.ts';

function setup(t: { after(fn: () => void): void }) {
  const db = new Db(':memory:'); t.after(() => db.close());
  const god = new GodMode(db, { worldId: 'outdoor-laps-test', ownerId: 'dev:owner', tick: () => 0, emit() {} });
  assert.equal(god.act({ ops: [{ op: 'define', def: OUTDOOR_LAPS }] }).accepted, true);
  assert.equal(god.act({ ops: [{ op: 'place', def: 'core/outdoor-laps@1', name: 'mat', p: [0, 0] }] }).accepted, true);
  const soul: EdgeSoul = { soulId: 's_ana', entityId: 'ana', name: 'Ana', owner: 'dev:ana' };
  const body = { human: {} as { holding?: string }, pose: { p: [0, 0, 2] } };
  let denied = false;
  const service = createOutdoorLaps({ model: god.model, engine: { world: { entities: { ana: body } }, clearanceAtV1: () => 1 }, levelAt: () => 0,
    soul: id => id === soul.soulId ? { id, entity_id: soul.entityId, name: soul.name } : undefined,
    denied: () => denied ? { code: 'object.private', reason: 'This circuit is private.' } : null,
    commit: ops => god.act({ ops }), log() {} });
  const receipt = (id: string, endedTick: number, phase = 'completed') => ({ id, endedTick, phase, soulId: soul.soulId, capability: `object:${god.model.get('mat')!.id}:walk-lap` }) as EdgeReceipt;
  return { god, service, soul, body, receipt, deny: (value: boolean) => { denied = value; }, state: () => god.model.get('mat')!.state! };
}

test('completion records are idempotent, monotonic and independent of later interruption', t => {
  const f = setup(t), { service, receipt } = f;
  for (const phase of ['accepted', 'started', 'cancelled', 'replaced', 'failed']) service.onReceipt(receipt('r_ignored', 10, phase));
  assert.equal(f.state().lastReceipt, '');
  service.onReceipt(receipt('r_b', 20)); assert.equal(f.state().completedLaps, 1); const saved = { ...f.state() }, seq = f.god.model.editSeq;
  for (const r of [receipt('r_b', 20), receipt('r_older', 19), receipt('r_a', 20), receipt('r_cancel', 21, 'cancelled')]) service.onReceipt(r);
  assert.deepEqual(f.state(), saved); assert.equal(f.god.model.editSeq, seq);
  service.onReceipt(receipt('r_c', 40)); assert.equal(f.state().lastReceipt, 'r_c'); assert.equal(f.state().completedLaps, 2);
  assert.match(service.facts(f.god.model.get('mat')!.id)!.practice, /Ana.*tick 40/);
  const plan = service.plan(f.soul, f.god.model.get('mat')!.id, 'walk-lap'); assert.ok(plan && 'steps' in plan);
  assert.deepEqual(plan.steps.map(x=>x.verb),['stand',...Array(6).fill('mars:walk_to'),'stand']);
  assert.deepEqual(plan.steps.slice(1,7).map(x=>[(x.params as Record<string,unknown>).x,(x.params as Record<string,unknown>).z]),[[0,-2],[-3,-2],[-3,2],[3,2],[3,-2],[0,-2]]);
  assert.ok(plan.steps.slice(2,7).every(x=>(x.params as Record<string,unknown>).gait==='walk'));
  const jog=service.plan(f.soul,f.god.model.get('mat')!.id,'jog-lap');assert.ok(jog&&'steps'in jog);assert.ok(jog.steps.slice(2,7).every(x=>(x.params as Record<string,unknown>).gait==='jog'));

});

test('access loss, missing actor, changed or removed marker and invalid endings cannot write completion', t => {
  const f = setup(t), id = f.god.model.get('mat')!.id;
  f.deny(true); assert.equal((f.service.plan(f.soul, id, 'walk-lap') as { code: string }).code, 'object.private'); f.service.onReceipt(f.receipt('r_denied', 30)); assert.equal(f.state().lastReceipt, '');
  f.deny(false); f.body.human.holding = 'cup'; assert.equal((f.service.plan(f.soul, id, 'walk-lap') as { code: string }).code, 'object.state'); delete f.body.human.holding;
  for (const endedTick of [NaN, Infinity, -1, 1.5]) f.service.onReceipt(f.receipt('r_invalid', endedTick));
  f.service.onReceipt({ ...f.receipt('r_foreign', 30), soulId: 'missing' }); assert.equal(f.state().lastReceipt, '');
  const entity = f.god.model.entities.get(id)!, originalDef = entity.def; entity.def = 'core/rug@1';
  f.service.onReceipt(f.receipt('r_changed', 30)); assert.equal(f.state().lastReceipt, ''); entity.def = originalDef;
  const ended = f.receipt('r_gone', 30);
  assert.equal(f.god.act({ ops: [{ op: 'remove', id }] }).accepted, true);
  f.service.onReceipt(ended); assert.equal(f.service.facts(id), null);
  assert.equal(f.god.act({ ops: [{ op: 'place', def: 'core/rug@1', name: 'mat', p: [0, 0] }] }).accepted, true);
  f.service.onReceipt({ ...ended, capability: `object:${f.god.model.get('mat')!.id}:walk-lap` }); assert.equal(f.god.model.get('mat')!.state?.lastReceipt, undefined);
});


test('waypoints and current dimensions follow a translated rotated and scaled course',t=>{
 const f=setup(t),id=f.god.model.get('mat')!.id;
 for(const scale of[2,.5]){
  assert.equal(f.god.act({ops:[{op:'move',id,p:[7,-5],r:Math.PI/2,s:scale}]}).accepted,true);
  const plan=f.service.plan(f.soul,id,'walk-lap');assert.ok(plan&&'steps'in plan);
  const expected=[[7-2*scale,-5],[7-2*scale,-5+3*scale],[7+2*scale,-5+3*scale],[7+2*scale,-5-3*scale],[7-2*scale,-5-3*scale],[7-2*scale,-5]];
  assert.deepEqual(plan.steps.slice(1,7).map(x=>[(x.params as Record<string,number>).x,(x.params as Record<string,number>).z].map(n=>Math.round(n*1e6)/1e6)),expected);
  assert.ok(f.service.facts(id)!.practice.includes(`${6*scale} by ${4*scale} metre`));
 }
});
