import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {opSchema, type Diff, type Op} from '@souls/world-compiler';
import {Db} from '../db.ts';
import {GodMode} from './god.ts';
import {commitSoulCompletion} from './soul-completion.ts';
import {fixture, factory} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {installEngineBridge} from './engine-bridge.ts';

const ops = (input: unknown[]): Op[] => input.map(op => opSchema.parse(op));
function setup() {
  const db = new Db(':memory:');
  const god = new GodMode(db, {worldId: 'completion-test', ownerId: 'dev:admin', tick: () => 100, emit() {}});
  const accepted = (result: {accepted: boolean}) => assert.equal(result.accepted, true, JSON.stringify(result));
  accepted(god.act({ops: [
    {op: 'place', def: 'core/garden-planter@2', name: 'progress', p: [5, 0], state: {growth: 1}},
    {op: 'place', def: 'core/bench@1', name: 'god-bench', p: [10, 0]},
  ]}));
  const progress = god.model.get('progress')!.id, bench = god.model.get('god-bench')!.id;
  const mirrored: Diff[] = [];
  const complete = (input: unknown[]) => commitSoulCompletion(god, diff => mirrored.push(diff), ops(input), 'completed Soul work');
  return {db, god, accepted, progress, bench, mirrored, complete};
}

test('completed progress and a new artifact survive God Undo and preserve pending redo across restart', t => {
  const f = setup(); t.after(() => f.db.close());
  f.accepted(f.god.act({ops: [{op: 'move', id: f.bench, p: [12, 0]}]}));
  const authored = f.god.store.undoable()!.seq;
  let admissionCalls = 0;
  f.god.actGuard = () => {admissionCalls++; return {accepted: false, failures: [{op: -1, code: 'test.god-only', detail: 'God admission is not Soul authority'}]};};
  f.accepted(f.complete([{op: 'set', id: f.progress, state: {growth: 2}}]));
  assert.equal(admissionCalls, 0);
  assert.equal(f.god.store.undoable()!.seq, authored, 'completion is not a God edit');
  const undone = f.god.undo(); f.accepted(undone); assert.equal(undone.reverted, authored);
  assert.equal(f.god.model.entities.get(f.progress)!.state!.growth, 2);
  const redo = f.god.store.redoable()!.seq;
  f.accepted(f.complete([{op: 'place', def: 'core/bowl@1', name: 'made-bowl', p: [15, 0]}]));
  const artifact = f.god.model.get('made-bowl')!.id;
  assert.equal(f.god.store.redoable()!.seq, redo, 'creating the artifact does not clear redo');
  assert.equal(f.mirrored.length, 2);
  for (const edit of f.god.store.edits(10).filter(edit => edit.note === 'completed Soul work')) {
    assert.equal(edit.by, 'engine'); assert.equal(edit.kind, 'engine'); assert.deepEqual(edit.inverse, []);
  }
  const again = new GodMode(f.db, {worldId: 'completion-test', ownerId: 'dev:admin', tick: () => 101, emit() {}});
  assert.equal(again.store.redoable()!.seq, redo);
  const redone = again.redo(); f.accepted(redone); assert.equal(redone.reverted, redo);
  assert.equal(again.model.entities.get(f.bench)!.p![0], 12);
  assert.equal(again.model.entities.get(f.progress)!.state!.growth, 2);
  assert.ok(again.model.entities.has(artifact));
  f.accepted(again.undo());
  assert.equal(again.model.entities.get(f.progress)!.state!.growth, 2);
  assert.ok(again.model.entities.has(artifact));
});

test('refused atomic completion changes neither stock, history, redo nor mirroring', t => {
  const f = setup(); t.after(() => f.db.close());
  f.accepted(f.god.act({ops: [{op: 'move', id: f.bench, p: [12, 0]}]}));
  f.accepted(f.god.undo());
  const before = structuredClone(f.god.model.snapshot()), history = f.god.store.edits(20), redo = f.god.store.redoable();
  const result = f.complete([{op: 'set', id: f.progress, state: {growth: 2}}, {op: 'remove', id: 'missing-artifact'}]);
  assert.equal(result.accepted, false);
  assert.deepEqual(f.god.model.snapshot(), before);
  assert.deepEqual(f.god.store.edits(20), history);
  assert.deepEqual(f.god.store.redoable(), redo);
  assert.equal(f.mirrored.length, 0);
  f.accepted(f.complete([{op: 'set', id: f.progress, state: {growth: 2}}]));
  assert.equal(f.mirrored.length, 1, 'a later accepted call has exactly its own notification');
});

test('the production bridge publishes engine provenance and mirrors a completed artifact into native physics', async t => {
  const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false});
  const bridge = installEngineBridge({host: f.host, god, edge, log() {}});
  t.after(() => {f.host.stop(); f.db.close();});
  const settle = async () => {for (let n = 0; n < 4; n++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
  await settle();
  const notifications: string[] = []; god.onCommit(event => notifications.push(event.by));
  const result = bridge.commitSoulWork(ops([{op: 'place', def: 'core/bowl@1', name: 'finished-bowl', p: [10, 0]}]), 'Soul made a bowl');
  assert.equal(result.accepted, true, JSON.stringify(result));
  const id = god.model.get('finished-bowl')!.id;
  assert.deepEqual(notifications, ['engine']);
  await settle();
  const body = f.host.engine.world.entities[id] as {support?: {kind?: string}} | undefined;
  assert.ok(body, 'the same newly committed artifact enters the actual native world');
  assert.equal(body.support?.kind, 'ground');
  assert.equal(god.store.undoable(), null, 'no God undo entry was created');
  assert.equal(god.undo().accepted, false);
  assert.ok(god.model.entities.has(id));
  assert.deepEqual(f.host.engine.runtime.violations, []);
});
