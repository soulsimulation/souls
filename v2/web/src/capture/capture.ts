// A shot's camera (Engine v2 G10, #2800): the page names what it draws (Souls by their public name, places and things
// by their kind and counter, "room 3", as the client's copy names them, or today's id of an imported thing) and puts
// the camera on one of them, so `shoot` on the agent's own machine can take a picture of a named place, Soul or thing
// with the site's own page. It reads only what the page already plays (the public stream); it moves nothing in the
// world. With `?shot` in the address the page hides its status, buttons and find box, so a shot shows the world alone.
import * as THREE from 'three';
import { bodyAt } from '../camera/follow.ts';
import type { WorldView } from '../draw/world.ts';
import type { NodeRec } from '../source/source.ts';

export type Role = 'soul' | 'place' | 'thing';
export type Spot = { id: string; name: string; role: Role; origin?: string };
/** Where a shot's camera stands and what it looks at, world metres. */
export type Aim = { eye: [number, number, number]; target: [number, number, number] };

const plainKind = (k: string) => k.replace(/@.*$/, '');
const counterOf = (id: string) => id.split(/[.-]/).pop() ?? id;
const BODY = /(^|:)(body|soul)$/;
const norm = (s: string) => s.trim().toLowerCase();
/** Eye height above a Soul's feet, and how far ahead of its body the eye sits (out of its own head), m. */
export const EYE_UP = 1.6, EYE_AHEAD = 0.35;

/** Every Soul, place and thing the page holds, named. A place is a node that holds others. */
export function spots(nodes: Iterable<NodeRec>, isBody: (n: NodeRec) => boolean, soulName: (id: string) => string | null): Spot[] {
  const all = [...nodes], holds = new Set(all.map((n) => n.parent).filter((p): p is string => !!p));
  return all.map((n): Spot => {
    if (isBody(n)) return { id: n.id, name: soulName(n.id) ?? n.name ?? `body ${counterOf(n.id)}`, role: 'soul' };
    const name = `${plainKind(n.kind).replace(/^.*:/, '')} ${counterOf(n.id)}`;
    return { id: n.id, name, role: holds.has(n.id) ? 'place' : 'thing', ...(n.origin ? { origin: n.origin } : {}) };
  });
}

/** The spot `asked` names: its id (`scope.n` or the client's `scope-n`), then a name or imported id exactly, then one it
 *  begins, then one it holds (case aside); Souls first, then places, then things. */
export function resolveSpot(all: Spot[], asked: string): Spot | null {
  const q = norm(asked), id = asked.trim().replace(/-(\d+)$/, '.$1');
  const byId = all.find((s) => s.id === id);
  if (byId) return byId;
  const order = (s: Spot) => ({ soul: 0, place: 1, thing: 2 })[s.role];
  const sorted = [...all].sort((a, b) => order(a) - order(b));
  for (const test of [(n: string) => n === q, (n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    const hit = sorted.find((s) => test(norm(s.name)) || (s.origin !== undefined && test(norm(s.origin))));
    if (hit) return hit;
  }
  return null;
}

/**
 * The camera for a shot of `spot` at world time `t`:
 * - a place: from above one corner of what it holds, looking at its middle;
 * - a thing or a Soul: 5 m back and 2.5 m up, looking at it;
 * - `eyes`, a Soul only: from its own eyes, the way it last walked (else toward the middle of what its room holds).
 */
export function aimAt(world: Pick<WorldView, 'nodes' | 'tracks' | 'frame'>, spot: Spot, t: number, eyes = false): Aim | null {
  const at = (id: string) => bodyAt(world, id, t);
  const centre = at(spot.id);
  if (!centre) return null;
  const v = (p: THREE.Vector3) => p.toArray() as [number, number, number];
  if (spot.role === 'place') {
    const inside = [...world.nodes.values()].filter((n) => n.parent === spot.id).map((n) => at(n.id)).filter((p): p is THREE.Vector3 => !!p);
    const box = new THREE.Box3().setFromPoints(inside.length ? inside : [centre]);
    const mid = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const d = Math.max(12, Math.hypot(size.x, size.z) * 0.9);
    return { eye: v(mid.clone().add(new THREE.Vector3(d * 0.6, d * 0.55, d * 0.6))), target: v(mid) };
  }
  if (spot.role === 'soul' && eyes) {
    const n = world.nodes.get(spot.id)!;
    const before = at(spot.id) && bodyAt(world, spot.id, t - 500_000);
    let dir = before ? centre.clone().sub(before).setY(0) : new THREE.Vector3();
    if (dir.length() < 0.05) {
      const near = [...world.nodes.values()].filter((m) => m.parent === n.parent && m.id !== n.id).map((m) => at(m.id)).filter((p): p is THREE.Vector3 => !!p);
      const mid = near.length ? new THREE.Box3().setFromPoints(near).getCenter(new THREE.Vector3()) : new THREE.Vector3().setFromMatrixPosition(world.frame(n.parent));
      dir = mid.sub(centre).setY(0);
    }
    if (dir.length() < 0.05) dir.set(1, 0, 0);
    dir.normalize();
    const eye = centre.clone().add(new THREE.Vector3(0, EYE_UP, 0)).addScaledVector(dir, EYE_AHEAD);
    return { eye: v(eye), target: v(eye.clone().addScaledVector(dir, 10).add(new THREE.Vector3(0, -0.6, 0))) };
  }
  const target = centre.clone().add(new THREE.Vector3(0, spot.role === 'soul' ? 1.3 : 0.8, 0));
  return { eye: v(target.clone().add(new THREE.Vector3(3.5, 2.5, 3.5))), target: v(target) };
}

type PageV2 = {
  world: WorldView;
  cam: { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update(): void } };
  director: { free(): void; t?: number | null };
  souls: { copy: { souls: Map<string, { name: string | null }> } };
};

/** `v2.capture` on the page: what it can name, and the camera put on one of them. */
export function installCapture(g: { v2?: PageV2 } & Record<string, unknown>, params: URLSearchParams, doc?: Document): void {
  if (params.has('shot') && doc) {
    // The world and what is drawn over it (names, speech) are canvases; the status, buttons and find box are not.
    const style = doc.createElement('style');
    style.textContent = 'body > :not(canvas) { display: none !important; }';
    doc.head.append(style);
  }
  const page = () => g.v2!;
  const now = () => (page().director as { t?: number | null }).t ?? null;
  const isBody = (n: NodeRec) => page().world.tracks.has(n.id) || BODY.test(plainKind(n.kind));
  const list = () => spots(page().world.nodes.values(), isBody, (id) => page().souls.copy.souls.get(id)?.name ?? null);
  const capture = {
    /** True once the page has drawn the world at a time. */
    ready: () => now() !== null && page().world.nodes.size > 0,
    where: list,
    /** Puts the camera on `name` (a Soul's own eyes with `eyes`); the spot and the camera, or null when nothing has that name. */
    aim(name: string, eyes = false): { spot: Spot; aim: Aim } | null {
      const t = now(), spot = resolveSpot(list(), name);
      if (t === null || !spot) return null;
      const a = aimAt(page().world, spot, t, eyes);
      if (!a) return null;
      const { cam, director } = page();
      director.free();
      cam.camera.position.set(...a.eye);
      cam.controls.target.set(...a.target);
      cam.camera.lookAt(...a.target);
      cam.controls.update();
      return { spot, aim: a };
    },
  };
  Object.assign(g, { v2: { ...page(), capture } });
}
