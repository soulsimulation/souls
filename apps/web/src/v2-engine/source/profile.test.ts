// The workers' own reader and writer for the engine's encoding profile (profile.ts) against the profile's committed
// vectors (v2/crates/replica/fixtures/encoding, which the native encoder and the WASM build are held to) and against
// cborg, the library they stand in for: every vector reads to the value cborg reads and writes back to the vector's
// bytes; the shapes the workers write (a query with node ids, a course) are written as cborg wrote them; whatever
// cborg writes within the profile is read as cborg reads it; and anything outside the profile is refused, never read
// or written as something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { decode as cborgDecode, encode as cborg } from 'cborg';
import { decode, encode } from './profile.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const dir = new URL('../../../../../v2/crates/replica/fixtures/encoding/', import.meta.url);
const id = (n: number | bigint): [Uint8Array, number | bigint] => [Uint8Array.from({ length: 16 }, (_, k) => (k * 37 + 5) & 255), n];
/** What the workers write, and values of every type and head width. */
const values: unknown[] = [
  new Map<number, unknown>([[1, 1], [2, id(7)]]),                                             // one node
  new Map<number, unknown>([[1, 5], [2, 123456]]),                                            // what changed since a version
  new Map<number, unknown>([[1, 7], [2, Array.from({ length: 300 }, (_, k) => id(k * 1000))]]), // many nodes at once
  new Map<number, unknown>([[1, 7], [2, [id(2n ** 64n - 1n), id(2n ** 53n + 1n)]]]),
  new Map<number, unknown>([[2, 'souls:course'], [1, [0, -1, -24, -25, -256, -257, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, -(2n ** 53n), -(2n ** 53n) - 1n, 2n ** 53n]],
    [80, new Map<number, unknown>([[3, new Uint8Array(40)], [1, -(2n ** 64n)], [70000, 'mars:carry_activity@1220ab'], [2 ** 40, [[], new Map(), '', new Uint8Array(0)]]])]]),
  [], new Map(), '', new Uint8Array(0), 0, -1, new Uint8Array(70000).fill(9), 'x'.repeat(300),
];

test('every committed encoding vector reads as cborg reads it and is written back as the vector\'s bytes', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  assert.ok(files.length >= 35, `the vectors are there (${files.length})`);
  for (const f of files) {
    const want = readFileSync(new URL(f, dir), 'utf8').trim().split('\n').at(-1)!.trim();
    assert.match(want, /^([0-9a-f]{2})+$/, `${f}: its last line is its bytes`);
    const value = decode(unhex(want));
    assert.deepStrictEqual(value, cborgDecode(unhex(want), { useMaps: true }), `${f}: read as cborg reads it`);
    assert.equal(hex(encode(value)), want, `${f}: written back`);
    assert.equal(hex(cborg(value)), want, `${f}: and cborg's encoder agrees`);
  }
});

test('what the workers write is written as cborg wrote it, and read back the same', () => {
  for (const v of values) {
    const bytes = encode(v);
    assert.equal(hex(bytes), hex(cborg(v)));
    assert.deepStrictEqual(decode(bytes), cborgDecode(bytes, { useMaps: true }));
  }
  assert.equal(hex(encode(new Map([[2, 0], [1, 0]]))), 'a201000200', 'a map is written in ascending key order, however it was built');
  // −2^53 is past what a number holds safely: read as a BigInt, as cborg reads it, so it is written back (a course's field)
  const edge = unhex('3b001fffffffffffff');
  assert.deepStrictEqual(decode(edge), cborgDecode(edge, { useMaps: true }));
  assert.equal(decode(edge), -(2n ** 53n));
  assert.equal(hex(encode(decode(edge))), hex(edge));
  assert.equal(decode(unhex('63efbbbf')), '\ufeff', 'text is kept whole, a leading byte order mark too');
});

test('bytes read are a copy of their own, and a value inside a larger buffer reads from its own range', () => {
  const whole = new Uint8Array(64).fill(0xff), item = encode([new Uint8Array([1, 2, 3]), 'kind', 500]);
  whole.set(item, 8);
  const [bytes, name, n] = decode(whole.subarray(8, 8 + item.length)) as [Uint8Array, string, number];
  assert.deepEqual([[...bytes], name, n], [[1, 2, 3], 'kind', 500]);
  assert.equal(bytes.buffer.byteLength, 3, 'not a view that keeps (or would post) the whole source');
  const fromNode = decode(Buffer.from(item)) as [Uint8Array];
  assert.equal(Object.getPrototypeOf(fromNode[0]), Uint8Array.prototype, 'a plain Uint8Array of its own, from a Node Buffer too');
});

test('a value the profile does not have is refused, written or read', () => {
  for (const bad of [1.5, NaN, Infinity, undefined, null, true, { a: 1 }, new Map([['a', 1]]), new Map([[1.5, 1]]), new Map([[-1, 1]]), [1, [undefined]], 2n ** 64n, -(2n ** 64n) - 1n, 2 ** 60, new Date(0)])
    assert.throws(() => encode(bad), /^Error: encoding: /, String(bad));
  const read: [string, string][] = [
    ['f93e00', 'a float'], ['fb3ff8000000000000', 'a float'], ['f6', 'null'], ['f5', 'true'], ['f7', 'undefined'], ['c074323032362d31312d3237', 'a tag'],
    ['9f0102ff', 'an array of indefinite length'], ['bf0102ff', 'a map of indefinite length'], ['5f4101ff', 'bytes of indefinite length'], ['1c', 'a reserved head'],
    ['', 'nothing'], ['18', 'a head cut short'], ['1901', 'a head cut short'], ['4301', 'bytes cut short'], ['8201', 'an array cut short'], ['a101', 'a map cut short'],
    ['0000', 'bytes after the value'], ['5b0020000000000000', 'a length beyond 2^53'], ['62c328', 'text that is not UTF-8'],
  ];
  for (const [bytes, what] of read) assert.throws(() => decode(unhex(bytes)), Error, `${what} (${bytes})`);
});
