// The pure-JS SHA-256 every def is hashed with gives the same digest as node:crypto, for every length round the block
// and padding edges, for text with characters of every UTF-8 width, and for a text as long as the core library's.
//   node --test packages/world-compiler/src/hash.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from './hash.ts';

const reference = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex');

test('every length from 0 to 300 bytes, and the text form of each', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 131 + 7) & 0xff);
  for (let n = 0; n <= 300; n++) {
    assert.equal(sha256Hex(bytes.subarray(0, n)), reference(bytes.subarray(0, n)), `${n} bytes`);
    const text = 'abcdefghij'.repeat(31).slice(0, n);
    assert.equal(sha256Hex(text), reference(text), `${n} characters`);
  }
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('text with one-, two-, three- and four-byte characters, and a long text', () => {
  for (const s of ['é', 'ü-ß', '€ and 日本', '🙂 a Soul', 'mixé€🙂'.repeat(40)]) assert.equal(sha256Hex(s), reference(s), s.slice(0, 12));
  const long = JSON.stringify(Array.from({ length: 40_000 }, (_, i) => ({ i, name: `def-${i}`, at: [i / 3, -i, 0.5] })));
  assert.ok(long.length > 2_000_000);
  assert.equal(sha256Hex(long), reference(long));
});
