// The owner's box state (C15, #3685): a close's `reply` is kept as the agent's words, trimmed and cut to REPLY_MOST.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NOTES_KEPT, OwnerBox, REPLY_MOST, line } from './box.ts';

const sent = (box: OwnerBox, words: string, id: string) => {
  assert.ok(box.put('g1', words));
  assert.ok(box.text(JSON.stringify({ sent: { id } })));
  assert.ok(box.text(JSON.stringify({ mail: { id, state: 'picked' } })));
  return box.messages.at(-1)!;
};

test('C15: a close with a reply marks the message done and keeps the reply', () => {
  const box = new OwnerBox();
  const m = sent(box, 'how are you?', 'm1');
  assert.equal(m.state, 'thinking');
  assert.ok(box.text(JSON.stringify({ close: { id: 'm1', state: 'done', outcome: null, reply: '  Fine, at the harbour.  ' } })));
  assert.equal(m.state, 'done');
  assert.equal(m.reply, 'Fine, at the harbour.');
  assert.equal(line(m), 'done');
});

test('C15: a failed close keeps its reply; a close without one leaves none', () => {
  const box = new OwnerBox();
  const a = sent(box, 'fly to the moon', 'm1');
  const b = sent(box, 'wave', 'm2');
  box.text(JSON.stringify({ close: { id: 'm1', state: 'failed', outcome: 'refused', reply: 'I cannot fly.' } }));
  box.text(JSON.stringify({ close: { id: 'm2', state: 'done', outcome: 'ok' } }));
  assert.equal(a.state, 'failed');
  assert.equal(a.reply, 'I cannot fly.');
  assert.equal(b.state, 'done');
  assert.equal(b.reply ?? null, null);
});

test('C15: a blank or non-string reply is none; a long one is cut to REPLY_MOST characters', () => {
  const box = new OwnerBox();
  const a = sent(box, 'one', 'm1');
  const b = sent(box, 'two', 'm2');
  const c = sent(box, 'three', 'm3');
  box.text(JSON.stringify({ close: { id: 'm1', state: 'done', outcome: null, reply: '   ' } }));
  box.text(JSON.stringify({ close: { id: 'm2', state: 'done', outcome: null, reply: 42 } }));
  box.text(JSON.stringify({ close: { id: 'm3', state: 'done', outcome: null, reply: '😀'.repeat(REPLY_MOST + 5) } }));
  assert.equal(a.reply ?? null, null);
  assert.equal(b.reply ?? null, null);
  assert.equal([...c.reply!].length, REPLY_MOST);
});

test('#3781: an interim note is kept under its open message, which stays open until its close', () => {
  const box = new OwnerBox();
  const m = sent(box, 'tidy the shed', 'm1');
  const other = sent(box, 'and wave', 'm2');
  assert.ok(box.text(JSON.stringify({ note: { id: 'm1', reply: '  on my way to the shed  ' } })));
  assert.deepEqual([m.state, m.notes, other.notes ?? null], ['thinking', ['on my way to the shed'], null]);
  box.text(JSON.stringify({ doing: { seq: 4, verb: 'tidy', phase: 'accepted' } }));
  box.text(JSON.stringify({ note: { id: 'm1', reply: 'halfway' } }));
  box.text(JSON.stringify({ note: { id: 'm1', reply: '   ' } }));
  box.text(JSON.stringify({ note: { id: 'm9', reply: 'nobody' } }));
  assert.deepEqual(m.notes, ['on my way to the shed', 'halfway']);
  box.text(JSON.stringify({ close: { id: 'm1', state: 'done', outcome: 'ok' } }));
  box.text(JSON.stringify({ note: { id: 'm1', reply: 'after the close' } }));
  assert.deepEqual([m.state, m.notes], ['done', ['on my way to the shed', 'halfway']]);
  for (let k = 0; k < NOTES_KEPT + 2; k++) box.text(JSON.stringify({ note: { id: 'm2', reply: `n${k}` } }));
  assert.equal(other.notes!.length, NOTES_KEPT);
  assert.equal(other.notes!.at(-1), `n${NOTES_KEPT + 1}`);
});
