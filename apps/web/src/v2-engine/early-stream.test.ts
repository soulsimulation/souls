// Time to Live: the stream reader the page's first phase starts is handed to the bridge with what it read meanwhile
// (early-stream.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// this file's own page address, whatever the suite's loader set (web-loader.mjs: http://fixture.invalid/w/eden/),
// put back when it is done; world-path.ts reads it once, at import, so it is set first
const g = globalThis as { location?: unknown }, suiteLocation = Object.getOwnPropertyDescriptor(g, 'location');
Object.defineProperty(g, 'location', { value: new URL('https://example.invalid/w/eden/'), configurable: true, writable: true });
after(() => { if (suiteLocation) Object.defineProperty(g, 'location', suiteLocation); else delete g.location; });
const { EarlyReader, claimEarlyReader, startEarlyReader, takeEarlyScene, v2Stream } = await import('./early-stream.ts');
/** Leaves no early reader, timer or scene request behind a test, whatever it asserted. */
async function settle() { claimEarlyReader('/s/none/', ''); await takeEarlyScene(); }

/** A stand-in for the reader's worker: what the page posted to it, and a way to post from it. */
class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  terminated = false;
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  say(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const STREAM = 'https://example.invalid/s/w/x-0/views/a/b/';

test('what the worker posted before the bridge started is delivered first, in order, then what it posts after', async () => {
  const worker = new FakeWorker(), reader = new EarlyReader(worker, STREAM, 'https://example.invalid/replica.js');
  assert.deepEqual(worker.posted, [{ stream: STREAM }], 'the stream is asked for at once');
  worker.say({ t: 'pointer', n: 1 }); worker.say({ t: 'snapshot', n: 2 });
  assert.equal(reader.pending, 2);
  // the bridge and its watchers: listeners first (watch), then onmessage, then the start
  const heard: unknown[] = [], got: unknown[] = [];
  reader.addEventListener('message', (e) => heard.push((e as MessageEvent).data));
  reader.onmessage = (e) => got.push(e.data);
  await tick();
  assert.deepEqual(got, [], 'nothing before the bridge starts it');
  reader.postMessage({ stream: STREAM });
  assert.deepEqual(worker.posted, [{ stream: STREAM }], 'the bridge\'s start is not sent to the worker again');
  worker.say({ t: 'part', n: 3 });   // during the replay: after the held ones
  await tick();
  worker.say({ t: 'part', n: 4 });   // after it: straight on
  const order = [{ t: 'pointer', n: 1 }, { t: 'snapshot', n: 2 }, { t: 'part', n: 3 }, { t: 'part', n: 4 }];
  assert.deepEqual(got, order);
  assert.deepEqual(heard, order, 'the watchers hear the same, in the same order');
  reader.postMessage({ other: 1 });
  assert.deepEqual(worker.posted.at(-1), { other: 1 }, 'any other message goes to the worker');
});

test('a worker error held before the start reaches the bridge\'s onerror; a throwing listener stops nothing', async () => {
  const worker = new FakeWorker(), reader = new EarlyReader(worker, STREAM, 'r');
  worker.dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }));
  worker.say({ t: 'part', n: 1 });
  const errors: string[] = [], got: unknown[] = [];
  reader.onerror = (e) => errors.push(e.message);
  let first = true;
  reader.onmessage = (e) => { got.push(e.data); if (first) { first = false; throw new Error('a listener failed'); } };
  const thrown: unknown[] = [], g = globalThis as { reportError?: unknown }, saved = g.reportError;
  g.reportError = (e: unknown) => thrown.push(e);
  try {
    worker.say({ t: 'part', n: 2 });
    reader.postMessage({ stream: STREAM });
    await tick(); await tick();
  } finally { g.reportError = saved; }
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(got, [{ t: 'part', n: 1 }, { t: 'part', n: 2 }], 'the next message is still delivered');
  assert.equal(thrown.length, 1, 'the failure is still reported');
});

test('terminate stops the worker and drops what was held', async () => {
  const worker = new FakeWorker(), reader = new EarlyReader(worker, STREAM, 'r');
  worker.say({ t: 'part', n: 1 });
  const got: unknown[] = []; reader.onmessage = (e) => got.push(e.data);
  reader.terminate();
  reader.postMessage({ stream: STREAM }); worker.say({ t: 'part', n: 2 });
  await tick();
  assert.equal(worker.terminated, true);
  assert.deepEqual(got, []);
});

test('only a page whose config names a v2 stream starts one; the bridge takes it once, for that stream and replica', async () => {
  const w = globalThis as { window?: unknown; Worker?: unknown; __simConfig?: unknown; fetch?: unknown };
  const saved = { window: w.window, Worker: w.Worker, fetch: w.fetch };
  const scenes: string[] = [];
  w.window = globalThis; w.Worker = FakeWorker;
  w.fetch = async (u: string) => { scenes.push(String(u)); return new Response(JSON.stringify({ renderSceneRef: { rulesVersion: 'v' } })); };
  try {
    w.__simConfig = {};
    assert.equal(startEarlyReader(() => new FakeWorker()), null, 'no stream named: nothing started');
    w.__simConfig = { v2Stream: '/s/w/x-0/views/a/b/', v2Replica: '/w/eden/v2/replica/1/replica.js' };
    assert.equal(v2Stream(), '/s/w/x-0/views/a/b/');
    const made: FakeWorker[] = [], replicas: string[] = [];
    const reader = startEarlyReader((replica) => { replicas.push(replica); const f = new FakeWorker(); made.push(f); return f; });
    assert.ok(reader);
    assert.deepEqual(replicas, ['https://example.invalid/w/eden/v2/replica/1/replica.js']);
    assert.deepEqual(made[0].posted, [{ stream: 'https://example.invalid/s/w/x-0/views/a/b/' }]);
    assert.deepEqual(scenes, ['/w/eden/v1/scene'], 'the scene leaves with it');
    assert.deepEqual(await takeEarlyScene(), { renderSceneRef: { rulesVersion: 'v' } });
    assert.equal(takeEarlyScene(), null, 'taken once');
    assert.equal(claimEarlyReader('/s/w/x-0/views/a/b/', 'https://example.invalid/w/eden/v2/replica/1/replica.js'), reader);
    assert.equal(claimEarlyReader('/s/w/x-0/views/a/b/', 'https://example.invalid/w/eden/v2/replica/1/replica.js'), null, 'claimed once');
    reader!.terminate();
  } finally { await settle(); Object.assign(w, saved); delete w.__simConfig; }
});

test('a reader for another stream is stopped, not handed over', async () => {
  const w = globalThis as { window?: unknown; Worker?: unknown; __simConfig?: unknown; fetch?: unknown };
  const saved = { window: w.window, Worker: w.Worker, fetch: w.fetch };
  w.window = globalThis; w.Worker = FakeWorker; w.fetch = undefined;
  try {
    w.__simConfig = { v2Stream: '/s/w/y-0/views/a/b/', v2Views: false };
    let made: FakeWorker | null = null;
    const reader = startEarlyReader(() => (made = new FakeWorker()));
    assert.ok(reader && made);
    assert.equal(takeEarlyScene(), null, 'no old views: no scene asked for');
    assert.equal(claimEarlyReader('/s/w/z-0/views/a/b/', reader!.replica), null);
    assert.equal((made as unknown as FakeWorker).terminated, true);
  } finally { await settle(); Object.assign(w, saved); delete w.__simConfig; }
});
