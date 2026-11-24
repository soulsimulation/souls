// R14: tiles baked ahead for one Ground (a release handover's standby) reach every Terrain made from a Ground with the same
// content, bit-identical to baking them there; a Ground with other content bakes its own; dropping them ends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, dropPrebakedTiles, emptyGround, prebakeTiles, type Ground } from './index.ts';

const ground = (): Ground => ({ ...emptyGround(256, 0), landforms: [{ id: 'hill', kind: 'bump', c: [10, -20], r: 40, h: 12, peak: 1 }] });

test('R14: prebaked tiles are given to an equal Ground, identical to its own bake, and to nothing else', (t) => {
  t.after(dropPrebakedTiles);
  const fresh = new Terrain(ground());
  const n = prebakeTiles(ground());
  assert.equal(n, 25, 'every tile the 256 m extent reaches (-2..2 by -2..2, of 64 m)');
  const given = new Terrain(JSON.parse(JSON.stringify(ground())));   // the same content, as the boot reads it again
  assert.equal(given.cachedTiles, n, 'a Terrain of the same content starts with them');
  for (let tz = -2; tz <= 2; tz++) for (let tx = -2; tx <= 2; tx++) assert.deepEqual(given.tile(tx, tz), fresh.tile(tx, tz), `tile ${tx},${tz} is bit-identical`);
  assert.equal(given.sample(12.5, -18.25), fresh.sample(12.5, -18.25));
  const other = new Terrain({ ...ground(), base: 1 });
  assert.equal(other.cachedTiles, 0, 'a Ground with other content bakes its own');
  dropPrebakedTiles();
  assert.equal(new Terrain(ground()).cachedTiles, 0, 'none once dropped');
});
