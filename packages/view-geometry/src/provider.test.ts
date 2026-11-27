import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewGeometry } from './index.ts';
import type { ViewGeometry, ViewGeometryProvider, Vec3, GeometryOverlay } from './index.ts';
import { scene, box, panel } from './fixtures.ts';
import { oracle } from './oracle.ts';
function build(g: ViewGeometry): ViewGeometryProvider {
    const b = createViewGeometry(g);
    assert.equal(b.status, 'ready', b.status === 'rejected' ? b.reason : '');
    if (b.status !== 'ready')
        throw Error('build refused');
    return b.provider;
}
function q(p: ViewGeometryProvider, from: Vec3, to: Vec3, radiusM = 0) { return { version: p.version, from, to, radiusM, maxWork: 100000 }; }
function compare(g: ViewGeometry, from: Vec3, to: Vec3, radius = 0) { const p = build(g), r = radius ? p.clearance(q(p, from, to, radius)) : p.segment(q(p, from, to)); assert.equal(r.status, oracle(g, from, to, radius, radius > 0), JSON.stringify({ from, to, radius, r })); return r; }
test('doors/windows are actual holes, with distinct glass/foliage occlusion and clearance', () => {
    const g = scene([box('left', [-3, 0, -.05], [-1, 3, .05]), box('right', [1, 0, -.05], [3, 3, .05]), box('lintel', [-1, 2, -.05], [1, 3, .05])]);
    const decorated: ViewGeometry = { ...g, rooms: [{ id: 'inside', bounds: { min: [-3, 0, -3], max: [3, 3, 0] } }], openings: [{ id: 'door', kind: 'door', fromRoom: 'inside', toRoom: null, polygon: [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]] }] };
    assert.equal(compare(decorated, [0, 1, -2], [0, 1, 2], .4).status, 'clear');
    assert.equal(compare(decorated, [.8, 1, -2], [.8, 1, 2], .4).status, 'blocked');
    assert.equal(compare(decorated, [0, 2.5, -2], [0, 2.5, 2]).status, 'blocked');
    const window = { ...decorated, meshes: [...g.meshes, { ...panel('pane', 'glass'), vertices: [[-1, 0, 0], [1, 0, 0], [1, 2, 0], [-1, 2, 0]] as const }], openings: decorated.openings.map(o => ({ ...o, kind: 'window' as const })) };
    assert.equal(compare(window, [0, 1, -2], [0, 1, 2]).status, 'clear');
    assert.equal(compare(window, [0, 1, -2], [0, 1, 2], .1).status, 'blocked');
    const leaves = scene([panel('leaves', 'foliage')]);
    assert.equal(compare(leaves, [0, 1, -2], [0, 1, 2]).status, 'unknown');
    assert.equal(compare(leaves, [0, 1, -2], [0, 1, 2], .2).status, 'clear');
});
test('thin/one-sided walls, tangency, coplanar and zero-length queries never falsely certify clear', () => {
    const g = scene([panel('wall', 'front')]), p = build(g);
    assert.equal(p.segment(q(p, [0, 1, 1], [0, 1, -1])).status, 'blocked');
    assert.equal(p.segment(q(p, [0, 1, -1], [0, 1, 1])).status, 'clear');
    assert.equal(p.clearance(q(p, [0, 1, -1], [0, 1, 1], .1)).status, 'blocked');
    for (const [a, b, r] of [[[0, 1, 0], [0, 1, 0], 0], [[0, 1, .1], [0, 1, .1], .1], [[-3, 1, 0], [3, 1, 0], 0]] as const) {
        const result = p.clearance(q(p, a, b, r));
        assert.notEqual(result.status, 'clear');
    }
    assert.equal(p.segment(q(p, [0, 1, 1e-8], [1e-10, 1, 1e-8])).status, 'unknown');
    assert.equal(p.clearance(q(p, [0, 1, .001], [0, 1, .001], .0001)).status, 'clear');
});
test('closed solid interiors block; unsupported occupancy/partial/stale/budget remain unknown', () => {
    const p = build(scene([box('solid', [-2, -2, -2], [2, 2, 2])]));
    assert.equal(p.clearance(q(p, [0, 0, 0], [.1, 0, 0], .1)).reason, 'inside-solid');
    const u = build(scene([{ ...box('unknown', [-2, -2, -2], [2, 2, 2]), topology: 'unknown-solid' }]));
    assert.equal(u.clearance(q(u, [0, 0, 0], [.1, 0, 0], .1)).status, 'unknown');
    const noGrant = p.segment({ ...q(p, [0, 0, 4], [0, 0, -4]), maxWork: 0 });
    assert.equal(noGrant.reason, 'work-limit');
    assert.equal(noGrant.work, 0);
    assert.equal(p.segment({ ...q(p, [0, 0, 4], [0, 0, -4]), version: { ...p.version, revision: 'stale' } }).reason, 'version-mismatch');
    assert.equal(build({ ...scene(), coverage: 'partial' }).segment(q(p, [0, 0, 0], [1, 0, 0])).status, 'unknown');
});
test('nested nonuniform, mirrored and sheared transforms preserve world-space sphere radius against independent oracle', () => {
    const g: ViewGeometry = { ...scene([{ ...box('transformed', [-1, -1, -.1], [1, 1, .1]), node: 'child' }]), nodes: [{ id: 'parent', parent: null, matrix: [0, 0, -2, 0, 0, 3, 0, 0, 1, 0, 0, 0, 4, 1, 2, 1] }, { id: 'child', parent: 'parent', matrix: [-1, 0, 0, 0, .3, 1, 0, 0, 0, 0, 2, 0, 1, 0, 0, 1] }] };
    const mirrored: ViewGeometry = { ...scene([{ ...panel('mirror', 'front'), node: 'mirror' }]), nodes: [{ id: 'mirror', parent: null, matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
    assert.equal(compare(mirrored, [0, 1, 1], [0, 1, -1]).status, 'clear');
    assert.equal(compare(mirrored, [0, 1, -1], [0, 1, 1]).status, 'blocked');
    for (let i = 0; i < 40; i++) {
        const y = -1 + (i % 8) * .5, z = -2 + Math.floor(i / 8) * .7;
        compare(g, [0, y, z], [8, y, z], .15);
    }
});
test('moving overlays share static index, replace prior dynamic poses, and reject mixed epochs/static collisions', () => {
    const p = build(scene([box('static', [20, 0, 0], [21, 2, 1])])), overlay: GeometryOverlay = { base: p.version, revision: 'moving-1', coverage: 'complete', nodes: [], meshes: [box('actor', [-1, 0, -1], [1, 2, 1])] };
    const a = p.withOverlay(overlay);
    assert.equal(a.status, 'ready');
    if (a.status !== 'ready')
        return;
    assert.equal(a.provider.storage.staticShared, true);
    assert.equal(a.provider.storage.sourceJsonUtf8Bytes, new TextEncoder().encode(JSON.stringify({ geometry: p.geometry, overlay })).byteLength);
    assert.equal(a.provider.geometry, p.geometry);
    assert.equal(a.provider.clearance(q(a.provider, [0, 1, -3], [0, 1, 3], .2)).status, 'blocked');
    const b = a.provider.withOverlay({ ...overlay, revision: 'moving-2', meshes: [box('actor', [5, 0, -1], [7, 2, 1])] });
    assert.equal(b.status, 'ready');
    if (b.status !== 'ready')
        return;
    assert.equal(b.provider.clearance(q(b.provider, [0, 1, -3], [0, 1, 3], .2)).status, 'clear');
    assert.equal(b.provider.clearance({ ...q(b.provider, [0, 1, -3], [0, 1, 3], .2), version: a.provider.version }).status, 'unknown');
    assert.equal(p.withOverlay({ ...overlay, base: { ...p.version, epoch: 'other' } }).status, 'rejected');
    assert.equal(p.withOverlay({ ...overlay, meshes: [box('static', [0, 0, 0], [1, 1, 1])] }).status, 'rejected');
    compare({ ...scene(), meshes: overlay.meshes }, [0, 1, -3], [0, 1, 3], .2);
    const moved = { ...scene(), meshes: [box('actor', [5, 0, -1], [7, 2, 1])] };
    for (const x of [0, 6]) {
        const from: Vec3 = [x, 1, -3], to: Vec3 = [x, 1, 3];
        assert.equal(b.provider.clearance(q(b.provider, from, to, .2)).status, oracle(moved, from, to, .2, true));
    }
    assert.equal(p.withOverlay({ ...overlay, base: { ...p.version, world: 'other-world' } }).status, 'rejected');
});
test('snapshots are detached immutable plain data; malformed/sparse/degenerate/unclosed transforms refuse', () => {
    const g = scene([panel()]), p = build(g);
    assert.ok(Object.isFrozen(p.geometry.meshes[0].vertices[0]));
    (g.meshes[0].vertices[0] as unknown as number[])[0] = 100;
    assert.equal(p.segment(q(p, [0, 1, 1], [0, 1, -1])).status, 'blocked');
    const sparse = scene([{ ...panel(), vertices: [Array(3), [1, 0, 0], [0, 1, 0]] as unknown as Vec3[] }]);
    assert.equal(createViewGeometry(sparse).status, 'rejected');
    assert.equal(createViewGeometry(scene([{ ...panel(), vertices: [[0, 0, 0], [1e-8, 0, 0], [0, 1e-8, 0]], triangles: [[0, 1, 2]] }])).status, 'rejected');
    assert.equal(createViewGeometry(scene([{ ...panel(), topology: 'convex-solid' }])).status, 'rejected');
    assert.equal(createViewGeometry({ ...scene(), nodes: [{ id: 'cycle', parent: 'cycle', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] }).status, 'rejected');
    assert.equal(p.segment(q(p, [Infinity, 0, 0], [0, 0, 0])).reason, 'invalid-query');
    for (const absent of [null, undefined]) {
        assert.equal(p.segment(absent as unknown as Parameters<typeof p.segment>[0]).reason, 'invalid-query');
        assert.equal(p.clearance(absent as unknown as Parameters<typeof p.clearance>[0]).reason, 'invalid-query');
    }
    assert.equal(p.segment(q(p, [1e7, 0, 0], [0, 0, 0])).reason, 'invalid-query');
});
test('indexed segment/capsule decisions match a slow oracle amid many irrelevant objects', () => {
    const g = scene(Array.from({ length: 80 }, (_, i) => box('box-' + i, [i % 10 * 4, 0, Math.floor(i / 10) * 4], [i % 10 * 4 + 1, 2, Math.floor(i / 10) * 4 + 1]))), p = build(g);
    let seed = 1729;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 60; i++) {
        const a: Vec3 = [random() * 40, random() * 4, random() * 32], b: Vec3 = [random() * 40, random() * 4, random() * 32], r = i % 2 ? .2 : 0, result = r ? p.clearance(q(p, a, b, r)) : p.segment(q(p, a, b));
        assert.equal(result.status, oracle(g, a, b, r, r > 0), JSON.stringify({ a, b, r, result }));
    }
    const distant = p.segment(q(p, [-100, 1, -100], [-99, 1, -99]));
    assert.equal(distant.status, 'clear');
    assert.equal(distant.triangles, 0);
    assert.equal(distant.work, 1);
});
test('large-coordinate centroid piercing cannot become a false clear through distance cancellation', () => {
    const vertices: readonly Vec3[] = [[-514277.37548947334, 676485.7355039567, 43812.07460537553], [-281595.1361786574, 80874.57139045, -229133.96009244025], [-380000.51798298955, 62726.71543993056, -189059.99846756458]];
    const corrected = vertices.map(p => [...p]) as [
        number,
        number,
        number
    ][];
    const g = scene([{ ...panel(), vertices: corrected, triangles: [[0, 1, 2]] }]), p = build(g), from: Vec3 = [-391957.27241959877, 273362.09491020377, -124793.0802805894], to: Vec3 = [-391958.0806811481, 273362.58664602105, -124794.84235583013];
    assert.equal(oracle(g, from, to, 0, false), 'blocked');
    assert.notEqual(p.segment(q(p, from, to)).status, 'clear');
    assert.notEqual(p.clearance(q(p, from, to, .01)).status, 'clear');
});
import { inspectPose, browserExample } from './client.fixture.ts';
test('browser client consumes CAM02 inspection pose and unknown never authorizes presentation', () => { assert.equal(browserExample(), true); const p = build(scene([box('glass', [-1, 0, .05], [1, 2, .06], 'glass')])), pose = { eyeM: [0, 1, 0] as Vec3, targetM: [0, 1, 5] as Vec3, up: [0, 1, 0] as Vec3, verticalFovRadians: 1, nearM: .1, farM: 100 }, r = inspectPose(p, p.version, pose, 390 / 844, 1000); assert.equal(r.sight.status, 'clear'); assert.equal(r.volume.status, 'blocked'); assert.equal(r.canPresent, false); assert.equal(inspectPose(build({ ...scene(), coverage: 'partial' }), p.version, pose, 390 / 844, 1000).canPresent, false); });
test('duplicated open caps cannot certify a closed volume', () => {
    const vertices: readonly Vec3[] = [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [-1, -1, 1], [1, -1, 1], [0, 1, 1]];
    for (const triangles of [[[0, 1, 2], [0, 1, 2], [3, 4, 5], [3, 4, 5]], [[0, 1, 2], [2, 1, 0], [3, 4, 5], [5, 4, 3]]] as const) {
        const result = createViewGeometry(scene([{ ...panel(), topology: 'convex-solid', vertices, triangles }]));
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected')
            assert.equal(result.reason, 'view-geometry.duplicate-solid-face');
    }
    const valid = build(scene([box('valid', [-1, -1, -1], [1, 1, 1])]));
    assert.equal(valid.clearance(q(valid, [0, 0, 0], [0, 0, 0])).reason, 'inside-solid');
});
test('analytically interior skinny coplanar point is refused before unstable distance tests', () => {
    // P=.5A+.25B+.25C lies in the triangle; aspect ratio is 1e-12.
    const g = scene([{ ...panel(), vertices: [[0, 0, 0], [1e6, 0, 0], [1e6, 1e-6, 0]], triangles: [[0, 1, 2]] }]);
    const result = createViewGeometry(g);
    assert.deepEqual(result, { status: 'rejected', reason: 'view-geometry.ill-conditioned-triangle' });
});
test('hidden and array serialization hooks are refused without executing caller code', () => {
    let calls = 0;
    for (const kind of ['function', 'getter', 'array'] as const) {
        const g = scene([panel()]);
        const target = kind === 'array' ? g.meshes : g;
        Object.defineProperty(target, 'toJSON', kind === 'getter' ? { get() { calls++; throw Error('must not execute'); } } : { value() { calls++; return scene(); } });
        assert.equal(createViewGeometry(g).status, 'rejected');
    }
    assert.equal(calls, 0);
});
test('admitted large skinny triangle retains analytically exact coplanar interior', () => {
    const p = build(scene([{ ...panel(), vertices: [[0, 0, 0], [1e6, 0, 0], [1e6, 2, 0]], triangles: [[0, 1, 2]] }]));
    // P=.5A+.25B+.25C: exact positive barycentric weights, not an oracle shared with production.
    const at: Vec3 = [500000, .5, 0];
    assert.notEqual(p.segment(q(p, at, at)).status, 'clear');
    assert.notEqual(p.clearance(q(p, at, at, 0)).status, 'clear');
});
test('rotated decimal coplanar interior accounts for normal and distance conditioning', () => {
    const p = build(scene([{ ...panel(), vertices: [[0, 0, 0], [999983.3, 999979.1, 999961.7], [999986.1, 999976.2, 999964.6]], triangles: [[0, 1, 2]] }]));
    // Decimal P=.5A+.25B+.25C. Rounded coordinates differ by less than 1e-9m;
    // a 1e-6m sphere must intersect even though the naive computed plane distance is about 1e-5m.
    const at: Vec3 = [499992.35, 499988.82499999995, 499981.57499999995];
    assert.equal(p.segment(q(p, at, at)).status, 'unknown');
    assert.equal(p.clearance(q(p, at, at, 1e-6)).status, 'unknown');
});
test('tiny offset geometry refuses amplified long-span normal uncertainty', () => {
    const p = build(scene([{ ...panel(), vertices: [[999999, 999999, 999999], [999999.0001, 999999.0002, 999999.0003], [999999.0003, 999999.0001, 999999.0002]], triangles: [[0, 1, 2]] }]));
    // The midpoint is the convex average of the three vertices; the segment goes through it.
    const center: Vec3 = [999999.0001, 999999.000075, 999999.000125];
    const from: Vec3 = [center[0] - .5, center[1] - .5, center[2] - .5], to: Vec3 = [center[0] + .5, center[1] + .5, center[2] + .5];
    assert.equal(p.segment(q(p, from, to)).status, 'unknown');
    assert.equal(p.clearance(q(p, from, to, 1e-6)).status, 'unknown');
});
test('nearly coplanar crossing refuses unstable intersection parameter', () => {
    const p = build(scene([panel()]));
    const from: Vec3 = [-1, 1, -1e-12], to: Vec3 = [1, 1, 1e-12];
    // Analytic midpoint [0,1,0] is inside the panel; long displacement over a tiny plane gap is uncertain.
    assert.equal(p.segment(q(p, from, to)).status, 'unknown');
    assert.equal(p.clearance(q(p, from, to, 0)).status, 'unknown');
});
