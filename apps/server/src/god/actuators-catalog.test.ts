// #1751: a def's acts as the soul catalog publishes them, the state it is in by default and when changed, and a hand act
// taken by id from far away (the act's own walk takes the body there; it is no longer refused as out of sight).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { catalogActs, farOutcome, kindActions, stateDefaults, stateDiff, wrapAct, STATE_TEXT_MAX } from './actuators.ts';
import { tx } from '../edge/comms/store.ts';

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
  whole = false; secret = true; assert.match(acts['switch-off'].validate(s, {}, ctx)!.reason, /do not know where that is/);
});

test('a far act held for its body: made on arrival if the thing still takes it; nothing changes when stopped, short or refused', () => {
  const commits: unknown[] = [], far = { id: 'e_l', action: 'switch-off', params: {}, capability: 'object:e_l:switch-off' }, soul = { soulId: 's_a' } as never;
  const host = (body: [number, number]) => ({ bodyAt: () => body, thingAt: () => [0, 0], commit: (_id: string, patch: unknown) => { commits.push(patch); return { accepted: true }; } }) as never;
  const find = (on: boolean) => () => ({ def: lamp, state: { on }, name: 'the desk lamp' });
  assert.equal((farOutcome(far, false, soul, find(true), host([0.5, 0])) as { code: string }).code, 'object.not-reached', 'stopped on the way');
  assert.equal((farOutcome(far, true, soul, find(true), host([40, 0])) as { code: string }).code, 'object.not-reached', 'ended far from it');
  assert.equal((farOutcome(far, true, soul, find(false), host([0.5, 0])) as { code: string }).code, 'object.state', 'someone switched it off first');
  assert.equal(commits.length, 0, 'none of those changed the world');
  assert.equal(farOutcome(far, true, soul, find(true), host([0.5, 0])), 'done');
  assert.deepEqual(commits, [{ on: false }]);
});

test('a far act whose thing turned private or whose policy changed during the walk gets the near act\'s named refusal on arrival, and nothing changes', () => {
  const commits: unknown[] = [], far = { id: 'e_l', action: 'switch-off', params: {}, capability: 'object:e_l:switch-off' }, soul = { soulId: 's_a' } as never;
  const find = () => ({ def: lamp, state: { on: true }, name: 'the desk lamp' });
  const base = { bodyAt: () => [0.5, 0], thingAt: () => [0, 0], commit: (_id: string, patch: unknown) => { commits.push(patch); return { accepted: true }; } };
  const priv = { code: 'object.private', reason: 'the desk lamp is Ben\'s and private.' }, locked = { code: 'door.locked', reason: 'It is locked.' };
  assert.deepEqual(farOutcome(far, true, soul, find, { ...base, access: () => priv } as never), priv, 'made private on the way');
  assert.deepEqual(farOutcome(far, true, soul, find, { ...base, policy: (_id: string, _s: unknown, action: string) => action === 'switch-off' ? locked : null } as never), locked, 'its policy changed on the way');
  // #1859: someone else's hand started on it during the walk
  const inUse = { code: 'container.in-use', reason: 'Someone\'s hand is in the desk lamp; wait until they are done.' };
  assert.deepEqual(farOutcome(far, true, soul, find, { ...base, busy: (id: string, action: string) => id === 'e_l' && action === 'switch-off' ? inUse : null } as never), inUse, 'busy on arrival');
  assert.equal(commits.length, 0, 'none changed the world');
});

test('a far act is held and a held one dropped only when the act\'s transaction commits: a newer act that rolls back leaves it held', () => {
  const db = new DatabaseSync(':memory:'), held: unknown[] = [];
  try {
    const objects = { act: () => ({ accepted: true }), core: { db } };
    const host = { bodyAt: () => [300, 0], thingAt: () => [0, 0], deferFar: (_s: unknown, far: unknown) => held.push(far), commit: () => ({ accepted: true }) } as never;
    wrapAct(objects, () => ({ def: lamp, state: { on: true }, name: 'the desk lamp' }), host, () => {});
    const soul = { soulId: 's_a', entityId: 'h_a' } as never, act = () => (objects as { act(id: string, s: unknown, i: unknown): unknown }).act('e_l', soul, { action: 'switch-off' });
    assert.throws(() => tx(db, () => { act(); assert.deepEqual(held, [], 'nothing held inside the transaction'); throw Error('admission rolled back'); }), /rolled back/);
    assert.deepEqual(held, [], 'an act that rolled back neither holds nor drops');
    tx(db, () => { act(); });
    assert.deepEqual(held.map((h) => (h as { capability?: string } | null)?.capability ?? null), [null, 'object:e_l:switch-off'], 'committed: the old one dropped, this one held');
    assert.throws(() => tx(db, () => { act(); throw Error('newer admission rolled back'); }), /rolled back/);
    assert.equal(held.length, 2, 'a newer act that rolled back leaves the earlier far act held');
  } finally { db.close(); }
});

test('#1859: inside a transaction afterCommit cannot track, a far act is neither held nor dropped, and that is logged', () => {
  const db = new DatabaseSync(':memory:'), held: unknown[] = [], logs: string[] = [];
  try {
    const objects = { act: () => ({ accepted: true }), core: { db } };
    const host = { bodyAt: () => [300, 0], thingAt: () => [0, 0], deferFar: (_s: unknown, far: unknown) => held.push(far), commit: () => ({ accepted: true }) } as never;
    wrapAct(objects, () => ({ def: lamp, state: { on: true }, name: 'the desk lamp' }), host, (m) => logs.push(m));
    const soul = { soulId: 's_a', entityId: 'h_a' } as never;
    db.exec('BEGIN');   // an outer transaction not opened by tx(): afterCommit throws edge-comms.untracked-outer-transaction
    (objects as { act(id: string, s: unknown, i: unknown): unknown }).act('e_l', soul, { action: 'switch-off' });
    db.exec('ROLLBACK');
    assert.deepEqual(held, [], 'nothing held or dropped');
    assert.equal(logs.length, 2, 'the drop and the hold each logged'); assert.match(logs[0]!, /untracked-outer-transaction/);
  } finally { db.close(); }
});
