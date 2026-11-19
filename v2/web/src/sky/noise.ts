// The weather noise texture (Engine v2 V19b, #3508), carried over from today's `apps/web/src/atmosphere/chunks.ts`
// (`makeAtmosphereNoise`): tileable fbm value noise, one texture for the dome's clouds (R), the Milky Way's mottle (R, G)
// and the moon's maria (B). Seeded by fixed numbers, so every page builds the same bytes.
import * as THREE from 'three';

/** The noise bytes (RGBA, `size` squared), exactly as today's page computes them. */
export function noiseBytes(size = 128): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number, s: number) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const lattices = new Map<number, Float64Array>();
  const lattice = (period: number, seed: number) => {
    const k = seed * 1024 + period;
    let L = lattices.get(k);
    if (!L) {
      L = new Float64Array(period * period);
      for (let j = 0; j < period; j++) for (let i = 0; i < period; i++) L[j * period + i] = hash(i, j, seed);
      lattices.set(k, L);
    }
    return L;
  };
  const value = (u: number, v: number, period: number, seed: number) => {
    const x = u * period, y = v * period, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), w = (a: number) => ((a % period) + period) % period;
    const L = lattice(period, seed), a = L[w(j) * period + w(i)], b = L[w(j) * period + w(i + 1)], c = L[w(j + 1) * period + w(i)], d = L[w(j + 1) * period + w(i + 1)];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, o = (y * size + x) * 4;
    for (let ch = 0; ch < 4; ch++) {
      let s = 0, amp = 0.5, norm = 0;
      for (let oct = 0; oct < 4; oct++) {
        s += amp * value(u, v, 4 << oct, ch * 31 + oct);
        norm += amp;
        amp *= 0.5;
      }
      data[o + ch] = Math.round(255 * Math.max(0, Math.min(1, (s / norm - 0.5) * 1.6 + 0.5)));
    }
  }
  return data;
}

let shared: THREE.DataTexture | null = null;
/** The page's one noise texture (built on first use). */
export function noiseTexture(): THREE.DataTexture {
  if (shared) return shared;
  const size = 128, t = new THREE.DataTexture(noiseBytes(size), size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return (shared = t);
}
