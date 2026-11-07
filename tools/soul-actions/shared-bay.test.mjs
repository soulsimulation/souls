// PC17 (#696): six separately owned Souls build a rack bay with a deck and stairs from real stock through the ordinary
// offers. `organize` binds the stock, `inspect` names each ready maneuver's exact offer, `volunteer` is bounded advance
// consent, progress is read from the world. Nothing here calls a privileged actor array.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory as plainFactory, seed, worldId} from '../../apps/server/test/native-owner-fixture.ts';
import {marsFactory, GREEN_FIELD_WORLD} from '../../packages/engine-mars/src/engine.ts';
import {Db} from '../../apps/server/src/db.ts';
import {WorldHost} from '../../apps/server/src/world.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {registerEdgeComms} from '../../apps/server/src/edge/comms/index.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {inspectFrame} from '../../apps/server/src/edge/perception/inspect.ts';
import {hereFrame} from '../../apps/server/src/edge/perception/here.ts';
import {beamBays, frameStability, framesStand, worldPoint} from '../../packages/engine-mars/src/beam-connect.ts';
import {def} from '../../mars/viewer/engine/world/catalog.ts';

const STEP_MS = 50, IN = 0.0254, T = 3 * IN, UP_L = 12 * 0.3048, BEAM_L = 9 * 0.3048, D = BEAM_L + 2 * T, H = D / 2 + UP_L / 2, SPAN = 24 * IN, R = Math.PI / 2;
const PROC = 'rack-bay-build@1';
const factory = await marsFactory({...GREEN_FIELD_WORLD, sharedCarryV1: true});
const log = process.env.BAY_LOG ? (...a) => console.log(...a) : () => {};

function mount(w, host, db, sharedCarry = true) {
  const edge = new EdgeLedger(host, db, undefined, {ambient: false, sharedCarry, now: w.now}), app = new Hono();
  const comms = registerEdgeComms(app, {host, db, souls: w.f.souls, ledger: edge, soul: () => w.current}, {fading: true, beam: true, now: w.now, sweepMs: 0});
  edge.attachComms(comms); comms.fading.addHold((id) => edge.postureHold(id));
  const stream = comms.streams, deliver = stream.deliver.bind(stream); w.told ??= {};
  stream.deliver = (s, k, t, b) => {(w.told[s] ??= []).push(JSON.stringify(b)); return deliver(s, k, t, b);};
  const god = new GodMode(db, {worldId: host.worldId, ownerId: 'dev:admin', tick: () => host.engine.world.tick, emit() {}});
  const bridge = installEngineBridge({host, god, edge, log: () => {}, worldLore: false, worldClock: false});
  Object.assign(w, {host, db, edge, app, comms, god, bridge});
}
async function world(t, {sharedCarry = true, names = ['Ada', 'Bo', 'Cy', 'Dee', 'Eve', 'Fay']} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-bay-')), path = join(dir, 'sim.db');
  const opts = {durableClockV1: true}, f = fixture(path, sharedCarry ? factory : plainFactory, opts); f.brain.quiesce();
  const clock = {now: 1_700_000_000_000}, w = {f, path, opts, clock, now: () => clock.now, current: null};
  t.after(() => {try {w.comms?.close();} catch {} try {w.host.stop();} catch {} try {if (w.db.db.isOpen) w.db.close();} catch {} rmSync(dir, {recursive: true, force: true});});
  mount(w, f.host, f.db, sharedCarry);
  w.tick = async (n = 5) => {for (let i = 0; i < n; i++) {clock.now += STEP_MS; w.host.tickOnce(); if (w.host.clockFailure) throw new Error('HALT ' + String(w.host.clockFailure).slice(0, 300)); await setImmediate(); w.host.drainInputs();}};
  await w.tick();
  const souls = {};
  for (const name of names) {
    await invite(f, name.toLowerCase());
    const row = await accept(f.host, f.souls.create(`dev:${name.toLowerCase()}-owner`, {name, description: 'Rack bay test'}));
    souls[name] = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  }
  await w.tick();
  const E = () => w.host.engine.world.entities, [ax, , az] = E()[souls.Ada.entityId].pose.p;
  w.at = async (s, x, z) => {await accept(w.host, w.host.enqueue('edge-relocate', `test:${s.soulId}`, {soulId: s.soulId, entityId: s.entityId, to: [x, z], why: 'test setup'}));};
  return Object.assign(w, {souls, ax, az, E, idOf: (n) => w.god.model.get(n).id});
}
const act = async (w, s, input) => accept(w.host, w.edge.act(s, input));
const ok = (r) => {assert.notEqual(r.accepted, false, JSON.stringify(r)); return r;};
const until = async (w, done, max) => {for (let n = 0; n < max && !done(); n++) await w.tick(1);};
const zone = (n, x, z, h = 1) => ({op: 'place', def: 'core/zone@1', name: n, shape: {area: [[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h]]}});
/** Lay real stock around a site (name, def, x, z, yaw in the site's frame), the crew beside it, and a place at its middle. */
async function yard(w, {yaw = 0, skip = []} = {}) {
  const xm = w.ax + 11, z0 = w.az, c = Math.cos(yaw), s = Math.sin(yaw), P = (x, z) => [xm + x * c - z * s, z0 + x * s + z * c];
  const stock = [['fa', 'core/rack-upright@2', -H, -3.2, 0], ['fb', 'core/rack-upright@2', H, -3.2, 0],
    ['beam1', 'core/rack-beam@5', 0, -3.9, 0], ['beam3', 'core/rack-beam@3', 0, -4.6, 0], ['beam2', 'core/rack-beam@5', 0, 3.9, 0], ['beam4', 'core/rack-beam@3', 0, 4.6, 0],
    ['j0', 'core/deck-joist@1', -2 * SPAN, -2.5, R], ['j2', 'core/deck-joist@1', 0, -2.5, R], ['j4', 'core/deck-joist@1', 2 * SPAN, -2.5, R], ['j1', 'core/deck-joist@1', -SPAN, 2.5, R], ['j3', 'core/deck-joist@1', SPAN, 2.5, R],
    ['sheet', 'core/plywood-sheet@2', 3.4, -5.4, 0], ['flight', 'core/deck-stair@1', 2.3, 2.4, R],
    ...[1, 2, 3, 4, 5].map((i) => [`tread${i}`, 'core/deck-stair-tread@1', -2.0, 0.9 + 0.4 * i, 0])].filter((x) => !skip.includes(x[0]));
  const at = [[-2, -5.5], [-3, -5.5], [2, -5.5], [3, -5.5], [-1, 5.5], [1, 5.5]];
  for (const [i, s2] of Object.values(w.souls).entries()) if (at[i]) await w.at(s2, ...P(...at[i]));
  ok(w.god.act({ops: [zone('site', xm, z0), zone('apron', ...P(-7, 7)), ...stock.map(([n, def, x, z, r]) => ({op: 'place', def, name: n, p: P(x, z), r: r - yaw}))]}));
  await w.tick(60);
  return {xm, z0, P};
}
const see = (w, s, id) => inspectFrame(w.edge, s, id, {all: true});
const offers = (w, s) => w.edge.capabilitiesPage(s, {all: true}).capabilities;
const open = (w, s) => w.edge.openReceipts(s.soulId);

const walk = async (w, s, place) => ok(await act(w, s, {capability: offers(w, s).find((c) => c.verb === 'walk' && c.id === `walk:${place}`)?.id ?? `walk:${place}`}));
/** Organize, then have every pair take the next ready maneuver `inspect` names, partners answering by their standing agreement. */
async function build(w, host, pairs, {yaw = 0, max = +(process.env.BAY_MAX ?? 9000), each, project} = {}) {
  const pj = project ?? ok(await act(w, host, {capability: `organize:${PROC}`, params: {at: 'site', yaw, with: Object.values(w.souls).filter((s) => s !== host).map((s) => s.name).join(', ')}})).result.project, souls = Object.values(w.souls);
  let section = null;
  const claimed = new Map(), t0 = w.now(), holds = new Map();
  const seconds = () => ((w.now() - t0) / 1000).toFixed(1);
  for (let n = 0; n < max; n++) {
    const v = see(w, host, pj), st = v.state;
    await each?.(st, pj);
    if (st.complete) {log('complete', seconds()); return {pj, seconds: +seconds()};}
    if (st.section && st.section !== section) {if (section) assert.equal(st.nobodyHolds, true, `the ${section} checkpoint holds nothing`); section = st.section; log('section', section, seconds()); for (const s of souls) ok(await act(w, s, {capability: `volunteer:${pj}`, params: {revision: st.revision}}));}
    for (const r of st.ready) {
      if (claimed.has(r.maneuver) || !r.offer) continue;
      if (r.crew === 1) {
        const who = r.offer.startsWith('stop-carry:') ? holds.get(r.part) : pairs.flat().find((s) => !open(w, s).length); if (!who) continue;
        const res = await act(w, who, {capability: r.offer, params: r.params}); log(r.maneuver, who.name, res.accepted === false ? JSON.stringify(res).slice(0, 240) : 'ok', seconds());
        if (res.accepted !== false) claimed.set(r.maneuver, who);
        continue;
      }
      const pair = pairs.find((p) => p.every((s) => !open(w, s).length)); if (!pair) break;
      const res = await act(w, pair[0], {capability: r.offer, params: {...r.params, with: pair[1].name}}); log(r.maneuver, pair[0].name, res.accepted === false ? JSON.stringify(res).slice(0, 300) : 'ok', seconds());
      // told who is in the way, that Soul walks clear by its own ordinary offer
      if (res.accepted === false && /occupied/.test(res.code)) {const by = souls.find((s) => res.reason.includes(s.name)); if (by && !open(w, by).length) await walk(w, by, 'apron');}
      if (res.accepted !== false) {claimed.set(r.maneuver, pair[0]); if (r.offer.startsWith('raise-with:')) holds.set(r.part, pair[0]);}
    }
    // what stopped short of done comes back ready: anyone free takes it up again
    for (const k of [...claimed.keys()]) if (st.ready.some((r) => r.maneuver === k) && !open(w, claimed.get(k)).length) claimed.delete(k);
    await w.tick(5);
  }
  for (const s of souls) log(s.name, w.E()[s.entityId].pose.p.map((v) => v.toFixed(2)).join(','), w.E()[s.entityId].human.activity, JSON.stringify(open(w, s).map((r) => [r.capability, r.phase, r.reason, r.shared?.phase, r.shared?.blocked])).slice(0, 400));
  assert.fail(`no end: ${JSON.stringify(see(w, host, pj).state).slice(0, 900)}`);
}

const CREW = ['Ada', 'Bo', 'Cy', 'Dee', 'Eve', 'Fay'];
for (const yaw of [0, 0.6, 2.356]) test(`R3: six Souls build the bay through the offers they are given, facing ${yaw}, and a Soul who built none of it walks up`, {timeout: 900000}, async (t) => {
  const w = await world(t, {names: [...CREW, 'Gil']}), {Ada, Bo, Cy, Dee, Eve, Fay, Gil} = w.souls;
  const {P} = await yard(w, {yaw});
  await w.at(Gil, ...P(-7, 7));
  // R6: the god joining a part advances the project as a crew would; `each` runs on every read of it
  let godJoined = !!yaw;
  const each = async (st, id) => {
    if (godJoined || !st.ready.some((r) => r.maneuver === 'set-tread-1')) return;
    godJoined = true; const before = st.maneuvers.done;
    const r0 = w.god.act({ops: [{op: 'connect', a: {id: 'tread1', connector: 'seat'}, b: {id: 'flight', connector: 'tread-1'}}]}), at = /flight tread-1 at \(([-\d.]+), ([-\d.]+), ([-\d.]+)\)/.exec(r0.failures?.[0]?.detail ?? '');
    ok(w.god.act({ops: [{op: 'move', id: 'tread1', in: {parent: 'world'}, p: [+at[1], +at[2], +at[3]], r: 0}, {op: 'connect', a: {id: 'tread1', connector: 'seat'}, b: {id: 'flight', connector: 'tread-1'}}]})); await w.tick(10);
    assert.equal(see(w, Ada, id).state.maneuvers.done, before + 1, 'the world says it is done, whoever did it');
  };
  const {pj} = await build(w, Ada, [[Ada, Bo], [Cy, Dee], [Eve, Fay]], {yaw, each});
  const v = see(w, Ada, pj).state;
  assert.equal(glitches(w), 0, 'no fault was recovered on the way');
  assert.equal(v.joints.made, 29); assert.equal(v.complete, true); assert.equal(v.nobodyHolds, true); assert.equal(v.checkpoint, 'deck-stairs');
  const r = await walk(w, Gil, 'sheet'); await until(w, () => ['completed', 'failed', 'replaced'].includes(w.edge.receipt(Gil.soulId, r.receipt.id)?.phase), 3000);
  assert.equal(w.edge.receipt(Gil.soulId, r.receipt.id).phase, 'completed', JSON.stringify(w.edge.receipt(Gil.soulId, r.receipt.id)));
  assert.ok(w.E()[Gil.entityId].pose.p[1] > 0.9, `Gil stands on the deck: ${w.E()[Gil.entityId].pose.p}`);
  // every member has receipts of its own for what it did, and the world's progress follows the world back
  for (const s of [Ada, Bo, Cy, Dee, Eve, Fay]) assert.ok(w.db.db.prepare("SELECT count(*) n FROM edge_receipts_v1 WHERE soul_id=? AND (capability LIKE 'accept:%' OR capability LIKE '%-with:%' OR capability LIKE 'install-tread:%')").get(s.soulId).n > 0, `${s.name} keeps a receipt`);
  ok(w.god.act({ops: [{op: 'remove', id: 'tread3'}]})); await w.tick(20);
  const after = see(w, Ada, pj).state;
  assert.equal(after.complete, false); assert.equal(after.joints.made, 28); assert.equal(after.stairs, false); assert.match(after.missing.join(), /tread-3 is gone/);
});

/** A yard, organized, every Soul at hand. */
async function organized(t, opts = {}) {
  const w = await world(t, opts), {Ada} = w.souls, y = await yard(w, opts);
  const o = ok(await act(w, Ada, {capability: `organize:${PROC}`, params: {at: 'site', with: 'Bo, Cy'}}));
  return {w, pj: o.result.project, ...y};
}
const invitation = (w, r) => w.edge.together.invite(r.receipt.shared.invite);
const answered = (w, r, soul) => invitation(w, r).responses[soul.soulId] === 'accepted';
const ready = (w, s, pj, m) => see(w, s, pj).state.ready.find((x) => x.maneuver === m);
const glitches = (w) => w.db.db.prepare('SELECT count(*) n FROM glitches_v1').get().n;
const heard = (w, s, re) => (w.told[s.soulId] ?? []).some((b) => re.test(b));
async function restart(w) {
  w.comms.close(); w.host.stop(); w.host.drainInputs(); w.host.saveSnapshot(true); w.db.close();
  const db = new Db(w.path), h = new WorldHost(db, factory, seed, 1e9, worldId, w.opts); h.boot(); h.drainInputs(); mount(w, h, db); await w.tick(5);
}
const propose = async (w, host, guest, m, pj, extra = {}) => {const x = ready(w, host, pj, m); assert.ok(x, `${m} is ready: ${JSON.stringify(see(w, host, pj).state.ready)}`); return ok(await act(w, host, {capability: x.offer, params: {...x.params, ...extra, with: guest.name}}));};

test('R2: organize refuses before anyone is asked: stock short, site blocked, unknown place', {timeout: 120000}, async (t) => {
  const w = await world(t), {Ada} = w.souls;
  assert.ok(!offers(w, Ada).some((c) => ['organize', 'volunteer', 'leave-project', 'revise-project'].includes(c.verb)), 'a world with no stock and no project gains nothing');
  assert.equal(hereFrame(w.edge, Ada).projects, undefined);
  await yard(w, {skip: ['fb']});
  const no = await act(w, Ada, {capability: `organize:${PROC}`, params: {at: 'site'}});
  assert.equal(no.code, 'project.stock-short', JSON.stringify(no)); assert.match(no.reason, /core\/rack-upright@2/);
  assert.equal((await act(w, Ada, {capability: `organize:${PROC}`, params: {at: 'nowhere at all'}})).code, 'project.unknown-place');
  ok(w.god.act({ops: [{op: 'place', def: 'core/rack-upright@2', name: 'fb', p: [w.ax + 11 + H, w.az - 3.2]}, {op: 'place', def: 'core/door@2', name: 'door', p: [w.ax + 11, w.az + 0.5]}]})); await w.tick(20);
  const blocked = await act(w, Ada, {capability: `organize:${PROC}`, params: {at: 'site'}});
  assert.equal(blocked.code, 'project.site-blocked', JSON.stringify(blocked)); assert.match(blocked.reason, /door/);
  assert.equal(w.db.db.prepare('SELECT count(*) n FROM edge_projects_v1').get().n, 0, 'no row');
});

test('R7: an agreement answers a ready maneuver of its section, on the Soul\'s own receipt, and nothing else', {timeout: 240000}, async (t) => {
  const {w, pj} = await organized(t), {Ada, Bo, Cy, Dee} = w.souls;
  const revision = see(w, Ada, pj).state.revision;
  ok(await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision, section: 'stock', maneuvers: 1}}));
  // not ready: this beam waits for the joists
  const beam = w.idOf('beam1');
  const off = ok(await act(w, Ada, {capability: `carry-with:${beam}`, params: {to: `project:${pj}`, with: 'Bo'}})); await w.tick(30);
  assert.equal(answered(w, off, Bo), false, 'a maneuver not ready stays an ordinary invitation');
  ok(await act(w, Ada, {capability: `withdraw:${off.receipt.shared.invite}`}));
  // a load off the plan: the same frame to another place
  const frame = w.idOf('fa');
  const away = ok(await act(w, Ada, {capability: `carry-with:${frame}`, params: {to: 'apron', with: 'Bo'}})); await w.tick(30);
  assert.equal(answered(w, away, Bo), false, 'off the plan stays an ordinary invitation');
  ok(await act(w, Ada, {capability: `withdraw:${away.receipt.shared.invite}`}));
  // the plan: answered, on Bo's own receipt, and Bo hears of it
  const p = await propose(w, Ada, Bo, 'carry-upright-a', pj); await until(w, () => answered(w, p, Bo), 40);
  assert.equal(answered(w, p, Bo), true, 'answered by the agreement');
  const mine = invitation(w, p).guestReceipts[Bo.soulId]; assert.equal(w.edge.receipt(Bo.soulId, mine).capability, `accept:${p.receipt.shared.invite}`);
  assert.equal(see(w, Ada, pj).members.length, 0, 'one maneuver stated, one spent');
  assert.ok(heard(w, Bo, /Your agreement answered Ada/), 'and Bo is told');
  // spent: the next stays open
  const q = await propose(w, Cy, Bo, 'carry-upright-b', pj); await w.tick(40);
  assert.equal(answered(w, q, Bo), false, 'consent spent'); ok(await act(w, Cy, {capability: `withdraw:${q.receipt.shared.invite}`}));
  // another section
  ok(await act(w, Dee, {capability: `volunteer:${pj}`, params: {revision, section: 'frames'}}));
  const r = await propose(w, Cy, Dee, 'carry-upright-b', pj); await w.tick(30);
  assert.equal(answered(w, r, Dee), false, 'another section'); ok(await act(w, Cy, {capability: `withdraw:${r.receipt.shared.invite}`}));
  // left: at once
  ok(await act(w, Dee, {capability: `volunteer:${pj}`, params: {revision, section: 'stock'}})); ok(await act(w, Dee, {capability: `leave-project:${pj}`}));
  const u = await propose(w, Cy, Dee, 'carry-upright-b', pj); await w.tick(30);
  assert.equal(answered(w, u, Dee), false, 'left'); ok(await act(w, Cy, {capability: `withdraw:${u.receipt.shared.invite}`}));
  // the bound holds whichever way the act arrives
  assert.equal((await act(w, Dee, {capability: `volunteer:${pj}`, params: {revision, maneuvers: 100000}})).code, 'capability.params');
  assert.equal((await act(w, Dee, {capability: `volunteer:${pj}`, params: {revision, expires: 100000000}})).code, 'capability.params');
  // expired
  ok(await act(w, Dee, {capability: `volunteer:${pj}`, params: {revision, section: 'stock', expires: 60}})); await w.tick(60 * 20 + 40);
  assert.equal(see(w, Cy, pj).members.some((m) => m.soulId === Dee.soulId), false, 'expired');
});

test('R7: a busy or faraway volunteer is not started; the invitation stays open', {timeout: 240000}, async (t) => {
  const {w, pj, P} = await organized(t), {Ada, Bo, Cy, Dee} = w.souls;
  const revision = see(w, Ada, pj).state.revision;
  for (const s of [Bo, Dee]) ok(await act(w, s, {capability: `volunteer:${pj}`, params: {revision}}));
  ok(await act(w, Bo, {capability: 'clap:here', params: {seconds: 8}}));
  const p = await propose(w, Ada, Bo, 'carry-upright-a', pj); await w.tick(30);
  assert.equal(answered(w, p, Bo), false, 'busy clapping'); assert.equal(invitation(w, p).state, 'pending');
  await until(w, () => answered(w, p, Bo), 400); assert.equal(answered(w, p, Bo), true, 'once free, it is answered');
  await w.at(Dee, w.ax + 30, w.az); await w.tick(5);
  assert.ok(w.E()[Dee.entityId].pose.p[0] > w.ax + 25, 'Dee is far');
  const q = await propose(w, Cy, Dee, 'carry-upright-b', pj); await w.tick(40);
  assert.equal(answered(w, q, Dee), false, 'too far'); assert.equal(invitation(w, q).state, 'pending');
  assert.notEqual(w.E()[Dee.entityId].human.activity, 'walk', 'and it moved nobody');
});

test('R8: a material revision asks everyone again; a like-for-like swap does not', {timeout: 240000}, async (t) => {
  const {w, pj} = await organized(t), {Ada, Bo, Cy, Fay} = w.souls;
  ok(await act(w, Fay, {capability: `volunteer:${pj}`, params: {revision: 1}}));
  ok(w.god.act({ops: [{op: 'place', def: 'core/rack-beam@5', name: 'spare5', p: [w.ax + 11, w.az - 6]}, {op: 'place', def: 'core/rack-beam@4', name: 'spare4', p: [w.ax + 11, w.az - 7]}]})); await w.tick(20);
  ok(await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision: 1}}));
  const same = ok(await act(w, Ada, {capability: `revise-project:${pj}`, params: {part: 'beam-high-r', entity: w.idOf('spare5')}}));
  assert.equal(same.result.material, false); assert.equal(see(w, Ada, pj).state.revision, 1); assert.equal(see(w, Ada, pj).members.length, 2, 'the agreements stand');
  const other = ok(await act(w, Ada, {capability: `revise-project:${pj}`, params: {part: 'beam-high-l', entity: w.idOf('spare4')}}));
  assert.equal(other.result.material, true); assert.equal(see(w, Ada, pj).state.revision, 2); assert.equal(see(w, Ada, pj).members.length, 0, 'every agreement lapsed');
  await w.at(Fay, w.ax - 25, w.az); await w.tick(5);
  assert.equal((await act(w, Fay, {capability: `volunteer:${pj}`, params: {revision: 1}})).code, 'project.revision-changed', 'out of sight, Fay still hears why');
  ok(await act(w, Fay, {capability: `volunteer:${pj}`, params: {revision: 2}}));
  assert.ok(heard(w, Bo, /beam-high-l is now core\/rack-beam@4/), 'Bo is told what changed');
  const stale = await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision: 1}});
  assert.equal(stale.code, 'project.revision-changed'); assert.match(stale.reason, /revision 2/); assert.match(stale.reason, /beam-high-l/);
  ok(await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision: 2}}));
  // an invitation made for the old site isn't what the plan calls for after it moves, whoever agrees to the new one
  const old = await propose(w, Ada, Cy, 'carry-upright-a', pj);
  const moved = ok(await act(w, Ada, {capability: `revise-project:${pj}`, params: {yaw: 0.3}}));
  assert.equal(moved.result.revision, 3); assert.equal(see(w, Ada, pj).members.length, 0);
  ok(await act(w, Cy, {capability: `volunteer:${pj}`, params: {revision: 3}})); await w.tick(30);
  assert.equal(answered(w, old, Cy), false, 'the spot it names is not the plan any more');
  ok(await act(w, Ada, {capability: `withdraw:${old.receipt.shared.invite}`}));
  // a volunteer who is out of sight still has the refusal and the way back
  const far = await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision: 2}});
  assert.equal(far.code, 'project.revision-changed', JSON.stringify(far));
  const elsewhere = ok(await act(w, Ada, {capability: `revise-project:${pj}`, params: {at: 'apron'}}));
  assert.equal(elsewhere.result.revision, 4); assert.match(see(w, Ada, pj).state.changed, /Apron|apron/);
  assert.equal((await act(w, Bo, {capability: `revise-project:${pj}`, params: {yaw: 0}})).accepted, false, 'only its organizer is offered that');
});

test('R9, R10, R11: inspect is enough, a far Soul gains nothing, a volunteer stays their own, and it all survives a restart', {timeout: 240000}, async (t) => {
  const {w, pj, P} = await organized(t), {Ada, Bo, Fay} = w.souls;
  const frame = inspectFrame(w.edge, Ada, pj);
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 4096, 'within the budget');
  assert.equal(frame.kind, 'project'); assert.equal(frame.state.blueprint, 'rack-bay@1'); assert.equal(frame.state.procedure, PROC); assert.equal(frame.state.section, 'stock');
  const first = frame.state.ready[0]; assert.match(first.offer, /^carry-with:/); assert.equal(first.params.to, `project:${pj}`);
  assert.ok(offers(w, Ada).some((c) => c.id === first.offer), 'the exact offer is on the menu');
  const line = hereFrame(w.edge, Ada).projects; assert.equal(line.length, 1); assert.match(line[0], /0 of 32 maneuvers/);
  // far away: nothing in here or the menu, even with a hundred things 100 m off
  ok(w.god.act({ops: Array.from({length: 100}, (_, i) => ({op: 'place', def: 'core/rack-beam@3', name: `far${i}`, p: [w.ax + 110 + (i % 10) * 3, w.az + 80 + Math.floor(i / 10) * 3]}))})); await w.tick(10);
  await w.at(Fay, w.ax - 25, w.az); await w.tick(10);
  assert.ok(Math.hypot(w.E()[Fay.entityId].pose.p[0] - w.ax - 11, w.E()[Fay.entityId].pose.p[2] - w.az) > 30, `Fay is far: ${w.E()[Fay.entityId].pose.p}`);
  assert.equal(hereFrame(w.edge, Fay).projects, undefined);
  const menu = offers(w, Fay).map((c) => c.verb); for (const v of ['organize', 'volunteer', 'revise-project', 'leave-project']) assert.ok(!menu.includes(v), v);
  assert.throws(() => inspectFrame(w.edge, Fay, pj), /not an id/);
  // a volunteer's own acts go on as ever
  ok(await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision: 1}}));
  const clap = ok(await act(w, Bo, {capability: 'clap:here', params: {seconds: 2}})); await until(w, () => w.edge.receipt(Bo.soulId, clap.receipt.id).phase === 'completed', 200);
  assert.equal(w.edge.receipt(Bo.soulId, clap.receipt.id).phase, 'completed');
  w.current = Bo;
  const spoke = await (await accept(w.host, w.app.request('/v1/edge/converse', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({op: 'start', with: [Ada.soulId], text: 'Ready when you are.'})}))).json();
  assert.ok(spoke.conversation, `a volunteer talks as ever: ${JSON.stringify(spoke).slice(0, 200)}`);
  const say = w.db.db.prepare('SELECT count(*) n FROM edge_receipts_v1 WHERE soul_id=?').get(Bo.soulId).n;
  // a maneuver done, then a restart: the reading is the same
  const p = await propose(w, Ada, Bo, 'carry-upright-a', pj); await until(w, () => see(w, Ada, pj).state.maneuvers.done === 1, 1200);
  assert.equal(see(w, Ada, pj).state.maneuvers.done, 1); assert.ok(p);
  assert.ok(w.db.db.prepare('SELECT count(*) n FROM edge_receipts_v1 WHERE soul_id=?').get(Bo.soulId).n > say, 'the maneuver is on Bo\'s own receipts');
  await until(w, () => !open(w, Ada).length && !open(w, Bo).length, 400); await w.tick(20);
  const before = JSON.stringify(see(w, Ada, pj).state);
  await restart(w);
  assert.equal(JSON.stringify(see(w, Ada, pj).state), before, 'the same reading after a restart');
  assert.equal(see(w, Ada, pj).members.length, 1, 'the agreement too');
  // the budget holds however many have agreed
  for (let i = 0; i < 40; i++) w.bridge.projects.rows.get(pj).consents[`s_fake${i}`] = {name: `Volunteer ${i}`, section: 'stock', revision: 1, left: 5, expiresTick: 1e9};
  const crowded = inspectFrame(w.edge, Ada, pj); assert.ok(Buffer.byteLength(JSON.stringify(crowded)) <= 4096, 'within the budget'); assert.ok(crowded.more.members > 0, 'and it says how many it left out');
});

test('R5: a crew stops short of another crew\'s load, by name', {timeout: 120000}, async (t) => {
  const {w, pj} = await organized(t), {Ada, Bo, Cy, Dee} = w.souls, beam = w.idOf('beam1'), other = w.idOf('beam3');
  // two crews, one load across the other's way: the first carries to the far side of the second's load
  const a = ok(await act(w, Ada, {capability: `carry-with:${other}`, params: {to: 'apron', with: 'Bo'}}));
  ok(await act(w, Bo, {capability: `accept:${a.receipt.shared.invite}`, params: {revision: 1}}));
  const b = ok(await act(w, Cy, {capability: `carry-with:${beam}`, params: {to: 'apron', with: 'Dee'}}));
  ok(await act(w, Dee, {capability: `accept:${b.receipt.shared.invite}`, params: {revision: 1}}));
  const named = new Set();
  for (let i = 0; i < 1500 && [a, b].some((x) => invitation(w, x).shared.op?.phase !== 'ended'); i++) {await w.tick(1); for (const r of w.host.engine.rt.records.values()) if (r.verb === 'carry' && r.status === 'blocked' && r.diagnostic?.code) named.add(r.diagnostic.code);}
  // this says crews wait, by name, rather than fault; which hold fired is pinned in mars/viewer/engine/test/crew-clearance.test.ts
  assert.ok(named.has('carry.path-occupied') || named.has('carry.pickup-occupied'), `a named wait, not a fault: ${[...named]}`);
  assert.equal(w.host.clockFailure, undefined); assert.ok(pj);
});

for (const [yaw, when] of [[0, 'back'], [0.6, 'lift'], [0.6, 'back'], [2.356, 'lift'], [2.356, 'back']]) test(`R4: a stop of a flight's lift (${when}, facing ${yaw}) lowers it, says so, and leaves nobody inside it`, {timeout: 300000}, async (t) => {
  const w = await world(t), {Ada, Bo, Cy, Dee, Eve, Fay} = w.souls; await yard(w, {yaw});
  const rt = w.host.engine.rt, tick = w.tick; let done = null;
  w.tick = async (n = 5) => {
    for (let i = 0; i < n; i++) {
      await tick(1);
      const l = [...rt.live.values()].find((x) => x.rec.verb === 'install_flight_v1' && (when === 'back' ? x.exec?.backing : x.exec?.phase === 'lift' && x.exec.t > 0.5));
      if (l && !done) {
        const s = Object.values(w.souls).find((x) => x.entityId === l.exec.crew[0]), run = w.edge.together.sharedRunning(s.soulId);
        ok(await act(w, s, {capability: `stop-carry:${run.op}`})); done = {s, part: w.E()[l.exec.part]}; await tick(400);
        throw new Error('stopped');
      }
    }
  };
  await assert.rejects(build(w, Ada, [[Ada, Bo], [Cy, Dee], [Eve, Fay]], {yaw}), /stopped/);
  assert.equal(w.E()[done.part.id].phase, 'staged'); assert.ok(heard(w, done.s, /flight was lowered back/), 'the crew hears what happened'); assert.equal(w.host.clockFailure, undefined);
  assert.equal(glitches(w), 0, 'no fault, no recovery');
});

test('R5: someone busy behind a flight\'s crew holds them by name, and a stop lowers it: no fault on a real host', {timeout: 300000}, async (t) => {
  const w = await world(t, {names: [...CREW, 'Gil']}), {Ada, Bo, Cy, Dee, Eve, Fay, Gil} = w.souls, {P} = await yard(w);
  const rt = w.host.engine.rt, tick = w.tick; let placed = false, done = null;
  w.tick = async (n = 5) => {
    for (let i = 0; i < n; i++) {
      await tick(1);
      if (!placed && [...rt.live.values()].some((x) => x.rec.verb === 'install_flight_v1' && x.exec?.phase === 'lift')) {placed = true; await w.at(Gil, ...P(0, 2.7)); w.E()[Gil.entityId].human.task = 'somebody-else';}
      const l = [...rt.live.values()].find((x) => x.exec?.backing && x.rec.status === 'blocked');
      if (l && !done) {
        const s = Object.values(w.souls).find((x) => x.entityId === l.exec.crew[0]), run = w.edge.together.sharedRunning(s.soulId);
        done = {code: l.rec.diagnostic?.code, part: w.E()[l.exec.part], s};
        ok(await act(w, s, {capability: `stop-carry:${run.op}`})); await tick(300);
        throw new Error('stopped');
      }
    }
  };
  await assert.rejects(build(w, Ada, [[Ada, Bo], [Cy, Dee], [Eve, Fay]]), /stopped/);
  assert.equal(done.code, 'lift.crew-blocked'); assert.equal(done.part.phase, 'staged'); assert.equal(glitches(w), 0, 'no recovery, no fault'); assert.ok(heard(w, done.s, /flight was lowered back/));
});

test('R5: the amend a refusal recommends keeps a project\'s raise where the blueprint says', {timeout: 120000}, async (t) => {
  const {w, pj} = await organized(t), {Ada} = w.souls, frame = w.idOf('fa');
  const r = ok(await act(w, Ada, {capability: `raise-with:${frame}`, params: {project: pj, with: 'Bo'}})), inv = r.receipt.shared.invite, base = w.edge.together.invite(inv).shared.base;
  assert.ok(base); ok(await act(w, Ada, {capability: `raise-with:${frame}`, params: {with: 'Cy', invite: inv}}));
  assert.deepEqual(w.edge.together.invite(inv).shared.base, base);
});

test('R6: editing the row cannot complete it', {timeout: 120000}, async (t) => {
  const {w, pj} = await organized(t), {Ada} = w.souls, row = w.db.db.prepare('SELECT body FROM edge_projects_v1 WHERE project_id=?').get(pj);
  assert.ok(!/progress|complete|done/.test(row.body), 'the row stores no progress');
  w.db.db.prepare('UPDATE edge_projects_v1 SET body=? WHERE project_id=?').run(JSON.stringify({...JSON.parse(row.body), complete: true, done: 32}), pj);
  await restart(w);
  const v = see(w, Ada, pj).state; assert.equal(v.complete, false); assert.equal(v.maneuvers.done, 0);
});

test('R4: any member can stop a maneuver: the load is laid down, nobody holds it, and the work is ready again', {timeout: 120000}, async (t) => {
  const {w, pj} = await organized(t), {Ada, Bo} = w.souls, frame = w.idOf('fa');
  ok(await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision: 1}}));
  const p = await propose(w, Ada, Bo, 'carry-upright-a', pj), id = p.receipt.shared.invite;
  await until(w, () => w.E()[frame].support?.kind === 'held', 900); assert.equal(w.E()[frame].support.kind, 'held');
  await w.tick(40);
  ok(await act(w, Bo, {capability: `stop-carry:${w.edge.together.invite(id).shared.op.id}`}));
  await until(w, () => w.edge.together.invite(id).shared.op.phase === 'ended', 800);
  await until(w, () => see(w, Ada, pj).state.nobodyHolds, 200);
  const v = see(w, Ada, pj).state; assert.equal(v.nobodyHolds, true); assert.equal(v.maneuvers.done, 0);
  assert.ok(v.ready.some((r) => r.maneuver === 'carry-upright-a'), 'it can be taken up again');
});

test('R5: a crew waits with a named hold for someone at its lift, and stops dead for someone on its way', {timeout: 120000}, async (t) => {
  const {w, pj, P} = await organized(t), {Ada, Bo, Fay} = w.souls, frame = w.idOf('fa'), at = w.E()[frame].pose.p;
  await w.at(Fay, at[0] + 0.9, at[2] + 0.5); await w.tick(3);
  ok(await act(w, Fay, {capability: 'clap:here', params: {seconds: 30}}));
  ok(await act(w, Bo, {capability: `volunteer:${pj}`, params: {revision: 1}}));
  const p = await propose(w, Ada, Bo, 'carry-upright-a', pj), blockedBy = () => w.edge.receipt(Ada.soulId, p.receipt.id).shared?.blocks ?? [];
  await until(w, () => blockedBy().some((b) => b.code === 'carry.pickup-occupied'), 900);
  assert.ok(blockedBy().some((b) => b.code === 'carry.pickup-occupied'), JSON.stringify(w.edge.receipt(Ada.soulId, p.receipt.id).shared));
  assert.notEqual(w.E()[frame].support?.kind, 'held', 'it does not leave the ground');
  // she goes; it lifts, and someone stepping onto its way stops it where it is
  ok(await act(w, Fay, {capability: 'walk:apron'}));
  await until(w, () => w.E()[frame].support?.kind === 'held', 900); assert.equal(w.E()[frame].support.kind, 'held');
  const spot = P(-H, 0), q = w.E()[frame].pose.p;
  await w.at(Fay, (q[0] + spot[0]) / 2, (q[2] + spot[1]) / 2); await w.tick(2);
  ok(await act(w, Fay, {capability: 'sit-ground:here', params: {seconds: 60}}));
  // it stands still where it is, the bystander is asked to step aside, and it goes on: never a body in the load
  const named = new Set();
  for (let i = 0; i < 900 && w.edge.together.invite(p.receipt.shared.invite).shared.op?.phase !== 'ended'; i++) {await w.tick(1); for (const r of w.host.engine.rt.records.values()) if (r.verb === 'carry' && r.status === 'blocked' && r.diagnostic?.code) named.add(r.diagnostic.code);}
  assert.ok(named.has('carry.path-occupied'), `the hold is named: ${[...named]}`);
  assert.equal(w.edge.together.invite(p.receipt.shared.invite).shared.op.result, 'arrived');
  assert.equal(w.host.clockFailure, undefined, 'the world goes on');
});

test('R11: a restart past the frames checkpoint reads the same, the crew finishes the bay, and another restart reads it finished', {timeout: 900000}, async (t) => {
  const w = await world(t), {Ada, Bo, Cy, Dee, Eve, Fay} = w.souls, crew = [[Ada, Bo], [Cy, Dee], [Eve, Fay]]; await yard(w);
  let pj = null;
  await assert.rejects(build(w, Ada, crew, {each: async (st, id) => {pj = id; if (st.checkpoint === 'frames') throw new Error('checkpoint');}}), /checkpoint/);
  await until(w, () => Object.values(w.souls).every((s) => !open(w, s).length), 600);
  const before = see(w, Ada, pj).state, frame = w.bridge.projects.rows.get(pj).bound['upright-a'];
  assert.equal(w.E()[frame].support.kind, 'connected'); assert.equal(before.checkpoint, 'frames');
  await restart(w);
  const after = see(w, Ada, pj).state;
  assert.equal(w.E()[frame].support.kind, 'ground', 'a boot keeps nothing: the model has no word for it');
  assert.equal(frameStability(w.host.engine.world, w.E()[frame]).stable, true, 'and it stands on its beams all the same');
  assert.deepEqual([after.maneuvers.done, after.checkpoint, after.section, after.joints], [before.maneuvers.done, 'frames', before.section, before.joints]);
  await build(w, Ada, crew, {project: pj});
  assert.equal(glitches(w), 0);
  await restart(w);
  const end = see(w, Ada, pj).state; assert.equal(end.complete, true); assert.equal(end.joints.made, 29); assert.equal(end.checkpoint, 'deck-stairs');
});

test('R11: a frame that took another beam after its release reads the same, re-derived and across a restart', {timeout: 900000}, async (t) => {
  const w = await world(t), {Ada, Bo, Cy, Dee, Eve, Fay} = w.souls, crew = [[Ada, Bo], [Cy, Dee], [Eve, Fay]], {P} = await yard(w);
  ok(w.god.act({ops: [{op: 'place', def: 'core/rack-beam@5', name: 'beam5', p: P(-9, 9), r: 0}]})); await w.tick(20);
  let pj = null;
  await assert.rejects(build(w, Ada, crew, {each: async (st, id) => {pj = id; if (st.checkpoint === 'frames') throw new Error('checkpoint');}}), /checkpoint/);
  await until(w, () => Object.values(w.souls).every((s) => !open(w, s).length), 600);
  const frame = w.bridge.projects.rows.get(pj).bound['upright-a'], extra = w.idOf('beam5'), joints = w.E()[frame].connections.length;
  // a fifth beam, by the ordinary offer: it lies under a free pair of seats
  ok(w.god.act({ops: [{op: 'move', id: 'beam5', p: P(0, 2.9), r: 0}]})); await w.tick(30);
  const bay = beamBays(w.host.engine.world, extra, 3.5)[0]; assert.ok(bay, 'a free pair of seats is offered');
  const seat = (u, id) => worldPoint(w.E()[u], def(w.E()[u].def).sockets.find((q) => q.id === id).local), qa = seat(bay.a, bay.seats[0]), qb = seat(bay.b, bay.seats[1]), mx = (qa[0] + qb[0]) / 2, mz = (qa[2] + qb[2]) / 2;
  ok(w.god.act({ops: [{op: 'move', id: 'beam5', p: [mx, mz + Math.sign(mz - w.az) * 0.7], r: 0}]})); await w.tick(30);
  for (const s of [Cy, Dee]) await w.at(s, ...P(-1, 2)); await w.tick(10);
  const r = ok(await act(w, Ada, {capability: `connect-beam-with:${extra}`, params: {column: bay.column, height: bay.height, with: 'Bo'}}));
  ok(await act(w, Bo, {capability: `accept:${r.receipt.shared.invite}`, params: {revision: r.receipt.shared.revision ?? 1}}));
  await until(w, () => w.E()[extra].phase === 'installed' && !open(w, Ada).length, 3000); await w.tick(60);
  assert.equal(w.E()[frame].connections.length, joints + 1, 'it joined the frame');
  const reading = () => {const st = see(w, Ada, pj).state; return [st.checkpoint, st.section, st.maneuvers.done];}, was = reading();
  assert.equal(was[0], 'frames');
  // a re-derive of the frame, by hand: nothing here edited it, and any edit that touches it derives it the same way
  w.bridge.pending.add(frame); w.bridge.flush(); await w.tick(5);
  assert.equal(w.E()[frame].support.kind, 'ground'); assert.deepEqual(reading(), was);
  await restart(w);
  assert.deepEqual(reading(), was);
  assert.equal(glitches(w), 0);
});

// a god re-seats a recorded beam, in one batch, on the same two frames. `released` builds to the frames checkpoint with a fifth
// beam by, whose free seats are the ones to go to.
async function released(t) {
  const w = await world(t), {Ada, Bo, Cy, Dee, Eve, Fay} = w.souls, crew = [[Ada, Bo], [Cy, Dee], [Eve, Fay]], {P} = await yard(w);
  ok(w.god.act({ops: [{op: 'place', def: 'core/rack-beam@5', name: 'beam5', p: P(-9, 9), r: 0}]})); await w.tick(20);
  let pj = null;
  await assert.rejects(build(w, Ada, crew, {each: async (st, id) => {pj = id; if (st.checkpoint === 'frames') throw new Error('checkpoint');}}), /checkpoint/);
  await until(w, () => Object.values(w.souls).every((s) => !open(w, s).length), 600);
  ok(w.god.act({ops: [{op: 'move', id: 'beam5', p: P(0, 2.9), r: 0}]})); await w.tick(30);
  const {bound} = w.bridge.projects.rows.get(pj), frames = [bound['upright-a'], bound['upright-b']], bays = beamBays(w.host.engine.world, w.idOf('beam5'), 3.5);
  assert.deepEqual(frames.map((f) => w.E()[f].support.kind), ['connected', 'connected']);
  return {w, pj, frames, bays};
}
const seatAt = (w, u, id) => worldPoint(w.E()[u], def(w.E()[u].def).sockets.find((q) => q.id === id).local);
const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
/** The ops that take a beam of column `from` at its highest out of its seats and put it in `bay`. */
function reseatOps(w, [fa, fb], from, bay) {
  const m = w.god.model, seat = (f) => (f === bay.a ? bay.seats[0] : bay.seats[1]);
  const beam = w.E()[fa].connections.find((c) => c.socket.includes(`-${from}-`)).to, e = m.entities.get(beam), ends = Object.entries(e.joins).filter(([, j]) => j.to === fa || j.to === fb);
  const was = mid(...ends.map(([, j]) => seatAt(w, j.to, j.at))), now = mid(...ends.map(([, j]) => seatAt(w, j.to, seat(j.to))));
  return {beam, off: ends.map(([c]) => ({op: 'disconnect', a: {id: beam, connector: c}})), move: {op: 'move', id: beam, in: {parent: 'world'}, p: e.p.map((v, i) => v + now[i] - was[i]), r: e.r}, on: ends.map(([c, j]) => ({op: 'connect', a: {id: beam, connector: c}, b: {id: j.to, connector: seat(j.to)}}))};
}
const reseat = (w, frames, from, bay) => {const o = reseatOps(w, frames, from, bay); return ok(w.god.act({ops: [...o.off, o.move, ...o.on]}));};
const kinds = (w, frames) => frames.map((f) => w.E()[f].support.kind);
const standsNow = (w, f) => frameStability(w.host.engine.world, w.E()[f]).stable;

test('R11: a god re-seating a beam so the frames no longer stand drops them to the ground: the clock runs, live and across a restart', {timeout: 900000}, async (t) => {
  const {w, pj, frames, bays} = await released(t);
  reseat(w, frames, 'l', bays.filter((b) => b.column === 'r').at(-1)); await w.tick(30);
  assert.equal(standsNow(w, frames[0]), false, 'it does not stand on its own');
  assert.notEqual(see(w, w.souls.Ada, pj).state.checkpoint, 'frames', 'and the project says so');
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.deepEqual(framesStand({world: w.host.engine.world}), []);
  await w.tick(40); await restart(w);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.deepEqual(framesStand({world: w.host.engine.world}), []);
  assert.equal(glitches(w), 0); assert.equal(w.host.clockFailure, undefined);
});

test('R11: a re-seat that leaves the frames standing reads as standing, and the world goes on', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t);
  reseat(w, frames, 'l', bays.filter((b) => b.column === 'l').at(-1)); await w.tick(30);
  assert.equal(standsNow(w, frames[0]), true, 'it would stand');
  assert.deepEqual(kinds(w, frames), ['ground', 'ground'], 'a re-derive keeps nothing');
  await restart(w);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
});

test('R11: an undo of a re-seat puts the beam back and the world goes on', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t), seats = () => frames.map((f) => w.E()[f].connections.map((c) => `${c.socket} ${c.to}`).sort()), joints = seats();
  reseat(w, frames, 'l', bays.filter((b) => b.column === 'r').at(-1)); await w.tick(30);
  ok(w.god.undo()); await w.tick(30);
  assert.deepEqual(seats(), joints, 'in its old seats');
  assert.deepEqual(kinds(w, frames), ['ground', 'ground'], 'nothing brings a support back');
  await restart(w);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
});

// a god commit first settles the one before it (`prepareWalkouts`), so the second call of a tick derives on what the first did
test('R11: two god calls in one tick, out and straight back: the world goes on', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t);
  reseat(w, frames, 'l', bays.filter((b) => b.column === 'r').at(-1)); ok(w.god.undo()); await w.tick(30);
  assert.equal(standsNow(w, frames[0]), true, 'the same seats');
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
});

test('R11: two god calls in one tick, off and into seats that do not stand, drop the frames and the world goes on', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t), o = reseatOps(w, frames, 'l', bays.filter((b) => b.column === 'r').at(-1)), lie = w.god.model.entities.get(o.beam);
  ok(w.god.act({ops: [...o.off, {op: 'move', id: o.beam, in: {parent: 'world'}, p: [lie.p[0], 0, lie.p[2]], r: lie.r}]}));
  ok(w.god.act({ops: [o.move, ...o.on]})); await w.tick(30);
  assert.equal(standsNow(w, frames[0]), false);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
  await restart(w);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
});

// a beam from a free seat of frame `f` on to a new upright a beam's length past it: a third frame in the group, which fails the
// rule until it has its own beams. A released frame the edit doesn't touch is judged on it too.
function thirdFrameOps(w, frames, f, seat, beam) {
  const m = w.god.model, fe = m.entities.get(f), other = frames.find((x) => x !== f), like = m.entities.get(w.E()[f].connections[0].to), ends = Object.entries(like.joins).filter(([, j]) => frames.includes(j.to));
  const was = mid(...ends.map(([, j]) => seatAt(w, j.to, j.at))), q = seatAt(w, f, seat), L = 2 * 1.3716, end = (id) => ends.find(([, j]) => j.to === id);
  const fIsLow = seatAt(w, f, end(f)[1].at)[0] < seatAt(w, other, end(other)[1].at)[0], [near, far] = fIsLow ? [end(f)[0], end(other)[0]] : [end(other)[0], end(f)[0]];
  return [{op: 'place', tmp: '$h', name: 'h', def: 'core/rack-upright@2', p: [fe.p[0] + L, fe.p[1], fe.p[2]], r: fe.r, anchor: 'center'},
    {op: 'move', id: beam, in: {parent: 'world'}, p: like.p.map((v, i) => v + [q[0] + L / 2, q[1], q[2]][i] - was[i]), r: like.r},
    {op: 'connect', a: {id: beam, connector: near}, b: {id: f, connector: seat}}, {op: 'connect', a: {id: beam, connector: far}, b: {id: '$h', connector: seat}}];
}
const reboot = async (w) => {w.comms.close(); w.host.stop(); w.db.close(); const db = new Db(w.path), h = new WorldHost(db, factory, seed, 1e9, worldId, w.opts); h.boot(); h.drainInputs(); mount(w, h, db); await w.tick(40);};

test('R11: after a restart, a god joining a third upright to the frames leaves the clock running, and a crash-style reboot too', {timeout: 900000}, async (t) => {
  const {w, pj, frames, bays} = await released(t);
  await restart(w);
  assert.equal(see(w, w.souls.Ada, pj).state.checkpoint, 'frames');
  ok(w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam5')})); await w.tick(40);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
  // every beam of the bay is where it was: only the rule says a frame in a group with a bare upright doesn't stand
  assert.notEqual(see(w, w.souls.Ada, pj).state.checkpoint, 'frames', 'a release is undone by what the frames now are');
  await reboot(w);
  assert.equal(w.host.clockFailure, undefined); assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
});

test('R11: a fifth beam on the frames and then a third upright leave the clock running', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t), bay = bays.at(-1), like = w.god.model.entities.get(w.E()[frames[0]].connections[0].to), ends = Object.entries(like.joins).filter(([, j]) => frames.includes(j.to));
  const was = mid(...ends.map(([, j]) => seatAt(w, j.to, j.at))), now = mid(seatAt(w, bay.a, bay.seats[0]), seatAt(w, bay.b, bay.seats[1]));
  ok(w.god.act({ops: [{op: 'move', id: 'beam5', in: {parent: 'world'}, p: like.p.map((v, i) => v + now[i] - was[i]), r: like.r}, ...ends.map(([c, j]) => ({op: 'connect', a: {id: 'beam5', connector: c}, b: {id: j.to, connector: j.to === bay.a ? bay.seats[0] : bay.seats[1]}}))]}));
  await w.tick(30);
  ok(w.god.act({ops: [{op: 'place', def: 'core/rack-beam@5', name: 'beam6', p: [w.ax + 30, w.az + 12], r: 0}]})); await w.tick(10);
  ok(w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam6')})); await w.tick(40);
  assert.equal(glitches(w), 0);
});

test('R11: after a restart, a whole third frame and then one of its beams taken leave the clock running', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t);
  await restart(w);
  const seats = [bays.find((b) => b.column === 'l' && b.height > 1), bays.find((b) => b.column === 'r' && b.height > 1), bays.filter((b) => b.column === 'l').at(-1), bays.filter((b) => b.column === 'r').at(-1)];
  ok(w.god.act({ops: [1, 2, 3].map((i) => ({op: 'place', def: 'core/rack-beam@5', name: `extra${i}`, p: [w.ax + 30, w.az + 12 + i], r: 0}))})); await w.tick(10);
  const ops = ['beam5', 'extra1', 'extra2', 'extra3'].flatMap((name, i) => thirdFrameOps(w, frames, frames[1], seats[i].seats[1], name).slice(i ? 1 : 0));
  ok(w.god.act({ops})); await w.tick(30);
  ok(w.god.act({ops: [{op: 'remove', id: 'extra3'}]})); await w.tick(30);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
});

test('#1250: a god joining a third upright to released frames, live: the clock runs, a reboot runs, and the god is told', {timeout: 900000}, async (t) => {
  const {w, pj, frames, bays} = await released(t);
  const r = ok(w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam5')})); await w.tick(40);
  assert.deepEqual(kinds(w, frames), ['ground', 'ground'], 'the frame the batch never touched too');
  assert.ok(r.warnings.some((x) => /frames\.settled/.test(x)), JSON.stringify(r.warnings));
  assert.notEqual(see(w, w.souls.Ada, pj).state.checkpoint, 'frames'); assert.equal(glitches(w), 0);
  await reboot(w);
  assert.equal(w.host.clockFailure, undefined); assert.deepEqual(kinds(w, frames), ['ground', 'ground']); assert.equal(glitches(w), 0);
});

test('#1250: each edit says only what it settled, and a reboot says nothing stale', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t), lines = (r) => r.warnings.filter((x) => /frames\.settled/.test(x));
  const first = ok(w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam5')})); await w.tick(40); assert.equal(lines(first).length, 1);
  const plain = ok(w.god.act({ops: [{op: 'place', def: 'core/table@1', name: 'clean', p: [w.ax + 20, w.az + 12]}]})); await w.tick(10); assert.deepEqual(lines(plain), [], 'nothing left over from the last edit');
  await reboot(w);
  const after = ok(w.god.act({ops: [{op: 'place', def: 'core/table@1', name: 'clean2', p: [w.ax + 22, w.az + 12]}]})); await w.tick(10); assert.deepEqual(lines(after), [], 'and nothing from the replay');
  assert.equal(glitches(w), 0);
});

test('#1250: an undo and a redo say what they settled', {timeout: 900000}, async (t) => {
  const {w, frames} = await released(t), take = w.host.engine.takeSettledV1.bind(w.host.engine); let say = [];
  w.host.engine.takeSettledV1 = () => { const ids = [...say, ...take()]; say = []; return ids; };
  ok(w.god.act({ops: [{op: 'place', def: 'core/table@1', name: 'clean', p: [w.ax + 20, w.az + 12]}]})); await w.tick(5);
  say = [frames[0]]; const undone = ok(w.god.undo()); assert.ok(undone.warnings.some((x) => /frames\.settled/.test(x)), JSON.stringify(undone.warnings)); await w.tick(5);
  say = [frames[0]]; const redone = ok(w.god.redo()); assert.ok(redone.warnings.some((x) => /frames\.settled/.test(x)), JSON.stringify(redone.warnings));
});

test('#1250: a reply on a clock that has stopped still answers: the edit is durable, and the note is all it costs', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t);
  t.mock.method(w.host, 'drainInputs', () => { throw new Error('fixture.clock-stopped'); });
  const r = w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam5')});
  assert.notEqual(r.accepted, false, JSON.stringify(r));
});

test('#1250: a world that settled replays to the same state from its log alone', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t);
  ok(w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam5')})); await w.tick(40);
  w.comms.close(); w.host.stop(); w.host.drainInputs(); w.host.saveSnapshot(true);
  const live = {tick: w.host.engine.world.tick, hash: w.host.engine.stateHash()}, id = w.host.worldId;
  w.db.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(id); w.db.close();
  const db = new Db(w.path), h = new WorldHost(db, factory, seed, 1e9, worldId, w.opts); h.boot(); h.drainInputs(); mount(w, h, db);
  assert.deepEqual({tick: h.engine.world.tick, hash: h.engine.stateHash()}, live, 'the fold settles the same way on replay');
  assert.deepEqual(kinds(w, frames), ['ground', 'ground']);
  await w.tick(20); assert.equal(glitches(w), 0);
});

test('#1250: a finished bay takes a third upright: the clock runs and the project says what the frames now are', {timeout: 900000}, async (t) => {
  const {w, pj, frames, bays} = await released(t), {Ada, Bo, Cy, Dee, Eve, Fay} = w.souls, b5 = w.god.model.get('beam5');
  ok(w.god.act({ops: [{op: 'move', id: 'beam5', p: [w.ax + 30, w.az + 12], r: 0}]})); await w.tick(20);
  await build(w, Ada, [[Ada, Bo], [Cy, Dee], [Eve, Fay]], {project: pj});
  assert.equal(see(w, Ada, pj).state.complete, true); assert.ok(b5);
  ok(w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam5')})); await w.tick(40);
  assert.equal(see(w, Ada, pj).state.complete, false); assert.equal(glitches(w), 0);
  await reboot(w); assert.equal(w.host.clockFailure, undefined); assert.equal(glitches(w), 0);
});

test('#1250: a whole third frame leaves a standing frame as it was, and taking a beam of it stands them down', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t);
  const seats = [bays.find((b) => b.column === 'l' && b.height > 1), bays.find((b) => b.column === 'r' && b.height > 1), bays.filter((b) => b.column === 'l').at(-1), bays.filter((b) => b.column === 'r').at(-1)];
  ok(w.god.act({ops: [1, 2, 3].map((i) => ({op: 'place', def: 'core/rack-beam@5', name: `extra${i}`, p: [w.ax + 30, w.az + 12 + i], r: 0}))})); await w.tick(10);
  ok(w.god.act({ops: ['beam5', 'extra1', 'extra2', 'extra3'].flatMap((name, i) => thirdFrameOps(w, frames, frames[1], seats[i].seats[1], name).slice(i ? 1 : 0))})); await w.tick(30);
  assert.equal(w.E()[frames[0]].support.kind, 'connected', 'the frame the batch never touched still stands, and keeps what it had');
  ok(w.god.act({ops: [{op: 'remove', id: 'extra3'}]})); await w.tick(30);
  assert.equal(w.E()[frames[0]].support.kind, 'ground'); assert.equal(glitches(w), 0);
});

test('#1250: a beam joined between uprights lying flat leaves the clock running, live and after a reboot', {timeout: 240000}, async (t) => {
  const w = await world(t, {names: ['Ada']}), x = w.ax + 11, z = w.az + 8, seat = 'front-l-5';
  ok(w.god.act({ops: [{op: 'place', def: 'core/rack-upright@2', name: 'fa', p: [x, z], r: 0}, {op: 'place', def: 'core/rack-upright@2', name: 'fb', p: [x + BEAM_L, z], r: 0}, {op: 'place', def: 'core/rack-beam@5', name: 'bm', p: [x + 8, z + 5], r: 0}]})); await w.tick(20);
  const m = mid(seatAt(w, w.idOf('fa'), seat), seatAt(w, w.idOf('fb'), seat));
  ok(w.god.act({ops: [{op: 'move', id: 'bm', in: {parent: 'world'}, p: [m[0], m[1] - 0.0508, m[2]], r: 0}, {op: 'connect', a: {id: 'bm', connector: 'end-l'}, b: {id: 'fa', connector: seat}}, {op: 'connect', a: {id: 'bm', connector: 'end-r'}, b: {id: 'fb', connector: seat}}]})); await w.tick(40);
  assert.equal(w.E()[w.idOf('bm')].support.kind, 'ground'); assert.deepEqual(framesStand({world: w.host.engine.world}), []); assert.equal(glitches(w), 0);
  await reboot(w); assert.equal(w.host.clockFailure, undefined); assert.equal(glitches(w), 0);
});

// #1150 on shared building: whatever a god's batch or a late verb leaves, the world goes on, a Soul can act, and a crash reboot boots
const goesOn = async (w, ticks = 60) => {
  await w.tick(ticks); assert.equal(w.host.clockFailure, undefined); assert.equal(w.host.paused, false); assert.equal(w.host.stepFailing, null);
  await reboot(w); assert.equal(w.host.clockFailure, undefined); await w.tick(20); assert.equal(w.host.clockFailure, undefined);
  const s = Object.values(w.souls)[0]; ok(await act(w, s, {capability: 'wave:here'}));
};
test('the ladder: a god joining a third upright to released frames, live', {timeout: 900000}, async (t) => {
  const {w, frames, bays} = await released(t);
  ok(w.god.act({ops: thirdFrameOps(w, frames, frames[1], bays[6].seats[1], 'beam5')})); await goesOn(w);
});
test('the ladder: a beam joined between uprights lying flat', {timeout: 240000}, async (t) => {
  const w = await world(t, {names: ['Ada']}), x = w.ax + 11, z = w.az + 8, seat = 'front-l-5';
  ok(w.god.act({ops: [{op: 'place', def: 'core/rack-upright@2', name: 'fa', p: [x, z], r: 0}, {op: 'place', def: 'core/rack-upright@2', name: 'fb', p: [x + BEAM_L, z], r: 0}, {op: 'place', def: 'core/rack-beam@5', name: 'bm', p: [x + 8, z + 5], r: 0}]})); await w.tick(20);
  const m = mid(seatAt(w, w.idOf('fa'), seat), seatAt(w, w.idOf('fb'), seat));
  ok(w.god.act({ops: [{op: 'move', id: 'bm', in: {parent: 'world'}, p: [m[0], m[1] - 0.0508, m[2]], r: 0}, {op: 'connect', a: {id: 'bm', connector: 'end-l'}, b: {id: 'fa', connector: seat}}, {op: 'connect', a: {id: 'bm', connector: 'end-r'}, b: {id: 'fb', connector: seat}}]})); await goesOn(w);
});
const placedAt = (r, what) => {const m = new RegExp(`${what} at \\(([-\\d.]+), ([-\\d.]+), ([-\\d.]+)\\)`).exec(r.failures?.[0]?.detail ?? ''); assert.ok(m, JSON.stringify(r)); return [+m[1], +m[2], +m[3]];};
test('the ladder: a tread joined to a flight lying on the ground', {timeout: 240000}, async (t) => {
  const w = await world(t, {names: ['Ada']}), x = w.ax + 11, z = w.az + 8;
  ok(w.god.act({ops: [{op: 'place', def: 'core/deck-stair@1', name: 'fl', p: [x, z], r: 0}, {op: 'place', def: 'core/deck-stair-tread@1', name: 'tr', p: [x + 4, z + 4], r: 0}]})); await w.tick(20);
  const join = {op: 'connect', a: {id: 'tr', connector: 'seat'}, b: {id: 'fl', connector: 'tread-1'}}, p = placedAt(w.god.act({ops: [join]}), 'fl tread-1');
  ok(w.god.act({ops: [{op: 'move', id: 'tr', in: {parent: 'world'}, p, r: 0}, join]})); await goesOn(w);
});
test('the ladder: a sheet joined to joists lying on the ground', {timeout: 240000}, async (t) => {
  const w = await world(t, {names: ['Ada']}), x = w.ax + 11, z = w.az + 8;
  ok(w.god.act({ops: [...[0, 1, 2, 3, 4].map((i) => ({op: 'place', def: 'core/deck-joist@1', name: `j${i}`, p: [x + (i - 2) * SPAN, z], r: R})), {op: 'place', def: 'core/plywood-sheet@2', name: 'sh', p: [x, z + 6], r: 0}]})); await w.tick(20);
  const p = placedAt(w.god.act({ops: [{op: 'connect', a: {id: 'sh', connector: 'on-2'}, b: {id: 'j2', connector: 'top'}}]}), 'j2 top');
  ok(w.god.act({ops: [{op: 'move', id: 'sh', in: {parent: 'world'}, p, r: 0}, ...[0, 1, 2, 3, 4].map((i) => ({op: 'connect', a: {id: 'sh', connector: `on-${i}`}, b: {id: `j${i}`, connector: 'top'}}))]})); await goesOn(w);
});
async function beamInTheAir(t) {
  const {w, frames, bays} = await released(t), {Ada, Bo} = w.souls, b = bays.filter((x) => x.height > 0.9)[0], sa = seatAt(w, b.a, b.seats[0]), sb = seatAt(w, b.b, b.seats[1]), beam = w.idOf('beam5');
  ok(w.god.act({ops: [{op: 'move', id: 'beam5', p: [(sa[0] + sb[0]) / 2, (sa[2] + sb[2]) / 2 + (sa[2] > 0 ? -0.15 : 0.15)], r: 0}]})); await w.tick(30);
  const q = w.E()[beam].pose.p; await w.at(Ada, q[0] - 2, q[2] + 1.2); await w.at(Bo, q[0] + 2, q[2] + 1.2); await w.tick(10);
  const cap = offers(w, Ada).find((c) => c.verb === 'connect-beam-with'); ok(await act(w, Ada, {capability: cap.id, params: {column: b.column, height: b.height, with: 'Bo'}})); await w.tick(5);
  const inv = offers(w, Bo).find((c) => c.id.startsWith('accept:')); if (inv) ok(await act(w, Bo, {capability: inv.id, params: {revision: 1}}));
  await until(w, () => w.E()[beam].pose.p[1] > 0.3, 2500); assert.ok(w.E()[beam].pose.p[1] > 0.3, 'it is in the air');
  return {w, frames, beam};
}
test('the ladder: a frame laid flat under a beam in the air, so a verb lands on what no longer stands', {timeout: 900000}, async (t) => {
  const {w, frames, beam} = await beamInTheAir(t), fa = frames[0], others = [...new Set(w.E()[fa].connections.map((c) => c.to))].filter((id) => id !== beam), m = w.god.model.entities.get(fa);
  ok(w.god.act({ops: [...others.map((id) => ({op: 'remove', id})), {op: 'move', id: fa, in: {parent: 'world'}, p: [m.p[0] - 3, m.p[2]], r: 0}]})); await goesOn(w, 800);
});
test('the ladder: a frame removed under a beam in the air, so a verb lands on nothing', {timeout: 900000}, async (t) => {
  const {w, frames, beam} = await beamInTheAir(t), fa = frames[0], others = [...new Set(w.E()[fa].connections.map((c) => c.to))].filter((id) => id !== beam);
  ok(w.god.act({ops: [...others.map((id) => ({op: 'remove', id})), {op: 'remove', id: fa}]})); await goesOn(w, 800);
});
test('shared building brings the ladder, and an explicit false turns it off', async () => {
  assert.match(factory.rulesVersion, /\+souls-repair\//);
  assert.doesNotMatch((await marsFactory({...GREEN_FIELD_WORLD, sharedCarryV1: true, soulsRepairV1: false})).rulesVersion, /\+souls-repair\//);
  assert.doesNotMatch((await marsFactory({...GREEN_FIELD_WORLD})).rulesVersion, /\+souls-repair\//);
});

test('R12: with the flag off, nothing is offered and no project exists', {timeout: 120000}, async (t) => {
  const w = await world(t, {sharedCarry: false}), {Ada} = w.souls; await yard(w);
  assert.ok(!offers(w, Ada).some((c) => ['organize', 'volunteer'].includes(c.verb)));
  assert.equal((await act(w, Ada, {capability: `organize:${PROC}`, params: {at: 'site'}})).accepted, false);
  assert.equal(w.edge.projects, undefined);
  assert.equal(w.db.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='edge_projects_v1'").get().n, 0);
  assert.equal(hereFrame(w.edge, Ada).projects, undefined);
});
