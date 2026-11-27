/** Representative browser client. The pose is already a validated CAM02 inspection request; this only reads
 * geometry and never changes its exact eye. Radius encloses the full projection near plane at supplied aspect.
 * Safe/UI insets affect composition, not full render projection aspect. Unknown never authorizes presentation. */
import { createViewGeometry } from '@souls/view-geometry';
import type { ViewGeometryProvider, GeometryVersion } from '@souls/view-geometry';
import type { CameraInspectionPose } from '../../camera/src/view-request.ts';
export function inspectPose(provider: ViewGeometryProvider, version: GeometryVersion, pose: CameraInspectionPose, aspect: number, maxWork: number) {
    const t = Math.tan(pose.verticalFovRadians / 2), radiusM = Number.isFinite(aspect) && aspect > 0 ? pose.nearM * Math.sqrt(1 + t * t * (1 + aspect * aspect)) : NaN;
    const sight = provider.segment({ version, from: pose.eyeM, to: pose.targetM, maxWork }), volume = provider.clearance({ version, from: pose.eyeM, to: pose.eyeM, radiusM, maxWork });
    return { sight, volume, canPresent: sight.status === 'clear' && volume.status === 'clear' };
}
export function browserExample() { const b = createViewGeometry({ schema: 'view-geometry/1', version: { world: 'fixture-world', epoch: 'browser', revision: '1', sourceHash: 'b'.repeat(64), overlayRevision: 'static' }, units: 'm', frame: 'world-y-up-rh', coverage: 'complete', materials: [], nodes: [], meshes: [], rooms: [], openings: [] }); if (b.status !== 'ready')
    throw Error('example rejected'); return inspectPose(b.provider, b.provider.version, { eyeM: [0, 1, 0], targetM: [0, 1, 5], up: [0, 1, 0], verticalFovRadians: 1, nearM: .1, farM: 100 }, 390 / 844, 100).canPresent; }
