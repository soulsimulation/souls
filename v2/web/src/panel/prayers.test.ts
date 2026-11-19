// node --test v2/web/src/panel/prayers.test.ts: the panel's prayers (G11, #3335). It lists the waiting ones and answers
// one on the creator's socket, as the creator's agent does, and refuses an answer over 4,000 characters by name before
// anything is sent. The whole path to the Soul is v2/client/src/daemon/pray.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_MOST, EVERY_MS, Prayers, prayerRefusal, type Prayer } from './prayers.ts';

const waiting: Prayer = { id: 'p_000000000001', soul: `soul-${'4d'.repeat(16)}-2`, text: 'let it rain', at: 1, state: 'waiting', answer: null };

/** A gateway stand-in: what the panel sent, and the directory's replies by `n`. */
function gateway(reply: (kind: string, body: Record<string, unknown>) => object) {
  const sent: Record<string, Record<string, unknown>>[] = [];
  const p: Prayers = new Prayers({
    send(t) {
      const f = JSON.parse(t) as Record<string, Record<string, unknown>>;
      sent.push(f);
      const [kind, body] = Object.entries(f)[0]!;
      queueMicrotask(() => p.text(JSON.stringify({ reply: { n: body.n, ...reply(kind, body) } })));
    },
  });
  return { p, sent };
}

test('the panel lists the waiting prayers and answers one on the creator\'s socket', async () => {
  let answered = false;
  const { p, sent } = gateway((kind, body) => {
    if (kind === 'prayers') return { ok: true, prayers: answered ? [] : [waiting] };
    answered = body.id === waiting.id;
    return { ok: true, prayer: { ...waiting, state: 'answered', answer: body.text } };
  });
  let changes = 0;
  p.onChange = () => changes++;
  await p.refresh();
  assert.deepEqual(p.waiting.map((w) => w.text), ['let it rain']);
  assert.equal(await p.answer(waiting.id, '  it will  '), null);
  assert.deepEqual(sent.map((f) => Object.keys(f)[0]), ['prayers', 'answer', 'prayers']);
  assert.deepEqual(sent[1]!.answer, { n: 2, id: waiting.id, text: 'it will' });
  assert.deepEqual(p.waiting, [], 'answered: no longer waiting');
  assert.equal(changes, 2);
  // A text frame that is not a reply to the panel is left to others.
  assert.equal(p.text('{"mail":{"id":"m_1"}}'), false);
  assert.equal(p.text('not json'), false);
});

test('an answer over 4,000 characters is refused by name, and a refusal from the world is shown by name', async () => {
  const { p, sent } = gateway(() => ({ ok: false, refused: 'prayer.not-found' }));
  assert.equal(await p.answer(waiting.id, 'y'.repeat(ANSWER_MOST + 1)), 'answer.too-long');
  assert.equal(sent.length, 0, 'nothing sent');
  assert.equal(await p.answer(waiting.id, ''), 'answer.empty');
  assert.equal(await p.answer(waiting.id, 'hello'), 'prayer.not-found');
  assert.match(prayerRefusal('answer.too-long'), /at most 4,000 characters/);
  assert.match(prayerRefusal('something.else'), /something\.else/);
});


test('closing a creator socket stops polling, settles pending answers, and refuses later sends', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { p, sent } = gateway(() => ({ ok: true, prayers: [] }));
  p.start();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(EVERY_MS);
  await Promise.resolve();
  assert.equal(sent.length, 2, 'open socket polls');
  p.stop();
  t.mock.timers.tick(EVERY_MS * 2);
  await p.refresh();
  assert.equal(sent.length, 2, 'closed socket never sends again');
  let sends = 0;
  const closed = new Prayers({ send() { sends++; } });
  const pending = closed.answer(waiting.id, 'yes');
  closed.stop();
  assert.equal(await pending, 'prayer.unanswered');
  assert.equal(await closed.answer(waiting.id, 'again'), 'prayer.unanswered');
  assert.equal(sends, 1, 'pending answer settled without retry');
  const throws = new Prayers({ send() { throw new Error('socket closed'); } });
  assert.equal(await throws.answer(waiting.id, 'yes'), 'prayer.unanswered', 'socket error becomes a named refusal');
  throws.stop();
});
