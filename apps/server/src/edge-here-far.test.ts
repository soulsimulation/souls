// #1281: a far line's id is a walk that would go. Hello-hamlet, a real genesis, the real act path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {hereFrame} from './edge/perception/here.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
async function world(t: {after(f: () => void): void}, template?: URL) {
  const w = await bootEden(() => {}, template ?? hamlet); t.after(w.close);
  const put = async (to: [number, number]) => {await accept(w.host, w.host.enqueue('edge-relocate', 'test:put', {soulId: w.soul.soulId, entityId: w.soul.entityId, to})); await w.settle(6);};
  const here = () => hereFrame(w.edge, w.soul, {doHere: true}) as any;
  const ids = (h: any) => (h.far as string[]).map(x => x.split(' · ').find(p => p.startsWith('walk:'))).filter(Boolean) as string[];
  const act = (capability: string) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, {capability} as never))) as Promise<any>;
  return {w, put, here, ids, act};
}

test('#1281 H1, H3: past the reach of exits a far line still ends with its walk, and a strict client can send it', {timeout: 300000}, async t => {
  const {w, put, here, ids, act} = await world(t);
  await put([200, 200]);
  const h = here(), go = ids(h);
  assert.equal(h.exits.length, 0, JSON.stringify(h.exits)); assert.ok(go.length >= 3, JSON.stringify(h.far));
  assert.equal((w.edge as any).offerGate(w.soul, {capability: go[0]}), null);
  const r = await act(go[0]!); assert.equal(r.accepted, true, JSON.stringify(r));
});

test('#1281 H3: from a room with no way out no far line offers a walk that would be refused', {timeout: 300000}, async t => {
  const {w, put, here, ids} = await world(t);
  const room = w.edge.places.byId.get('g-lab-reading-room')!, at = room.polygon.reduce((s, q) => [s[0] + q[0] / room.polygon.length, s[1] + q[1] / room.polygon.length], [0, 0]) as [number, number];
  await put(at);
  const h = here(); assert.ok(h.exits.length > 0 && h.exits.every((e: any) => e.reachable === false), JSON.stringify(h.exits));
  assert.deepEqual(ids(h), [], JSON.stringify(h.far));
});

const marsTwo = new URL('../../../worlds/templates/mars-two.json', import.meta.url);

test('#1281 H3: a walk offered only on demand is route-checked too: none from a closed house', {timeout: 300000}, async t => {
  const {w, put, here, ids, act} = await world(t, marsTwo);
  const {ref: _r, hash: _h, by: _b, born: _bo, ...definition} = w.god.model.resolvedDef('core/cottage@1') as any;
  const built = w.god.act({ops: [{op: 'define', def: {...definition, name: 'closed-cottage-control', state: {...definition.state, doors: {type: 'json', default: {}}}}}, {op: 'place', def: 'closed-cottage-control@1', name: 'closed-house', p: [440, 0], state: {doors: {'front-door': 'closed'}}}]} as never);
  assert.equal(built.accepted, true, JSON.stringify(built)); await w.settle(8); w.edge.map();
  const room = [...w.edge.places.byId.values()].find(p => /closed-house.*bedroom/.test(p.id))!;
  await put(room.polygon.reduce((s, q) => [s[0] + q[0] / room.polygon.length, s[1] + q[1] / room.polygon.length], [0, 0]) as [number, number]);
  const h = here(); assert.deepEqual(ids(h), [], JSON.stringify(h.far));
  assert.equal((await act('walk:chiba')).code, 'route.unreachable', 'the walk the line left out would have been refused');
});

test('#1281 H1: a water place keeps its walk, though the walk aims at its shore', {timeout: 300000}, async t => {
  const {put, here, ids} = await world(t, marsTwo);
  await put([450, 2]);
  assert.ok(ids(here()).includes('walk:campus-swimming-pond'), JSON.stringify(here().far));
});

test('#1281: on a replica no route issue is not remembered, so a verdict that arrives later counts', {timeout: 300000}, async t => {
  const {w} = await world(t);
  const edge = w.edge as any, feas = edge.mw.feasibility, ask = feas.canPerform, plans = new Map([['walk:x', {label: 'Walk', steps: [{verb: 'walk_to', params: {to: [0, 0]}}]}]]);
  edge.readOnly = true; t.after(() => {edge.readOnly = false; feas.canPerform = ask;});
  feas.canPerform = () => null;
  assert.equal(w.edge.routeProblem(w.soul, 'walk:x', plans as never), null);
  feas.canPerform = () => ({code: 'route.unreachable'});
  assert.equal(w.edge.routeProblem(w.soul, 'walk:x', plans as never)?.code, 'route.unreachable');
});

test('#1281: a far line repeats neither an exit nor the place she stands in', {timeout: 300000}, async t => {
  const {here, ids} = await world(t);
  const h = here(), exits = new Set(h.exits.map((e: any) => e.walk));
  for (const id of ids(h)) assert.ok(!exits.has(id), id);
  assert.ok(!(h.far as string[]).some(x => / · been.* · walk:/.test(x) && x.includes(' 0m')), JSON.stringify(h.far));
});

test('#1281 H4: a flag in a secret place is not named until she knows the place', {timeout: 300000}, async t => {
  const {w, here} = await world(t);
  for (const op of [{op: 'place', def: 'core/zone@1', name: 'hidden-grove', shape: {area: [[60, 60], [90, 60], [90, 90], [60, 90]]}, params: {use: 'park'}}, {op: 'place', def: 'core/flag@1', name: 'grove-flag', p: [75, 75], state: {label: 'the hidden grove'}}]) assert.equal(w.god.act({ops: [op]} as never).accepted, true);
  await w.settle(8); w.edge.map();
  const grove = [...w.edge.places.byId.values()].find(p => /hidden-grove/.test(p.id))!;
  assert.ok((here().flags as string[]).some(l => l.startsWith('the hidden grove')), 'a public place: named');
  assert.equal(w.edge.knowledge.setSecret(grove.id, true), true); await w.settle(3);
  assert.ok(!JSON.stringify(here().flags).includes('hidden grove'), JSON.stringify(here().flags));
});

test('#1281: what far and flags name leaves the room for what can be done here as it was', {timeout: 300000}, async t => {
  const {w, here} = await world(t, new URL('../../../worlds/templates/eden-2026.json', import.meta.url));
  const edge = w.edge as any, flags = edge.namedFlagsV1, resolve = edge.resolveIdV1;
  const six = Array.from({length: 6}, (_, i) => ({name: `flag ${i}`, walk: `walk:flag-f${i}`, at: [i, 0] as [number, number]}));
  edge.namedFlagsV1 = () => six; const full = here();
  edge.namedFlagsV1 = () => []; edge.resolveIdV1 = () => ({kind: 'unknown'}); const bare = here();
  edge.namedFlagsV1 = flags; edge.resolveIdV1 = resolve;
  assert.equal(full.flags.length, 4); assert.ok(full.doHere.length > 0, 'offers stay listed');
  assert.ok(Math.abs(full.doHereCoverage.byteBudget - bare.doHereCoverage.byteBudget) <= 8, `${full.doHereCoverage.byteBudget} against ${bare.doHereCoverage.byteBudget}`);
  assert.deepEqual(full.doHere, bare.doHere);
});
