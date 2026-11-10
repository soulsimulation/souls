import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CameraTrace, overrides, toJsonl, type TraceRecord } from '../src/camera-trace.ts';

const follow = (t: number, rule: string, eye: [number, number, number], desired: [number, number, number] = [0, 2, 8], extra: Record<string, unknown> = {}): TraceRecord =>
  ({ t, kind: 'frame', mode: 'follow', target: [0, 1, 0], eye, desired, rule: { name: rule, ...extra } });

test('T3: an automatic move soon after the viewer\'s input that leaves their view is an override, named by its rule', () => {
  const records: TraceRecord[] = [
    follow(0, 'glide', [0, 3, 8]),
    { t: 100, kind: 'input', input: 'wheel', detail: { dy: 200 } },
    follow(116, 'user', [0, 3, 8]),
    follow(600, 'collision', [0, 1.5, 1.2], [0, 2, 8], { reach: 1.4 }),
    follow(616, 'collision', [0, 1.5, 1.1], [0, 2, 8], { reach: 1.3 }),   // the same run: one row
    follow(900, 'held', [0, 3, 8]),
    follow(3000, 'search', [4, 3, 6]),                                     // after the grace period: not an override
  ];
  const found = overrides(records);
  assert.equal(found.length, 1);
  assert.deepEqual({ rule: found[0].rule, input: found[0].input, since: found[0].sinceInputMs, params: found[0].params }, { rule: 'collision', input: 'wheel', since: 500, params: { reach: 1.4 } });
  assert.ok(found[0].offMetres > 6);
});

test('T3: the viewer\'s own view, a decoupled hold and other modes are never overrides', () => {
  const records: TraceRecord[] = [
    { t: 0, kind: 'input', input: 'drag' },
    follow(50, 'user', [0, 3, 8.1]), follow(60, 'held', [0, 3, 9]),
    follow(70, 'glide', [0, 3.05, 8.02]),                                  // within 0.25 m and 3°: the viewer's view
    { t: 80, kind: 'frame', mode: 'manual', target: [0, 0, 0], eye: [30, 30, 30], desired: null, rule: null },
  ];
  assert.deepEqual(overrides(records), []);
});

test('T1, T2: frames are kept only when something changed; JSONL has one record per line with performance.now() times', () => {
  let now = 1000;
  const trace = new CameraTrace(() => now);
  const f = { mode: 'follow', target: [0, 1, 0] as const, eye: [0, 3, 8] as const, desired: [0, 2, 8] as const, rule: { name: 'glide' } };
  trace.frame(f); now += 16; trace.frame(f); now += 16; trace.frame({ ...f, eye: [0, 3, 7.9] });
  trace.input('wheel', { dy: 100 });
  assert.equal(trace.records.length, 3);
  const lines = toJsonl(trace.records).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.t, l.kind]), [[1000, 'frame'], [1032, 'frame'], [1032, 'input']]);
  assert.deepEqual(lines[0].rule, { name: 'glide' });
});

test('T4: off by default: the trace is its own chunk, loaded only with ?camtrace, and sends nothing', () => {
  const live = readFileSync(new URL('../src/LiveWorld.tsx', import.meta.url), 'utf8'), src = readFileSync(new URL('../src/camera-trace.ts', import.meta.url), 'utf8');
  assert.match(live, /has\('camtrace'\)\)void import\('\.\/camera-trace\.ts'\)/);
  assert.doesNotMatch(live, /^import [^;]*camera-trace/m, 'never a static import');
  assert.doesNotMatch(src, /fetch\(|sendBeacon|XMLHttpRequest|WebSocket|localStorage/, 'it never leaves the page');
});
