import { cameraPlainData, cameraVersionMismatch, contractNumber, contractRecord, contractRejected, contractText, contractVec, contractVersion } from './observation.ts';
import type { CameraContractResult, CameraObservation, CameraVec3, CameraVersion } from './observation.ts';
import { cameraUsableViewport, validateCameraShot } from './shot.ts';
import type { CameraShotIntent, CameraViewport } from './shot.ts';

export type CameraInspectionPose = Readonly<{ eyeM: CameraVec3; targetM: CameraVec3; up: CameraVec3;
  verticalFovRadians: number; nearM: number; farM: number }>;
/** This is a local presentation request. The caller has already authorized its audience. Validation only checks
 * compatibility; it grants no audience, actor, server, or inspection authority. Inspection never silently re-aims. */
export type CameraViewRequest = Readonly<{ schema: 'camera-view-request/1'; version: CameraVersion; audience: string; authority: 'observe-only' }> & (
  | Readonly<{ kind: 'cinematic'; shot: CameraShotIntent }>
  | Readonly<{ kind: 'inspection'; viewport: CameraViewport; posePolicy: 'exact-eye'; pose: CameraInspectionPose }>);

/** observation must already have passed validateCameraObservation/validateCameraStep. */
export function validateCameraViewRequest(input: unknown, observation: CameraObservation): CameraContractResult<CameraViewRequest> {
  if (!contractRecord(input) || input.schema !== 'camera-view-request/1') return contractRejected('camera.schema-unsupported', 'request.schema');
  if (!cameraPlainData(input) || !contractVersion(input.version) || !contractText(input.audience)) return contractRejected('camera.request-malformed', 'request');
  const mismatch = cameraVersionMismatch(input.version, observation.version); if (mismatch) return contractRejected(mismatch, 'request.version');
  if (input.audience !== observation.audience) return contractRejected('camera.audience-mismatch', 'request.audience');
  if (input.authority !== 'observe-only') return contractRejected('camera.authority-mismatch', 'request.authority');
  if (input.kind === 'cinematic') {
    const shot = validateCameraShot(input.shot, observation); if (shot.status === 'rejected') return shot;
    const value = input as CameraViewRequest;
    return shot.status === 'incomplete' ? { ...shot, value } : { status: 'ready', value };
  }
  const p = input.pose;
  if (input.kind !== 'inspection' || input.posePolicy !== 'exact-eye' || !cameraUsableViewport(input.viewport) || !contractRecord(p) || !contractVec(p.eyeM)
    || !contractVec(p.targetM) || !contractVec(p.up) || Math.abs(Math.hypot(...p.up) - 1) > 1e-6
    || !contractNumber(p.verticalFovRadians) || p.verticalFovRadians <= 0 || p.verticalFovRadians >= Math.PI
    || !contractNumber(p.nearM) || !contractNumber(p.farM) || p.nearM <= 0 || p.farM <= p.nearM)
    return contractRejected('camera.request-malformed', 'request.pose');
  const d = p.targetM.map((x, i) => x - (p.eyeM as number[])[i]), up = p.up;
  const cross = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  if (Math.hypot(...cross) <= 1e-9) return contractRejected('camera.request-malformed', 'request.pose.basis');
  return { status: 'ready', value: input as CameraViewRequest };
}
