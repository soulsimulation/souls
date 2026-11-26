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
  // The second chair was dropped by the ways check before the edit was checked (#3961).
  assert.match(out.says, /3 pieces in 1 rooms, 3 dropped; dropped: e_1\/kitchen-chair-2 \(would cut the way[^)]*\), e_1\/kitchen-table \(edit.slot\), e_1\/kitchen-bowl \(edit.slot\)/);
  // Inside another's live claim (or outside a helper's own): the whole furnish is refused by name, nothing dropped.
  for (const code of ['edit.claimed', 'edit.outside-claim', 'edit.claim-unknown']) {
    const refused = checkedFurnish(furnishOps(house(false), `${S}-2`, { kinds, entries }), () => ({ ok: false, code, op: 0, detail: 'x' }));
    assert.deepEqual([refused.ok, refused.code, refused.op, refused.ops], [false, code, 0, undefined]);
  }
});

// #5006 row 22: a cottage bedroom of the Hello Hamlet template's size, 2.23 × 2.72 m, its door to the landing halfway
// along a long wall. Its double bed (1.47 × 2.06 m) leaves at most 0.72 m to that wall, and a body needs 0.93 m.
const smallBedroom = (width = 2230) => [
  { id: `${S}-1`, kind: 'eden:ground@1', parent: null, fields: {} },
  { id: `${S}-2`, kind: 'eden:cottage@1', parent: `${S}-1`, fields: { 2: hex('core-cottage@3') }, pose: pose(`${S}-1`) },
  { id: `${S}-3`, kind: 'eden:floor@1', parent: `${S}-2`, fields: { 5: 0 }, pose: pose(`${S}-2`) },
  { id: `${S}-4`, kind: 'eden:room@1', parent: `${S}-3`, pose: pose(`${S}-3`),
    fields: { 1: hex('e_1/bedroom'), 11: [[-width / 2, -1360], [width / 2, -1360], [width / 2, 1360], [-width / 2, 1360]], 22: [[{ id: `${S}-9` }, 'eden:door', width / 2, 0, 90000, 800, 2100]] },
    links: [{ id: `${S}-9`, type: 'eden:doorway', ends: [`${S}-4`, `${S}-5`], owner: 0 }] },
  { id: `${S}-5`, kind: 'eden:room@1', parent: `${S}-3`, pose: pose(`${S}-3`, [3_000_000, 0, 0]), fields: { 1: hex('e_1/landing'), 11: [[-800, -1360], [800, -1360], [800, 1360], [-800, 1360]] } },
];
const beds = (single) => ({
  kinds: { 'eden:room@1': {}, 'eden:bed@1': {}, ...(single ? { 'eden:bunk@1': {} } : {}) },
  entries: { 'eden:bed': { geometry: { bounds_mm: [1470, 960, 2060] } }, 'eden:bunk': { geometry: { bounds_mm: [1010, 1800, 2010] } } },
});

test('#5006 row 22: a double bed that leaves no room to reach it gives way to a single bed, and the answer says so', () => {
  const out = furnishOps(smallBedroom(), `${S}-4`, beds(true));
  assert.deepEqual(out.placed.map((p) => [p.name, p.kind]), [['e_1/bedroom-bed', 'eden:bunk']], JSON.stringify(out));
  assert.equal(out.ops[0].kind, 'eden:bunk@1');
  // the bunk stands along the far wall, its length along it, with 0.93 m or more between it and the door's wall
  const [x] = out.ops[0].at, along = Math.abs(out.ops[0].orientation[2]) > 0;
  assert.ok(along && 1115 - (x + 505) >= 930, JSON.stringify(out.ops[0]));
  assert.deepEqual(out.instead, [{ name: 'e_1/bedroom-bed', kind: 'eden:bunk', for: 'eden:bed', why: 'would cut the way to its doors or another piece' }]);
  assert.match(out.says, /1 pieces in 1 rooms, 0 dropped; e_1\/bedroom-bed is a single bed \(eden:bunk\): a double \(eden:bed\) does not fit with room to reach it/);
  const sent = checkedFurnish(out, () => ({ ok: true }));
  assert.match(sent.says, /^furnish \S+ \(cottage, front s\): 1 pieces in 1 rooms, 0 dropped; e_1\/bedroom-bed is a single bed \(eden:bunk\)/);
  // a check that refuses the single bed drops it, and the answer no longer says it was placed
  const refused = checkedFurnish(furnishOps(smallBedroom(), `${S}-4`, beds(true)), (ops) => (ops.length ? { ok: false, code: 'edit.admits', op: 0 } : { ok: true }));
  assert.equal(refused.code, 'furnish.nothing');
  // a bedroom the double fits keeps it
  assert.deepEqual(furnishOps(smallBedroom(3200), `${S}-4`, beds(true)).placed.map((p) => p.kind), ['eden:bed']);
});

test('#5006 row 22: where no bed fits, the bed is dropped saying so, with why for each', () => {
  const none = furnishOps(smallBedroom(1500), `${S}-4`, beds(true));
  assert.equal(none.ops.length, 0, JSON.stringify(none.ops));
  assert.match(none.dropped[0].why, /^no bed fits: eden:bed .+; eden:bunk .+/);
  assert.equal(none.dropped[0].name, 'e_1/bedroom-bed');
  // a world with no single bed among its kinds says that
  const pinned = furnishOps(smallBedroom(), `${S}-4`, beds(false));
  assert.match(pinned.dropped[0].why, /^no bed fits: eden:bed .+; no single bed among the world's kinds$/);
  assert.match(checkedFurnish(pinned, () => ({ ok: true })).detail, /e_1\/bedroom-bed \(no bed fits: /);
});

test('#3961: a furnish whose ways check dropped a piece is still one edit under its claim: refused edit.claimed in another\'s', () => {
  // The kitchen is inside a live claim. The stand-in judge is the claims rule (#3701): a batch under no claim that
  // places anything in the claimed room is refused edit.claimed at that operation; under the claim it is made.
  const judge = (claim) => (ops) => {
    const k = ops.findIndex((o) => o.in === `${S}-4`);
    return claim === 'c:kitchen' || k < 0 ? { ok: true } : { ok: false, code: 'edit.claimed', op: k, detail: 'inside c:kitchen' };
  };
  const ways = furnishOps(house(false), `${S}-2`, { kinds, entries });
  assert.deepEqual(ways.dropped.map((d) => d.name), ['e_1/kitchen-chair-2'], 'the ways check dropped the second chair first');
  const refused = checkedFurnish(ways, judge(undefined));
  assert.deepEqual([refused.ok, refused.code, refused.op, refused.ops], [false, 'edit.claimed', 0, undefined], JSON.stringify(refused));
  const under = checkedFurnish(furnishOps(house(false), `${S}-2`, { kinds, entries }), judge('c:kitchen'));
  assert.equal(under.ops.filter((o) => o.in === `${S}-4`).length, 4, JSON.stringify(under.ops));
  assert.match(under.says, /5 pieces in 1 rooms, 1 dropped; dropped: e_1\/kitchen-chair-2 \(would cut the way/);
});
