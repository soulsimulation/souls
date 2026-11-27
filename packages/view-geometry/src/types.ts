/** Read-only depicted geometry, never collision/navigation or secret-world authority.
 * Metres, right-handed world XYZ with +Y up. Matrices are column-major affine local-to-parent.
 * Vertices are mesh-local; opening polygons/room bounds are world-space context, not invented cutouts.
 * Real holes must exist in the supplied triangles. Source hashes bind externally verified source receipts;
 * they are provenance labels, not a digest this module invents from geometry. */
export type Vec3 = readonly [
    number,
    number,
    number
];
export type Mat4 = readonly number[];
export type Bounds = Readonly<{
    min: Vec3;
    max: Vec3;
}>;
export type GeometryVersion = Readonly<{
    world: string;
    epoch: string;
    revision: string;
    sourceHash: string;
    overlayRevision: string;
}>;
export type ViewMaterial = Readonly<{
    id: string;
    occlusion: 'block' | 'pass' | 'unknown';
    clearance: 'block' | 'pass' | 'unknown';
    /** Occlusion respects transformed vertex winding. Clearance always tests both sides, including zero-thickness walls. */
    side: 'front' | 'back' | 'both';
}>;
export type TransformNode = Readonly<{
    id: string;
    parent: string | null;
    matrix: Mat4;
}>;
export type ViewMesh = Readonly<{
    id: string;
    node: string | null;
    material: string;
    /** World-transformed triangles require cross magnitude / longest edge squared > 1e-6; unsupported conditioning is refused. */
    vertices: readonly Vec3[];
    triangles: readonly (readonly [
        number,
        number,
        number
    ])[];
    /** surface: only supplied faces have occupancy. convex-solid: validated closed convex volume, including its interior.
     * unknown-solid: faces are usable, but clearance overlapping its bounds cannot certify clear interior occupancy. */
    topology: 'surface' | 'convex-solid' | 'unknown-solid';
}>;
export type ViewGeometry = Readonly<{
    schema: 'view-geometry/1';
    version: GeometryVersion;
    units: 'm';
    frame: 'world-y-up-rh';
    coverage: 'complete' | 'partial';
    materials: readonly ViewMaterial[];
    nodes: readonly TransformNode[];
    meshes: readonly ViewMesh[];
    rooms: readonly Readonly<{
        id: string;
        bounds: Bounds;
    }>[];
    openings: readonly Readonly<{
        id: string;
        fromRoom: string;
        toRoom: string | null;
        polygon: readonly Vec3[];
        kind: 'door' | 'window';
    }>[];
}>;
/** Dynamic meshes are separate from static meshes; replacing an overlay never mutates or rebuilds the static index.
 * Adapter must remove moving objects from static geometry, publish all relevant moving surfaces, and change revision.
 * Exact base version prevents borrowing an overlay from another world/epoch/source. No live object references. */
export type GeometryOverlay = Readonly<{
    base: GeometryVersion;
    revision: string;
    coverage: 'complete' | 'partial';
    nodes: readonly TransformNode[];
    meshes: readonly ViewMesh[];
}>;
export type Query = Readonly<{
    version: GeometryVersion;
    from: Vec3;
    to: Vec3;
    maxWork: number;
}>;
export type ClearanceQuery = Query & Readonly<{
    radiusM: number;
}>;
export type QueryResult = Readonly<{
    status: 'clear' | 'blocked' | 'unknown';
    reason: 'no-hit' | 'surface-hit' | 'inside-solid' | 'partial-coverage' | 'uncertain-material' | 'unsupported-occupancy' | 'numeric-boundary' | 'work-limit' | 'version-mismatch' | 'invalid-query';
    version: GeometryVersion;
    work: number;
    candidates: number;
    triangles: number;
    mesh?: string;
}>;
export type GeometryStorage = Readonly<{
    meshes: number;
    triangles: number;
    nodes: number;
    /** Exact retained typed-array byteLengths, including reusable query scratch. Excludes JS objects/engine overhead. */
    numericBufferBytes: number;
    /** UTF8 bytes of serialized retained plain inputs, NOT their JS heap footprint. */
    sourceJsonUtf8Bytes: number;
    staticShared: boolean;
}>;
export type ViewGeometryProvider = Readonly<{
    version: GeometryVersion;
    geometry: ViewGeometry;
    storage: GeometryStorage;
    segment(query: Query): QueryResult;
    /** Exact swept sphere against supplied triangle surfaces; convex-solid interiors also block. */
    clearance(query: ClearanceQuery): QueryResult;
    withOverlay(overlay: GeometryOverlay): GeometryBuild;
}>;
export type GeometryBuild = Readonly<{
    status: 'ready';
    provider: ViewGeometryProvider;
}> | Readonly<{
    status: 'rejected';
    reason: string;
}>;
