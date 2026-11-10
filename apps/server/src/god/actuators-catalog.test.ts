// #1751: a def's acts as the soul catalog publishes them, the state it is in by default and when changed, and a hand act
// taken by id from far away (the act's own walk takes the body there; it is no longer refused as out of sight).
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogActs, kindActions, stateDefaults, stateDiff, STATE_TEXT_MAX } from './actuators.ts';

const bucket = { name: 'core-ash-bucket', version: 1, tags: [], components: {}, state: { ash: { type: 'number', default: 0 }, note: { type: 'string', default: '' } }, actions: [] } as never;
const lamp = { name: 'core-desk-lamp', version: 1, tags: ['hand-operated'], components: {}, state: { on: { type: 'boolean', default: true } },
  actions: [{ name: 'switch-on', label: 'Switch on', roles: 'anyone', reach: 'touch', params: {}, when: [{ field: 'on', is: false }], then: [{ op: 'set', field: 'on', value: true }] },
    { name: 'switch-off', label: 'Switch off', roles: 'anyone', reach: 'touch', params: {}, when: [{ field: 'on', is: true }], then: [{ op: 'set', field: 'on', value: false }] }] } as never;
const board = { name: 'core-chalkboard', version: 1, tags: ['hand-writable'], components: {}, state: { text: { type: 'string', default: '' }, textBy: { type: 'string', default: '' }, leftBy: { type: 'string', default: '' }, count: { type: 'number', default: 0 }, tune: { type: 'enum', values: ['Waltz', 'Reel'], default: 'Waltz' } },
  actions: [{ name: 'write', label: 'Write', roles: 'anyone', reach: 'touch', params: { text: { type: 'string', max: 200, doc: 'what to write' } }, when: [], then: [{ op: 'set', field: 'text', value: { param: 'text' } }, { op: 'set', field: 'textBy', value: 's_x' }, { op: 'set', field: 'leftBy', value: 'x' }, { op: 'increment', field: 'count', by: 1 }, { op: 'cycle', field: 'tune', values: ['Waltz', 'Reel'] }] },
    { name: 'Bad Name', label: 'no', roles: 'anyone', reach: 'touch', params: {}, when: [], then: [{ op: 'set', field: 'text', value: '' }] }] } as never;

test('the catalog publishes a def\'s own acts with their params and the state they need, and nothing it would not offer', () => {
  assert.deepEqual(catalogActs(lamp), [{ verb: 'switch-on', label: 'Switch on', when: [{ field: 'on', is: false }] }, { verb: 'switch-off', label: 'Switch off', when: [{ field: 'on', is: true }] }]);
  assert.deepEqual(catalogActs(board), [{ verb: 'write', label: 'Write', params: { text: { type: 'string', maxLength: 200, description: 'what to write' } } }]);
  assert.deepEqual(Object.keys(kindActions(board, {} as never, () => 'board')), ['write'], 'the same names kindActions offers');
});

test('a thing\'s state is published only where it differs from the default: booleans, numbers, enum values, never free text or Soul ids', () => {
  assert.deepEqual(stateDefaults(lamp), { on: true });
  assert.deepEqual(stateDefaults(board), { count: 0, tune: 'Waltz' });
  assert.equal(stateDiff({ id: 'l', state: { on: true } } as never, lamp), null);
  assert.deepEqual(stateDiff({ id: 'l', state: { on: false } } as never, lamp), { on: false });
  const d = stateDiff({ id: 'b', state: { text: 'meet me at noon', textBy: 's_ana', leftBy: 'e_1=s_ana', count: 2, tune: 'Reel' } } as never, board)!;
  assert.deepEqual(d, { count: 2, tune: 'Reel' });
  assert.equal(stateDiff({ id: 'b', state: { tune: 'x'.repeat(STATE_TEXT_MAX + 1) } } as never, board), null, 'not one of the enum\'s values');
  assert.deepEqual(stateDefaults(bucket), { ash: 0 }, 'a thing with no acts of its own publishes its declared state');
  assert.deepEqual(stateDiff({ id: 'k', state: { ash: 3, note: 'hi' } } as never, bucket), { ash: 3 });
  assert.equal(stateDiff({ id: 'n', state: { text: 'secret line' } } as never, { ...(board as object), tags: ['hand-writable', 'notebook'] } as never), null, 'a notebook\'s lines come with a read');
});

test('a hand act on a thing 300 m away is taken by id (the act walks there); a whole menu leaves it out; a secret place\'s thing stays unknown', () => {
  let whole = false, secret = false;
  const host = { bodyAt: () => [300, 0], stateOf: () => ({ on: true }), wholeMenu: () => whole, hidden: () => secret } as never;
  const acts = kindActions(lamp, host, () => 'the desk lamp'), s = { key: 'e_l', at: [0, 0], state: { on: true } }, ctx = { soul: { soulId: 's_a' } };
  assert.equal(acts['switch-off'].available(s, ctx), null);
  assert.equal(acts['switch-on'].available(s, ctx)?.code, 'object.state', 'a state the act does not take is still refused, with its reason');
  whole = true; assert.equal(acts['switch-off'].available(s, ctx)?.code, 'object.out-of-reach', 'a whole menu lists things within sight only');
  assert.equal(kindActions(lamp, { ...(host as object), bodyAt: () => [10, 0] } as never, () => 'the desk lamp')['switch-off'].available(s, ctx), null, 'near: listed');
  whole = false; secret = true; assert.match(acts['switch-off'].validate(s, {}, ctx)!.reason, /do not know the way/);
});
