// 0.133 item 6: the old page's creator panel places, moves and removes a thing on a world the new engine runs. The
// operations are the creator's own edit batch (`souls:edit`'s place, move and remove, as `souls-god place|move|remove`
// send them), sent on the creator socket (creator-socket.ts); this module makes them from what the page's stream reader
// has shown (creator-kinds.ts keeps every node) and a point on the ground in the world's frame, metres. The world's
// answer rules: build safety refuses an edit onto a Soul, and the panel shows the refusal's name.
import { entityId } from './creator-kinds.ts';
import { placedOf } from './world-state.ts';
import type { Op, Spot, Turn } from './creator-socket.ts';

/** A node as the stream reader keeps it (v2/web/src/source/source.ts NodeRec), the fields read here. */
export type BuildNode = { id: string; kind: string; parent: string | null; pos?: [number, number, number]; rot?: [number, number, number, number];
  slot?: number | null; slots?: number[][]; soul?: string | null; origin?: string; defines?: string; outline?: number[][]; tiles?: unknown[] };
type Nodes = ReadonlyMap<string, BuildNode>;

let nodesOf: (() => Nodes) | null = null;
/** The stream's nodes, set by the v2 page's reader (use-v2-souls.ts); null on an old world. */
export const setBuildNodes = (f: (() => Nodes) | null) => { nodesOf = f; };
export const buildNodes = (): Nodes | null => nodesOf?.() ?? null;

let clicks = false;
/** While the panel's Build is open a click on the world is its own (place, select), not a thing card's (LiveWorld). */
export const setBuildClicks = (on: boolean) => { clicks = on; };
export const buildTakesClicks = () => clicks;

const plain = (k: string) => k.split('@')[0]!;
/** Kinds that are frames, not things: the ground, rooms and places, a definition, the engine's own. */
const FRAME = /:(ground|room|floor|place|extent|world|kind)$/;

/** A thing a creator may place, move or remove: not a body, a frame, an area's outline or the engine's own. */
export function isThing(n: BuildNode): boolean {
  return n.parent !== null && !!n.pos && !!n.rot && !n.soul && !/:(humanoid|body)$/.test(plain(n.kind)) && !n.kind.startsWith('souls:')
    && !FRAME.test(plain(n.kind)) && !n.outline?.length && !n.tiles?.length;
}

/** A kind as the panel names it: `eden:park_bench@…` is "park bench". */
export const shortKind = (k: string) => (plain(k).split(':').pop() ?? k).replace(/[_-]/g, ' ');

/** The kinds this world has pinned that a creator can place on the ground: the kind of each thing standing on it (not a
 *  building's door or window) and each creator-defined kind, by their full names (`ns:name@hash`), in the order of
 *  their short names. */
export function buildKinds(nodes: Nodes): string[] {
  const out = new Set<string>(), ground = groundOf(nodes);
  for (const n of nodes.values()) {
    if (isThing(n) && n.parent === ground && n.slot == null) out.add(n.kind);
    else if (plain(n.kind) === 'souls:kind' && n.defines && !n.id.startsWith('entry:')) out.add(n.defines);
  }
  return [...out].sort((a, b) => shortKind(a).localeCompare(shortKind(b)) || a.localeCompare(b));
}

/** Where a new thing goes: the open ground (`*:ground`), else the world's root. */
export function groundOf(nodes: Nodes): string | null {
  let root: string | null = null;
  for (const n of nodes.values()) {
    if (/:ground$/.test(plain(n.kind)) && n.pos && n.rot) return n.id;
    if (n.parent === null) root ??= n.id;
  }
  return root;
}

/** `v` turned by `yaw` about +y. */
const turned = (v: [number, number, number], yaw: number): [number, number, number] =>
  [v[0] * Math.cos(yaw) + v[2] * Math.sin(yaw), v[1], -v[0] * Math.sin(yaw) + v[2] * Math.cos(yaw)];

/** `at` (the world's frame, metres) in `parent`'s frame, µm; null when the page cannot place the parent. */
export function spotIn(nodes: Nodes, parent: string, at: [number, number, number]): Spot | null {
  const p = parent && nodes.get(parent);
  if (!p) return null;
  const f = p.parent === null && !p.pos ? { p: [0, 0, 0] as [number, number, number], yaw: 0 } : placedOf(nodes, parent);
  if (!f) return null;
  const local = turned([at[0] - f.p[0], at[1] - f.p[1], at[2] - f.p[2]], -f.yaw);
  const um = (v: number) => Math.round(v * 1e6) || 0; // never -0: T0 writes it as a float
  return { x: um(local[0]), y: um(local[1]), z: um(local[2]) };
}

/** Where a thing is in the world's frame, metres; null when the page cannot say. */
export const placedAt = (nodes: Nodes, id: string): [number, number, number] | null => placedOf(nodes, id)?.p ?? null;

/** The place of one thing of `kind` at `at` (metres, the world's frame) on the open ground, or why not. */
export function placeOp(nodes: Nodes, kind: string, at: [number, number, number]): Op | { why: string } {
  const parent = groundOf(nodes);
  const spot = parent ? spotIn(nodes, parent, at) : null;
  if (!parent || !spot) return { why: 'The world\'s ground is not loaded yet.' };
  return { op: 'place', name: 1, kind, parent, at: spot };
}

/** The move of thing `id` to `at` (metres, the world's frame), facing as it does; or why not. */
export function moveOp(nodes: Nodes, id: string, at: [number, number, number]): Op | { why: string } {
  const n = nodes.get(id);
  if (!n || !isThing(n) || n.parent === null) return { why: 'That thing is not in the world now.' };
  if (n.slot != null) return { why: `The ${shortKind(n.kind)} is held in a slot of what it is in: move that instead.` };
  const spot = spotIn(nodes, n.parent, at);
  if (!spot) return { why: 'The page cannot place what it is in.' };
  return { op: 'move', node: id, at: spot, ...(n.rot ? { rot: [...n.rot] as Turn } : {}) };
}

/** The removal of thing `id` (and everything in it). */
export const removeOp = (id: string): Op => ({ op: 'remove', node: id });

/** The thing an entity of the page's layer draws: a creator's (its id made from the node's) or the world's own (its
 *  origin), or null. */
export function thingOf(nodes: Nodes, entity: string): string | null {
  for (const n of nodes.values()) if (isThing(n) && (n.origin === entity || entityId(n.id) === entity)) return n.id;
  return null;
}

/** The thing standing nearest `at` ([x, z] metres), within `radius`, or null. */
export function thingNear(nodes: Nodes, at: [number, number], radius = 1.5): string | null {
  let best: string | null = null, d = radius;
  for (const n of nodes.values()) {
    if (!isThing(n)) continue;
    const p = placedOf(nodes, n.id)?.p;
    const e = p ? Math.hypot(p[0] - at[0], p[2] - at[1]) : Infinity;
    if (e <= d) (best = n.id), (d = e);
  }
  return best;
}
