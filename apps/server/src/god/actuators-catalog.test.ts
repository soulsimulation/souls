// #1751: a def's acts as the soul catalog publishes them, the state it is in by default and when changed, and a hand act
// taken by id from far away (the act's own walk takes the body there; it is no longer refused as out of sight).
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogActs, kindActions, stateDefaults, stateDiff, STATE_TEXT_MAX } from './actuators.ts';

const lamp = { name: 'core-desk-lamp', version: 1, tags: ['hand-operated'], components: {}, state: { on: { type: 'boolean', default: true } },
  actions: [{ name: 'switch-on', label: 'Switch on', roles: 'anyone', reach: 'touch', params: {}, when: [{ field: 'on', is: false }], then: [{ op: 'set', field: 'on', value: true }] },
    { name: 'switch-off', label: 'Switch off', roles: 'anyone', reach: 'touch', params: {}, when: [{ field: 'on', is: true }], then: [{ op: 'set', field: 'on', value: false }] }] } as never;
const board = { name: 'core-chalkboard', version: 1, tags: ['hand-writable'], components: {}, state: { text: { type: 'string', default: '' }, leftBy: { type: 'string', default: '' } },
  actions: [{ name: 'write', label: 'Write', roles: 'anyone', reach: 'touch', params: { text: { type: 'string', max: 200, doc: 'what to write' } }, when: [], then: [{ op: 'set', field: 'text', value: { param: 'text' } }, { op: 'set', field: 'leftBy', value: 'x' }] },
    { name: 'Bad Name', label: 'no', roles: 'anyone', reach: 'touch', params: {}, when: [], then: [{ op: 'set', field: 'text', value: '' }] }] } as never;

test('the catalog publishes a def\'s own acts with their params and the state they need, and nothing it would not offer', () => {
  assert.deepEqual(catalogActs(lamp), [{ verb: 'switch-on', label: 'Switch on', when: [{ field: 'on', is: false }] }, { verb: 'switch-off', label: 'Switch off', when: [{ field: 'on', is: true }] }]);
  assert.deepEqual(catalogActs(board), [{ verb: 'write', label: 'Write', params: { text: { type: 'string', maxLength: 200, description: 'what to write' } } }]);
  assert.deepEqual(Object.keys(kindActions(board, {} as never, () => 'board')), ['write'], 'the same names kindActions offers');
});

test('a thing\'s state is published only where it differs from the default, never who left what, text cut short', () => {
  assert.deepEqual(stateDefaults(lamp), { on: true });
  assert.deepEqual(stateDefaults(board), { text: '' });
  assert.equal(stateDiff({ id: 'l', state: { on: true } } as never, lamp), null);
  assert.deepEqual(stateDiff({ id: 'l', state: { on: false } } as never, lamp), { on: false });
  const long = 'x'.repeat(300), d = stateDiff({ id: 'b', state: { text: long, leftBy: 'e_1=s_ana' } } as never, board)!;
  assert.equal(d.leftBy, undefined); assert.equal((d.text as string).length, STATE_TEXT_MAX);
  assert.equal(stateDiff({ id: 'n', state: { text: 'secret line' } } as never, { ...(board as object), tags: ['hand-writable', 'notebook'] } as never), null, 'a notebook\'s lines come with a read');
});

test('a hand act on a thing 300 m away is available: the act walks there', () => {
  const host = { bodyAt: () => [300, 0], stateOf: () => ({ on: true }) } as never;
  const acts = kindActions(lamp, host, () => 'the desk lamp'), s = { key: 'e_l', at: [0, 0], state: { on: true } };
  assert.equal(acts['switch-off'].available(s, { soul: { soulId: 's_a' } }), null);
  assert.equal(acts['switch-on'].available(s, { soul: { soulId: 's_a' } })?.code, 'object.state', 'a state the act does not take is still refused, with its reason');
});
