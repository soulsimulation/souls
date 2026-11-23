// #4175: what a v2 Soul says reaches the old page's speech layer (its `talk` lines) and the take's events, in order, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeEvents } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { V2Bridge } from './bridge.ts';
import { TICK_US } from './takes.ts';
import { isPublic, talkOf } from './take-speech.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const world = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null };
const body = (id: string, soul: string, name: string) => ({ id, kind: 'souls:body@1', parent: 'w.0', slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: T0, soul, name });
const said = (speaker: string, s: number, words: string | null, extra: object = {}) => ({ speaker, at: T0 + s * 1e6, length: 2e6, reach: 10_000, ref: `r${speaker}${s}`, words, ...extra });
const part = (n: number, s: object[] = []) => ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes: [], removed: [], samples: [], said: s } as never });

test('a said is a talk line from its Soul, in world-time order, once, and not before its chunk is in', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body('b.1', 'soul-abc-1', 'Ada'), body('b.2', 'soul-abc-2', 'Bo')], removed: [] } as never });
  b.receive(part(0, [said('b.2', 0.4, 'second'), said('b.1', 0.1, 'first')]));
  b.receive(part(1, [said('b.1', 0.1, 'first')])); // the same said again (a replayed part): kept once
  b.receive(part(2, [said('b.1', 1.2, 'private', { private: { conversation: 'c', members: [] } }), said('b.2', 1.3, null)]));
  assert.equal(b.view.talk.length, 0, 'nothing shown before its chunk is drawn');
  for (let n = 3; n < 10; n++) b.receive(part(n));
  assert.deepEqual(b.view.talk.map((l) => [l.from, l.fromName, l.act, l.text]), [['s_abc-1', 'Ada', 'say', 'first'], ['s_abc-2', 'Bo', 'say', 'second']]);
  assert.ok(b.view.talk[0].id < b.view.talk[1].id && b.view.talk[0].at <= b.view.talk[1].at);
  assert.equal(b.view.talk[0].tick, Math.floor((T0 + 100_000) / TICK_US));
  // the take's events carry them too, on the speaker's tick
  const take = b.view.takes.chunks.find((c) => c.fromTick === T0 / TICK_US)!.take as unknown as Take;
  assert.deepEqual(takeEvents(take).map((e) => [e.t, e.type === 'mark' ? e.data : null]), [[2, { from: 's_abc-1', text: 'first' }], [8, { from: 's_abc-2', text: 'second' }]]);
  const later = b.view.takes.chunks.filter((c) => c.fromTick > T0 / TICK_US);
  assert.ok(later.every((c) => !(c.take as { events: unknown[] }).events.length), 'in one chunk only');
});

test('private turns and saids without words are never shown', () => {
  assert.equal(isPublic({ speaker: 'b', at: 0, length: 0, ref: 'x', words: 'hi', private: { conversation: 'c', members: [] } }), false);
  assert.equal(isPublic({ speaker: 'b', at: 0, length: 0, ref: 'x', words: null }), false);
  const l = talkOf({ speaker: 'b', at: 3 * TICK_US + 1, length: 0, ref: 'x', words: 'hi' }, 7, 's_b', 'B', TICK_US, 1234);
  assert.deepEqual([l.id, l.tick, l.at, l.from, l.text], [7, 3, 1234, 's_b', 'hi']);
});
