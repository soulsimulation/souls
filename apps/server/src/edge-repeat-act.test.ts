// #1272: a Soul repeating the act it's already doing isn't asking for a new one. Hello-hamlet, a real genesis, the real act path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {Db} from './db.ts';
import {AgentInbox} from './inbox.ts';
import {OwnerLoop} from './edge/owner-loop.ts';
import type {EdgeReceipt} from './edge/contract.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
const WALK = 'walk:cottage/bench';

async function world(t: {after(f: () => void): void}) {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const act = (capability: string, params?: unknown, clientRef?: string) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, {capability, ...(params ? {params} : {}), ...(clientRef ? {clientRef} : {})} as never))) as Promise<any>;
  const receipt = (id: string) => w.edge.receipt(w.soul.soulId, id)!;
  const pos = () => [...(w.host.engine.world.entities as any)[w.soul.entityId].pose.p] as number[];
  const ended = async (id: string) => {for (let i = 0; i < 300 && ['waiting', 'started'].includes(receipt(id).phase); i++) await w.settle(20); return receipt(id);};
  return {w, act, receipt, pos, ended};
}

test('#1272 R1: the same act while it runs returns its receipt; nothing is replaced and the walk goes on', {timeout: 300000}, async t => {
  const {w, act, receipt, pos, ended} = await world(t);
  const first = await act(WALK); assert.equal(first.accepted, true, JSON.stringify(first));
  await w.settle(60);
  const before = pos(), again = await act(WALK);
  assert.equal(again.accepted, true); assert.equal(again.repeat, true); assert.equal(again.receipt.id, first.receipt.id);
  assert.equal(receipt(first.receipt.id).phase, 'started', 'still under way');
  await w.settle(40);
  assert.ok(Math.hypot(pos()[0]! - before[0]!, pos()[2]! - before[2]!) > 0.5, 'she kept walking');
  assert.equal((await ended(first.receipt.id)).phase, 'completed');
});

test('#1272 R1: a look mid-walk and a retried old request leave the walk matched', {timeout: 300000}, async t => {
  const {w, act, receipt, ended} = await world(t);
  const rest = await act('rest:here', {seconds: 1}, 'old-rest'); await ended(rest.receipt.id);
  const first = await act(WALK); await w.settle(30);
  const look = await act('look at the bench'); assert.equal(look.accepted, true, JSON.stringify(look));
  assert.equal(receipt(first.receipt.id).phase, 'started', 'the look took no body');
  assert.equal((await act(WALK)).receipt.id, first.receipt.id, 'still the same walk after a look');
  assert.equal((await act('rest:here', {seconds: 1}, 'old-rest')).receipt.id, rest.receipt.id, 'the old answer replays');
  const again = await act(WALK); assert.equal(again.receipt.id, first.receipt.id, 'and the replay changed nothing'); assert.equal(again.repeat, true);
});

test('#1272 R2: words, answers, stands and hand acts are not repeats', {timeout: 300000}, async t => {
  const {w, act, receipt} = await world(t);
  const a = await act(WALK); await w.settle(10);
  const words = await act('walk to the cottage bench'); assert.equal(words.repeat, undefined);
  assert.equal(receipt(a.receipt.id).phase, 'replaced', 'words replace, as they did');
  // answers and stands do something each time: a stand has a job in the stall guard, a stale accept is shared.busy
  for (const capability of ['stand:here', 'accept:inv_1', 'decline:inv_1', 'pick-up:letter']) assert.equal((w.edge as any).actKey({capability}), null, capability);
});

test('#1272 R2: a receipt in a shared operation is never a repeat', {timeout: 300000}, async t => {
  const {w, act} = await world(t);
  const first = await act(WALK); await w.settle(10);
  const edge = w.edge as any, open = edge.openReceipts;
  assert.equal(edge.repeatOf(w.soul, {capability: WALK})?.id, first.receipt.id);
  edge.openReceipts = (id: string) => open.call(edge, id).map((r: object) => ({...r, shared: {phase: 'started'}})); t.after(() => {edge.openReceipts = open;});
  assert.equal(edge.repeatOf(w.soul, {capability: WALK}), null);
});

test('#1272 R6: a {verb, target} repeat says so and leaves the receipt as chosen', {timeout: 300000}, async t => {
  const {w, receipt} = await world(t);
  const go = (extra: Record<string, unknown>) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, {verb: 'walk', target: {place: 'cottage/bench'}, ...extra} as never))) as Promise<any>;
  const first = await go({}); assert.equal(first.accepted, true, JSON.stringify(first)); await w.settle(10);
  const before = JSON.stringify(receipt(first.receipt.id).chosen);
  const again = await go({note: 'a different intent'});
  assert.equal(again.repeat, true, JSON.stringify(again)); assert.equal(again.receipt.id, first.receipt.id);
  assert.equal(JSON.stringify(receipt(first.receipt.id).chosen), before);
});

test('#1272 R2: other params or another act replace it, and the same act after the end is a new one', {timeout: 300000}, async t => {
  const {w, act, receipt, ended} = await world(t);
  const a = await act('read:here', {seconds: 20}); await w.settle(4);
  const b = await act('read:here', {seconds: 30}); await w.settle(4);
  assert.notEqual(b.receipt.id, a.receipt.id); assert.equal(b.repeat, undefined); assert.equal(receipt(a.receipt.id).phase, 'replaced');
  const c = await act(WALK); await w.settle(4);
  assert.notEqual(c.receipt.id, b.receipt.id); assert.equal(receipt(b.receipt.id).phase, 'replaced');
  assert.equal((await ended(c.receipt.id)).phase, 'completed');
  const d = await act(WALK);
  assert.notEqual(d.receipt.id, c.receipt.id, 'done is done: asking again is a new act'); assert.equal(d.repeat, undefined);
});

test('#1272 R4: a retry of a repeat finds the same receipt, while it runs and after it ends', {timeout: 300000}, async t => {
  const {w, act, ended} = await world(t);
  const first = await act(WALK, undefined, 'ref-one'); await w.settle(20);
  const again = await act(WALK, undefined, 'ref-two'); assert.equal(again.receipt.id, first.receipt.id);
  assert.equal((await act(WALK, undefined, 'ref-two')).receipt.id, first.receipt.id);
  await ended(first.receipt.id);
  const late = await act(WALK, undefined, 'ref-two');
  assert.equal(late.receipt.id, first.receipt.id, 'the retry does not act twice');
  assert.equal((await act(WALK, undefined, 'ref-one')).receipt.id, first.receipt.id, 'the first ref still answers too');
});

test('#1272 R5: the offer gate lets a repeat through even when the offer has gone', {timeout: 300000}, async t => {
  const {w, act} = await world(t);
  // rest, because a walk's id has its own way through the gate (far offers, by id) and would pass with or without this
  const REST = {capability: 'rest:here', params: {seconds: 60}};
  const first = await act(REST.capability, REST.params); assert.equal(first.accepted, true, JSON.stringify(first)); await w.settle(10);
  const edge = w.edge as any, bindOne = edge.bindOne, binds = edge.binds, words = edge.wordsMenu, dry = edge.intents.dryRun, none = () => ({caps: [], plans: new Map()});
  edge.bindOne = () => undefined; edge.binds = none; edge.wordsMenu = none; edge.intents.dryRun = () => ({});
  t.after(() => {edge.bindOne = bindOne; edge.binds = binds; edge.wordsMenu = words; edge.intents.dryRun = dry;});
  assert.notEqual(edge.offerGate(w.soul, {capability: REST.capability, params: {seconds: 30}}), null, 'with the offer gone, a different act meets the gate');
  assert.equal(edge.offerGate(w.soul, REST), null, 'the act under way answers');
});

test('#1272 R3: both owner messages on a repeated act close when its receipt ends, the first keeping its own steps', t => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-1272-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  const db = new Db(join(dir, 'fixture.db')); t.after(() => db.close());
  const inbox = new AgentInbox(db, 'w1'), soul = {soulId: 's_bo', entityId: 'h_bo', name: 'Bo', owner: 'mira'}, scope = {scope: 'soul:s_bo', owner: 'mira'};
  const rec = (phase: EdgeReceipt['phase']) => ({id: 'r_walk', soulId: 's_bo', capability: 'walk:pond', phase, acceptedTick: 1, startedTick: 1, endedTick: phase === 'completed' ? 2 : null, code: null}) as unknown as EdgeReceipt;
  let emit: (r: EdgeReceipt) => void = () => {};
  const loop = new OwnerLoop(inbox, () => ({...rec('completed'), done: 'walk completed at the pond.'}) as never, l => {emit = l;});
  const take = (text: string) => {inbox.send(scope, text); const m = inbox.takeBacklog(scope).at(-1)!; inbox.acknowledge(scope, m.id, 'On it'); return m.id;};
  const row = (id: string) => db.db.prepare('SELECT result,result_by FROM soul_inbox_queue_v1 WHERE id=?').get(id) as {result: string | null; result_by: string | null};
  const one = take('walk to the pond'), two = take('are you going to the pond?');
  loop.link(soul, rec('started'), one); loop.link(soul, rec('started'), two);
  assert.equal(row(one).result, null); assert.equal(row(two).result, null);
  emit(rec('completed'));
  assert.equal(row(one).result_by, 'server', 'the first message closes'); assert.equal(row(two).result_by, 'server', 'and so does the repeat');
  const three = take('walk to the pond');
  loop.link(soul, rec('started'), three); loop.link(soul, rec('started'), three);
  emit(rec('completed'));
  assert.equal(row(three).result_by, 'server', 'one message linked twice closes once');
  // a message of several steps stays open when its first step ends; the repeat's own message still closes
  const four = take('walk to the pond and then rest'), five = take('how far is the pond?');
  assert.equal(loop.link(soul, rec('started'), four, true).open, true, 'the walk is not its last step');
  loop.link(soul, rec('started'), five);
  emit(rec('completed'));
  assert.equal(row(four).result, null, 'the first message keeps its own steps'); assert.equal(row(five).result_by, 'server');
});
