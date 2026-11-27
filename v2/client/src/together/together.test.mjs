// A touch's intents (0.134 T1) and its offer note: what `together` sends, and what the other Soul's `wait` shows.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { offerNote, offerPlace } from '../converse/converse.mjs';
import { giveIntents } from '../give/give.mjs';
import { requestOf } from '../cli/souls.mjs';
import { activitiesIn, activityNamed, kindsListed, touchOf, togetherIntents } from './together.mjs';

const id = (n) => `${'ab'.repeat(16)}-${n}`;
const pin = (k) => `${k}_activity@1220${'0f'.repeat(32)}`;
// The world's activities as it serves them (`worldd serve`'s `activities.json`, fetched with the entries).
const one = (kind, more = {}) => ({ kind, name: pin(kind), word: kind.replace(/^.*:/, '').replace(/_/g, '-'), card: `A ${kind}.`, roles: [], asks: 1, offerer: 'eden:one', near_m: 0.6, ...more });
const served = { format: 'souls-activities/1', activities: [
  one('eden:hug'), one('eden:handshake'), one('eden:high_five'), one('eden:hold_hands'), one('eden:follow', { near_m: undefined }),
  one('eden:dance_together', { asks: 7, near_m: undefined }), one('eden:group_jumping_jacks', { asks: 7, offerer: 'eden:starter' }),
  one('eden:harvest_together', { at: 'eden:harvest_together' }), one('eden:chess_table', { offerer: undefined, at: 'eden:chess_table' }),
  one('mars:carry', { offerer: 'mars:front' }),
] };
const ctx = { place: id(1), served, thingAt: (k) => (k === 'eden:harvest_together' ? id(5) : null) };

test('together offers a handshake, a hug or a high five to one body by the served name; accept and decline answer it', () => {
  for (const touch of ['handshake', 'hug', 'high-five', 'hold-hands', 'follow']) {
    const kind = `eden:${touch.replace(/-/g, '_')}`;
    assert.deepEqual(togetherIntents({ do: 'offer', touch, to: id(3) }, ctx),
      [{ verb: 'activity:offer', target: id(1), params: { 1: pin(kind), 2: 'eden:one', 3: [id(3)] } }]);
  }
  assert.deepEqual(togetherIntents({ do: 'accept', offer: id(9) }, ctx), [{ verb: 'activity:accept', target: id(9) }]);
  assert.deepEqual(togetherIntents({ do: 'decline', offer: id(9) }, ctx), [{ verb: 'activity:decline', target: id(9) }]);
  assert.equal(togetherIntents({ do: 'offer', touch: 'wrestle', to: id(3) }, ctx).code, 'together-unknown');
  assert.equal(togetherIntents({ do: 'offer', touch: 'hug', to: id(3) }, { ...ctx, place: null }).code, 'together-no-place');
  assert.equal(togetherIntents({ do: 'offer', touch: 'hug', to: id(3) }, { place: id(1) }).code, 'together-not-served', 'a world serving no list');
  assert.equal(togetherIntents({ do: 'accept' }, ctx).code, 'together-names-an-offer');
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
  assert.deepEqual(giveIntents(req, ctx), togetherIntents(req, ctx));
  assert.deepEqual(requestOf(['together', 'accept', id(9)]).req, { op: 'give', do: 'accept', offer: id(9) });
});

test('an offer of a touch reaches the other as a touch, not a conversation', () => {
  const ev = { name: 'souls:offer', fields: { 1: id(9), 2: pin('eden:high_five'), 3: [id(3)], 4: 60_000_000, 5: id(2) } };
  assert.deepEqual(offerNote(ev, id(3)), { kind: 'together', what: 'offered', touch: 'high-five', offer: id(9), from: id(2) });
  assert.equal(offerNote(ev, id(2)), null, 'its own offer');
  assert.equal(touchOf('souls:conversation@1220ab'), null);
});

test('a dance is offered to up to seven at once, by its word or the one word it starts', () => {
  const to = [3, 4, 5].map(id);
  assert.deepEqual(togetherIntents({ do: 'offer', touch: 'dance', to }, ctx),
    [{ verb: 'activity:offer', target: id(1), params: { 1: pin('eden:dance_together'), 2: 'eden:one', 3: to } }]);
  assert.deepEqual(requestOf(['together', 'offer', 'dance', ...to]).req.to, to);
  assert.equal(togetherIntents({ do: 'offer', touch: 'dance', to: [3, 4, 5, 6, 7, 8, 9, 10].map(id) }, ctx).code, 'together-usage');
  assert.equal(togetherIntents({ do: 'offer', touch: 'hug', to: [id(3), id(4)] }, ctx).code, 'together-usage');
  assert.equal(activityNamed(activitiesIn(served), 'harvest')?.word, 'harvest-together');
  assert.equal(activityNamed(activitiesIn(served), 'jumping')?.word, 'group-jumping-jacks', 'a whole word it holds');
  assert.equal(activityNamed(activitiesIn(served), 'jump'), null, 'never part of a word');
});

test('any activity the world serves is offered by its word, the offerer in the role it names; one played at a thing at the nearest', () => {
  const list = activitiesIn(served);
  // chess has no offerer (proposed at its table), the crew is `carry offer`'s
  assert.deepEqual(list.map((a) => a.word), ['dance-together', 'follow', 'group-jumping-jacks', 'handshake', 'harvest-together', 'high-five', 'hold-hands', 'hug']);
  assert.deepEqual(list.find((a) => a.word === 'hug'), { word: 'hug', kind: 'eden:hug', pin: pin('eden:hug'), role: 'eden:one', most: 1, card: 'A eden:hug.', near_m: 0.6, at: null });
  const to = [3, 4].map(id);
  assert.deepEqual(togetherIntents({ do: 'offer', touch: 'group-jumping-jacks', to }, ctx),
    [{ verb: 'activity:offer', target: id(1), params: { 1: pin('eden:group_jumping_jacks'), 2: 'eden:starter', 3: to } }]);
  assert.equal(togetherIntents({ do: 'offer', touch: 'eden:group_jumping_jacks', to }, ctx)[0].params[2], 'eden:starter', 'by its kind too');
  // a harvest is offered at the basket, not where this Soul stands; with no basket in the copy it is refused, nothing sent
  assert.deepEqual(togetherIntents({ do: 'offer', touch: 'harvest', to: id(3) }, ctx),
    [{ verb: 'activity:offer', target: id(5), params: { 1: pin('eden:harvest_together'), 2: 'eden:one', 3: [id(3)] } }]);
  const none = togetherIntents({ do: 'offer', touch: 'harvest', to: id(3) }, { ...ctx, thingAt: () => null });
  assert.equal(none.code, 'together.at-its-thing');
  assert.match(none.detail, /harvest together/);
  assert.equal(togetherIntents({ do: 'offer', touch: 'chess-table', to: id(3) }, ctx).code, 'together-unknown', 'chess is proposed at its table');
  const ev = { name: 'souls:offer', fields: { 1: id(9), 2: pin('eden:group_jumping_jacks'), 3: to, 4: 60_000_000, 5: id(2) } };
  assert.deepEqual(offerNote(ev, id(3)), { kind: 'together', what: 'offered', touch: 'group-jumping-jacks', offer: id(9), from: id(2) });
  assert.deepEqual(requestOf(['together', 'kinds']).req, { op: 'give', do: 'kinds' });
  assert.deepEqual(requestOf(['together', 'accept', 'group-jumping-jacks']).req, { op: 'give', do: 'accept', offer: 'group-jumping-jacks' });
});

test('together leave ends this Soul\'s part in an activity, by its id or its word', () => {
  assert.deepEqual(togetherIntents({ do: 'leave', offer: id(9) }, ctx), [{ verb: 'activity:leave', target: id(9) }]);
  assert.deepEqual(requestOf(['together', 'leave', 'dance']).req, { op: 'give', do: 'leave', offer: 'dance' });
  const { req } = requestOf(['together', 'leave', id(9)]);
  assert.deepEqual(giveIntents(req, ctx), [{ verb: 'activity:leave', target: id(9) }]);
  assert.equal(togetherIntents({ do: 'leave' }, ctx).code, 'together-names-an-offer');
});

// Trial of 25 Nov: `together offer yoga | jumping-jacks | chorus | applause | story-circle` named nothing, though the
// world serves `group-yoga`, `group-jumping-jacks`, `group-chorus`, `round-of-applause`, `oral-story-circle`.
test('together offer takes an activity by the one word it holds whole; a word two hold names neither', () => {
  const more = { format: 'souls-activities/1', activities: [...served.activities,
    one('eden:group_yoga', { asks: 7, offerer: 'eden:starter' }), one('eden:group_chorus', { asks: 7, offerer: 'eden:starter' }),
    one('eden:round_of_applause', { asks: 7 }), one('eden:oral_story_circle', { asks: 7, offerer: 'eden:teller' }),
    one('eden:stargaze_together', { asks: 7, offerer: 'eden:starter' }), one('eden:bow_to_each_other'),
    one('eden:wave_to_each_other'), one('eden:wave_together', { asks: 7 })] };
  const list = activitiesIn(more);
  for (const [word, kind] of [['yoga', 'eden:group_yoga'], ['jumping-jacks', 'eden:group_jumping_jacks'], ['jumping_jacks', 'eden:group_jumping_jacks'],
    ['chorus', 'eden:group_chorus'], ['applause', 'eden:round_of_applause'], ['story-circle', 'eden:oral_story_circle'],
    ['stargaze', 'eden:stargaze_together'], ['bow', 'eden:bow_to_each_other'], ['dance', 'eden:dance_together'], ['hug', 'eden:hug']]) {
    assert.equal(activityNamed(list, word)?.kind, kind, word);
  }
  assert.equal(activityNamed(list, 'wave'), null, 'wave-to-each-other or wave-together: neither');
  assert.equal(activityNamed(list, 'together'), null, 'a word many hold names none');
  assert.deepEqual(togetherIntents({ do: 'offer', touch: 'yoga', to: [id(3), id(4)] }, { ...ctx, served: more }),
    [{ verb: 'activity:offer', target: id(1), params: { 1: pin('eden:group_yoga'), 2: 'eden:starter', 3: [id(3), id(4)] } }]);
});

test('together kinds lists every activity the world serves, with how the ones it does not offer are played', () => {
  const rows = kindsListed(served);
  assert.deepEqual(rows.map((r) => r.word), served.activities.map((a) => a.word).sort());
  assert.match(rows.find((r) => r.word === 'carry').how, /carry offer/);
  assert.match(rows.find((r) => r.word === 'chess-table').how, /find chess table/);
  assert.deepEqual(rows.find((r) => r.word === 'hug'), { word: 'hug', card: 'A eden:hug.', asks: 1, near: 'within 0.6 m', where: 'anywhere' });
});

// Trial of 25 Nov: `converse start` from a bench put the conversation under the bench, refused `child-not-admitted`.
test('an offer goes on the open ground, never under the seat this Soul sits on', () => {
  const me = id(2), ground = id(1), bench = id(7);
  const rows = new Map([[ground, { id: ground, kind: 'eden:ground@1220aa' }], [bench, { id: bench, kind: 'eden:bench@1220bb', parent: ground }],
    [id(8), { id: id(8), kind: 'souls:body', soul: me, parent: bench }]]);
  assert.equal(offerPlace(rows, me), ground);
  rows.delete(ground);
  assert.equal(offerPlace(rows, me), bench, 'with no ground in the copy, where it stands');
  assert.equal(offerPlace(new Map(), me), null);
});
