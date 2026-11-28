import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCamera, projectCompositionBounds } from './composition.ts';
import type { CompositionInput, CompositionResult } from './composition.ts';
import type { CameraBounds, CameraSubject, CameraVec3 } from '../observation.ts';
import type { CameraViewport } from '../shot.ts';
const version = { world: 'fixture', epoch: 'epoch', revision: '1' };
const bounds: CameraBounds = { min: [-.3, 0, -.2], max: [.3, 1.8, .2] };
const portrait: CameraViewport = { widthCssPx: 390, heightCssPx: 844, deviceScaleFactor: 2, insetsCssPx: { left: 12, right: 20, top: 44, bottom: 100 } };
const transform = { positionM: [0, 0, 0] as CameraVec3, rotationXyzw: [0, 0, 0, 1] as const };
function subject(id = 'actor', position: CameraVec3 = [0, 0, 0]): CameraSubject { return { id, version, state: 'present', transform: { ...transform, positionM: position }, bounds, anchors: [{ role: 'head', localM: [0, 1.75, 0], confidence: 1 }], confidence: 1, facing: null, travelMps: null, activity: null, carrier: { state: 'none' } }; }
function input(subjects: CameraSubject[] = [subject()]): CompositionInput { return { observation: { schema: 'camera-observation/1', version, audience: 'public', coordinateFrame: 'world-y-up-rh', units: { distance: 'm', time: 's', angle: 'rad' }, depicted: { tick: 25.25, seconds: 1.2625 }, coverage: 'complete', subjects }, shot: { schema: 'camera-shot/1', version, mode: 'follow', requiredSubjects: ['actor'], optionalSubjects: [], focusRegionM: null, extent: 'full', viewport: portrait, screenRegion: { left: .05, top: .05, right: .95, bottom: .95 }, heightFraction: { min: .25, max: .8 }, lens: { minVerticalFovRadians: .45, maxVerticalFovRadians: 1.4, nearM: .05, farM: 100 } }, pose: { eyeM: [0, .9, 4], targetM: [0, .9, 0], up: [0, 1, 0], verticalFovRadians: .8, nearM: .05, farM: 100 }, context: { clock: { nowSeconds: 1, deltaSeconds: 1 / 60 }, seed: 42, grant: { queries: 0, candidates: 10000 } }, shotId: 'shot', resetId: 'live-epoch', previous: null, options: { comfortRegion: { left: .15, top: .1, right: .85, bottom: .9 }, maxCorrectionMps: 2, maxLensRadiansPerSecond: .4 } }; }
function proposal(r: CompositionResult) {
    assert.ok(r.status === 'ready' || r.status === 'infeasible');
    if (r.status !== 'ready' && r.status !== 'infeasible')
        throw Error('no proposal');
    return r;
}
function change(i: CompositionInput, patch: Partial<CompositionInput>) { return { ...i, ...patch }; }
const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs${b}`);
test('projection uses full viewport aspect and asymmetric usable origin in primary portrait', () => {
    const i = input(), r = projectCompositionBounds(bounds, transform, i.pose, portrait)!;
    const tan = Math.tan(.4), z = 3.8;
    close(r.left, ((.5 - .3 / (2 * z * tan * (390 / 844))) * 390 - 12) / 358);
    close(r.top, ((.5 - .9 / (2 * z * tan)) * 844 - 44) / 700);
    const landscape = { ...portrait, widthCssPx: 844, heightCssPx: 390, insetsCssPx: { left: 70, right: 10, top: 10, bottom: 20 } };
    const l = projectCompositionBounds(bounds, transform, i.pose, landscape)!;
    assert.ok(l.right - l.left < r.right - r.left);
    close((l.bottom - l.top) / (r.bottom - r.top), (390 / 360) / (844 / 700));
    const rotated = projectCompositionBounds(bounds, { ...transform, rotationXyzw: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)] }, i.pose, portrait)!;
    assert.ok(rotated.right - rotated.left > r.right - r.left);
});
test('comfortable off-centre framing has slack; activity movement inside it does not chase centre', () => {
    const i = input([subject('actor', [.12, 0, 0])]), r = proposal(composeCamera(i));
    assert.equal(r.status, 'ready');
    assert.equal(r.current.feasible, true);
    assert.deepEqual(r.correctionWorldM, [0, 0, 0]);
    close(r.pose.verticalFovRadians, .8);
    const moving = proposal(composeCamera(change(i, { observation: { ...i.observation, depicted: { tick: 26.5, seconds: 1.325 }, subjects: [subject('actor', [.15, 0, 0])] }, previous: r.state, context: { ...i.context, clock: { nowSeconds: 2, deltaSeconds: 1 / 60 } } })));
    assert.deepEqual(moving.correctionWorldM, [0, 0, 0]);
    close(moving.pose.verticalFovRadians, .8);
});
test('outside comfort corrects gradually and current feasibility is not future feasibility', () => {
    const i = input([subject('actor', [1.2, 0, 0])]), r = proposal(composeCamera(i));
    assert.equal(r.current.feasible, false);
    assert.ok(Math.hypot(...r.correctionWorldM) <= 2 / 60 + 1e-12);
    assert.equal(r.status, 'infeasible');
    assert.equal(r.proposed.feasible, false);
    const fast = proposal(composeCamera(change(i, { options: { ...i.options, maxCorrectionMps: 1000 }, context: { ...i.context, clock: { nowSeconds: 1, deltaSeconds: 1 } } })));
    assert.equal(fast.proposed.feasible, true);
    assert.equal(fast.current.feasible, false);
});
test('each required member needs readable size; only declared optional outliers may be omitted', () => {
    const i = input([subject(), subject('friend', [0, 0, -40])]);
    const required = proposal(composeCamera(change(i, { shot: { ...i.shot, requiredSubjects: ['actor', 'friend'] } })));
    assert.equal(required.status, 'infeasible');
    assert.ok(required.proposed.members.find(x => x.subject === 'friend')!.issues.includes('too-small'));
    const optional = proposal(composeCamera(change(i, { shot: { ...i.shot, optionalSubjects: ['friend'] } })));
    assert.equal(optional.status, 'ready');
    assert.deepEqual(optional.omittedOptional, ['friend']);
    const distant = input([subject(), subject('friend', [10, 0, 0])]);
    assert.equal(proposal(composeCamera(change(distant, { shot: { ...distant.shot, requiredSubjects: ['actor', 'friend'] } }))).status, 'infeasible');
});
test('full/medium chest-only and clipped-head frames cannot pass; missing anatomy remains incomplete', () => {
    const i = input(), chest = { ...i.pose, eyeM: [0, .8, 1] as CameraVec3, targetM: [0, .8, 0] as CameraVec3, verticalFovRadians: .45 };
    const full = proposal(composeCamera(change(i, { pose: chest, options: { ...i.options, maxCorrectionMps: 0, maxLensRadiansPerSecond: 0 } })));
    assert.equal(full.current.feasible, false);
    assert.equal(full.proposed.feasible, false);
    const medium = change(i, { shot: { ...i.shot, extent: 'medium' as const }, pose: chest, details: [{ subject: 'actor', mediumBounds: { min: [-.3, .7, -.2], max: [.3, 1.8, .2] } }], options: { ...i.options, maxCorrectionMps: 0, maxLensRadiansPerSecond: 0 } });
    assert.equal(proposal(composeCamera(medium)).status, 'infeasible');
    assert.equal(composeCamera(change(medium, { details: [] })).status, 'incomplete');
    const nohead = subject();
    assert.equal(nohead.state, 'present');
    if (nohead.state !== 'present')
        return;
    assert.equal(composeCamera(change(medium, { observation: { ...i.observation, subjects: [{ ...nohead, anchors: [] }] } })).status, 'incomplete');
    const near = proposal(composeCamera(change(i, { pose: { ...i.pose, eyeM: [0, .9, .1], targetM: [0, .9, -1] } })));
    assert.equal(near.status, 'infeasible');
    assert.ok(near.proposed.members[0].issues.includes('near-or-far-clipped'));
});
test('action framing includes measured action and public role subject; missing facts are incomplete', () => {
    const i = input(), actor = subject();
    if (actor.state !== 'present')
        throw Error('fixture');
    const a = { ...actor, anchors: [...actor.anchors, { role: 'activity' as const, localM: [.2, 1, 0] as CameraVec3, confidence: 1 }], activity: { kind: 'use', roles: [{ role: 'object' as const, subject: 'object' }] } };
    const action = change(i, { observation: { ...i.observation, subjects: [a, subject('object', [.5, 0, 0])] }, shot: { ...i.shot, extent: 'activity' as const } });
    const r = proposal(composeCamera(action));
    assert.equal(r.proposed.members.length, 2);
    assert.ok(r.proposed.members.every(x => x.required));
    assert.equal(composeCamera(change(action, { observation: { ...i.observation, subjects: [a] } })).status, 'incomplete');
    assert.equal(composeCamera(change(action, { observation: { ...i.observation, subjects: [actor, subject('object')] } })).status, 'incomplete');
});
test('lens stays bounded and stable by explicit shot/reset identity across revision/aspect changes', () => {
    const i = input(), first = proposal(composeCamera(i));
    const changed = change(i, { observation: { ...i.observation, version: { ...version, revision: '2' }, subjects: [{ ...subject(), version: { ...version, revision: '2' } }] }, shot: { ...i.shot, version: { ...version, revision: '2' }, viewport: { ...portrait, widthCssPx: 844, heightCssPx: 390 } }, previous: first.state, context: { ...i.context, clock: { nowSeconds: 2, deltaSeconds: .1 } } });
    const next = proposal(composeCamera(changed));
    assert.ok(Math.abs(next.pose.verticalFovRadians - first.pose.verticalFovRadians) <= .04 + 1e-12);
    assert.ok(next.pose.verticalFovRadians >= i.shot.lens.minVerticalFovRadians && next.pose.verticalFovRadians <= i.shot.lens.maxVerticalFovRadians);
    const reset = proposal(composeCamera(change(i, { previous: { ...first.state, verticalFovRadians: 1.2 }, resetId: 'new-seek' })));
    close(reset.pose.verticalFovRadians, .8);
    const stopped = proposal(composeCamera(change(i, { previous: first.state, context: { ...i.context, clock: { nowSeconds: 1, deltaSeconds: 0 } } })));
    close(stopped.pose.verticalFovRadians, first.state.verticalFovRadians);
    assert.deepEqual(stopped.correctionWorldM, [0, 0, 0]);
});
test('fractional depicted time survives, inputs remain untouched, and malformed or exhausted inputs refuse', () => {
    const i = input(), before = structuredClone(i);
    proposal(composeCamera(i));
    assert.deepEqual(i, before);
    assert.equal(composeCamera(change(i, { context: { ...i.context, grant: { queries: 0, candidates: 0 } } })).status, 'incomplete');
    assert.equal(composeCamera(change(i, { options: { ...i.options, comfortRegion: { left: 0, top: 0, right: 1, bottom: 1 } } })).status, 'rejected');
    assert.equal(composeCamera(change(i, { pose: { ...i.pose, up: [0, 0, 1] } })).status, 'rejected');
    assert.equal(projectCompositionBounds(bounds, transform, i.pose, { ...portrait, insetsCssPx: { left: 500, top: 0, right: 0, bottom: 0 } }), null);
    assert.equal(composeCamera(change(i, { previous: { shotId: 'shot', resetId: 'live-epoch', verticalFovRadians: .8, nowSeconds: 2 } })).status, 'rejected');
});
test('proposal clipping matches returned shot lens while current retains its actual planes', () => {
    const i = input(), r = proposal(composeCamera(change(i, { shot: { ...i.shot, lens: { ...i.shot.lens, nearM: 4.5 } } })));
    assert.equal(r.current.feasible, true);
    assert.equal(r.proposed.feasible, false);
    assert.equal(r.pose.nearM, 4.5);
    assert.ok(r.proposed.members[0].issues.includes('near-or-far-clipped'));
});
test('explicit medium chest crop still requires the measured head in the frame', () => {
    const i = input(), chestPose = { ...i.pose, eyeM: [0, 1, 1.5] as CameraVec3, targetM: [0, 1, 0] as CameraVec3, verticalFovRadians: .45 };
    const crop: CameraBounds = { min: [-.15, .9, -.1], max: [.15, 1.1, .1] };
    // Crop fits, but actual head y1.75 is above the full viewport and must not disappear from the check.
    const cropProjection = projectCompositionBounds(crop, transform, chestPose, portrait)!;
    assert.ok(cropProjection.top >= 0 && cropProjection.bottom <= 1);
    const r = proposal(composeCamera(change(i, { shot: { ...i.shot, extent: 'medium' as const }, pose: chestPose, details: [{ subject: 'actor', mediumBounds: crop }], options: { ...i.options, maxCorrectionMps: 0, maxLensRadiansPerSecond: 0 } })));
    assert.equal(r.current.feasible, false);
    assert.equal(r.status, 'infeasible');
    assert.ok(r.current.members[0].issues.includes('outside-region'));
});
test('required unknown bounds are incomplete; zero-work and lens-bound changes do not silently pass', () => {
    const i = input(), s = subject();
    if (s.state !== 'present')
        throw Error('fixture');
    assert.equal(composeCamera(change(i, { observation: { ...i.observation, subjects: [{ ...s, bounds: null }] } })).status, 'incomplete');
    const exhausted = composeCamera(change(i, { context: { ...i.context, grant: { queries: 0, candidates: 1 } } }));
    assert.equal(exhausted.status, 'incomplete');
    if (exhausted.status === 'incomplete')
        assert.ok(exhausted.work <= 1);
    const previous = { shotId: 'shot', resetId: 'live-epoch', verticalFovRadians: 1.2, nowSeconds: 1 };
    assert.equal(composeCamera(change(i, { previous, shot: { ...i.shot, lens: { ...i.shot.lens, maxVerticalFovRadians: 1 } } })).status, 'rejected');
    assert.equal(proposal(composeCamera(change(i, { previous, resetId: 'new-shot', shot: { ...i.shot, lens: { ...i.shot.lens, maxVerticalFovRadians: 1 } } }))).pose.verticalFovRadians, .8);
});
test('unapplied prior lens cannot bypass per-step correction rate', () => {
    const i = input();
    assert.equal(composeCamera(change(i, { previous: { shotId: i.shotId, resetId: i.resetId, verticalFovRadians: 1.2, nowSeconds: 1 } })).status, 'rejected');
});
test('selected anchor and duplicate role traversals are admitted before validation/lookup', () => {
    const i = input(), s = subject();
    if (s.state !== 'present')
        throw Error('fixture');
    const manyAnchors = { ...s, anchors: Array.from({ length: 10000 }, () => ({ role: 'root' as const, localM: [0, 0, 0] as CameraVec3, confidence: 1 })) };
    const a = composeCamera(change(i, { observation: { ...i.observation, subjects: [manyAnchors] }, context: { ...i.context, grant: { queries: 0, candidates: 100 } } }));
    assert.equal(a.status, 'incomplete');
    if (a.status === 'incomplete') {
        assert.deepEqual(a.missing, ['work-limit']);
        assert.ok(a.work <= 100);
    }
    const manyRoles = { ...s, activity: { kind: 'use', roles: Array.from({ length: 10000 }, () => ({ role: 'object' as const, subject: 'object' })) } };
    const r = composeCamera(change(i, { shot: { ...i.shot, extent: 'activity' as const }, observation: { ...i.observation, subjects: [manyRoles, subject('object')] }, context: { ...i.context, grant: { queries: 0, candidates: 100 } } }));
    assert.equal(r.status, 'incomplete');
    if (r.status === 'incomplete') {
        assert.deepEqual(r.missing, ['work-limit']);
        assert.ok(r.work <= 100);
    }
});
test('small required activity object needs explicit role readability; primary and clipping remain hard', () => {
    const i = input(), s = subject();
    if (s.state !== 'present')
        throw Error('fixture');
    const actor = { ...s, anchors: [...s.anchors, { role: 'activity' as const, localM: [.2, 1, 0] as CameraVec3, confidence: 1 }], activity: { kind: 'use', roles: [{ role: 'object' as const, subject: 'object' }] } };
    const object = { ...s, id: 'object', transform: { ...transform, positionM: [.5, 0, 0] as CameraVec3 }, anchors: [], bounds: { min: [-.05, .95, -.05] as CameraVec3, max: [.05, 1.05, .05] as CameraVec3 } };
    const action = change(i, { shot: { ...i.shot, extent: 'activity' as const }, observation: { ...i.observation, subjects: [actor, object] } });
    assert.equal(proposal(composeCamera(action)).status, 'infeasible');
    const explicit = change(action, { details: [{ subject: 'object', roleHeightFraction: { min: .02, max: .08 }, actionBounds: object.bounds }] });
    const r = proposal(composeCamera(explicit));
    assert.equal(r.status, 'ready');
    const member = r.proposed.members.find(x => x.subject === 'object')!;
    assert.equal(member.required, true);
    assert.ok(member.heightFraction! >= .02 && member.heightFraction! <= .08);
    assert.equal(proposal(composeCamera(change(explicit, { observation: { ...i.observation, subjects: [actor, { ...object, transform: { ...object.transform, positionM: [10, 0, 0] } }] } }))).status, 'infeasible');
    assert.equal(proposal(composeCamera(change(explicit, { shot: { ...action.shot, heightFraction: { min: .95, max: .99 } } }))).status, 'infeasible');
    assert.equal(composeCamera(change(explicit, { details: [...explicit.details!, { subject: 'actor', roleHeightFraction: { min: .01, max: 1 } }] })).status, 'rejected');
    assert.equal(composeCamera(change(explicit, { details: [{ subject: 'object', roleHeightFraction: { min: 0, max: .08 } }] })).status, 'rejected');
});
