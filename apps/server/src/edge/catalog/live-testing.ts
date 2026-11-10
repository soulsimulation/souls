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
  const entities: Record<string, {pose: {p: number[]}; human: {activity: string | null}}> = {h_a: {pose: {p: [1, 0, 1]}, human: {activity: null}}, h_b: {pose: {p: [50, 0, 50]}, human: {activity: null}}};
  const world = {tick: 0, entities};
  const minds = new Map([['s_a', {soulId: 's_a', entityId: 'h_a', name: 'Ada'}], ['s_b', {soulId: 's_b', entityId: 'h_b', name: 'Bo'}]]);
  // the place path is ground level (the yard), as locate would say for a body standing under the attic
  const placePathOf = (id: string) => { const p = entities[minds.get(id)?.entityId ?? '']?.pose.p; return p && p[0]! < 30 && p[2]! < 30 ? [{id: 'g-yard', kind: 'yard'}, {id: 'world', kind: 'region'}] : [{id: 'world', kind: 'region'}]; };
  const poseOf = (id: string) => { const p = entities[minds.get(id)?.entityId ?? '']?.pose.p; return p ? {x: p[0]!, z: p[2]!, yaw: 0} : null; };
  const L = {host: {worldId: 'w-1', engine: {world}, minds}, faded: new Set<string>(), placePathOf, poseOf, knowledge, places} as unknown as EdgeLedger;
  let spectate: (m: any) => void = () => {};
  const app = new Hono(), hub = mountLiveRoute(app, {ledger: L}, {onSpectator: l => { spectate = l; }}, () => 'cat-1');
  const get = async () => JSON.parse(await (await app.request('/v1/edge/live')).text());
  const advance = (ticks = 10) => { world.tick += ticks; };
  const say = (soulId: string, id: string, text: string) => spectate({kind: 'speech', tick: world.tick, at: 1, id, from: {soulId, name: minds.get(soulId)?.name}, channel: {}, text});
  const secret = (id: string, on: boolean) => { if (on) secrets.add(id); else secrets.delete(id); knowledge.version++; };
  return {hub, app, get, advance, say, secret, entities, world};
}
