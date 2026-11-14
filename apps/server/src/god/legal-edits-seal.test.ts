// #2188 legal-edits/2: a god edit that would leave a Soul with no walk out is refused by name before it commits (the last
// wall of a ring closed round her at a distance); ordinary walls, near or far, are accepted; a construction closure still
// walks residents off its site (a legal walk); the check costs little per commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { applyBatch, coreRef } from '@souls/world-compiler';
import { GREEN_FIELD_WORLD } from '@souls/engine-mars';
import { fixture, invite, accept, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { enableLegalEditsV1, enableLegalEditsV2, legalEditsV2 } from '../edge-runtime-rules.ts';
import { describedFactoryV1 } from '../world-factory.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { inSite } from './builds.ts';
import * as seal from './seal-check.ts';

// the off-thread preview rebuilds this factory in its worker from the descriptor (edit-preview.test.ts)
describedFactoryV1(factory, { kind: 'mars', world: GREEN_FIELD_WORLD as never });

/* eslint-disable @typescript-eslint/no-explicit-any */
async function world() {
  const f = fixture(':memory:', factory, { durableClockV1: true }); f.brain.quiesce();
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, now: () => 1_000_000, buildPauseMs: 50, buildClosureMs: 500, emit: () => {} });
  const edge = new EdgeLedger(f.host, f.db);
  const bridge: any = installEngineBridge({ host: f.host, god, edge, log: () => {}, worldClock: false, worldLore: false });
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  const soul = async (owner: string, name: string) => {
    await invite(f, owner);
    const row: any = await accept(f.host, f.souls.create(`dev:${owner}`, { name, description: 'stands still' }));
    await settle(3);
    return { soulId: row.id as string, entityId: row.entity_id as string, name: row.name as string };
  };
  const E = f.host.engine as any;
  const at = (id: string): [number, number] => [E.world.entities[id].pose.p[0], E.world.entities[id].pose.p[2]];
  const rules = async (v2: boolean) => {
    await accept(f.host, enableLegalEditsV1(f.host, 'test:legal-edits') as never); await settle(2);
    if (v2) { await accept(f.host, enableLegalEditsV2(f.host, 'test:legal-edits') as never); await settle(2); }
  };
  return { ...f, god, edge, bridge, settle, soul, E, at, rules };
}
type W = Awaited<ReturnType<typeof world>>;
const cleanup = (w: W) => () => { w.brain.quiesce(); w.host.stop(); w.edge.comms?.close(); w.db.close(); };
const R = 15, SEG = 6;
const seg = (name: string, p: [number, number], r: number) => ({ op: 'place', def: coreRef('wall'), params: { w: SEG, h: 2.6, d: 0.5 }, name, p, r });
/** A square ring of side 2R round (x, z), five 6 m walls a side, without the middle of its north side (15 m from the centre). */
function openRing(x: number, z: number) {
  const ops: any[] = [];
  for (let i = 0; i < 5; i++) {
    const o = -R + SEG / 2 + i * SEG;
    ops.push(seg(`s-${i}`, [x + o, z + R], 0), seg(`w-${i}`, [x - R - 0.3, z + o], Math.PI / 2), seg(`e-${i}`, [x + R + 0.3, z + o], Math.PI / 2));
    if (i !== 2) ops.push(seg(`n-${i}`, [x + o, z - R], 0));
  }
  return { ops };
}
const shape = (r: any) => ({ accepted: r.accepted, failures: (r.failures ?? []).map((f: any) => `${f.code}|${f.entity}|${f.field}`).sort() });

test('legal-edits/2: closing a ring 15 m from a Soul is refused by name, dry run = commit; under legal-edits/1 alone it is accepted', { timeout: 300000 }, async t => {
  const w = await world(); t.after(cleanup(w));
  await w.settle(2);
  const bo = await w.soul('bo', 'Bo');
  await w.rules(false);
  const [x, z] = w.at(bo.entityId);
  const open: any = await w.god.checked(() => w.god.act(openRing(x, z)));
  assert.equal(open.accepted, true, JSON.stringify(open).slice(0, 600));
  await w.settle(4);
  const close = { ops: [seg('n-2', [x, z - R], 0)] };

  // legal-edits/1 as logged: the closing wall is accepted (the gap this rule closes)
  const v1: any = await w.god.checked(() => w.god.dryrun(close));
  assert.equal(v1.accepted, true, JSON.stringify(v1).slice(0, 600));

  await accept(w.host, enableLegalEditsV2(w.host, 'test:legal-edits') as never); await w.settle(2);
  assert.equal(legalEditsV2(w.host), true, 'adopted by a logged rules event');
  assert.ok(w.db.rulesEvents(w.host.worldId).some((e: any) => e.payload?.runtimePolicy?.legalEditsV2 === true));

  const seq = w.god.model.editSeq;
  const dry: any = await w.god.checked(() => w.god.dryrun(close));
  assert.equal(dry.accepted, false, JSON.stringify(dry).slice(0, 600));
  const f = dry.failures.find((x: any) => x.entity === bo.entityId);
  assert.ok(f, JSON.stringify(dry.failures));
  assert.equal(f.code, 'body.sealed-in'); assert.equal(f.field, 'legal-edits/2'); assert.equal(f.measured.soul, bo.soulId);
  assert.match(f.detail, /^Bo would have no walk out: this edit closes Bo in \d+ m²/);
  assert.ok(f.measured.pocket > 700 && f.measured.pocket <= seal.SEAL_MAX_POCKET, `the pen's free ground: ${f.measured.pocket}`);
  const committed: any = await w.god.checked(() => w.god.act(close));
  assert.deepEqual(shape(committed), shape(dry), 'the commit answers as the dry run');
  assert.equal(w.god.model.get('n-2'), undefined, 'nothing was built'); assert.equal(w.god.model.editSeq, seq);
  await w.settle(4); assert.deepEqual(w.at(bo.entityId), [x, z], 'Bo was not moved');

  // a gate-wide gap left in the last wall: a walk out, accepted
  const gapped = { ops: [{ ...seg('n-2a', [x - 1.6, z - R], 0), params: { w: 2.4, h: 2.6, d: 0.5 } }, { ...seg('n-2b', [x + 1.6, z - R], 0), params: { w: 2.4, h: 2.6, d: 0.5 } }] };
  const ok: any = await w.god.checked(() => w.god.act(gapped));
  assert.equal(ok.accepted, true, JSON.stringify(ok).slice(0, 600));
});

test('legal-edits/2: ordinary walls near and far from a Soul are accepted', { timeout: 300000 }, async t => {
  const w = await world(); t.after(cleanup(w));
  await w.settle(2);
  const bo = await w.soul('bo', 'Bo');
  await w.rules(true);
  const [x, z] = w.at(bo.entityId);
  const near: any = await w.god.checked(() => w.god.act({ ops: [seg('near', [x + 12, z], Math.PI / 2)] }));
  assert.equal(near.accepted, true, JSON.stringify(near).slice(0, 600));
  const far: any = await w.god.checked(() => w.god.act({ ops: [seg('far', [x + 120, z + 40], 0)] }));
  assert.equal(far.accepted, true, JSON.stringify(far).slice(0, 600));
  assert.ok(Math.hypot(120, 40) - SEG > seal.SEAL_R, 'the far wall is beyond the check\'s reach: nothing is rastered for it');
});

test('legal-edits/2: a construction closure still walks a resident off its site (a legal walk), unchanged', { timeout: 300000 }, async t => {
  const w = await world(); t.after(cleanup(w));
  await w.settle(2);
  const bo = await w.soul('bo', 'Bo');
  await w.rules(true);
  const p = w.at(bo.entityId);
  const caller = w.god.godIdentity(w.god.mintFor({ id: 'dev:admin', role: 'user' }, 'builder'))!;
  const site = { at: p, size: [10, 10] as [number, number], yaw: .4 };
  const r: any = w.god.builds.start({ id: 'pavilion', title: 'Pavilion', steps: ['shell'], site, massing: [{ at: p, size: [10, 10], h: 2 }] } as any, caller);
  assert.equal(r.ok, true, JSON.stringify(r));
  await w.settle(15);
  assert.equal(inSite(site, w.at(bo.entityId), .5), false, `Bo stepped off the site: ${JSON.stringify(w.at(bo.entityId))}`);
  const ev = w.db.events(w.host.worldId, 0, 100000).filter((e: any) => e.author === 'god:walkout');
  assert.equal(ev.length, 1, 'one walk-out'); assert.equal(ev[0].kind, 'edge-god-walkout');
});

test('legal-edits/2, the check alone: 40 single walls among 12 Souls (S6 bar p95 < 250 ms a commit); a pen closed before the edit is not refused', { timeout: 600000 }, async t => {
  const w = await world(); t.after(cleanup(w));
  await w.settle(2);
  const bo = await w.soul('bo', 'Bo');
  const [x, z] = w.at(bo.entityId);
  const apply = (m: any, ops: any[]) => { const after = m.fork(), r: any = applyBatch(after, { ops } as any, 'god', 0); assert.equal(r.result.accepted, true, JSON.stringify(r.result).slice(0, 300)); return { after, diff: r.diff }; };
  // twelve Souls in a plaza 30 m across; 40 single walls 8 to 40 m from its centre, none closing anything
  const crowd = Array.from({ length: 12 }, (_, i) => ({ body: `b-${i}`, soulId: `s-${i}`, name: `S${i}`, p: [x + Math.cos(i) * (3 + i), z + Math.sin(i) * (3 + i)] as [number, number] }));
  const base = w.god.model.fork(), ms: number[] = [];
  for (let i = 0; i < 40; i++) {
    const a = i * 0.7, d = 8 + (i % 9) * 4;
    const { after, diff } = apply(base, [{ op: 'place', def: coreRef('wall'), params: { w: 3, h: 2.6, d: 0.5 }, name: `b-${i}`, p: [x + Math.cos(a) * d, z + Math.sin(a) * d], r: a }]);
    const t0 = performance.now();
    assert.deepEqual(seal.sealedBy(base, after, diff, crowd), []);
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const p50 = ms[20], p95 = ms[38], max = ms[39];
  t.diagnostic(`seal check per commit, 12 Souls within reach: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
  assert.ok(p95 < 100, `p95 ${p95.toFixed(1)} ms: well under the S6 bar of 250 ms a commit`);

  // the ring closed round the plaza: every Soul in it is named; a wall added inside the closed ring seals no one anew
  const open = apply(base, openRing(x, z).ops), closed = apply(open.after, [seg('n-2', [x, z - R], 0)]);
  const inRing = crowd.filter(c => Math.max(Math.abs(c.p[0] - x), Math.abs(c.p[1] - z)) < R - 1);
  const sealed = seal.sealedBy(open.after, closed.after, closed.diff, inRing);
  assert.equal(sealed.length, inRing.length, `the plaza's Souls named: ${sealed.length} of ${inRing.length}`); assert.ok(sealed.every(s => s.by.includes(closed.after.get('n-2')!.id)));
  const inside = apply(closed.after, [{ op: 'place', def: coreRef('wall'), params: { w: 2, h: 2.6, d: 0.5 }, name: 'inner', p: [x + 8, z + 8] }]);
  assert.deepEqual(seal.sealedBy(closed.after, inside.after, inside.diff, crowd), [], 'already closed before this edit: not its doing');
});

