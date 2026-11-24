// 0.133 Q1: the live seat's measurement (live.mjs, onboard.mjs), from what an agent ran and what the client answered.
// No world and no model.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { commandsFromStream, intentsOf, refusalRate, splitWords, outcomeOf } from './live.mjs';
import { classify, codeIn, ONE_LINE, placeThings } from './onboard.mjs';

test("an agent's client calls are read from its Bash calls, quotes and all, and each world intent's end and cause", () => {
  assert.deepEqual(splitWords(`say --to Moss "hello there" 2>&1`), ['say', '--to', 'Moss', 'hello there']);
  assert.deepEqual(splitWords(`ack m_1 'on my way' | head`), ['ack', 'm_1', 'on my way']);
  const calls = [
    { name: 'Bash', cmd: 'cd soul && node eden.mjs act ab-1 --wait', result: '{"ok":true,"phase":"done"}' },
    { name: 'Bash', cmd: 'node eden.mjs find bench', result: '{"ok":true,"found":[]}' },
    { name: 'Bash', cmd: 'node eden.mjs act wave --wait', result: '{"ok":false,"code":"refused","detail":"intent.text-not-a-name: wave"}' },
    { name: 'Bash', cmd: 'node eden.mjs act sit:ab-2 --for m_1 --wait', result: '{"ok":false,"code":"mail-not-found"}' },
    { name: 'Bash', cmd: 'node eden.mjs say "hi"', result: '{"ok":true,"sent":true}' },
    { name: 'Read', cmd: 'skill.md', result: '' },
  ];
  const intents = intentsOf(commandsFromStream(calls));
  assert.deepEqual(intents.map((i) => [i.words[0], i.end, i.cause]), [['act', 'done', null], ['act', 'refused', 'intent.text-not-a-name'], ['act', 'refused', 'mail-not-found'], ['say', 'sent', null]]);
  assert.deepEqual(outcomeOf({ ok: false, phase: 'refused', receipt: {}, code: 'spot-none-near' }), { end: 'refused', cause: 'spot-none-near' });
  const r = refusalRate(intents);
  assert.deepEqual([r.intents, r.refused, r.per1000], [4, 2, 500]);
  assert.deepEqual(r.causes.map((c) => c.cause).sort(), ['intent.text-not-a-name', 'mail-not-found']);
});

test('an ask is one call, a retry, a refusal it could not act on, or no intent; the pairing code is read from a tool result', () => {
  assert.equal(classify([]), 'no-intent');
  assert.equal(classify([{ end: 'done' }, { end: 'sent' }]), 'one-call');
  assert.equal(classify([{ end: 'refused' }, { end: 'done' }]), 'retry');
  assert.equal(classify([{ end: 'done' }, { end: 'refused' }]), 'refused');
  const stream = [{ type: 'user', message: { content: [{ type: 'tool_result', content: '{"ok":true,"step":"approve","link":"x","code":"DQVJ-XNVN"}' }] } }];
  assert.equal(codeIn(stream), 'DQVJ-XNVN');
  assert.equal(codeIn([]), null);
  assert.equal(ONE_LINE('http://w/', 'Hello Hamlet'), 'Read the instructions at http://w/instructions.md to create a new soul in the world Hello Hamlet.');
  const f = placeThings({ kinds: [], things: [] }, [{ kind: 'eden:apple', ref: 'q1-apple@1', name: 'a red apple', at: [3, 2] }, { kind: 'eden:apple', ref: 'q1-apple@1', name: 'a green apple', at: [1, 1] }]);
  assert.equal(f.kinds.length, 1);
  assert.deepEqual(f.things.map((t) => [t.name, t.pose]), [['a red apple', [3000, 0, 2000, 0]], ['a green apple', [1000, 0, 1000, 0]]]);
});
