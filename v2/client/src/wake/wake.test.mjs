// Wake rules and the owner's budget (Engine v2 R13, #2753), on a fake clock. The daemon's side, with the mailbox,
// the gateway and a world, is mail.test.mjs.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { wakeRequest } from '../cli/wake.mjs';
import { BUDGETS, HELD_MS, QUEUE_MOST, Wakes } from './wake.mjs';

const ME = 's_me', ADA = 's_ada';
const T0 = Date.parse('2026-11-19T10:00:00Z'), MIN = 60_000, HOUR = 60 * MIN;
const said = (from, sequence) => ({ name: 'eden:say', fields: { 1: 'hello' }, actor: from, toMe: true, sequence });
const spokeToMe = { when: { event: 'eden:say', toMe: true }, why: 'someone spoke to you' };

test('a rule matches R9 events and queues a wake; another Soul\'s event is marked untrusted; its own never matches', () => {
  const w = new Wakes(ME);
  w.add(spokeToMe, T0);
  assert.equal(w.onEvent(said(ME, 1), T0), false, 'an event this Soul caused');
  assert.equal(w.onEvent({ ...said(ADA, 2), toMe: false }, T0), false);
  assert.equal(w.onEvent(said(ADA, 3), T0), true);
  assert.deepEqual(w.deliver(T0), [{ rule: 'w1', why: 'someone spoke to you', count: 1, at: T0, untrusted: true }]);
  for (const [bad, code] of [[{ when: { event: 'eden:say' }, send: {} }, 'wake-unknown-key'], [{ when: {} }, 'when-event-not-a-name'],
    [{ when: { event: 'eden:say' }, why: 'two\nlines' }, 'wake-why-not-a-line'], [{ when: { event: 'eden:say' }, expires: 0 }, 'expires-not-a-count']]) {
    assert.throws(() => w.add(bad, T0), { code });
  }
  const e = new Wakes(ME);
  e.add({ ...spokeToMe, expires: 10 }, T0);
  assert.equal(e.onEvent(said(ADA, 1), T0 + 10_000), false, 'an expired rule is gone');
});

test('A2: wakes in any hour never pass the owner\'s budget, with a reader always open and an event every 10 s', () => {
  for (const [name, most] of [['quiet', 4], ['normal', 12], ['lively', 60], [3, 3]]) {
    const w = new Wakes(ME);
    w.add(spokeToMe, T0);
    w.add({ when: { event: 'eden:wave' } }, T0);
    w.op({ do: 'budget', hour: name }, T0);
    const handed = []; // when each delivery was made
    for (let t = T0; t < T0 + 5 * HOUR; t += 10_000) {
      w.onEvent(said(ADA, t), t);
      w.onEvent({ name: 'eden:wave', actor: ADA, toMe: false }, t);
      // The reader takes what it is handed, and the model's turn confirms it half the time; the rest are held and
      // come back after 10 minutes, and are charged again when handed again.
      if (w.deliver(t).length) { handed.push(t); if (handed.length % 2) w.confirm(); }
    }
    for (const t of handed) {
      const inHour = handed.filter((u) => u >= t && u < t + HOUR).length;
      assert.ok(inHour <= most, `${name}: ${inHour} deliveries in the hour from ${new Date(t).toISOString()}`);
    }
    assert.ok(handed.length >= most * 4, `${name}: the budget is used, ${handed.length} in 5 hours`);
    assert.equal(w.view(T0 + 5 * HOUR).budget.perHour, most);
  }
  // A day cap holds beside the hour's; unlimited has none.
  const d = new Wakes(ME);
  d.add(spokeToMe, T0);
  d.op({ do: 'budget', hour: 'lively', day: 5 }, T0);
  let n = 0;
  for (let t = T0; t < T0 + 3 * HOUR; t += MIN) { d.onEvent(said(ADA, t), t); if (d.deliver(t).length) { n++; d.confirm(); } }
  assert.equal(n, 5);
  assert.equal(BUDGETS.unlimited, null);
  assert.throws(() => d.op({ do: 'budget', hour: 'loud' }, T0), { code: 'budget-not-a-budget' });
});

test('A2: a delivery is charged once, when handed, and never refunded', () => {
  const w = new Wakes(ME);
  w.add(spokeToMe, T0);
  w.op({ do: 'budget', hour: 2 }, T0);
  w.onEvent(said(ADA, 1), T0);
  assert.equal(w.deliver(T0).length, 1);
  assert.equal(w.view(T0).budget.deliveredLastHour, 1);
  // Never confirmed: back in the queue after 10 minutes, handed again and charged again; then the budget is spent.
  assert.equal(w.deliver(T0 + HELD_MS - 1).length, 0, 'held, not yet queued again');
  assert.equal(w.deliver(T0 + HELD_MS).length, 1);
  assert.equal(w.view(T0 + HELD_MS).budget.deliveredLastHour, 2);
  w.onEvent(said(ADA, 2), T0 + HELD_MS + 1);
  assert.equal(w.deliver(T0 + HELD_MS + 1).length, 0, 'over the budget: it waits');
  assert.equal(w.nextFree(T0 + HELD_MS + 1), T0 + HOUR, 'until the first delivery is an hour old');
  assert.equal(w.deliver(T0 + HOUR).length, 1);
});

test('A3: with no reader, wakes merge into one entry per rule and wait, then go as one delivery', () => {
  const w = new Wakes(ME);
  w.add(spokeToMe, T0);
  w.add({ when: { event: 'eden:wave' } }, T0);
  for (let k = 0; k < 30; k++) w.onEvent(said(ADA, k), T0 + k * MIN);
  w.onEvent({ name: 'eden:wave', actor: null, toMe: false }, T0 + 31 * MIN);
  const v = w.view(T0 + 32 * MIN);
  assert.deepEqual(v.queued.map((q) => [q.rule, q.count]), [['w1', 30], ['w2', 1]]);
  assert.equal(v.budget.deliveredLastHour, 0, 'nothing is charged while no reader takes it');
  const handed = w.deliver(T0 + 32 * MIN);
  assert.deepEqual(handed.map((q) => [q.rule, q.count, q.at]), [['w1', 30, T0 + 29 * MIN], ['w2', 1, T0 + 31 * MIN]]);
  assert.equal(w.view(T0 + 32 * MIN).budget.deliveredLastHour, 1);
  // The queue is bounded per rule, so a rule firing for ever is one entry; and at most QUEUE_MOST rules wait.
  const many = new Wakes(ME);
  for (let k = 0; k < QUEUE_MOST + 5; k++) many.add({ when: { event: `eden:e${k}` } }, T0);
  for (let k = 0; k < QUEUE_MOST + 5; k++) many.onEvent({ name: `eden:e${k}`, actor: null }, T0);
  assert.equal(many.view(T0).queued.length, QUEUE_MOST);
});

test('the wake command\'s requests', () => {
  assert.deepEqual(wakeRequest([]), { op: 'wake', do: 'list' });
  assert.deepEqual(wakeRequest(['remove', 'w2']), { op: 'wake', do: 'remove', id: 'w2' });
  assert.deepEqual(wakeRequest(['add', '{"when":{"event":"eden:say"}}']), { op: 'wake', do: 'add', rule: { when: { event: 'eden:say' } } });
  assert.deepEqual(wakeRequest(['budget', 'quiet']), { op: 'wake', do: 'budget', hour: 'quiet' });
  assert.deepEqual(wakeRequest(['budget', '20', '--day', '100']), { op: 'wake', do: 'budget', hour: 20, day: 100 });
  assert.throws(() => wakeRequest(['add', '{nope']), /JSON/);
  assert.throws(() => wakeRequest(['budget']), /usage/);
});
