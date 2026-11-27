import { cameraPlainData, cameraVersionMismatch, contractBounds, contractNumber, contractRecord, contractRejected, contractText, contractVersion } from './observation.ts';
import type { CameraBounds, CameraContractResult, CameraObservation, CameraVersion } from './observation.ts';

/** Actual rendered camera viewport, with safe-area and UI composition insets already combined by the caller in CSS pixels.
 * Supply each inset once, not separate additive copies. Portrait mobile is composed from this usable aspect,
 * never a cropped landscape shot. The full rendered viewport defines projection aspect; insets define a separate
 * composition aspect. If the renderer actually crops its viewport, supply those actual cropped dimensions/insets.
 * DPR records render scale; it does not rescale CSS-space insets. */
export type CameraViewport = Readonly<{ widthCssPx: number; heightCssPx: number; deviceScaleFactor: number;
  insetsCssPx: Readonly<{ left: number; top: number; right: number; bottom: number }> }>;
export function cameraUsableViewport(input: unknown): Readonly<{ widthCssPx: number; heightCssPx: number; originCssPx: readonly [number, number]; compositionAspect: number; projectionAspect: number }> | null {
  if (!contractRecord(input) || !contractNumber(input.widthCssPx) || !contractNumber(input.heightCssPx)
    || input.widthCssPx <= 0 || input.heightCssPx <= 0 || !contractNumber(input.deviceScaleFactor)
    || input.deviceScaleFactor <= 0 || !contractRecord(input.insetsCssPx)) return null;
  const i = input.insetsCssPx;
  if (![i.left, i.top, i.right, i.bottom].every(v => contractNumber(v) && v >= 0)) return null;
  const widthCssPx = input.widthCssPx - Number(i.left) - Number(i.right);
  const heightCssPx = input.heightCssPx - Number(i.top) - Number(i.bottom);
  const compositionAspect = widthCssPx / heightCssPx, projectionAspect = input.widthCssPx / input.heightCssPx;
  return widthCssPx > 0 && heightCssPx > 0 && Number.isFinite(compositionAspect) && compositionAspect > 0
    && Number.isFinite(projectionAspect) && projectionAspect > 0
    ? { widthCssPx, heightCssPx, originCssPx: [Number(i.left), Number(i.top)], compositionAspect, projectionAspect } : null;
}

export type CameraLensBounds = Readonly<{ minVerticalFovRadians: number; maxVerticalFovRadians: number; nearM: number; farM: number }>;
export type CameraShotIntent = Readonly<{ schema: 'camera-shot/1'; version: CameraVersion; mode: 'follow' | 'broadcast';
  requiredSubjects: readonly string[]; optionalSubjects: readonly string[];
  /** World-space interest region allows meaningful quiet coverage with no subjects. */
  focusRegionM: CameraBounds | null; extent: 'full' | 'medium' | 'activity';
  /** Normalized coordinates within the usable viewport AFTER supplied safe/UI insets, origin top-left.
   * heightFraction is relative to usable height. Vertical lens FOV projects at the FULL rendered viewport aspect,
   * not the inset composition aspect. For normalized usable (u,v), full-viewport coordinates are
   * ((leftInset + u*usableWidth)/viewportWidth, (topInset + v*usableHeight)/viewportHeight);
   * this preserves asymmetric insets without re-centering the projection. */
  viewport: CameraViewport; screenRegion: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  heightFraction: Readonly<{ min: number; max: number }>; lens: CameraLensBounds }>;

export function cameraLensValid(v: unknown): v is CameraLensBounds {
  return contractRecord(v) && contractNumber(v.minVerticalFovRadians) && contractNumber(v.maxVerticalFovRadians)
    && v.minVerticalFovRadians > 0 && v.minVerticalFovRadians <= v.maxVerticalFovRadians && v.maxVerticalFovRadians < Math.PI
    && contractNumber(v.nearM) && contractNumber(v.farM) && v.nearM > 0 && v.farM > v.nearM;
}
/** observation must be the value of validateCameraObservation/validateCameraStep, not arbitrary unvalidated input. */
export function validateCameraShot(input: unknown, observation: CameraObservation): CameraContractResult<CameraShotIntent> {
  if (!contractRecord(input) || input.schema !== 'camera-shot/1') return contractRejected('camera.schema-unsupported', 'shot.schema');
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(contractText) && new Set(v).size === v.length;
  const r = input.screenRegion, h = input.heightFraction;
  if (!cameraPlainData(input) || !contractVersion(input.version) || !['follow', 'broadcast'].includes(input.mode as string)
    || !ids(input.requiredSubjects) || !ids(input.optionalSubjects) || input.requiredSubjects.some(id => (input.optionalSubjects as string[]).includes(id))
    || (input.focusRegionM !== null && !contractBounds(input.focusRegionM)) || (!input.requiredSubjects.length && input.focusRegionM === null)
    || !['full', 'medium', 'activity'].includes(input.extent as string) || !contractRecord(r)
    || ![r.left, r.top, r.right, r.bottom].every(contractNumber) || !(Number(r.left) >= 0 && Number(r.left) < Number(r.right) && Number(r.right) <= 1)
    || !(Number(r.top) >= 0 && Number(r.top) < Number(r.bottom) && Number(r.bottom) <= 1)
    || !contractRecord(h) || !contractNumber(h.min) || !contractNumber(h.max) || !(h.min > 0 && h.min <= h.max && h.max <= 1)
    || !cameraUsableViewport(input.viewport) || !cameraLensValid(input.lens)) return contractRejected('camera.shot-malformed', 'shot');
  const mismatch = cameraVersionMismatch(input.version, observation.version); if (mismatch) return contractRejected(mismatch, 'shot.version');
  const missing: string[] = [];
  for (const id of input.requiredSubjects) {
    const s = observation.subjects.find(s => s.id === id);
    if (!s || s.state !== 'present') return contractRejected('camera.required-subject-unavailable', `shot.requiredSubjects.${id}`);
    if (s.bounds === null) missing.push(`${id}.bounds`);
    if (input.extent === 'activity' && !s.anchors.some(a => a.role === 'activity')) missing.push(`${id}.activity-anchor`);
  }
  const value = input as CameraShotIntent;
  // No required subject may be dropped or successful framing claimed from guessed bounds. Caller revalidates any held pose.
  if (missing.length) return { status: 'incomplete', value, missing, fallback: 'hold-current-view' };
  for (const id of input.optionalSubjects) if (!observation.subjects.some(s => s.id === id && s.state === 'present')) missing.push(`${id}.optional`);
  return missing.length ? { status: 'incomplete', value, missing, fallback: 'available-data-only' } : { status: 'ready', value };
}
