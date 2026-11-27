// The engine's encoding profile (v2/docs/encoding.md) for the page's workers: six types, each value in one byte form.
// Integers from −2^64 to 2^64 − 1, bytes, text, arrays, and maps keyed by unsigned integers in ascending order; no
// floats, tags, simple values or indefinite lengths. Everything the engine writes and the replica hands back is in it,
// so a worker that reads and writes only that needs none of a general CBOR library's other forms. A value is held as
// cborg holds it with `useMaps`: an integer as a number, or a BigInt beyond 2^53; bytes as their own Uint8Array (a
// copy, never a view of the source); text as a string; an array; a Map. Anything outside the profile is refused.

const refuse = (what: string): never => { throw new Error(`encoding: ${what}`); };
const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', { fatal: true });
const whole = (v: unknown): v is number | bigint => typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v));

/** A head: the major type and its argument in the shortest form that holds it (rule 3). */
function head(out: number[], major: number, n: bigint): void {
  if (n < 0n || n > 0xffffffffffffffffn) refuse('an argument out of range');
  const info = n < 24n ? Number(n) : n < 0x100n ? 24 : n < 0x10000n ? 25 : n < 0x100000000n ? 26 : 27;
  out.push((major << 5) | info);
  for (let k = info < 24 ? 0 : 1 << (info - 24); k-- > 0;) out.push(Number((n >> BigInt(8 * k)) & 0xffn));
}
function blob(out: number[], major: number, bytes: Uint8Array): void {
  head(out, major, BigInt(bytes.length));
  for (const b of bytes) out.push(b);
}
function write(out: number[], v: unknown): void {
  if (whole(v)) { const n = BigInt(v); if (n < 0n) head(out, 1, -1n - n); else head(out, 0, n); }
  else if (v instanceof Uint8Array) blob(out, 2, v);
  else if (typeof v === 'string') blob(out, 3, utf8.encode(v));
  else if (Array.isArray(v)) { head(out, 4, BigInt(v.length)); for (const x of v) write(out, x); }
  else if (v instanceof Map) {
    const rows = [...v].map(([k, x]) => [whole(k) ? BigInt(k) : refuse('a map key that is not a whole number'), x] as [bigint, unknown]);
    head(out, 5, BigInt(rows.length));
    for (const [k, x] of rows.sort((a, b) => (a[0] < b[0] ? -1 : 1))) { head(out, 0, k); write(out, x); }
  } else refuse('not a value of the profile');
}

/** `v`'s one byte form in the profile; throws for a value the profile does not have. */
export function encode(v: unknown): Uint8Array {
  const out: number[] = [];
  write(out, v);
  return Uint8Array.from(out);
}

/** The value `bytes` hold: exactly one item of the profile (definite lengths, no tag, float or simple value, nothing
 *  after it). A head need not be the shortest: what the engine hashed it has already checked. */
export function decode(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const take = (n: number) => { if (at + n > bytes.length) refuse('cut short'); at += n; return at - n; };
  const read = (): unknown => {
    const first = bytes[take(1)], major = first >> 5, info = first & 31;
    let n: number | bigint = info;
    if (info === 24) n = bytes[take(1)];
    else if (info === 25) n = view.getUint16(take(2));
    else if (info === 26) n = view.getUint32(take(4));
    else if (info === 27) { const wide = view.getBigUint64(take(8)); n = wide <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(wide) : wide; }
    else if (info > 27) refuse('an indefinite length or a reserved head');
    if (major === 0) return n;
    if (major === 1) return typeof n === 'bigint' ? -1n - n : -1 - n;
    if (major > 5) refuse('a tag, a float or a simple value');
    if (typeof n === 'bigint') return refuse('a length out of range');
    if (major === 2) { const from = take(n); return new Uint8Array(bytes.subarray(from, from + n)); } // a copy, whatever `bytes` is
    if (major === 3) { const from = take(n); return text.decode(bytes.subarray(from, from + n)); }
    if (major === 4) { const out: unknown[] = []; for (let k = 0; k < n; k++) out.push(read()); return out; }
    const out = new Map<unknown, unknown>();
    for (let k = 0; k < n; k++) { const key = read(); out.set(key, read()); }
    return out;
  };
  const value = read();
  if (at !== bytes.length) refuse('bytes after the value');
  return value;
}
