// doors-pass/1 (#2365 review): reach (`RouteOpts.doors: 'pass'`) and the connectivity audit count only a closed hand door
// on the ground. A `pass` door upstairs, right above a ground wall, is no way through the wall below it: both say no.
// The same door at ground height is the control: both say yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NavConnectivity } from '../spatial/connectivity.ts';
import { Spatial } from '../spatial/service.ts';
import { GROUND_TILE_M, G_WALK, type GroundField } from '../spatial/ground.ts';
import { HUMAN_PROFILE, type Obstacle, type SpatialScene } from '../spatial/types.ts';
import { addAll, emptyWorld, human } from '../world/factory.ts';

const flatField: GroundField = {
  id: 'doors-pass-upstairs-flat', extent: [-64, -64, 64, 64], wadeMax: 0.6, maxSlope: 1,
  height: () => 0, waterLevel: () => null, medium: () => G_WALK,
  mediaTile: () => new Uint8Array(GROUND_TILE_M * GROUND_TILE_M),
};
/** A pocket walled all round at the ground (30, 30), and a closed hand door's gap box in its south wall at height `y`: at the
 *  ground it fills a 2 m gap in that wall; upstairs it stands over the wall, which runs on unbroken below it. */
function scene(y: number): SpatialScene {
  const wall = (id: string, x: number, z: number, hx: number, hz: number): Obstacle => ({ id, obb: { c: [x, z], half: [hx, hz], yaw: 0 }, y0: 0, y1: 3, kind: 'wall' });
  return {
    bounds: [-64, -64, 64, 64], levels: [{ id: 0, y: 0, label: 'ground' }], surfaces: [], links: [],
    obstacles: [wall('pocket-n', 30, 35, 5.5, .5), wall('pocket-e', 35, 30, .5, 5.5), wall('pocket-w', 25, 30, .5, 5.5),
      ...(y > 0 ? [wall('pocket-s', 30, 25, 5.5, .5)] : [wall('pocket-sw', 26.75, 25, 2.25, .5), wall('pocket-se', 33.25, 25, 2.25, .5)]),
      { id: 'door#door:o', obb: { c: [30, 25], half: [1, .45], yaw: 0 }, y0: y, y1: y + 2.1, kind: 'fixture', door: 'pass' }],
  };
}
function fixture(ground: boolean, y: number) {
  const base = scene(y), world = addAll(emptyWorld('doors-pass-upstairs', base), human('person', 0, 0));
  if (!ground) base.surfaces.unshift({ id: 'base', level: 0, y: 0, obb: { c: [0, 0], half: [64, 64], yaw: 0 } });
  const spatial = new Spatial(base, { cell: .5 }); spatial.sync(world);
  if (ground) spatial.setGround(flatField, world, [[0, 0]], { paged: false });
  const conn = new NavConnectivity(spatial, { anchors: () => [[0, 0]] });
  const reach = () => spatial.route(world, HUMAN_PROFILE, { level: 0, p: [30, 15] }, { level: 0, p: [30, 30] }, { proveUnreachable: true, doors: 'pass' }).ok;
  const inside = () => { spatial.sync(world); conn.update(); return conn.check([{ id: 'in', p: [30, 30], tol: 1 }])[0]; };
  return { reach, inside };
}

for (const ground of [true, false]) {
  test(`a hand door upstairs is no way through the wall below it (${ground ? 'ground' : 'flat'})`, () => {
    const upstairs = fixture(ground, 3.2);
    assert.equal(upstairs.reach(), false, 'reach: no');
    assert.equal(upstairs.inside().code, 'nav.disconnected', 'audit: cut off');
    const onGround = fixture(ground, 0);
    assert.equal(onGround.reach(), true, 'control, the door at ground height: reach yes');
    assert.equal(onGround.inside().ok, true, 'control: joined');
  });
}

// Review of #2397: the upstairs join. A pocket walled all round with ONE closed hand door in its south wall at the ground,
// and stairs inside it to an upper floor. Reach (doors 'pass') goes from the street up to the upper floor and back; the
// audit joins the upper floor to the world and marks it behind the door; the walk graph alone walls it off.
function upstairsScene(): SpatialScene {
  const s = scene(0);
  s.levels.push({ id: 1, y: 3, label: 'upstairs' });
  s.surfaces.push({ id: 'upper', level: 1, y: 3, obb: { c: [30, 32.5], half: [4, 2], yaw: 0 } });
  s.links.push({ id: 'stair', kind: 'stairs', from: { level: 0, p: [28, 27], y: 0 }, to: { level: 1, p: [28, 31.5], y: 3 }, width: 1.2, heading: Math.PI / 2, path: [[28, 0, 27], [28, 3, 31.5]], usable: true });
  return s;
}
for (const ground of [true, false]) {
  test(`one ground door joins the floor above it: reach and the audit (${ground ? 'ground' : 'flat'})`, () => {
    const base = upstairsScene(), world = addAll(emptyWorld('doors-pass-upstairs-join', base), human('person', 0, 0));
    if (!ground) base.surfaces.unshift({ id: 'base', level: 0, y: 0, obb: { c: [0, 0], half: [64, 64], yaw: 0 } });
    const spatial = new Spatial(base, { cell: .5 }); spatial.sync(world);
    if (ground) spatial.setGround(flatField, world, [[0, 0]], { paged: false });
    const route = (a: { level: number; p: [number, number] }, b: { level: number; p: [number, number] }, doors?: 'pass') => spatial.route(world, HUMAN_PROFILE, a, b, { proveUnreachable: true, ...(doors ? { doors } : {}) }).ok;
    const street = { level: 0, p: [30, 15] as [number, number] }, upper = { level: 1, p: [31, 33] as [number, number] };
    assert.equal(route(street, upper), false, 'the walk graph walls it off');
    assert.equal(route(street, upper, 'pass'), true, 'reach: up through the door');
    assert.equal(route(upper, street, 'pass'), true, 'reach: and down and out');
    const conn = new NavConnectivity(spatial, { anchors: () => [[0, 0]] }); conn.update();
    const [up, out] = conn.check([{ id: 'up', p: upper.p, level: 1, tol: 1 }, { id: 'out', p: street.p, tol: 1 }]);
    assert.equal(up.ok, true, 'audit: the upper floor is joined');
    assert.equal(up.door, true, 'behind the door');
    assert.equal(out.ok, true); assert.equal(out.door, undefined, 'the street is not behind a door');
  });
}

// Review of #2397: slope naming. On ground whose terrain stands 0.8 m up, a closed hand door's gap (its foot on the terrain)
// is named by a failed search on the composed ground grid (whose own `y` is a nominal 0), as the passage needs; any other
// obstacle is named by the grid's floor as before (the change is scoped to `door: 'pass'`).
const raised: GroundField = { ...flatField, id: 'doors-pass-raised', height: () => 0.8 };
for (const pass of [true, false]) {
  test(`a failed search on raised ground names a closed hand door (${pass ? 'pass door' : 'plain solid: unchanged'})`, () => {
    const base = scene(0);
    for (const o of base.obstacles) { o.y0 += 0.8; o.y1 += 0.8; if (!pass) delete o.door; }
    const world = addAll(emptyWorld('doors-pass-raised', base), human('person', 0, 0));
    const spatial = new Spatial(base, { cell: .5 }); spatial.sync(world);
    spatial.setGround(raised, world, [[0, 0]], { paged: false });
    const r = spatial.route(world, HUMAN_PROFILE, { level: 0, p: [30, 15] }, { level: 0, p: [30, 30] }, { nameObstacles: (id) => id.includes('#door:') });
    assert.equal(r.ok, false);
    const subjects = r.ok ? [] : r.diagnostic.subjects ?? [];
    assert.equal(subjects.includes('door#door:o'), pass, pass ? 'the door is named at the terrain height' : 'a plain solid is named only at the grid floor, as before');
  });
}
