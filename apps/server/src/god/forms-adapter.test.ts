// SA-F3a follow-up: what the agent's client reads of an entry thing on today's engine. The catalog publishes the loaded entry
// (`entries`, by the kind its def's `entry` param names) and changes nothing for other things; a form refused when it is
// sent, or failed when its programme ends, carries the rules library's verdict (`decided`) in the answer the client gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {coreRef} from '@souls/world-compiler';
import {fixture, factory, invite, accept} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {ledgerCatalog} from '../edge/catalog/routes.ts';
import {GodMode} from './god.ts';
import {GroundHost, installGroundCapabilities} from './ground-host.ts';
import {installEngineBridge} from './engine-bridge.ts';
import {registerEdgeComms} from '../edge/comms/index.ts';
import {edgeSoulResolver} from '../edge/routes.ts';
import type {EdgeSoul} from '../edge/contract.ts';
import {valueAt, type Timed} from '../../../../packages/form-rules/src/rules.ts';
// @ts-expect-error: plain .mjs tools without types
import {loadDef} from '../../../../tools/entry/load.mjs';
// @ts-expect-error: plain .mjs tools without types
import {hashKinds} from '../../../../tools/entry/format.mjs';
// @ts-expect-error: plain .mjs tools without types
import {loadEntries} from '../../../../tools/entry/look.mjs';

const ROOT = resolve(import.meta.dirname, '../../../..');
/** The kettle's def as tools/entry/load.mjs defines it, and its entry. */
function kettle() {
  const rows = (loadEntries(resolve(ROOT, 'content/kinds'), 'content/kinds') as {entry?: {kind: string}; errors: unknown[]}[]).filter((r) => r.entry && !r.errors.length);
  const entry = rows.find((r) => r.entry!.kind === 'eden:kettle')!.entry!, refs = hashKinds(rows.map((r) => r.entry));
  return {def: loadDef(entry, refs.get('eden:kettle').ref).def as {name: string; version: number}, entry: entry as {kind: string; state: Record<string, {min: number; max: number}>}};
}

test('an entry thing on today\'s engine: its entry in the catalog, and the rules\' verdict in a refusal', {timeout: 300_000}, async (t) => {
  const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}}), edge = new EdgeLedger(f.host, f.db);
  new GroundHost(f.db, f.host, god); installGroundCapabilities(edge, god, f.host);
  const bridge = installEngineBridge({host: f.host, god, edge, log() {}, worldClock: false, worldLore: true});
  const comms = registerEdgeComms(new Hono(), {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, () => undefined), ledger: edge}, {sweepMs: 0, fetch: null}); edge.attachComms(comms as never);
  t.after(() => {comms.close(); f.brain.quiesce(); f.host.stop(); f.db.close();});
  const tick = async (n = 4) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); if (i % 20 === 0) {await setImmediate(); f.host.drainInputs();}}};
  await tick();
  const ok = (r: {accepted: boolean}) => {assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 400)); return r;};
  ok(god.act({ops: [
    {op: 'place', def: coreRef('zone'), name: 'field', shape: {area: [[-30, -30], [30, -30], [30, 30], [-30, 30]]}, params: {use: 'park'}},
    {op: 'place', def: coreRef('desk-lamp'), name: 'lamp', p: [4, 2]},
  ]} as never)); await tick(8);
  bridge.perceive.sync(true);
  const before = ledgerCatalog(edge).payload;
  assert.equal('entries' in before, false, 'no entry thing, no entries');

  // A1: the kettle, loaded as load.mjs loads it
  const k = kettle();
  ok(god.act({ops: [{op: 'define', def: k.def}]} as never));
  ok(god.act({ops: [{op: 'place', def: `${k.def.name}@${k.def.version}`, name: 'kettle', p: [6, 0]}]} as never)); await tick(8);
  bridge.perceive.sync(true);
  const kettleId = god.model.get('kettle')!.id, after = ledgerCatalog(edge).payload;
  assert.deepEqual(Object.keys(after.entries ?? {}), ['eden:kettle'], 'keyed by the kind the def\'s entry param names');
  assert.deepEqual(after.entries!['eden:kettle'], k.entry, 'the entry as loaded');
  assert.equal(after.things.find((x) => x.id === kettleId)?.kind, 'eden:kettle', 'the thing is of that kind');
  assert.ok(after.kinds['eden:kettle']?.acts.some((a) => a.verb === 'switch_on'), 'its offered forms are under the same kind');
  assert.deepEqual(after.things.filter((x) => x.id !== kettleId), before.things, 'other things are as before');
  assert.deepEqual(Object.fromEntries(Object.entries(after.kinds).filter(([kind]) => kind !== 'eden:kettle')), before.kinds, 'other kinds are as before');

  // A2 at the start: the kettle is empty, so switching it on is refused with the rules' verdict
  await invite(f, 'ada'); const row = await accept(f.host, f.souls.create('dev:ada', {name: 'Ada', description: 'entry kettle'}));
  const soul: EdgeSoul = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await tick(4); bridge.perceive.sync(true); edge.map(); edge.invalidateBodies();
  const act = async (capability: string) => {const no = edge.offerGate(soul, {capability}); if (no) return no as Record<string, any>; let done = false; const p = edge.act(soul, {capability}).finally(() => {done = true;}); for (let i = 0; i < 400 && !done; i++) await tick(1); return await p as Record<string, any>;};
  const refused = await act(`object:${kettleId}:switch_on`);
  assert.equal(refused.accepted, false, JSON.stringify(refused).slice(0, 400));
  assert.equal(refused.code, 'form.field_differs');
  assert.equal(refused.decided?.verdict, 'no');
  assert.equal(refused.decided?.reason, 'field_differs');
  assert.deepEqual(refused.decided?.detail, {field: 'water', found: 0, wanted: {at_least: 1}});
  assert.ok(refused.decided?.read.some(([addr, v]: [string, unknown]) => addr === `${kettleId}/field/1` && v === 0), 'what the world read');
  assert.equal(JSON.parse(JSON.stringify(refused)).decided.reason, 'field_differs', 'it survives the wire');

  // A2 at the end: accepted, then the kettle is switched on by someone else before the press; the receipt fails with the verdict
  ok(god.act({ops: [{op: 'set', id: kettleId, state: {water: 1000}}]} as never)); await tick(4); bridge.perceive.sync(true); edge.invalidateBodies();
  const going = await act(`object:${kettleId}:switch_on`) as {accepted: boolean; receipt?: {id: string}};
  assert.equal(going.accepted, true, JSON.stringify(going).slice(0, 400));
  ok(god.act({ops: [{op: 'set', id: kettleId, state: {heating: true}}]} as never));
  const receipt = () => edge.receipt(soul.soulId, going.receipt!.id)! as Record<string, any>;
  for (let i = 0; i < 300 && ['waiting', 'started'].includes(receipt().phase); i++) await tick(20);
  assert.equal(receipt().phase, 'failed', JSON.stringify(receipt()).slice(0, 400));
  assert.equal(receipt().code, 'form.field_differs');
  assert.deepEqual(receipt().decided?.detail, {field: 'heating', found: true, wanted: {is: false}});

  // A timed field: the adapter gives the rules the world's time, so a bare switch_on is not refused `no_time`; the kettle's
  // heat is set rising from that time and reads, at later world times, warmer until it holds at its boil
  ok(god.act({ops: [{op: 'set', id: kettleId, state: {heating: false}}]} as never)); await tick(4); bridge.perceive.sync(true); edge.invalidateBodies();
  const on = await act(`object:${kettleId}:switch_on`) as {accepted: boolean; receipt?: {id: string}};
  assert.equal(on.accepted, true, JSON.stringify(on).slice(0, 400));
  const onReceipt = () => edge.receipt(soul.soulId, on.receipt!.id)! as Record<string, any>;
  for (let i = 0; i < 300 && ['waiting', 'started'].includes(onReceipt().phase); i++) await tick(20);
  assert.equal(onReceipt().phase, 'completed', JSON.stringify(onReceipt()).slice(0, 400));
  const state = () => god.model.entities.get(kettleId)!.state as unknown as {heating: unknown; heat: Timed};
  const nowUs = () => f.host.engine.world.tick * 50_000;
  assert.equal(state().heating, true);
  const heat = state().heat, kh = k.entry.state.heat;
  assert.equal(heat.per_s, 500, 'warming at the form\'s rate');
  assert.ok(heat.set_us > 0 && heat.set_us <= nowUs(), `set at the world's time: ${JSON.stringify(heat)} at ${nowUs()}`);
  const first = valueAt(kh, heat, nowUs()) as number;
  await tick(200);   // ten seconds of world time
  const later = valueAt(kh, state().heat, nowUs()) as number;
  assert.ok(later > first && later < 100_000, `heat rises over world time: ${first} then ${later}`);
  assert.equal(valueAt(kh, state().heat, Number(heat.set_us) + 150_000_000), 100_000, 'boiled 150 s after it was switched on');

  // A crossing that is due: past the boil, the next plan runs the kettle's `boiled` once, at the time it crossed, as the
  // world; `heating` reads false and the heat cools from the boil, so the kettle can be switched on again
  const boil = Number(heat.set_us) + 150_000_000;
  while (nowUs() < boil + 20_000_000) await tick(100);
  assert.equal(state().heating, true, 'nothing written between events');
  const planned = (bridge as unknown as {forms: {plan(s: {entityId: string}, id: string, a: string): unknown}}).forms.plan(soul, kettleId, 'switch_on');
  assert.ok(planned && 'steps' in (planned as object), JSON.stringify(planned).slice(0, 400));
  assert.equal(state().heating, false, 'boiled: switched itself off');
  assert.deepEqual(state().heat, {value: 100_000, per_s: -50, set_us: boil}, 'cooling from the moment it boiled');
  const cooled = state().heat;
  (bridge as unknown as {forms: {plan(s: {entityId: string}, id: string, a: string): unknown}}).forms.plan(soul, kettleId, 'switch_on');
  assert.equal(state().heat, cooled, 'each crossing runs once');
  const again = await act(`object:${kettleId}:switch_on`) as {accepted: boolean; receipt?: {id: string}};
  assert.equal(again.accepted, true, JSON.stringify(again).slice(0, 400));
  const againReceipt = () => edge.receipt(soul.soulId, again.receipt!.id)! as Record<string, any>;
  for (let i = 0; i < 300 && ['waiting', 'started'].includes(againReceipt().phase); i++) await tick(20);
  assert.equal(againReceipt().phase, 'completed', JSON.stringify(againReceipt()).slice(0, 400));
  assert.equal(state().heating, true, 'switched on again');
  assert.equal(state().heat.per_s, 500);
  assert.ok((state().heat.value as number) < 100_000 && (state().heat.value as number) > 25_000, `warming again from where it cooled to: ${JSON.stringify(state().heat)}`);
});
