// Vendored from mars/viewer/engine/core/math.ts (Vec3, clamp and dsin with its kernels) (#2750 B15): v2/web draws creature presets without importing from mars/viewer.
// Keep in step with that file; creature.test.ts pins the bakes it produces.
export type Vec3 = [number, number, number];
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------------------
// Deterministic transcendentals (fdlibm / FreeBSD msun algorithms, pure
// arithmetic). Accuracy: <= 1 ulp vs a correctly rounded result for the
// trig kernels, <= 2 ulp for dtan/dasin/dacos (verified in core.test.ts).
// Range reduction is exact for |x| < 2^20 * pi/2 (~1.65e6). Beyond that the
// argument is first folded with the exactly-specified % by a 33-bit 2*pi: the
// result stays deterministic and in range, but is not an accurate sin/cos of
// such huge arguments (no Payne-Hanek; the engine never gets near 1e6 rad).

// sin/cos kernel coefficients on [-pi/4, pi/4] (msun k_sin.c / k_cos.c)
const S1 = -1.66666666666666324348e-1, S2 = 8.33333333332248946124e-3, S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6, S5 = -2.50507602534068634195e-8, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2, C2 = -1.38888888888741095749e-3, C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7, C5 = 2.08757232129817482790e-9, C6 = -1.13596475577881948265e-11;

/** sin(x + y) for |x + y| <= ~pi/4, y the tail of a reduced argument. */
function ksin(x: number, y: number): number {
  const z = x * x, w = z * z, r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6), v = z * x;
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
/** cos(x + y) for |x + y| <= ~pi/4. */
function kcos(x: number, y: number): number {
  const z = x * x, w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z, h = 1 - hz;
  return h + (((1 - h) - hz) + (z * r - x * y));
}

// Cody-Waite pi/2 in three 33-bit pieces + tail (fdlibm e_rem_pio2.c): n * piece
// is exact for |n| < 2^20, so x - n*pi/2 is formed to ~150 bits.
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417e0, PIO2_2 = 6.07710050630396597660e-11;
const PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
const PIO4 = 7.85398163397448278999e-1;
// reduced argument (head, tail) of the last remPio2 call; module scratch keeps the hot path allocation-free
let RY0 = 0, RY1 = 0;

const REM_EXACT = 1647099.3291652855; // 2^20 * pi/2
const TWO_PI_33 = 4 * PIO2_1; // exactly representable

/** x = n*pi/2 + (RY0 + RY1) with |RY0 + RY1| <= ~pi/4; returns n. Finite x only. */
function remPio2(x: number): number {
  if (x >= REM_EXACT || x <= -REM_EXACT) x %= TWO_PI_33; // deterministic fold, see header
  const n = Math.round(x * INV_PIO2);
  const r = x - n * PIO2_1; // exact (Sterbenz; n*PIO2_1 exact)
  const a = n * PIO2_2; // exact
  const s = r - a;
  let v = s - r; // two-sum(r, -a)
  const lo = (r - (s - v)) - (a + v) - (n * PIO2_3 + n * PIO2_3T);
  const y0 = s + lo;
  v = y0 - s; // two-sum(s, lo)
  RY1 = (s - (y0 - v)) + (lo - v);
  RY0 = y0;
  return n;
}

const TINY_TRIG = 7.450580596923828e-9; // 2^-27: sin x = x, cos x = 1, tan x = x to within 1/2 ulp

/** Deterministic sin(x) (<= 1 ulp). */
export function dsin(x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax <= PIO4) {
    if (ax < TINY_TRIG) return x; // keeps -0
    const z = x * x, w = z * z, r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
    return x + z * x * (S1 + z * r);
  }
  if (!(ax < Infinity)) return NaN;
  const n = remPio2(x) & 3;
  return n === 0 ? ksin(RY0, RY1) : n === 1 ? kcos(RY0, RY1) : n === 2 ? -ksin(RY0, RY1) : -kcos(RY0, RY1);
}

/** Deterministic cos(x) (<= 1 ulp). */
export function dcos(x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax <= PIO4) return ax < TINY_TRIG ? 1 : kcos(x, 0);
  if (!(ax < Infinity)) return NaN;
  const n = remPio2(x) & 3;
  return n === 0 ? kcos(RY0, RY1) : n === 1 ? -ksin(RY0, RY1) : n === 2 ? -kcos(RY0, RY1) : ksin(RY0, RY1);
}

/** Deterministic tan(x) (<= 2 ulp), as the ratio of the shared-reduction kernels. */
