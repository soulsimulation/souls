import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCameraObservation, validateCameraStep } from './observation.ts';
import type { CameraObservation, CameraStepContext, CameraSubject } from './observation.ts';
import { cameraUsableViewport, validateCameraShot } from './shot.ts';
import type { CameraShotIntent } from './shot.ts';
import { validateCameraViewRequest } from './view-request.ts';
import type { CameraViewRequest } from './view-request.ts';

const version = { world: 'fixture-world', epoch: 'fixture-epoch', revision: 'geometry-1' };
const subject = (id: string): CameraSubject => ({ id, version, state: 'present', confidence: 1,
  transform: { positionM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1] }, bounds: { min: [-.3, 0, -.3], max: [.3, 1.8, .3] },
  anchors: [{ role: 'eyes', localM: [0, 1.6, 0], confidence: 1 }], facing: { value: [1, 0, 0], source: 'displayed', confidence: .9 },
  travelMps: { value: [0, 0, 2], source: 'derived', confidence: .8 }, activity: { kind: 'walk', roles: [{ role: 'actor', subject: id }] },
  carrier: { state: 'none' } });
const observation = (): CameraObservation => ({ schema: 'camera-observation/1', version, audience: 'public', coordinateFrame: 'world-y-up-rh',
  units: { distance: 'm', time: 's', angle: 'rad' }, depicted: { tick: 20, seconds: 1 }, coverage: 'complete', subjects: [subject('walker')] });
const viewport = { widthCssPx: 390, heightCssPx: 844, deviceScaleFactor: 3, insetsCssPx: { left: 8, top: 48, right: 8, bottom: 96 } };
const shot = (): CameraShotIntent => ({ schema: 'camera-shot/1', version, mode: 'follow', requiredSubjects: ['walker'], optionalSubjects: [],
  focusRegionM: null, extent: 'full', viewport, screenRegion: { left: .1, top: .1, right: .9, bottom: .9 }, heightFraction: { min: .25, max: .8 },
  lens: { minVerticalFovRadians: .5, maxVerticalFovRadians: 1.2, nearM: .1, farM: 2000 } });
const inspection = (): CameraViewRequest => ({ schema: 'camera-view-request/1', version, audience: 'public', authority: 'observe-only',
  kind: 'inspection', viewport, posePolicy: 'exact-eye', pose: { eyeM: [3, 2, 3], targetM: [0, 1, 0], up: [0, 1, 0], verticalFovRadians: .7, nearM: .1, farM: 2000 } });
const context: CameraStepContext = { clock: { nowSeconds: 20, deltaSeconds: 1 / 60 }, seed: 7, grant: { queries: 0, candidates: 0 } };
const reason = (result: { status: string; reason?: string }) => result.status === 'rejected' ? result.reason : result.status;

test('displayed walker and carrier fixture keep facing, velocity, local anchors and confidence distinct', () => {
  const o = observation(), walker = o.subjects[0];
  assert.equal(validateCameraObservation(o).status, 'ready');
  assert.equal(walker.state, 'present');
  if (walker.state !== 'present') throw Error('fixture');
  assert.notDeepEqual(walker.facing?.value, walker.travelMps?.value);
  const ride: CameraObservation = { ...o, subjects: [{ ...walker, carrier: { state: 'attached', subject: 'boat', relation: 'aboard', confidence: .75 } }, subject('boat')] };
  const result = validateCameraObservation(JSON.parse(JSON.stringify(ride)));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.value.subjects, ride.subjects);
  const noCarrier = validateCameraObservation({ ...ride, subjects: [ride.subjects[0]] });
  assert.equal(noCarrier.status, 'incomplete');
  if (noCarrier.status === 'incomplete') assert.ok(noCarrier.missing.includes('walker.carrier-subject'));
});

test('mixed world, epoch and geometry revisions are refused rather than repaired', () => {
  for (const [key, expected] of [['world', 'camera.world-mismatch'], ['epoch', 'camera.epoch-mismatch'], ['revision', 'camera.revision-mismatch']] as const) {
    const o = observation();
    assert.equal(reason(validateCameraObservation({ ...o, subjects: [{ ...o.subjects[0], version: { ...version, [key]: 'other' } }] })), expected);
    assert.equal(reason(validateCameraShot({ ...shot(), version: { ...version, [key]: 'other' } }, o)), expected);
    assert.equal(reason(validateCameraViewRequest({ ...inspection(), version: { ...version, [key]: 'other' } }, o)), expected);
  }
});

test('malformed required fields, transforms, units and unsupported schemas have named results', () => {
  const o = observation(), s = o.subjects[0];
  const { units: _units, ...missing } = o;
  for (const input of [missing, { ...o, units: { ...o.units, distance: 'mm' } },
    { ...o, subjects: [{ ...s, transform: { positionM: [0, 0, 0], rotationXyzw: [0, 0, 0, 0] } }] },
    { ...o, subjects: [{ ...s, transform: { positionM: [NaN, 0, 0], rotationXyzw: [0, 0, 0, 1] } }] },
    { ...o, subjects: [{ ...s, bounds: { min: [1, 0, 0], max: [0, 1, 1] } }] }]) {
    assert.equal(reason(validateCameraObservation(input)), 'camera.observation-malformed');
  }
  for (const positionM of [Array(3), [0, , 0]]) {
    assert.equal(reason(validateCameraObservation({ ...o, subjects: [{ ...s, transform: { positionM, rotationXyzw: [0, 0, 0, 1] } }] })), 'camera.observation-malformed');
    assert.equal(reason(validateCameraObservation({ ...o, subjects: [{ ...s, bounds: { min: positionM, max: [1, 1, 1] } }] })), 'camera.observation-malformed');
  }
  assert.equal(reason(validateCameraObservation({ ...o, schema: 'camera-observation/999' })), 'camera.schema-unsupported');
  assert.equal(reason(validateCameraShot({ ...shot(), schema: 'camera-shot/999' }, o)), 'camera.schema-unsupported');
  assert.equal(reason(validateCameraViewRequest({ ...inspection(), schema: 'camera-view-request/999' }, o)), 'camera.schema-unsupported');
});

test('incomplete metadata never invents facts; required bounds hold and unavailable subjects cannot be substituted', () => {
  const o = observation(), s = o.subjects[0];
  assert.equal(s.state, 'present'); if (s.state !== 'present') throw Error('fixture');
  const partial: CameraObservation = { ...o, coverage: 'partial', subjects: [{ ...s, facing: null, travelMps: null, activity: null, carrier: null, bounds: null, anchors: [] }] };
  const observed = validateCameraObservation(partial);
  assert.equal(observed.status, 'incomplete');
  if (observed.status !== 'incomplete') throw Error('fixture');
  assert.equal(observed.fallback, 'available-data-only'); assert.ok(observed.missing.includes('walker.facing'));
  assert.equal(observed.value.subjects[0], partial.subjects[0]);
  const framed = validateCameraShot(shot(), observed.value);
  assert.equal(framed.status, 'incomplete'); if (framed.status === 'incomplete') assert.equal(framed.fallback, 'hold-current-view');
  const absent: CameraObservation = { ...o, subjects: [{ id: 'walker', version, state: 'unavailable', reason: 'unplaced' }] };
  assert.equal(validateCameraObservation(absent).status, 'incomplete');
  assert.equal(reason(validateCameraShot(shot(), absent)), 'camera.required-subject-unavailable');
  assert.equal(reason(validateCameraObservation({ ...absent, subjects: [{ ...absent.subjects[0], transform: s.transform }] })), 'camera.observation-malformed');
});

test('optional subjects may be omitted; quiet Broadcast can frame a region without inventing a subject', () => {
  const o = observation();
  const optional = validateCameraShot({ ...shot(), optionalSubjects: ['bystander'] }, o);
  assert.equal(optional.status, 'incomplete'); if (optional.status === 'incomplete') assert.equal(optional.fallback, 'available-data-only');
  assert.equal(validateCameraShot({ ...shot(), mode: 'broadcast', requiredSubjects: [], focusRegionM: { min: [-5, 0, -5], max: [5, 4, 5] } }, o).status, 'ready');
  assert.equal(reason(validateCameraShot({ ...shot(), requiredSubjects: [] }, o)), 'camera.shot-malformed');
  assert.equal(reason(validateCameraShot({ ...shot(), lens: { ...shot().lens, nearM: 0 } }, o)), 'camera.shot-malformed');
  assert.equal(reason(validateCameraShot({ ...shot(), screenRegion: { left: .8, top: 0, right: .2, bottom: 1 } }, o)), 'camera.shot-malformed');
});

test('cinematic and exact-eye inspection preserve audience, lens and authority without moving anything', () => {
  const o = observation(), request = inspection(), before = JSON.stringify([o, request]);
  assert.deepEqual(validateCameraViewRequest(request, o), { status: 'ready', value: request });
  assert.equal(JSON.stringify([o, request]), before);
  assert.equal(validateCameraViewRequest({ schema: 'camera-view-request/1', version, audience: 'public', authority: 'observe-only', kind: 'cinematic', shot: shot() }, o).status, 'ready');
  assert.equal(reason(validateCameraViewRequest({ ...request, audience: 'another-scope' }, o)), 'camera.audience-mismatch');
  assert.equal(reason(validateCameraViewRequest({ ...request, authority: 'move-actor' }, o)), 'camera.authority-mismatch');
  if (request.kind !== 'inspection') throw Error('fixture');
  assert.equal(reason(validateCameraViewRequest({ ...request, pose: { ...request.pose, eyeM: request.pose.targetM } }, o)), 'camera.request-malformed');
  assert.equal(reason(validateCameraViewRequest({ ...request, posePolicy: 'repair-eye' }, o)), 'camera.request-malformed');
});

test('explicit zero grants are valid replay inputs; ambient dependencies and renderer instances are absent', () => {
  const o = observation(), before = JSON.stringify([o, context]);
  assert.deepEqual(validateCameraStep(o, context), validateCameraStep(o, context));
  assert.equal(validateCameraStep(o, context).status, 'ready'); assert.equal(JSON.stringify([o, context]), before);
  for (const c of [{ ...context, seed: -1 }, { ...context, grant: { queries: 1.5, candidates: 0 } }, { ...context, clock: { nowSeconds: 0, deltaSeconds: -1 } }])
    assert.equal(reason(validateCameraStep(o, c)), 'camera.context-malformed');
  class RendererObject { schema = 'camera-observation/1'; }
  assert.equal(reason(validateCameraObservation(new RendererObject())), 'camera.schema-unsupported');
  assert.equal(reason(validateCameraObservation({ ...o, renderer: () => null })), 'camera.observation-malformed');
  const cycle: Record<string, unknown> = { ...o }; cycle.cycle = cycle;
  assert.equal(reason(validateCameraObservation(cycle)), 'camera.observation-malformed');
  for (const file of ['observation.ts', 'shot.ts', 'view-request.ts']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Date\.now|performance\.now|Math\.random|fetch\(|from ['"](?:three|node:)/);
  }
});


test('portrait framing uses actual usable viewport and rejects impossible insets or malformed regions', () => {
  assert.deepEqual(cameraUsableViewport(viewport), { widthCssPx: 374, heightCssPx: 700, aspect: 374 / 700 });
  const o = observation();
  for (const v of [{ ...viewport, widthCssPx: 0 }, { ...viewport, deviceScaleFactor: -1 },
    { ...viewport, insetsCssPx: { ...viewport.insetsCssPx, top: -1 } },
    { ...viewport, insetsCssPx: { ...viewport.insetsCssPx, right: 390 } },
    { ...viewport, insetsCssPx: { ...viewport.insetsCssPx, bottom: 844 } }]) {
    assert.equal(cameraUsableViewport(v), null);
    assert.equal(reason(validateCameraShot({ ...shot(), viewport: v }, o)), 'camera.shot-malformed');
    assert.equal(reason(validateCameraViewRequest({ ...inspection(), viewport: v }, o)), 'camera.request-malformed');
  }
  assert.equal(reason(validateCameraShot({ ...shot(), screenRegion: { left: 0, top: 0, right: 1.1, bottom: 1 } }, o)), 'camera.shot-malformed');
});
