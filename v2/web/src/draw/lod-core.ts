// The pure half of the ground's distance levels (#3785), copied from today's apps/web/src/mesh-lod-core.ts (not
// imported): coarser index buffers for one mesh from meshoptimizer's simplifier, run in lod.worker.ts so a phone never
// stalls simplifying, and in the tests. No three.js.
export type Simplifier = {
  simplify(indices: Uint32Array, positions: Float32Array, stride: number, targetIndexCount: number, targetError: number, flags?: string[]): [Uint32Array, number];
  simplifyWithAttributes?(indices: Uint32Array, positions: Float32Array, stride: number, attributes: Float32Array, attributeStride: number, weights: number[], lock: Uint8Array | null, targetIndexCount: number, targetError: number, flags?: string[]): [Uint32Array, number];
};
/** Copied, transferable arrays of one mesh: positions (xyz), indices, and the attributes that guide simplification
 *  (vertex colours, normals) with their weights. */
export type LodInput = { positions: Float32Array; indices: Uint32Array; parts: { array: Float32Array; n: number; w: number }[] };
/** One level: its index (into the input's vertices), its geometric error in metres, its triangles. */
export type LodLevel = { index: Uint32Array; error: number; triangles: number };

/** Today's level ratios and the hard cap on any level's deviation (m): decals (paths, lawns) lie just above the ground
 *  and must stay above a simplified surface. */
export const RATIOS = [0.3, 0.1, 0.03] as const;
export const MAX_WORLD_ERROR = 0.015;
/** Vertex colours carry the painted ground (a colour step of ~0.03 counts like a 1.5 cm displacement); normals keep
 *  the shading of folds (today's weights). */
export const COLOUR_WEIGHT = 0.5, NORMAL_WEIGHT = 0.05;

/** Coarser index levels, coarsest last; a level is kept only when it is meaningfully coarser than the one before.
 *  Borders are locked, so neighbouring pieces of ground never crack. */
export function simplifyLevels(s: Simplifier, input: LodInput, ratios: readonly number[] = RATIOS, maxError = MAX_WORLD_ERROR): LodLevel[] {
  const { positions, indices, parts } = input, count = positions.length / 3;
  const stride = parts.reduce((k, p) => k + p.n, 0), attributes = stride && s.simplifyWithAttributes ? new Float32Array(count * stride) : null;
  if (attributes) for (let v = 0; v < count; v++) {
    let o = v * stride;
    for (const p of parts) for (let c = 0; c < p.n; c++) attributes[o++] = p.array[v * p.n + c];
  }
  const weights = parts.flatMap((p) => Array<number>(p.n).fill(p.w));
  const out: LodLevel[] = [];
  let last = indices.length;
  for (const r of ratios) {
    const target = Math.max(3, Math.floor((indices.length * r) / 3) * 3);
    const [index, error] = attributes
      ? s.simplifyWithAttributes!(indices, positions, 3, attributes, stride, weights, null, target, maxError, ['LockBorder', 'ErrorAbsolute'])
      : s.simplify(indices, positions, 3, target, maxError, ['LockBorder', 'ErrorAbsolute']);
    if (!(index.length > 0) || index.length >= last * 0.8 || !Number.isFinite(error)) continue;
    out.push({ index, error, triangles: index.length / 3 });
    last = index.length;
  }
  return out;
}
