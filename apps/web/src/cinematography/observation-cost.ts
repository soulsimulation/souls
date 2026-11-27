/** Passive measurement only. No camera/world setter, scheduler or worker. */
export const COST_LAYOUT = Object.freeze({ version: 'camera-observation-cost/1', capacity: 600, slots: 80,
  field: { sequence: 0, epoch: 1, at: 2, tick: 3, seconds: 4, controllerClock: 5, controllerStep: 6, invoked: 7, start: 8, end: 9, outcome: 10, callbackStart: 11, callbackEnd: 12, cameraWorld: 16, projection: 32, width: 48, height: 49, bufferWidth: 50, bufferHeight: 51, pixelRatio: 52, mode: 53, publicIdentity: 54, history: 55, seek: 56, takeStart: 57, takeTicks: 58, dt: 59, callbackFailed: 62 } });
export type CostDraw = { tick: number; seconds: number; controllerClock: number; controllerStep: number; callbackStart: number; cameraWorld: readonly number[]; projection: readonly number[]; viewport: readonly number[]; mode: number; publicIdentity: readonly string[]; history?: boolean; seek?: number; takeStart?: number; takeTicks?: number; dt?: number };
export type CostSnapshot = { version: string; epoch: number; first: number; last: number; total: number; count: number; dropped: number; overwrites: number; exports: number; exportMs: number; numericBufferBytes: number; encoding: 'float64-le-base64'; data: string; failure: string | null; identities: readonly (readonly string[])[] };
type Witness = { status: 'complete'; before: string; after: string; equal: boolean; bytes: number } | { status: 'refused'; reason: string };
let nextEpoch = 0;
const fail = (reason: string): never => { throw Error('camera-cost-' + reason); };
/** Incrementally bounded canonical encoding; oversized/unsupported values refuse the entire witness. */
export function costWitness(value: unknown, maximum = 524288): { text: string; bytes: number } {
  const parts: string[] = [], seen = new Set<object>(), encoder = new TextEncoder(); let bytes = 0;
  const put = (s: string) => { if (s.length > maximum - bytes) fail('witness-byte-limit'); bytes += encoder.encode(s).length; if (bytes > maximum) fail('witness-byte-limit'); parts.push(s); };
  const visit = (v: unknown, depth: number) => {
    if (depth > 64) fail('witness-depth');
    if (v === null) return put('null');
    if (typeof v === 'undefined') return put('undefined');
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('witness-nonfinite'); return put('n' + (Object.is(v, -0) ? '-0' : String(v))); }
    if (typeof v === 'string') { if (v.length > maximum - bytes) fail('witness-byte-limit'); return put('s' + JSON.stringify(v)); }
    if (typeof v === 'boolean') return put(v ? 'true' : 'false');
    if (typeof v !== 'object' || seen.has(v)) fail('witness-shape');
    const object = v as Record<string, unknown>; if (!Array.isArray(v) && ![null, Object.prototype].includes(Object.getPrototypeOf(v))) fail('witness-shape');
    seen.add(v); put(Array.isArray(v) ? '[' : '{');
    const one = (key: string) => { const d = Object.getOwnPropertyDescriptor(v, key); if (!d || !('value' in d)) fail('witness-accessor-or-hole'); put(JSON.stringify(key) + ':'); visit(d!.value, depth + 1); put(','); };
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) one(String(i)); }
    else { const keys: string[] = []; for (const key in object) if (Object.hasOwn(object, key)) { if (keys.length >= maximum / 4) fail('witness-byte-limit'); keys.push(key); } for (const key of keys.sort()) one(key); }
    put(Array.isArray(v) ? ']' : '}'); seen.delete(v);
  };
  visit(value, 0); return { text: parts.join(''), bytes };
}
export class ObservationCostRing {
  readonly epoch = ++nextEpoch;
  readonly numericBufferBytes = 600 * 80 * 8;
  private values = new Float64Array(600 * 80);
  private sequence = 0; private exports = 0;
  failure: string | null = null;
  refuse(reason: string) { this.failure ??= reason; }
  status() { return { epoch: this.epoch, total: this.sequence, failure: this.failure, witnessPlan: [...this.witnessPlan], witnessCount: this.witnesses.size }; }
  private identities: string[][] = [];
  private witnessPlan: Set<number>; private witnesses = new Map<number, Witness>();
  constructor(witnessSequences: readonly number[] = []) {
    if (witnessSequences.length > 8 || new Set(witnessSequences).size !== witnessSequences.length || witnessSequences.some(n => !Number.isSafeInteger(n) || n < 1)) fail('witness-plan');
    this.witnessPlan = new Set(witnessSequences);
  }
  begin(draw: CostDraw, witness?: () => unknown) {
    const identity = [...draw.publicIdentity];
    if (identity.length !== 3 || identity.some(s => typeof s !== 'string' || new TextEncoder().encode(s).length > 256)) fail('public-identity');
    let identityIndex = this.identities.findIndex(v => v.every((s, i) => s === identity[i]));
    if (identityIndex < 0) { if (this.identities.length === 8) fail('public-identity-limit'); this.identities.push(identity); identityIndex = this.identities.length - 1; }
    const seq = ++this.sequence, offset = ((seq - 1) % 600) * 80, row = this.values.subarray(offset, offset + 80); row.fill(0);
    row.set([seq, this.epoch, performance.now(), draw.tick, draw.seconds, draw.controllerClock, draw.controllerStep]); row[11] = draw.callbackStart;
    if (draw.cameraWorld.length !== 16 || draw.projection.length !== 16 || draw.viewport.length !== 5) fail('draw-layout');
    row.set(draw.cameraWorld, 16); row.set(draw.projection, 32); row.set(draw.viewport, 48); row[53] = draw.mode; row.set([identityIndex + 1, Number(draw.history ?? false), draw.seek ?? 0, draw.takeStart ?? 0, draw.takeTicks ?? 0, draw.dt ?? 0], 54);
    let before: ReturnType<typeof costWitness> | null = null;
    if (this.witnessPlan.has(seq)) { try { if (!witness) fail('witness-missing'); before = costWitness(witness!()); } catch { this.witnesses.set(seq, { status: 'refused', reason: 'camera-cost-witness-refused' }); } }
    return { seq, offset, before };
  }
  end(token: ReturnType<ObservationCostRing['begin']>, span: { invoked: boolean; start: number; end: number; outcome: number }, witness?: () => unknown) {
    if (this.values[token.offset] !== token.seq) fail('draw-overwritten');
    this.values.set([Number(span.invoked), span.start, span.end, span.outcome], token.offset + 7);
    if (token.before) { try { if (!witness) fail('witness-missing'); const after = costWitness(witness!()); this.witnesses.set(token.seq, { status: 'complete', before: token.before.text, after: after.text, equal: token.before.text === after.text, bytes: token.before.bytes + after.bytes }); } catch { this.witnesses.set(token.seq, { status: 'refused', reason: 'camera-cost-witness-refused' }); } }
  }
  callbackEnd(sequence: number, at: number, failed = false) { const offset = ((sequence - 1) % 600) * 80; if (this.values[offset] !== sequence) fail('draw-overwritten'); this.values[offset + 12] = at; this.values[offset + 62] = Number(failed); }
  read(after: number, epoch = this.epoch): CostSnapshot {
    const started = performance.now(); if (epoch !== this.epoch || !Number.isSafeInteger(after) || after < 0 || after > this.sequence) fail('cursor');
    const first = Math.max(after + 1, this.sequence - 599, 1), count = Math.max(0, this.sequence - first + 1), bytes = new Uint8Array(count * 80 * 8), data = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) for (let j = 0; j < 80; j++) data.setFloat64((i * 80 + j) * 8, this.values[((first + i - 1) % 600) * 80 + j], true);
    let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    const encoded = btoa(binary); return { version: COST_LAYOUT.version, epoch: this.epoch, first, last: this.sequence, total: this.sequence, count, dropped: Math.max(0, first - after - 1), overwrites: Math.max(0, this.sequence - 600), exports: ++this.exports, exportMs: performance.now() - started, numericBufferBytes: this.numericBufferBytes, failure: this.failure, identities: this.identities.map(v => [...v]), encoding: 'float64-le-base64', data: encoded };
  }
  readWitnesses() { return [...this.witnesses].map(([sequence, value]) => ({ sequence, ...value })); }
}
