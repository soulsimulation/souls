// A world map's `with` rows as facts things (with.ts): Eden's guitar in its stand's cradle, its bass in its stand, a
// piano's bench beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { entriesIn, withMap, withThings } from './with.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entries = entriesIn(`${root}content/kinds`);
const withOf = withMap(`${root}content/worlds/eden/map.json`);
const place = (p: { x: number; y: number; z: number; yaw: number }) => [Math.round(p.x * 1000), Math.round(p.y * 1000), Math.round(p.z * 1000), Math.round((p.yaw * 180_000) / Math.PI)];

test("Eden's map holds a guitar in each guitar stand's cradle and a bass in each bass stand's", () => {
  for (const [def, holder, made] of [['eden-guitar-stand@1', 'eden:guitar_stand', 'eden:guitar'], ['eden-bass-stand@1', 'eden:bass_stand', 'eden:bass_guitar']]) {
    const rows = withOf(def);
    assert.equal(rows.length, 1, def);
    const [w] = withThings({ id: 'e_stand', name: 'stage-guitar', entry: holder, parent: null, pose: { x: 89.9, y: 0, z: -30.3, yaw: Math.PI }, world: { x: 89.9, y: 0, z: -30.3, yaw: Math.PI }, scale: 1 }, rows, entries, place);
    assert.deepEqual(w.thing, { id: 'e_stand-with-1', def: made, ref: `entry:${made}`, name: `stage-guitar-${made.split(':')[1]}`, entry: made, scale_ppm: 1_000_000,
      parent: 'e_stand', slot: { n: 1, id: 'cradle' }, pose: [0, 300, 0, 0], world: [89900, 300, -30300, 180000] }, 'in the cradle, slot 1 as the stand\'s entry numbers it, at its point');
    assert.deepEqual(w.slot, { n: 1, id: 'cradle', kind: 'thing', at: [0, 300, 0], yaw: 0 }, 'the stand\'s slot, which its def does not bake');
    assert.equal(w.kind.name, made, 'a kind named as its entry, so the world pins it and the stand\'s take finds it');
    assert.match(w.kind.hash, /^[0-9a-f]{64}$/);
  }
});

test("a piano's bench stands beside it, in its room, turned with it", () => {
  const rows = withOf('core/piano@1');
  assert.equal(rows[0]?.entry, 'eden:piano_bench');
  const [w] = withThings({ id: 'e_piano', name: 'parlour-piano', entry: 'eden:piano', parent: 'e_house', slot: { room: 'parlour' }, pose: { x: 1, y: 0, z: 2, yaw: Math.PI / 2 }, world: { x: 11, y: 0, z: 22, yaw: Math.PI / 2 }, scale: 1 }, rows, entries, place);
  // at_mm [0, 0, 650] in the piano's frame: its +z is the room's +x when it is turned a quarter
  assert.deepEqual(w.thing.pose, [1650, 0, 2000, 90_000]);
  assert.deepEqual(w.thing.world, [11650, 0, 22000, 90_000]);
  assert.deepEqual([w.thing.parent, w.thing.slot], ['e_house', { room: 'parlour' }], "the piano's own parent and room");
  const [inSlot] = withThings({ id: 'e_piano', entry: 'eden:piano', parent: 'e_shelf', slot: { n: 2, id: 'top' }, pose: { x: 0, y: 0, z: 0, yaw: 0 }, world: { x: 0, y: 0, z: 0, yaw: 0 }, scale: 1 }, rows, entries, place);
  assert.equal(inSlot.thing.slot, undefined, 'never into a slot one thing holds: a plain child at its own place');
});

test('a row naming an entry or a slot the content does not have is refused', () => {
  const holder = { id: 'e_x', entry: 'eden:guitar_stand', parent: null, pose: { x: 0, y: 0, z: 0, yaw: 0 }, world: { x: 0, y: 0, z: 0, yaw: 0 }, scale: 1 };
  assert.throws(() => withThings(holder, [{ entry: 'eden:no_such_thing', slot: 'cradle' }], entries, place), /does not have/);
  assert.throws(() => withThings(holder, [{ entry: 'eden:guitar', slot: 'shelf' }], entries, place), /does not have/);
  assert.deepEqual(withOf('core-chair@1'), [], 'a row without `with` adds nothing');
});
