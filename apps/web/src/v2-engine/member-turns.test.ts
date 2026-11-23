// 0.133 R3b: a private turn's words reach a member's page and no one else's (member-turns.ts, bridge.ts `heard`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'cborg';
// the page modules it loads read `location` when loaded
Object.assign(globalThis, { location: { origin: 'http://localhost:5960', pathname: '/w/eden/', search: '', hash: '', href: 'http://localhost:5960/w/eden/' } });
const { followFrame, heardOf } = await import('./member-turns.ts');
const { V2Bridge } = await import('./bridge.ts');

const id = (hex: string, n: number) => [Uint8Array.from(hex.match(/../g)!, (x) => parseInt(x, 16)), n];
const CONV = id('aa'.repeat(16), 9), BODY = id('bb'.repeat(16), 7), AT = 1_000_000_000_000;
const said = new Map<number, unknown>([[1, 'souls:said'], [2, new Map<number, unknown>([[1, new Map([[21, id('cc'.repeat(16), 1)]])], [2, 1000], [4, 2_000_000]])]]);
const entry = (audience: Map<number, unknown>) => encode(new Map<number, unknown>([[1, 41], [2, AT], [4, new Map<number, unknown>([[1, 3]])], [5, audience], [6, BODY], [8, [said]]]));
const ofConv = new Map<number, unknown>([[1, 2], [2, CONV]]);
/** R4's addressed item `{1: 9, 2: entry, 3: words}` as the gateway hands it; without words for one who may not read them. */
const item = (audience: Map<number, unknown>, words?: string) =>
  encode(new Map<number, unknown>([[1, 9], [2, entry(audience)], ...(words === undefined ? [] : [[3, new TextEncoder().encode(words)] as [number, unknown]])]));

test('a member reads a turn with its words; a turn without words, a public one or another item is nothing', () => {
  assert.deepEqual(heardOf(item(ofConv, 'meet me by the pond')),
    { conversation: `${'aa'.repeat(16)}.9`, speaker: `${'bb'.repeat(16)}.7`, at: AT, words: 'meet me by the pond' });
  assert.equal(heardOf(item(ofConv)), null, 'sent without its words: the subscriber may not read them');
  assert.equal(heardOf(item(new Map([[1, 1]]), 'aloud')), null, 'public speech reaches the dock from the stream');
  assert.equal(heardOf(encode(new Map<number, unknown>([[1, 5], [2, new Map([[1, 4]])]]))), null, 'a grant item');
});

test('the follow frame asks for the Souls\' own bodies at counts', () => {
  assert.deepEqual(followFrame([`${'bb'.repeat(16)}.7`]), encode(new Map<number, unknown>([[30, new Map<number, unknown>([[1, [new Map([[2, BODY]])]], [2, 4], [3, 8_000]])]])));
});

test('the dock shows a member the words in place of the `…` line; a page that heard nothing keeps the `…`', () => {
  const body = { id: `${'bb'.repeat(16)}.7`, kind: 'souls:body@1', parent: null, slot: null, pos: [0, 0, 0], rot: [2 ** 30, 0, 0, 0], at: AT, soul: 'soul-abc-7', name: 'Ada' };
  const turn = { speaker: body.id, at: AT, length: 0, reach: 0, ref: `private:${'aa'.repeat(16)}.9`, words: null, private: { conversation: `${'aa'.repeat(16)}.9`, members: [body.id] } };
  const run = (member: boolean) => {
    const b = new V2Bridge({ rulesVersion: 'test/1' });
    b.receive({ t: 'snapshot', s: { nodes: [body], removed: [] } } as never);
    if (member) b.heard(heardOf(item(ofConv, 'meet me by the pond'))!);
    b.receive({ t: 'part', p: { number: 0, from: AT, to: AT + 500_000, nodes: [], removed: [], samples: [], said: [turn] } } as never);
    return b.view.conversations.map((m) => 'turn' in m ? `turn ${m.turn.from.name}: ${m.turn.text}` : m.kind);
  };
  assert.deepEqual(run(true), ['conversation.start', 'turn Ada: meet me by the pond', 'conversation.member']);
  assert.deepEqual(run(false), ['conversation.member', 'conversation.talking']);
  // A whisper to a Soul (its audience the Soul's own) is not a conversation's turn: no thread is made of it.
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [body, { ...body, id: `${'dd'.repeat(16)}.2`, soul: `soul-${'ee'.repeat(16)}-0`, name: 'Bo' }], removed: [] } } as never);
  b.heard({ ...heardOf(item(ofConv, 'psst'))!, conversation: `${'ee'.repeat(16)}.0` });
  b.heard({ ...heardOf(item(ofConv, 'psst'))!, conversation: `${'dd'.repeat(16)}.2` });
  assert.deepEqual(b.view.conversations, []);
});
