// Does anything float? Each placed thing's base (its origin, where its model stands) against what holds it up: its
// slot's point for a thing in a slot; for a thing on the open ground, the drawn ground under it, or the water, or the
// surface of a ground-laid thing (a pier's deck) when one is higher there; for a thing in a room, its floor's surface.
// Run on the page (`v2.support()`) by `support.mjs`; a thing more than 5 cm above its support floats.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { STRUCTURE, type WorldView } from './world.ts';

const MM = 1e-3;
/** Off by more than this (m) floats, or sinks. */
export const TOLERANCE = 0.05;

export function inside(x: number, z: number, poly: number[][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

export type Off = { id: string; kind: string; on: 'slot' | 'ground' | 'water' | 'surface' | 'floor'; base: number; support: number; off: number };
export type Support = { checked: number; floating: number; sunk: number; worst: Off[] };

/** Every placed thing's base against its support, in the world view as drawn; `drawn` says which things the page
 *  draws (the thing layer's), all but structure when not given. */
export function support(world: WorldView, drawn: (id: string) => boolean = () => true): Support {
  const v = new THREE.Vector3();
  const nodes = [...world.nodes.values()];
  const floors = new Map<string, NodeRec[]>();
  for (const n of nodes) if (n.surfaces && n.parent) (floors.get(n.parent) ?? floors.set(n.parent, []).get(n.parent)!).push(n);
  // Water and the surfaces of things on the open ground, in the world's frame (mm), with their heights (m).
  const waters = nodes.filter((n) => n.waterLevel !== undefined && n.outline).map((n) => ({ poly: n.outline!, y: n.waterLevel! * MM }));
  const decks: { poly: number[][]; y: number; ground: boolean }[] = [];
  for (const n of nodes) {
    if (n.parent !== world.groundId || n.at !== null || world.isDrape(n)) continue;
    for (const f of floors.get(n.id) ?? []) {
      const m = world.frame(f.id);
      for (const [y, pts] of f.surfaces!) {
        const poly = pts.map(([x, z]) => (v.set(x * MM, 0, z * MM).applyMatrix4(m), [v.x / MM, v.z / MM]));
        // Laid out in the world's frame (at the origin): heights above the ground; otherwise in the thing's frame.
        // A deck's (a pier's) heights are its own; another ground-laid thing's are above the ground.
        const ground = !world.isDeck(n) && n.pos.every((p) => p === 0);
        decks.push({ poly, y: ground ? y * MM : v.set(0, y * MM, 0).applyMatrix4(m).y, ground });
      }
    }
  }
  const out: Support = { checked: 0, floating: 0, sunk: 0, worst: [] };
  const all: Off[] = [];
  for (const n of nodes) {
    if (n.at !== null || STRUCTURE.has(n.kind.split('@')[0]) || world.isDrape(n) || !n.parent || !drawn(n.id)) continue;
    const base = v.setFromMatrixPosition(world.frame(n.id)).y, x = v.x, z = v.z;
    let s: number | null = null, on: Off['on'] = 'slot';
    const parent = world.nodes.get(n.parent);
    if (n.slot !== null) {
      const sl = parent?.slots?.find((r) => r[0] === n.slot);
      if (!sl) continue;
      s = v.set(sl[1] * MM, sl[2] * MM, sl[3] * MM).applyMatrix4(world.frame(n.parent)).y;
    } else if (n.parent === world.groundId) {
      const g = world.heightAt(x, z);
      if (g === null) continue;
      [s, on] = [g, 'ground'];
      for (const w of waters) if (inside(x / MM, z / MM, w.poly) && w.y > s) [s, on] = [w.y, 'water'];
      // A surface counts when the thing stands at or above it (a boat under a pier stands on the water).
      for (const d of decks) {
        const y = d.ground ? g + d.y : d.y;
        if (y > s && base >= y - TOLERANCE && inside(x / MM, z / MM, d.poly)) [s, on] = [y, 'surface'];
      }
    } else if (parent?.kind.split('@')[0] === 'eden:room' && parent.parent) {
      // A room's floor: the surface under the thing, in the floor's frame.
      const fl = world.nodes.get(parent.parent), m = world.frame(parent.parent);
      let best: number | null = null;
      for (const [y, pts] of fl?.surfaces ?? []) {
        const local = v.set(x, base, z).applyMatrix4(m.clone().invert());
        if (inside(local.x / MM, local.z / MM, pts)) best = Math.max(best ?? -Infinity, v.set(0, y * MM, 0).applyMatrix4(m).y);
      }
      if (best === null) continue;
      [s, on] = [best, 'floor'];
    } else continue;
    out.checked++;
    const off = base - s;
    if (off > TOLERANCE) out.floating++;
    if (off < -TOLERANCE) out.sunk++;
    if (Math.abs(off) > TOLERANCE) all.push({ id: n.id, kind: n.kind, on, base, support: s, off });
  }
  out.worst = all.sort((a, b) => b.off - a.off).slice(0, 12);
  return out;
}
