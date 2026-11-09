// W055: real authoritative painting offers, movement, brush pose, receipts and persistence; fake minds only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Hono } from 'hono';
import { coreRef } from '@souls/world-compiler';
import { fixture, invite, accept, factory, seed } from '../test/native-owner-fixture.ts';
import { Db } from './db.ts';
import { WorldHost } from './world.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { mountEdgeRoutes } from './edge/routes.ts';
import { GodMode } from './god/god.ts';
import { installEngineBridge } from './god/engine-bridge.ts';
import { createPaintingService } from './art/painting-completion.ts';
import { MURAL_PANEL_DEF } from '../../../packages/world-compiler/src/core-kit/mural-panel.ts';

const picture = { title: 'Sun garden', background: '#e8e1ce', shapes: [{ kind: 'ellipse', cx: 0.5, cy: 0.4, rx: 0.23, ry: 0.23, colour: '#e6ac25' }] };
type Soul = { soulId: string; entityId: string; name: string; owner: string };

test('mural offer paints a real permitted wall, preserves cancellation/refusals and survives native restart exactly once, with bounded perception', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mural-native-')), path = join(dir, 'world.db'), art = join(dir, 'art'); mkdirSync(art);
  const f = fixture(path, factory, { durableClockV1: true }); f.brain.quiesce(); let host = f.host, db = f.db;
  let god!: GodMode, edge!: EdgeLedger, soul!: Soul, app!: Hono, comms!: ReturnType<typeof mountEdgeRoutes>;
  const attach = () => {
    god = new GodMode(db, { worldId: host.worldId, ownerId: 'dev:admin', tick: () => host.engine.world.tick, emit() {}, assetDir: dir });
    edge = new EdgeLedger(host, db, undefined, { ambient: false });
    installEngineBridge({ host, god, edge, log() {}, worldLore: false, worldClock: false });
    edge.painting = createPaintingService({ model: () => god.model, dir: art, basePath: '/w/mural-test', worldId: host.worldId, commit: (ops, note, done, durable) => god.engineAct(ops, note, done, durable) });
    app = new Hono(); comms = mountEdgeRoutes(app, { host, db, souls: f.souls, ledger: edge, soul: () => soul } as never);
  }; attach();
  t.after(() => { comms.close(); host.stop(); if (db.db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); });
  const tick = async (n = 5) => { for (let i = 0; i < n; i++) { host.tickOnce(); await setImmediate(); host.drainInputs(); } };
  await tick(); await invite(f, 'ana'); const row = await accept(host, f.souls.create('dev:ana', { name: 'Ana', description: 'Mural test' }));
  soul = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner }; await tick();
  const here = async () => { const r = await app.request('/v1/edge/here?include=doHere'); assert.equal(r.status, 200); return (await r.json()).here; };
  const absent = await here();
  const distant = Array.from({ length: 100 }, (_, i) => ({ op: 'place', def: coreRef('mural-panel', 1), name: `distant-mural-${i}`, p: [120 + i % 10 * 3, 120 + Math.floor(i / 10) * 3], state: { media: '/w/mural-test/art/' + 'a'.repeat(64) + '.png', title: 'Distant picture', maker: 'soul:s_far:Far painter' } }));
  assert.equal(god.act({ ops: distant as never }).accepted, true); await tick(45); const far = await here();
  const strip = (h: Record<string, unknown>) => JSON.stringify({ ...h, tick: 0, now: '', clock: '', light: '', day: '', doHereCoverage: { ...(h.doHereCoverage as object), byteBudget: 0 } });
  assert.equal(strip(far), strip(absent), '100 distant murals add zero normalized here bytes');
  assert.ok(!/Distant picture|Far painter|distant-mural/.test(JSON.stringify(far)));
  const body = () => host.engine.world.entities[soul.entityId] as { pose: { p: number[] }; human?: { activity?: string } };
  const [x, , z] = body().pose.p;
  // A materially different wall uses the same wall geometry without the painting workstation: permission is opt-in.
  const ordinary = structuredClone(MURAL_PANEL_DEF); ordinary.name = 'plain-mural-wall'; ordinary.components = { display: { w: 1.2, h: 1.2 } };
  assert.equal(god.act({ ops: [{ op: 'define', def: ordinary },
    { op: 'place', def: coreRef('mural-panel', 1), name: 'garden-wall', p: [x + 3, z + 2] },
    { op: 'place', def: coreRef('mural-panel', 1), name: 'private-wall', p: [x - 3, z + 2], owner: 'soul:s_other' },
    { op: 'place', def: 'plain-mural-wall@1', name: 'plain-wall', p: [x + 7, z + 2] },
  ] as never }).accepted, true); await tick(45);
  const target = god.model.get('garden-wall')!.id, privateId = god.model.get('private-wall')!.id, plainId = god.model.get('plain-wall')!.id;
  const capId = `paint:paint.${target}`, caps = edge.capabilities(soul), cap = caps.find(c => c.id === capId)!;
  assert.ok(cap?.available); assert.match(cap.label, /^Paint a mural/);
  assert.match((cap.params!.painting as { description: string }).description, /512×512.*64.*rect.*ellipse.*line/);
  const inspected = await app.request(`/v1/edge/inspect/${encodeURIComponent(cap.target!.id)}`);
  assert.equal(inspected.status, 200);
  const spot = (await inspected.json()).inspect as { offers: { id: string; label: string; params?: { painting?: unknown } }[] };
  const inspectedPaint = spot.offers.find(o => o.id === capId);
  assert.ok(inspectedPaint, 'inspect the activity spot named by its paint offer');
  assert.match(inspectedPaint.label, /^Paint a mural/); assert.ok(inspectedPaint.params?.painting);
  assert.ok(!caps.some(c => c.verb === 'paint' && c.id.includes(plainId)), 'ordinary walls offer no painting');
  const nearBlank = await here();
  const act = async (capability: string, params?: Record<string, unknown>) => await accept(host, edge.act(soul, { capability, ...(params ? { params } : {}) }));
  const invalid = await act(capId, { painting: { ...picture, shapes: [{ kind: 'star' }] } }); assert.equal(invalid.accepted, false); if (!invalid.accepted) assert.equal(invalid.code, 'painting.invalid');
  const denied = await act(`paint:paint.${privateId}`, { painting: picture }); assert.equal(denied.accepted, false); if (!denied.accepted) assert.equal(denied.code, 'art.not-yours');
  const unrelated = await act('stand:here', { painting: picture }); assert.equal(unrelated.accepted, false); if (!unrelated.accepted) assert.equal(unrelated.code, 'painting.no-easel');
  assert.equal(edge.openReceipts(soul.soulId).length, 0, 'admission refusals start no activity'); assert.deepEqual(readdirSync(art), []);
  const state = () => god.model.entities.get(target)!.state!;
  const cut = await act(capId, { seconds: 30, painting: picture }); assert.equal(cut.accepted, true); if (!cut.accepted) return;
  await tick(30); assert.equal((await act('stand:here')).accepted, true); await tick(40);
  assert.equal(state().media, ''); assert.deepEqual(readdirSync(art), []);
  assert.ok(['replaced', 'failed', 'cancelled'].includes(edge.receipt(soul.soulId, cut.receipt.id)!.phase));
  const started = await act(capId, { seconds: 5, painting: picture }); assert.equal(started.accepted, true, JSON.stringify(started)); if (!started.accepted) return;
  for (let i = 0; i < 1800 && body().human?.activity !== 'paint'; i++) await tick(1);
  assert.equal(body().human?.activity, 'paint', 'native brush pose at the real wall'); assert.equal(state().media, '', 'only completion publishes');
  const program = edge.receipt(soul.soulId, started.receipt.id)!.programId, head = host.engine.stateHash();
  comms.close(); host.stop(); host.drainInputs(); assert.ok(host.engine.canSnapshot?.() !== false); host.saveSnapshot(true);
  const worldId = host.worldId; db.close(); db = new Db(path); host = new WorldHost(db, factory, seed, 1e9, worldId, { durableClockV1: true });
  assert.equal(host.boot().from, 'snapshot'); host.drainInputs(); attach();
  assert.equal(host.engine.stateHash(), head); assert.equal(host.engine.programOf(soul.entityId), program);
  assert.equal(edge.receipt(soul.soulId, started.receipt.id)!.phase, 'started');
  for (let i = 0; i < 1800 && ['waiting', 'started'].includes(edge.receipt(soul.soulId, started.receipt.id)!.phase); i++) await tick(1);
  const done = edge.receipt(soul.soulId, started.receipt.id)!; assert.equal(done.phase, 'completed', JSON.stringify(done));
  assert.equal(state().title, picture.title); assert.equal(state().maker, `soul:${encodeURIComponent(soul.soulId)}:Ana`); assert.match(state().media as string, /\/art\/[a-f0-9]{64}\.png$/);
  assert.equal(done.outcome!.produced[0].id, target); assert.equal(done.outcome!.produced[0].kind, 'painting');
  await tick(100); assert.equal(readdirSync(art).filter(x => x.endsWith('.png')).length, 1);
  assert.equal(god.store.edits(200).filter(e => e.note?.includes(`"receipt":"${started.receipt.id}"`)).length, 1);
  const painted = await here(), what = (painted.objects as { id: string; what?: string }[]).find(o => o.id === target)?.what;
  assert.match(what ?? '', /^Ana’s mural “Sun garden”/); assert.ok(!/e6ac25|ellipse|shapes/.test(JSON.stringify(painted)));
  assert.deepEqual(host.engine.runtime.violations, []);
  const summary = { status: 'pass', hereBytes: { absent: JSON.stringify(absent).length, distant100: JSON.stringify(far).length, nearbyBlank: JSON.stringify(nearBlank).length, nearbyPainted: JSON.stringify(painted).length, normalizedDistantDelta: strip(far).length - strip(absent).length }, outcomeSummary: done.outcome!.summary, checks: { nativeBrushPose: true, restartExactlyOnce: true, forbiddenOwner: 'art.not-yours', invalid: 'painting.invalid', ordinaryWallOffer: false } };
  if (process.env.SOUL_ACTIONS_OUT) { mkdirSync(process.env.SOUL_ACTIONS_OUT, { recursive: true }); writeFileSync(join(process.env.SOUL_ACTIONS_OUT, 'mural-summary.json'), JSON.stringify(summary, null, 2)); }
  console.log(JSON.stringify(summary));
});
