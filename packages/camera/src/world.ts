// World in: the solids a camera may not enter and cannot see through, as plain data.
// A god world's `/v1/scene` carries no obstacles (its buildings live in the entity model), so the camera's world is
// built from the model's own footprints (the boxes navigation already uses). Nothing here reads a renderer.
import type { Obstacle, SpatialScene } from '../../../mars/viewer/engine/spatial/types.ts';

/** A world-frame footprint box as `WorldModel.footprint` returns it (yaw turns the other way from the engine's OBB2). */
export type Footprint = { c: readonly [number, number]; half: readonly [number, number]; yaw: number; y0: number; y1: number };
/** The part of a world model the camera needs; `WorldModel` satisfies it structurally. */
export type FootprintSource<E extends { id: string; name?: string } = { id: string; name?: string }> = {
  entities: { values(): Iterable<E> };
  footprint(e: E): Footprint[];
};

/** Boxes thinner than this in both plan directions or lower than this are not camera solids (grass, kerbs, rugs). */
export const MIN_SOLID = { half: 0.04, height: 0.3 };

export function obstaclesOf<E extends { id: string; name?: string }>(model: FootprintSource<E>): Obstacle[] {
  const out: Obstacle[] = [];
  for (const e of model.entities.values()) {
    let boxes: Footprint[];
    try { boxes = model.footprint(e); } catch { continue; } // a def that cannot bake draws nothing either
    boxes.forEach((b, i) => {
      if (!(b.y1 - b.y0 >= MIN_SOLID.height) || Math.max(b.half[0], b.half[1]) < MIN_SOLID.half) return;
      out.push({ id: `${e.id}#${i}`, label: e.name ?? e.id, kind: 'solid', obb: { c: [b.c[0], b.c[1]], half: [b.half[0], b.half[1]], yaw: -b.yaw }, y0: b.y0, y1: b.y1 });
    });
  }
  return out;
}

/** The camera's scene: the engine's scene (or none) plus world obstacles, with bounds grown to hold them. */
export function cameraScene(base: SpatialScene | null, obstacles: readonly Obstacle[], pad = 40): SpatialScene {
  const all = [...(base?.obstacles ?? []), ...obstacles];
  let [x0, z0, x1, z1] = base?.bounds ?? [Infinity, Infinity, -Infinity, -Infinity];
  for (const o of all) { const r = Math.hypot(o.obb.half[0], o.obb.half[1]); x0 = Math.min(x0, o.obb.c[0] - r); z0 = Math.min(z0, o.obb.c[1] - r); x1 = Math.max(x1, o.obb.c[0] + r); z1 = Math.max(z1, o.obb.c[1] + r); }
  if (!Number.isFinite(x0)) [x0, z0, x1, z1] = [-50, -50, 50, 50];
  return { bounds: [x0 - pad, z0 - pad, x1 + pad, z1 + pad], levels: base?.levels ?? [], surfaces: base?.surfaces ?? [], obstacles: all, links: base?.links ?? [] };
}

/** A thing as a world's facts carry it (v2/tools/import-eden/export/export.ts, the file `worldd seed` keeps beside a
 *  world): its world pose `[x, y, z mm, yaw mdeg]` and its solids `[cx, cz, half x, half z mm, yaw mdeg, y0, y1 mm, tag,
 *  abs]` in its own frame, scaled; a world-frame shape (`worldShape`) carries them in the world frame, heights above
 *  the ground unless `abs`. */
export type FactsThing = { id: string; name?: string; world: [number, number, number, number]; worldShape?: boolean; solids?: number[][] };

/** The camera's solids from a new-engine world's facts: the same boxes `obstaclesOf` takes from today's world model
 *  (WorldModel.footprint), so a world on the new engine is planned with no world model and no server. */
export function obstaclesOfFacts(facts: { things: readonly FactsThing[] }, ground: (x: number, z: number) => number = () => 0): Obstacle[] {
  const out: Obstacle[] = [], M = 1000, DEG = Math.PI / 180000;
  for (const t of facts.things) for (const [i, s] of (t.solids ?? []).entries()) {
    const [cx, cz, hx, hz, yaw, y0, y1, , abs] = s;
    let c: [number, number], y: number, turn: number;
    if (t.worldShape) { c = [cx / M, cz / M]; y = abs ? 0 : ground(c[0], c[1]); turn = yaw * DEG; }
    else {
      const a = t.world[3] * DEG, co = Math.cos(a), si = Math.sin(a);
      c = [(t.world[0] + cx * co + cz * si) / M, (t.world[2] - cx * si + cz * co) / M]; y = t.world[1] / M; turn = a + yaw * DEG;
    }
    const b: Footprint = { c, half: [hx / M, hz / M], yaw: turn, y0: y + y0 / M, y1: y + y1 / M };
    if (!(b.y1 - b.y0 >= MIN_SOLID.height) || Math.max(b.half[0], b.half[1]) < MIN_SOLID.half) continue;
    out.push({ id: `${t.id}#${i}`, label: t.name ?? t.id, kind: 'solid', obb: { c: [b.c[0], b.c[1]], half: [b.half[0], b.half[1]], yaw: -b.yaw }, y0: b.y0, y1: b.y1 });
  }
  return out;
}
