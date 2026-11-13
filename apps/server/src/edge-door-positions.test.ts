// #2261: a building's doors, with position, level and facing, in the catalog and in `inspect`. Eden 2026, the real genesis.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {ledgerCatalog} from './edge/catalog/routes.ts';
import {inspectFrame} from './edge/perception/inspect.ts';

test('#2261 A2: Eden 2026 gives the Library door and the Vineyard Villa\'s off-centre door, in the catalog and in inspect', {timeout: 300000}, async t => {
  const w = await bootEden(); t.after(w.close);
  const places = ledgerCatalog(w.edge).payload.places, place = (id: string) => places.find(p => p.id === id)!;
  // the Library: the middle of its south wall, where #2224 read it from a walk in (x 74)
  assert.deepEqual(place('g-eden-library-1').doors, [{at: [74, -2.9], level: 0, facing: 'south', approach: [74, -1.9]}]);
  // the Vineyard Villa: its south wall runs x 62.9..79.1 (middle 71); its door is 2 m east of the middle
  const villa = place('g-region-vineyard-villa'), xs = villa.outline!.map(v => v[0]), middle = (Math.min(...xs) + Math.max(...xs)) / 2;
  assert.deepEqual(villa.doors, [{at: [73, -147.1], level: 0, facing: 'south', approach: [73, -146.1]}]);
  assert.ok(Math.abs(villa.doors![0]!.at[0] - middle) >= 1.9, `${middle}`);
  // a building with two doors gives both
  assert.deepEqual(place('g-eden-classroom-1').doors?.map(d => d.facing), ['south', 'north']);
  // inspect gives what the catalog gives, each door with its ready move to stand in front of it
  assert.deepEqual(inspectFrame(w.edge, w.soul, 'g-eden-library-1').doors, [{...place('g-eden-library-1').doors![0]!, act: 'walk-to:here {"at":[74,-1.9]}'}]);
  // a place that is not a building has none
  assert.equal(places.filter(p => p.doors && p.kind !== 'building').length, 0);
});
