// #1287: a Soul cut off in a sealed room (hello-hamlet's reading room: its front door is shut building state, which no
// Soul opens) takes nav-connect/1's logged step-out whichever walk form it asks with, and is told; the listing agrees.
// Souls that are not cut off, or are inside the step-out's once-a-minute bound, or ask while navigation is cold, are
// refused as before. Real genesis, the real act path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {hereFrame} from './edge/perception/here.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
const MOVED = 'Moved to open ground first: no walk led out from where you stood.';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function world(t: {after(f: () => void): void}, warm = true) {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  // warm first, so the bridge's one warm-up pass is spent before she is put inside (nothing else steps her out)
  if (warm) {assert.equal((w.host.engine as any).navWarmV1(Infinity), true); await w.settle(4);}
  const room = w.edge.places.byId.get('g-lab-reading-room')!, mid = room.polygon.reduce((s, q) => [s[0] + q[0] / room.polygon.length, s[1] + q[1] / room.polygon.length], [0, 0]) as [number, number];
  const put = async (to: [number, number]) => {await accept(w.host, w.host.enqueue('edge-relocate', 'test:put', {soulId: w.soul.soulId, entityId: w.soul.entityId, to})); await w.settle(6);};
  const here = () => hereFrame(w.edge, w.soul, {doHere: true}) as any;
  const act = (input: Record<string, unknown>) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, input as never))) as Promise<any>;
  const steps = () => w.db.events(w.host.worldId).filter((e: any) => e.kind === 'edge-relocate' && e.payload.policy === 'nav-connect/1');
  const pos = () => {const p = w.host.engine.world.entities[w.soul.entityId]!.pose.p; return [p[0], p[2]] as [number, number];};
  const inRoom = () => {const [x, z] = pos(); let c = false; const P = room.polygon; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > z) !== (P[j][1] > z) && x < (P[j][0] - P[i][0]) * (z - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c;};
  return {w, mid, put, here, act, steps, inRoom};
}

test('#1287 P1, P2: from the sealed room a place walk asked as an intent steps out (logged, once), walks, and says so; here agrees', {timeout: 300000}, async t => {
  const {w, mid, put, here, act, steps, inRoom} = await world(t);
  await put(mid); assert.equal(inRoom(), true); assert.equal(steps().length, 0, 'nothing stepped her out yet');
  const h = here();
  assert.ok(h.exits.length > 0 && h.exits.every((e: any) => e.reachable !== false), JSON.stringify(h.exits));
  assert.ok((h.far as string[]).some(l => / · walk:/.test(l)), JSON.stringify(h.far));
  const r = await act({verb: 'walk', target: 'field'});
  assert.equal(r.accepted, true, JSON.stringify(r));
  const ev = steps(); assert.equal(ev.length, 1, 'one logged step out');
  assert.match(ev[0].payload.why, /^nav-connect\/1: stood cut off \(nav\.disconnected\), no walk out: stepped to the nearest open ground$/);
  assert.equal(r.receipt.reason, MOVED, 'the receipt says so');
  assert.equal(inRoom(), false, 'out of the room'); await w.settle(3); assert.ok(w.host.engine.programOf(w.soul.entityId), 'and walking');
});

test('#1287 P3: a Soul on the main area asking for the sealed room is refused as before', {timeout: 300000}, async t => {
  const {act, steps} = await world(t);
  const r = await act({verb: 'walk', target: 'g-lab-reading-room'});
  assert.equal(r.accepted, false, JSON.stringify(r)); assert.equal(r.code, 'route.unreachable', JSON.stringify(r));
  assert.equal(steps().length, 0);
});

test('#1287 P3: put back inside within the minute, every walk form is refused naming when it can go, nothing moves her, and after the minute it goes', {timeout: 300000}, async t => {
  const {w, mid, put, here, act, steps, inRoom} = await world(t);
  await put(mid); assert.equal((await act({capability: 'walk:field'})).accepted, true); assert.equal(steps().length, 1);
  await w.settle(3); await act({capability: 'stop'}); await w.settle(3);
  await put(mid); assert.equal(inRoom(), true);
  // (#1501 review) every form carries the seconds: the exits, the intent and the offered id
  assert.ok(here().exits.every((e: any) => e.reachable === false && e.why === 'route.unreachable' && e.retry_after >= 1 && e.retry_after <= 60), JSON.stringify(here().exits));
  const wait = w.edge.stepOutWait(w.soul as never); assert.ok(wait !== null && wait >= 1 && wait <= 60, String(wait));
  for (const input of [{verb: 'walk', target: 'field'}, {capability: 'walk:field'}, {capability: 'walk:flag-orchard'}]) {
    // coordinator's check: never a silent no-op; the refusal says she is cut off and when the step out can be taken
    const r = await act(input); assert.equal(r.code, 'route.unreachable', `${JSON.stringify(input)}: ${JSON.stringify(r)}`);
    assert.match(r.reason, /^You stand cut off, with no walk out from here\. .* the next move out can be made in \d+ s: ask for the walk again then\.$/, r.reason);
    assert.ok(r.retry_after >= 1 && r.retry_after <= 60, JSON.stringify(r));
  }
  assert.equal(steps().length, 1, 'no second step out'); assert.equal(inRoom(), true);
  // once the minute is up the same ask steps her out again
  await w.settle(Math.ceil((wait! + 1) * 20)); assert.equal(w.edge.stepOutWait(w.soul as never), 0);
  const again = await act({verb: 'walk', target: 'field'}); assert.equal(again.accepted, true, JSON.stringify(again));
  assert.equal(steps().length, 2); assert.equal(again.receipt.reason, MOVED);
});

test('#1287 P3: with navigation cold the intent is refused as the flag walk is', {timeout: 300000}, async t => {
  const {w, mid, put, act, steps} = await world(t, false);
  await put(mid); assert.equal((w.host.engine as any).navWarmV1(0), false, 'still cold');
  assert.equal(w.edge.stepOutReady(w.soul as never), false);
  const r = await act({verb: 'walk', target: 'field'});
  assert.equal(r.code, 'route.unreachable', JSON.stringify(r)); assert.equal(steps().length, 0);
});

test('#1287 (#1501 review): shut in behind a locked door she may not open, no walk form steps her out: the door is never skipped, and the refusal names it', {timeout: 300000}, async t => {
  const {w, put, here, act, steps} = await world(t);
  // a walled yard on open ground, its door locked and its key side facing in (not hers: no thumb-turn on her side)
  const [x, z] = [30, 30];
  const built = w.god.act({ops: [
    {op: 'place', def: 'core/garden-wall@1', name: 'lock-yard', shape: {path: [[x - 0.6, z], [x - 4, z], [x - 4, z + 6], [x + 4, z + 6], [x + 4, z], [x + 0.6, z]]}},
    {op: 'place', def: 'core/door@3', name: 'lock-door', p: [x, z], r: 0, owner: 'soul:Zed', state: {locked: true}}]} as never) as any;
  assert.equal(built.accepted, true, JSON.stringify(built.failures)); await w.settle(8);
  assert.equal((w.host.engine as any).navWarmV1(Infinity), true); await w.settle(2);
  await put([x, z + 3]);
  assert.ok(w.edge.stepOutWait(w.soul as never) === 0, 'cut off, and the step-out alone would move her');
  const h = here(); assert.ok(h.exits.length > 0 && h.exits.every((e: any) => e.reachable === false && e.why === 'route.unreachable'), JSON.stringify(h.exits));
  const intent = await act({verb: 'walk', target: 'field'});
  assert.equal(intent.accepted, false, JSON.stringify(intent)); assert.equal(intent.code, 'route.unreachable');
  assert.match(intent.reason, /lock-door/, intent.reason);
  const byId = await act({capability: 'walk:field'});
  assert.equal(byId.accepted, false, JSON.stringify(byId)); assert.match(byId.reason, /lock-door/, byId.reason);
  assert.equal(steps().length, 0, 'never stepped out past the door');
});

test('#1287 (#1501 re-review): from open ground, a sit in a locked yard (more than walk steps) is refused as before, never by the step-out\'s door gate', {timeout: 300000}, async t => {
  const {w, put, act, steps} = await world(t);
  // the locked yard's front (key side) faces out: from outside, not Zed's, door passage refuses
  const [x, z] = [30, 30];
  const built = w.god.act({ops: [
    {op: 'place', def: 'core/garden-wall@1', name: 'lock-yard', shape: {path: [[x - 0.6, z], [x - 4, z], [x - 4, z + 6], [x + 4, z + 6], [x + 4, z], [x + 0.6, z]]}},
    {op: 'place', def: 'core/door@3', name: 'lock-door', p: [x, z], r: Math.PI, owner: 'soul:Zed', state: {locked: true}},
    {op: 'place', def: 'core/bench@1', name: 'lock-bench', p: [x + 1.5, z + 4]}]} as never) as any;
  assert.equal(built.accepted, true, JSON.stringify(built.failures)); await w.settle(8); w.edge.map();
  assert.equal((w.host.engine as any).navWarmV1(Infinity), true); await w.settle(2);
  const benchId = w.god.model.get('lock-bench')!.id;
  // a sit there: walk, then sit (not a plain walk, so door passage never planned it)
  await put([x + 3, z - 6]);
  const cap = (w.edge as any).capabilities(w.soul).find((c: any) => c.verb === 'sit' && (c.target?.id === benchId || c.object === benchId || String(c.id).includes('lock-bench')));
  assert.ok(cap, 'a sit on the bench is offered: ' + JSON.stringify((w.edge as any).capabilities(w.soul).filter((c: any) => /sit/.test(c.verb)).map((c: any) => c.id).slice(0, 20)));
  const id = cap.id, plan = (w.edge as any).bindOne(w.soul, id)?.plan;
  assert.equal(w.edge.stepOutWait(w.soul as never), null, 'on open ground: not cut off');
  assert.ok(plan && plan.steps.some((s: any) => s.verb !== 'walk_to' && s.verb !== 'stand'), `more than walk steps: ${JSON.stringify(plan?.steps)}`);
  const r = await act({capability: id});
  t.diagnostic(`outcome: ${JSON.stringify({accepted: r.accepted, code: r.code, reason: r.reason})}`);
  // the outcome before #1501's door gate (c5e7a4c1e): refused route.unreachable in the planner's own words, no door refusal
  assert.equal(r.accepted, false, JSON.stringify(r)); assert.equal(r.code, 'route.unreachable');
  assert.doesNotMatch(r.reason, /locked|It was not opened/, r.reason); assert.match(r.reason, /no walkable route reaches it/);
  assert.equal(steps().length, 0);
});
