// #2383 (the Eden 2026 bakery walk ran into the library and back out): the coarse ground path runs through enterable
// buildings, so a long walk's hop waypoint could lie on a building's floor. With the building's door open the fine hop
// walked in through it, and the next hop walked back out the same door. The waypoint now moves on along the coarse path
// off the floor (here: to the goal itself, just past the building), so the walk goes round the building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spatial } from '../spatial/service.ts';
import { GROUND_TILE_M, G_WALK, type GroundField } from '../spatial/ground.ts';
import { HUMAN_PROFILE, type Obstacle, type SpatialScene } from '../spatial/types.ts';
import { addAll, emptyWorld, human } from '../world/factory.ts';

const flatField: GroundField = {
  id: 'ground-hop-outdoors-flat', extent: [-128, -128, 128, 128], wadeMax: 0.6, maxSlope: 1,
  height: () => 0, waterLevel: () => null, medium: () => G_WALK,
  mediaTile: () => new Uint8Array(GROUND_TILE_M * GROUND_TILE_M),
};
/** A hall 10 x 8 m (x -5..5, z 3..11) with a floor slab and one open 2 m doorway in its north wall, facing the start. */
const wall = (id: string, x: number, z: number, hx: number, hz: number): Obstacle => ({ id, obb: { c: [x, z], half: [hx, hz], yaw: 0 }, y0: 0, y1: 3, kind: 'wall' });
const hall = () => ({
  obstacles: [wall('hall-s', 0, 3, 5.2, .2), wall('hall-e', 5, 7, .2, 4.2), wall('hall-w', -5, 7, .2, 4.2), wall('hall-nw', -3, 11, 2, .2), wall('hall-ne', 3, 11, 2, .2)],
  surfaces: [{ id: 'hall#f0', level: 0, y: 0.1, obb: { c: [0, 7] as [number, number], half: [4.8, 3.8] as [number, number], yaw: 0 } }],
});
const inHall = ([x, z]: number[]) => x > -4.8 && x < 4.8 && z > 3.2 && z < 10.8;

for (const paged of [true, false]) test(`a long walk past a building with an open door does not walk into it (${paged ? 'paged' : 'unpaged'})`, () => {
  const base: SpatialScene = { bounds: [-128, -128, 128, 128], levels: [{ id: 0, y: 0, label: 'ground' }], surfaces: [], links: [], obstacles: [] };
  const world = addAll(emptyWorld('ground-hop-outdoors', base), human('walker', 0, 52));
  const spatial = new Spatial(base, { cell: .1, contributors: [hall] });
  spatial.sync(world);
  spatial.setGround(flatField, world, [[0, 52], [0, 0]], { paged });
  spatial.sync(world);
  // 52 m on the straight line through the hall to a point 3 m past its far (doorless) wall: the first hop's 48 m mark is
  // on the hall's floor
  const r = spatial.route(world, HUMAN_PROFILE, { level: 0, p: [0, 52] }, { level: 0, p: [0, 0] }, {});
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  if (!r.ok) return;
  const points = r.route.legs.flatMap((l) => (l.kind === 'walk' ? l.points : []));
  assert.deepEqual(points.filter(inHall), [], 'no point of the route is inside the hall');
  assert.ok(Math.hypot(points.at(-1)![0], points.at(-1)![1]) < 0.5, `the route ends at the goal: ${points.at(-1)}`);
});
