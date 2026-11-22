// A creator's furnish (#3728): today's recipes on an export of the copy, with no daemon and no world. The served
// proof (a full-Eden townhouse emptied and furnished again through `node eden.mjs god furnish`) is in the pull request.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkedFurnish, furnishOps, kindFor, roomKindOf, styleOf } from './furnish.mjs';

const S = '0'.repeat(32);
const hex = (t) => ({ hex: Buffer.from(t).toString('hex') });
const pose = (frame, at = [0, 0, 0]) => ({ frame, at, orientation: [1 << 30, 0, 0, 0], support: { which: 1, node: frame, height: 0 } });
// A townhouse with one 4 × 4 m kitchen whose door (to the ground) is on its +z wall, and a chair already in it.
const house = (chair) => [
  { id: `${S}-1`, kind: 'eden:ground@1', parent: null, fields: {} },
  { id: `${S}-2`, kind: 'eden:townhouse@1', parent: `${S}-1`, fields: { 2: hex('core-townhouse@3') }, pose: pose(`${S}-1`) },
  { id: `${S}-3`, kind: 'eden:floor@1', parent: `${S}-2`, fields: { 5: 0 }, pose: pose(`${S}-2`) },
  { id: `${S}-4`, kind: 'eden:room@1', parent: `${S}-3`, pose: pose(`${S}-3`, [1_000_000, 0, 0]),
    fields: { 1: hex('e_1/kitchen'), 11: [[-2000, -2000], [2000, -2000], [2000, 2000], [-2000, 2000]], 22: [[{ id: `${S}-9` }, 'eden:door', 1000, 2000, 0, 1000, 2100]] },
    links: [{ id: `${S}-9`, type: 'eden:doorway', ends: [`${S}-4`, `${S}-1`], owner: 0 }] },
  ...(chair ? [{ id: `${S}-5`, kind: 'eden:chair@1', parent: `${S}-4`, fields: { 1: hex('e_1/kitchen-chair-1') }, pose: pose(`${S}-4`, [-1_500_000, 0, -1_500_000]) }] : []),
];
const kinds = {
  'eden:room@1': { owner: 'room', admits: ['thing'], slots: {} },
  'eden:workbench@1': { owner: 'thing', admits: [], slots: {} },
  'eden:table@1': { owner: 'thing', admits: [], slots: { 1: ['thing'] } },
  'eden:bowl@1': { owner: 'thing', admits: [], slots: {} },
  'eden:chair@1': { owner: 'thing', admits: [], slots: {} },
};
const entries = { 'eden:workbench': [1600, 900, 600], 'eden:table': [1200, 750, 800], 'eden:bowl': [200, 80, 200], 'eden:chair': [450, 900, 450] };
for (const k of Object.keys(entries)) entries[k] = { geometry: { bounds_mm: entries[k] } };

test('today\'s names: a def\'s style, a room\'s kind, a recipe def\'s pinned kind', () => {
  assert.equal(styleOf(hex('core-townhouse@3')), 'townhouse');
  assert.equal(roomKindOf(hex('e_df85cd6d/bedroom-2')), 'bedroom');
  assert.equal(kindFor('core/bench-seat@1', { 'eden:bench_seat@12ab': {} }), 'eden:bench_seat@12ab');
  assert.equal(kindFor('core/statue@1', kinds), null);
});

test('a kitchen furnished from today\'s townhouse recipe: in the room, out of its doorway, a bowl on the table', () => {
  const out = furnishOps(house(false), `${S}-2`, { kinds, entries });
  assert.equal(out.ok, undefined, JSON.stringify(out));
  assert.match(out.says, /townhouse, front s/);
  const by = Object.fromEntries(out.placed.map((p, k) => [p.name, out.ops[k]]));
  assert.deepEqual(Object.keys(by), ['e_1/kitchen-counter', 'e_1/kitchen-table', 'e_1/kitchen-bowl', 'e_1/kitchen-chair-1', 'e_1/kitchen-stool']);
  assert.equal(by['e_1/kitchen-stool'].kind, 'eden:chair@1', 'a stool\'s next def, as today');
  for (const o of out.ops.filter((o) => o.at)) {
    assert.equal(o.in, `${S}-4`);
    assert.ok(Math.abs(o.at[0]) <= 2000 && Math.abs(o.at[2]) <= 2000, `${o.kind} in the room: ${o.at}`);
    assert.deepEqual(o.support, { which: 1, node: `${S}-4`, height: 0 });
  }
  // The door is at x 0, z 2000 in the room's frame: nothing solid within 0.8 m of it.
  for (const o of out.ops.filter((o) => o.at)) assert.ok(!(Math.abs(o.at[0]) < 800 && o.at[2] > 1000), `${o.kind} out of the doorway: ${o.at}`);
  assert.deepEqual(by['e_1/kitchen-bowl'], { op: 'place', name: 3, kind: 'eden:bowl@1', in: 2, slot: 1, fields: { 1: hex('e_1/kitchen-bowl') } });
  // The second chair's poses all cut a way in this small kitchen (today's ways check, `ways.mjs`).
  assert.deepEqual(out.dropped.map((d) => d.name), ['e_1/kitchen-chair-2']);
  assert.match(out.dropped[0].why, /way/);
});

test('a second furnish leaves what is there by today\'s name, and a piece standing there is in the way', () => {
  const out = furnishOps(house(true), `${S}-4`, { kinds, entries });
  assert.ok(out.notes.includes('e_1/kitchen-chair-1 already there'));
  assert.ok(!out.placed.some((p) => p.name === 'e_1/kitchen-chair-1'));
  assert.equal(furnishOps(house(false), `${S}-3`, { kinds, entries }).code, 'furnish.no-rooms');
  assert.equal(furnishOps(house(false), `${S}-2`, { kinds, entries, style: 'igloo' }).code, 'furnish.style');
});

test('with no kinds text here (a served creator\'s home), the kinds the world already uses are its kinds', () => {
  const out = furnishOps(house(true), `${S}-2`, { entries });
  assert.deepEqual(out.placed.map((p) => p.name), ['e_1/kitchen-chair-2', 'e_1/kitchen-stool']);
  assert.ok(out.dropped.some((d) => d.name === 'e_1/kitchen-table' && /no kind/.test(d.why)));
});

test('the edit is checked under its claim: a piece the check refuses is dropped, a claims refusal is the furnish\'s', () => {
  // The table refused (its slot, say): it goes, with the bowl on it; the rest is checked again and sent.
  let asked = 0;
  const out = checkedFurnish(furnishOps(house(false), `${S}-2`, { kinds, entries }), (ops) => {
    asked++;
    const k = ops.findIndex((o) => o.kind === 'eden:table@1');
    return k >= 0 ? { ok: false, code: 'edit.slot', op: k } : { ok: true };
  });
  assert.equal(asked, 2);
  assert.ok(!out.ops.some((o) => o.kind === 'eden:table@1' || o.kind === 'eden:bowl@1'), JSON.stringify(out.ops));
  assert.match(out.says, /4 pieces in 1 rooms, 2 dropped; dropped: e_1\/kitchen-table \(edit.slot\), e_1\/kitchen-bowl \(edit.slot\)/);
  // Inside another's live claim (or outside a helper's own): the whole furnish is refused by name, nothing dropped.
  for (const code of ['edit.claimed', 'edit.outside-claim', 'edit.claim-unknown']) {
    const refused = checkedFurnish(furnishOps(house(false), `${S}-2`, { kinds, entries }), () => ({ ok: false, code, op: 0, detail: 'x' }));
    assert.deepEqual([refused.ok, refused.code, refused.op, refused.ops], [false, code, 0, undefined]);
  }
});
