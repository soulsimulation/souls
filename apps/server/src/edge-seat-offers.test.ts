// #485, #628: what's offered executes, and what a Soul did stays read as done. Hello-hamlet, a real genesis, two Souls, the
// cottage's outdoor bench: its named part holds one slot of the bench.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {menuWorldOf} from './split/menu-world.ts';
import {accept, invite} from '../test/native-owner-fixture.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
const BENCH = 'sit:cottage/part-outdoor-bench';

async function seated(t: {after(f: () => void): void}) {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  await invite(w as never, 'bo');
  const row = await accept(w.host, w.souls.create('dev:bo', {name: 'Bo', description: 'a neighbour'})) as {id: string; entity_id: string; name: string; owner: string};
  const bo = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await w.settle(3);
  const act = (soul: unknown, capability: string, params?: unknown) => accept(w.host, Promise.resolve(w.edge.act(soul as never, {capability, ...(params ? {params} : {})} as never))) as Promise<any>;
  const human = (id: string) => (w.host.engine.world.entities as any)[id].human;
  const sit = await act(w.soul, BENCH); assert.equal(sit.accepted, true, JSON.stringify(sit));
  const began = w.host.engine.world.tick;
  while (human(w.soul.entityId).activity !== 'sit' && w.host.engine.world.tick - began < 2400) await w.settle(20);
  assert.equal(human(w.soul.entityId).activity, 'sit');
  return {w, bo, act, human, sit};
}
const offer = (w: any, soul: unknown) => (w.edge.coreA.binds(soul).caps as any[]).find(c => c.id === BENCH);

test('#485: a named seat someone holds is not offered as free, and refuses at once saying so', {timeout: 300000}, async t => {
  const {w, bo, act} = await seated(t);
  const cap = offer(w, bo);
  assert.equal(cap?.available, false, JSON.stringify(cap)); assert.equal(cap.blocked.code, 'seat.taken');
  const dry = w.edge.intents.dryRun(bo as never, {capability: BENCH}) as any;
  assert.equal(dry.would?.available, false, JSON.stringify(dry)); assert.equal(dry.would.blocked.code, 'seat.taken');
  const r = await act(bo, BENCH).catch((e: {code?: string; message: string}) => ({accepted: false, code: e.code, reason: e.message}));
  assert.equal(r.accepted, false, JSON.stringify(r)); assert.equal(r.code, 'seat.taken');
  assert.ok((w.host.engine as any).nativeSeatHoldsV1(w.soul.entityId).length > 0, 'the sitter keeps the seat');
  await act(w.soul, 'stand:here'); await w.settle(40);
  assert.equal(offer(w, bo)?.available, true, 'free again once she stands');
});

test('#485: a kept menu follows the seat, whoever moved', {timeout: 300000}, async t => {
  const {w, bo} = await seated(t), world = menuWorldOf(w.host as never) as any, seats = world.seatOccupantsV1;
  assert.equal(offer(w, bo)?.available, false);
  await w.settle(1); world.seatOccupantsV1 = () => []; t.after(() => {world.seatOccupantsV1 = seats;});   // nobody moved, so only the seat read can see it
  await w.settle(1);
  assert.equal(offer(w, bo)?.available, true, 'the kept menu is dropped when the seat it read changed');
});

test('#485: a sit still on its way to the seat is replaced as before, seat claim or not', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const act = (capability: string, params?: unknown) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, {capability, ...(params ? {params} : {})} as never))) as Promise<any>;
  const sit = await act(BENCH); assert.equal(sit.accepted, true);
  // the window: her claim on the seat is held, and she hasn't sat yet
  const holds = () => (w.host.engine as any).nativeSeatHoldsV1(w.soul.entityId).length, activity = () => (w.host.engine.world.entities as any)[w.soul.entityId].human.activity;
  for (let i = 0; i < 2400 && !holds(); i++) await w.settle(1);
  assert.ok(holds() > 0, 'the walking sit holds its seat'); assert.notEqual(activity(), 'sit', 'and she is not on it yet');
  // rest, because it doesn't stand her first: a read or a wave here does, and never asks whether she is seated
  const rest = await act('rest:here', {seconds: 20}); assert.equal(rest.accepted, true, JSON.stringify(rest)); await w.settle(4);
  const r = w.edge.receipt(w.soul.soulId, sit.receipt.id)!;
  assert.equal(r.phase, 'replaced', JSON.stringify(r)); assert.equal(r.code ?? null, null);
});

test('#485: a read on a seat leaves the sit done, not cut short; getting up to go elsewhere still replaces', {timeout: 300000}, async t => {
  const {w, act, sit} = await seated(t);
  const read = await act(w.soul, 'read:here', {seconds: 30}); assert.equal(read.accepted, true, JSON.stringify(read));
  await w.settle(10);
  const done = w.edge.receipt(w.soul.soulId, sit.receipt.id)!;
  assert.equal(done.phase, 'completed', JSON.stringify(done)); assert.equal(done.code, 'seat.kept'); assert.match(done.reason ?? '', /Still seated/);
  assert.match(done.outcome?.summary ?? '', /, still seated\.$/, JSON.stringify(done.outcome));
  assert.ok((w.host.engine as any).nativeSeatHoldsV1(w.soul.entityId).length > 0, 'and she is still on the seat');
  const sit2 = await act(w.soul, 'stand:here'); assert.equal(sit2.accepted, true);
  await w.settle(10);
  assert.equal(w.edge.receipt(w.soul.soulId, read.receipt.id)!.phase, 'replaced', 'a read that was cut off still says so');
});
