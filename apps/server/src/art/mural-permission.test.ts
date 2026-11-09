import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldModel, coreRef } from '@souls/world-compiler';
import { Db } from '../db.ts';
import { GodMode } from '../god/god.ts';
import { paintingLine, planHang, type ArtFailure } from './art.ts';
import { createPaintingService, type PaintingIntent } from './painting-completion.ts';

const ana = { soulId: 's_ana', entityId: 'h_aaaa', name: 'Ana', owner: 'dev:ana' };
const ben = { soulId: 's_ben', entityId: 'h_bbbb', name: 'Ben', owner: 'dev:ben' };
const picture = { title: 'Garden', background: '#374c38', shapes: [{ kind: 'ellipse', cx: 0.5, cy: 0.45, rx: 0.2, ry: 0.2, colour: '#ffd23f' }] };
const caller = (s: typeof ana) => ({ kind: 'soul' as const, id: s.soulId, name: s.name });

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mural-permission-')), db = new Db(join(dir, 'world.db'));
  const god = new GodMode(db, { worldId: 'mural-test', ownerId: 'dev:admin', tick: () => 1, emit() {}, assetDir: dir });
  assert.equal(god.act({ ops: [
    { op: 'place', def: coreRef('mural-panel', 1), name: 'public-wall', p: [0, 0] },
    { op: 'place', def: coreRef('mural-panel', 1), name: 'own-wall', p: [4, 0], owner: 'soul:s_ana' },
    { op: 'place', def: coreRef('mural-panel', 1), name: 'other-wall', p: [8, 0], owner: 'soul:s_ben' },
    { op: 'place', def: coreRef('mural-panel', 1), name: 'group-wall', p: [12, 0], owner: 'group:artists' },
  ] }).accepted, true);
  const service = createPaintingService({ model: () => god.model, dir, basePath: '/w/mural-test', worldId: 'mural-test', commit: (ops, note, done, durable) => god.engineAct(ops, note, done, durable) });
  const id = (name: string) => god.model.get(name)!.id;
  const prepare = (name: string, soul = ana, recipe = picture) => service.prepare(soul, id(name), recipe);
  const pngs = () => readdirSync(dir).filter(f => f.endsWith('.png'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, god, service, id, prepare, pngs };
}

test('public and owned murals reuse completion, provenance, replacement history and persistence; foreign owners refuse before rendering', t => {
  const w = setup(t);
  for (const name of ['other-wall', 'group-wall']) {
    const result = w.prepare(name) as ArtFailure;
    assert.equal(result.code, 'art.not-yours'); assert.match(result.message, new RegExp(name));
  }
  assert.deepEqual(w.pngs(), []);
  for (const name of ['public-wall', 'own-wall']) {
    const intent = w.prepare(name); assert.ok(!('ok' in intent), JSON.stringify(intent));
    assert.equal(w.service.complete(ana, `r_${name}`, intent as PaintingIntent, () => {}).ok, true);
    const e = w.god.model.get(name)!;
    assert.equal(e.state!.maker, 'soul:s_ana:Ana'); assert.equal(e.state!.title, 'Garden');
    assert.equal(paintingLine(e, w.god.model.resolvedDef(e.def)), 'Ana’s mural “Garden”');
  }
  const before = { ...w.god.model.get('public-wall')!.state };
  const next = w.prepare('public-wall', ben, { ...picture, title: 'Dawn' }); assert.ok(!('ok' in next));
  assert.equal(w.service.complete(ben, 'r_repaint', next as PaintingIntent, () => {}).ok, true);
  const note = w.god.store.edits(20).find(e => e.note?.includes('r_repaint'))!.note!;
  assert.deepEqual(JSON.parse(note.slice('painting/1 '.length)).previous, before);
  const restored = WorldModel.fromSnapshot(JSON.parse(JSON.stringify(w.god.model.snapshot())), undefined, w.god.model.library);
  assert.deepEqual(restored.get('public-wall')!.state, w.god.model.get('public-wall')!.state);
  const denied = planHang(w.god.model, caller(ana), { frame: w.id('other-wall'), media: '/picture.png' }) as ArtFailure;
  assert.equal(denied.code, 'art.not-yours', 'general hang cannot bypass owner-bound painting permission');
  assert.equal((planHang(w.god.model, caller(ana), { frame: w.id('public-wall'), media: '/picture.png' }) as ArtFailure).code, 'art.drawn-only');
  assert.equal(planHang(w.god.model, { kind: 'creator', owner: 'dev:admin' }, { frame: w.id('own-wall'), media: null }).ok, true);
});

test('ownership changes, movement, wrong level and duplicate completion preserve the mural and publish no extra files', t => {
  const w = setup(t), intent = w.prepare('own-wall'); assert.ok(!('ok' in intent));
  assert.equal(w.god.act({ ops: [{ op: 'set', id: w.id('own-wall'), owner: 'soul:s_ben' }] }).accepted, true);
  assert.equal((w.service.complete(ana, 'r_changed', intent as PaintingIntent, () => assert.fail()) as ArtFailure).code, 'painting.target-changed');
  assert.equal((w.prepare('own-wall') as ArtFailure).code, 'art.not-yours'); assert.deepEqual(w.pngs(), []);
  const publicIntent = w.prepare('public-wall') as PaintingIntent;
  assert.equal(w.service.reached(publicIntent, { position: [0, 0, 0.6], level: 0, scale: 1 }), null);
  assert.equal(w.service.reached(publicIntent, { position: [0, 0, 0.6], level: 1, scale: 1 })!.code, 'painting.not-reached');
  assert.equal(w.service.reached(publicIntent, { position: [4, 0, 0.6], level: 0, scale: 1 })!.code, 'painting.not-reached');
  assert.equal(w.service.complete(ana, 'r_once', publicIntent, () => {}).ok, true);
  const before = { ...w.god.model.get('public-wall')!.state };
  assert.equal((w.service.complete(ana, 'r_once', publicIntent, () => assert.fail()) as ArtFailure).code, 'painting.target-changed');
  const moved = w.prepare('public-wall') as PaintingIntent;
  assert.equal(w.god.act({ ops: [{ op: 'move', id: w.id('public-wall'), p: [1, 0] }] }).accepted, true);
  assert.equal(w.service.reached(moved, { position: [1, 0, 0.6], level: 0, scale: 1 })!.code, 'painting.target-changed');
  assert.equal((w.service.complete(ana, 'r_moved', moved, () => assert.fail()) as ArtFailure).code, 'painting.target-changed');
  assert.deepEqual(w.god.model.get('public-wall')!.state, before); assert.equal(w.pngs().length, 1);
});
