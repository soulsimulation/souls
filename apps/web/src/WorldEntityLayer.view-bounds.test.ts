// The arrival framing's box (WorldEntityLayer.viewBounds) holds each placed thing's whole footprint, not only 10 m round
// its origin: RnA Studio (one building at the origin, 53 x 44 m) opened with the eye 2 m from its south wall.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { entityArrivalPose } from './entity-arrival.ts';

type Box = { c: [number, number]; half: [number, number]; yaw: number; y0: number; y1: number };
async function layerWith(things: { id: string; p: [number, number]; boxes: Box[] | 'throws' }[]) {
  const index = new URL('./gen-mesh/index.ts', import.meta.url).href;
  const hook = registerHooks({ load(url, context, next) { return url === index ? { format: 'module', shortCircuit: true, source: "export { meshFor } from './registry.ts';" } : next(url, context); } });
  const { WorldEntityLayer } = await import('./WorldEntityLayer.ts').finally(() => hook.deregister());
  const layer = new WorldEntityLayer((p) => p);
  const byId = new Map(things.map((t) => [t.id, t]));
  (layer as unknown as { model: unknown }).model = {
    constants: { extent: 1000 },
    entities: new Map(things.map((t) => [t.id, { id: t.id, def: 'd', in: { parent: 'world' } }])),
    resolvedDef: () => ({ components: {}, make: { kind: 'none' } }),
    worldPose: (e: { id: string }) => ({ x: byId.get(e.id)!.p[0], y: 0, z: byId.get(e.id)!.p[1], yaw: 0, s: 1 }),
    footprint: (e: { id: string }) => { const b = byId.get(e.id)!.boxes; if (b === 'throws') throw new Error('bake'); return b; },
  };
  return layer;
}

test('a big building at the origin is framed from outside its walls', async () => {
  // RnA Studio's walls, as two long boxes (x -29..24, z -29..15)
  const wall = (cx: number, cz: number, hx: number, hz: number): Box => ({ c: [cx, cz], half: [hx, hz], yaw: 0, y0: 0, y1: 4 });
  const layer = await layerWith([{ id: 'studio', p: [0, 0], boxes: [wall(-2.5, 15, 26.5, 0.2), wall(-2.5, -29, 26.5, 0.2), wall(-29, -7, 0.2, 22), wall(24, -7, 0.2, 22)] }]);
  const b = layer.viewBounds();
  assert.ok(b[0] <= -29 && b[1] <= -29 && b[2] >= 24 && b[3] >= 15, `bounds ${b}`);
  const pose = entityArrivalPose(b, 1, () => 0, 45, 16 / 9, 1, null);
  assert.ok(pose.eye[2] > 15 + 20, `the eye stands well south of the south wall: ${pose.eye}`);
  layer.dispose();
});

test('a small thing keeps its 10 m box, and one whose footprint cannot be worked out keeps it too', async () => {
  const layer = await layerWith([{ id: 'bench', p: [5, 5], boxes: [{ c: [5, 5], half: [1, 0.3], yaw: 0, y0: 0, y1: 1 }] }, { id: 'odd', p: [-5, -5], boxes: 'throws' }]);
  assert.deepEqual(layer.viewBounds(), [-15, -15, 15, 15]);
  layer.dispose();
});
