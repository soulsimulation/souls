// #4986: the page loads the replica from the asset CDN only when its config names exactly that CDN's copy of the
// version the launcher serves; the worker falls back to the origin's copy.
//   node --test apps/web/src/v2-engine/replica-cdn.test.ts
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPLICA_CDN, replicaAtCdn, replicaOrigin } from './replica-cdn.ts';

// a new instance of the worker's replica module per test (its address arrives once per instance)
const fresh = (tag: string) => import(`./replica-served.ts?${tag}`) as Promise<typeof import('./replica-served.ts')>;
const V = '3e17c6aab67e0b66', ORIGIN = `/w/eden/v2/replica/${V}/replica.js`, CDN = `${REPLICA_CDN}/assets/replica/${V}/replica.js`;

test('the CDN copy of the named version, and nothing else', () => {
  assert.equal(REPLICA_CDN, 'https://cdn.soul.game');
  assert.equal(replicaAtCdn({ v2Replica: ORIGIN, v2ReplicaCdn: CDN }, ''), CDN);
  assert.equal(replicaAtCdn({ v2Replica: ORIGIN, v2ReplicaCdn: CDN }, '?hour=12:00&replicacdn=1'), CDN);
  assert.equal(replicaAtCdn({ v2Replica: ORIGIN, v2ReplicaCdn: CDN }, '?replicacdn=0'), null);
  assert.equal(replicaAtCdn({ v2Replica: ORIGIN, v2ReplicaCdn: CDN }, '?hour=12:00&replicacdn=0'), null);
  for (const v2ReplicaCdn of [undefined, null, 3, [CDN], `${CDN}?x=1`, `${CDN}#x`, CDN.replace('https:', 'http:'), CDN.replace('cdn.soul.game', 'cdn.soul.game.evil.example'),
    CDN.replace('cdn.soul.game', 'evil.example'), CDN.replace(V, '0000000000000000'), CDN.replace('replica.js', 'other.js'), `${REPLICA_CDN}/w/eden/assets/${V}/replica.js`]) {
    assert.equal(replicaAtCdn({ v2Replica: ORIGIN, v2ReplicaCdn }, ''), null, String(v2ReplicaCdn));
  }
  assert.equal(replicaAtCdn({ v2ReplicaCdn: CDN }, ''), null, 'no origin copy named: nothing to match the version against');
  assert.equal(replicaAtCdn(undefined, ''), null);
});

test('replicaUrl: the CDN copy for the config it was loaded with, the origin copy kept for the worker', async () => {
  const g = globalThis as { location?: unknown }, suite = Object.getOwnPropertyDescriptor(g, 'location');
  Object.defineProperty(g, 'location', { value: new URL('https://example.invalid/w/eden/'), configurable: true, writable: true });
  after(() => { if (suite) Object.defineProperty(g, 'location', suite); else delete g.location; });
  const { replicaUrl } = await import('./early-stream.ts');
  const origin = `https://example.invalid${ORIGIN}`;
  assert.equal(replicaUrl(ORIGIN, { v2Replica: ORIGIN, v2ReplicaCdn: CDN }, ''), CDN);
  assert.equal(replicaOrigin(CDN), origin, 'the worker\'s fallback');
  assert.equal(replicaOrigin(origin), undefined);
  assert.equal(replicaUrl(ORIGIN, { v2Replica: ORIGIN, v2ReplicaCdn: CDN }, '?replicacdn=0'), origin);
  assert.equal(replicaUrl(ORIGIN, { v2Replica: ORIGIN }, ''), origin);
  assert.equal(replicaUrl(ORIGIN, undefined, ''), origin);
  assert.equal(replicaUrl(ORIGIN), origin, 'no config at load: as before');
  // asked for another replica than the config's (never by the page): the origin's, not a CDN copy of a different one
  assert.equal(replicaUrl('/w/eden/v2/replica/0000000000000000/replica.js', { v2Replica: ORIGIN, v2ReplicaCdn: CDN }, ''), 'https://example.invalid/w/eden/v2/replica/0000000000000000/replica.js');
});

test('the worker loads the origin copy when the CDN copy does not load', async () => {
  const listeners: ((e: unknown) => void)[] = [];
  (globalThis as unknown as { addEventListener: unknown }).addEventListener = (type: string, f: (e: unknown) => void) => { if (type === 'message') listeners.push(f); };
  const m = await fresh('fallback');
  mkdirSync(new URL('../../../../.local/', import.meta.url), { recursive: true });
  const dir = mkdtempSync(join(new URL('../../../../.local/', import.meta.url).pathname, 'replica-cdn-'));
  writeFileSync(join(dir, 'replica.js'), 'export default async function init() {} export class StreamPlayer {} export const readPointer = () => "origin";\n');
  const init = m.default();
  for (const f of listeners) f({ data: { replica: pathToFileURL(join(dir, 'missing.js')).href, replicaOrigin: pathToFileURL(join(dir, 'replica.js')).href }, stopImmediatePropagation: () => {} });
  await init;
  assert.equal(m.readPointer(), 'origin');
});

test('with no origin copy posted, a replica that does not load still fails', async () => {
  const listeners: ((e: unknown) => void)[] = [];
  (globalThis as unknown as { addEventListener: unknown }).addEventListener = (type: string, f: (e: unknown) => void) => { if (type === 'message') listeners.push(f); };
  const m = await fresh('none');
  const init = m.default();
  for (const f of listeners) f({ data: { replica: 'file:///nonexistent-replica-4986.js' }, stopImmediatePropagation: () => {} });
  await assert.rejects(init);
});
