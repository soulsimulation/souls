import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_KIT, coreRef } from '../core-kit.ts';
import { WorldModel } from '../model.ts';
import { applyBatch } from '../compile.ts';
import { MURAL_PANEL_DEF } from './mural-panel.ts';

test('mural panel opts into the painting faculty with reachable media, surface words and owner-bound permission', () => {
  assert.equal(CORE_KIT.find(d => d.name === 'core-mural-panel' && d.version === 1), MURAL_PANEL_DEF);
  const model = new WorldModel({ constants: { ground: 'land' }, seed: 'mural-panel' });
  const def = model.defineDef(MURAL_PANEL_DEF, 'core', 0);
  assert.equal(def.components.workstation?.kind, 'painting');
  assert.deepEqual(def.components.display, { w: 1.2, h: 1.2 });
  assert.equal(def.make.kind, 'gen');
  const face = (def.make.kind === 'gen' ? def.make.args!.faces : []) as { at: number[]; h: number; w: number; media: boolean; ownerBound: boolean; paintLabel: string; paintNoun: string }[];
  assert.equal(face.length, 1); assert.equal(face[0].w, face[0].h); assert.equal(face[0].media, true);
  assert.ok(face[0].at[1] - face[0].h / 2 >= 0.5); assert.ok(face[0].at[1] + face[0].h / 2 <= 2);
  assert.equal(face[0].ownerBound, true); assert.equal(face[0].paintLabel, 'Paint a mural'); assert.equal(face[0].paintNoun, 'mural');
  const placed = applyBatch(model, { ops: [{ op: 'place', def: coreRef('mural-panel', 1), name: 'wall', p: [0, 0] }] }, 'god', 1);
  assert.equal(placed.result.accepted, true, JSON.stringify(placed.result));
  assert.equal(model.get('wall')!.owner, undefined, 'unowned means explicitly public');
  assert.deepEqual(model.get('wall')!.state, { media: '', title: '', maker: '' });
});
