// 0.133 R3: private turns, the ticker and the radio from the v2 stream, as the old page's dock, ticker and sound read them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Bridge } from './bridge.ts';
import { TICK_US } from './takes.ts';
import { didOf, privateTurnOf, tickerOf } from './take-talk.ts';
import { thingState } from './world-state.ts';
import { createDialogueStore, ingestDialogue } from '../dialogue-threads.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const world = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null };
const body = (id: string, soul: string, name: string) => ({ id, kind: 'souls:body@1', parent: 'w.0', slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: T0, soul, name });
const part = (n: number, extra: object = {}) => ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes: [], removed: [], samples: [], ...extra } as never });
const turn = (speaker: string, s: number) => ({ speaker, at: T0 + s * 1e6, length: 0, reach: 0, ref: `private:c1`, words: null, private: { conversation: 'c1', members: ['b.1', 'b.2'] } });

test('a private turn is shown as the old page shows a sealed conversation to anyone: its members, and a … line, never words', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body('b.1', 'soul-abc-1', 'Ada'), body('b.2', 'soul-abc-2', 'Bo')], removed: [] } as never });
  b.receive(part(0, { said: [turn('b.1', 0.1), turn('b.2', 0.3)] }));
  b.receive(part(1, { said: [turn('b.1', 0.1)] })); // the same turn again (a replayed part): kept once
  const talking = b.view.conversations.filter((m) => m.kind === 'conversation.talking');
  assert.deepEqual(talking.map((m) => (m as { from: { name: string } }).from.name), ['Ada', 'Bo']);
  assert.ok(!JSON.stringify(b.view.conversations).includes('"text"'), 'no words');
  // the dock makes it one sealed thread of the two members, a … line a turn
  const store = createDialogueStore();
  ingestDialogue(store, b.view.conversations as never, []);
  const [thread] = [...store.threads.values()];
  assert.equal(thread.sealed, true);
  assert.deepEqual(thread.members.sort(), ['s_abc-1', 's_abc-2']);
  assert.deepEqual(thread.lines.map((l) => [l.name, l.text]), [['Ada', '…'], ['Bo', '…']]);
  assert.equal(privateTurnOf({ speaker: 'b.1', at: 0, length: 0, ref: 'x', words: 'hi' }, 0, 0, () => ({ soulId: 's', name: 'n' })), null, 'a public said is not a private turn');
});

test('the ticker says what the Souls did, once each, from moves and the named events on bodies', () => {
  assert.equal(didOf('souls:sit'), 'sat down');
  assert.equal(didOf('eden:wave@2'), 'waved');
  assert.equal(didOf('souls:effect'), null, 'what it does not tell');
  assert.deepEqual(tickerOf(7, 'Ada', 'souls:rise'), { tick: 7, text: 'Ada stood up' });
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body('b.1', 'soul-abc-1', 'Ada'), { ...world, id: 'w.9', parent: 'w.0', kind: 'eden:radio@1' }], removed: [] } as never });
  const moves = [{ body: 'b.1', name: 'souls:sit', start: T0 + 100_000, ends: [T0 + 900_000] }, { body: 'b.1', name: 'souls:wave', start: T0 + 2e6, ends: [T0 + 3e6] }];
  b.receive(part(0, { moves, happened: [{ at: T0 + 4e6, node: 'b.1', name: 'souls:idle' }, { at: T0 + 4e6, node: 'w.9', name: 'souls:idle' }] }));
  b.receive(part(1, { moves })); // again: once each
  assert.deepEqual(b.view.ticker.map((l) => l.text), ['Ada sat down', 'Ada waved', 'Ada went idle'], 'bodies only, once each');
  assert.equal(b.view.ticker[0].tick, Math.floor((T0 + 100_000) / TICK_US));
});

test('a radio\'s power and station reach the old page\'s entity, as its sound and dial read them', () => {
  const radio = (fields: Record<number, unknown>) => ({ id: 'r.1', kind: 'eden:radio@1220ab', parent: 'w.0', origin: 'e_radio', fields });
  assert.deepEqual(thingState(radio({ 28: 1, 29: 'eden:dance_band' }) as never), { on: true, station: 'dance_band' });
  assert.deepEqual(thingState(radio({ 28: 0 }) as never), { on: false });
});
