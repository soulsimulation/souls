/** Test-only slow reference: independently transform each vertex through its ancestor chain; no index,
 * production matrix product, slab test, Voronoi-region code or production segment distance is reused.
 * Triangle projection+edge projection, then convex one-dimensional minimization along the segment. */
import type { Vec3, ViewGeometry, ViewMesh, ViewMaterial } from './types.ts';
const sub = (a: readonly number[], b: readonly number[]) => a.map((x, i) => x - b[i]);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]) => Math.sqrt(dot(a, a));
export function worldFaces(g: ViewGeometry, mesh: ViewMesh): number[][][] { const vertices = mesh.vertices.map(p => { let q: number[] = [...p], node = mesh.node; while (node !== null) {
    const n = g.nodes.find(n => n.id === node)!;
    const m = n.matrix;
    q = [m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12], m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13], m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14]];
    node = n.parent;
} return q; }); return mesh.triangles.map(t => t.map(i => vertices[i])); }
function pointDistance(p: number[], face: number[][]): number { const [a, b, c] = face, n = cross(sub(b, a), sub(c, a)), nn = dot(n, n), height = dot(sub(p, a), n) / nn, projected = p.map((x, i) => x - height * n[i]); const sides = [[a, b], [b, c], [c, a]].map(([u, v]) => dot(cross(sub(v, u), sub(projected, u)), n)); if (sides.every(v => v >= -1e-12) || sides.every(v => v <= 1e-12))
    return height * height * nn; return Math.min(...[[a, b], [b, c], [c, a]].map(([u, v]) => { const edge = sub(v, u), t = Math.max(0, Math.min(1, dot(sub(p, u), edge) / dot(edge, edge))), delta = p.map((x, i) => x - u[i] - t * edge[i]); return dot(delta, delta); })); }
export function oracleDistance(a: Vec3, b: Vec3, face: number[][]): number { const f = (t: number) => pointDistance(a.map((x, i) => x + (b[i] - x) * t), face); let lo = 0, hi = 1; for (let i = 0; i < 100; i++) {
    const x = lo + (hi - lo) / 3, y = hi - (hi - lo) / 3;
    if (f(x) < f(y))
        hi = y;
    else
        lo = x;
} return Math.min(f(0), f(1), f((lo + hi) / 2)); }
function inside(p: Vec3, faces: number[][][]): boolean { let sum = 0; for (const [a, b, c] of faces) {
    const x = sub(a, p), y = sub(b, p), z = sub(c, p), numerator = dot(x, cross(y, z)), denominator = norm(x) * norm(y) * norm(z) + dot(x, y) * norm(z) + dot(y, z) * norm(x) + dot(z, x) * norm(y);
    sum += 2 * Math.atan2(numerator, denominator);
} return Math.abs(sum) > Math.PI * 2; }
export function oracle(g: ViewGeometry, from: Vec3, to: Vec3, radius: number, clearance: boolean): 'clear' | 'blocked' | 'unknown' { let unknown = g.coverage === 'partial'; for (const mesh of g.meshes) {
    const m = g.materials.find(m => m.id === mesh.material) as ViewMaterial, policy = clearance ? m.clearance : m.occlusion;
    if (policy === 'pass')
        continue;
    const faces = worldFaces(g, mesh);
    if (clearance && mesh.topology === 'convex-solid' && inside(from, faces)) {
        if (policy === 'block')
            return 'blocked';
        unknown = true;
    }
    for (const face of faces) {
        const n = cross(sub(face[1], face[0]), sub(face[2], face[0])), direction = dot(sub(to, from), n);
        if (!clearance && m.side !== 'both' && ((m.side === 'front' && direction >= 0) || (m.side === 'back' && direction <= 0)))
            continue;
        const d = oracleDistance(from, to, face);
        if (d <= (radius + 1e-8) ** 2) {
            if (policy === 'block')
                return 'blocked';
            unknown = true;
        }
    }
} return unknown ? 'unknown' : 'clear'; }
