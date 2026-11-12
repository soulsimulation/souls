// #1317: an opt-in, local-only camera trace. `?camtrace` on a world page loads this chunk; without it nothing here runs.
// It records what the camera decided and why (the mode, the target, the pose the viewer asked for and the pose drawn,
// and while following the rule that moved it, from WorldFollow.rule), and the viewer's input as it arrives. Records stay
// in the page; the viewer can download them as JSONL. Times are performance.now() ms, the clock performance.mark uses.
// #2201 A1: it also meters the follow camera's cost, the ms and sightline rays of each follow.resolve call, every frame,
// and the panel shows their median and p95 (the auto-camera note's per-frame budget).

export type Vec = readonly [number, number, number];
export type CameraFrame = { mode: string; target: Vec; eye: Vec; desired?: Vec | null; rule?: { name: string; [k: string]: unknown } | null };
export type TraceRecord =
  | ({ t: number; kind: 'frame' } & CameraFrame)
  | { t: number; kind: 'input'; input: string; detail?: Record<string, number | string> }
  | ({ t: number; kind: 'cost' } & CostSummary);
/** #2201 A1: the follow camera's per-frame cost over the metered frames: median and p95 of ms and of rays. */
export type CostSummary = { frames: number; ms: { median: number; p95: number; max: number }; rays: { median: number; p95: number; max: number } };
export type Override = { t: number; sinceInputMs: number; input: string; rule: string; params: Record<string, unknown>; offMetres: number; offDegrees: number };

/** Automatic rules: anything that moved the camera other than the viewer's own hand. */
const AUTOMATIC = new Set(['collision', 'opening', 'search', 'glide', 'speed-cap']);
export const OVERRIDE_GRACE_MS = 2000, OVERRIDE_METRES = 0.25, OVERRIDE_DEGREES = 3;
const MAX_RECORDS = 50_000, MAX_COST = 50_000;
/** Nearest-rank percentile of `values` (0..1), 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
export function costSummary(ms: readonly number[], rays: readonly number[]): CostSummary {
  const round = (v: number) => Math.round(v * 1000) / 1000, stats = (v: readonly number[]) => ({ median: round(percentile(v, .5)), p95: round(percentile(v, .95)), max: round(v.length ? Math.max(...v) : 0) });
  return { frames: ms.length, ms: stats(ms), rays: stats(rays) };
}
const r3 = (v: Vec): Vec => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);

/** T3: each following frame within the grace period after a viewer input whose rule is automatic and whose drawn camera
 *  is off what the viewer asked for: an automatic move overriding them. One row per run of such frames. */
export function overrides(records: readonly TraceRecord[], grace = OVERRIDE_GRACE_MS): Override[] {
  const out: Override[] = [];
  let input: { t: number; input: string } | null = null, open = false;
  for (const r of records) {
    if (r.kind === 'cost') continue;
    if (r.kind === 'input') { input = { t: r.t, input: r.input }; open = false; continue; }
    if (r.mode !== 'follow' || !input || r.t - input.t > grace || !r.rule || !AUTOMATIC.has(r.rule.name) || !r.desired) { open = false; continue; }
    const actual = sub(r.eye, r.target), off = len(sub(actual, r.desired));
    const cos = (actual[0] * r.desired[0] + actual[1] * r.desired[1] + actual[2] * r.desired[2]) / Math.max(1e-9, len(actual) * len(r.desired));
    const degrees = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (off <= OVERRIDE_METRES && degrees <= OVERRIDE_DEGREES) { open = false; continue; }
    if (open) continue;
    open = true;
    const { name, ...params } = r.rule;
    out.push({ t: r.t, sinceInputMs: Math.round(r.t - input.t), input: input.input, rule: name, params, offMetres: Math.round(off * 100) / 100, offDegrees: Math.round(degrees * 10) / 10 });
  }
  return out;
}

export const toJsonl = (records: readonly TraceRecord[]) => records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');

export class CameraTrace {
  readonly records: TraceRecord[] = [];
  private last = '';
  private now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  private push(r: TraceRecord) { if (this.records.length >= MAX_RECORDS) this.records.shift(); this.records.push(r); }
  /** One frame; kept only when something changed (a moved camera, another mode or rule). */
  frame(f: CameraFrame) {
    const rec = { t: Math.round(this.now() * 10) / 10, kind: 'frame' as const, mode: f.mode, target: r3(f.target), eye: r3(f.eye), desired: f.desired ? r3(f.desired) : null, rule: f.rule ? { ...f.rule } : null };
    const key = JSON.stringify([rec.mode, rec.target, rec.eye, rec.desired, rec.rule]);
    if (key === this.last) return;
    this.last = key; this.push(rec);
  }
  input(input: string, detail?: Record<string, number | string>) { this.push({ t: Math.round(this.now() * 10) / 10, kind: 'input', input, ...(detail ? { detail } : {}) }); }
  private costMs: number[] = [];
  private costRays: number[] = [];
  /** #2201 A1: one follow.resolve call's cost (ms, sightline rays). Every frame is kept (up to MAX_COST, oldest dropped). */
  cost(ms: number, rays: number) {
    if (this.costMs.length >= MAX_COST) { this.costMs.shift(); this.costRays.shift(); }
    this.costMs.push(ms); this.costRays.push(rays);
  }
  costSummary(): CostSummary { return costSummary(this.costMs, this.costRays); }
  /** The records plus a closing cost summary, as JSONL. */
  jsonl() { return toJsonl([...this.records, { t: Math.round(this.now() * 10) / 10, kind: 'cost', ...this.costSummary() }]); }
}

/** Starts the trace on `canvas`: input listeners (capture, passive: they never change what the input does) and a small
 *  panel with the record count, the overrides readout and Download. Returns the trace and a stop function. */
export function startCameraTrace(canvas: HTMLElement): { trace: CameraTrace; stop(): void } {
  const trace = new CameraTrace(), doc = canvas.ownerDocument, off: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    target.addEventListener(type, fn as EventListener, { capture: true, passive: true }); off.push(() => target.removeEventListener(type, fn as EventListener, { capture: true }));
  };
  let dragging = false;
  on(canvas, 'wheel', (e) => trace.input('wheel', { dy: Math.round(e.deltaY), ...(e.ctrlKey ? { pinch: 1 } : {}) }));
  on(canvas, 'pointerdown', (e) => { dragging = true; trace.input('pointerdown', { button: e.button, type: e.pointerType }); });
  on(doc, 'pointermove', (e) => { if (dragging && (e as PointerEvent).buttons) trace.input('drag', { type: (e as PointerEvent).pointerType }); });
  on(doc, 'pointerup', () => { if (dragging) trace.input('pointerup'); dragging = false; });
  on(canvas, 'touchstart', (e) => trace.input('touchstart', { fingers: (e as TouchEvent).touches.length }));
  on(doc, 'keydown', (e) => { const k = (e as KeyboardEvent).code; if (/^(Key[WASDQEFRH]|Arrow|Home)/.test(k)) trace.input('key', { code: k }); });
  const panel = doc.createElement('div');
  panel.className = 'camera-trace';
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Camera trace');
  Object.assign(panel.style, { position: 'fixed', left: '8px', bottom: '8px', zIndex: '2147480002', maxWidth: 'min(420px,calc(100vw - 16px))', maxHeight: '40vh', overflow: 'auto',
    padding: '8px 10px', borderRadius: '10px', background: 'rgba(0,0,0,.72)', color: '#fff', font: '12px/1.4 ui-monospace,monospace' });
  const head = doc.createElement('div'), cost = doc.createElement('div'), list = doc.createElement('ol'), save = doc.createElement('button');
  save.type = 'button'; save.textContent = 'Download';
  Object.assign(save.style, { marginLeft: '6px', padding: '1px 8px', border: '0', borderRadius: '6px', background: '#fff', color: '#000', font: 'inherit', cursor: 'pointer' });
  Object.assign(list.style, { margin: '6px 0 0', paddingLeft: '18px' });
  save.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([trace.jsonl()], { type: 'application/x-ndjson' })), a = doc.createElement('a');
    a.href = url; a.download = `camera-trace-${Math.round(performance.timeOrigin)}.jsonl`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  cost.className = 'camera-trace-cost';
  panel.append(head, save, cost, list); doc.body.append(panel);
  const render = () => {
    const found = overrides(trace.records);
    head.textContent = `Camera trace · ${trace.records.length} records · ${found.length} override${found.length === 1 ? '' : 's'} of your input `;
    head.append(save);
    const c = trace.costSummary();
    cost.textContent = c.frames ? `follow cost · ${c.frames} frames · ms median ${c.ms.median} p95 ${c.ms.p95} max ${c.ms.max} · rays median ${c.rays.median} p95 ${c.rays.p95} max ${c.rays.max}` : 'follow cost · no frames yet';
    list.replaceChildren(...found.slice(-12).map((o) => { const li = doc.createElement('li'); li.textContent = `${(o.t / 1000).toFixed(1)} s: ${o.rule} ${o.sinceInputMs} ms after ${o.input}, ${o.offMetres} m / ${o.offDegrees}° off${Object.keys(o.params).length ? ' ' + JSON.stringify(o.params) : ''}`; return li; }));
  };
  const timer = setInterval(render, 1000); render();
  return { trace, stop() { clearInterval(timer); for (const f of off) f(); panel.remove(); } };
}
