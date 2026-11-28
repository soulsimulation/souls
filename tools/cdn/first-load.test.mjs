// #4986: the new-viewer gauge sorts each request of a cold page load by who paid for it.
//   node --test tools/cdn/first-load.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathClass, servedBy, summarize } from './first-load.mjs';

test('path classes of a world page load', () => {
  for (const [path, cls] of [['/w/eden/', 'page'], ['/', 'page'], ['/assets/main-ohHrQCwe.js', 'bundles'], ['/assets/main-DeE5v0m5.css', 'bundles'],
    ['/w/eden/v2/replica/3e17c6aab67e0b66/replica_bg.wasm', 'replica'], ['/w/eden/v2/replica/3e17c6aab67e0b66/replica.js', 'replica'], ['/w/eden/v2/bodies/bodies.json', 'bodies'],
    ['/w/eden/v1/world/snapshot', 'api'], ['/w/eden/v1/config', 'api'], ['/__sim/worlds.json', 'api'], ['/s/w/a-0/views/b/pointer', 'stream'],
    ['/assets/kind-looks-BgoB7tkf.json', 'data'], ['/assets/icon-mark-BEMKzawi.png', 'models-and-images'], ['/assets/br/91/910b.glb', 'models-and-images'],
    ['/worlds/w/eden/v1/scene', 'api'], ['/worlds/assets/main-ohHrQCwe.js', 'bundles'], ['/changelog', 'other']]) assert.equal(pathClass(path), cls, path);
});

test('who paid: the host, an edge filling its cache from the host, an edge alone, or a third party', () => {
  const our = { originHosts: ['soul.game'], ourHosts: ['soul.game'] };
  assert.equal(servedBy({ host: 'soul.game', cf: null, ...our }), 'host', 'a DNS-only record: every answer is the host\'s');
  assert.equal(servedBy({ host: 'soul.game', cf: 'HIT', ...our }), 'edge');
  assert.equal(servedBy({ host: 'soul.game', cf: 'DYNAMIC', ...our }), 'host');
  assert.equal(servedBy({ host: 'stream.soul.game', cf: 'HIT', ...our }), 'edge');
  assert.equal(servedBy({ host: 'stream.soul.game', cf: 'EXPIRED', ...our }), 'edgeFill');
  assert.equal(servedBy({ host: 'stream.soul.game', cf: 'DYNAMIC', ...our }), 'host');
  assert.equal(servedBy({ host: 'cdn.soul.game', cf: 'MISS', ...our }), 'edgeFill');
  assert.equal(servedBy({ host: 'cdn.soul.game', cf: null, ...our }), 'edge', 'the bucket\'s own domain: never the host');
  assert.equal(servedBy({ host: 'clerk.example.com', cf: 'HIT', ...our }), 'third');
  assert.equal(servedBy({ host: 'notsoul.game', cf: null, ...our }), 'third');
});

test('summary: bytes and requests by host, and by path class on the origin', () => {
  const row = (host, cls, bytes, by) => ({ host, class: cls, bytes, servedBy: by });
  const s = summarize([row('soul.game', 'page', 7, 'host'), row('soul.game', 'bundles', 100, 'host'), row('soul.game', 'bundles', 50, 'host'), row('cdn.soul.game', 'replica', 500, 'edge'),
    row('stream.soul.game', 'stream', 3, 'edgeFill'), row('clerk.example.com', 'other', 9, 'third')], { originHosts: ['soul.game'] });
  assert.deepEqual(s.totals, { host: { requests: 3, bytes: 157 }, edge: { requests: 1, bytes: 500 }, edgeFill: { requests: 1, bytes: 3 }, third: { requests: 1, bytes: 9 } });
  assert.deepEqual(Object.keys(s.byClass), ['page', 'bundles'], 'classes are the origin host\'s only');
  assert.deepEqual([s.byClass.bundles.requests, s.byClass.bundles.hostBytes], [2, 150]);
  assert.deepEqual([s.byHost['cdn.soul.game'].edge, s.byHost['cdn.soul.game'].edgeBytes, s.byHost['cdn.soul.game'].host], [1, 500, 0]);
});
