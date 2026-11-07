// #1288: a repeat answers with the act under way (#1272), so a stuck act has to end by itself. Hello-hamlet, the real act path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept, invite} from '../test/native-owner-fixture.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
async function world(t: {after(f: () => void): void}) {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const act = (capability: string) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, {capability} as never))) as Promise<any>;
  const receipt = (id: string) => w.edge.receipt(w.soul.soulId, id)!;
  /** Hold every walk at pace 0, the shape of a live "walking on the spot" report, until the receipt ends. */
  const stuck = async (id: string) => {
    const execs = () => [...((w.host.engine as any).rt.services.walkExecs?.values() ?? [])] as {speed: number}[];
    for (let i = 0; i < 900 && ['waiting', 'started'].includes(receipt(id).phase); i++) {for (const ex of execs()) ex.speed = 0; await w.settle(1);}
    return receipt(id);
  };
  return {w, act, stuck};
}

test('#1288 W1, W6: a stuck jog ends walk.stuck, and the same jog sent again is a new act', {timeout: 300000}, async t => {
  const {w, act, stuck} = await world(t);
  const jogs = w.edge.capabilitiesPage(w.soul as never, {all: true}).capabilities.filter((c: any) => c.verb === 'jog' && c.available).map((c: any) => c.id);
  const jog = jogs.find((id: string) => /knoll|cottage/.test(id))!; assert.ok(jog, JSON.stringify(jogs));
  const first = await act(jog); assert.equal(first.accepted, true, JSON.stringify(first)); await w.settle(4);
  assert.equal((await act(jog)).repeat, true, 'while it runs, a repeat answers with it');
  const end = await stuck(first.receipt.id);
  assert.equal(end.phase, 'failed', JSON.stringify(end)); assert.equal(end.code, 'walk.stuck');
  const again = await act(jog); assert.equal(again.repeat, undefined); assert.notEqual(again.receipt.id, first.receipt.id);
});

test('#1288 W2: a stuck go-near ends walk.stuck', {timeout: 300000}, async t => {
  const {w, act, stuck} = await world(t);
  await invite(w, 'bob'); const bob = await accept(w.host, w.souls.create('dev:bob', {name: 'Bob', description: 'stands about'})) as {id: string; entity_id: string};
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:put', {soulId: bob.id, entityId: bob.entity_id, to: [20, 20]})); await w.settle(6);
  const first = await act('go-near:' + bob.id); assert.equal(first.accepted, true, JSON.stringify(first));
  const end = await stuck(first.receipt.id);
  assert.equal(end.phase, 'failed', JSON.stringify(end)); assert.equal(end.code, 'walk.stuck');
});
