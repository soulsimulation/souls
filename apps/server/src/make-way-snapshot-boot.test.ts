// #1368: a world checkpointed while an act waits out a make-way nudge boots from that snapshot. Before the fix the restore
// threw `snapshot.waiting-invalid` ("waiting directive … has invalid graph provenance"), so the world could not boot at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {marsFactory} from '@souls/engine-mars';
import {Db} from './db.ts';
import {WorldHost} from './world.ts';

test('#1368 a world saved while an act waits behind a make-way nudge boots from its snapshot and steps on identically', async () => {
  const factory = await marsFactory();
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'souls-makeway-')), 'world.db'));
  const h = new WorldHost(db, factory, 'makeway', 1e9); h.boot();
  void h.enqueue('birth', 'test', {soulId: 'sa', entityId: 'a', name: 'Ada', description: 'test', owner: 'owner'});
  void h.enqueue('birth', 'test', {soulId: 'sb', entityId: 'b', name: 'Bo', description: 'test', owner: 'owner'});
  for (let i = 0; i < 40; i++) h.tickOnce();
  // a courtesy step-aside on Bo (walk.ts makeWay's id shape), then a walk for Bo, which waits the nudge out (M03)
  const rt = (h.engine as unknown as {rt: {submit(v: string, p: unknown, o?: {id?: string}): {id: string; status: string; phase?: string}; records: Map<string, {status: string}>}}).rt;
  const [x, , z] = (h.engine.world.entities as Record<string, {pose: {p: number[]}}>).b.pose.p;
  const nudge = rt.submit('walk_to', {actor: 'b', x: x + 1.2, z}, {id: 'b:make-way:41'}); assert.equal(nudge.status, 'executing');
  const walk = rt.submit('walk_to', {actor: 'b', x: x - 3, z}); assert.equal(walk.phase, 'make-way', 'the walk waits the nudge out');
  h.tickOnce(); assert.equal(rt.records.get(walk.id)!.status, 'requested', 'still waiting at the checkpoint');
  h.saveSnapshot(true);
  const booted = new WorldHost(db, factory, 'makeway', 1e9);
  assert.equal(booted.boot().from, 'snapshot', 'boots from the snapshot');
  assert.equal(booted.engine.stateHash(), h.engine.stateHash());
  for (let i = 0; i < 200; i++) {h.tickOnce(); booted.tickOnce();}
  assert.equal(booted.engine.stateHash(), h.engine.stateHash(), 'and steps on identically');
  const brt = (booted.engine as unknown as {rt: {records: Map<string, {status: string}>}}).rt;
  assert.equal(brt.records.get(walk.id)!.status, 'completed', 'the waiting walk ran once the nudge ended');
  h.stop(); booted.stop(); db.close();
});
