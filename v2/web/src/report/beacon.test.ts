// Visitors' page errors (Engine v2 O25, #3336): today's test of apps/web/src/client-errors.ts carried over. The beacon
// reports each kind once (repeats as a count), caps a flood, sends no personal text; `stream` replaces the socket kinds.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

type Beacon = { b: string; w?: string; e: { k: string; m: string; s: string; n: number }[] };
const beacons: Beacon[] = [];
const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
class FakeErrorEvent extends Event { message: string; filename: string; error: unknown; constructor(m: string, f = '', error?: unknown) { super('error'); this.message = m; this.filename = f; this.error = error; } }
class FakeRejection extends Event { reason: unknown; constructor(reason: unknown) { super('unhandledrejection'); this.reason = reason; } }
const g = globalThis as unknown as Record<string, unknown>;
Object.assign(g, { window: g, ErrorEvent: FakeErrorEvent, document: doc, __BUILD__: 'v2-test12345678', location: { pathname: '/w/eden-2026/', search: '' },
  addEventListener: win.addEventListener.bind(win) });
Object.defineProperty(g, 'navigator', { configurable: true, value: { sendBeacon: (url: string, data: string) => { assert.equal(url, '/__sim/client-errors'); beacons.push(JSON.parse(data)); return true; } } });

test('one report per kind with its count, a cap per page, no personal text, the stream, WebGL and arrival', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { watchStream, report, expectArrival } = await import('./beacon.ts');
  expectArrival();
  // 10k throws of one error from one page: one event, its count
  for (let i = 0; i < 10_000; i++) win.dispatchEvent(new FakeErrorEvent('Error: injected test throw', 'https://soul.example/assets/main-Ab12_xYz.js?v=1'));
  mock.timers.tick(3000);
  assert.equal(beacons.length, 1);
  assert.deepEqual(beacons[0], { b: 'v2-test12345678', w: 'eden-2026', e: [{ k: 'js', m: 'Error: injected test throw', s: 'main', n: 10_000 }] });
  // personal text never leaves the page
  win.dispatchEvent(new FakeRejection(new Error('said "meet me at the well" to gene@example.com with user_2pQ7xYzAbCdEfGhIjKlMnOp at /v1/x?token=abc')));
  win.dispatchEvent(new FakeRejection({ message: 'Kwyjibo is asleep' }));
  // WebGL: a live canvas losing its context counts, a canvas being torn down does not
  const canvas = Object.assign(new EventTarget(), { isConnected: true }), gone = Object.assign(new EventTarget(), { isConnected: false });
  const lost = (t: EventTarget) => { win.dispatchEvent(Object.defineProperty(new Event('webglcontextlost'), 'target', { value: t })); };
  lost(canvas); lost(gone);
  // the stream: two failures and a part played are no report; three failures in a row are one, however long it goes on
  const seen: string[] = [];
  const on = watchStream({ pointer() {}, part: (p: number) => void seen.push(`part ${p}`), error: (m: string) => void seen.push(m) });
  on.error('HTTP 503'); on.error('HTTP 503'); on.part(7); on.error('HTTP 503'); on.error('HTTP 503'); on.error('HTTP 503'); on.error('HTTP 503');
  assert.equal(seen.length, 7, 'the page still gets every event');
  // a failed asset reports its path without the query string
  report('asset', '404', 'https://soul.example/models/worlds/models/missing.glb?x=1');
  mock.timers.tick(3000);
  const e = beacons[1]!.e;
  const rej = e.filter((x) => x.k === 'rej');
  assert.equal(rej.length, 2);
  assert.ok(!JSON.stringify(rej).match(/meet me|gene@example|user_2pQ7|token=|Kwyjibo/), JSON.stringify(rej));
  assert.equal(rej[1]!.m, 'object', 'a rejection that is no Error sends only its type');
  assert.deepEqual(e.filter((x) => x.k === 'gl').map((x) => x.n), [1]);
  assert.deepEqual(e.filter((x) => x.k === 'stream'), [{ k: 'stream', m: 'failed 3 times in a row: HTTP 503', s: '', n: 1 }]);
  assert.deepEqual(e.find((x) => x.k === 'asset'), { k: 'asset', m: '404', s: 'https://soul.example/models/worlds/models/missing.glb', n: 1 });
  // an arrival that never finished: reported once after 60 s with the last arrival mark it reached
  performance.mark('sim:stream-pointer');
  mock.timers.tick(54_000); mock.timers.tick(3000);   // 60 s after expectArrival (two 3 s flushes so far), then its flush
  assert.deepEqual(beacons.at(-1)!.e, [{ k: 'arrival', m: 'not done in 60 s', s: 'stream-pointer', n: 1 }]);
  // the cap: at most 12 kinds per page however many distinct errors it throws
  for (let i = 0; i < 50; i++) report('js', `distinct ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i >= 26 ? 'z' : ''}`);
  mock.timers.tick(3000);
  const kinds = beacons.flatMap((x) => x.e).length;
  assert.equal(kinds, 12);
  // hidden: the repeats of an already-sent kind go out as one more count
  win.dispatchEvent(new FakeErrorEvent('Error: injected test throw', 'main-Ab12_xYz.js'));
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(beacons.at(-1)!.e, [{ k: 'js', m: 'Error: injected test throw', s: 'main', n: 1 }]);
  mock.timers.reset();
});
