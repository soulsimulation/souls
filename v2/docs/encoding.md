# The encoding profile

Engine v2 T0 (#2639), under contract T6 in [TRUNK.md](TRUNK.md): anything hashed is encoded deterministically, CBOR
with numbered fields. A kind's hash (T3), every effect (T6), every checkpoint (K5) and every golden fixture rest on one
value having exactly one byte form. This page fixes that form.

Code: `v2/crates/replica/src/encode.rs`. Vectors: `v2/crates/replica/fixtures/encoding/`. Checks: the native test
`v2/crates/replica/tests/encoding.rs` (in `cargo test`), and `v2/tools/encoding-vectors/run.mjs`, which runs replica's
WASM build in Node and the JavaScript library [cborg](https://github.com/rvagg/cborg) 6.2.1 over the same vectors
(the `encoding-vectors` step of `v2/tools/ci.sh`).

## The rules

The profile is CBOR ([RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html)) cut down until each value has one form.

1. **One item.** A value's bytes are exactly one CBOR data item, with nothing after it.
2. **Six types.** Unsigned integers (major type 0), negative integers (1), byte strings (2), text (3), arrays (4) and
   maps (5). No tags (6) and nothing of major type 7: no floats, no `null`, no `false`, `true` or `undefined`, no
   other simple value. A flag is the integer 0 or 1.
3. **Shortest form.** Every argument (an integer's value, a length, a map key) is written in the shortest head that
   holds it: 0 to 23 in the first byte, then 1, 2, 4 or 8 bytes.
4. **Definite lengths.** Every byte string, text, array and map states its length up front.
5. **Integers** run from −2^64 to 2^64 − 1, as CBOR has them. A JavaScript reader holds any integer beyond 2^53 as a
   `BigInt`.
6. **Text is an ASCII name:** letters, digits and `_ - . : / @`, possibly empty. Nothing else: no space, no control
   character, nothing beyond ASCII. Free text is stored by reference (contract T8), never inside hashed bytes.
7. **Maps are keyed by field number:** unsigned integers in strictly ascending order, so no key twice. With keys in
   their shortest form, ascending by number is the same order as RFC 8949's bytewise order (section 4.2.1) and its
   older length-first order (section 4.2.3).
8. **Nesting** is at most 32 arrays and maps deep. The encoder refuses a deeper value with `too-deep` rather than
   write bytes the decoder would refuse. Containment depth is unbounded (contract T2), so the node tree and
   checkpoints are encoded flat, never nested: nodes keyed by id, each naming its parent by id.
9. **Fields.** A required field is always written, even at its default. An optional field that is absent is left
   out; it is never written as a null or an empty value.
10. **Stored bytes are what a hash covers.** The decoder keeps the bytes it read beside the value; a hash is taken
    over stored bytes, never over a re-encoding.
11. **One encoder.** Only `replica` encodes or decodes, natively and in WASM. Lengths are written from a 64-bit type,
    since `usize` is 32 bits in WASM. The JavaScript library is used by the vector check alone, never by the client
    or the v2 page. The old page's workers (`apps/web/src/v2-engine`) read what the replica hands them and write its
    queries, never anything hashed: the stream worker reads with that library, and both write, and the history worker
    reads, with a small reader and writer of this profile (`source/profile.ts`), held to the same vectors.
12. **Vectors are fixed.** A vector file changes only in its own commit, with the reason.

## The vectors

Each file in `fixtures/encoding/` is two lines: the value in CBOR diagnostic notation (RFC 8949, section 8), then
` # ` and what it shows; and the value's bytes as hex. The native build encodes each value to these bytes and decodes
them back to the same value; the WASM build in Node and cborg each encode it to the same bytes.

| File | Value | What it shows | Bytes |
|---|---|---|---|
| 01-uint-0 | `0` | the smallest unsigned integer | `00` |
| 02-uint-23 | `23` | the largest integer held in the first byte | `17` |
| 03-uint-24 | `24` | the smallest integer that needs one more byte | `1818` |
| 04-uint-255 | `255` | the largest one-byte argument | `18ff` |
| 05-uint-256 | `256` | the smallest two-byte argument | `190100` |
| 06-uint-65535 | `65535` | the largest two-byte argument | `19ffff` |
| 07-uint-65536 | `65536` | the smallest four-byte argument | `1a00010000` |
| 08-uint-4294967295 | `4294967295` | the largest four-byte argument | `1affffffff` |
| 09-uint-4294967296 | `4294967296` | the smallest eight-byte argument | `1b0000000100000000` |
| 10-uint-2p53-plus-1 | `9007199254740993` | 2^53 + 1, the first integer a JavaScript number cannot hold | `1b0020000000000001` |
| 11-uint-max | `18446744073709551615` | 2^64 − 1, the largest unsigned integer | `1bffffffffffffffff` |
| 12-nint-1 | `-1` | the first negative integer | `20` |
| 13-nint-24 | `-24` | the last negative integer held in the first byte | `37` |
| 14-nint-25 | `-25` | the first negative integer that needs one more byte | `3818` |
| 15-nint-256 | `-256` | the last negative one-byte argument | `38ff` |
| 16-nint-257 | `-257` | the first negative two-byte argument | `390100` |
| 17-nint-65537 | `-65537` | the first negative four-byte argument | `3a00010000` |
| 18-nint-4294967297 | `-4294967297` | the first negative eight-byte argument | `3b0000000100000000` |
| 19-nint-min | `-18446744073709551616` | −2^64, the smallest integer | `3bffffffffffffffff` |
| 20-bytes-empty | `h''` | an empty byte string | `40` |
| 21-bytes-two | `h'00ff'` | a byte string of two bytes | `4200ff` |
| 22-bytes-24 | `h'abab…ab'` (24 bytes) | a byte string whose length needs one more byte | `5818` then `ab` × 24 |
| 23-text-empty | `""` | empty text | `60` |
| 24-text-one | `"a"` | a one-byte name | `6161` |
| 25-text-kind | `"souls:kettle@v1"` | a name shaped like a kind, with : and @ | `6f736f756c733a6b6574746c65407631` |
| 26-text-path | `"a_b-c.d/e"` | a name with _ - . and / | `69615f622d632e642f65` |
| 27-array-empty | `[]` | an empty array | `80` |
| 28-array-nested | `[1, [2, 3], h'', "x"]` | an array holding an array, bytes and text | `8401820203406178` |
| 29-array-24 | `[0, 0, …, 0]` (24 zeros) | an array whose length needs one more byte | `9818` then `00` × 24 |
| 30-map-empty | `{}` | an empty map | `a0` |
| 31-map-step0 | `{1: 0, 2: "a", 24: -1}` | the map worked by hand in Step 0: keys 1, 2 and 24 | `a30100026161181820` |
| 32-map-key-widths | `{256: 0, 23: 0, 24: 0, 0: 0}` | keys written out of order and across widths, encoded ascending | `a40000170018180019010000` |
| 33-map-nested | `{1: {1: 7, 2: [1]}, 2: {}}` | a map holding a map, which holds an array, and an empty map | `a201a2010702810102a0` |
| 34-map-required-default | `{1: 0, 2: ""}` | a record whose required fields 1 and 2 are at their defaults (0 and empty text): both written | `a201000260` |
| 35-map-optional-absent | `{1: 5, 3: 0}` | a record whose optional field 2 is absent: omitted, not written as null | `a201050300` |

## The refused forms

The decoder refuses every other input, each by name, with the offset of the byte at fault (`RefusalKind` in
`encode.rs`). The native test checks each name against the bytes shown.

| Name | Rule | Refused | Example |
|---|---|---|---|
| `truncated` | 1 | The input ends inside an item, or a length runs past the end | `18`, `6261`, `9affffffff00` |
| `trailing-bytes` | 1 | Bytes after the one item | `0000` |
| `tag` | 2 | Any tag | `c11a00000000`, `c240` |
| `float` | 2 | A float of any width | `f93c00`, `fa3f800000`, `fb3ff0000000000000` |
| `null` | 2 | `null` | `f6` |
| `simple` | 2 | `false`, `true`, `undefined`, any other simple value | `f4`, `f5`, `f7`, `f820` |
| `break` | 2 | A break byte | `ff` |
| `not-shortest` | 3 | An integer, length or key wider than it needs | `1817`, `1a0000ffff`, `3b00000000ffffffff`, `5800`, `a1180100` |
| `reserved-argument` | 3 | Additional information 28 to 30, or 31 on an integer or a tag (not well-formed CBOR) | `1c`, `3f` |
| `indefinite-length` | 4 | A byte string, text, array or map of indefinite length | `5f40ff`, `7fff`, `9fff`, `bfff` |
| `text-not-name` | 6 | A character outside the name characters | `6120`, `6100`, `62c3a9` |
| `map-key-not-uint` | 7 | A map key that is not an unsigned integer | `a12000`, `a1616100` |
| `map-keys-out-of-order` | 7 | A key smaller than the one before | `a202000100` |
| `map-key-duplicate` | 7 | A key equal to the one before | `a201000100` |
| `too-deep` | 8 | 33 arrays or maps nested (the encoder refuses such a value too) | `81` × 32 then `80` |

## What would quietly break this

Each of these would give one value two byte forms, or one byte form two values, without failing anything loudly.

- **Swapping the encoder for a library's defaults.** No CBOR library is deterministic by default: ciborium's canonical
  helpers sort length-first, cbor-x has no canonical mode, and minicbor and cbor4ii document no order. The vectors
  are the test; a new encoder passes them first.
- **A JavaScript number above 2^53.** It rounds without an error. Large integers are `BigInt` (vector 10).
- **A length cast through `usize` on one side.** `usize` is 32 bits in WASM; lengths go through `u64`.
- **Hashing a re-encoding.** If a later, wider profile accepts a form this one refuses, a re-encoding hides the
  difference; a hash covers the stored bytes (rule 10).
- **A lenient decoder.** Accepting a non-shortest or unordered form "and fixing it" makes two byte strings decode to
  one value.
- **Leaving out a required field at its default**, or writing an absent optional field as null or empty: two forms of
  one record (rule 9, vectors 34 and 35).
- **Text beyond ASCII.** Unicode has more than one byte form for the same letters (composed and decomposed); widening
  text needs a normalisation rule first.
- **Floats.** `-0.0`, NaN payloads and widths give one number several forms; the record uses fixed-point integers.
- **Text map keys.** Bytewise and length-first order disagree on them; keys are field numbers (rule 7).
- **Nesting the node tree by containment.** A tree more than 32 deep could not be written, and a lenient writer
  would store bytes no reader accepts. The tree and checkpoints are flat (rule 8).
- **Narrowing the profile later.** Fewer name characters or a lower nesting limit would refuse bytes already stored.
  Widening is safe: it changes no stored byte.
- **Editing a vector to fit new code.** A vector changes only in its own commit, with the reason (rule 12).
