// R15b test proof: decode actual durable answers (worldd::answers::ANSWERED), never the actor-key bytes as an ID.
import assert from 'node:assert/strict';
import { decode, idText } from '../brief/copy.mjs';

/** Require one exact actor/sequence receipt and every referenced effect, with the same actor and intent cause. */
export function durableReceipt(parts, actorId, sequence) {
  const hits = [];
  for (const part of parts) for (const row of Array.isArray(part.get(3)) ? part.get(3) : []) {
    if (row.get(2) !== sequence) continue;
    const key = decode(row.get(1));
    if (key.get(1) !== 1 || idText(key.get(2)) !== actorId) continue;
    hits.push({ part, row, key });
  }
  assert.equal(hits.length, 1, 'one durable answer for the exact actor and sequence');
  const { part, row, key } = hits[0], answer = decode(row.get(4)).get(2);
  assert.deepEqual(answer.get(1), key, 'the actual Answer names the exact actor');
  assert.equal(answer.get(2), sequence, 'the actual Answer names the exact sequence');
  assert.equal(answer.get(3), 1, 'the actual Answer is a successful receipt');
  assert.deepEqual(answer.get(4), row.get(3), 'the receipt names the admitted intent');
  if (row.has(5)) {
    assert.deepEqual(row.get(5).get(1), key, 'the durable intent names the actor');
    assert.equal(row.get(5).get(5), sequence, 'the durable intent names the sequence');
  }
  const entries = answer.get(5), all = parts.flatMap((p) => p.get(2) ?? []);
  assert.ok(Array.isArray(entries) && entries.length > 0, 'the receipt references durable effects');
  const effects = entries.map((n) => {
    const found = all.filter((e) => e.get(1) === n);
    assert.equal(found.length, 1, 'every referenced entry exists exactly once');
    const effect = found[0];
    assert.equal(effect.get(3).get(1), 1, 'the referenced entry was caused by an intent');
    assert.deepEqual(effect.get(3).get(2), answer.get(4), 'the referenced entry has this exact intent cause');
    assert.deepEqual(effect.get(4), key, 'the referenced entry has this exact actor');
    return effect;
  });
  return { part, entries, effects };
}
