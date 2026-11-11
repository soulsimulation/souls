// Legal by construction 1a (#2134): a god world-edit previewed on a detached copy names the bodies it would break a rule
// on, and the rule, and changes nothing live. The payloads are the bridge's own: a twin world without the Soul builds
// them (the same genesis), and each is previewed on the Soul's world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { GREEN_FIELD_WORLD, type WorldEditV1 } from '@souls/engine-mars';
import { fixture, invite, accept, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { detachedEngineV1, previewWorldEditOffThreadV1, previewWorldEditV1 } from './edit-preview.ts';
import { describedFactoryV1 } from '../world-factory.ts';

// #2140: the off-thread path rebuilds this factory in its worker from the descriptor
describedFactoryV1(factory, { kind: 'mars', world: GREEN_FIELD_WORLD as never });

/* eslint-disable @typescript-eslint/no-explicit-any */
function world() {
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const bridge = installEngineBridge({ host: f.host, god, edge: new EdgeLedger(f.host, f.db), log: () => {} });
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  return { ...f, god, bridge, settle };
}

test('a wall over a standing Soul names it and the rule; on an empty spot nothing; a burying undo is named; nothing live moves', { timeout: 300000 }, async t => {
  const w = world(), twin = world();
  t.after(() => { for (const x of [w, twin]) { x.brain.quiesce(); x.host.stop(); x.db.close(); } });
  w.brain.quiesce(); twin.brain.quiesce();
  await w.settle(2); await twin.settle(2);
  await invite(w, 'bo');
  const row: any = await accept(w.host, w.souls.create('dev:bo', { name: 'Bo', description: 'stands still' }));
  await w.settle(3);
  const E = w.host.engine as any, bo = row.entity_id as string, at: [number, number] = [E.world.entities[bo].pose.p[0], E.world.entities[bo].pose.p[2]];

  // the twin's bridge logs each edit as one world-edit event: those are the batches previewed
  const sent: WorldEditV1[] = [], enqueue = twin.host.enqueue.bind(twin.host);
  (twin.host as any).enqueue = (kind: string, author: string, payload: unknown) => { if (kind === 'world-edit') sent.push(payload as WorldEditV1); return enqueue(kind as never, author as never, payload as never); };
  const edit = async (act: () => any) => { const n = sent.length, r = act(); assert.equal(r.accepted, true, JSON.stringify(r)); await twin.settle(2); const mine = sent.slice(n).filter(e => e.seq > 0); assert.equal(mine.length, 1); return mine[0]; };
  const wall = { def: coreRef('wall'), params: { w: 4, h: 2.6, d: 0.5 } };
  const empty = await edit(() => twin.god.act({ ops: [{ op: 'place', ...wall, name: 'far-wall', p: [at[0], at[1] + 12] }] }));
  const over = await edit(() => twin.god.act({ ops: [{ op: 'place', ...wall, name: 'wall', p: at }] }));
  await edit(() => twin.god.act({ ops: [{ op: 'remove', id: twin.god.model.get('wall')!.id }] }));
  const undo = await edit(() => twin.god.undo());
  assert.ok(undo.set[twin.god.model.get('wall')!.id], 'the undo puts the wall back');

  const live = () => JSON.stringify([E.stateHash(), E.world.entities[bo].pose, E.world.entityPhysicsV1?.hash ?? null, E.runtime.violations.length]);
  const was = live();
  const named = (p: ReturnType<typeof previewWorldEditV1>, what: string) => {
    assert.equal(p.ok, true, what); if (!p.ok) return;
    const v = p.violations.find(x => x.rule === 'collision.human-static' && x.subjects.includes(bo));
    assert.ok(v, `${what}: ${JSON.stringify(p)}`);
    const body = v.bodies.find(b => b.id === bo)!;
    assert.deepEqual(body.at, at, `${what}: where Bo stands`);
    assert.ok(body.alternative, `${what}: a legal place to stand`);
    assert.ok(Math.hypot(body.alternative[0] - at[0], body.alternative[1] - at[1]) > 0.2, `${what}: off the wall`);
  };
  named(previewWorldEditV1(detachedEngineV1(w.host), over), 'wall over Bo');
  const clear = previewWorldEditV1(detachedEngineV1(w.host), empty);
  assert.deepEqual(clear, { ok: true, violations: [], relocated: [], trapped: [] }, 'the same wall on an empty spot');
  named(previewWorldEditV1(detachedEngineV1(w.host), undo), 'burying undo');
  assert.equal(live(), was, 'the live world is unchanged');
  await w.settle(2);
  assert.deepEqual([E.world.entities[bo].pose.p[0], E.world.entities[bo].pose.p[2]], at, 'Bo still stands where it stood');
});

test('off the tick thread: the same result as the in-thread preview on the #2134 cases and on 20 recorded edits', { timeout: 300000 }, async t => {
  const w = world(), twin = world();
  t.after(() => { for (const x of [w, twin]) { x.brain.quiesce(); x.host.stop(); x.db.close(); } });
  w.brain.quiesce(); twin.brain.quiesce();
  await w.settle(2); await twin.settle(2);
  await invite(w, 'bo');
  const row: any = await accept(w.host, w.souls.create('dev:bo', { name: 'Bo', description: 'stands still' }));
  await w.settle(3);
  const E = w.host.engine as any, bo = row.entity_id as string, at: [number, number] = [E.world.entities[bo].pose.p[0], E.world.entities[bo].pose.p[2]];

  // 20 edits as the twin's bridge logs them: walls placed near, over and away from where Bo stands, moved, removed, undone
  const sent: WorldEditV1[] = [], enqueue = twin.host.enqueue.bind(twin.host);
  (twin.host as any).enqueue = (kind: string, author: string, payload: unknown) => { if (kind === 'world-edit') sent.push(payload as WorldEditV1); return enqueue(kind as never, author as never, payload as never); };
  const edits: WorldEditV1[] = [];
  const edit = async (act: () => any) => { const n = sent.length, r = act(); assert.equal(r.accepted, true, JSON.stringify(r)); await twin.settle(2); const mine = sent.slice(n).filter(e => e.seq > 0); assert.equal(mine.length, 1); edits.push(mine[0]); };
  const wall = { def: coreRef('wall'), params: { w: 4, h: 2.6, d: 0.5 } }, id = (name: string) => twin.god.model.get(name)!.id;
  const P = (dx: number, dz: number) => [at[0] + dx, at[1] + dz];
  const place = (name: string, dx: number, dz: number) => edit(() => twin.god.act({ ops: [{ op: 'place', ...wall, name, p: P(dx, dz) }] }));
  const move = (name: string, dx: number, dz: number) => edit(() => twin.god.act({ ops: [{ op: 'move', id: id(name), p: P(dx, dz) }] }));
  const remove = (name: string) => edit(() => twin.god.act({ ops: [{ op: 'remove', id: id(name) }] }));
  const undo = () => edit(() => twin.god.undo());
  await place('a', 0, 0); await remove('a'); await undo(); await move('a', 0.3, 0.2); await move('a', 10, 0);
  await place('b', 0, 0.4); await move('b', -6, 3); await place('c', 2.5, 0); await remove('c');
  await place('d', 0, -1.2); await move('d', 0, 0); await remove('d'); await undo();
  await place('e', 8, -8); await place('f', 12, 12); await remove('e'); await remove('d'); await move('f', 0.2, 0);
  await edit(() => twin.god.act({ ops: [{ op: 'place', ...wall, name: 'g', p: P(-3, -3) }, { op: 'place', ...wall, name: 'h', p: P(3, 3) }] }));
  await place('far', 20, -20);
  assert.equal(edits.length, 20);

  const live = () => JSON.stringify([E.stateHash(), E.world.entities[bo].pose, E.world.entityPhysicsV1?.hash ?? null, E.runtime.violations.length]);
  const was = live();
  let named = 0;
  for (const [k, e] of edits.entries()) {
    const old = previewWorldEditV1(detachedEngineV1(w.host), e);
    const off = await previewWorldEditOffThreadV1(w.host, e);
    assert.deepEqual(off, old, `edit ${k} (seq ${e.seq})`);
    if (old.ok && old.violations.some(v => v.subjects.includes(bo))) named++;
  }
  assert.ok(named >= 5, `the walls over Bo are named (${named})`);
  assert.equal(live(), was, 'the live world is unchanged');
});
