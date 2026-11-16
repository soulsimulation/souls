// #1243: a thing's stand point is searched for standing room on its own side of its room's wall, never by distance alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {GodNav, type NavHost, type Thing} from './nav.ts';

type V2 = [number, number];
const ROOM: V2[] = [[-3, -3], [3, -3], [3, 3], [-3, 3]];   // its east wall is x = 3
/** A room with a counter along its east wall: no standing room for x in (1.6, 3.35), so beside a stool at the counter the
 *  nearest clear spot is the wall's outer face (0.75 m east), the nearest inside the room 1 m west. `inside` narrows the
 *  room's clear floor further. The engine's ring search: 0.25 m rings, 8 points more each. */
function fixture(inside: (p: V2) => boolean = () => true) {
  const clear = (p: V2) => p[0] >= 3.35 || (p[0] <= 1.6 && Math.abs(p[0]) < 3 && Math.abs(p[1]) < 3 && inside(p));
  const standableNearV1 = (at: V2, _level?: number, _except?: string, _clear?: number, maxRing = 24): V2 | null => {
    for (let ring = 0; ring <= maxRing; ring++) for (let k = 0, n = Math.max(1, ring * 8); k < n; k++) {
      const a = (k / n) * Math.PI * 2, q: V2 = [Math.round((at[0] + Math.cos(a) * ring * .25) * 1000) / 1000, Math.round((at[1] + Math.sin(a) * ring * .25) * 1000) / 1000];
      if (clear(q)) return q;
    }
    return null;
  };
  const nav = new GodNav({model: {entities: new Map(), ground: () => ({waters: []}), editSeq: 0}, engine: {world: {tick: 0, entities: {}}, standableNearV1},
    levelAt: () => 0, engineOwned: () => false} as unknown as NavHost);
  const room: Thing = {ref: 'house/kitchen', id: 'kitchen', name: 'kitchen', kind: 'room', what: 'room', words: [], at: [0, 0], level: 0, poly: ROOM};
  const stool = (stands: V2[], at: V2 = [2.5, 0]): Thing => ({ref: 'house/kitchen-stool', id: 'stool', name: 'kitchen stool', kind: 'thing', what: 'stool', words: [], at, level: 0, seat: true, stands} as Thing);
  return {nav, room, stool, standableNearV1};
}
const inRoom = (p: V2) => p[0] < 3 && p[0] > -3 && p[1] < 3 && p[1] > -3;

test('A1: a stand with no room beside it finds standing room in its own room, not the wall\'s outer face nearer to it', (t) => {
  const f = fixture(), s: V2 = [2.6, 0], stool = f.stool([s]);
  t.mock.method(f.nav, 'things', () => [f.room, stool]);
  assert.equal(f.standableNearV1(s, 0, undefined, .4, 6)?.[0], 3.35, 'the search by distance alone lands outside');
  const g = f.nav.goal(stool, [10, 0]);
  assert.ok(g && inRoom(g.p), `goal ${JSON.stringify(g)} is in the kitchen`);
  assert.ok(Math.hypot(g.p[0] - s[0], g.p[1] - s[1]) <= 1.5 + 1e-9, 'within the stand\'s 1.5 m');
});

test('A2: a stand with no standing room on its side is passed over for the next one, though it is nearer the Soul', (t) => {
  // the room's clear floor is only its south half: the north stand has none within 1.5 m on its side, the south one has
  const f = fixture((p) => p[1] < -1), north: V2 = [2.6, 1.5], south: V2 = [2.6, -1.5], stool = f.stool([north, south], [2.5, 0]);
  t.mock.method(f.nav, 'things', () => [f.room, stool]);
  assert.ok(f.nav.standPoint(stool, north) === null, 'the north stand reports no standing room');
  const g = f.nav.goal(stool, [10, 3]);
  assert.ok(g && inRoom(g.p) && g.p[1] < -1, `goal ${JSON.stringify(g)} is the south stand's, in the kitchen`);
});

test('A2: with no standing room in the room near any stand, the nearest in the room to the thing; with none, no goal', (t) => {
  const far = fixture((p) => p[0] < -1), stool = far.stool([[2.6, 0]]);
  t.mock.method(far.nav, 'things', () => [far.room, stool]);
  const g = far.nav.goal(stool, [10, 0]);
  assert.ok(g && inRoom(g.p) && g.p[0] < -.9, `goal ${JSON.stringify(g)} is the kitchen's floor, not outside`);
  const none = fixture(() => false), stool2 = none.stool([[2.6, 0]]);
  t.mock.method(none.nav, 'things', () => [none.room, stool2]);
  assert.equal(none.nav.goal(stool2, [10, 0]), null, 'no standing room, rather than a goal outside the kitchen');
});

test('a stand in no room keeps the nearest standing spot', (t) => {
  const f = fixture(), stool = f.stool([[2.6, 0]]);
  t.mock.method(f.nav, 'things', () => [stool]);
  assert.deepEqual(f.nav.goal(stool, [10, 0])?.p, [3.35, 0]);
});
