// V9 (#2719): the link to a moment and the history clock's way back to live.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { cameraAt, placeCamera, readCamera } from '../camera/link.ts';
import { BEHIND_US, caughtUp } from '../clock/clock.ts';
import { FAR_US, FAST, HistoryClock } from './clock.ts';
import { readMoment, writeMoment, historyBase } from './link.ts';
import { HistoryPage, historyLive, historyLocation } from './page.ts';
import { worldAddress } from '../source/address.ts';

test('A4: the link carries world, lineage, world time in µs and a camera in its fragment, and nothing else', () => {
  const m = { world: 'cd5c-0', lineage: 'cd5c', at: 90_000_000, camera: { node: 'cd5c.0', eye: [-6_505_317, 30_000_000, 136_763_564] as [number, number, number], target: [33_494_683, 0, 96_763_564] as [number, number, number] } };
  const frag = writeMoment(m);
  assert.ok(frag.startsWith('#'));
  assert.deepEqual([...new URLSearchParams(frag.slice(1)).keys()], ['w', 'l', 't', 'c']);
  assert.deepEqual(readMoment(frag), m);
  assert.equal(readMoment('#w=a&t=5'), null, 'no lineage: not a moment (a fork is another lineage)');
});

test('a camera framed on a moving node keeps its place in that frame', () => {
  const boat = new THREE.Matrix4().compose(new THREE.Vector3(10, 0, -4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7), new THREE.Vector3(1, 1, 1));
  const c = cameraAt('boat.7', boat, new THREE.Vector3(12, 5, 3), new THREE.Vector3(10, 1, -4));
  assert.deepEqual(readCamera(`${c.node}~${c.eye.join(',')}~${c.target.join(',')}`), c);
  const p = placeCamera(c, boat);
  assert.ok(p.eye.distanceTo(new THREE.Vector3(12, 5, 3)) < 1e-5 && p.target.distanceTo(new THREE.Vector3(10, 1, -4)) < 1e-5);
});

test('history plays at its speed, never past what is loaded, and holds when paused', () => {
  const c = new HistoryClock(1_000_000);
  assert.equal(c.step(500, 10_000_000).t, 1_500_000);
  c.speed = 4;
  assert.equal(c.step(1000, 10_000_000).t, 5_500_000);
  assert.equal(c.step(5000, 10_000_000).t, 10_000_000);
  assert.equal(c.state, 'holding: loading');
  c.paused = true;
  assert.equal(c.step(1000, 99_000_000).t, 10_000_000);
});

test('A3: back to live from near plays fast with no jump and hands over at the live point', () => {
  const live = 600_000_000, c = new HistoryClock(live - BEHIND_US - 60_000_000);
  c.returning = true;
  let last = c.t, frames = 0, r = { t: c.t, live: false };
  while (!r.live && frames < 10_000) {
    r = c.step(1000 / 60, last + 10_000_000, live + frames * 16_667, live + frames * 16_667);
    // Each frame moves at most FAST times real time: no jump.
    assert.ok(r.t - last <= (1000 / 60) * 1000 * FAST + 1);
    last = r.t;
    frames++;
  }
  assert.ok(r.live && !c.cut);
  assert.ok(Math.abs(r.t - (live + (frames - 1) * 16_667 - BEHIND_US)) <= 1000);
});

test('A3: back to live from far is one visible cut, once the live stream reaches the live point', () => {
  const live = 3_600_000_000, c = new HistoryClock(60_000_000);
  c.returning = true;
  assert.deepEqual(c.step(16, 70_000_000, live, null), { t: 60_000_000, live: false });
  assert.equal(c.state, 'waiting for live');
  const r = c.step(16, 70_000_000, live, live);
  assert.deepEqual(r, { t: live - BEHIND_US, live: true });
  assert.ok(c.cut && live - BEHIND_US - 60_000_000 > FAR_US);
});


const lineage = 'ab'.repeat(16), zone = `${'cd'.repeat(16)}-0`;
const moment = { world: `${lineage}-${zone}`, lineage, at: 90_000_000, camera: null };
const path = `${lineage}/${zone}/7/${zone}/1/everyone/`;
const locator = { format: 'souls/history-live/1', world: moment.world, lineage, stream: `../views/${path}` };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('V9b: canonical and preview cold moments use the exact trusted public history and stream', async () => {
  for (const prefix of ['/w/garden/', '/preview/w/garden/']) {
    const href = `https://world.example${prefix}${writeMoment(moment)}`;
    const bootstrap = { world: 'garden', stream: `/s/w/${moment.world}/views/${path}`, history: `/s/w/${moment.world}/history/`, directory: '/', gateway: `${prefix}v2/ws`, creatorToken: `${prefix}v2/creator-token` };
    const installed = await worldAddress(href, (async (url, options) => {
      assert.equal(url, `https://world.example${prefix}v1/bootstrap`);
      assert.equal(options?.redirect, 'error');
      return response(bootstrap);
    }) as typeof fetch);
    assert.ok(installed?.history);
    const base = new URL(installed.history);
    assert.equal(await historyLive(moment, base, installed, (async (url, options) => {
      assert.equal(url, `${installed.history}live`);
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.cache, 'no-store');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      return response(locator);
    }) as typeof fetch), installed.stream);
    assert.deepEqual(readMoment(new URL(href).hash), moment, 'camera, time and internal identity survive the cold link');
  }
});

test('V9b: standalone legacy cold seeks retain their byte paths; absent live metadata refuses', async () => {
  const base = new URL(historyBase(moment), 'https://world.example/');
  assert.equal(base.pathname, `/s/h/${moment.world}/${lineage}/`);
  await assert.rejects(historyLive(moment, base, undefined, (async url => {
    assert.equal(url, `${base.href}live`);
    return new Response('', { status: 404 });
  }) as typeof fetch), /history-live-missing/);
  const link = writeMoment(moment);
  assert.deepEqual(readMoment(link), moment);
});

test('V9b: missing, malformed, foreign, private and unmapped navigation never guesses a live stream', async () => {
  const base = new URL(`https://world.example/s/w/${moment.world}/history/`);
  const installed = { history: base.href, stream: new URL(locator.stream, base).href };
  for (const value of [null, {}, { ...locator, stream: locator.stream.replace('/7/', '/07/') }, { ...locator, stream: locator.stream.replaceAll('-0/', '-00/') }, { ...locator, world: 'another-instance' }, { ...locator, world: 'garden' }, { ...locator, lineage: 'ef'.repeat(16) },
    { ...locator, stream: locator.stream.replace('/1/everyone/', `/1/${zone}/`) }, { ...locator, stream: locator.stream.replace('/1/everyone/', '/0/everyone/') },
    { ...locator, stream: locator.stream.replace(zone, `${'ef'.repeat(16)}-0`) }, { ...locator, stream: 'https://foreign.example/stream/' },
    { ...locator, stream: `${locator.stream}?token=hidden` }, { ...locator, stream: locator.stream.replace('../views/', '../views/%2e%2e/') }]) {
    await assert.rejects(historyLive(moment, base, installed, (async () => response(value)) as typeof fetch), /history-live-invalid/);
  }
  await assert.rejects(historyLive(moment, base, { stream: installed.stream }), /history-live-unmapped/);
  await assert.rejects(historyLive(moment, base, { ...installed, stream: installed.stream.replace('/7/', '/8/') }, (async () => response(locator)) as typeof fetch), /history-live-foreign/);
  await assert.rejects(worldAddress(`https://world.example/w/garden/${writeMoment(moment)}`, (async () => new Response('', { status: 410 })) as typeof fetch), /410/);
});

test('V9b: the ordinary Back to live callback starts once after validation and preserves failure visibility', async () => {
  const base = new URL(`https://world.example/s/w/${moment.world}/history/`), addresses: string[] = [];
  const page = Object.assign(Object.create(HistoryPage.prototype), { moment, base, clock: new HistoryClock(moment.at), hooks: { live: (address: string) => addresses.push(address) }, opened: { hash: null }, error: '' });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    await page.backToLive();
    assert.deepEqual(addresses, []);
    assert.equal(page.clock.returning, false);
    assert.match(page.status(), /history-live-missing/);
    globalThis.fetch = (async () => response(locator)) as typeof fetch;
    await page.backToLive();
    assert.deepEqual(addresses, [new URL(locator.stream, base).href]);
    assert.equal(page.clock.returning, true);
    assert.doesNotMatch(page.status(), /history-live-missing/);
  } finally { globalThis.fetch = original; }
});


test('V9b: the real constructor validates installed cold identity before creating a worker or seeking', () => {
  const names = ['location', 'Worker', 'document', 'addEventListener'] as const;
  const original = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const messages: unknown[] = []; let workers = 0;
  const element = () => ({ style: {}, append: (..._children: unknown[]) => {}, remove: () => {} });
  const hooks = { apply: () => {}, frame: () => null, root: () => null, live: () => {} };
  try {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class { constructor() { workers++; } postMessage(message: unknown) { messages.push(message); } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: element, body: element() } });
    Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: () => {} });
    for (const prefix of ['/w/garden/', '/preview/w/garden/']) {
      const href = `https://world.example${prefix}`, installed = { history: `https://world.example/s/w/${moment.world}/history/`, stream: `https://world.example/s/w/${moment.world}/views/${path}` };
      Object.defineProperty(globalThis, 'location', { configurable: true, value: { href } });
      const before = workers, sent = messages.length;
      assert.throws(() => new HistoryPage({ ...moment, world: 'foreign' }, {} as ConstructorParameters<typeof HistoryPage>[1], hooks, installed), /history-live-foreign/);
      assert.throws(() => new HistoryPage({ ...moment, lineage: 'ef'.repeat(16) }, {} as ConstructorParameters<typeof HistoryPage>[1], hooks, installed), /history-live-foreign/);
      assert.throws(() => new HistoryPage(moment, {} as ConstructorParameters<typeof HistoryPage>[1], hooks, { stream: installed.stream }), /history-live-unmapped/);
      assert.equal(workers, before); assert.equal(messages.length, sent, 'no foreign history seek');
      const page = new HistoryPage(moment, {} as ConstructorParameters<typeof HistoryPage>[1], hooks, installed);
      assert.equal(page.base.href, installed.history);
      assert.equal(workers, before + 1);
      assert.deepEqual(messages.slice(sent), [{ base: installed.history, seq: 1, at: moment.at, hash: true }, { base: installed.history, counts: 0 }]);
      assert.equal(historyLocation(moment, href).href, new URL(historyBase(moment), href).href);
    }
  } finally {
    names.forEach((name, i) => original[i] ? Object.defineProperty(globalThis, name, original[i]!) : Reflect.deleteProperty(globalThis, name));
  }
});


test('V9b: a still public stream holds at its last part until its genuine quiet frontier allows return', () => {
  const now = 3_600_000_000, lastPart = 60_000_000, quietUntil = now;
  const clock = new HistoryClock(0); clock.returning = true;
  assert.deepEqual(clock.step(16, lastPart, now, caughtUp(lastPart, null)), { t: 0, live: false });
  assert.equal(clock.state, 'waiting for live');
  assert.equal(clock.cut, false);
  assert.deepEqual(clock.step(16, lastPart, now, caughtUp(lastPart, quietUntil)), { t: now - BEHIND_US, live: true });
  assert.equal(clock.state, 'live'); assert.equal(clock.cut, true);
});
