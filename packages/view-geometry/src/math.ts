import type { Vec3 } from './types.ts';
/** Squared point/triangle distance using projected edge orientations, avoiding differences of
 * nearly equal dot-product products. A negative orientation within its roundoff envelope is unknown. */
export function pointTriangle(px: number, py: number, pz: number, v: Float64Array, o: number): number {
    const ax = v[o], ay = v[o + 1], az = v[o + 2], ux = v[o + 3] - ax, uy = v[o + 4] - ay, uz = v[o + 5] - az, wx = v[o + 6] - ax, wy = v[o + 7] - ay, wz = v[o + 8] - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, n2 = nx * nx + ny * ny + nz * nz;
    let outside = false, uncertain = false, edgeMinimum = Infinity;
    for (let k = 0; k < 3; k++) {
        const i = o + k * 3, j = o + (k + 1) % 3 * 3, ex = v[j] - v[i], ey = v[j + 1] - v[i + 1], ez = v[j + 2] - v[i + 2], x = px - v[i], y = py - v[i + 1], z = pz - v[i + 2];
        const t0 = ey * z * nx, t1 = -ez * y * nx, t2 = ez * x * ny, t3 = -ex * z * ny, t4 = ex * y * nz, t5 = -ey * x * nz;
        const side = t0 + t1 + t2 + t3 + t4 + t5, error = (Math.abs(t0) + Math.abs(t1) + Math.abs(t2) + Math.abs(t3) + Math.abs(t4) + Math.abs(t5)) * Number.EPSILON * 32;
        if (side < -error)
            outside = true;
        else if (side < 0)
            uncertain = true;
        const t = Math.max(0, Math.min(1, (x * ex + y * ey + z * ez) / (ex * ex + ey * ey + ez * ez))), dx = x - t * ex, dy = y - t * ey, dz = z - t * ez;
        edgeMinimum = Math.min(edgeMinimum, dx * dx + dy * dy + dz * dz);
    }
    if (!outside) {
        if (uncertain)
            return NaN;
        const signed = nx * (px - ax) + ny * (py - ay) + nz * (pz - az);
        return signed * signed / n2;
    }
    return edgeMinimum;
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
// Condition the complete distance calculation before using any of its plane/endpoint/edge minima.
// Coordinate subtraction and cross-product errors are amplified by inverse squared angular condition
// in the projections/closest-pair solves. Reserve a quarter of the provider's 1e-7m boundary band;
// A safety multiple of coordinate roundoff is propagated through length/angular ratios; this
// remains a conservative refusal policy, not a claim of exact floating-point distance.
function distanceErrorEnvelope(a: Vec3, b: Vec3, v: Float64Array, o: number, nx: number, ny: number, nz: number): number {
    let scale = 0, longest2 = 0;
    for (let k = 0; k < 3; k++)
        scale = Math.max(scale, Math.abs(a[k]), Math.abs(b[k]));
    for (let i = o; i < o + 9; i++)
        scale = Math.max(scale, Math.abs(v[i]));
    for (let k = 0; k < 3; k++) {
        const i = o + k * 3, j = o + (k + 1) % 3 * 3;
        longest2 = Math.max(longest2, (v[j] - v[i]) ** 2 + (v[j + 1] - v[i + 1]) ** 2 + (v[j + 2] - v[i + 2]) ** 2);
    }
    const area = Math.hypot(nx, ny, nz), condition = area / longest2, roundoff = 64 * Number.EPSILON * scale;
    const edgeLength = Math.sqrt(longest2), span = Math.max(Math.hypot(a[0] - v[o], a[1] - v[o + 1], a[2] - v[o + 2]), Math.hypot(b[0] - v[o], b[1] - v[o + 1], b[2] - v[o + 2]), edgeLength);
    // Normal direction error from small edges at a large offset also grows over a long query span.
    let error = roundoff * (1 + span / edgeLength) / (condition * condition);
    if (error > 2.5e-8)
        return NaN;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], d2 = dx * dx + dy * dy + dz * dz;
    if (d2 === 0)
        return error;
    for (let k = 0; k < 3; k++) {
        const i = o + k * 3, j = o + (k + 1) % 3 * 3, ex = v[j] - v[i], ey = v[j + 1] - v[i + 1], ez = v[j + 2] - v[i + 2];
        const cx = dy * ez - dz * ey, cy = dz * ex - dx * ez, cz = dx * ey - dy * ex, c2 = cx * cx + cy * cy + cz * cz, e2 = ex * ex + ey * ey + ez * ez;
        if (c2 === 0) {
            // Axis-zero products establish exact parallelism; cancelling nonzero products do not.
            if (dy * ez !== 0 || dz * ey !== 0 || dz * ex !== 0 || dx * ez !== 0 || dx * ey !== 0 || dy * ex !== 0)
                return NaN;
        }
        else {
            error = Math.max(error, roundoff * (1 + Math.sqrt(d2 / e2) + Math.sqrt(e2 / d2)) * d2 * e2 / c2);
            if (error > 2.5e-8)
                return NaN;
        }
    }
    return error;
}
/** Capsule/triangle distance: plane piercing, endpoints, and three edge pairs. */
export function segmentTriangle(a: Vec3, b: Vec3, v: Float64Array, o: number): number {
    const ux = v[o + 3] - v[o], uy = v[o + 4] - v[o + 1], uz = v[o + 5] - v[o + 2], wx = v[o + 6] - v[o], wy = v[o + 7] - v[o + 1], wz = v[o + 8] - v[o + 2], nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const error = distanceErrorEnvelope(a, b, v, o, nx, ny, nz);
    if (!Number.isFinite(error))
        return NaN;
    const da = nx * (a[0] - v[o]) + ny * (a[1] - v[o + 1]) + nz * (a[2] - v[o + 2]), db = nx * (b[0] - v[o]) + ny * (b[1] - v[o + 1]) + nz * (b[2] - v[o + 2]);
    if (da !== db && da * db <= 0) {
        const normalLength = Math.hypot(nx, ny, nz), gap = (Math.abs(da) + Math.abs(db)) / normalLength;
        // For opposite signs the denominator is a sum, but near-coplanar t can still be sensitive.
        // If endpoint distance intervals touch zero or propagated t error moves the intersection
        // beyond the reserved boundary band, neither crossing nor its fallback can certify clear.
        if (Math.min(Math.abs(da), Math.abs(db)) / normalLength <= error || gap <= 2 * error ||
            2 * error / (gap - 2 * error) * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 2.5e-8)
            return NaN;
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
export function meets(a: Vec3, b: Vec3, box: Float64Array, o: number, r: number): boolean {
    let lo = 0, hi = 1;
    for (let k = 0; k < 3; k++) {
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
    }
    return true;
}
