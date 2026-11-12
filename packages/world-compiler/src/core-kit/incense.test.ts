import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_KIT, coreRef } from '../core-kit.ts';
import { WorldModel } from '../model.ts';
import { applyBatch } from '../compile.ts';
import { INCENSE_CENSER_DEF } from './incense.ts';
import { HAND_FIRE } from './hand-fire.ts';

test('incense uses the existing contact fire actions and persistent on state with a real tip and conditional smoke', () => {
  const model = new WorldModel({ constants: { ground: 'land' }, seed: 'incense' });
  assert.equal(CORE_KIT.find(d => d.name === 'core-incense-censer'), INCENSE_CENSER_DEF);
  const original = HAND_FIRE.find(d => d.name === 'core-candle-stand')!.actions!;
  assert.deepEqual(INCENSE_CENSER_DEF.actions!.map((a, i) => ({ ...a, label: original[i].label })), original);
  const def = model.defineDef(INCENSE_CENSER_DEF, 'core', 0);
  assert.equal(applyBatch(model, { ops: [{ op: 'place', def: coreRef('incense-censer', 1), name: 'censer', p: [0, 0] }] }, 'god', 1).result.accepted, true);
  assert.deepEqual(model.get('censer')!.state, { on: false });
  assert.deepEqual(def.params.smokeScale, { type: 'number', default: 0.15, min: 0.1, max: 0.3, doc: 'smoke plume attenuation' });
  const shapes = (def.make.kind === 'gen' ? def.make.args!.shapes : []) as { tint: string; when?: string; at: number[]; role?: string }[];
  const tip = shapes.find(s => s.tint === 'tip')!, contact = shapes.find(s => s.tint === 'valve')!, smoke = shapes.find(s => s.tint === 'smoke')!;
  assert.equal(tip.when, '@on'); assert.equal(smoke.when, '@on');
  assert.ok(Math.hypot(...tip.at.map((v, i) => v - contact.at[i])) < 0.005, 'hand contact is at the actual smoldering tip');
  assert.ok(shapes.every(s => s.role === undefined), 'no artificial role to force unique rendering');
});
