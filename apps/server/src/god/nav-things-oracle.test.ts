// #2489 A1: nav's things list is updated from each commit's changed entities (GodNav.update), not rebuilt. The oracle:
// after every edit of a corpus of engine and god edits on Eden 2026 (doors, moves, renames of holders, meaning parts and
// what they name, a child named like a room, removals and placements, containers shut on what they keep) and after every
// tick of Souls walking, sitting and acting, the list equals a whole pass of a fresh nav (no memo, nothing kept).
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {bootEden} from '../../test/eden-capabilities-timing.ts';
import {accept} from '../../test/native-owner-fixture.ts';
import type {EdgeCapability, EdgeSoul} from '../edge/contract.ts';
import type {Entity} from '@souls/world-compiler';

const NO_EDEN = existsSync(new URL('../../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json';
type Nav = {things(): {ref: string; kind: string; id: string}[]; thingsOracleV1(): string | null; update: (...a: unknown[]) => unknown};
type Result = {accepted: boolean; failures?: unknown[]};

test('Eden 2026: the things list updated from each commit equals a whole pass, after every edit and every tick', {timeout: 600_000, skip: NO_EDEN}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge, host = w.host, god = w.god, m = god.model;
  const bridge = w.bridge as unknown as {nav: Nav; engineAct(ops: unknown[], note: string): Result};
  const nav = bridge.nav;
  let updates = 0, checks = 0, accepted = 0;
  const update = nav.update.bind(nav); nav.update = (...a: unknown[]) => {updates++; return update(...a);};
  const check = (what: string) => {nav.things(); checks++; assert.equal(nav.thingsOracleV1(), null, what);};
  const refused: string[] = [];
  const engine = (what: string, ops: unknown[]) => {const r = bridge.engineAct(ops, `oracle: ${what}`); if (r.accepted) accepted++; else refused.push(`${what}: ${JSON.stringify(r.failures).slice(0, 160)}`); check(what);};
  const authored = (what: string, ops: unknown[]) => {const r = god.act({ops} as never) as Result; if (r.accepted) accepted++; else refused.push(`${what}: ${JSON.stringify(r.failures).slice(0, 160)}`); check(what);};
  const run = async (n: number, what: string) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 5 === 0) {await setImmediate(); host.drainInputs();} check(`${what}, tick ${i}`);} await setImmediate(); host.drainInputs(); check(what);};
  await run(20, 'arrival');

  const ents = () => [...m.entities.values()] as Entity[];
  const def = (e: Entity) => m.resolvedDef(e.def);
  const listed = new Set(nav.things().map(x => x.id));
  // doors, several times over
  const doors = ents().filter(e => e.name && def(e)?.components.opening && listed.has(e.id)).slice(0, 4);
  assert.ok(doors.length >= 2, 'Eden 2026 has doors');
  for (const d of doors) for (const open of [true, false, true]) engine(`door ${m.pathOf(d.id)} open=${open}`, [{op: 'set', id: d.id, state: {open}}]);
  // things held by a listed holder, moved a little: the thing and its holder
  const held = ents().filter(e => e.name && e.in.parent !== 'world' && listed.has(e.id) && !def(e)?.components.opening && e.p).slice(0, 6);
  for (const e of held) { const p = e.p!; engine(`move ${m.pathOf(e.id)}`, [{op: 'move', id: e.id, p: p.length === 3 ? [p[0] + 0.05, p[1], p[2]] : [p[0] + 0.05, p[1]], mode: 'nudge'}]); }
  // a holder renamed: every ref under it changes; then back
  const holder = ents().find(e => e.name && e.in.parent === 'world' && listed.has(e.id) && [...(m.children.get(e.id) ?? [])].some(c => listed.has(c)))!;
  const was = holder.name!;
  engine(`rename ${was}`, [{op: 'set', id: holder.id, name: `${was}-renamed`}]);
  engine(`rename ${was} back`, [{op: 'set', id: holder.id, name: was}]);
  // meaning: a title and what, then named parts (one naming another thing, one a stand point); then the named thing moves,
  // is renamed and the owner's own pose changes
  const owner = ents().find(e => e.name && e.in.parent === 'world' && listed.has(e.id) && e.id !== holder.id && def(e)?.form === 'point' && !m.children.get(e.id)?.size)!;
  const named = held[0]!, op = owner.p!, at = [op[0], 0, op.length === 3 ? op[2] : op[1]];
  engine('about', [{op: 'set', id: owner.id, about: {title: 'Oracle Stone', what: 'a stone the oracle reads'}}]);
  engine('parts', [{op: 'set', id: owner.id, about: {title: 'Oracle Stone', parts: [{id: 'seat', title: 'Oracle seat', anchor: {kind: 'entity', ref: named.id}}, {id: 'step', title: 'Oracle step', anchor: {kind: 'local', point: [1, 0, 0], stand: [1.5, 0, 0], level: 0}}]}}]);
  const np = m.entities.get(named.id)!.p!;
  engine('the named thing moves', [{op: 'move', id: named.id, p: np.length === 3 ? [np[0] - 0.05, np[1], np[2]] : [np[0] - 0.05, np[1]], mode: 'nudge'}]);
  engine('the named thing is renamed', [{op: 'set', id: named.id, name: `${named.name}-x`}]);
  engine('the owner turns', [{op: 'move', id: owner.id, r: 0.3, mode: 'nudge'}]);
  engine('parts cleared', [{op: 'set', id: owner.id, about: null}]);
  // a child named like one of a building's rooms takes the room's ref; removed, the room is back
  const building = nav.things().find(x => x.kind === 'room')!, bid = building.id, room = building.ref.split('/').pop()!;
  const stool = ents().find(e => e.name && e.in.parent === bid && def(e)?.form === 'point' && !def(e)?.components.opening);
  assert.ok(stool, `${building.ref}'s building holds a named thing`);
  engine(`a child named ${room}`, [{op: 'set', id: stool.id, name: room}]);
  engine('renamed back', [{op: 'set', id: stool.id, name: stool.name}]);
  authored('a thing placed in a building', [{op: 'place', def: stool.def, name: 'oracle-stool', in: {parent: bid}, p: [0.4, 0.4], mode: 'nudge'}]);
  const placed = m.get(`${m.pathOf(bid)}/oracle-stool`);
  assert.ok(placed, 'the placed thing is there');
  authored('the placed thing removed', [{op: 'remove', id: placed.id}]);
  // a container shut and opened on what it keeps (entry 42)
  const box = ents().find(e => {const d = def(e); return !!d?.components.container && Object.hasOwn(d.state ?? {}, 'open') && [...(m.children.get(e.id) ?? [])].some(c => m.entities.get(c)?.name);});
  if (box) for (const open of [false, true, false]) engine(`container open=${open}`, [{op: 'set', id: box.id, state: {open}}]);
  // a thing removed (with what it holds)
  const gone = held.at(-1)!; engine(`remove ${m.pathOf(gone.id)}`, [{op: 'remove', id: gone.id}]);
  assert.ok(accepted >= 25, `most of the corpus applies (${accepted} accepted; refused: ${refused.join(' | ')})`);

  // Souls walking, sitting and acting: their engine edits (doors, seats, what they carry) between every tick
  const raw = L as unknown as {binds(s: EdgeSoul): {caps: EdgeCapability[]}};
  const soul = w.soul;
  const verbs: string[] = [];
  const act = async (c: EdgeCapability) => {
    verbs.push(c.id);
    const r = await accept(host, L.act(soul, {capability: c.id})) as Result;
    if (r.accepted) for (let i = 0; i < 12 && L.openReceipts(soul.soulId).length; i++) await run(10, c.id);
  };
  const caps = () => raw.binds(soul).caps.filter(c => c.available);
  for (const k of [5, 40]) {const go = caps().filter(c => c.verb === 'walk' && c.target?.kind === 'place')[k]; assert.ok(go, `a walk #${k}`); await act(go);}
  t.diagnostic(`verbs here: ${[...new Set(caps().map(c => c.verb))].join(',')}`);
  for (const v of ['sit', 'pick-up', 'drink', 'cook', 'read', 'garden', 'play-piano']) {const c = caps().find(x => x.verb === v); if (c) await act(c);}
  assert.ok(updates >= 25, `the list was updated in place, not rebuilt (${updates} updates)`);
  t.diagnostic(`${checks} checks, ${updates} updates, ${accepted} edits accepted, acts ${verbs.join(',')}; refused: ${refused.join(' | ') || 'none'}`);
});
