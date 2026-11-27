// Stable hashing for defs and bake keys. Node and browsers both have SubtleCrypto,
// but defs must hash synchronously at define time, so this is a pure-JS SHA-256.
// Same output as the map/filter/sort/join form ('[' + v.map(f).join(',') + ']', '{' + sorted defined keys k:f(v) + '}'),
// built in one pass with a small memo of quoted keys: bake keys stringify a building's params once per child (L3e).
const quotedKeys = new Map<string, string>();
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    let s = '[';
    for (let i = 0; i < v.length; i++) { if (i) s += ','; const x = stableStringify(v[i]); if (x !== undefined) s += x; } // join() writes undefined as ''
    return s + ']';
  }
  const o = v as Record<string, unknown>, keys: string[] = [];
  for (const k of Object.keys(o)) if (o[k] !== undefined) keys.push(k);
  keys.sort();
  let s = '{';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]; let q = quotedKeys.get(k);
    if (q === undefined) { q = JSON.stringify(k) + ':'; if (quotedKeys.size < 4096) quotedKeys.set(k, q); }
    if (i) s += ',';
    s += q + stableStringify(o[k]);
  }
  return s + '}';
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
// Phone arrival: one page builds the core library (~1,000 defs, 2.3 MB of stable JSON) by hashing every def at once.
// The block loop keeps its state in locals and reads the bytes directly (no padded copy, DataView or destructuring per
// block): the same digest, several times faster.
const K32 = Int32Array.from(K), W = new Int32Array(64), tail = new Uint8Array(128), utf8 = new TextEncoder();
function blocks(H: Int32Array, b: Uint8Array, end: number): void {
  let h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7];
  for (let off = 0; off < end; off += 64) {
    for (let i = 0, j = off; i < 16; i++, j += 4) W[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3), s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = h0, c1 = h1, c2 = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)), t1 = (h + S1 + ((e & f) ^ (~e & g)) + K32[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)), t2 = (S0 + ((a & c1) ^ (a & c2) ^ (c1 & c2))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c2; c2 = c1; c1 = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + c1) | 0; h2 = (h2 + c2) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  H[0] = h0; H[1] = h1; H[2] = h2; H[3] = h3; H[4] = h4; H[5] = h5; H[6] = h6; H[7] = h7;
}
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8.encode(input) : input;
  const l = bytes.length, whole = l - (l % 64), rest = l - whole, n = rest + 9 <= 64 ? 64 : 128;
  const H = Int32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  blocks(H, bytes, whole);
  // the last bytes, the 0x80 and the length in bits (64-bit big-endian) in one or two more blocks
  tail.fill(0); tail.set(bytes.subarray(whole), 0); tail[rest] = 0x80;
  const hi = Math.floor((l * 8) / 4294967296), lo = (l * 8) >>> 0;
  tail[n - 8] = hi >>> 24; tail[n - 7] = hi >>> 16; tail[n - 6] = hi >>> 8; tail[n - 5] = hi;
  tail[n - 4] = lo >>> 24; tail[n - 3] = lo >>> 16; tail[n - 2] = lo >>> 8; tail[n - 1] = lo;
  blocks(H, tail, n);
  let hex = '';
  for (let i = 0; i < 8; i++) hex += (H[i] >>> 0).toString(16).padStart(8, '0');
  return hex;
}
export const hashOf = (v: unknown) => sha256Hex(stableStringify(v));
/** In-memory cache key for content (bake keys): two independent 32-bit string hashes plus the length of the stable JSON.
 *  Not for anything persisted or compared across processes (use hashOf); ~20x cheaper than the pure-JS SHA-256, which
 *  dominated a big world's first frame (Eden 2026: ~1.1 s of bake keys while drawing). */
export function cacheKeyOf(v: unknown): string { return cacheKeyOfText(stableStringify(v)); }
/** cacheKeyOf of text that is already the stable JSON. */
export function cacheKeyOfText(s: string): string {
  let a = 0x811c9dc5 | 0, b = 0x9e3779b9 | 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; }
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b); b = Math.imul(b ^ (b >>> 13), 0xc2b2ae35);
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + s.length.toString(36);
}
/** Short, URL-safe id from a counter and a world seed; ids are unique per world and never reused. */
export function entityId(seq: number, worldSeed: string): string {
  return 'e_' + sha256Hex(`${worldSeed}:${seq}`).slice(0, 8);
}
