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

test('#1287 P3: put back inside within the minute, every walk form is refused as before, and nothing moves her', {timeout: 300000}, async t => {
  const {w, mid, put, here, act, steps, inRoom} = await world(t);
  await put(mid); assert.equal((await act({capability: 'walk:field'})).accepted, true); assert.equal(steps().length, 1);
  await w.settle(3); await act({capability: 'stop'}); await w.settle(3);
  await put(mid); assert.equal(inRoom(), true);
  assert.ok(here().exits.every((e: any) => e.reachable === false && e.why === 'route.unreachable'), JSON.stringify(here().exits));
  for (const input of [{verb: 'walk', target: 'field'}, {capability: 'walk:field'}, {capability: 'walk:flag-orchard'}]) {
    const r = await act(input); assert.equal(r.code, 'route.unreachable', `${JSON.stringify(input)}: ${JSON.stringify(r)}`);
  }
  assert.equal(steps().length, 1, 'no second step out'); assert.equal(inRoom(), true);
});

test('#1287 P3: with navigation cold the intent is refused as the flag walk is', {timeout: 300000}, async t => {
  const {w, mid, put, act, steps} = await world(t, false);
  await put(mid); assert.equal((w.host.engine as any).navWarmV1(0), false, 'still cold');
  assert.equal(w.edge.stepOutReady(w.soul as never), false);
  const r = await act({verb: 'walk', target: 'field'});
  assert.equal(r.code, 'route.unreachable', JSON.stringify(r)); assert.equal(steps().length, 0);
});
