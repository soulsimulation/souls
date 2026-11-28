// A part's ways as a Soul sees them (`ways.mjs`): a built deck bay's frame, its beam at 1.8 m and a sheet over its
// inner face, as the copy's rows hold them (`../brief/copy.mjs`: floors' levels and surfaces, slots, boxes, links).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { brief } from '../brief/brief.mjs';
import { braced, climbNamed, climbOffers, nothingToStandOn, placeAt, placesIn, rowsWithPlaces, waysOf } from './ways.mjs';
import { find } from '../find/find.mjs';
import { help, requestOf } from '../cli/souls.mjs';

const ONE = 2 ** 30;
const rect = (y, [x, z], [w, d]) => [[y, [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]]]];
const FRAME = {
  kind: 'mars:rack_upright_12ft',
  geometry: {
    floors: [{ top_mm: 1800, size_mm: [1144, 900], at_mm: [0, -488], while_joined: true }, { top_mm: 1800, size_mm: [1144, 900], at_mm: [0, 488], while_joined: true }],
    ladders: [{ face: 'back', top_mm: 500 }, { face: 'back', top_mm: 1800 }, { face: 'front', top_mm: 500 }, { face: 'front', top_mm: 1800 }],
  },
};
const SHEET = { kind: 'mars:plywood_sheet', geometry: { floors: [{ top_mm: 19, size_mm: [1829, 1219] }] } };
const FLIGHT = { kind: 'mars:stair_flight', geometry: { stairs: [{ from_mm: [-1250, 0], to_mm: [1250, 0], bottom_mm: 0, top_mm: 2010 }], floors: [{ top_mm: 2010, size_mm: [500, 900], at_mm: [1500, 0] }] } };
const kinds = { [FRAME.kind]: FRAME, [SHEET.kind]: SHEET, [FLIGHT.kind]: FLIGHT };

/** A built bay on the ground: frame 1 at its -z end, a high beam joined to it at 1.8 m, and (with `sheet`) a sheet
 *  seated at 1.8 m over the frame's inner face. `beam`: the beam's height, mm, or null for none. As the copy holds
 *  them, a seated part's pose is in its slot's frame (zero), its place the bay's slot's. */
function bay({ beam = 1800, sheet = true, linked = true } = {}) {
  const rows = new Map();
  const add = (r) => rows.set(r.id, { path: [], children: 0, ...r });
  add({ id: 'g-1', name: 'ground 1', kind: 'eden:ground', parent: null });
  add({ id: 'b-2', name: 'bay', kind: 'mars:deck_bay', parent: 'g-1', pos: [65_000_000, 0, -24_000_000], rot: [ONE, 0, 0, 0],
    slots: [[1, 0, 0, -1448, 0, 1], [3, -572, 500, 0, 0, 1], [5, -572, 1800, 0, 0, 1], [11, 0, 1800, -612, 0, 1]] });
  add({ id: 'f-3', name: 'frame-1', kind: FRAME.kind, parent: 'b-2', pos: [0, 0, 0], rot: [ONE, 0, 0, 0], slot: 1, solids: [[0, 0, 572, 38, 0, 0, 3658]] });
  for (const [n, id] of [[0, 'f-4'], [1, 'f-5'], [2, 'f-6'], [3, 'f-7'], [4, 'f-8']]) {
    const f = FRAME.geometry.floors[n - 1];
    add({ id, name: `floor ${id.slice(2)}`, kind: 'eden:floor', parent: 'f-3', level: n, ...(f ? { surfaces: rect(f.top_mm, f.at_mm, f.size_mm) } : {}) });
  }
  if (beam !== null) add({ id: 'm-9', name: 'beam-high-l', kind: 'mars:deck_beam', parent: 'b-2', pos: [0, 0, 0], rot: [ONE, 0, 0, 0], slot: beam === 500 ? 3 : 5, solids: [[0, 0, 38, 1448, 0, -70, 70]], ...(linked ? { links: ['f-3'] } : {}) });
  if (sheet) {
    add({ id: 's-10', name: 'sheet-1', kind: SHEET.kind, parent: 'b-2', pos: [0, 0, 0], rot: [ONE, 0, 0, 0], slot: 11 });
    add({ id: 's-11', name: 'floor 11', kind: 'eden:floor', parent: 's-10', level: 1, surfaces: rect(19, [0, 0], [1829, 1219]) });
  }
  add({ id: 't-12', name: 'flight', kind: FLIGHT.kind, parent: 'g-1', pos: [62_000_000, 0, -24_572_000], rot: [ONE, 0, 0, 0] });
  add({ id: 't-13', name: 'floor 13', kind: 'eden:floor', parent: 't-12', level: 0 });
  add({ id: 't-14', name: 'floor 14', kind: 'eden:floor', parent: 't-12', level: 1, surfaces: rect(2010, [1500, 0], [500, 900]) });
  add({ id: 'me-15', name: 'Oriel', kind: 'souls:body', parent: 'g-1', pos: [65_000_000, 0, -28_000_000], soul: 'soul-1' });
  return rows;
}

test('a built bay: frame 1 shows its outer standing place and the ladder up to it; the inner one under the sheet is not there', () => {
  const rows = bay(), w = waysOf(rows, rows.get('f-3'), FRAME);
  assert.deepEqual(w.places, [{ id: 'f-5', name: 'standing place, 1.8 m, back face of frame-1', point: [0, 1_800_000, -488_000], standing: true, of: 'f-3' }]);
  assert.deepEqual(w.ways, [{ name: 'ladder up frame-1\'s back face, to its 1.8 m standing place', kind: 'ladder', to: 'f-5' }]);
  assert.equal(braced(rows, rows.get('f-6'), rows.get('f-3')), false, 'the inner face, under the sheet');
  // Without the sheet, both faces stand; the 0.5 m ladders reach no place and are not ways up.
  const open = bay({ sheet: false }), o = waysOf(open, open.get('f-3'), FRAME);
  assert.deepEqual(o.places.map((p) => p.name), ['standing place, 1.8 m, back face of frame-1', 'standing place, 1.8 m, front face of frame-1']);
  assert.deepEqual(o.ways.map((x) => x.to), ['f-5', 'f-6']);
});

test('a standing place is there only while braced: no beam, a beam not joined, or a beam at another height leaves none', () => {
  for (const [what, rows] of [['no beam', bay({ beam: null })], ['not joined', bay({ linked: false })], ['at 0.5 m', bay({ beam: 500 })]]) {
    const w = waysOf(rows, rows.get('f-3'), FRAME);
    assert.deepEqual([w.places, w.ways], [[], []], what);
  }
});

test('a sheet shows its deck and a flight its top and the stair up to it; each walks to its own point', () => {
  const rows = bay();
  assert.deepEqual(waysOf(rows, rows.get('s-10'), SHEET).places, [{ id: 's-11', name: 'deck of sheet-1', point: [0, 19_000, 0], standing: false, of: 's-10' }]);
  const f = waysOf(rows, rows.get('t-12'), FLIGHT);
  assert.deepEqual(f.places.map((p) => [p.name, p.point]), [['top of flight', [1_500_000, 2_010_000, 0]]]);
  assert.deepEqual(f.ways, [{ name: 'stair up flight, to top of flight', kind: 'stair', to: 't-14' }]);
  assert.equal(placeAt(rows, kinds, 's-11').name, 'deck of sheet-1');
  assert.equal(placeAt(rows, kinds, 'f-6'), null, 'a place not there now is none');
  assert.equal(placeAt(rows, kinds, 'f-3'), null, 'a part is no place');
});

test('object <frame> offers climb to its standing place, sent as a walk to it', () => {
  const rows = bay(), w = waysOf(rows, rows.get('f-3'), FRAME);
  assert.deepEqual(climbOffers(w), [{ name: 'climb to standing place, 1.8 m, back face of frame-1', act: 'walk:f-5', place: 'f-5', usage: 'act f-5' }]);
  assert.deepEqual(climbOffers(waysOf(rows, rows.get('s-10'), SHEET)), [], 'a deck is walked to, not climbed');
});

test('find and query find a place by its name and by the way up to it; look lists the places in the room', () => {
  const rows = bay(), named = rowsWithPlaces(rows, kinds);
  assert.equal(find(named, 'standing', { limit: 3 }).found[0]?.id, 'f-5');
  assert.equal(find(named, 'ladder', { limit: 3 }).found[0]?.id, 'f-5');
  assert.equal(find(named, 'deck', { limit: 3 }).found[0]?.id, 's-11');
  assert.equal(rows.get('f-5').name, 'floor 5', 'the copy\'s own rows are left as they are');
  const b = brief(rows, { me: 'me-15', places: placesIn(rows, kinds) });
  for (const name of ['standing place, 1.8 m, back face of frame-1', 'deck of sheet-1', 'top of flight']) assert.ok(b.here.some((h) => h.startsWith(name)), `${name} in ${JSON.stringify(b.here)}`);
  // Standing on it, the Soul's room is the place, by its name.
  rows.set('me-15', { ...rows.get('me-15'), parent: 'f-5' });
  assert.equal(brief(rows, { me: 'me-15', places: placesIn(rows, kinds) }).room.name, 'standing place, 1.8 m, back face of frame-1');
});

test('the command: object <frame> climb to <place> names the offer by the place id or its name; help names climb to once', () => {
  const rows = bay(), offers = climbOffers(waysOf(rows, rows.get('f-3'), FRAME));
  assert.deepEqual(requestOf(['object', 'f-3', 'climb', 'to', 'f-5']).req, { op: 'object', this: 'f-3', action: 'climb', args: ['to', 'f-5'] });
  assert.equal(climbNamed(offers, 'climb', ['to', 'f-5']).act, 'walk:f-5');
  assert.equal(climbNamed(offers, 'climb to standing place, 1.8 m, back face of frame-1').act, 'walk:f-5');
  assert.equal(climbNamed(offers, 'climb', ['to', 'f-6']), null, 'a place not there now is no offer');
  assert.equal(climbNamed(offers, 'walk'), undefined, 'not a climb');
  const h = help(undefined, undefined, undefined);
  assert.equal(JSON.stringify(h).split('climb to').length - 1, 1, 'climb to, once');
});

// N14: the 12 ft frame as its kind now declares it, ladders only (no standing place of its own), in a deck bay whose
// sheet is seated as deck_bay's s1 (1.991 m, its top 2.01 m up).
const FRAME_N14 = { kind: 'mars:rack_upright_12ft', geometry: { bounds_mm: [1219, 3658, 76], ladders: [{ face: 'back', bottom_mm: 0, top_mm: 1800, width_mm: 900, run_mm: 330 }, { face: 'front', bottom_mm: 0, top_mm: 1800, width_mm: 900, run_mm: 330 }] } };
function deckBay({ sheet = true } = {}) {
  const rows = new Map();
  const add = (r) => rows.set(r.id, { path: [], children: 0, ...r });
  add({ id: 'g-1', name: 'ground 1', kind: 'eden:ground', parent: null });
  add({ id: 'b-2', name: 'bay', kind: 'mars:deck_bay', parent: 'g-1', pos: [65_000_000, 0, -24_000_000], rot: [ONE, 0, 0, 0],
    slots: [[1, 0, 0, -1448, 0, 1], [11, 0, 1991, -612, 0, 1]] });
  add({ id: 'f-3', name: 'frame-1', kind: FRAME_N14.kind, parent: 'b-2', pos: [0, 0, 0], rot: [ONE, 0, 0, 0], slot: 1 });
  for (const [n, id] of [[0, 'f-4'], [1, 'f-5'], [2, 'f-6']]) add({ id, name: `floor ${id.slice(2)}`, kind: 'eden:floor', parent: 'f-3', level: n });
  if (sheet) {
    add({ id: 's-10', name: 'sheet-1', kind: SHEET.kind, parent: 'b-2', pos: [0, 0, 0], rot: [ONE, 0, 0, 0], slot: 11 });
    add({ id: 's-11', name: 'floor 11', kind: 'eden:floor', parent: 's-10', level: 1, surfaces: rect(19, [0, 0], [1829, 1219]) });
  }
  return rows;
}
const kindsN14 = { ...kinds, [FRAME_N14.kind]: FRAME_N14 };

test('N14: a frame with a deck on it offers its outer ladder up onto the deck, and no standing place of its own', () => {
  const rows = deckBay(), w = waysOf(rows, rows.get('f-3'), FRAME_N14, undefined, kindsN14);
  assert.deepEqual(w.places, []);
  assert.deepEqual(w.ways, [{ name: 'ladder up frame-1\'s back face, to deck of sheet-1', kind: 'ladder', to: 's-11' }]);
  assert.deepEqual(climbOffers(w), [{ name: 'climb to deck of sheet-1', act: 'walk:s-11', place: 's-11', usage: 'act s-11' }]);
  assert.equal(nothingToStandOn(w, 'f-3'), null);
});

test('N14: a frame with no deck on it has nothing to stand on at its ladders\' tops: a climb is refused by name', () => {
  const rows = deckBay({ sheet: false }), w = waysOf(rows, rows.get('f-3'), FRAME_N14, undefined, kindsN14);
  assert.deepEqual([w.places, w.ways, climbOffers(w)], [[], [], []]);
  assert.equal(nothingToStandOn(w, 'f-3').code, 'climb.nothing-to-stand-on');
});
