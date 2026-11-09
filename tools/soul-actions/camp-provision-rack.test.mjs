import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {WorldModel, containerInside} from '../../packages/world-compiler/src/index.ts';
import {TakeRecorder} from '../../mars/viewer/engine/take/recorder.ts';

// #1490: new fixed campsite geometry on the existing storage faculty. Every transfer goes through a discovered
// strict offer, with real engine support and recorded hand motion; no product code knows the rack's name.
test('camp provision rack: strict offers, stocked places, hand clearance, access, interruption, restore and long tail', {timeout: 600000}, async t => {
 const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 t.after(() => {comms.close(); f.host.stop(); f.db.close();});
 const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
 installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
 const tick = async (n = 5) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
 const ok = r => {assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 800)); return r;};
 const souls = {};
 const join = async (key, name) => {await invite(f, key); const r = await accept(f.host, f.souls.create('dev:' + key, {name, description: 'Camp storage test'})); souls[name] = {soulId: r.id, entityId: r.entity_id, name: r.name, owner: r.owner}; await tick();};
 await tick(); await join('ana', 'Ana'); await join('bea', 'Bea'); soul = souls.Ana;
 const ent = name => {const e = [...god.model.entities.values()].find(e => e.name === name); assert.ok(e, name); return e;};
 const id = name => ent(name).id, native = name => f.host.engine.world.entities[id(name)];
 const here = async () => {const r = await app.request('/v1/edge/here?include=doHere'); assert.equal(r.status, 200); return (await r.json()).here;};
 const frame = h => JSON.stringify({...h, tick: 0}), absent = await here();
 const rackDef = god.model.resolvedDef('core/camp-provision-rack@1'), inside = containerInside(rackDef);
 assert.ok(inside); assert.equal(rackDef.components.carryable, undefined, 'a fixed fixture');
 const farOps = Array.from({length: 100}, (_, i) => [
  {op: 'place', def: 'core/camp-provision-rack@1', name: `distant-rack-${i}`, p: [120 + i % 10 * 2, 120 + Math.floor(i / 10) * 2]},
  {op: 'place', def: 'core/bowl@2', name: `distant-bowl-${i}`, in: {parent: `distant-rack-${i}`, slot: 'in-1'}},
 ]).flat();
 ok(god.act({ops: farOps})); await tick(45);
 const far = await here(); assert.equal(frame(far), frame(absent), '100 stocked distant racks add no here bytes or facts');
 const farIds = new Set(farOps.map(op => id(op.name)));
 assert.ok(!edge.capabilities(soul).some(c => c.verb !== 'walk' && (farIds.has(c.object) || farIds.has(c.target?.id))), 'no distant storage offers');
 const idle = new TakeRecorder(f.host.engine.rt, {rulesVersion: 'camp-rack-idle'}); await tick(20);
 assert.ok(!Object.keys(idle.finish().tracks).some(key => farIds.has(key)), 'no idle tracks for racks or contents');

 const body = who => f.host.engine.world.entities[(who ?? soul).entityId], [ax, az] = [body().pose.p[0], body().pose.p[2]];
 ok(god.act({ops: [
  {op: 'place', def: 'core/table@1', name: 'table', p: [ax + 2.4, az - 0.6]},
  ...['one', 'two', 'three', 'four'].map((n, i) => ({op: 'place', def: 'core/bowl@2', name: `bowl-${n}`, in: {parent: 'table', slot: 'top'}, p: [(i % 2 ? 1 : -1) * 0.27, i < 2 ? -0.25 : 0.25]})),
  {op: 'place', def: 'core/table@1', name: 'gear-table', p: [ax + 4.4, az - 0.6]},
  {op: 'place', def: 'core/lantern@3', name: 'lantern', in: {parent: 'gear-table', slot: 'top'}, p: [0, 0], state: {on: false}},
  {op: 'place', def: 'core/camp-provision-rack@1', name: 'camp-rack', p: [ax + 1, az + 2.6], r: Math.PI},
  {op: 'place', def: 'core/camp-provision-rack@1', name: 'private-rack', p: [ax - 2.5, az + 2.6], r: Math.PI, access: 'private', owner: `soul:${souls.Ana.soulId}`},
 ]})); await tick(60);
 const inspect = async name => {const r = await app.request(`/v1/edge/inspect/${id(name)}`); assert.equal(r.status, 200); return (await r.json()).inspect;};
 const act = async (capability, params = {}, who = soul) => {
  const previous = soul; soul = who;
  try {return await (await accept(f.host, app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({strict: true, capability, params})}))).json();}
  finally {soul = previous;}
 };
 const offer = async (name, verb) => {const c = (await inspect(name)).offers.find(c => c.verb === verb); assert.ok(c, `${verb} on ${name}`); assert.deepEqual(c.params ?? {}, {}); return c;};
 const receipt = (r, who = soul) => edge.receipt(who.soulId, r.receipt.id);
 const wait = async (r, watch, who = soul) => {for (let n = 0; n < 1600; n++) {watch?.(); const rc = receipt(r, who); if (['completed', 'failed', 'cancelled', 'replaced'].includes(rc?.phase)) return rc; await tick(1);} throw Error('timed out ' + r.receipt.capability);};
 const done = async (name, verb, watch, who = soul) => {const previous = soul; soul = who; try {const c = await offer(name, verb); assert.equal(c.available, true, JSON.stringify(c)); const r = ok(await act(c.id)); const rc = await wait(r, watch); assert.equal(rc.phase, 'completed', JSON.stringify(rc).slice(0, 800)); return rc;} finally {soul = previous;}};
 const refused = async (name, verb, code, who = soul) => {const previous = soul; soul = who; try {const c = await offer(name, verb); const r = await act(c.id); assert.equal(r.accepted, false); assert.equal(r.code, code, JSON.stringify(r));} finally {soul = previous;}};
 const rackFrame = name => {const wp = god.model.worldPose(ent(name)), c = Math.cos(wp.yaw), s = Math.sin(wp.yaw); return p => [(p[0] - wp.x) * c - (p[2] - wp.z) * s, p[1] - wp.y, (p[0] - wp.x) * s + (p[2] - wp.z) * c];};
 let transferSamples = 0, lipSamples = 0, minLip = Infinity;
 const watch = (itemName, boxName) => () => {
  const transfer = body().human?.itemTransferV1; if (!transfer || transfer.reachTick === undefined) return;
  transferSamples++; const item = native(itemName), local = rackFrame(boxName), p = local(item.pose.p);
  // The held bowl's complete footprint clears the front rail, not only its centre. Its base must remain above the
  // shelf once it enters the tray; neither side nor the fixed back can be crossed below their top edge.
  if (item.support?.kind === 'in-hand') {
   if (Math.abs(p[0]) < 0.695 && p[2] + 0.125 >= 0.24 && p[2] - 0.125 <= 0.27) {minLip = Math.min(minLip, p[1] - inside.lip); lipSamples++; assert.ok(p[1] >= inside.lip, `bowl clears rail: ${JSON.stringify(p)}`);}
   if (p[2] - 0.125 < 0.24) {assert.ok(p[1] >= 1.015 - 0.002, 'above tray floor'); assert.ok(Math.abs(p[0]) + 0.125 <= 0.57 + 0.002, 'clear of tray sides'); assert.ok(p[2] - 0.125 >= -0.24 - 0.002, 'clear of tray back');}
   for (const other of ['bowl-one', 'bowl-two', 'bowl-three']) {if (other === itemName) continue; const o = native(other); if (o.support?.on !== id(boxName)) continue; const q = local(o.pose.p); assert.ok(Math.abs(p[0] - q[0]) >= 0.25 - 0.002 || Math.abs(p[2] - q[2]) >= 0.25 - 0.002 || p[1] >= q[1] + 0.1 - 0.002, 'clear of another stored bowl');}
  }
 };

 assert.ok(!(await inspect('camp-rack')).offers.some(c => c.verb === 'pick-up'), 'no carrying offer for fixed rack');
 for (const [i, name] of ['bowl-one', 'bowl-two', 'bowl-three'].entries()) {
  await done(name, 'pick-up');
  const put = await offer('camp-rack', 'put-in');
  // Malformed params are refused. Unknown parameter names remain a separate failing baseline diagnostic (R3),
  // because the shared storage offer schema currently leaves undeclared names to the plan that reads them.
  if (i === 0) {const before = structuredClone(native(name).support), invalid = await act(put.id, []); assert.equal(invalid.accepted, false); assert.equal(invalid.code, 'capability.params'); assert.deepEqual(native(name).support, before, 'malformed params change nothing');}
  await done('camp-rack', 'put-in', watch(name, 'camp-rack'));
  assert.deepEqual(native(name).support, {kind: 'resting-on', on: id('camp-rack'), slot: `in-${i + 1}`});
  const p = rackFrame('camp-rack')(native(name).pose.p); assert.ok(Math.abs(p[1] - 1.015) < 0.002); assert.ok(Math.abs(p[0] - inside.slots[i].p[0]) < 0.002);
 }
 assert.ok(transferSamples > 20 && lipSamples > 0, 'recorded transfer crosses the rail');
 const stocked = await here(), facts = stocked.objects.find(o => o.id === id('camp-rack'))?.state;
 assert.deepEqual(facts, {holds: ['bowl-one', 'bowl-three', 'bowl-two']});
 assert.deepEqual((await inspect('camp-rack')).contents.map(c => c.id).sort(), ['bowl-one', 'bowl-two', 'bowl-three'].map(id).sort());
 await done('bowl-four', 'pick-up'); await refused('camp-rack', 'put-in', 'container.full'); await done('table', 'put-on');
 await done('lantern', 'pick-up'); await refused('camp-rack', 'put-in', 'item.does-not-fit'); await done('gear-table', 'put-on');

 const restored = WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())), undefined, god.model.library);
 for (const name of ['bowl-one', 'bowl-two', 'bowl-three']) {const e = restored.get(id(name)); assert.equal(e.in.parent, id('camp-rack')); assert.deepEqual(restored.worldPose(e), god.model.worldPose(ent(name)));}
 const clone = factory.restore(f.host.engine.snapshot()); assert.equal(clone.stateHash(), f.host.engine.stateHash());
 for (let i = 0; i < 20; i++) {clone.step(); f.host.engine.step(); assert.equal(clone.stateHash(), f.host.engine.stateHash());}

 // Cancel a take after the hand motion starts but before its custody contact.
 {const c = await offer('bowl-two', 'pick-up'), r = ok(await act(c.id)); for (let n = 0; n < 1600 && !body().human?.itemTransferV1; n++) await tick(1); assert.ok(body().human?.itemTransferV1); assert.equal(native('bowl-two').support.on, id('camp-rack')); ok(await act('stop:current')); await tick(120); assert.equal(receipt(r).phase, 'failed'); assert.equal(receipt(r).code, 'act.stopped'); assert.equal(ent('bowl-two').in.parent, id('camp-rack'));}
 for (const name of ['bowl-three', 'bowl-two', 'bowl-one']) {await done(name, 'pick-up', watch(name, 'camp-rack')); await done('table', 'put-on');}
 await done('bowl-one', 'pick-up', undefined, souls.Bea);
 await refused('private-rack', 'put-in', 'object.private', souls.Bea); await done('table', 'put-on', undefined, souls.Bea);
 await done('bowl-one', 'pick-up'); await done('private-rack', 'put-in'); assert.equal(ent('bowl-one').in.parent, id('private-rack'));
 assert.deepEqual(f.host.engine.runtime.violations, []);
 assert.equal(f.host.glitches.total, 0, 'no recovered or contained engine faults');
 const report = {status: 'pass', hereBytes: {absent: frame(absent).length, distant100: frame(far).length, nearbyStocked: frame(stocked).length}, transferSamples, lipSamples, minLipMargin: minLip, limits: ['fixed fixture; no portability, packing, deployment or cooling']};
 if (process.env.SOUL_ACTIONS_OUT) {mkdirSync(process.env.SOUL_ACTIONS_OUT, {recursive: true}); writeFileSync(`${process.env.SOUL_ACTIONS_OUT}/summary.json`, JSON.stringify(report, null, 2) + '\n');}
 t.diagnostic(JSON.stringify(report));
});

// Pin the advertised maximum, rather than using a short bowl to stand in for a tall fitting thing. All three full-size
// parcels remain real engine items while the next is stocked/retrieved, at two non-cardinal rack turns.
test('camp provision rack: three maximum-fit parcels clear the tray and one another at turns', {timeout: 180000}, async t => {
 const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 t.after(() => {comms.close(); f.host.stop(); f.db.close();});
 const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
 installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
 const tick = async n => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
 await tick(5); await invite(f, 'ana'); const row = await accept(f.host, f.souls.create('dev:ana', {name: 'Ana', description: 'Maximum storage fit test'})); soul = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await tick(5);
 const body = () => f.host.engine.world.entities[soul.entityId], [ax, az] = [body().pose.p[0], body().pose.p[2]];
 const ok = r => {assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 600)); return r;};
 const names = ['parcel-one', 'parcel-two', 'parcel-three'];
 ok(god.act({ops: [
  {op: 'define', def: {schema: 'def/1', name: 'camp-fit-parcel', version: 1, form: 'point', tags: ['item', 'recorded-item'], description: 'A test parcel at the complete advertised storage fit.', make: {kind: 'gen', gen: 'kit/2', args: {round: 0, shapes: [{kind: 'box', at: [0, 0.14, 0], size: [0.3, 0.28, 0.3]}]}}, size: {box: [0.3, 0.28, 0.3]}, components: {carryable: {mass: 0.5, grips: 1}}}},
  {op: 'place', def: 'core/table@1', name: 'table', p: [ax + 2.4, az - 1.2]},
  ...names.map((name, i) => ({op: 'place', def: 'camp-fit-parcel@1', name, in: {parent: 'table', slot: 'top'}, p: [(i - 1) * 0.4, 0]})),
 ]})); await tick(40);
 const ent = name => [...god.model.entities.values()].find(e => e.name === name), id = name => ent(name).id, item = name => f.host.engine.world.entities[id(name)];
 let samples = 0, railSamples = 0, minRail = Infinity, minSide = Infinity;
 const overlap = (a, aa, b, ba, ah = [0.15, 0.15], bh = [0.15, 0.15]) => {
  const axes = a => [[Math.cos(a), Math.sin(a)], [-Math.sin(a), Math.cos(a)]];
  const aa2 = axes(aa), ba2 = axes(ba), d = [a[0] - b[0], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  return [...aa2, ...ba2].every(axis => Math.abs(dot(d, axis)) < aa2.reduce((r, v, i) => r + ah[i] * Math.abs(dot(v, axis)), 0) + ba2.reduce((r, v, i) => r + bh[i] * Math.abs(dot(v, axis)), 0) - 0.001);
 };
 const check = name => {
  if (!body().human?.itemTransferV1 || item(name).support?.kind !== 'in-hand') return;
  const e = item(name), wp = god.model.worldPose(ent('rack')), c = Math.cos(wp.yaw), s = Math.sin(wp.yaw);
  const local = p => [(p[0] - wp.x) * c - (p[2] - wp.z) * s, p[1] - wp.y, (p[0] - wp.x) * s + (p[2] - wp.z) * c];
  const p = local(e.pose.p), yaw = e.pose.yaw + wp.yaw, half = 0.15 * (Math.abs(Math.cos(yaw)) + Math.abs(Math.sin(yaw)));
  samples++;
  if (overlap(p, yaw, [0, 0, 0.255], 0, [0.15, 0.15], [0.57, 0.015])) {railSamples++; minRail = Math.min(minRail, p[1] - 1.095); assert.ok(p[1] >= 1.095, `maximum parcel clears rail ${JSON.stringify({p, yaw})}`);}
  // Test actual finite panel volumes. A transfer starts at the hand beside the source table, which may be far behind
  // the rack; that is not an item inside the tray. Each panel includes its complete height and oriented footprint.
  for (const [panel, at, size] of [
   ['left side', [-0.585, 1.105, 0], [0.03, 0.18, 0.54]], ['right side', [0.585, 1.105, 0], [0.03, 0.18, 0.54]],
   ['back', [0, 1.105, -0.255], [1.14, 0.18, 0.03]], ['rail', [0, 1.055, 0.255], [1.14, 0.08, 0.03]], ['floor', [0, 1, 0], [1.2, 0.03, 0.54]],
  ]) if (p[1] < at[1] + size[1] / 2 - 0.001 && p[1] + 0.28 > at[1] - size[1] / 2 + 0.001) assert.ok(!overlap(p, yaw, at, 0, [0.15, 0.15], [size[0] / 2, size[2] / 2]), `maximum parcel clears ${panel}: ${JSON.stringify({p, yaw})}`);
  if (Math.abs(p[2]) <= 0.05 && Math.abs(p[0]) <= 0.4 && p[1] < 1.195) minSide = Math.min(minSide, 0.57 - Math.abs(p[0]) - half);
  for (const other of names) {const o = item(other); if (other === name || o.support?.on !== id('rack')) continue; const q = local(o.pose.p); assert.ok(p[1] >= q[1] + 0.28 - 0.001 || !overlap(p, yaw, q, o.pose.yaw + wp.yaw), `maximum parcels do not overlap: ${name}, ${other}`);}
 };
 const done = async (name, verb, moving) => {
  const inspected = (await (await app.request(`/v1/edge/inspect/${id(name)}`)).json()).inspect, cap = inspected.offers.find(c => c.verb === verb); assert.ok(cap?.available, JSON.stringify(cap));
  const a = ok(await (await accept(f.host, app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({strict: true, capability: cap.id, params: {}})}))).json());
  for (let n = 0; n < 1600; n++) {if (moving) check(moving); const r = edge.receipt(soul.soulId, a.receipt.id); if (['completed', 'failed', 'cancelled', 'replaced'].includes(r?.phase)) {assert.equal(r.phase, 'completed', JSON.stringify(r).slice(0, 800)); return;} await tick(1);} throw Error('transfer timed out');
 };
 for (const turn of [0.4, 1.9]) {
  ok(god.act({ops: [{op: 'place', def: 'core/camp-provision-rack@1', name: 'rack', p: [ax + 1, az + 3], r: turn}]})); await tick(40);
  for (const name of names) {await done(name, 'pick-up'); await done('rack', 'put-in', name); assert.equal(item(name).support.on, id('rack'));}
  for (const name of [...names].reverse()) {await done(name, 'pick-up', name); await done('table', 'put-on');}
  ok(god.act({ops: [{op: 'remove', id: id('rack')}]})); await tick(20);
 }
 assert.ok(samples > 100 && railSamples > 0); assert.deepEqual(f.host.engine.runtime.violations, []); assert.equal(f.host.glitches.total, 0);
 t.diagnostic(JSON.stringify({maximumSize: [0.3, 0.28, 0.3], turns: [0.4, 1.9], samples, railSamples, minRailMargin: minRail, minSideMargin: minSide}));
});
