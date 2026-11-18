// The crowd's coarser levels (V6, #2715): vertex clustering on the body's bind pose. Every vertex in one cell of a
// grid becomes the cell's first vertex (its skin weights and colour with it); triangles that collapse are dropped.
// Crude next to a quadric simplifier (apps/web's mesh-lod worker uses meshoptimizer), but it needs no dependency, runs
// in a millisecond on a 6,000-triangle body, and keeps a body's outline at the distances its levels are drawn.

export type LodMesh = {
  /** xyz per vertex. */
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  /** Four bone indices and four weights per vertex. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  index: Uint32Array;
};

/** The mesh with every vertex snapped to the first vertex of its `cell`-sided grid cell, unused vertices dropped. */
export function cluster(m: LodMesh, cell: number): LodMesh {
  const n = m.position.length / 3;
  const first = new Map<string, number>();
  const rep = new Uint32Array(n);
  for (let v = 0; v < n; v++) {
    const k = `${Math.floor(m.position[v * 3] / cell)},${Math.floor(m.position[v * 3 + 1] / cell)},${Math.floor(m.position[v * 3 + 2] / cell)}`;
    let r = first.get(k);
    if (r === undefined) first.set(k, (r = v));
    rep[v] = r;
  }
  const tris: number[] = [];
  for (let t = 0; t < m.index.length; t += 3) {
    const a = rep[m.index[t]], b = rep[m.index[t + 1]], c = rep[m.index[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  const map = new Map<number, number>();
  const index = new Uint32Array(tris.length);
  tris.forEach((v, i) => {
    let to = map.get(v);
    if (to === undefined) map.set(v, (to = map.size));
    index[i] = to;
  });
  const out: LodMesh = {
    position: new Float32Array(map.size * 3),
    normal: new Float32Array(map.size * 3),
    color: new Float32Array(map.size * 3),
    skinIndex: new Uint16Array(map.size * 4),
    skinWeight: new Float32Array(map.size * 4),
    index,
  };
  for (const [from, to] of map) {
    out.position.set(m.position.subarray(from * 3, from * 3 + 3), to * 3);
    out.normal.set(m.normal.subarray(from * 3, from * 3 + 3), to * 3);
    out.color.set(m.color.subarray(from * 3, from * 3 + 3), to * 3);
    out.skinIndex.set(m.skinIndex.subarray(from * 4, from * 4 + 4), to * 4);
    out.skinWeight.set(m.skinWeight.subarray(from * 4, from * 4 + 4), to * 4);
  }
  return out;
}
