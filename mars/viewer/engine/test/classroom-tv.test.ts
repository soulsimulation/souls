// classroom-tv/1 (#2302): a classroom display marked a TV once; a body in the room switches it and changes its picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Runtime } from '../runtime/runtime.ts';
import { Spatial } from '../spatial/service.ts';
import { provingGround } from '../scenes/proving-ground.ts';
import { addAll, emptyWorld, FIXTURE, human } from '../world/factory.ts';
import type { Entity } from '../world/types.ts';
import type { ActionDef } from '../actions/types.ts';
import { OBJECT_ACTIONS, TV_PICTURES, classroomDisplayClear, classroomDisplayFocus, classroomTvMigrate } from '../objects/classroom.ts';

const screen = (): Entity => ({ id: 'screen', def: 'standing-display', kind: 'fixture', pose: { p: [-5, 0, 5], yaw: 0 }, provenance: FIXTURE, equipment: { kind: 'display', config: { available: true, mode: 'on', content: 'Eden lesson' } } });
const session: ActionDef<{ display: string }, null, null> = {
  verb: 'test_session', description: 'test display holder', schema: z.strictObject({ display: z.string() }),
  reservations: (_w, p) => [{ resource: `display:${p.display}`, mode: 'exclusive' }],
  plan: () => ({ ok: true, program: null }), start: () => null, step: () => ({ status: 'running' }), cancel: () => ({ ok: true }),
};
function setup(...entities: Entity[]) {
  const base = provingGround(), world = addAll(emptyWorld('classroom-tv', base), ...entities);
  return new Runtime(world, new Map<string, ActionDef>([...OBJECT_ACTIONS.map((a) => [a.verb, a] as [string, ActionDef]), [session.verb, session]]), { spatial: new Spatial(base) }, []);
}
const tv = (rt: Runtime, op: string, actor = 'ana') => { const r = rt.submit('classroom_tv', { actor, display: 'screen', op }); if (r.status === 'executing') rt.step(); return r; };
const cfg = (rt: Runtime) => rt.world.entities.screen.equipment!.config;

test('classroom-tv/1: a display is a TV only once migrated; migration keeps mode and lesson and is idempotent', () => {
  const rt = setup(screen(), human('ana', -4, 3));
  assert.equal(tv(rt, 'on').diagnostic?.code, 'display.not-a-tv');
  assert.equal(classroomTvMigrate(rt.world.entities.screen), true);
  assert.deepEqual(cfg(rt), { available: true, mode: 'on', content: 'Eden lesson', tv: true, picture: 'lesson' });
  const h = rt.stateHash();
  assert.equal(classroomTvMigrate(rt.world.entities.screen), false);
  assert.equal(rt.stateHash(), h);
  assert.equal(classroomTvMigrate(rt.world.entities.ana), false, 'a body is no display');
});

test('classroom-tv/1: off, on, the five pictures in order, off; refused off, out of reach, or while a class holds it', () => {
  const rt = setup(screen(), human('ana', -4, 3), human('far', 30, 30));
  classroomTvMigrate(rt.world.entities.screen);
  assert.equal(tv(rt, 'off').status, 'completed'); assert.equal(cfg(rt).mode, 'off');
  assert.equal(tv(rt, 'next').diagnostic?.code, 'display.off');
  assert.equal(tv(rt, 'on', 'far').diagnostic?.code, 'display.out-of-reach');
  assert.equal(tv(rt, 'on').status, 'completed'); assert.equal(cfg(rt).mode, 'on'); assert.equal(cfg(rt).picture, 'lesson');
  const seen: unknown[] = [];
  for (let i = 0; i < TV_PICTURES.length; i++) { assert.equal(tv(rt, 'next').status, 'completed'); seen.push(cfg(rt).picture); }
  assert.deepEqual(seen, ['garden', 'sea', 'stars', 'test-card', 'lesson']);
  assert.equal(tv(rt, 'next').status, 'completed'); assert.equal(cfg(rt).picture, 'garden');
  // a running class holds the display: the TV act is refused and the class's lesson goes on the screen
  const cls = rt.submit('test_session', { display: 'screen' });
  assert.ok(['reservation.conflict', 'display.in-class'].includes(tv(rt, 'off').diagnostic?.code ?? ''));
  assert.equal(classroomDisplayFocus(rt, { session: cls.id, displayId: 'screen', phase: 'presenting', content: 'Tonight: soil' }), null);
  assert.equal(cfg(rt).picture, 'lesson'); assert.equal(cfg(rt).content, 'Tonight: soil'); assert.equal(cfg(rt).mode, 'on');
  assert.equal(classroomDisplayClear(rt, cls.id, 'screen'), null); rt.cancel(cls.id);
  assert.equal(tv(rt, 'on').status, 'completed'); assert.equal(cfg(rt).picture, 'lesson');
  assert.equal(tv(rt, 'off').status, 'completed'); assert.equal(cfg(rt).mode, 'off');
});

test('classroom-tv/1: a display that is no TV keeps its exact bytes under a class and the director control', () => {
  const rt = setup(screen());
  const cls = rt.submit('test_session', { display: 'screen' });
  classroomDisplayFocus(rt, { session: cls.id, displayId: 'screen', phase: 'presenting', content: 'x' });
  assert.equal('picture' in cfg(rt), false);
  classroomDisplayClear(rt, cls.id, 'screen'); rt.cancel(cls.id);
  const d = rt.submit('display_control', { display: 'screen', mode: 'on', content: 'y' }); rt.step();
  assert.equal(d.status, 'completed'); assert.equal('picture' in cfg(rt), false);
});
