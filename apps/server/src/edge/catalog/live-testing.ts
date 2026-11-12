// Test-only (#1755): a live picture over a fake ledger (no world): two Souls, a yard, and a room upstairs whose outline
// covers part of the yard. The world's real live route and push run over it.
import {Hono} from 'hono';
import {mountLiveRoute} from './live.ts';
import type {EdgeLedger} from '../ledger/ledger.ts';

const square = (x: number, z: number, s = 10): [number, number][] => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
export function fakeLiveWorld() {
  const secrets = new Set<string>();
  const knowledge = {version: 0, isSecret: (id: string) => secrets.has(id), marked: () => secrets};
  const places = {version: 0, byId: new Map([['world', {id: 'world', kind: 'region', parent: null, polygon: square(-100, -100, 200)}], ['g-yard', {id: 'g-yard', kind: 'yard', parent: 'world', polygon: square(0, 0)}],
    // a room upstairs over the yard's corner: its outline covers ground the yard's people stand on
    ['g-attic', {id: 'g-attic', kind: 'room', parent: 'world', polygon: square(20, 20)}]])};
  const entities: Record<string, {pose: {p: number[]}; human: {activity: string | null}}> = {h_a: {pose: {p: [1, 0, 1]}, human: {activity: null}}, h_b: {pose: {p: [50, 0, 50]}, human: {activity: null}},
    // #1751's things: a lamp under the attic, a door in the yard
    e_lamp: {pose: {p: [25, 0, 25]}, human: {activity: null}}, e_door: {pose: {p: [5, 0, 5]}, human: {activity: null}}};
  const world = {tick: 0, entities};
  const minds = new Map<string, {soulId: string; entityId: string; name: string; description?: string}>([['s_a', {soulId: 's_a', entityId: 'h_a', name: 'Ada'}], ['s_b', {soulId: 's_b', entityId: 'h_b', name: 'Bo'}]]);
  // the place path is ground level (the yard), as locate would say for a body standing under the attic
  const placePathOf = (id: string) => { const p = entities[minds.get(id)?.entityId ?? '']?.pose.p; return p && p[0]! < 30 && p[2]! < 30 ? [{id: 'g-yard', kind: 'yard'}, {id: 'world', kind: 'region'}] : [{id: 'world', kind: 'region'}]; };
  const poseOf = (id: string) => { const p = entities[minds.get(id)?.entityId ?? '']?.pose.p; return p ? {x: p[0]!, z: p[2]!, yaw: 0} : null; };
  // a thing's state that differs from its kind's default: a new Map on every change, as the ledger's is (its sort is kept by identity)
  let states = new Map<string, Record<string, unknown>>();
  const thingStates = () => states, concealedThing = () => false;
  const setThing = (id: string, st: Record<string, unknown> | null) => { states = new Map(states); if (st) states.set(id, st); else states.delete(id); };
  // the clock's state (#1918): no day until a test sets one
  // #1978: the Souls' status lines, as the host's store keeps them (a change tells `onChange`)
  const lines = new Map<string, {text: string; at: number}>();
  const soulNow = {onChange: (_id: string) => {}, set(id: string, text: string | null) { if (text) lines.set(id, {text, at: 1}); else lines.delete(id); this.onChange(id); }};
  const host: {worldId: string; engine: {world: typeof world}; minds: typeof minds; clockRate: number; paused: boolean; living?: {origin: number; dayTicks: number}; soulNow: typeof soulNow; nowOf: (id: string) => {text: string; at: number} | null} = {worldId: 'w-1', engine: {world}, minds, clockRate: 1, paused: false, soulNow, nowOf: id => lines.get(id) ?? null};
  const L = {host, faded: new Set<string>(), placePathOf, poseOf, knowledge, places, thingStates, concealedThing} as unknown as EdgeLedger;
  let spectate: (m: any) => void = () => {};
  const app = new Hono(), hub = mountLiveRoute(app, {ledger: L}, {onSpectator: l => { spectate = l; }}, () => 'cat-1');
  const get = async () => JSON.parse(await (await app.request('/v1/edge/live')).text());
  const advance = (ticks = 10) => { world.tick += ticks; };
  const say = (soulId: string, id: string, text: string) => spectate({kind: 'speech', tick: world.tick, at: 1, id, from: {soulId, name: minds.get(soulId)?.name}, channel: {}, text});
  const secret = (id: string, on: boolean) => { if (on) secrets.add(id); else secrets.delete(id); knowledge.version++; };
  // a place's outline redrawn (the places' version moves, the knowledge's does not)
  const reshape = (id: string, polygon: [number, number][]) => { (places.byId.get(id) as {polygon: [number, number][]}).polygon = polygon; places.version++; };
  return {hub, app, get, advance, say, secret, reshape, setThing, entities, world, host};
}
