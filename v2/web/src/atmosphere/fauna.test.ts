// N-V7 (#3690): the fauna's anchors come from any world's own facts, and the creatures follow today's weather rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faunaAnchors, faunaLevels, type AnchorInput } from './anchors.ts';
import { Fauna, MAX_FLOCK_BIRDS, LANDERS, GULLS, DUCKS } from './fauna.ts';

const pond: [number, number][] = [[-60, -40], [-20, -40], [-20, -10], [-60, -10]];
const world = (over: Partial<AnchorInput> = {}): AnchorInput => ({
  extent: [-100, -80, 100, 80],
  heightAt: (x, z) => (Math.abs(x) <= 100 && Math.abs(z) <= 80 ? 2 + x * 0.01 : null),
  water: [{ level: 1.5, points: pond }],
  sources: [
    { pos: [30, 2, 20], sounds: ['water', 'water', 'birds'] },
    { pos: [-40, 2, 50], sounds: ['bees'] },
    { pos: [60, 2, -30], sounds: ['bees'] },
  ],
  ...over,
});
const inPond = (x: number, z: number) => x > -60 && x < -20 && z > -40 && z < -10;

test('A1: flocks circle over the land of any world, from its extent, the same each time', () => {
  const a = faunaAnchors(world()), b = faunaAnchors(world());
  assert.deepEqual(a, b);
  assert.ok(a.flocks.length >= 2 && a.flocks.length <= 8, `${a.flocks.length} flocks`);
  for (const [x, z, r, alt, n] of a.flocks) {
    assert.ok(x >= -100 && x <= 100 && z >= -80 && z <= 80, `flock at ${x},${z} inside the world`);
    assert.ok(!inPond(x, z), 'over land');
    assert.ok(r >= 14 && r <= 26 && alt >= 12 && alt <= 24 && n >= 5 && n <= 7);
  }
  // A bigger world gets more flocks; a world with no ground yet gets none.
  assert.ok(faunaAnchors(world({ extent: [-400, -400, 400, 400], heightAt: () => 0 })).flocks.length > a.flocks.length);
  assert.deepEqual(faunaAnchors(world({ extent: null })).flocks, []);
  // With things standing in one corner, every flock circles near them.
  const town = faunaAnchors(world({ things: [[70, 50], [75, 55], [80, 60]] }));
  assert.ok(town.flocks.length >= 2 && town.flocks.every(([x, z]) => Math.hypot(x - 75, z - 55) < 30), JSON.stringify(town.flocks));
});

test('A2: birds land where birds are heard, butterflies where bees are, ducks and gulls on the water', () => {
  const a = faunaAnchors(world());
  assert.ok(a.perches.length >= 2);
  assert.ok(a.perches.some(([x, , z]) => Math.hypot(x - 30, z - 20) <= 8), 'a perch beside the birdsong');
  assert.equal(a.flowers.length, 2);
  assert.deepEqual(a.flowers.map(([x, , z]) => [x, z]), [[-40, 50], [60, -30]]);
  assert.ok(a.water.length > 0 && a.water.every(([x, y, z]) => inPond(x, z) && y === 1.5), 'ducks on the pond, at its level');
  assert.deepEqual(a.gulls, [-40, -25]);
  // A dry world without sounding things: no ducks, gulls or butterflies, and landers still find ground.
  const dry = faunaAnchors(world({ water: [], sources: [] }));
  assert.deepEqual([dry.water, dry.gulls, dry.flowers], [[], null, []]);
  assert.ok(dry.perches.length >= 1);
});

test('A1: one instanced draw holds every creature, placed from the anchors', () => {
  const f = new Fauna(), a = faunaAnchors(world());
  f.setAnchors(a, () => 2);
  assert.equal(f.placed.landers, LANDERS);
  assert.equal(f.placed.gulls, GULLS);
  assert.equal(f.placed.ducks, DUCKS);
  assert.ok(f.placed.birds > 0 && f.placed.birds <= MAX_FLOCK_BIRDS);
  assert.equal(f.mesh.castShadow, false);
  f.update(100, 1, 1, 1, 1);
  assert.equal(f.mesh.visible, true);
  f.update(100, 0, 0, 0, 0);
  assert.equal(f.mesh.visible, false, 'nothing drawn when nothing is visible');
  f.dispose();
});

test('A2: today\'s weather rules: birds by day and not in rain, butterflies only on fair days, none for reduced motion', () => {
  const fair = { daylight: 1, rain: 0, cloud: 0, wind: 0.2, fogLevel: 0 };
  assert.deepEqual(faunaLevels(fair, false), { birds: 1, butterflies: 1 * (1 - 0.2 * 0.6), ducks: 1 });
  assert.equal(faunaLevels({ ...fair, daylight: 0.1 }, false).birds, 0, 'night');
  assert.ok(faunaLevels({ ...fair, rain: 1 }, false).birds < 0.11);
  assert.equal(faunaLevels({ ...fair, rain: 1 }, false).butterflies, 0);
  assert.deepEqual(faunaLevels(fair, true), { birds: 0, butterflies: 0, ducks: 0 });
});
