// intents/1 (Core-A): affordance intents resolved by the server when the step starts — the nearest free seat near a
// Soul, a front-row seat in a room, go/swim/approach/turn/look — each receipt reporting the concrete choice; resolve is
// the same choice as a dry run with no side effects; the attention channel (look/turn/face) never cancels the body's
// act, speech and conversation never stop a walk; conversation members auto-face the speaker; replay is exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {coreAWorld} from '../test/core-a-fixture.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {headingOfYaw} from './edge/perception/geometry.ts';
import {Perception} from './edge/perception/here.ts';
import {existsSync} from 'node:fs';
import {bootEden} from '../test/eden-capabilities-timing.ts';

test('intents: nearest free seat near a Soul, front row, go, swim, approach, turn, look; resolve has no side effects', {timeout: 600000}, async t => {
  const w = await coreAWorld(4); t.after(() => w.close());
  const [a, b, c, d] = w.souls;
  const act = async (s: typeof a, body: object) => (await w.http(s, 'POST', '/v1/edge/act', body)).body;
  const dry = async (s: typeof a, body: object) => (await w.http(s, 'POST', '/v1/edge/resolve', body)).body.resolve;
  // #1911: an act over HTTP is an offered id. The ledger reads the intent (its choice is `chosen`), the act sends the id it
  // chose, and the receipt is that act's. A refused intent answers the ledger's refusal; the words never reach the route.
  const byIntent = async (s: typeof a, body: object) => {const d = w.ledger.intents.dryRun(s, body as never) as any; if (!d.ok) return {accepted: false, code: d.code};
    const out = await act(s, {capability: d.would.capability, ...(d.would.params ? {params: d.would.params} : {})}); return {...out, chosen: {...d.would.chosen, ...out.receipt?.chosen}};};
  const finish = async (s: typeof a, out: any, n = 8000) => {assert.equal(out.accepted, true, JSON.stringify(out)); await w.ticks(n, () => !w.open(s, out.receipt.id)); return w.receipt(s, out.receipt.id);};
  const seatOf = (s: typeof a) => new Perception(w.ledger, s).seat();
  // here.me.seat is the native seat slot (`<entity>#<slot>`, matching a receipt's chosen.slot); compare the entity part to menu targets.
  const seatEntity = (s: typeof a) => { const slot = seatOf(s); assert.match(String(slot), /#/); return String(slot).split('#')[0]; };
  // B stands by the dining table; C takes the chair nearest to B first
  await w.put(b, [21.6, 3.6]);
  const bAt = w.pos(b), chairs = w.ledger.capabilities(c).filter(x => x.verb === 'sit' && x.id.startsWith('sit:social-eden-dining-chair'));
  const dist = (id: string) => {const e = (w.engine.world.entities as any)[id]; return Math.hypot(e.pose.p[0] - bAt[0], e.pose.p[2] - bAt[1]);};
  const nearest = [...chairs].sort((x, y) => dist(x.target!.id) - dist(y.target!.id) || x.id.localeCompare(y.id));
  const cs = await finish(c, await act(c, {capability: nearest[0].id})); assert.equal(cs.phase, 'completed', JSON.stringify(cs));
  assert.equal(seatEntity(c), nearest[0].target!.id);
  // dry run first: no receipt, no event, no movement
  const before = {receipts: (w.f.db.db.prepare('SELECT COUNT(*) n FROM edge_receipts_v1').get() as any).n, events: w.f.db.events(w.f.host.worldId).length, at: w.pos(a)};
  const r1 = await dry(a, {verb: 'sit', target: {nearest: 'seat', near: b.soulId, free: true}});
  for (const q of [{verb: 'sit', target: {in: 'eden-classroom-1', row: 'front'}}, {verb: 'go', target: {place: 'shore-bank'}}, {verb: 'swim', target: {place: 'shore-water', seconds: 120}},
    {verb: 'approach', target: b.soulId, distance: 1.5}, {verb: 'turn', heading: 90}, {verb: 'look', target: b.name}, {verb: 'go', target: {place: 'region-park.pond'}}, {capability: 'walk to the pond'}, {capability: 'walk:eden-pond-north'}]) await dry(a, q);
  assert.deepEqual({receipts: (w.f.db.db.prepare('SELECT COUNT(*) n FROM edge_receipts_v1').get() as any).n, events: w.f.db.events(w.f.host.worldId).length, at: w.pos(a)}, before, 'resolve changed nothing');
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r1.would.capability, 'sit:' + nearest[1].target!.id, 'the nearest FREE seat to B (the nearest is taken)');
  // act on it: the receipt reports the same choice and A ends up in that seat
  const s1 = await byIntent(a, {verb: 'sit', target: {nearest: 'seat', near: b.name}});
  assert.equal(s1.chosen.seat, nearest[1].target!.id, JSON.stringify(s1)); assert.equal(s1.chosen.near.name, b.name);
  assert.equal(w.receipt(a, s1.receipt.id).capability, 'sit:' + nearest[1].target!.id, 'the receipt is the chosen seat');
  const s1d = await finish(a, s1); assert.equal(s1d.phase, 'completed'); assert.equal(seatEntity(a), nearest[1].target!.id); assert.equal((s1d.endedAt as any).posture, 'seated');
  // look keeps posture and seat; attention receipts never replace the body's act
  const lk = await act(a, {capability: `look:${c.soulId}`}); assert.equal(lk.accepted, true, JSON.stringify(lk)); assert.equal(lk.channel, 'attention'); assert.equal(lk.chosen.turned, 'head');
  assert.equal(seatEntity(a), nearest[1].target!.id); assert.equal(w.body(a).human.gaze?.target, c.entityId); assert.deepEqual(w.body(a).human.attention, [w.body(c).pose.p[0], w.body(c).pose.p[2]]);
  // front row of the classroom: a centre seat in the row nearest the lectern; the second Soul gets the other centre seat
  const f1 = await byIntent(d, {verb: 'sit', target: {in: 'eden-classroom-1', row: 'front'}}); assert.equal(f1.chosen.row, 1, JSON.stringify(f1));
  assert.ok(['eden-classroom-seat-02', 'eden-classroom-seat-03'].includes(f1.chosen.seat), f1.chosen.seat);
  await finish(d, f1, 12000); assert.equal(seatEntity(d), f1.chosen.seat);
  const f2 = await dry(b, {verb: 'sit', target: {in: 'eden-classroom-1', row: 'front'}}); assert.equal(f2.would.chosen.row, 1);
  assert.ok(['eden-classroom-seat-02', 'eden-classroom-seat-03'].includes(f2.would.chosen.seat) && f2.would.chosen.seat !== f1.chosen.seat, JSON.stringify(f2));
  const back = await dry(b, {verb: 'sit', target: {in: 'eden-classroom-1', row: 'back'}}); assert.equal(back.would.chosen.row, back.would.chosen.rows);
  // go {place}: route + walk, chosen place and ETA; arrives there
  const g = await byIntent(b, {verb: 'go', target: {place: 'shore-bank'}}); assert.equal(g.chosen.place, 'shore-bank'); assert.ok(g.chosen.eta && g.chosen.distance > 0, JSON.stringify(g.chosen));
  const gd = await finish(b, g); assert.equal(gd.phase, 'completed'); assert.equal((gd.endedAt as any).place, 'shore-bank');
  // approach {target, distance}: resolve chooses that Soul; going up to them by the offered go-near ends about that far away
  const up = await act(c, {capability: 'stand:here'}); await w.ticks(200, () => !w.open(c, up.receipt.id)); await w.put(c, [-20, 2]);
  const apd0 = w.ledger.intents.dryRun(b, {verb: 'approach', target: c.name, distance: 1.5} as never) as any; assert.equal(apd0.would?.chosen?.target, c.soulId, JSON.stringify(apd0));
  // the menu offers approaching a Soul as go-near:<soul>; resolve's approach:<soul> is not taken by act (#2143)
  const ap = await act(b, {capability: `go-near:${c.soulId}`}); assert.equal(ap.accepted, true, JSON.stringify(ap) + JSON.stringify([w.pos(b), w.pos(c)]));
  const apd = await finish(b, ap); assert.equal(apd.phase, 'completed', JSON.stringify(apd));
  const gap = Math.hypot(w.pos(b)[0] - w.pos(c)[0], w.pos(b)[1] - w.pos(c)[1]); assert.ok(gap > 0.9 && gap < 2.6, 'gap ' + gap);
  // turn {heading}: a free standing body turns; turn {target: a thing}
  const tn = await byIntent(b, {verb: 'turn', heading: 270}); assert.equal(tn.chosen.turned, 'body', JSON.stringify(tn)); assert.equal(headingOfYaw(w.body(b).pose.yaw), 270);
  const tf = await byIntent(b, {verb: 'turn', target: 'fire'}); assert.equal(tf.accepted, true, JSON.stringify(tf)); assert.equal(tf.chosen.kind, 'fire');
  // swim {place, seconds}: laps chosen for the time asked
  const sw = await byIntent(b, {verb: 'swim', target: {place: 'shore-water', seconds: 120}}); assert.equal(sw.accepted, true, JSON.stringify(sw)); assert.equal(sw.chosen.laps, 5); assert.equal(sw.chosen.place, 'shore-water');
  const notWater = await byIntent(b, {verb: 'swim', target: {place: 'eden-library-1'}}); assert.equal(notWater.accepted, false); assert.equal(notWater.code, 'swim.not-swimmable');
  const st = await act(b, {capability: 'stand:here'}); assert.equal(st.accepted, true);
  // refusals are honest
  assert.equal((await byIntent(a, {verb: 'sit', target: {nearest: 'seat', near: 'Nobody Here'}})).code, 'target.not-in-sight');
  assert.equal((await byIntent(a, {verb: 'look', target: 'the moon'})).code, 'target.not-in-sight');
  assert.equal((await byIntent(a, {verb: 'sit', target: {in: 'eden-nowhere'}})).code, 'place.unknown');
  assert.equal((await act(a, {verb: 'sit', target: {in: 'eden-classroom-1', row: 'front'}})).code, 'capability.unknown', 'an intent over HTTP is refused by the strict gate');
  assert.deepEqual(w.f.host.engine.runtime.violations, []);
  await w.replayExact();
});

test('channels: attention never cancels the body; speech and conversation never stop a walk; auto-face to the speaker', {timeout: 600000}, async t => {
  const w = await coreAWorld(3); t.after(() => w.close());
  const [a, b, c] = w.souls;
  const act = async (s: typeof a, body: object) => (await w.http(s, 'POST', '/v1/edge/act', body)).body;
  await w.put(a, [14, 4]); await w.put(b, [15.5, 4]); await w.put(c, [13, 5]);
  // a long walk; look, turn, face, say and converse while it runs
  const walk = await act(a, {capability: 'walk:shore-bank'}); assert.equal(walk.accepted, true, JSON.stringify(walk));
  await w.ticks(60); assert.equal(w.receipt(a, walk.receipt.id).phase, 'started');
  const start = w.pos(a);
  // #1911: the offered attention ids for "look at B", "face B", "look at C", "turn to face B" and "look left"
  for (const q of [{capability: `look:${b.soulId}`}, {capability: `face:${b.soulId}`}, {capability: `look:${c.soulId}`}, {capability: `turn:${b.soulId}`}, {capability: 'look:left'}]) {
    const r = await act(a, q); assert.equal(r.accepted, true, JSON.stringify(q) + JSON.stringify(r)); assert.equal(r.channel, 'attention', JSON.stringify(r));
    assert.equal(w.receipt(a, walk.receipt.id).phase, 'started', 'the walk goes on after ' + JSON.stringify(q));
  }
  const said = (await w.http(a, 'POST', '/v1/edge/say', {text: 'Off to the pond!'})).body; assert.ok(said.said, JSON.stringify(said));
  const cv: any = w.comms.conversations.handle(b, {op: 'start', with: [a.soulId], text: 'where are you going?'});
  if (cv.accepted) {w.comms.conversations.handle(a, {op: 'accept', conversation: cv.conversation.id}); w.comms.conversations.handle(a, {op: 'say', conversation: cv.conversation.id, text: 'the pond'});}
  else t.diagnostic('conversation not started (A already out of reach): ' + cv.code);
  assert.equal(w.receipt(a, walk.receipt.id).phase, 'started', 'speech and conversation never stop the walk');
  await w.ticks(9000, () => !w.open(a, walk.receipt.id));
  assert.equal(w.receipt(a, walk.receipt.id).phase, 'completed', JSON.stringify(w.receipt(a, walk.receipt.id)));
  assert.ok(Math.hypot(w.pos(a)[0] - start[0], w.pos(a)[1] - start[1]) > 20, 'it really walked');
  assert.equal(w.ledger.openReceipts(a.soulId).length, 0);
  // auto-face (default on): B and C talk; when C speaks, B's head turns to C
  await w.put(b, [10, 10]); await w.put(c, [12, 10]);
  await act(b, {capability: 'look:ahead'});
  const talk: any = w.comms.conversations.handle(b, {op: 'start', with: [c.soulId], text: 'hello'}); assert.equal(talk.accepted, true, JSON.stringify(talk));
  w.comms.conversations.handle(c, {op: 'accept', conversation: talk.conversation.id});
  w.comms.conversations.handle(c, {op: 'say', conversation: talk.conversation.id, text: 'hi there'}); await w.ticks(5);
  assert.equal(w.body(b).human.gaze?.kind, 'auto'); assert.equal(w.body(b).human.gaze?.target, c.entityId);
  // CONV-UI: free standing bodies turn to face each other too (the speaker included): B east towards C, C west towards B
  assert.ok(Math.abs(w.body(b).pose.yaw) < 0.01, `B faces C: ${w.body(b).pose.yaw}`); assert.ok(Math.abs(Math.abs(w.body(c).pose.yaw) - Math.PI) < 0.01, `C faces B: ${w.body(c).pose.yaw}`);
  // turned off for this conversation: no more auto-face
  // auto-face has no offered id (#2143): the setting is the ledger's, read from the intent
  const off: any = await accept(w.f.host, w.ledger.act(b, {verb: 'auto-face', on: false, conversation: talk.conversation.id} as never)); assert.equal(off.accepted, true, JSON.stringify(off));
  await act(b, {capability: 'look:ahead'}); await w.ticks(5);
  w.comms.conversations.handle(c, {op: 'say', conversation: talk.conversation.id, text: 'still here'}); await w.ticks(5);
  assert.equal(w.body(b).human.gaze, undefined, 'auto-face off');
  // the attention events are logged and replay exactly
  assert.ok(w.f.db.events(w.f.host.worldId).filter(e => e.kind === ('edge-attention' as never)).length >= 6);
  assert.deepEqual(w.f.host.engine.runtime.violations, []);
  await w.replayExact();
});

test('walk-to:here {at}: the engine walk_to to a point on this level ends within 0.5 m and reports arrival; a point with no route is refused with a route code (#1916)', {timeout: 600000}, async t => {
  const w = await coreAWorld(2); t.after(() => w.close());
  const [a, b] = w.souls, goal: [number, number] = [-20, 2];
  const act = async (body: object) => (await w.http(a, 'POST', '/v1/edge/act', body)).body;
  const streams = (w.ledger.comms as any).streams, deliver = streams.deliver.bind(streams), arrived: any[] = [];
  streams.deliver = (soulId: string, kind: string, tick: number, body: any) => {if (kind === 'arrive' && soulId === a.soulId) arrived.push(body); return deliver(soulId, kind, tick, body);};
  await w.put(a, [14, 4]); await w.put(b, [21.6, 3.6]);
  assert.ok(Math.hypot(w.pos(a)[0] - goal[0], w.pos(a)[1] - goal[1]) > 20, 'far from the goal');
  assert.ok(Math.hypot(w.pos(b)[0] - goal[0], w.pos(b)[1] - goal[1]) > 0.8, 'no other body within 0.8 m of the goal');
  const out = await act({capability: 'walk-to:here', params: {at: goal}});
  assert.equal(out.accepted, true, JSON.stringify(out)); assert.equal(out.receipt.capability, 'walk-to:here'); assert.deepEqual(out.chosen.at, goal);
  // the plan is the engine's own walk_to (standoff 0, standing room), launched as any offer is
  const launched = (w.ledger as any).launched.get(out.receipt.id);
  assert.deepEqual(launched?.steps.filter((s: any) => s.verb !== 'stand'), [{verb: 'walk_to', params: {to: goal, standoff: 0, stand: 'clear/1'}}]);
  await w.ticks(8000, () => !w.open(a, out.receipt.id));
  const done = w.receipt(a, out.receipt.id); assert.equal(done.phase, 'completed', JSON.stringify(done));
  const off = Math.hypot(w.pos(a)[0] - goal[0], w.pos(a)[1] - goal[1]); assert.ok(off <= 0.5, `ended ${off.toFixed(2)} m from the goal`);
  assert.equal(arrived.length, 1, 'arrival reported as for other walks'); assert.equal(arrived[0].receipt.capability, 'walk-to:here');
  // no route: refused as a place walk is, with a route code, and the body stays put
  const at = w.pos(a), far = await act({capability: 'walk-to:here', params: {at: [1000, 1000]}});
  assert.equal(far.accepted, false, JSON.stringify(far)); assert.match(far.code, /^route\./, JSON.stringify(far));
  await w.ticks(40); assert.deepEqual(w.pos(a), at);
  assert.deepEqual(w.f.host.engine.runtime.violations, []);
  await w.replayExact();
});

test('walk-to:here, a point with no complete route nearby: the closest approach, and the receipt\'s chosen gives the goal used and the shortfall (#1964 A2 near)', {timeout: 600000}, async t => {
  const w = await coreAWorld(1); t.after(() => w.close());
  const [a] = w.souls, asked: [number, number] = [37, -27], eng = w.engine as any;
  const act = async (body: object) => (await w.http(a, 'POST', '/v1/edge/act', body)).body;
  await w.put(a, [14, 4]);
  // the premise: a small walled-off area (standing room, no walk joins it), within the distance the planner proves whole
  assert.equal(eng.navWarmV1(Infinity), true);
  const v = eng.navCheckV1([{id: 'g', p: asked, level: 0, tol: 0.6}])[0]; assert.equal(v.code, 'nav.disconnected', JSON.stringify(v));
  assert.ok(Math.hypot(w.pos(a)[0] - asked[0], w.pos(a)[1] - asked[1]) < 72);
  const out = await act({capability: 'walk-to:here', params: {at: asked}});
  assert.equal(out.accepted, true, JSON.stringify(out));
  assert.match(out.receipt.reason, /^Got within [\d.]+ m of \[37, -27\]: no walkable route reaches it/, 'the existing closest-approach note');
  const {chosen} = out.receipt; assert.deepEqual(chosen.at, asked);
  assert.ok(Array.isArray(chosen.goal) && chosen.short > 1, JSON.stringify(chosen));
  assert.equal(chosen.short, Math.round(Math.hypot(chosen.goal[0] - asked[0], chosen.goal[1] - asked[1]) * 10) / 10, 'the shortfall is the goal used\'s distance from the point asked');
  await w.ticks(8000, () => !w.open(a, out.receipt.id));
  const done = w.receipt(a, out.receipt.id); assert.equal(done.phase, 'completed', JSON.stringify(done)); assert.deepEqual(done.chosen, chosen);
  assert.ok(Math.hypot(w.pos(a)[0] - chosen.goal[0], w.pos(a)[1] - chosen.goal[1]) <= 0.5, 'ended at the goal used');
  assert.deepEqual(w.f.host.engine.runtime.violations, []);
  await w.replayExact();
});

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json';
test('walk-to:here on Eden 2026 (paged ground): a point in a wall snaps to standing ground within 1 m, one with none is refused, a walled-off point 490 m out is refused, and from an upper floor an outdoor point is refused naming the level (#1964 A1-A3)', {timeout: 900000, skip: NO_EDEN}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const eng = w.host.engine as any, L = w.edge, s = w.soul;
  const at = () => {const e = eng.world.entities[s.entityId]; return {p: [e.pose.p[0], e.pose.p[2]] as [number, number], level: e.human.level ?? 0};};
  const act = async (capability: string, params?: object) => await accept(w.host, Promise.resolve(L.act(s, {capability, ...(params ? {params} : {})}))) as any;
  const finish = async (id: string, seconds = 600) => {const t0 = eng.world.tick; let r = L.receipt(s.soulId, id)!; while (['accepted', 'waiting', 'started'].includes(r.phase) && eng.world.tick - t0 < 20 * seconds) {await w.settle(20); r = L.receipt(s.soulId, id)!;} return r;};
  const stays = async (before: {p: [number, number]; level: number}) => {await w.settle(20); assert.deepEqual(at(), before, 'the body never moved');};
  // a garden wall on open ground by the Commons, and a pen of four garden walls on open ground 490 m out (corner gaps
  // 0.25 m: no body fits). A live world's ledger warms the connectivity labels a slice a tick; the test warms them at once.
  const wall = (name: string, path: number[][]) => ({op: 'place', def: 'core/garden-wall@1', name, shape: {path}});
  const [px, pz] = [483, 85], h = 3, i = 0.4;
  const built = w.god.act({ops: [wall('test-wall', [[7, 6], [13, 6]]), wall('pen-n', [[px - h + i, pz + h], [px + h - i, pz + h]]), wall('pen-s', [[px - h + i, pz - h], [px + h - i, pz - h]]),
    wall('pen-e', [[px + h, pz - h + i], [px + h, pz + h - i]]), wall('pen-w', [[px - h, pz - h + i], [px - h, pz + h - i]])]} as never) as {accepted?: boolean};
  assert.equal(built.accepted, true, JSON.stringify(built)); await w.settle(3);
  assert.equal(eng.navWarmV1(Infinity), true);
  // A1: inside the wall: snapped to standing ground within 1 m, walked there, and chosen says so
  assert.ok(eng.clearanceAtV1(10, 6) < 0.05, 'the point is inside the wall');
  const snap = await act('walk-to:here', {at: [10, 6]}); assert.equal(snap.accepted, true, JSON.stringify(snap));
  const c = snap.receipt.chosen, moved = Math.hypot(c.goal[0] - 10, c.goal[1] - 6);
  assert.deepEqual(c.at, [10, 6]); assert.ok(moved > 0 && moved <= 1, JSON.stringify(c)); assert.equal(c.short, Math.round(moved * 10) / 10);
  assert.ok(eng.clearanceAtV1(c.goal[0], c.goal[1]) >= 0.34, 'the goal used has standing room');
  assert.deepEqual((L as any).launched.get(snap.receipt.id)?.steps.filter((x: any) => x.verb !== 'stand'), [{verb: 'walk_to', params: {to: c.goal, standoff: 0, stand: 'clear/1'}}]);
  const sd = await finish(snap.receipt.id); assert.equal(sd.phase, 'completed', JSON.stringify(sd));
  assert.ok(Math.hypot(at().p[0] - c.goal[0], at().p[1] - c.goal[1]) <= 0.5, 'ended at the snapped goal');
  // A1: the middle of the Commons pond has no standing ground within 1 m on her level: refused, not-standable
  let before = at();
  const pond = await act('walk-to:here', {at: [-60, 0]});
  assert.equal(pond.accepted, false, JSON.stringify(pond)); assert.equal(pond.code, 'route.goal-blocked'); assert.match(pond.reason, /no standing room within 1 m of \[-60, 0\] on the ground \(level 0\)/i);
  await stays(before);
  // A2 far: the pen 490 m out on paged ground. The planner proves only the first hop there (before #1964 this walk was
  // accepted and failed 45 m short after six minutes); the labels see no walk joins it: refused with a route code
  const v = eng.navCheckV1([{id: 'pen', p: [px, pz], level: 0, tol: 0.6}])[0]; assert.equal(v.code, 'nav.disconnected', JSON.stringify(v));
  assert.ok(Math.hypot(at().p[0] - px, at().p[1] - pz) > 450, 'about 500 m away');
  const far = await act('walk-to:here', {at: [px, pz]});
  assert.equal(far.accepted, false, JSON.stringify(far)); assert.equal(far.code, 'route.unreachable'); assert.match(far.reason, /No walkable route joins \[483, 85\]/);
  await stays(before);
  // A3: upstairs (Eden House 3's kitchen, level 4), an outdoor point is refused naming the level; she stays upstairs
  const up = await act('walk:g-eden-house-3-kitchen.kitchen-1'); assert.equal(up.accepted, true, JSON.stringify(up));
  assert.equal((await finish(up.receipt.id)).phase, 'completed'); before = at(); assert.equal(before.level, 4);
  const out = await act('walk-to:here', {at: [0, 0]});
  assert.equal(out.accepted, false, JSON.stringify(out)); assert.equal(out.code, 'route.goal-blocked'); assert.match(out.reason, /on level 4, the floor you are on: walk-to stays on your own level/);
  await stays(before);
  assert.deepEqual(eng.runtime.violations, []);
});
