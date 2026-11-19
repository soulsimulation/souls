// A landform's expansion into one creator's edit (Engine v2 G5, #2762). G7's verbs call `expand` once merged.
//
// The batch, in `replica::edit::Op`'s shapes: the landform's place node under the open ground (its outline, its
// parameters as JSON bytes; for a lake or a pond, the water itself, as N1 imports Eden's waters), the open ground's
// tiles with the changed ones patched (`v2/tools/terrain`, today's `packages/ground`), and a move for each thing resting
// on the open ground whose origin's ground rises or falls, by exactly that much: a pose change written in the batch,
// never a silent move. The world refuses the batch whole if a Soul stands where the ground changes, a building stands
// there, or a resting thing is not moved (`sim::edit::terrain`). Heights under a point are read as the engine reads
// them (`ground::scene::Terrain::height_at`): bilinear in whole micrometres, rounded half up, so the lift agrees.
import { patch, samplesOf } from '../../../../tools/terrain/patch.ts';

/** N1's field numbers (`v2/tools/import-eden/src/lib.rs`), and the landform's parameters (G5). */
export const F = { OUTLINE: 11, WATER_LEVEL: 18, PLACE_OF: 20, TILE_SIZE: 24, TILES: 25, LANDFORM: 28 };

const div = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b));

/** The ground's height at (x, z) µm on `tiles` (each `tileMm` a side), µm, as the engine reads it; null off them. */
export function heightAt(tiles, tileMm, x, z) {
  const side = BigInt(tileMm) * 1000n;
  const key = (p) => div(p, side);
  let tx = key(x), tz = key(z);
  const at = (a, b) => tiles.find((t) => BigInt(t.tx) === a && BigInt(t.tz) === b);
  if (!at(tx, tz) && x - tx * side === 0n) tx -= 1n;
  if (!at(tx, tz) && z - tz * side === 0n) tz -= 1n;
  const t = at(tx, tz);
  if (!t) return null;
  const n = BigInt(samplesOf(t)), cell = side / n, last = n - 1n;
  const fx = x - tx * side, fz = z - tz * side;
  const i = fx / cell < last ? fx / cell : last, j = fz / cell < last ? fz / cell : last;
  const u = fx - i * cell, v = fz - j * cell, w = Number(n) + 1;
  const h = (a, b) => BigInt(t.heights[Number(b) * w + Number(a)]) * 1000n;
  const s = cell;
  const sum = h(i, j) * (s - u) * (s - v) + h(i + 1n, j) * u * (s - v) + h(i, j + 1n) * (s - u) * v + h(i + 1n, j + 1n) * u * v;
  const d = s * s;
  return div(sum + d / 2n, d);
}

const ring = (pts) => pts.map(([x, z]) => [Math.round(x * 1000), Math.round(z * 1000)]);

/**
 * One edit's operations for `landform` (`packages/ground`'s record, metres) on the open ground `ground`
 * ({ id, tileMm, tiles: [{ tx, tz, heights: Int32Array mm, classes: Uint8Array }] }), with `things` resting on it
 * ([{ id, position: [x, y, z] µm (BigInt or number), orientation, support }]). `water` ({ level } m) makes the place
 * a water over the landform's area; `placeKind` is the world's pinned `eden:place@…`. Positions in the ops are µm.
 */
export function expand({ ground, landform, water, things = [], placeKind, outline }) {
  const patched = patch(ground.tiles, ground.tileMm, landform);
  const byKey = new Map(patched.map((t) => [`${t.tx},${t.tz}`, t]));
  const tiles = ground.tiles.map((t) => byKey.get(`${t.tx},${t.tz}`) ?? t);
  const area = outline ?? landform.area;
  if (!area) throw new Error('a landform place needs an outline');
  const fields = { [F.OUTLINE]: ring(area) };
  if (water) {
    fields[F.PLACE_OF] = 'eden:water';
    fields[F.WATER_LEVEL] = Math.round(water.level * 1000);
  } else {
    fields[F.PLACE_OF] = 'eden:landform';
  }
  fields[F.LANDFORM] = new TextEncoder().encode(JSON.stringify(landform));
  const ops = [
    { op: 'place', name: 1, kind: placeKind, parent: ground.id, at: { position: [0n, 0n, 0n] }, fields },
    {
      op: 'set', node: ground.id, field: F.TILES,
      to: tiles.map((t) => [t.tx, t.tz, new Uint8Array(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength), t.classes]),
    },
  ];
  for (const th of things) {
    const [x, y, z] = th.position.map(BigInt);
    const before = heightAt(ground.tiles, ground.tileMm, x, z) ?? 0n;
    const after = heightAt(tiles, ground.tileMm, x, z) ?? 0n;
    if (after === before) continue;
    ops.push({ op: 'move', node: th.id, at: { position: [x, y + after - before, z], orientation: th.orientation, support: th.support } });
  }
  return { ops, patched: patched.length };
}
