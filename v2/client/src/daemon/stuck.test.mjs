// A walk that got nowhere, as the world names it (stuck.mjs): N1's `goal-unreachable` named like C21's `walk.blocked`.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { STUCK, stuckOf, whyOf } from './stuck.mjs';

/** Bytes as the world writes them (T0's byte string: its length in the head), as hex. */
const hexOf = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from(b.length < 24 ? [0x40 + b.length] : [0x58, b.length]), b]).toString('hex'); };
/** The ladder's entry event as the daemon's entry JSON gives it (`wireEntry`: bytes as the hex of their encoding). */
const ended = (walker, name, why) => ({ name: 'souls:order-ended', fields: { 1: walker, 2: 'o-1', 3: hexOf(name), 4: hexOf(why) } });

test('the ladder\'s ended order is read for my own body, by name and what it waited for; nothing else is', () => {
  assert.deepEqual(stuckOf(ended('b-1', 'goal-unreachable', '12.4 m from its leg\'s end'), ['s-1', 'b-1']),
    { name: 'goal-unreachable', why: '12.4 m from its leg\'s end' });
  assert.equal(stuckOf(ended('b-2', 'goal-unreachable', 'x'), ['s-1', 'b-1']), null, 'another body\'s');
  assert.equal(stuckOf({ name: 'souls:reroute', fields: { 1: 'b-1' } }, ['b-1']), null, 'another rung');
  assert.ok(STUCK.has('goal-unreachable') && STUCK.has('walk.blocked'));
});

test('a refused walk\'s receipt says how far it got, for goal-unreachable as for walk.blocked; not for other refusals', () => {
  const sentAt = '2026-11-23T13:00:00.000Z', t = Date.parse(sentAt);
  const seen = [
    { name: 'goal-unreachable', why: 'an older walk', seenAt: t - 5000 },
    { name: 'goal-unreachable', why: '12.4 m from its leg\'s end', seenAt: t + 15_000 },
    { name: 'walk.blocked', why: 'a body in the doorway', seenAt: t + 3000 },
  ];
  const refused = (reason) => ({ sentAt, answers: [{ answer: 'accepted' }, { answer: 'refused', reason }] });
  assert.equal(whyOf(refused('goal-unreachable'), seen), '12.4 m from its leg\'s end', 'the newest since it was sent');
  assert.equal(whyOf(refused('walk.blocked'), seen), 'a body in the doorway');
  assert.equal(whyOf(refused('act.stopped'), seen), null, 'not a stuck walk');
  assert.equal(whyOf({ sentAt, answers: [{ answer: 'receipt' }] }, seen), null, 'done');
  assert.equal(whyOf(refused('goal-unreachable'), seen.slice(0, 1)), null, 'only an older walk\'s');
});
