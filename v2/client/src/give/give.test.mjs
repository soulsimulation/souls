// The give's intents (0.133 R4) and its offer note: what `give` sends, and what the taker's `wait` shows.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { offerNote } from '../converse/converse.mjs';
import { GIVER, KIND, giveIntents } from './give.mjs';

const id = (n) => `${'ab'.repeat(16)}-${n}`;

test('give offers a held thing to one body; accept and decline answer the offer', () => {
  assert.deepEqual(giveIntents({ do: 'offer', thing: id(7), to: id(3) }, { place: id(1) }),
    [{ verb: 'activity:offer', target: id(1), params: { 1: KIND, 2: GIVER, 3: [id(3)], 4: id(7) } }]);
  assert.deepEqual(giveIntents({ do: 'accept', offer: id(9) }, { place: id(1) }), [{ verb: 'activity:accept', target: id(9) }]);
  assert.deepEqual(giveIntents({ do: 'decline', offer: id(9) }, { place: id(1) }), [{ verb: 'activity:decline', target: id(9) }]);
  assert.equal(giveIntents({ do: 'offer', thing: id(7) }, { place: id(1) }).code, 'give-usage');
  assert.equal(giveIntents({ do: 'offer', thing: id(7), to: id(3) }, { place: null }).code, 'give-no-place');
  assert.equal(giveIntents({ do: 'accept' }, { place: id(1) }).code, 'give-names-an-offer');
});

test('an offer that names a thing reaches the taker as a give, not a conversation', () => {
  const ev = { name: 'souls:offer', fields: { 1: id(9), 2: KIND, 3: [id(3)], 4: 30_000_000, 5: id(2), 6: id(7) } };
  assert.deepEqual(offerNote(ev, id(3)), { kind: 'give', what: 'offered', offer: id(9), thing: id(7), from: id(2) });
  assert.equal(offerNote(ev, id(2)), null, 'its own offer');
});
