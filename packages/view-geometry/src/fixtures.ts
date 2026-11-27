import type { ViewGeometry, ViewMesh, ViewMaterial, Vec3 } from './types.ts';
export const MATERIALS: readonly ViewMaterial[] = [{ id: 'wall', occlusion: 'block', clearance: 'block', side: 'both' }, { id: 'glass', occlusion: 'pass', clearance: 'block', side: 'both' }, { id: 'foliage', occlusion: 'unknown', clearance: 'pass', side: 'both' }, { id: 'front', occlusion: 'block', clearance: 'block', side: 'front' }];
export function box(id: string, min: Vec3, max: Vec3, material = 'wall'): ViewMesh {
    const [x, y, z] = min, [X, Y, Z] = max;
    return { id, node: null, material, topology: 'convex-solid', vertices: [[x, y, z], [X, y, z], [X, Y, z], [x, Y, z], [x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]], triangles: [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]] };
}
export function scene(meshes: readonly ViewMesh[] = []): ViewGeometry { return { schema: 'view-geometry/1', version: { world: 'fixture-world', epoch: 'fixture', revision: '1', sourceHash: 'a'.repeat(64), overlayRevision: 'static' }, units: 'm', frame: 'world-y-up-rh', coverage: 'complete', materials: MATERIALS, nodes: [], meshes, rooms: [], openings: [] }; }
export function panel(id = 'thin', material = 'wall'): ViewMesh { return { id, node: null, material, topology: 'surface', vertices: [[-2, 0, 0], [2, 0, 0], [2, 3, 0], [-2, 3, 0]], triangles: [[0, 1, 2], [0, 2, 3]] }; }
