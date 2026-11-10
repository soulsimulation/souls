// #1411 slice 1: every solid-in-solid pair in a world, as one pure read. A measuring stick for the mover fuzz
// (tools/soul-actions/mover-fuzz.test.mjs) and, later, the placement validator: it never corrects anything and keeps no memory.
// Bodies are read by their own invariants' tests (collision.human-static, collision.human-human: same exemptions, same
// tolerances), over every body rather than the moved ones. Objects (components, vehicles) are read by footprint against the
// scene's obstacles: an overlap needs both the ground OBBs to overlap and the height ranges to share more than a centimetre,
// so an item resting on a table (ranges touching) is none. Held, in-hand, forks-borne and ridden things move with a body or
// vehicle and are left to collision.human-load and vehicle.static-clearance.
import { obbOverlap } from '../core/math.ts';
import { entityFootprint, type Spatial } from '../spatial/service.ts';
import type { Entity } from '../world/types.ts';
import { humanHumanSeparation, humanStaticClearance } from './invariants.ts';
import type { Runtime } from './runtime.ts';

export type SolidOverlapV1 = { kind: 'body-static' | 'body-body' | 'object-static'; subjects: string[]; at: number[] };

const MOVES_WITH_ANOTHER = new Set(['held', 'in-hand', 'forks', 'ridden-by']);
const Y_EPS = 0.01;

/** Every solid-in-solid pair now, sorted by kind then subjects. A pure read of world state and its scene. `objects` limits the
 *  object read to those ids (a big world's thousands of fixtures against thousands of obstacles is slow; a mover names what it
 *  moved); bodies are always read whole. */
export function solidOverlapsV1(rt: Runtime, opts?: { objects?: Iterable<string> }): SolidOverlapV1[] {
  const out: SolidOverlapV1[] = [];
  for (const d of humanStaticClearance(rt)) out.push({ kind: 'body-static', subjects: [...(d.subjects ?? [])], at: [...(d.at ?? [])] });
  for (const d of humanHumanSeparation(rt)) out.push({ kind: 'body-body', subjects: [...(d.subjects ?? [])].sort(), at: [...(d.at ?? [])] });
  const sp = rt.services.spatial as Spatial | undefined;
  if (sp) {
    sp.sync(rt.world);
    const obstacles = sp.scene.obstacles, seen = new Set<string>();
    const ents = rt.world.entities as Record<string, Entity>;
    const list = opts?.objects ? [...new Set(opts.objects)].flatMap(id => ents[id] ? [ents[id]] : []) : Object.values(ents);
    for (const e of list) {
      if (e.kind === 'human' || (e.support && MOVES_WITH_ANOTHER.has(e.support.kind))) continue;
      let fp: ReturnType<typeof entityFootprint>;
      try { fp = entityFootprint(e); } catch { continue; }   // no footprint: nothing solid to read
      const on = e.support?.kind === 'resting-on' ? e.support.on : undefined;
      for (const o of obstacles) {
        const owner = o.id.startsWith('upper:') ? o.id.split(':')[1] : o.id.split('#')[0];
        if (owner === e.id || owner === on) continue;
        if (Math.min(fp.y1, o.y1) - Math.max(fp.y0, o.y0) <= Y_EPS || !obbOverlap(fp.obb, o.obb)) continue;
        const subjects = [e.id, owner].sort(), key = subjects.join('|');
        if (seen.has(key)) continue;
        seen.add(key); out.push({ kind: 'object-static', subjects, at: [...e.pose.p] });
      }
    }
  }
  return out.sort((a, b) => (a.kind + a.subjects.join()).localeCompare(b.kind + b.subjects.join()));
}

/** The overlaps in `after` that `before` didn't have (by kind and subjects): what one move created. */
export function newOverlapsV1(before: SolidOverlapV1[], after: SolidOverlapV1[]): SolidOverlapV1[] {
  const had = new Set(before.map(o => o.kind + '|' + o.subjects.join()));
  return after.filter(o => !had.has(o.kind + '|' + o.subjects.join()));
}
