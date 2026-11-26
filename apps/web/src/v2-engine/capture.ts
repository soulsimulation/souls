// A shot's camera on the page worlds serve (#5022's finding): the client's `shoot`, and a creator's `look`
// (v2/client/src/shoot/shoot.mjs), load a world's page with `?shot=1` and wait for `globalThis.v2.capture.ready()`, then
// put the camera on a named Soul, place or thing with `aim` and take the picture. The v2 page sets that hook
// (v2/web/src/capture/capture.ts); this is the same hook for the old page (LiveWorld) on a world the new engine runs.
// The names are the client's copy's: a place's public name (field 4), else a thing's own name, else its kind and counter
// ("bench 12"); a Soul by its public name; any node by its id (`scope.n` or the client's `scope-n`) or an imported
// thing's id. It reads only what the page already plays (the public stream) and moves nothing in the world; the
// camera goes where LiveWorld's own `?shot` pin puts it (`shotCamera`: lifted clear of the ground, held until the picture).
import { placedOf } from './world-state.ts';

export type Role = 'soul' | 'place' | 'thing';
export type Spot = { id: string; name: string; role: Role; origin?: string };
type V3 = [number, number, number];
/** Where a shot's camera stands and what it looks at, world metres. */
export type Aim = { eye: V3; target: V3 };
/** A node as the stream reader posts it (v2/web/src/source/source.ts NodeRec), the fields read here. */
export type CaptureNode = { id: string; kind: string; parent: string | null; slot?: number | null; pos?: V3; rot?: [number, number, number, number];
  slots?: number[][]; soul?: string | null; origin?: string; name?: string | null; placeName?: string | null; outline?: number[][] };
type Nodes = ReadonlyMap<string, CaptureNode>;
/** A Soul's body as the page draws it now: its public name, its place (metres) and heading (the old take's yaw). */
export type Drawn = { name: string | null; p: readonly number[]; yaw: number };
/** What LiveWorld gives the hook. */
export type CapturePage = {
  /** True once the page has drawn the world for a shot (`__shotReady`) and plays a time. */
  ready(): boolean;
  /** The world time drawn, µs, or null. */
  t(): number | null;
  /** The stream's nodes (creator-build.ts buildNodes), or null before the reader has any. */
  nodes(): Nodes | null;
  /** A body node as drawn now, or null when the page does not draw it. */
  body(n: CaptureNode): Drawn | null;
  /** Holds the camera at `eye`, looking at `target`, until the picture; answers the camera it set. */
  pin(eye: V3, target: V3): Aim;
};

const plainKind = (k: string) => k.replace(/@.*$/, '');
const counterOf = (id: string) => id.split(/[.-]/).pop() ?? id;
const isBody = (n: CaptureNode) => !!n.soul || /:(humanoid|body)$/.test(plainKind(n.kind));
const norm = (s: string) => s.trim().toLowerCase();
/** "bench 12": a node's kind's plain name and its counter, as the client's copy names a thing with no name. */
const kindName = (n: CaptureNode) => `${plainKind(n.kind).replace(/^.*:/, '')} ${counterOf(n.id)}`;
/** Eye height above a Soul's feet, and how far ahead of its body the eye sits (out of its own head), m. */
export const EYE_UP = 1.6, EYE_AHEAD = 0.35;

/** Every Soul, place and thing the page holds, named. A place is a node that holds others. */
export function spots(nodes: Nodes, body: (n: CaptureNode) => Drawn | null): (Spot & { also: string })[] {
  const holds = new Set<string>();
  for (const n of nodes.values()) if (n.parent) holds.add(n.parent);
  const out: (Spot & { also: string })[] = [];
  for (const n of nodes.values()) {
    const also = kindName(n), origin = n.origin ? { origin: n.origin } : {};
    if (isBody(n)) out.push({ id: n.id, name: body(n)?.name ?? n.name ?? `body ${counterOf(n.id)}`, role: 'soul', also });
    else out.push({ id: n.id, name: n.placeName ?? n.name ?? also, role: holds.has(n.id) ? 'place' : 'thing', also, ...origin });
  }
  return out;
}

/** The spot `asked` names: its id (`scope.n` or the client's `scope-n`), then a name, kind and counter or imported id
 *  exactly, then one it begins, then one it holds (case aside); Souls first, then places, then things. */
export function resolveSpot<S extends Spot & { also?: string }>(all: S[], asked: string): S | null {
  const q = norm(asked), id = asked.trim().replace(/-(\d+)$/, '.$1');
  const byId = all.find((s) => s.id === asked.trim() || s.id === id);
  if (byId) return byId;
  const order = (s: Spot) => ({ soul: 0, place: 1, thing: 2 })[s.role];
  const sorted = [...all].sort((a, b) => order(a) - order(b));
  for (const test of [(n: string) => n === q, (n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    const hit = sorted.find((s) => [s.name, s.also, s.origin].some((n) => n !== undefined && test(norm(n))));
    if (hit) return hit;
  }
  return null;
}

/** Where a node is drawn now, metres: a body where the page draws it, else its place from its chain of frames. */
const at = (nodes: Nodes, body: (n: CaptureNode) => Drawn | null, id: string): V3 | null => {
  const n = nodes.get(id);
  if (!n) return null;
  const b = isBody(n) ? body(n)?.p : placedOf(nodes, id)?.p;
  return b && b.length === 3 && b.every(Number.isFinite) ? [b[0], b[1], b[2]] : null;
};

/**
 * The camera for a shot of `spot` (as the v2 page's `aimAt`):
 * - a place: from above one corner of what it holds (an area: its outline), looking at its middle;
 * - a thing or a Soul: about 5 m back and 2.5 m up, looking at it;
 * - `eyes`, a Soul only: from its own eyes, the way it faces.
 */
export function aimAt(nodes: Nodes, body: (n: CaptureNode) => Drawn | null, spot: Spot, eyes = false): Aim | null {
  const centre = at(nodes, body, spot.id), n = nodes.get(spot.id);
  if (spot.role === 'place' || n?.outline?.length) {
    const pts: V3[] = [];
    for (const c of nodes.values()) if (c.parent === spot.id) { const p = at(nodes, body, c.id); if (p) pts.push(p); }
    for (const [x, z] of n?.outline ?? []) pts.push([x / 1000, centre?.[1] ?? 0, z / 1000]);
    if (!pts.length && centre) pts.push(centre);
    if (!pts.length) return null;
    const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
    const mid: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const d = Math.max(12, Math.hypot(hi[0] - lo[0], hi[2] - lo[2]) * 0.9);
    return { eye: [mid[0] + d * 0.6, mid[1] + d * 0.55, mid[2] + d * 0.6], target: mid };
  }
  if (!centre) return null;
  if (spot.role === 'soul' && eyes && n) {
    const yaw = body(n)?.yaw ?? 0, dir: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const eye: V3 = [centre[0] + dir[0] * EYE_AHEAD, centre[1] + EYE_UP, centre[2] + dir[2] * EYE_AHEAD];
    return { eye, target: [eye[0] + dir[0] * 10, eye[1] - 0.6, eye[2] + dir[2] * 10] };
  }
  const target: V3 = [centre[0], centre[1] + (spot.role === 'soul' ? 1.3 : 0.8), centre[2]];
  return { eye: [target[0] + 3.5, target[1] + 2.5, target[2] + 3.5], target };
}

type Host = { v2?: unknown };
/** `v2.capture` and `v2.director.t` on the page, as shoot.mjs reads them; `retire` takes them off again. */
export function installCapture(host: Host, page: CapturePage): { retire(): void } {
  const list = () => { const nodes = page.nodes(); return nodes ? spots(nodes, page.body).map(({ also: _, ...s }) => s) : []; };
  const capture = {
    ready: () => page.ready() && page.t() !== null && (page.nodes()?.size ?? 0) > 0,
    where: list,
    /** Puts the camera on `name` (a Soul's own eyes with `eyes`); the spot and the camera, or null when nothing has that name. */
    aim(name: string, eyes = false): { spot: Spot; aim: Aim } | null {
      const nodes = page.nodes();
      if (!nodes || page.t() === null) return null;
      const hit = resolveSpot(spots(nodes, page.body), String(name));
      if (!hit) return null;
      const { also: _, ...spot } = hit;
      const a = aimAt(nodes, page.body, spot, eyes);
      return a ? { spot, aim: page.pin(a.eye, a.target) } : null;
    },
  };
  const mine = { capture, director: { get t() { return page.t(); } } };
  host.v2 = mine;
  return { retire: () => { if (host.v2 === mine) delete host.v2; } };
}
