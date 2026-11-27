import type { Vec3 } from './types.ts';
/** Squared point/triangle distance, barycentric Voronoi regions; scalar arithmetic, no query scratch allocation. */
export function pointTriangle(px: number, py: number, pz: number, v: Float64Array, o: number): number {
    const ax = v[o], ay = v[o + 1], az = v[o + 2], bx = v[o + 3], by = v[o + 4], bz = v[o + 5], cx = v[o + 6], cy = v[o + 7], cz = v[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0)
        return apx * apx + apy * apy + apz * apz;
    const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3)
        return bpx * bpx + bpy * bpy + bpz * bpz;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3), x = apx - t * abx, y = apy - t * aby, z = apz - t * abz;
        return x * x + y * y + z * z;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6)
        return cpx * cpx + cpy * cpy + cpz * cpz;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const t = d2 / (d2 - d6), x = apx - t * acx, y = apy - t * acy, z = apz - t * acz;
        return x * x + y * y + z * z;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)), x = bpx - t * (cx - bx), y = bpy - t * (cy - by), z = bpz - t * (cz - bz);
        return x * x + y * y + z * z;
    }
    const inv = 1 / (va + vb + vc), u = vb * inv, w = vc * inv, x = apx - u * abx - w * acx, y = apy - u * aby - w * acy, z = apz - u * abz - w * acz;
    return x * x + y * y + z * z;
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function edgeDistance(a: Vec3, b: Vec3, v: Float64Array, i: number, j: number): number {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], ex = v[j] - v[i], ey = v[j + 1] - v[i + 1], ez = v[j + 2] - v[i + 2], rx = a[0] - v[i], ry = a[1] - v[i + 1], rz = a[2] - v[i + 2];
    const aa = dx * dx + dy * dy + dz * dz, ee = ex * ex + ey * ey + ez * ez, ff = ex * rx + ey * ry + ez * rz;
    let s = 0, t = 0;
    if (aa === 0) {
        t = ee === 0 ? 0 : clamp(ff / ee);
    }
    else {
        const cc = dx * rx + dy * ry + dz * rz;
        if (ee === 0)
            s = clamp(-cc / aa);
        else {
            const bb = dx * ex + dy * ey + dz * ez, cx = dy * ez - dz * ey, cy = dz * ex - dx * ez, cz = dx * ey - dy * ex, den = cx * cx + cy * cy + cz * cz;
            s = den > 0 ? clamp(((ey * rz - ez * ry) * cx + (ez * rx - ex * rz) * cy + (ex * ry - ey * rx) * cz) / den) : 0;
            t = (bb * s + ff) / ee;
            if (t < 0) {
                t = 0;
                s = clamp(-cc / aa);
            }
            else if (t > 1) {
                t = 1;
                s = clamp((bb - cc) / aa);
            }
        }
    }
    const x = rx + s * dx - t * ex, y = ry + s * dy - t * ey, z = rz + s * dz - t * ez;
    return x * x + y * y + z * z;
}
/** Capsule/triangle distance: plane piercing, endpoints, and three edge pairs. */
export function segmentTriangle(a: Vec3, b: Vec3, v: Float64Array, o: number): number {
    const ux = v[o + 3] - v[o], uy = v[o + 4] - v[o + 1], uz = v[o + 5] - v[o + 2], wx = v[o + 6] - v[o], wy = v[o + 7] - v[o + 1], wz = v[o + 8] - v[o + 2], nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const da = nx * (a[0] - v[o]) + ny * (a[1] - v[o + 1]) + nz * (a[2] - v[o + 2]), db = nx * (b[0] - v[o]) + ny * (b[1] - v[o + 1]) + nz * (b[2] - v[o + 2]);
    if (da !== db && da * db <= 0) {
        const t = da / (da - db), x = a[0] + t * (b[0] - a[0]), y = a[1] + t * (b[1] - a[1]), z = a[2] + t * (b[2] - a[2]);
        const side = (i: number, j: number) => { const ex = v[j] - v[i], ey = v[j + 1] - v[i + 1], ez = v[j + 2] - v[i + 2], px = x - v[i], py = y - v[i + 1], pz = z - v[i + 2]; return (ey * pz - ez * py) * nx + (ez * px - ex * pz) * ny + (ex * py - ey * px) * nz; };
        const s0 = side(o, o + 3), s1 = side(o + 3, o + 6), s2 = side(o + 6, o), band = (nx * nx + ny * ny + nz * nz) * 1e-12;
        if (s0 >= 0 && s1 >= 0 && s2 >= 0)
            return 0;
        if (s0 >= -band && s1 >= -band && s2 >= -band)
            return NaN;
    }
    return Math.max(0, Math.min(pointTriangle(...a, v, o), pointTriangle(...b, v, o), edgeDistance(a, b, v, o, o + 3), edgeDistance(a, b, v, o + 3, o + 6), edgeDistance(a, b, v, o + 6, o)));
}
/** Conservative capsule broad phase: segment against a radius-expanded AABB. */
export function meets(a: Vec3, b: Vec3, box: Float64Array, o: number, r: number): boolean { let lo = 0, hi = 1; for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k], min = box[o + k] - r, max = box[o + k + 3] + r;
    if (d === 0) {
        if (a[k] < min || a[k] > max)
            return false;
    }
    else {
        let x = (min - a[k]) / d, y = (max - a[k]) / d;
        if (x > y)
            [x, y] = [y, x];
        lo = Math.max(lo, x);
        hi = Math.min(hi, y);
        if (lo > hi)
            return false;
    }
} return true; }
