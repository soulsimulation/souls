// Legal by construction 1b: under legal-edits/1 (a logged rules event), a god edit, undo or redo whose off-thread preview
// breaks a rule on a Soul is refused, naming the body, the rule and the nearest legal place; an edit to a seat in use is
// refused too; nobody is walked out; a preview that cannot run refuses the edit with a retryable code. Batches before the
// event replay as recorded: a walk-out made before it replays to the same hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { kernelHash } from '@souls/kernel';
import { coreRef } from '@souls/world-compiler';
import { GREEN_FIELD_WORLD } from '@souls/engine-mars';
import { fixture, invite, accept, factory, seed } from '../../test/native-owner-fixture.ts';
import { WorldHost } from '../world.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { enableLegalEditsV1, legalEditsV1 } from '../edge-runtime-rules.ts';
import { describedFactoryV1 } from '../world-factory.ts';
import { GodMode, LEGAL_PENDING } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { previewWorkerScriptV1 } from './edit-preview.ts';
import { land } from './land.ts';

// the off-thread preview rebuilds this factory in its worker from the descriptor (edit-preview.test.ts)
describedFactoryV1(factory, { kind: 'mars', world: GREEN_FIELD_WORLD as never });

/* eslint-disable @typescript-eslint/no-explicit-any */
async function world() {
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(f.host, f.db);
  const bridge: any = installEngineBridge({ host: f.host, god, edge, log: () => {} });
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  const until = async (pred: () => boolean, n = 4000) => { for (let i = 0; i < n && !pred(); i++) { f.host.tickOnce(); if (i % 20 === 0) { await setImmediate(); f.host.drainInputs(); } } await settle(2); return pred(); };
  const soul = async (owner: string, name: string) => {
    await invite(f, owner);
    const row: any = await accept(f.host, f.souls.create(`dev:${owner}`, { name, description: 'stands still' }));
    await settle(3);
    return { soulId: row.id as string, entityId: row.entity_id as string, name: row.name as string };
  };
  const E = f.host.engine as any;
  const at = (id: string): [number, number] => [E.world.entities[id].pose.p[0], E.world.entities[id].pose.p[2]];
  return { ...f, god, edge, bridge, settle, until, soul, E, at };
}
type W = Awaited<ReturnType<typeof world>>;
const cleanup = (w: W) => () => { w.brain.quiesce(); w.host.stop(); w.db.close(); };
const wall = (name: string, p: [number, number]) => ({ ops: [{ op: 'place', def: coreRef('wall'), params: { w: 4, h: 2.6, d: 0.5 }, name, p }] });

test('legal-edits/1: a wall on a standing Soul is refused by name, on an empty spot accepted; a burying undo and an edit to a seat in use are refused; nobody moves; replay agrees', { timeout: 300000 }, async t => {
  const w = await world(); w.brain.quiesce(); t.after(cleanup(w));
  await w.settle(2);
  const bo = await w.soul('bo', 'Bo');

  // under the old rules a wall over Bo walks Bo out: that batch must replay as recorded after the rule is adopted
  const old: any = w.god.act(wall('old-wall', w.at(bo.entityId)));
  assert.equal(old.accepted, true, JSON.stringify(old));
  assert.equal(old.moved?.[0]?.soulId, bo.soulId, 'walked out under the old rules');
  await w.settle(4);

  assert.equal(legalEditsV1(w.host), false);
  await accept(w.host, enableLegalEditsV1(w.host, 'test:legal-edits') as never); await w.settle(2);
  assert.equal(legalEditsV1(w.host), true, 'adopted by a logged rules event');
  assert.ok(w.db.rulesEvents(w.host.worldId).some((e: any) => e.payload?.runtimePolicy?.legalEditsV1 === true));

  const here = w.at(bo.entityId), seq = w.god.model.editSeq;
  // a caller that does not wait for the check is refused, never accepted unchecked
  assert.equal((w.god.act(wall('wall', here)) as any).failures?.[0]?.code, LEGAL_PENDING);
  const over: any = await w.god.checked(() => w.god.act(wall('wall', here)));
  assert.equal(over.accepted, false, JSON.stringify(over));
  const f = over.failures.find((x: any) => x.entity === bo.entityId);
  assert.ok(f, JSON.stringify(over.failures));
  assert.equal(f.code, 'body.in-the-way'); assert.equal(f.measured.rule, 'collision.human-static', 'the preview names the rule');
  assert.match(f.detail, /^Bo stands at/);
  assert.ok(f.suggest?.p && Math.hypot(f.suggest.p[0] - here[0], f.suggest.p[1] - here[1]) > 0.2, `the nearest legal place: ${JSON.stringify(f.suggest)}`);
  assert.equal(w.god.model.get('wall'), undefined, 'nothing was built'); assert.equal(w.god.model.editSeq, seq);
  await w.settle(2); assert.deepEqual(w.at(bo.entityId), here, 'Bo was not moved');

  // the same wall on an empty spot
  const spot: [number, number] = [here[0], here[1] + 12];
  const empty: any = await w.god.checked(() => w.god.act(wall('wall', spot)));
  assert.equal(empty.accepted, true, JSON.stringify(empty)); assert.equal(empty.moved, undefined);
  await w.settle(2);

  // a burying undo: the wall is removed, Bo stands where it was, the undo of the removal would put it back on Bo
  assert.equal((await w.god.checked(() => w.god.act({ ops: [{ op: 'remove', id: w.god.model.get('wall')!.id }] })) as any).accepted, true);
  await w.settle(2);
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:stand', { soulId: bo.soulId, entityId: bo.entityId, to: spot, why: 'stand where the wall was' })); await w.settle(3);
  const there = w.at(bo.entityId);
  assert.ok(Math.hypot(there[0] - spot[0], there[1] - spot[1]) < 0.3, `Bo stands on the wall's spot: ${there}`);
  const undo: any = await w.god.checked(() => w.god.undo());
  assert.equal(undo.accepted, false, JSON.stringify(undo));
  assert.ok(undo.failures.some((x: any) => x.entity === bo.entityId && x.measured?.rule), JSON.stringify(undo.failures));
  assert.equal(w.god.model.get('wall'), undefined, 'the wall stays removed');
  await w.settle(2); assert.deepEqual(w.at(bo.entityId), there, 'Bo was not moved');

  // an edit to a seat in use
  const bench: any = await w.god.checked(() => w.god.act({ ops: [{ op: 'place', def: coreRef('bench'), name: 'bench', p: [here[0] + 6, here[1]] }] }));
  assert.equal(bench.accepted, true, JSON.stringify(bench)); await w.settle(3);
  const id = w.god.model.get('bench')!.id;
  const sit: any = await accept(w.host, w.edge.act(bo as never, { capability: `sit:${id}`, params: { seconds: 600 } }));
  assert.equal(sit.accepted, true, JSON.stringify(sit));
  assert.ok(await w.until(() => w.E.world.entities[bo.entityId].human.activity === 'sit'), 'Bo sits');
  const seated = w.at(bo.entityId);
  const moveSeat: any = await w.god.checked(() => w.god.act({ ops: [{ op: 'move', id, p: [here[0] + 9, here[1]] }] }));
  assert.equal(moveSeat.accepted, false, JSON.stringify(moveSeat));
  const s = moveSeat.failures.find((x: any) => x.entity === bo.entityId);
  assert.ok(s, JSON.stringify(moveSeat.failures));
  assert.match(s.detail, /^Bo /);
  await w.settle(2);
  assert.equal(w.E.world.entities[bo.entityId].human.activity, 'sit', 'Bo still sits'); assert.deepEqual(w.at(bo.entityId), seated);
  assert.deepEqual(w.E.runtime.violations, []);

  // replay: the walk-out before the rule and the refusals after it give the same head
  w.host.drainInputs(); w.host.saveSnapshot(true);
  const head = { engine: w.host.engine.stateHash(), kernel: kernelHash(w.host.kernel), physics: w.E.world.entityPhysicsV1.hash };
  w.db.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(w.host.worldId);
  const h = new WorldHost(w.db, factory, seed, 1e9, w.host.worldId, { durableClockV1: true });
  try {
    assert.equal(h.boot().from, 'genesis');
    assert.deepEqual({ engine: h.engine.stateHash(), kernel: kernelHash(h.kernel), physics: (h.engine as any).world.entityPhysicsV1.hash }, head, 'replay exact');
    assert.equal(legalEditsV1(h), true, 'the replayed world has the rule');
  } finally { h.stop(); }
});

test('legal-edits/1: a preview that times out refuses the edit with a retryable code; it is never accepted unchecked', { timeout: 120000 }, async t => {
  const w = await world(); w.brain.quiesce();
  const real = previewWorkerScriptV1(new URL(`data:text/javascript,${encodeURIComponent('import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => {});')}`));
  t.after(() => { previewWorkerScriptV1(real); cleanup(w)(); });
  await w.settle(2);
  await accept(w.host, enableLegalEditsV1(w.host, 'test:legal-edits') as never); await w.settle(2);
  w.bridge.legalTimeoutMs = 300;
  const seq = w.god.model.editSeq;
  const r: any = await w.god.checked(() => w.god.act(wall('wall', [5, 5])));
  assert.equal(r.accepted, false, JSON.stringify(r));
  assert.equal(r.failures[0].code, 'edit-preview.worker-unavailable');
  assert.equal(r.failures[0].measured.retryable, true); assert.equal(r.ok, false, 'a build rewind client reads ok');
  assert.match(r.failures[0].detail, /no answer within 300 ms/);
  assert.equal(w.god.model.get('wall'), undefined); assert.equal(w.god.model.editSeq, seq, 'nothing committed');
  // with a working preview the same request goes through
  previewWorkerScriptV1(real); w.bridge.legalTimeoutMs = undefined;
  const ok: any = await w.god.checked(() => w.god.act(wall("wall", [5, 5])));
  assert.equal(ok.accepted, true, JSON.stringify(ok));
  // a land edit (POST /v1/god/land) waits for its preview the same way
  const raised: any = await w.god.checked(() => land(w.god, { verb: 'raise', at: [30, 30], radius: 6, amount: 0.5, force: true } as never));
  assert.equal(raised.accepted, true, JSON.stringify(raised).slice(0, 400));
});
