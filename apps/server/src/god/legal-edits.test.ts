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
  // a dry run and a preview of the same edit answer as the commit did: refused, the same bodies and reasons
  const names = (r: any) => r.failures.map((x: any) => `${x.code}|${x.entity}|${x.measured?.rule ?? ''}`).sort();
  const dry: any = await w.god.checked(() => w.god.dryrun(wall('wall', here)));
  assert.equal(dry.accepted, false, JSON.stringify(dry)); assert.deepEqual(names(dry), names(over), 'dry run = commit');
  const pv: any = await w.god.checked(() => w.god.preview(wall('wall', here)));
  assert.equal(pv.accepted, false, JSON.stringify(pv)); assert.deepEqual(names(pv), names(over), 'preview = commit');
  assert.equal(w.god.model.editSeq, seq, 'neither committed');
  await w.settle(2); assert.deepEqual(w.at(bo.entityId), here, 'Bo was not moved');

  // the same wall on an empty spot
  const spot: [number, number] = [here[0], here[1] + 12];
  const empty: any = await w.god.checked(() => w.god.act(wall('wall', spot)));
  assert.equal(empty.accepted, true, JSON.stringify(empty)); assert.equal(empty.moved, undefined);
  await w.settle(2);

  // a burying undo: the wall is removed, Bo stands where it was, the undo of the removal would put it back on Bo
  assert.equal((await w.god.checked(() => w.god.act({ ops: [{ op: 'remove', id: w.god.model.get('wall')!.id }] })) as any).accepted, true);
  await w.settle(2);
  // a dry run's verdict never answers a later commit: dry-run a wall on an empty spot, Bo steps onto it, the commit is
  // previewed again on the world as it is then and refused by the preview's rule
  const spot2: [number, number] = [here[0] - 8, here[1]];
  assert.equal((await w.god.checked(() => w.god.dryrun(wall('probe', spot2))) as any).accepted, true, 'empty spot: dry run accepted');
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:stand', { soulId: bo.soulId, entityId: bo.entityId, to: spot2, why: 'stand on the probed spot' })); await w.settle(3);
  const late: any = await w.god.checked(() => w.god.act(wall('probe', spot2)));
  assert.equal(late.accepted, false, JSON.stringify(late));
  assert.ok(late.failures.some((x: any) => x.entity === bo.entityId && x.measured?.rule === 'collision.human-static'), `the commit's own preview names Bo: ${JSON.stringify(late.failures)}`);
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
  const dryMove: any = await w.god.checked(() => w.god.dryrun({ ops: [{ op: 'move', id, p: [here[0] + 9, here[1]] }] }));
  assert.deepEqual(dryMove.failures?.map((x: any) => `${x.code}|${x.entity}`), moveSeat.failures.map((x: any) => `${x.code}|${x.entity}`), 'dry run = commit for a seat in use');
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
  const bo = await w.soul('bo', 'Bo');
  await accept(w.host, enableLegalEditsV1(w.host, 'test:legal-edits') as never); await w.settle(2);
  w.bridge.legalTimeoutMs = 300;
  // an edit with nothing a rule watches within 8 m needs no preview: it goes through without one (the worker never answers)
  const [bx, bz] = w.at(bo.entityId), near: [number, number] = [bx, bz + 3];
  const far: any = await w.god.checked(() => w.god.act(wall('far-wall', [bx + 30, bz + 30])));
  assert.equal(far.accepted, true, JSON.stringify(far));
  const seq = w.god.model.editSeq;
  const r: any = await w.god.checked(() => w.god.act(wall('wall', near)));
  assert.equal(r.accepted, false, JSON.stringify(r));
  assert.equal(r.failures[0].code, 'edit-preview.worker-unavailable');
  assert.equal(r.failures[0].measured.retryable, true); assert.equal(r.ok, false, 'a build rewind client reads ok');
  assert.match(r.failures[0].detail, /no answer within 300 ms/);
  assert.equal(w.god.model.get('wall'), undefined); assert.equal(w.god.model.editSeq, seq, 'nothing committed');
  // with a working preview the same request goes through
  previewWorkerScriptV1(real); w.bridge.legalTimeoutMs = undefined;
  const ok: any = await w.god.checked(() => w.god.act(wall("wall", near)));
  assert.equal(ok.accepted, true, JSON.stringify(ok));
  // a land edit (POST /v1/god/land) goes through `checked` too
  const raised: any = await w.god.checked(() => land(w.god, { verb: 'raise', at: [30, 30], radius: 6, amount: 0.5, force: true } as never));
  assert.equal(raised.accepted, true, JSON.stringify(raised).slice(0, 400));
});

// #2377: the preview runs only near what a rule watches. A ring of walls closed 15 m from a Soul gets the same verdict as
// with the preview forced on every edit (main before #2377), on the dry run and the commit; a ride anywhere, a carried or
// engine part near the edit, a big fixture whose box reaches a Soul, and an asset the bridge cannot see force the preview.
test('legal-edits/1: a ring closed far from a Soul is judged as with the preview on every edit; rides, parts and big fixtures force it', { timeout: 300000 }, async t => {
  const w = await world(); w.brain.quiesce(); t.after(cleanup(w));
  await w.settle(2);
  const bo = await w.soul('bo', 'Bo');
  await accept(w.host, enableLegalEditsV1(w.host, 'test:legal-edits') as never); await w.settle(2);
  const [x, z] = w.at(bo.entityId), R = 15, W = 6;
  const seg = (name: string, p: [number, number], r: number) => ({ op: 'place', def: coreRef('wall'), params: { w: W, h: 2.6, d: 0.5 }, name, p, r });
  // a square ring of side 2R round Bo, five 6 m walls a side (the sides 5 cm clear of the ends); the gap is the middle of the north side, 15 m from Bo
  const ring: any[] = [];
  for (let i = 0; i < 5; i++) {
    const o = -R + W / 2 + i * W;
    ring.push(seg(`s-${i}`, [x + o, z + R], 0), seg(`w-${i}`, [x - R - 0.3, z + o], Math.PI / 2), seg(`e-${i}`, [x + R + 0.3, z + o], Math.PI / 2));
    if (i !== 2) ring.push(seg(`n-${i}`, [x + o, z - R], 0));
  }
  const open: any = await w.god.checked(() => w.god.act({ ops: ring }));
  assert.equal(open.accepted, true, JSON.stringify(open).slice(0, 600));
  await w.settle(4);
  const close = { ops: [seg('n-2', [x, z - R], 0)] };
  const real = w.bridge.draftNearWatched;
  const verdict = async (always: boolean) => {
    if (always) w.bridge.draftNearWatched = () => true;
    try { return await w.god.checked(() => w.god.dryrun(close)); } finally { w.bridge.draftNearWatched = real; }
  };
  const forced: any = await verdict(true), skipped: any = await verdict(false);
  const shape = (r: any) => ({ accepted: r.accepted, failures: (r.failures ?? []).map((f: any) => ({ code: f.code, entity: f.entity, rule: f.measured?.rule, detail: f.detail })) });
  t.diagnostic(`closing the ring 15 m from Bo, forced: ${JSON.stringify({ ...shape(forced), warnings: forced.warnings, wouldMove: forced.wouldMove }).slice(0, 700)}`);
  assert.deepEqual(shape(skipped), shape(forced), 'the same verdict with and without the preview forced');
  const committed: any = await w.god.checked(() => w.god.act(close));
  assert.deepEqual(shape(committed).failures, shape(forced).failures, 'the commit answers as the dry run');
  assert.deepEqual(w.at(bo.entityId), [x, z], 'Bo never moves');

  // the near test itself, on synthetic drafts 40 m from Bo
  const draft = (c: [number, number]) => ({ contract: 'world-edit/1', seq: 0, hash: '', levels: [], set: { 'probe-wall': { solids: [{ id: 'probe-wall', obb: { c, half: [3, 0.25], yaw: 0 }, y0: 0, y1: 2.6 }] } } });
  const far: [number, number] = [x + 40, z + 40], ents = w.E.world.entities;
  assert.equal(w.bridge.draftNearWatched(w.god.model, draft(far)), false, 'nothing watched near: no preview');
  assert.equal(w.bridge.draftNearWatched(w.god.model, draft([x + 5, z])), true, 'a Soul within 8 m: preview');
  const add = (id: string, e: any) => { ents[id] = { id, def: 'probe', provenance: { origin: 'design-edit', confidence: 'hypothetical' }, ...e }; };
  try {
    add('probe-ride', { kind: 'fixture', pose: { p: [x - 200, 0, z - 200], yaw: 0 }, carrier: {} });
    assert.equal(w.bridge.draftNearWatched(w.god.model, draft(far)), true, 'a ride anywhere: preview');
    delete ents['probe-ride'];
    add('probe-item', { kind: 'component', pose: { p: [far[0] + 2, 0.9, far[1]], yaw: 0 }, support: { kind: 'held' } });
    assert.equal(w.bridge.draftNearWatched(w.god.model, draft(far)), true, 'a carried or engine part within 8 m: preview');
    delete ents['probe-item'];
    // a fixture counts by its asset's box, not its spot: a 40 m stand 18 m from Bo covers him
    const stand = { def: 'probe-stand', kind: 'fixture', label: 'stand', p: [x + 18, 0, z], yaw: 0 };
    const big = { contract: 'world-edit/1', seq: 0, hash: '', levels: [], assets: { 'probe-stand': { size: [40, 3, 40] } }, set: { 'probe-stand': { fixture: stand } } };
    assert.equal(w.bridge.draftNearWatched(w.god.model, big), true, 'a big fixture whose box covers Bo: preview');
    const unseen = { ...big, assets: {}, set: { 'probe-stand': { fixture: { ...stand, def: 'probe-unseen', p: [far[0], 0, far[1]] } } } };
    assert.equal(w.bridge.draftNearWatched(w.god.model, unseen), true, 'an asset the bridge cannot see: preview');
  } finally { delete ents['probe-ride']; delete ents['probe-item']; }
});
