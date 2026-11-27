import { cameraVersionMismatch, contractBounds, contractNumber, contractVec } from '../observation.ts';
import type { CameraBounds, CameraObservation, CameraStepContext, CameraSubject, CameraTransform, CameraVec3 } from '../observation.ts';
import { cameraUsableViewport, validateCameraShot } from '../shot.ts';
import type { CameraShotIntent, CameraViewport } from '../shot.ts';
import type { CameraInspectionPose } from '../view-request.ts';
export type CompositionRegion = Readonly<{
    left: number;
    top: number;
    right: number;
    bottom: number;
}>;
/** Explicit depicted shape supplied by an adapter/caller, not inferred anatomy. Subject-local metres. */
export type CompositionDetail = Readonly<{
    subject: string;
    mediumBounds?: CameraBounds;
    actionBounds?: CameraBounds;
    headLocalM?: CameraVec3;
    actionLocalM?: CameraVec3;
}>;
export type CompositionState = Readonly<{
    shotId: string;
    resetId: string;
    verticalFovRadians: number;
    nowSeconds: number;
}>;
export type CompositionOptions = Readonly<{
    comfortRegion: CompositionRegion;
    maxCorrectionMps: number;
    maxLensRadiansPerSecond: number;
}>;
export type CompositionMember = Readonly<{
    subject: string;
    required: boolean;
    region: CompositionRegion | null;
    heightFraction: number | null;
    issues: readonly ('near-or-far-clipped' | 'outside-region' | 'too-small' | 'too-large')[];
}>;
export type CompositionFrame = Readonly<{
    feasible: boolean;
    members: readonly CompositionMember[];
}>;
export type CompositionInput = Readonly<{
    observation: CameraObservation;
    shot: CameraShotIntent;
    pose: CameraInspectionPose;
    context: CameraStepContext;
    shotId: string;
    resetId: string;
    previous: CompositionState | null;
    options: CompositionOptions;
    details?: readonly CompositionDetail[];
}>;
export type CompositionResult = Readonly<{
    status: 'rejected';
    reason: string;
}> | Readonly<{
    status: 'incomplete';
    missing: readonly string[];
    fallback: 'hold-current-view';
    work: number;
}> | Readonly<{
    status: 'ready' | 'infeasible';
    current: CompositionFrame;
    proposed: CompositionFrame;
    pose: CameraInspectionPose;
    correctionWorldM: CameraVec3;
    lensTargetRadians: number;
    state: CompositionState;
    omittedOptional: readonly string[];
    work: number;
}>;
type Basis = {
    right: CameraVec3;
    up: CameraVec3;
    forward: CameraVec3;
};
type Point = readonly [
    number,
    number,
    number
];
type Shape = {
    id: string;
    required: boolean;
    points: Point[];
};
const finite = (x: number) => Number.isFinite(x);
const dot = (a: CameraVec3, b: CameraVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: CameraVec3, b: CameraVec3): CameraVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: CameraVec3, b: CameraVec3): CameraVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(v: CameraVec3): CameraVec3 | null { const n = Math.hypot(...v); return finite(n) && n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null; }
function basis(p: CameraInspectionPose): Basis | null {
    if (!p || !contractVec(p.eyeM) || !contractVec(p.targetM) || !contractVec(p.up) || !finite(p.verticalFovRadians) || p.verticalFovRadians <= 0 || p.verticalFovRadians >= Math.PI || !finite(p.nearM) || !finite(p.farM) || p.nearM <= 0 || p.farM <= p.nearM)
        return null;
    const forward = unit(subtract(p.targetM, p.eyeM));
    if (!forward)
        return null;
    const right = unit(cross(forward, p.up));
    if (!right)
        return null;
    return { right, up: cross(right, forward), forward };
}
function world(p: CameraVec3, t: CameraTransform): CameraVec3 {
    const [x, y, z, w] = t.rotationXyzw, tx = 2 * (y * p[2] - z * p[1]), ty = 2 * (z * p[0] - x * p[2]), tz = 2 * (x * p[1] - y * p[0]);
    return [p[0] + w * tx + y * tz - z * ty + t.positionM[0], p[1] + w * ty + z * tx - x * tz + t.positionM[1], p[2] + w * tz + x * ty - y * tx + t.positionM[2]];
}
function corners(b: CameraBounds): CameraVec3[] {
    const out: CameraVec3[] = [];
    for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]])
            for (const z of [b.min[2], b.max[2]])
                out.push([x, y, z]);
    return out;
}
function cameraPoint(p: CameraVec3, pose: CameraInspectionPose, b: Basis): Point { const d = subtract(p, pose.eyeM); return [dot(d, b.right), dot(d, b.up), dot(d, b.forward)]; }
function screen(points: readonly Point[], pose: CameraInspectionPose, viewport: CameraViewport, fov: number, dx = 0, dy = 0): CompositionRegion | null {
    const v = cameraUsableViewport(viewport)!;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const tan = Math.tan(fov / 2);
    for (const [x, y, z] of points) {
        if (z <= pose.nearM || z >= pose.farM)
            return null;
        const u = ((.5 + (x - dx) / (2 * z * tan * v.projectionAspect)) * viewport.widthCssPx - v.originCssPx[0]) / v.widthCssPx;
        const w = ((.5 - (y - dy) / (2 * z * tan)) * viewport.heightCssPx - v.originCssPx[1]) / v.heightCssPx;
        if (!finite(u) || !finite(w))
            return null;
        left = Math.min(left, u);
        right = Math.max(right, u);
        top = Math.min(top, w);
        bottom = Math.max(bottom, w);
    }
    return { left, top, right, bottom };
}
/** Eight transformed corners, full projection aspect, top-left normalized usable viewport coordinates.
 * A near/far intersection is explicit; no partial/clipped box is advertised as readable. */
export function projectCompositionBounds(bounds: CameraBounds, transform: CameraTransform, pose: CameraInspectionPose, viewport: CameraViewport): CompositionRegion | null {
    const b = basis(pose);
    if (!b || !cameraUsableViewport(viewport) || !contractBounds(bounds) || !transform || !contractVec(transform.positionM) || !contractVec(transform.rotationXyzw, 4) || Math.abs(Math.hypot(...transform.rotationXyzw) - 1) > 1e-6)
        return null;
    return screen(corners(bounds).map(p => cameraPoint(world(p, transform), pose, b)), pose, viewport, pose.verticalFovRadians);
}
function region(r: CompositionRegion): boolean { return !!r && [r.left, r.top, r.right, r.bottom].every(finite) && r.left >= 0 && r.left < r.right && r.right <= 1 && r.top >= 0 && r.top < r.bottom && r.bottom <= 1; }
const contains = (outer: CompositionRegion, inner: CompositionRegion) => inner.left >= outer.left - 1e-10 && inner.right <= outer.right + 1e-10 && inner.top >= outer.top - 1e-10 && inner.bottom <= outer.bottom + 1e-10;
function frame(shapes: readonly Shape[], pose: CameraInspectionPose, shot: CameraShotIntent, fov: number, dx: number, dy: number, spend: (n: number) => void): CompositionFrame {
    const members = shapes.map(s => {
        spend(s.points.length);
        const r = screen(s.points, pose, shot.viewport, fov, dx, dy), height = r ? r.bottom - r.top : null;
        const issues: CompositionMember['issues'][number][] = [];
        if (!r)
            issues.push('near-or-far-clipped');
        else {
            if (!contains(shot.screenRegion, r))
                issues.push('outside-region');
            if (height! < shot.heightFraction.min)
                issues.push('too-small');
            if (height! > shot.heightFraction.max)
                issues.push('too-large');
        }
        return { subject: s.id, required: s.required, region: r, heightFraction: height, issues };
    });
    return { feasible: members.filter(m => m.required).every(m => m.issues.length === 0), members };
}
/** Camera-plane shift intervals for the requested region, preserving orientation/depth. */
function shift(shapes: readonly Shape[], shot: CameraShotIntent, fov: number, r: CompositionRegion, spend: (n: number) => void): readonly [
    number,
    number
] | null {
    const v = cameraUsableViewport(shot.viewport)!, tan = Math.tan(fov / 2), u = (x: number) => (v.originCssPx[0] + x * v.widthCssPx) / shot.viewport.widthCssPx, w = (y: number) => (v.originCssPx[1] + y * v.heightCssPx) / shot.viewport.heightCssPx;
    const L = 2 * u(r.left) - 1, R = 2 * u(r.right) - 1, B = 1 - 2 * w(r.bottom), T = 1 - 2 * w(r.top);
    let xmin = -Infinity, xmax = Infinity, ymin = -Infinity, ymax = Infinity;
    for (const s of shapes) {
        spend(s.points.length);
        for (const [x, y, z] of s.points) {
            if (z <= shot.lens.nearM || z >= shot.lens.farM)
                return null;
            xmin = Math.max(xmin, x - R * z * tan * v.projectionAspect);
            xmax = Math.min(xmax, x - L * z * tan * v.projectionAspect);
            ymin = Math.max(ymin, y - T * z * tan);
            ymax = Math.min(ymax, y - B * z * tan);
        }
    }
    if (xmin > xmax || ymin > ymax)
        return null;
    return [Math.max(xmin, Math.min(0, xmax)), Math.max(ymin, Math.min(0, ymax))];
}
/** Pure bounded proposal. It reads selected depicted facts; never owns movement, visibility/obstacle authority,
 * clocks, RNG or renderer state. Caller must still validate actual geometry/visibility and inspect rendered pixels.
 * current describes supplied pose; proposed describes THIS step's rate-limited proposal, never a future target.
 * Previous state describes the last applied lens and must match the supplied actual pose.
 * Previous lens is reused only for the explicit shot/reset pair; revision and aspect/inset changes do not reset it.
 * Input observations are adapter-validated plain data; this function checks only facts used for framing.
 * Candidate grants count membership admission, selected-fact and corner visits. Shot validation follows
 * admission and sees selected subjects, not all metadata. This is not a CPU-instruction counter.
 * Exhausted work holds current view. */
export function composeCamera(input: CompositionInput): CompositionResult {
    let work = 0;
    const incomplete = (...missing: string[]): CompositionResult => ({ status: 'incomplete', missing, fallback: 'hold-current-view', work });
    if (!input || !input.context || !input.options)
        return { status: 'rejected', reason: 'composition.input-malformed' };
    const { observation: o, shot, pose, context: c, options, previous } = input;
    const b = basis(pose), clock = c.clock, grant = c.grant?.candidates;
    if (!b || !clock || ![clock.nowSeconds, clock.deltaSeconds].every(x => finite(x) && x >= 0) || !Number.isSafeInteger(grant) || grant < 0 || !input.shotId || !input.resetId || !region(options.comfortRegion) || ![options.maxCorrectionMps, options.maxLensRadiansPerSecond].every(x => finite(x) && x >= 0))
        return { status: 'rejected', reason: 'composition.input-malformed' };
    // Do not impose the older observation validator's integer-tick assumption on depicted interpolated frames.
    if (!o || !o.version || !Array.isArray(o.subjects) || !o.depicted || !contractNumber(o.depicted.tick) || !contractNumber(o.depicted.seconds))
        return { status: 'rejected', reason: 'composition.observation-malformed' };
    if (!shot || !Array.isArray(shot.requiredSubjects) || !Array.isArray(shot.optionalSubjects) || !Array.isArray(input.details ?? []))
        return { status: 'rejected', reason: 'composition.input-malformed' };
    if (previous && (![previous.nowSeconds, previous.verticalFovRadians].every(finite) || previous.verticalFovRadians <= 0 || previous.verticalFovRadians >= Math.PI || previous.nowSeconds > clock.nowSeconds))
        return { status: 'rejected', reason: 'composition.state-malformed' };
    const spend = (n: number) => {
        if (work + n > grant)
            throw Error('composition.work-limit');
        work += n;
    };
    try {
        spend(o.subjects.length + (input.details?.length ?? 0) + shot.requiredSubjects.length + shot.optionalSubjects.length);
        const byId = new Map<string, CameraSubject>();
        for (const s of o.subjects) {
            if (!s || !s.version || byId.has(s.id) || cameraVersionMismatch(s.version, o.version))
                return { status: 'rejected', reason: 'composition.subject-version-or-id' };
            byId.set(s.id, s);
        }
        const selected = [...shot.requiredSubjects, ...shot.optionalSubjects].map(id => byId.get(id)).filter((s): s is CameraSubject => !!s);
        const checked = validateCameraShot(shot, { ...o, subjects: selected });
        if (checked.status === 'rejected')
            return { status: 'rejected', reason: checked.reason };
        if (!contains(shot.screenRegion, options.comfortRegion))
            return { status: 'rejected', reason: 'composition.comfort-outside-limits' };
        const details = new Map<string, CompositionDetail>();
        for (const d of input.details ?? []) {
            if (details.has(d.subject) || (d.mediumBounds !== undefined && !contractBounds(d.mediumBounds)) || (d.actionBounds !== undefined && !contractBounds(d.actionBounds)) || (d.headLocalM !== undefined && !contractVec(d.headLocalM)) || (d.actionLocalM !== undefined && !contractVec(d.actionLocalM)))
                return { status: 'rejected', reason: 'composition.detail-malformed' };
            details.set(d.subject, d);
        }
        const required = new Set(shot.requiredSubjects);
        if (shot.extent === 'activity')
            for (const id of shot.requiredSubjects) {
                const s = byId.get(id);
                if (s?.state !== 'present' || !s.activity)
                    return incomplete(id + '.activity');
                for (const role of s.activity.roles)
                    required.add(role.subject);
            }
        const shapes: Shape[] = [], missing: string[] = [], omittedOptional: string[] = [];
        for (const id of [...required, ...shot.optionalSubjects.filter(id => !required.has(id))]) {
            const needed = required.has(id), s = byId.get(id), d = details.get(id);
            if (!s || s.state !== 'present') {
                if (needed)
                    missing.push(id + '.unavailable');
                else
                    omittedOptional.push(id);
                continue;
            }
            if (!contractVec(s.transform?.positionM) || !contractVec(s.transform.rotationXyzw, 4) || Math.abs(Math.hypot(...s.transform.rotationXyzw) - 1) > 1e-6)
                return { status: 'rejected', reason: 'composition.transform-malformed' };
            const actionSubject = shot.extent === 'activity' && shot.requiredSubjects.includes(id);
            const bounds = shot.extent === 'medium' ? d?.mediumBounds : actionSubject ? d?.actionBounds ?? s.bounds : s.bounds;
            const head = d?.headLocalM ?? s.anchors.find(a => a.role === 'head' && a.confidence > 0)?.localM;
            const action = d?.actionLocalM ?? s.anchors.find(a => a.role === 'activity' && a.confidence > 0)?.localM;
            if (!bounds || (shot.extent === 'medium' && !head) || (actionSubject && !action)) {
                if (needed)
                    missing.push(id + '.' + (!bounds ? 'bounds' : shot.extent === 'medium' ? 'head' : 'action'));
                else
                    omittedOptional.push(id);
                continue;
            }
            if (!contractBounds(bounds))
                return { status: 'rejected', reason: 'composition.bounds-malformed' };
            const points = [...corners(bounds), ...(head ? [head] : []), ...(actionSubject && action ? [action] : [])];
            spend(points.length);
            const cameraPoints = points.map(p => cameraPoint(world(p, s.transform), pose, b));
            if (cameraPoints.some(p => !p.every(finite)))
                return { status: 'rejected', reason: 'composition.numeric-range' };
            shapes.push({ id, required: needed, points: cameraPoints });
        }
        if (missing.length)
            return incomplete(...missing);
        if (shot.focusRegionM) {
            spend(8);
            shapes.push({ id: 'focus-region', required: true, points: corners(shot.focusRegionM).map(p => cameraPoint(p, pose, b)) });
        }
        const proposedPose = { ...pose, nearM: shot.lens.nearM, farM: shot.lens.farM };
        const requiredShapes = shapes.filter(s => s.required), current = frame(shapes, pose, shot, pose.verticalFovRadians, 0, 0, spend);
        const sameShot = previous?.shotId === input.shotId && previous.resetId === input.resetId;
        if (sameShot && Math.abs(previous!.verticalFovRadians - pose.verticalFovRadians) > 1e-9)
            return { status: 'rejected', reason: 'composition.state-pose-lens-mismatch' };
        if (sameShot && (previous!.verticalFovRadians < shot.lens.minVerticalFovRadians || previous!.verticalFovRadians > shot.lens.maxVerticalFovRadians))
            return { status: 'rejected', reason: 'composition.state-lens-outside-limits' };
        const base = Math.max(shot.lens.minVerticalFovRadians, Math.min(shot.lens.maxVerticalFovRadians, sameShot ? previous!.verticalFovRadians : pose.verticalFovRadians));
        // Fixed deterministic candidate set; prior lens first. No claim of a continuous global optimum.
        let chosen: {
            fov: number;
            shift: readonly [
                number,
                number
            ];
        } | null = null;
        for (const fov of [base, ...Array.from({ length: 17 }, (_, i) => shot.lens.minVerticalFovRadians + (shot.lens.maxVerticalFovRadians - shot.lens.minVerticalFovRadians) * i / 16)]) {
            const correction = shift(requiredShapes, shot, fov, options.comfortRegion, spend) ?? shift(requiredShapes, shot, fov, shot.screenRegion, spend);
            if (!correction)
                continue;
            const candidate = frame(requiredShapes, proposedPose, shot, fov, ...correction, spend);
            if (!candidate.feasible)
                continue;
            if (!chosen || Math.abs(fov - base) < Math.abs(chosen.fov - base))
                chosen = { fov, shift: correction };
            if (fov === base)
                break;
        }
        const target = chosen?.fov ?? base, limit = options.maxLensRadiansPerSecond * clock.deltaSeconds;
        const fov = base + Math.max(-limit, Math.min(limit, target - base));
        const desired = shift(requiredShapes, shot, fov, options.comfortRegion, spend) ?? shift(requiredShapes, shot, fov, shot.screenRegion, spend) ?? [0, 0];
        const distance = Math.hypot(...desired), maxShift = options.maxCorrectionMps * clock.deltaSeconds, factor = distance > 0 ? Math.min(1, maxShift / distance) : 0, dx = factor === 0 ? 0 : desired[0] * factor, dy = factor === 0 ? 0 : desired[1] * factor;
        const correctionWorldM: CameraVec3 = [b.right[0] * dx + b.up[0] * dy, b.right[1] * dx + b.up[1] * dy, b.right[2] * dx + b.up[2] * dy];
        const proposed = frame(shapes, proposedPose, shot, fov, dx, dy, spend);
        for (const m of proposed.members)
            if (!m.required && m.issues.length)
                omittedOptional.push(m.subject);
        const add = (v: CameraVec3): CameraVec3 => [v[0] + correctionWorldM[0], v[1] + correctionWorldM[1], v[2] + correctionWorldM[2]];
        return { status: proposed.feasible ? 'ready' : 'infeasible', current, proposed, pose: { ...pose, eyeM: add(pose.eyeM), targetM: add(pose.targetM), verticalFovRadians: fov, nearM: shot.lens.nearM, farM: shot.lens.farM }, correctionWorldM, lensTargetRadians: target, state: { shotId: input.shotId, resetId: input.resetId, verticalFovRadians: fov, nowSeconds: clock.nowSeconds }, omittedOptional, work };
    }
    catch (error) {
        if (error instanceof Error && error.message === 'composition.work-limit')
            return incomplete('work-limit');
        throw error;
    }
}
