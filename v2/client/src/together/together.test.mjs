// A touch's intents (0.134 T1) and its offer note: what `together` sends, and what the other Soul's `wait` shows.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { offerNote } from '../converse/converse.mjs';
import { giveIntents } from '../give/give.mjs';
import { requestOf } from '../cli/souls.mjs';
import { KINDS, OFFERER, togetherIntents } from './together.mjs';

const id = (n) => `${'ab'.repeat(16)}-${n}`;

test('together offers a handshake, a hug or a high five to one body; accept and decline answer it', () => {
  for (const touch of ['handshake', 'hug', 'high-five', 'hold-hands']) {
    assert.deepEqual(togetherIntents({ do: 'offer', touch, to: id(3) }, { place: id(1) }),
      [{ verb: 'activity:offer', target: id(1), params: { 1: KINDS[touch], 2: OFFERER, 3: [id(3)] } }]);
  }
  assert.deepEqual(togetherIntents({ do: 'accept', offer: id(9) }, { place: id(1) }), [{ verb: 'activity:accept', target: id(9) }]);
  assert.deepEqual(togetherIntents({ do: 'decline', offer: id(9) }, { place: id(1) }), [{ verb: 'activity:decline', target: id(9) }]);
  assert.equal(togetherIntents({ do: 'offer', touch: 'wrestle', to: id(3) }, { place: id(1) }).code, 'together-usage');
  assert.equal(togetherIntents({ do: 'offer', touch: 'hug', to: id(3) }, { place: null }).code, 'together-no-place');
  assert.equal(togetherIntents({ do: 'accept' }, { place: id(1) }).code, 'together-names-an-offer');
});

test('the CLI sends a touch as a give, and the give handler builds the touch', () => {
  const { req } = requestOf(['together', 'offer', 'hug', id(3)]);
  assert.equal(req.op, 'give');
  assert.deepEqual(giveIntents(req, { place: id(1) }), togetherIntents(req, { place: id(1) }));
  assert.deepEqual(requestOf(['together', 'accept', id(9)]).req, { op: 'give', do: 'accept', offer: id(9) });
});

test('an offer of a touch reaches the other as a touch, not a conversation', () => {
  const ev = { name: 'souls:offer', fields: { 1: id(9), 2: KINDS['high-five'], 3: [id(3)], 4: 60_000_000, 5: id(2) } };
  assert.deepEqual(offerNote(ev, id(3)), { kind: 'together', what: 'offered', touch: 'high-five', offer: id(9), from: id(2) });
  assert.equal(offerNote(ev, id(2)), null, 'its own offer');
});
