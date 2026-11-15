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

  // a scattered batch: 16 short walls 30 m apart (a 4 × 4 grid 90 m across) with the twelve Souls among them, 20 times over;
  // and 50 pieces scattered over 200 m. The windows are capped, so the cost does not grow with the pieces.
  const scattered = (n: number, step: number, k: number) => Array.from({ length: n }, (_, i) => ({ op: 'place', def: coreRef('wall'), params: { w: 2, h: 2.6, d: 0.5 }, name: `sc-${k}-${i}`, p: [x - 45 + (i % Math.ceil(Math.sqrt(n))) * step + k * 0.1, z - 45 + Math.floor(i / Math.ceil(Math.sqrt(n))) * step], r: (i * 0.4) % 3 }));
  const among = Array.from({ length: 12 }, (_, i) => ({ body: `m-${i}`, soulId: `m-${i}`, name: `M${i}`, p: [x - 30 + (i % 4) * 25, z - 30 + Math.floor(i / 4) * 30] as [number, number] }));
  for (const [label, n, step] of [['16 walls 30 m apart', 16, 30], ['50 walls over 200 m', 50, 28]] as const) {
    const t2: number[] = [];
    for (let k = 0; k < 20; k++) {
      const b = apply(base, scattered(n, step, k)), t0 = performance.now();
      assert.deepEqual(seal.sealedBy(base, b.after, b.diff, among), []);
      t2.push(performance.now() - t0);
    }
    t2.sort((a, b) => a - b);
    t.diagnostic(`seal check per commit, ${label}, 12 Souls among them: p50 ${t2[10].toFixed(1)} ms, p95 ${t2[18].toFixed(1)} ms, max ${t2[19].toFixed(1)} ms`);
    assert.ok(t2[18] < 100, `${label}: p95 ${t2[18].toFixed(1)} ms`);
  }
});

test('legal-edits/2, the check alone: a 48 m pen closed at its far corner names a Soul in the opposite corner; a parent moved with a wall child is checked', { timeout: 300000 }, async t => {
  const w = await world(); t.after(cleanup(w));
  await w.settle(2);
  const apply = (m: any, ops: any[]) => { const after = m.fork(), r: any = applyBatch(after, { ops } as any, 'god', 0); assert.equal(r.result.accepted, true, JSON.stringify(r.result).slice(0, 300)); return { after, diff: r.diff }; };
  const base = w.god.model.fork(), a = 60, L = 48;
  // a pen 48 m a side, eight 6 m walls a side; the north-east corner piece is left out, then closed
  const pen: any[] = [];
  for (let i = 0; i < 8; i++) {
    const o = a + SEG / 2 + i * SEG;
    pen.push(seg(`ps-${i}`, [o, a], 0), seg(`pw-${i}`, [a - 0.3, o], Math.PI / 2), seg(`pe-${i}`, [a + L + 0.3, o], Math.PI / 2));
    if (i !== 7) pen.push(seg(`pn-${i}`, [o, a + L], 0));
  }
  const open = apply(base, pen), closed = apply(open.after, [seg('pn-7', [a + L - SEG / 2, a + L], 0)]);
  for (const d of [1.5, 3]) {
    const sw = { body: 'sw', soulId: 'sw', name: 'Sw', p: [a + d, a + d] as [number, number] };
    const got = seal.sealedBy(open.after, closed.after, closed.diff, [sw]);
    assert.equal(got.length, 1, `a Soul ${d} m in from the south-west corner is named: ${JSON.stringify(got)}`);
    assert.ok(got[0].pocket > 2000 && got[0].pocket <= seal.SEAL_MAX_POCKET, `pocket ${got[0].pocket}`);
  }

  // a parent that is not solid, carrying a wall: moved so the wall closes the pen's corner
  const host = apply(open.after, [
    { op: 'define', def: { schema: 'def/1', name: 'pen-gate-host', size: { box: [8, 3, 8] }, make: { kind: 'none' }, slots: [{ id: 'ground', kind: 'floor', p: [0, 0, 0], accepts: {}, capacity: 8 }] } },
    { op: 'place', tmp: '$g', def: 'pen-gate-host@1', name: 'gate-host', p: [a + 200, a + L] },
    { op: 'place', def: coreRef('wall'), params: { w: SEG, h: 2.6, d: 0.5 }, name: 'carried', in: { parent: '$g', slot: 'ground' }, p: [0, 0, 0] },
  ]);
  const moved = apply(host.after, [{ op: 'move', id: 'gate-host', p: [a + L - SEG / 2, a + L] }]);
  const carried = [...moved.after.entities.values()].find((e: any) => e.name === 'carried');
  assert.ok(carried, 'the child wall exists');
  const got = seal.sealedBy(host.after, moved.after, moved.diff, [{ body: 'sw', soulId: 'sw', name: 'Sw', p: [a + 2, a + 2] }]);
  assert.equal(got.length, 1, `the parent move is checked: ${JSON.stringify(got)}`); assert.ok(got[0].by.includes((carried as any).id), 'the carried wall is named');
});

test('legal-edits/2: an undo that puts back the wall closing a ring round a Soul is refused by name', { timeout: 300000 }, async t => {
  const w = await world(); t.after(cleanup(w));
  await w.settle(2);
  const bo = await w.soul('bo', 'Bo');
  await w.rules(false);
  const [x, z] = w.at(bo.entityId);
  const ring: any = await w.god.checked(() => w.god.act(openRing(x, z)));
  assert.equal(ring.accepted, true, JSON.stringify(ring).slice(0, 400));
  const placed: any = await w.god.checked(() => w.god.act({ ops: [{ ...seg('gap', [x + 40, z + 40], 0) }] }));
  assert.equal(placed.accepted, true, JSON.stringify(placed).slice(0, 400));
  // under legal-edits/1 alone: the wall moved into the ring's gap and out again; the undo of the move out puts it back
  const into: any = await w.god.checked(() => w.god.act({ ops: [{ op: 'move', id: 'gap', p: [x, z - R] }] }));
  assert.equal(into.accepted, true, 'under legal-edits/1 alone the move into the gap is accepted');
  const out: any = await w.god.checked(() => w.god.act({ ops: [{ op: 'move', id: 'gap', p: [x + 40, z + 40] }] }));
  assert.equal(out.accepted, true, JSON.stringify(out).slice(0, 400));
  await w.settle(4);
  const p = w.at(bo.entityId);
  if (Math.hypot(p[0] - x, p[1] - z) > 0.5) { await accept(w.host, w.host.enqueue('edge-relocate', 'test:seal', { soulId: bo.soulId, entityId: bo.entityId, to: [x, z], why: 'seal test fixture' })); await w.settle(2); }
  await accept(w.host, enableLegalEditsV2(w.host, 'test:legal-edits') as never); await w.settle(2);
  const seq = w.god.model.editSeq;
  const undo: any = await w.god.checked(() => w.god.undo());
  assert.equal(undo.accepted, false, JSON.stringify(undo).slice(0, 600));
  const f = undo.failures.find((x: any) => x.entity === bo.entityId);
  assert.ok(f, JSON.stringify(undo.failures)); assert.equal(f.code, 'body.sealed-in'); assert.match(f.detail, /^Bo would have no walk out/);
  assert.equal(w.god.model.editSeq, seq, 'nothing committed');
});

