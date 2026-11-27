/** Displayed-state contracts, not a world protocol. Adapters convert native µs/mm to seconds/metres.
 * Right-handed world XYZ, +Y up. Bounds and anchors are subject-local metres; facing/velocity are world vectors.
 * Quaternions are unit [x,y,z,w] local-to-world rotations. Never derive facing from travel: the depicted take's
 * atan2(dz,dx) heading may describe motion rather than a measured face. Unknown facts stay null. */
export type CameraVec3 = readonly [number, number, number];
export type CameraVersion = Readonly<{ world: string; epoch: string; revision: string }>;
export type CameraBounds = Readonly<{ min: CameraVec3; max: CameraVec3 }>;
export type CameraTransform = Readonly<{ positionM: CameraVec3; rotationXyzw: readonly [number, number, number, number] }>;
export type CameraFact<T> = Readonly<{ value: T; confidence: number; source: 'displayed' | 'derived' }>;
export type CameraAnchor = Readonly<{ role: 'root' | 'head' | 'eyes' | 'activity' | 'seat' | 'grip'; localM: CameraVec3; confidence: number }>;
export type CameraSubject = Readonly<{ id: string; version: CameraVersion }> & (
  | Readonly<{ state: 'unavailable'; reason: 'not-published' | 'unplaced' | 'not-loaded' }>
  | Readonly<{ state: 'present'; transform: CameraTransform; bounds: CameraBounds | null; anchors: readonly CameraAnchor[];
      confidence: number; facing: CameraFact<CameraVec3> | null; travelMps: CameraFact<CameraVec3> | null;
      activity: Readonly<{ kind: string; roles: readonly Readonly<{ role: 'actor' | 'partner' | 'object' | 'carrier'; subject: string }>[] }> | null;
      carrier: Readonly<{ state: 'none' }> | Readonly<{ state: 'attached'; subject: string; relation: 'aboard' | 'seated' | 'carried'; confidence: number }> | null }>);
export type CameraObservation = Readonly<{ schema: 'camera-observation/1'; version: CameraVersion;
  /** Opaque label for an audience already authorized by the adapter. Equality never grants permission. */
  audience: string; coordinateFrame: 'world-y-up-rh'; units: Readonly<{ distance: 'm'; time: 's'; angle: 'rad' }>;
  depicted: Readonly<{ tick: number; seconds: number }>; coverage: 'complete' | 'partial'; subjects: readonly CameraSubject[] }>;
/** Explicit replay inputs. Work grants are effective counts, including zero, not a request for more work.
 * Clock is caller monotonic time, separate from depicted world time (which may seek backwards). No ambient clock/RNG. */
export type CameraStepContext = Readonly<{ clock: Readonly<{ nowSeconds: number; deltaSeconds: number }>; seed: number;
  grant: Readonly<{ queries: number; candidates: number }> }>;
export type CameraContractResult<T> =
  | Readonly<{ status: 'ready'; value: T }>
  | Readonly<{ status: 'incomplete'; value: T; missing: readonly string[]; fallback: 'available-data-only' | 'hold-current-view' }>
  | Readonly<{ status: 'rejected'; reason: CameraContractReason; path: string }>;
export type CameraContractReason = 'camera.schema-unsupported' | 'camera.observation-malformed' | 'camera.context-malformed'
  | 'camera.shot-malformed' | 'camera.request-malformed' | 'camera.world-mismatch' | 'camera.epoch-mismatch'
  | 'camera.revision-mismatch' | 'camera.audience-mismatch' | 'camera.authority-mismatch' | 'camera.required-subject-unavailable';

// Small shared predicates for these three contract modules; no dependency or renderer type is admitted.
export const contractRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const contractText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const contractNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const contractCount = (v: unknown): v is number => contractNumber(v) && Number.isSafeInteger(v) && v >= 0;
export const contractVec = (v: unknown, n = 3): v is number[] => Array.isArray(v) && v.length === n && Array.from(v).every(contractNumber);
export const contractConfidence = (v: unknown) => contractNumber(v) && v >= 0 && v <= 1;
export const contractBounds = (v: unknown): v is CameraBounds => contractRecord(v) && contractVec(v.min) && contractVec(v.max)
  && v.min.every((x, i) => x <= (v.max as number[])[i]);
export const contractVersion = (v: unknown): v is CameraVersion => contractRecord(v) && contractText(v.world) && contractText(v.epoch) && contractText(v.revision);
export const contractRejected = (reason: CameraContractReason, path: string) => ({ status: 'rejected' as const, reason, path });
export function cameraVersionMismatch(a: CameraVersion, b: CameraVersion): CameraContractReason | null {
  return a.world !== b.world ? 'camera.world-mismatch' : a.epoch !== b.epoch ? 'camera.epoch-mismatch'
    : a.revision !== b.revision ? 'camera.revision-mismatch' : null;
}
/** Reject functions, renderer instances, cycles, nonfinite values and deep object graphs rather than coercing them. */
export function cameraPlainData(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 64 || (!Array.isArray(value) && !contractRecord(value)) || ancestors.has(value as object)) return false;
  ancestors.add(value as object);
  const values = Array.isArray(value) ? Array.from(value) : Object.values(value as object);
  const ok = values.every(v => cameraPlainData(v, ancestors, depth + 1));
  ancestors.delete(value as object); return ok;
}
function fact(v: unknown, direction: boolean): boolean {
  return v === null || (contractRecord(v) && contractVec(v.value) && contractConfidence(v.confidence)
    && ['displayed', 'derived'].includes(v.source as string) && (!direction || Math.abs(Math.hypot(...v.value) - 1) <= 1e-6));
}
function present(v: Record<string, unknown>): boolean {
  const t = v.transform, a = v.activity, c = v.carrier;
  return contractRecord(t) && contractVec(t.positionM) && contractVec(t.rotationXyzw, 4)
    && Math.abs(Math.hypot(...t.rotationXyzw) - 1) <= 1e-6 && (v.bounds === null || contractBounds(v.bounds))
    && contractConfidence(v.confidence) && Array.isArray(v.anchors) && v.anchors.every(x => contractRecord(x)
      && ['root', 'head', 'eyes', 'activity', 'seat', 'grip'].includes(x.role as string) && contractVec(x.localM) && contractConfidence(x.confidence))
    && fact(v.facing, true) && fact(v.travelMps, false)
    && (a === null || (contractRecord(a) && contractText(a.kind) && Array.isArray(a.roles) && a.roles.every(r => contractRecord(r)
      && ['actor', 'partner', 'object', 'carrier'].includes(r.role as string) && contractText(r.subject))))
    && (c === null || (contractRecord(c) && (c.state === 'none' || (c.state === 'attached' && contractText(c.subject)
      && ['aboard', 'seated', 'carried'].includes(c.relation as string) && contractConfidence(c.confidence)))));
}
export function validateCameraObservation(input: unknown): CameraContractResult<CameraObservation> {
  if (!contractRecord(input) || input.schema !== 'camera-observation/1') return contractRejected('camera.schema-unsupported', 'observation.schema');
  if (!cameraPlainData(input) || !contractVersion(input.version) || !contractText(input.audience)
    || input.coordinateFrame !== 'world-y-up-rh' || !contractRecord(input.units) || input.units.distance !== 'm'
    || input.units.time !== 's' || input.units.angle !== 'rad' || !contractRecord(input.depicted)
    || !contractNumber(input.depicted.tick) || !contractNumber(input.depicted.seconds) || input.depicted.seconds < 0
    || !['complete', 'partial'].includes(input.coverage as string) || !Array.isArray(input.subjects))
    return contractRejected('camera.observation-malformed', 'observation');
  const ids = new Set<string>(), missing: string[] = input.coverage === 'partial' ? ['observation.coverage'] : [];
  for (const [i, s] of input.subjects.entries()) {
    const path = `observation.subjects[${i}]`;
    if (!contractRecord(s) || !contractText(s.id) || ids.has(s.id) || !contractVersion(s.version)) return contractRejected('camera.observation-malformed', path);
    ids.add(s.id);
    const mismatch = cameraVersionMismatch(s.version, input.version); if (mismatch) return contractRejected(mismatch, `${path}.version`);
    if (s.state === 'unavailable' && ['not-published', 'unplaced', 'not-loaded'].includes(s.reason as string)) {
      // An unavailable subject must carry no guessed pose/shape/knowledge from another audience.
      if (Object.keys(s).some(k => !['id', 'version', 'state', 'reason'].includes(k))) return contractRejected('camera.observation-malformed', path);
      missing.push(`${s.id}.unavailable`); continue;
    }
    if (s.state !== 'present' || !present(s)) return contractRejected('camera.observation-malformed', path);
    for (const key of ['bounds', 'facing', 'travelMps', 'activity', 'carrier']) if (s[key] === null) missing.push(`${s.id}.${key}`);
    if (!(s.anchors as unknown[]).length) missing.push(`${s.id}.anchors`);
  }
  const value = input as CameraObservation;
  const available = new Set(value.subjects.filter(s => s.state === 'present').map(s => s.id));
  for (const s of value.subjects) if (s.state === 'present') {
    if (s.carrier?.state === 'attached' && !available.has(s.carrier.subject)) missing.push(`${s.id}.carrier-subject`);
    for (const role of s.activity?.roles ?? []) if (!available.has(role.subject)) missing.push(`${s.id}.activity-subject.${role.subject}`);
  }
  // Unknown metadata never means permission to invent a pose or read hidden data. Required framing is checked by shot validation.
  return missing.length ? { status: 'incomplete', value, missing, fallback: 'available-data-only' } : { status: 'ready', value };
}
export function validateCameraStep(input: unknown, context: unknown): CameraContractResult<Readonly<{ observation: CameraObservation; context: CameraStepContext }>> {
  if (!cameraPlainData(context) || !contractRecord(context) || !contractRecord(context.clock)
    || !contractNumber(context.clock.nowSeconds) || context.clock.nowSeconds < 0 || !contractNumber(context.clock.deltaSeconds)
    || context.clock.deltaSeconds < 0 || !contractCount(context.seed) || context.seed > 0xffffffff || !contractRecord(context.grant)
    || !contractCount(context.grant.queries) || !contractCount(context.grant.candidates)) return contractRejected('camera.context-malformed', 'context');
  const observed = validateCameraObservation(input); if (observed.status === 'rejected') return observed;
  const value = { observation: observed.value, context: context as CameraStepContext };
  return observed.status === 'incomplete' ? { ...observed, value } : { status: 'ready', value };
}
