// A landform's expansion into one creator's edit (Engine v2 G5, #2762), called by souls-god's `land` verbs (#3695).
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
const hexOf = (bytes) => ({ hex: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex') });

/** The cells (i, j) of side `side / n` whose heights differ between `before` and `after`, as "i,j" keys. */
export function changedCells(before, after, tileMm) {
  const out = new Set();
  const byKey = new Map(before.map((t) => [`${t.tx},${t.tz}`, t]));
  for (const t of after) {
    const b = byKey.get(`${t.tx},${t.tz}`);
    if (!b) continue;
    const n = samplesOf(t), w = n + 1;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = [j * w + i, j * w + i + 1, (j + 1) * w + i, (j + 1) * w + i + 1];
        if (k.some((x) => t.heights[x] !== b.heights[x])) out.add(`${t.tx * n + i},${t.tz * n + j}`);
      }
    }
  }
  return { cells: out, cellUm: (tileMm * 1000) / samplesOf(before[0] ?? { classes: [0] }) };
}

/** The bodies (`[{ id, position: [x, y, z] µm }]` standing on the open ground) within `radiusUm` of a changed cell:
 *  what the world refuses as `edit.terrain-under-soul` (`sim::edit::terrain`), found on the copy first. */
export function bodiesUnder({ cells, cellUm }, bodies, radiusUm) {
  const c = (v) => Math.floor(Number(v) / cellUm);
  return bodies.filter(({ position: [x, , z] }) => {
    for (let i = c(Number(x) - radiusUm); i <= c(Number(x) + radiusUm); i++) {
      for (let j = c(Number(z) - radiusUm); j <= c(Number(z) + radiusUm); j++) if (cells.has(`${i},${j}`)) return true;
    }
    return false;
  });
}

/**
 * One edit's operations for `landform` (`packages/ground`'s record, metres) on the open ground `ground`
 * ({ id, tileMm, tiles: [{ tx, tz, heights: Int32Array mm, classes: Uint8Array }] }), with `things` resting on it
 * ([{ id, position: [x, y, z] µm (BigInt or number), orientation: [w, x, y, z], support }]). `water` ({ level } m)
 * makes the place a water over the landform's area; `placeKind` is the world's place kind. The operations are the
 * daemon's batch (`replica::wasm` `ops_of`): bytes as `{ hex }`, a move's position in µm as `atUm`, its facing and
 * support kept. Also the tiles after, for the caller's own checks.
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
  fields[F.LANDFORM] = hexOf(new TextEncoder().encode(JSON.stringify(landform)));
  const ops = [
    { op: 'place', name: 1, kind: placeKind, in: ground.id, at: [0, 0, 0], fields },
    { op: 'set', node: ground.id, field: F.TILES, value: tiles.map((t) => [t.tx, t.tz, hexOf(t.heights), hexOf(t.classes)]) },
  ];
  for (const th of things) {
    const [x, y, z] = th.position.map(BigInt);
    const before = heightAt(ground.tiles, ground.tileMm, x, z) ?? 0n;
    const after = heightAt(tiles, ground.tileMm, x, z) ?? 0n;
    if (after === before) continue;
    ops.push({ op: 'move', node: th.id, atUm: [Number(x), Number(y + after - before), Number(z)], orientation: th.orientation, support: th.support });
  }
  return { ops, patched: patched.length, tiles };
}

/** The tiles' range [tx0, tz0, tx1, tz1] (inclusive), grown to cover `bounds` ([x0, z0, x1, z1] m) if given. */
export function tileRange(tiles, tileMm, bounds) {
  const txs = tiles.map((t) => t.tx), tzs = tiles.map((t) => t.tz);
  const r = [Math.min(...txs), Math.min(...tzs), Math.max(...txs), Math.max(...tzs)];
  if (!bounds) return r;
  const side = tileMm / 1000, lo = (v) => Math.floor(v / side + 1e-9), hi = (v) => Math.ceil(v / side - 1e-9) - 1;
  return [Math.min(r[0], lo(bounds[0])), Math.min(r[1], lo(bounds[1])), Math.max(r[2], hi(bounds[2])), Math.max(r[3], hi(bounds[3]))];
}

/**
 * The open ground grown to cover `bounds` ([x0, z0, x1, z1] m), as today's `expand` grows a world (#3728): a tile
 * wherever the bounds reach and there was none, flat outward from the old ground's edge (each sample the height of the
 * nearest sample on that edge, each cell the class of the nearest cell), so the new ground meets the old with no step.
 * Only the new tiles; the old are kept as they are.
 */
export function grownTiles(tiles, tileMm, bounds) {
  if (!tiles.length) return [];
  const n = samplesOf(tiles[0]), w = n + 1;
  const keys = new Map(tiles.map((t) => [`${t.tx},${t.tz}`, t]));
  const [a0, b0, a1, b1] = tileRange(tiles);
  const [x0, z0, x1, z1] = tileRange(tiles, tileMm, bounds);
  const clamp = (v, l, h) => (v < l ? l : v > h ? h : v);
  const sample = (gi, gj) => {
    gi = clamp(gi, a0 * n, (a1 + 1) * n); gj = clamp(gj, b0 * n, (b1 + 1) * n);
    const tx = Math.min(Math.floor(gi / n), a1), tz = Math.min(Math.floor(gj / n), b1), t = keys.get(`${tx},${tz}`);
    return t ? t.heights[(gj - tz * n) * w + (gi - tx * n)] : 0;
  };
  const cell = (ci, cj) => {
    ci = clamp(ci, a0 * n, (a1 + 1) * n - 1); cj = clamp(cj, b0 * n, (b1 + 1) * n - 1);
    const tx = Math.floor(ci / n), tz = Math.floor(cj / n), t = keys.get(`${tx},${tz}`);
    return t ? t.classes[(cj - tz * n) * n + (ci - tx * n)] : 0;
  };
  const out = [];
  for (let tz = z0; tz <= z1; tz++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (keys.has(`${tx},${tz}`)) continue;
      const heights = new Int32Array(w * w), classes = new Uint8Array(n * n);
      for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) heights[j * w + i] = sample(tx * n + i, tz * n + j);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) classes[j * n + i] = cell(tx * n + i, tz * n + j);
      out.push({ tx, tz, heights, classes });
    }
  }
  return out;
}
