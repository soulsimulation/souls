import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, seed, worldId} from '../../apps/server/test/native-owner-fixture.ts';
import {Db} from '../../apps/server/src/db.ts';
import {WorldHost} from '../../apps/server/src/world.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {marsFactory, GREEN_FIELD_WORLD} from '../../packages/engine-mars/src/engine.ts';
import {forgetMotion} from '../../mars/viewer/engine/runtime/invariants.ts';
import {rowsOf as glitchRows} from '../../apps/server/test/glitch-rows.ts';

import {solidOverlapsV1, newOverlapsV1} from '../../mars/viewer/engine/runtime/solid-overlaps.ts';
const coreRef = (name, v = 1) => `core/${name}@${v}`;   // as @souls/world-compiler's core-kit.ts

// #1411 slice 1: the world-level movers on a real server fixture (native engine, edge ledger, god mode, engine bridge), measured
// by solidOverlapsV1 after every tick. Mover here: the god placing a table or a cottage on a walking Soul's spot (G1 walk-out,
// BUILDSAFE). Counted per case: new body overlaps the edit left (`overlaps`), and whether god mode refused the placement
// (`refused`: the request-time side). Fixed seeds; numbers printed with MOVER_FUZZ_REPORT=1.
const factory = await marsFactory({...GREEN_FIELD_WORLD, sharedCarryV1: true, soulsRepairV1: true});
const COTTAGE = {w: 6, d: 5, floors: 1, floorHeight: 2.8, style: 'cottage', roof: 'gable', roofPitch: 32, material: 'plaster', front: 's', porch: 0, balcony: false, windows: 0.6, wallThickness: 0.22};
async function world(t) {
  const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false, sharedCarry: true}), app = new Hono();
  const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => null});
  t.after(() => { try { comms.close(); f.host.stop(); f.db.close(); } catch { /* closed */ } });
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
  const tick = async (n = 5) => { for (let i = 0; i < n && !f.host.paused; i++) { f.host.tickOnce(); await setImmediate(); if (!f.host.paused) f.host.drainInputs(); } };
  await tick();
  const souls = {};
  for (const name of ['Ada', 'Bo']) {
    await invite(f, name.toLowerCase());
    const row = await accept(f.host, f.souls.create(`dev:${name.toLowerCase()}`, {name, description: 'Mover fuzz'}));
    souls[name] = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  }
  await tick();
  const [ax, , az] = f.host.engine.world.entities[souls.Ada.entityId].pose.p;
  god.act({ops: [
    {op: 'place', def: 'core/zone@1', name: 'east', shape: {area: [[ax + 14, az - 2], [ax + 18, az - 2], [ax + 18, az + 2], [ax + 14, az + 2]]}},
    {op: 'place', def: 'core/zone@1', name: 'west', shape: {area: [[ax - 18, az - 2], [ax - 14, az - 2], [ax - 14, az + 2], [ax - 18, az + 2]]}},
  ]});
  await tick(30);
  return {f, edge, god, tick, souls};
}
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const report = {};
for (const what of ['table', 'cottage'])
  test(`mover fuzz (world): the god places a ${what} on a walking Soul's spot`, {timeout: 600000}, async (t) => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
    const tally = report[what] = {cases: 0, refused: 0, overlaps: 0, overlapKinds: {}, halts: 0};
    for (let k = 0; k < 6; k++) {
      const r = rng(1411 + k * 104729), w = await world(t), h = w.f.host, {Ada, Bo} = w.souls;
      await accept(h, w.edge.act(Ada, {capability: k % 2 ? 'walk:east' : 'walk:west'})); await accept(h, w.edge.act(Bo, {capability: k % 2 ? 'walk:west' : 'walk:east'}));
      await w.tick(20 + Math.floor(r() * 40));
      const p = h.engine.world.entities[Ada.entityId].pose.p, at = [p[0] + (r() - 0.5) * 2, p[2] + (r() - 0.5) * 2];
      const rt = h.engine.rt, before = solidOverlapsV1(rt, {objects: []}), made = new Map();
      const res = what === 'table' ? w.god.act({ops: [{op: 'place', def: 'core/table@1', name: `t${k}`, p: at}]}) : w.god.act({ops: [{op: 'place', def: coreRef('cottage'), name: `c${k}`, p: at, r: r() * Math.PI, params: COTTAGE}]});
      tally.cases++; if (res.accepted === false) tally.refused++;
      for (let i = 0; i < 200; i++) { await w.tick(1); for (const o of newOverlapsV1(before, solidOverlapsV1(h.engine.rt, {objects: []}))) made.set(o.kind + '|' + o.subjects.join(), o); }
      if (!h.clockAvailable || h.paused) tally.halts++;
      tally.placed = (tally.placed ?? 0) + (Object.values(h.engine.world.entities).some((e) => e.name === (what === 'table' ? `t${k}` : `c${k}`) || String(e.label ?? '').includes(what === 'table' ? `t${k}` : `c${k}`)) ? 1 : 0);
      tally.near = (tally.near ?? 0) + (Math.hypot(h.engine.world.entities[Ada.entityId].pose.p[0] - at[0], h.engine.world.entities[Ada.entityId].pose.p[2] - at[1]) < 6 ? 1 : 0);
      // canary: the reader sees an overlap in this fixture when there is one
      const q = h.engine.world.entities[Ada.entityId].pose.p, bo = h.engine.world.entities[Bo.entityId], keep = [...bo.pose.p];
      bo.pose.p = [q[0] + 0.05, q[1], q[2]]; if (bo.human) bo.human.level = h.engine.world.entities[Ada.entityId].human.level;
      assert.ok(solidOverlapsV1(h.engine.rt, {objects: []}).some((o) => o.kind === 'body-body'), 'canary: two bodies 5 cm apart are read'); bo.pose.p = keep;
      tally.overlaps += made.size; for (const o of made.values()) tally.overlapKinds[o.kind] = (tally.overlapKinds[o.kind] ?? 0) + 1;
    }
    if (process.env.MOVER_FUZZ_REPORT) console.info('[mover-fuzz-world]', what, JSON.stringify(tally));
    assert.equal(tally.halts, 0, JSON.stringify(tally));
  });

// Slice 1b: the engine's own placements (the ladder's and the god walk-out's), driven directly. Each case aims Ada at a seeded
// spot near a god-built cottage, a table or another Soul, and reads what the placement made. With body-step-guard/1 off and on
// (#1360's validator for bodies). Strict: the aimed spot itself overlaps (what a goal check would refuse up front).
const PLACERS = {
  relocate: (e, id, to) => e.relocateHumanV1(id, to),
  restore: (e, id, to) => e.restoreHumanPoseV1(id, {p: [to[0], 0, to[1]], yaw: 0, level: 0}),
  'god walk-out': (e, id, to) => e.godWalkoutV1(id, to, [], 'relocated'),
};
for (const guard of [false, true])
  test(`mover fuzz (world): the engine's placements aimed at crowded spots, body-step-guard/1 ${guard ? 'on' : 'off'}`, {timeout: 600000}, async (t) => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
    const w = await world(t), h = w.f.host, {Ada, Bo} = w.souls;
    if (guard) await accept(h, h.enableBodyStepGuardV1('test'));
    const [ax, , az] = h.engine.world.entities[Ada.entityId].pose.p;
    w.god.act({ops: [{op: 'place', def: coreRef('cottage'), name: 'hut', p: [ax + 6, az + 6], r: 0, params: COTTAGE}, {op: 'place', def: 'core/table@1', name: 'desk', p: [ax - 4, az + 3]}]});
    await w.tick(10);
    const tallies = {};
    for (const [name, place] of Object.entries(PLACERS)) {
      const tally = tallies[name] = {cases: 0, placed: 0, overlaps: 0, overlapKinds: {}, strictWouldRefuse: 0, strictAndOverlapped: 0, strictPlacedClean: 0};
      for (let k = 0; k < 30; k++) {
        const r = rng(1411 + k * 7919), e = h.engine, ada = e.world.entities[Ada.entityId], home = [...ada.pose.p];
        const anchors = [[ax + 6, az + 6], [ax - 4, az + 3], [...e.world.entities[Bo.entityId].pose.p].filter((_, i) => i !== 1)];
        const a = anchors[k % 3], to = [a[0] + (r() - 0.5) * 6, a[1] + (r() - 0.5) * 6];
        const before = solidOverlapsV1(e.rt, {objects: []});
        ada.pose.p = [to[0], ada.pose.p[1], to[1]];
        const strict = newOverlapsV1(before, solidOverlapsV1(e.rt, {objects: []})).length > 0;
        ada.pose.p = home;
        let ok = false; try { ok = place(e, Ada.entityId, to) !== false; } catch { ok = false; }
        const made = newOverlapsV1(before, solidOverlapsV1(e.rt, {objects: []}));
        tally.cases++; if (ok) tally.placed++;
        tally.overlaps += made.length; for (const o of made) tally.overlapKinds[o.kind] = (tally.overlapKinds[o.kind] ?? 0) + 1;
        if (strict) { tally.strictWouldRefuse++; if (made.length) tally.strictAndOverlapped++; else if (ok) tally.strictPlacedClean++; }
        ada.pose.p = home; e.rt.acknowledgeRelocation?.(Ada.entityId);
      }
    }
    if (process.env.MOVER_FUZZ_REPORT) console.info('[mover-fuzz-placements]', `guard ${guard ? 'on' : 'off'}`, JSON.stringify(tallies));
    if (guard) for (const [name, tally] of Object.entries(tallies)) if (name !== 'god walk-out') assert.equal(tally.overlaps, 0, `${name} under the guard never stands a body in a solid or a body: ${JSON.stringify(tally)}`);
  });
