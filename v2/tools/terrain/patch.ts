// A landform's patches to the open ground's tiles (Engine v2 G5, #2762), made by today's `packages/ground`.
//
// The open ground holds N1's tiles (`F_TILES`): each [tx, tz, heights, classes], heights (n + 1)² little-endian i32 mm,
// a row of x for each z, at side / n spacing, classes n² bytes. A landform is folded onto what is there: each sample's
// height is `heightAt` of a ground whose base is that sample's old height and whose one landform is the new one, rounded
// to the millimetre as N1's export rounds it. On flat ground at 0 that is exactly today's baked tile for the landform
// (patch.test.ts). Only the tiles the landform changes are returned; classes are kept (the engine reads none).
//
// Not here: a smooth brush (it samples its neighbours, and a base is one sample), tiles where there are none yet.
import { GROUND_SCHEMA, heightAt, influenceBounds, landformSchema, type Ground, type Landform } from '../../../packages/ground/src/index.ts';

export type Tile = { tx: number; tz: number; heights: Int32Array; classes: Uint8Array };

/** A tile's samples a side, less one. */
export const samplesOf = (t: Tile): number => Math.round(Math.sqrt(t.classes.length));

/** The tiles `tiles` (each `tileMm` mm a side) with `landform` folded on, only those it changes, as new tiles. */
export function patch(tiles: Tile[], tileMm: number, landform: unknown): Tile[] {
  const l = landformSchema.parse(landform) as Landform;
  if (l.kind === 'brush' && l.op === 'smooth') throw new Error('a smooth brush is not folded onto tiles');
  const [x0, z0, x1, z1] = influenceBounds(l);
  const side = tileMm / 1000;
  const out: Tile[] = [];
  for (const t of tiles) {
    const ox = t.tx * side, oz = t.tz * side;
    if (ox > x1 || ox + side < x0 || oz > z1 || oz + side < z0) continue;
    const n = samplesOf(t), w = n + 1, step = side / n;
    const heights = new Int32Array(t.heights);
    let changed = false;
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const g: Ground = { schema: GROUND_SCHEMA, base: t.heights[k]! / 1000, extent: [-1e9, -1e9, 1e9, 1e9], landforms: [l], waters: [] };
        const h = Math.round(heightAt(g, ox + i * step, oz + j * step) * 1000);
        if (h !== heights[k]) { heights[k] = h; changed = true; }
      }
    }
    if (changed) out.push({ tx: t.tx, tz: t.tz, heights, classes: t.classes });
  }
  return out;
}
