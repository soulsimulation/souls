// A touch's intents (0.134 T1) and its offer note: what `together` sends, and what the other Soul's `wait` shows.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { offerNote } from '../converse/converse.mjs';
import { giveIntents } from '../give/give.mjs';
import { requestOf } from '../cli/souls.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activityPin } from '../carry/carry.mjs';
import { KINDS, OFFERER, activitiesIn, togetherIntents } from './together.mjs';

const id = (n) => `${'ab'.repeat(16)}-${n}`;

test('together offers a handshake, a hug or a high five to one body; accept and decline answer it', () => {
  for (const touch of ['handshake', 'hug', 'high-five', 'hold-hands', 'follow']) {
    assert.deepEqual(togetherIntents({ do: 'offer', touch, to: id(3) }, { place: id(1) }),
      [{ verb: 'activity:offer', target: id(1), params: { 1: KINDS[touch], 2: OFFERER, 3: [id(3)] } }]);
  }
  assert.deepEqual(togetherIntents({ do: 'accept', offer: id(9) }, { place: id(1) }), [{ verb: 'activity:accept', target: id(9) }]);
  assert.deepEqual(togetherIntents({ do: 'decline', offer: id(9) }, { place: id(1) }), [{ verb: 'activity:decline', target: id(9) }]);
  assert.equal(togetherIntents({ do: 'offer', touch: 'wrestle', to: id(3) }, { place: id(1) }).code, 'together-unknown');
  assert.equal(togetherIntents({ do: 'offer', touch: 'hug', to: id(3) }, { place: null }).code, 'together-no-place');
  assert.equal(togetherIntents({ do: 'accept' }, { place: id(1) }).code, 'together-names-an-offer');
});

test('#4700: together withdraw takes back an offer by its id or its word: the asker\'s leave of it', () => {
  assert.deepEqual(togetherIntents({ do: 'withdraw', offer: id(9) }, { place: id(1) }), [{ verb: 'activity:leave', target: id(9) }]);
  assert.equal(togetherIntents({ do: 'withdraw' }, { place: id(1) }).code, 'together-names-an-offer');
  assert.deepEqual(requestOf(['together', 'withdraw', 'hug']).req, { op: 'give', do: 'withdraw', offer: 'hug' });
  const { req } = requestOf(['together', 'withdraw', id(9)]);
  assert.deepEqual(giveIntents(req, { place: id(1) }), [{ verb: 'activity:leave', target: id(9) }]);
  assert.deepEqual(giveIntents({ do: 'withdraw', offer: id(8) }, { place: id(1) }), [{ verb: 'activity:leave', target: id(8) }], 'a give too');
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

test('a dance is offered to up to seven at once, from the command line too', () => {
  const to = [3, 4, 5].map(id);
  assert.deepEqual(togetherIntents({ do: 'offer', touch: 'dance', to }, { place: id(1) }),
    [{ verb: 'activity:offer', target: id(1), params: { 1: KINDS.dance, 2: OFFERER, 3: to } }]);
  assert.deepEqual(requestOf(['together', 'offer', 'dance', ...to]).req.to, to);
  assert.equal(togetherIntents({ do: 'offer', touch: 'dance', to: [3, 4, 5, 6, 7, 8, 9, 10].map(id) }, { place: id(1) }).code, 'together-usage');
  assert.equal(togetherIntents({ do: 'offer', touch: 'hug', to: [id(3), id(4)] }, { place: id(1) }).code, 'together-usage');
});

test('any activity the world serves is offered by its word, the offerer in its one-member role, to as many as it takes', () => {
  const read = (f) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../../content/kinds', f), 'utf8'));
  const jacks = read('calisthenics/group_jumping_jacks.json'), chess = read('games/chess_table.json');
  const kinds = { [jacks.kind]: jacks, [chess.kind]: chess, 'eden:rock': { kind: 'eden:rock' } };
  const list = activitiesIn(kinds);
  assert.deepEqual(list.map((a) => [a.word, a.role, a.most]), [['chess-table', 'eden:white', 1], ['group-jumping-jacks', 'eden:starter', 7]]);
  const to = [3, 4].map(id);
  assert.deepEqual(togetherIntents({ do: 'offer', touch: 'group-jumping-jacks', to }, { place: id(1), kinds }),
    [{ verb: 'activity:offer', target: id(1), params: { 1: activityPin(jacks.kind, jacks), 2: 'eden:starter', 3: to } }]);
  assert.equal(togetherIntents({ do: 'offer', touch: 'eden:group_jumping_jacks', to }, { place: id(1), kinds })[0].params[2], 'eden:starter', 'by its kind too');
  assert.equal(togetherIntents({ do: 'offer', touch: 'chess-table', to }, { place: id(1), kinds }).code, 'together-usage', 'chess takes one other');
  // its offer reaches the asked Soul as that activity, not as a conversation
  const ev = { name: 'souls:offer', fields: { 1: id(9), 2: activityPin(jacks.kind, jacks), 3: to, 4: 60_000_000, 5: id(2) } };
  assert.deepEqual(offerNote(ev, id(3)), { kind: 'together', what: 'offered', touch: 'group-jumping-jacks', offer: id(9), from: id(2) });
  assert.deepEqual(requestOf(['together', 'kinds']).req, { op: 'give', do: 'kinds' });
  assert.deepEqual(requestOf(['together', 'accept', 'group-jumping-jacks']).req, { op: 'give', do: 'accept', offer: 'group-jumping-jacks' });
});
