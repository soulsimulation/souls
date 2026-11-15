// doors-pass/1 (#2365): a closed, unlocked, hand-operated door is a way through in every world. Ground worlds (paged and
// unpaged) and flat ones: reach and the connectivity audit see the walled yard behind a closed door as joined to the
// world, a plain walk goes through it (Soul Actions entry 31: opened by hand, passed, closed behind), a locked door
// stays a wall refused by name, and a Soul shut in behind a closed door is never lifted out by the rescue.
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {fixture, factory, invite, accept} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {GodMode} from './god.ts';
import {installEngineBridge} from './engine-bridge.ts';
import {GroundHost} from './ground-host.ts';
import {mountEdgeRoutes} from '../edge/routes.ts';
import {Hono} from 'hono';
import {leafDistance} from '../../../../mars/viewer/engine/social/hand-actuator.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Vec2 = [number, number];
type Kind = 'flat' | 'ground-paged' | 'ground-unpaged';
function world(t: TestContext, kind: Kind) {
  const was = process.env.NAV_PAGED;
  if (kind !== 'flat') process.env.NAV_PAGED = kind === 'ground-paged' ? '1' : '0';
  const w = fixture(':memory:', factory, {durableClockV1: true});
  w.brain.quiesce();
  const god = new GodMode(w.db, {worldId: w.host.worldId, ownerId: 'dev:admin', tick: () => w.host.engine.world.tick, emit() {}});
  if (kind !== 'flat') new GroundHost(w.db, w.host, god);
  const edge = new EdgeLedger(w.host, w.db, undefined, {ambient: false}), bridge = installEngineBridge({host: w.host, god, edge, log() {}, worldClock: false, worldLore: false});
  // the edge routes give the ledger its comms (a door's hand contact is recorded as an object act there)
  const comms = mountEdgeRoutes(new Hono(), {host: w.host, db: w.db, souls: w.souls, ledger: edge, soul: () => undefined as never});
  t.after(() => {w.brain.quiesce(); w.host.stop(); comms.close(); w.db.close(); if (was === undefined) delete process.env.NAV_PAGED; else process.env.NAV_PAGED = was;});
  const tick = async (n = 4) => {for (let i = 0; i < n; i++) {w.host.tickOnce(); await setImmediate(); w.host.drainInputs();}};
  const act = (ops: any[]) => {const r = god.act({ops}) as any; assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 600)); return r;};
  return {...w, god, edge, bridge, tick, act, E: w.host.engine as any};
}

/** A walled yard 8 x 6 m with a door in its south wall at (X, Z), facing south; a bench inside, a lamp outside. */
const X = 20, Z = 3;
const yard = (name: string, x: number, w = 0.6) => ({op: 'place', def: 'core/garden-wall@1', name, shape: {path: [[x - w, Z], [x - 4, Z], [x - 4, Z + 6], [x + 4, Z + 6], [x + 4, Z], [x + w, Z]]}});
const INSIDE: Vec2 = [X + 1.5, Z + 4], OUTSIDE: Vec2 = [X + 2.5, Z - 4];

for (const kind of ['ground-unpaged', 'ground-paged', 'flat'] as Kind[]) {
  test(`a closed hand door is a way through (${kind})`, {timeout: 300_000}, async t => {
    const w = world(t, kind); await w.tick(2);
    assert.equal(!!w.E.world.groundV1, kind !== 'flat', 'the world is the kind asked');
    w.act([yard('yard-walls', X), {op: 'place', def: 'core/door@2', name: 'door', p: [X, Z], r: Math.PI},
      {op: 'place', def: 'core/bench@1', name: 'inside-bench', p: INSIDE}, {op: 'place', def: 'core/floor-lamp@2', name: 'outside-lamp', p: OUTSIDE}]);
    await w.tick(20);
    const door = () => w.god.model.get('door') as any;
    assert.equal(door().state.open, false, 'the door stands closed');
    // reach and connectivity: a way through
    const inside: Vec2 = [X - 1.5, Z + 3.5], outside: Vec2 = [X - 1.5, Z - 3];
    const reach = () => w.E.reachV1({p: outside, level: 0}, {p: inside, level: 0});
    const conn = () => w.E.navCheckV1([{id: 'in', p: inside, level: 0, tol: 0.6}])[0];
    assert.equal(reach().ok, true, 'reach through the closed door: ' + JSON.stringify(reach()));
    assert.equal(conn().ok, true, 'the yard is joined to the world: ' + JSON.stringify(conn()));
    // the walk graph still walls the gap: a body never walks through a shut leaf
    assert.equal(w.E.reachesV1(outside, inside), false, 'the shut leaf blocks a plain route');
    // a locked door is a wall
    w.act([{op: 'set', id: 'door', state: {locked: true}}]); await w.tick(4);
    assert.equal(reach().ok, false, 'no reach through a locked door');
    assert.equal(conn().code, 'nav.disconnected', 'a yard behind a locked door is cut off');
    w.act([{op: 'set', id: 'door', state: {locked: false}}]); await w.tick(4);
    assert.equal(conn().ok, true);
    // two Souls, one plain walk act each: in through the closed door and out again, together, both ways
    const souls: Record<string, any> = {};
    for (const name of ['ana', 'bea']) {
      await invite(w, name);
      const row: any = await accept(w.host, w.souls.create('dev:' + name, {name: name[0].toUpperCase() + name.slice(1), description: 'door test'}));
      souls[name] = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await w.tick(3);
    }
    const body = (s: any) => w.E.world.entities[s.entityId];
    const side = (s: any) => (body(s).pose.p[2] > Z ? 'inside' : 'outside');
    const walk = async (s: any, cap: string) => {const r: any = await accept(w.host, w.edge.act(s, {capability: cap})); assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 600)); return r;};
    const finish = async (list: [any, any][], limit = 2400) => {
      for (let n = 0; n < limit; n++) {const ph = list.map(([s, r]) => w.edge.receipt(s.soulId, r.receipt.id)); if (ph.every((p: any) => ['failed', 'completed', 'replaced'].includes(p?.phase))) return ph; await w.tick(1);}
      return list.map(([s, r]) => w.edge.receipt(s.soulId, r.receipt.id));
    };
    const r1 = await walk(souls.ana, 'walk:inside-bench');
    assert.match(r1.receipt.reason ?? '', /Through door/, 'the walk goes through the door by hand');
    const [e1] = await finish([[souls.ana, r1]]);
    assert.equal((e1 as any).phase, 'completed', JSON.stringify(e1).slice(0, 600));
    assert.equal(side(souls.ana), 'inside'); assert.equal(door().state.open, false, 'closed behind');
    // shut in behind a closed door with every destination outside: joined to the world, never lifted out
    assert.equal(w.E.navRescueV1(souls.ana.entityId, Infinity), null, 'no rescue for a Soul behind a closed hand door');
    // both ways at once: Ana out, Bea in
    const ra = await walk(souls.ana, 'walk:outside-lamp'), rb = await walk(souls.bea, 'walk:inside-bench');
    const both = await finish([[souls.ana, ra], [souls.bea, rb]]);
    assert.deepEqual(both.map((x: any) => x.phase), ['completed', 'completed'], JSON.stringify(both).slice(0, 900));
    assert.equal(side(souls.ana), 'outside'); assert.equal(side(souls.bea), 'inside'); assert.equal(door().state.open, false, 'the door ends closed');
    // a locked door on the only way: refused by name, nothing moves
    w.act([{op: 'set', id: 'door', state: {locked: true}}]); await w.tick(4);
    const p0 = [...body(souls.ana).pose.p];
    const locked: any = await accept(w.host, w.edge.act(souls.ana, {capability: 'walk:inside-bench'}));
    assert.equal(locked.accepted, false, JSON.stringify(locked).slice(0, 600)); assert.match(JSON.stringify(locked), /locked/i);
    await w.tick(10); assert.deepEqual(body(souls.ana).pose.p, p0, 'a refusal does not move the body');
  });
}

// A2: the leaf ignores everything but Souls: a thing standing in its swing does not stop a walk through the door.
for (const kind of ['ground-unpaged', 'flat'] as Kind[]) {
  test(`a thing in the swing does not stop the walk (${kind})`, {timeout: 300_000}, async t => {
    const LAMP: Vec2 = [X + 0.62, Z - 0.6];   // beside the hinge, where the open leaf comes to rest
    const w = world(t, kind); await w.tick(2);
    w.act([yard('yard-walls', X), {op: 'place', def: 'core/door@2', name: 'door', p: [X, Z], r: Math.PI},
      {op: 'place', def: 'core/bench@1', name: 'inside-bench', p: INSIDE}, {op: 'place', def: 'core/floor-lamp@2', name: 'swing-lamp', p: LAMP}]);
    await w.tick(20);
    await invite(w, 'ana');
    const row: any = await accept(w.host, w.souls.create('dev:ana', {name: 'Ana', description: 'door test'}));
    const ana = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await w.tick(3);
    const r: any = await accept(w.host, w.edge.act(ana, {capability: 'walk:inside-bench'}));
    assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 600));
    let e: any;
    let opening: any = null;
    for (let n = 0; n < 2400; n++) {e = w.edge.receipt(ana.soulId, r.receipt.id); if (['failed', 'completed', 'replaced'].includes(e?.phase)) break; await w.tick(1); opening ??= w.E.world.entities[ana.entityId].human?.handActuator?.opening ?? null;}
    // the lamp stands in the leaf's sweep (the leaf passes within 0.2 m of its post)
    assert.ok(opening, "the door was opened by hand"); if (process.env.SWING_DEBUG) console.log("OPENING", JSON.stringify(opening));
    const sweep = Math.min(...Array.from({length: 17}, (_, k) => leafDistance(opening, opening.from + (opening.to - opening.from) * k / 16, LAMP[0], LAMP[1])));
    assert.ok(sweep < 0.2, `the lamp is in the swing: ${sweep}`);
    assert.equal(e.phase, 'completed', JSON.stringify(e).slice(0, 600));
    assert.ok(w.E.world.entities[ana.entityId].pose.p[2] > Z, 'inside');
    assert.equal((w.god.model.get('door') as any).state.open, false, 'closed behind');
  });
}

// Review of #2370: entry 31's passage opens ONE door on the ground, so reach, the audit, the offer and the walk count only
// that. An inner room behind two closed doors in series is out of reach in one walk and cut off for the audit, so a Soul
// shut in there is stepped out (nav-connect/1) and walks on; she is never left stuck. The yard between, one door from the
// world, stays joined. Upper floors: doors there stay walls for reach and the audit (not covered yet).
const Z2 = Z + 5;
const OUTER = {op: 'place', def: 'core/garden-wall@1', name: 'outer-walls', shape: {path: [[X - 0.6, Z], [X - 8, Z], [X - 8, Z + 10], [X + 8, Z + 10], [X + 8, Z], [X + 0.6, Z]]}};
const INNER = {op: 'place', def: 'core/garden-wall@1', name: 'inner-walls', shape: {path: [[X - 0.6, Z2], [X - 4, Z2], [X - 4, Z + 9], [X + 4, Z + 9], [X + 4, Z2], [X + 0.6, Z2]]}};
for (const kind of ['ground-unpaged', 'flat'] as Kind[]) {
  test(`two closed doors in series: reach, audit, offer and walk agree; shut in, she gets out (${kind})`, {timeout: 300_000}, async t => {
    const w = world(t, kind); await w.tick(2);
    w.act([OUTER, INNER, {op: 'place', def: 'core/door@2', name: 'door-a', p: [X, Z], r: Math.PI}, {op: 'place', def: 'core/door@2', name: 'door-b', p: [X, Z2], r: Math.PI},
      {op: 'place', def: 'core/bench@1', name: 'inner-bench', p: [X + 1.5, Z + 7.5]}, {op: 'place', def: 'core/bench@1', name: 'yard-bench', p: [X - 6, Z + 2]}, {op: 'place', def: 'core/floor-lamp@2', name: 'outside-lamp', p: OUTSIDE}]);
    await w.tick(20);
    const inRoom: Vec2 = [X - 1.5, Z + 7.5], yardP: Vec2 = [X - 3, Z + 2], out: Vec2 = [X - 1.5, Z - 3];
    const reach = (a: Vec2, b: Vec2) => w.E.reachV1({p: a, level: 0}, {p: b, level: 0}).ok;
    const conn = (p: Vec2) => w.E.navCheckV1([{id: 'p', p, level: 0, tol: 0.6}])[0];
    assert.equal(reach(out, yardP), true, 'one door: reached');
    assert.equal(reach(yardP, inRoom), true, 'one door from the yard: reached');
    assert.equal(reach(out, inRoom), false, 'two doors in series: not one walk');
    assert.equal(reach(inRoom, out), false, 'nor back out');
    assert.equal(conn(yardP).ok, true, 'the yard is one door from the world');
    assert.equal(conn(inRoom).code, 'nav.disconnected', 'the inner room is two doors away');
    await invite(w, 'ana');
    const row: any = await accept(w.host, w.souls.create('dev:ana', {name: 'Ana', description: 'door test'}));
    const ana = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await w.tick(3);
    const body = () => w.E.world.entities[ana.entityId];
    const inInner = () => {const p = body().pose.p; return p[0] > X - 4 && p[0] < X + 4 && p[2] > Z2 && p[2] < Z + 9;};
    const finish = async (r: any) => {for (let n = 0; n < 2400; n++) {const e: any = w.edge.receipt(ana.soulId, r.receipt.id); if (['failed', 'completed', 'replaced'].includes(e?.phase)) return e; await w.tick(1);} return w.edge.receipt(ana.soulId, r.receipt.id);};
    // from outside, the inner bench is not one walk: the act never ends inside the inner room, and it ends
    const r1: any = await accept(w.host, w.edge.act(ana, {capability: 'walk:inner-bench'}));
    if (r1.accepted) {const e = await finish(r1); assert.ok(['failed', 'completed'].includes(e.phase), JSON.stringify(e).slice(0, 400));}
    assert.equal(inInner(), false, 'not through two doors in one walk');
    // shut in the inner room (put there, both doors closed): stepped out, then walks out; never stuck
    await accept(w.host, w.host.enqueue('edge-relocate', 'test:start', {soulId: ana.soulId, entityId: ana.entityId, to: inRoom, why: 'shut in behind two doors'}));
    await w.tick(6); delete body().human.speed;
    assert.ok(inInner(), 'in the inner room');
    assert.ok(w.E.navRescueV1(ana.entityId, Infinity), 'a Soul two doors in is stepped out');
    const r2: any = await accept(w.host, w.edge.act(ana, {capability: 'walk:outside-lamp'}));
    assert.equal(r2.accepted, true, JSON.stringify(r2).slice(0, 600));
    const e2 = await finish(r2);
    assert.equal(e2.phase, 'completed', JSON.stringify(e2).slice(0, 600));
    assert.ok(body().pose.p[2] < Z, 'she ends outside');
  });
}

// Review of #2397, item 4: a long walk across the world into a yard behind a closed hand door. The walk's far ground is
// planned coarsely, so the shut leaf is met only near the end; reach says the way goes through the door, so the walk is
// planned as the passage's legs from the start and arrives inside, on the first try.
for (const kind of ['ground-paged'] as Kind[]) {
  test(`a long walk into a closed yard goes through its door on the first try (${kind})`, {timeout: 300_000}, async t => {
    const w = world(t, kind); await w.tick(2);
    w.act([yard('yard-walls', X), {op: 'place', def: 'core/door@2', name: 'door', p: [X, Z], r: Math.PI},
      {op: 'place', def: 'core/bench@1', name: 'inside-bench', p: INSIDE}]);
    await w.tick(20);
    await invite(w, 'ana');
    const row: any = await accept(w.host, w.souls.create('dev:ana', {name: 'Ana', description: 'door test'}));
    const ana = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await w.tick(3);
    const FAR: Vec2 = [X - 120, Z - 90];
    await accept(w.host, w.host.enqueue('edge-relocate', 'test:start', {soulId: ana.soulId, entityId: ana.entityId, to: FAR, why: 'far away'}));
    await w.tick(6);
    const body = () => w.E.world.entities[ana.entityId];
    assert.ok(Math.hypot(body().pose.p[0] - FAR[0], body().pose.p[2] - FAR[1]) < 1, 'she starts 150 m away');
    w.E.navWarmV1(Infinity);   // the labels warm, as in a running world
    const r: any = await accept(w.host, w.edge.act(ana, {capability: 'walk:inside-bench', params: {gait: 'run'}}));
    assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 600));
    assert.match(r.receipt.reason ?? '', /Through door/, 'planned through the door from the start');
    let e: any;
    for (let n = 0; n < 6000; n++) {e = w.edge.receipt(ana.soulId, r.receipt.id); if (['failed', 'completed', 'replaced'].includes(e?.phase)) break; await w.tick(1);}
    assert.equal(e.phase, 'completed', JSON.stringify(e).slice(0, 600));
    assert.ok(body().pose.p[2] > Z, 'inside the yard');
    assert.equal((w.god.model.get('door') as any).state.open, false, 'closed behind');
  });
}
