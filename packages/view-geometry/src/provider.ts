import type { Vec3, Mat4, GeometryVersion, ViewGeometry, GeometryOverlay, GeometryBuild, ViewGeometryProvider, ViewMesh, ViewMaterial, Query, ClearanceQuery, QueryResult, GeometryStorage } from './types.ts';
import { meets, segmentTriangle } from './math.ts';
/** Segment endpoints are inclusive. Swept spheres are conservative camera near-plane/body envelopes, not
 * actor collision. Caller supplies the current depicted version and an explicit work grant. Work counts
 * index nodes, surface tests and convex interior planes (at most four mesh broad-phase checks per leaf).
 * Unsupported occupancy, partial coverage, stale versions, numeric boundary bands and exhausted work
 * never certify clear. Unknown material affects only intersecting faces; a known blocker can still block.
 * Closed occupancy is supported only for validated closed convex meshes. Concave/unknown solids must
 * stay unknown or be supplied as faithful convex pieces by a future adapter. No automatic convex hull.
 * CAM07 must verify actual draw-time source/material/side/transform/coverage and overlay completeness;
 * no content hash or apparent complete flag grants hidden-state or movement authority. */
// Numeric domain keeps cross/dot products finite and gives a conservative world-space boundary band.
const LIMIT = 1e6, EPS = 1e-7;
const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256;
const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= LIMIT;
const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && Array.from(v).every(finite);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const same = (a: GeometryVersion, b: GeometryVersion) => a && b && a.world === b.world && a.epoch === b.epoch && a.revision === b.revision && a.sourceHash === b.sourceHash && a.overlayRevision === b.overlayRevision;
function require(ok: unknown, why: string): asserts ok { if (!ok)
    throw Error('view-geometry.' + why); }
function plain(value: unknown, seen = new Set<object>(), depth = 0, budget = { left: 1000000 }): boolean {
    if (--budget.left < 0 || depth > 64)
        return false;
    if (value === null || typeof value === 'boolean')
        return true;
    if (typeof value === 'string')
        return value.length <= 4096;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value))
        return false;
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return false;
    if (Array.isArray(value) && value.length > budget.left)
        return false;
    seen.add(value);
    const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value);
    for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !('value' in d) || !plain(d.value, seen, depth + 1, budget))
            return false;
    }
    seen.delete(value);
    return true;
}
function freeze<T>(v: T): T { if (v && typeof v === 'object') {
    for (const x of Object.values(v))
        freeze(x);
    Object.freeze(v);
} return v; }
function copy<T>(v: T): T { require(plain(v), 'non-plain-or-oversized'); return freeze(JSON.parse(JSON.stringify(v)) as T); }
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function product(a: Mat4, b: Mat4): number[] { const out = Array(16).fill(0); for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
        for (let k = 0; k < 4; k++)
            out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k]; return out; }
function matrix(m: Mat4) { require(Array.isArray(m) && m.length === 16 && Array.from(m).every(finite) && m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1, 'affine-matrix'); const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]); require(Number.isFinite(det) && Math.abs(det) > 1e-12, 'singular-transform'); }
function version(v: GeometryVersion) { require(v && text(v.world) && text(v.epoch) && text(v.revision) && hash(v.sourceHash) && text(v.overlayRevision), 'version'); }
type Mesh = {
    id: string;
    material: ViewMaterial;
    topology: ViewMesh['topology'];
    triangles: Float64Array;
    bounds: Float64Array;
    planes: Float64Array | null;
};
type Index = {
    meshes: Mesh[];
    boxes: Float64Array;
    left: Int32Array;
    right: Int32Array;
    start: Int32Array;
    end: Int32Array;
    order: Uint32Array;
    stack: Int32Array;
    used: number;
    bytes: number;
    triangles: number;
    ids: ReadonlySet<string>;
    staticJsonBytes: number;
};
function index(nodes: ViewGeometry['nodes'], source: readonly ViewMesh[], materials: ReadonlyMap<string, ViewMaterial>): Index {
    require(Array.isArray(nodes) && Array.isArray(source), 'mesh-list');
    const byNode = new Map<string, typeof nodes[number]>(), world = new Map<string, number[]>();
    for (const n of nodes) {
        require(text(n.id) && !byNode.has(n.id) && (n.parent === null || text(n.parent)), 'node-id');
        matrix(n.matrix);
        byNode.set(n.id, n);
    }
    const resolve = (id: string, visiting = new Set<string>()): number[] => { const old = world.get(id); if (old)
        return old; require(!visiting.has(id) && visiting.size < 64, 'transform-cycle-or-depth'); const node = byNode.get(id); require(node, 'missing-parent'); visiting.add(id); const m = node.parent === null ? [...node.matrix] : product(resolve(node.parent, visiting), node.matrix); visiting.delete(id); matrix(m); world.set(id, m); return m; };
    for (const id of byNode.keys())
        resolve(id);
    const ids = new Set<string>(), meshes: Mesh[] = [];
    let triangles = 0;
    for (const mesh of source) {
        require(text(mesh.id) && !ids.has(mesh.id), 'mesh-id');
        ids.add(mesh.id);
        const material = materials.get(mesh.material);
        require(material, 'material-missing');
        require(['surface', 'convex-solid', 'unknown-solid'].includes(mesh.topology), 'topology');
        require(Array.isArray(mesh.vertices) && mesh.vertices.length >= 3 && mesh.vertices.every(vec) && Array.isArray(mesh.triangles) && mesh.triangles.length > 0, 'vertices');
        const m = mesh.node === null ? identity() : world.get(mesh.node);
        require(m, 'mesh-node');
        const points = mesh.vertices.map((p: Vec3) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]);
        require(points.every(vec), 'transformed-range');
        const data = new Float64Array(mesh.triangles.length * 9), bounds = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]), planes = new Float64Array(mesh.triangles.length * 4), edges = new Map<string, number>();
        const center = [0, 0, 0];
        for (const p of points)
            for (let k = 0; k < 3; k++)
                center[k] += p[k] / points.length;
        for (let i = 0; i < mesh.triangles.length; i++) {
            const face = mesh.triangles[i];
            require(Array.isArray(face) && face.length === 3 && Array.from(face).every(n => count(n) && n < points.length), 'triangle-index');
            const a = points[face[0]], b = points[face[1]], c = points[face[2]], o = i * 9;
            data.set([...a, ...b, ...c], o);
            for (const p of [a, b, c])
                for (let k = 0; k < 3; k++) {
                    bounds[k] = Math.min(bounds[k], p[k]);
                    bounds[k + 3] = Math.max(bounds[k + 3], p[k]);
                }
            let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            const length = Math.hypot(nx, ny, nz);
            require(length > 1e-12, 'degenerate-triangle');
            nx /= length;
            ny /= length;
            nz /= length;
            if (mesh.topology === 'convex-solid') {
                if (nx * (center[0] - a[0]) + ny * (center[1] - a[1]) + nz * (center[2] - a[2]) > 0) {
                    nx = -nx;
                    ny = -ny;
                    nz = -nz;
                }
                const distance = nx * a[0] + ny * a[1] + nz * a[2];
                require(nx * center[0] + ny * center[1] + nz * center[2] - distance < -EPS, 'flat-solid');
                require(points.every((p: readonly number[]) => nx * p[0] + ny * p[1] + nz * p[2] - distance <= EPS), 'non-convex-solid');
                planes.set([nx, ny, nz, distance], i * 4);
                for (const [u, v] of [[a, b], [b, c], [c, a]]) {
                    const x = u.join(','), y = v.join(','), key = x < y ? x + '|' + y : y + '|' + x;
                    edges.set(key, (edges.get(key) ?? 0) + 1);
                }
            }
        }
        if (mesh.topology === 'convex-solid')
            require([...edges.values()].every(n => n === 2) && bounds[3] - bounds[0] > EPS && bounds[4] - bounds[1] > EPS && bounds[5] - bounds[2] > EPS, 'unclosed-solid');
        meshes.push({ id: mesh.id, material, topology: mesh.topology, triangles: data, bounds, planes: mesh.topology === 'convex-solid' ? planes : null });
        triangles += mesh.triangles.length;
    }
    const size = Math.max(1, meshes.length * 2), boxes = new Float64Array(size * 6), left = new Int32Array(size).fill(-1), right = new Int32Array(size).fill(-1), start = new Int32Array(size), end = new Int32Array(size), order = Uint32Array.from(meshes.map((_, i) => i)), stack = new Int32Array(size);
    let used = 0;
    const build = (lo: number, hi: number): number => { const node = used++, o = node * 6; boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], o); for (let i = lo; i < hi; i++)
        for (let k = 0; k < 3; k++) {
            const b = meshes[order[i]].bounds;
            boxes[o + k] = Math.min(boxes[o + k], b[k]);
            boxes[o + k + 3] = Math.max(boxes[o + k + 3], b[k + 3]);
        } start[node] = lo; end[node] = hi; if (hi - lo > 4) {
        let axis = 0;
        for (let k = 1; k < 3; k++)
            if (boxes[o + k + 3] - boxes[o + k] > boxes[o + axis + 3] - boxes[o + axis])
                axis = k;
        const sorted = Array.from(order.subarray(lo, hi)).sort((a, b) => meshes[a].bounds[axis] + meshes[a].bounds[axis + 3] - meshes[b].bounds[axis] - meshes[b].bounds[axis + 3]);
        order.set(sorted, lo);
        const mid = (lo + hi) >>> 1;
        left[node] = build(lo, mid);
        right[node] = build(mid, hi);
    } return node; };
    if (meshes.length)
        build(0, meshes.length);
    const bytes = boxes.byteLength + left.byteLength + right.byteLength + start.byteLength + end.byteLength + order.byteLength + stack.byteLength + meshes.reduce((n, m) => n + m.triangles.byteLength + m.bounds.byteLength + (m.planes?.byteLength ?? 0), 0);
    return { meshes, boxes, left, right, start, end, order, stack, used, bytes, triangles, ids, staticJsonBytes: 0 };
}
function validate(g: ViewGeometry) { require(g.schema === 'view-geometry/1' && g.units === 'm' && g.frame === 'world-y-up-rh', 'schema-or-frame'); version(g.version); require(['complete', 'partial'].includes(g.coverage) && Array.isArray(g.materials) && Array.isArray(g.rooms) && Array.isArray(g.openings), 'coverage-or-context'); const materials = new Map<string, ViewMaterial>(); for (const m of g.materials) {
    require(text(m.id) && !materials.has(m.id) && ['block', 'pass', 'unknown'].includes(m.occlusion) && ['block', 'pass', 'unknown'].includes(m.clearance) && ['front', 'back', 'both'].includes(m.side), 'material');
    materials.set(m.id, m);
} const rooms = new Set<string>(); for (const room of g.rooms) {
    require(text(room.id) && !rooms.has(room.id) && room.bounds && vec(room.bounds.min) && vec(room.bounds.max) && room.bounds.min.every((x: number, k: number) => x <= room.bounds.max[k]), 'room');
    rooms.add(room.id);
} const openings = new Set<string>(); for (const p of g.openings) {
    require(text(p.id) && !openings.has(p.id) && rooms.has(p.fromRoom) && (p.toRoom === null || rooms.has(p.toRoom)) && ['door', 'window'].includes(p.kind) && Array.isArray(p.polygon) && p.polygon.length >= 3 && p.polygon.every(vec), 'opening');
    openings.add(p.id);
} return materials; }
function queryValid(q: Query, r: number): boolean { return !!q && vec(q.from) && vec(q.to) && count(q.maxWork) && finite(r) && r >= 0; }
function provider(g: ViewGeometry, base: Index, materials: ReadonlyMap<string, ViewMaterial>, overlay?: GeometryOverlay): ViewGeometryProvider {
    let moving: Index | undefined;
    const v = freeze({ ...g.version, overlayRevision: overlay?.revision ?? g.version.overlayRevision });
    if (overlay) {
        require(same(overlay.base, g.version) && text(overlay.revision) && ['complete', 'partial'].includes(overlay.coverage), 'overlay-version');
        moving = index(overlay.nodes, overlay.meshes, materials);
        require(moving.meshes.every(m => !base.ids.has(m.id)), 'overlay-static-id');
    }
    const indexes = moving ? [base, moving] : [base], partial = g.coverage === 'partial' || overlay?.coverage === 'partial';
    const storage: GeometryStorage = freeze({ meshes: indexes.reduce((n, i) => n + i.meshes.length, 0), triangles: indexes.reduce((n, i) => n + i.triangles, 0), nodes: indexes.reduce((n, i) => n + i.used, 0), numericBufferBytes: indexes.reduce((n, i) => n + i.bytes, 0), sourceJsonUtf8Bytes: overlay ? base.staticJsonBytes - 4 + new TextEncoder().encode(JSON.stringify(overlay)).byteLength : base.staticJsonBytes, staticShared: !!moving });
    const run = (q: Query, r: number, clearance: boolean): QueryResult => {
        let work = 0, candidates = 0, triangles = 0, uncertain: QueryResult['reason'] | null = partial ? 'partial-coverage' : null;
        const result = (status: QueryResult['status'], reason: QueryResult['reason'], mesh?: string): QueryResult => ({ status, reason, version: v, work, candidates, triangles, ...(mesh ? { mesh } : {}) });
        if (!queryValid(q, r))
            return result('unknown', 'invalid-query');
        if (!same(q.version, v))
            return result('unknown', 'version-mismatch');
        const spend = () => { if (work >= q.maxWork) return false; work++; return true; };
        for (const tree of indexes) {
            if (!tree.used)
                continue;
            let top = 0;
            tree.stack[top++] = 0;
            while (top) {
                const node = tree.stack[--top];
                if (!spend())
                    return result('unknown', 'work-limit');
                if (!meets(q.from, q.to, tree.boxes, node * 6, r + EPS))
                    continue;
                if (tree.left[node] >= 0) {
                    tree.stack[top++] = tree.left[node];
                    tree.stack[top++] = tree.right[node];
                    continue;
                }
                for (let i = tree.start[node]; i < tree.end[node]; i++) {
                    const m = tree.meshes[tree.order[i]];
                    if (!meets(q.from, q.to, m.bounds, 0, r + EPS))
                        continue;
                    candidates++;
                    const policy = clearance ? m.material.clearance : m.material.occlusion;
                    if (policy === 'pass')
                        continue;
                    if (clearance && m.planes) {
                        let inside = true;
                        for (let o = 0; o < m.planes.length; o += 4) {
                            if (!spend())
                                return result('unknown', 'work-limit');
                            if (m.planes[o] * q.from[0] + m.planes[o + 1] * q.from[1] + m.planes[o + 2] * q.from[2] - m.planes[o + 3] > EPS) {
                                inside = false;
                                break;
                            }
                        }
                        if (inside) {
                            if (policy === 'block')
                                return result('blocked', 'inside-solid', m.id);
                            uncertain = 'uncertain-material';
                        }
                    }
                    if (clearance && m.topology === 'unknown-solid')
                        uncertain = 'unsupported-occupancy';
                    for (let o = 0; o < m.triangles.length; o += 9) {
                        if (!spend())
                            return result('unknown', 'work-limit');
                        triangles++;
                        const data = m.triangles, distance = segmentTriangle(q.from, q.to, data, o);
                        if (!Number.isFinite(distance)) {
                            uncertain = 'numeric-boundary';
                            continue;
                        }
                        if (distance > (r + EPS) * (r + EPS))
                            continue;
                        if (!clearance && m.material.side !== 'both') {
                            const ax = data[o + 3] - data[o], ay = data[o + 4] - data[o + 1], az = data[o + 5] - data[o + 2], bx = data[o + 6] - data[o], by = data[o + 7] - data[o + 1], bz = data[o + 8] - data[o + 2], nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, dot = (q.to[0] - q.from[0]) * nx + (q.to[1] - q.from[1]) * ny + (q.to[2] - q.from[2]) * nz, tol = EPS * Math.hypot(nx, ny, nz);
                            if (Math.abs(dot) <= tol) {
                                uncertain = 'numeric-boundary';
                                continue;
                            }
                            if ((m.material.side === 'front' && dot > 0) || (m.material.side === 'back' && dot < 0))
                                continue;
                        }
                        if (distance <= r * r && policy === 'block')
                            return result('blocked', 'surface-hit', m.id);
                        uncertain = policy === 'unknown' ? 'uncertain-material' : 'numeric-boundary';
                    }
                }
            }
        }
        return uncertain ? result('unknown', uncertain) : result('clear', 'no-hit');
    };
    return Object.freeze({ version: v, geometry: g, storage, segment: (q: Query) => run(q, 0, false), clearance: (q: ClearanceQuery) => run(q, q?.radiusM, true), withOverlay: (input: GeometryOverlay): GeometryBuild => { try {
            return { status: 'ready', provider: provider(g, base, materials, copy(input)) };
        }
        catch (e) {
            return { status: 'rejected', reason: e instanceof Error && e.message.startsWith('view-geometry.') ? e.message : 'view-geometry.malformed' };
        } } });
}
/** No global cache, clock, randomness, timer, worker, network or scene mutation. Build/query work is caller-owned. */
export function createViewGeometry(input: ViewGeometry): GeometryBuild { try {
    const g = copy(input), materials = validate(g);
    const base = index(g.nodes, g.meshes, materials);
    // Cache immutable static accounting once; overlays never rescan the static source or ID list.
    base.staticJsonBytes = new TextEncoder().encode(JSON.stringify({ geometry: g, overlay: null })).byteLength;
    return { status: 'ready', provider: provider(g, base, materials) };
}
catch (e) {
    return { status: 'rejected', reason: e instanceof Error && e.message.startsWith('view-geometry.') ? e.message : 'view-geometry.malformed' };
} }
