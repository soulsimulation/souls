// Legal by construction 1a (#2134): a god world-edit previewed on a detached copy names the bodies it would break a rule
// on, and the rule, and changes nothing live. The payloads are the bridge's own: a twin world without the Soul builds
// them (the same genesis), and each is previewed on the Soul's world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import type { WorldEditV1 } from '@souls/engine-mars';
import { fixture, invite, accept, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { detachedEngineV1, previewWorldEditV1 } from './edit-preview.ts';

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
