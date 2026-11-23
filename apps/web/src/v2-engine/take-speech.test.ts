// #4175: what a v2 Soul says reaches the old page's speech layer (its `talk` lines) and the take's events, in order, once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeEvents } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { V2Bridge } from './bridge.ts';
import { TICK_US } from './takes.ts';
import { hearersOf, isPublic, talkOf } from './take-speech.ts';
import { candidates } from '../WorldDirector.ts';
import { channelChip, speechFromEdge } from '../WorldSpectatorSpeech.ts';
import { createDialogueStore, ingestDialogue } from '../dialogue-threads.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const world = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null };
const body = (id: string, soul: string, name: string) => ({ id, kind: 'souls:body@1', parent: 'w.0', slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: T0, soul, name });
const said = (speaker: string, s: number, words: string | null, extra: object = {}) => ({ speaker, at: T0 + s * 1e6, length: 2e6, reach: 10_000, ref: `r${speaker}${s}`, words, ...extra });
const part = (n: number, s: object[] = []) => ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes: [], removed: [], samples: [], said: s } as never });

test('a said is a talk line from its Soul, in world-time order, once, and not before its chunk is in', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, body('b.1', 'soul-abc-1', 'Ada'), body('b.2', 'soul-abc-2', 'Bo')], removed: [] } as never });
  b.receive(part(0, [said('b.2', 0.4, 'second'), said('b.1', 0.1, 'first')]));
  assert.equal(b.view.speech.length, 0, 'nothing shown before its chunk is drawn');
  b.receive(part(1, [said('b.1', 0.1, 'first')])); // the same said again (a replayed part): kept once
  b.receive(part(2, [said('b.1', 1.2, 'private', { private: { conversation: 'c', members: [] } }), said('b.2', 1.3, null)]));
  for (let n = 3; n < 10; n++) b.receive(part(n));
  assert.deepEqual(b.view.speech.map((l) => [l.kind, l.from, l.text]), [['speech', { soulId: 's_abc-1', name: 'Ada' }, 'first'], ['speech', { soulId: 's_abc-2', name: 'Bo' }, 'second']]);
  assert.ok(b.view.speech[0].id !== b.view.speech[1].id && b.view.speech[0].at <= b.view.speech[1].at);
  assert.equal(b.view.speech[0].tick, Math.floor((T0 + 100_000) / TICK_US));
  assert.equal(b.view.speech[0].channel.radius, 10, 'heard within its reach (10 m)');
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

test('the old page shows a v2 say as said aloud by the Soul, never as a private exchange with someone', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const nameless = { ...body('b.6', 'soul-abc-6', 'x'), name: null }; // its name not yet resolved: listed as "Soul 6"
  b.receive({ t: 'snapshot', s: { nodes: [world, body('b.1', 'soul-abc-1', 'Ada'), nameless], removed: [] } as never });
  b.receive(part(0, [said('b.1', 0.1, 'hello all'), said('b.6', 0.2, 'hi Ada')]));
  for (let n = 1; n < 10; n++) b.receive(part(n));
  // the speech layer and the speaker's card chip (LiveWorld: speechFromEdge, channelChip)
  const speeches = speechFromEdge(b.view.speech, () => [0, 0, 0]);
  assert.deepEqual(speeches.map((x) => [x.speaker, x.speakerName, x.text, x.channel.kind]), [['s_abc-1', 'Ada', 'hello all', 'earshot'], ['s_abc-6', 'Soul 6', 'hi Ada', 'earshot']]);
  for (const x of speeches) {
    const chip = channelChip(x, () => 'someone');
    assert.equal(chip.private, false);
    assert.match(chip.text, /aloud/);
  }
  // the dialogue dock: one aloud thread with the speakers' names, nothing sealed
  const store = createDialogueStore();
  ingestDialogue(store, b.view.speech, [], b.view.speech[0].at + 1000);
  const threads = [...store.threads.values()];
  assert.ok(threads.length >= 1 && threads.every((t) => t.kind === 'aloud' && !t.sealed));
  assert.deepEqual(threads.flatMap((t) => t.lines.map((l) => [l.name, l.text])), [['Ada', 'hello all'], ['Soul 6', 'hi Ada']]);
  ingestDialogue(store, b.view.speech, [], b.view.speech[0].at + 2000);
  assert.equal(threads.flatMap((t) => t.lines).length, 2, 'folded once');
});

test('two Souls speaking aloud near each other are heard by each other: one thread, and broadcast takes their two-shot', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const unnamed = { ...body('b.2', 'x', 'Bo'), soul: undefined }; // a body the stream gives no Soul grant: known by its node id
  b.receive({ t: 'snapshot', s: { nodes: [world, body('b.1', 'soul-abc-1', 'Ada'), unnamed, body('b.3', 'soul-abc-3', 'Cy')], removed: [] } as never });
  // Ada and Bo 3 m apart, Cy 40 m off (the stream's µm, in the world frame); a 10 m reach.
  const at = (id: string, x: number) => [id, 'w.0', null, T0, x, 0, 0];
  b.receive({ t: 'part', p: { number: 0, from: T0, to: T0 + 500_000, nodes: [], removed: [], samples: [at('b.1', 0), at('b.2', 3_000_000), at('b.3', 40_000_000)],
    said: [said('b.1', 0.1, 'hello Bo'), said('b.2', 0.3, 'hello Ada'), said('b.3', 0.4, 'anyone?')] } as never });
  for (let n = 1; n < 10; n++) b.receive(part(n));
  assert.deepEqual(b.view.speech.map((x) => [x.from.name, x.heardBy]), [['Ada', ['s_b_2']], ['Bo', ['s_abc-1']], ['Cy', []]]);
  const store = createDialogueStore();
  ingestDialogue(store, b.view.speech, [], b.view.speech[0].at + 1000);
  const threads = [...store.threads.values()].map((t) => t.lines.map((l) => l.name));
  assert.deepEqual(threads, [['Ada', 'Bo'], ['Cy']], 'Ada and Bo are one scene; Cy talks alone');
  // the director (WorldBroadcast feeds it the dock's threads by entity): Ada and Bo are a conversation two-shot
  const thread = [...store.threads.values()][0].id;
  const speaking = new Map([['v2_b_1', { thread, at: 100 }], ['v2_b_2', { thread, at: 101 }]]);
  const best = candidates({ bodies: [{ id: 'v2_b_1', p: [0, 0, 0] }, { id: 'v2_b_2', p: [3, 0, 0] }], speaking, now: 102, landmarks: [] })[0];
  assert.equal(best.kind === 'subjects' && best.twoShot, true);
});

test('hearers are the other Souls within earshot of the speaker, once each; an unplaced speaker is heard by none', () => {
  const others = [{ soul: 'a', p: [1000, 0, 0] }, { soul: 'b', p: [0, 0, 12_500] }, { soul: 'c', p: null }, { soul: 'a', p: [2000, 0, 0] }];
  assert.deepEqual(hearersOf([0, 0, 0], 12_000, others), ['a']);
  assert.deepEqual(hearersOf(null, 12_000, others), []);
});
