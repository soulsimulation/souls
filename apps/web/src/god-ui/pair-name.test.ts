import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { nameRefusedLine } from './pair-name.ts';

test('first day (28 Nov): a name another Soul of the world has says so, not "not kept"', () => {
  assert.equal(nameRefusedLine('name-taken'), 'That name is taken in this world; its agent can choose another.');
  assert.equal(nameRefusedLine('name'), 'That is not a name this world takes; its agent can choose another.');
  assert.equal(nameRefusedLine(null), 'The name was not kept; its agent can set one.', 'unreachable or another refusal');
});
