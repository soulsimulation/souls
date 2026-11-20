// The crowd's coarser levels (V6, #2715): vertex clustering on the body's bind pose. Every vertex in one cell of a
// grid becomes the cell's first vertex (its skin weights and colour with it); triangles that collapse are dropped.
// Crude next to a quadric simplifier (apps/web's mesh-lod worker uses meshoptimizer), but it needs no dependency, runs
// in a millisecond on a 6,000-triangle body, and keeps a body's outline at the distances its levels are drawn.

export type LodMesh = {
  /** xyz per vertex. */
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  /** Original UVs and material group, retained through derived levels. */
  uv?: Float32Array;
  material?: Uint16Array;
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
  const uvAt = new Map<string, string>();
  const seams = new Set<string>();
  if (m.uv) for (let v = 0; v < n; v++) {
    const p = `${m.position[v * 3]},${m.position[v * 3 + 1]},${m.position[v * 3 + 2]}`;
    const uv = `${m.uv[v * 2]},${m.uv[v * 2 + 1]}`;
    if (uvAt.has(p) && uvAt.get(p) !== uv) seams.add(p);
    uvAt.set(p, uv);
  }
  for (let v = 0; v < n; v++) {
    const p = `${m.position[v * 3]},${m.position[v * 3 + 1]},${m.position[v * 3 + 2]}`;
    const seam = m.uv && seams.has(p) ? `${m.uv[v * 2]},${m.uv[v * 2 + 1]}` : '';
    const k = `${Math.floor(m.position[v * 3] / cell)},${Math.floor(m.position[v * 3 + 1] / cell)},${Math.floor(m.position[v * 3 + 2] / cell)}:${m.material?.[v] ?? 0}:${seam}`;
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
    ...(m.uv ? { uv: new Float32Array(map.size * 2) } : {}),
    ...(m.material ? { material: new Uint16Array(map.size) } : {}),
    skinIndex: new Uint16Array(map.size * 4),
    skinWeight: new Float32Array(map.size * 4),
    index,
  };
  for (const [from, to] of map) {
    out.position.set(m.position.subarray(from * 3, from * 3 + 3), to * 3);
    out.normal.set(m.normal.subarray(from * 3, from * 3 + 3), to * 3);
    out.color.set(m.color.subarray(from * 3, from * 3 + 3), to * 3);
    if (out.uv && m.uv) out.uv.set(m.uv.subarray(from * 2, from * 2 + 2), to * 2);
    if (out.material && m.material) out.material[to] = m.material[from];
    out.skinIndex.set(m.skinIndex.subarray(from * 4, from * 4 + 4), to * 4);
    out.skinWeight.set(m.skinWeight.subarray(from * 4, from * 4 + 4), to * 4);
  }
  return out;
}

/** A body kind's simple model (B13, #2744), as the importer writes it and the crowd draws it for its farthest level:
 *  `crowd-mesh/1`, little-endian: the eight bytes `CMESH1\0\0`, the vertex and index counts (u32 each), then position,
 *  normal and colour (f32 × 3 each), skin indices (u16 × 4), skin weights (f32 × 4) and the indices (u32). */
const MAGIC = 'CMESH1\0\0', TEXTURED_MAGIC = 'CMESH2\0\0';

export function encodeMesh(m: LodMesh): Uint8Array {
  const n = m.position.length / 3;
  const textured = !!(m.uv || m.material);
  const parts: ArrayBufferView[] = [m.position, m.normal, m.color, m.skinIndex, m.skinWeight, m.index];
  if (textured) parts.push(m.uv ?? new Float32Array(n * 2), m.material ?? new Uint16Array(n));
  const size = 16 + parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(size);
  for (let i = 0; i < 8; i++) out[i] = (textured ? TEXTURED_MAGIC : MAGIC).charCodeAt(i);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, n, true);
  dv.setUint32(12, m.index.length, true);
  let at = 16;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
    at += p.byteLength;
  }
  return out;
}

export function decodeMesh(b: Uint8Array): LodMesh {
  const magic = String.fromCharCode(...b.subarray(0, 8));
  if (magic !== MAGIC && magic !== TEXTURED_MAGIC) throw new Error('not a crowd-mesh file');
  const textured = magic === TEXTURED_MAGIC;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(8, true), k = dv.getUint32(12, true);
  const copy = b.slice(16).buffer; // aligned
  if (copy.byteLength !== n * (12 * 3 + 8 + 16 + (textured ? 10 : 0)) + k * 4) throw new Error('crowd-mesh/1: wrong length');
  let at = 0;
  const take = <T>(C: new (buf: ArrayBuffer, off: number, len: number) => T, len: number, bytes: number): T => {
    const v = new C(copy, at, len);
    at += len * bytes;
    return v;
  };
  const mesh: LodMesh = {
    position: take(Float32Array, n * 3, 4), normal: take(Float32Array, n * 3, 4), color: take(Float32Array, n * 3, 4),
    skinIndex: take(Uint16Array, n * 4, 2), skinWeight: take(Float32Array, n * 4, 4), index: take(Uint32Array, k, 4),
  };
  if (textured) {
    mesh.uv = take(Float32Array, n * 2, 4);
    mesh.material = take(Uint16Array, n, 2);
  }
  return mesh;
}

/** The mesh clustered on ever larger cells until it has at most `triangles` triangles. */
export function simplify(m: LodMesh, triangles: number): LodMesh {
  let out = m;
  for (let cell = 0.02; out.index.length / 3 > triangles && cell < 100; cell *= 1.15) out = cluster(m, cell);
  if (out.index.length / 3 > triangles) throw new Error('body.simple-mesh-preserves-seams');
  return out;
}
