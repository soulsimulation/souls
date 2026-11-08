// #1355: a seated gesture is a layer. Nodding or clapping on a bench keeps the body seated and the sit receipt open; the sit
// goes on under the same receipt afterwards. A bow stands first, so it ends the sit as replaced, never as a kept seat.
// Hello-hamlet, a real genesis: the cottage's outdoor bench.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
const BENCH = 'sit:cottage/part-outdoor-bench';

async function seated(t: {after(f: () => void): void}, params?: unknown) {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const act = (capability: string, p?: unknown) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, {capability, ...(p ? {params: p} : {})} as never))) as Promise<any>;
  const human = () => (w.host.engine.world.entities as any)[w.soul.entityId].human;
  const holds = () => (w.host.engine as any).nativeSeatHoldsV1(w.soul.entityId).length as number;
  const receipt = (id: string) => w.edge.receipt(w.soul.soulId, id)!;
  const sit = await act(BENCH, params); assert.equal(sit.accepted, true, JSON.stringify(sit));
  const began = w.host.engine.world.tick;
  while (human().activity !== 'sit' && w.host.engine.world.tick - began < 2400) await w.settle(20);
  assert.equal(human().activity, 'sit');
  return {w, act, human, holds, receipt, sit: sit.receipt.id as string};
}
const sitting = (h: any) => h.activity === 'sit' || h.baseActivity === 'sit';

test('#1355 A1: a nod and a clap on the bench keep the body seated and the sit receipt open; the sit goes on after', {timeout: 300000}, async t => {
  const {w, act, human, holds, receipt, sit} = await seated(t);
  for (const [g, p] of [['nod:here', undefined], ['clap:here', {seconds: 3}]] as const) {
    const r = await act(g, p); assert.equal(r.accepted, true, JSON.stringify(r));
    await w.settle(2);
    assert.equal(receipt(sit).phase, 'started', `${g}: the sit stays open while the gesture plays: ${JSON.stringify(receipt(sit))}`);
    assert.ok(sitting(human()), `${g}: seated during the gesture`); assert.ok(holds() > 0, `${g}: the seat is still hers`);
    const began = w.host.engine.world.tick;
    while (['waiting', 'started'].includes(receipt(r.receipt.id).phase) && w.host.engine.world.tick - began < 400) await w.settle(10);
    assert.equal(receipt(r.receipt.id).phase, 'completed', `${g} completes: ${JSON.stringify(receipt(r.receipt.id))}`);
    await w.settle(10);
    assert.equal(receipt(sit).phase, 'started', `${g}: after it, the sit is still open: ${JSON.stringify(receipt(sit))}`);
    assert.ok(sitting(human()), `${g}: still seated after`); assert.ok(holds() > 0);
    assert.ok(w.host.engine.programOf(w.soul.entityId), `${g}: a programme holds the sit again`);
  }
  // standing ends the sit as before
  await act('stand:here'); await w.settle(20);
  assert.notEqual(receipt(sit).phase, 'started');
});

test('#1355 A1: a timed sit keeps its remaining time through a gesture and then ends as a sit does', {timeout: 300000}, async t => {
  const {w, act, receipt, sit} = await seated(t, {seconds: 12});
  await w.settle(20);
  const r = await act('nod:here'); assert.equal(r.accepted, true);
  const began = w.host.engine.world.tick;
  while (['waiting', 'started'].includes(receipt(r.receipt.id).phase) && w.host.engine.world.tick - began < 400) await w.settle(5);
  await w.settle(5);
  assert.equal(receipt(sit).phase, 'started', 'the nod is over and the timed sit goes on: ' + JSON.stringify(receipt(sit)));
  assert.ok(w.host.engine.programOf(w.soul.entityId), 'under a programme again');
  while (receipt(sit).phase === 'started' && w.host.engine.world.tick - began < 20 * 40) await w.settle(10);
  const done = receipt(sit);
  assert.equal(done.phase, 'completed', JSON.stringify(done)); assert.notEqual(done.code, 'seat.kept');
  const ticks = w.host.engine.world.tick - began;
  assert.ok(ticks < 20 * 20, `ends near its own time, not much later: ${ticks} ticks`);
});

test('#1355 A2: a bow stands first, so the sit ends replaced, never as a kept seat', {timeout: 300000}, async t => {
  const {w, act, human, receipt, sit} = await seated(t);
  const r = await act('bow:here'); assert.equal(r.accepted, true, JSON.stringify(r));
  await w.settle(10);
  const s = receipt(sit);
  assert.equal(s.phase, 'replaced', JSON.stringify(s)); assert.notEqual(s.code, 'seat.kept');
  await w.settle(80); assert.ok(!sitting(human()), 'standing after the bow');
});
