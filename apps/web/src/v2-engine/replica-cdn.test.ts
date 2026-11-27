// #4986: the page loads the replica from the asset CDN only when its config names exactly that CDN's copy of the
// version the launcher serves; the worker falls back to the origin's copy.
//   node --test apps/web/src/v2-engine/replica-cdn.test.ts
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPLICA_CDN, REPLICA_GLOBAL, replicaAtCdn } from './replica-cdn.ts';

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

test('replicaUrl: what the head script left, as it is; else the origin\'s copy as before', async () => {
  const g = globalThis as Record<string, unknown>, suite = Object.getOwnPropertyDescriptor(g, 'location');
  Object.defineProperty(g, 'location', { value: new URL('https://example.invalid/w/eden/'), configurable: true, writable: true });
  after(() => { if (suite) Object.defineProperty(g, 'location', suite); else delete g.location; delete g[REPLICA_GLOBAL]; });
  const { replicaUrl } = await import('./early-stream.ts');
  assert.equal(replicaUrl(ORIGIN), `https://example.invalid${ORIGIN}`);
  g[REPLICA_GLOBAL] = `${CDN}#${ORIGIN}`;
  assert.equal(replicaUrl(ORIGIN), `${CDN}#${ORIGIN}`, 'the stream hook and the early reader are given the same address');
  delete g[REPLICA_GLOBAL];
  assert.equal(replicaUrl(ORIGIN), `https://example.invalid${ORIGIN}`);
});

const worker = async (tag: string, replica: string) => {
  const listeners: ((e: unknown) => void)[] = [];
  (globalThis as unknown as { addEventListener: unknown }).addEventListener = (type: string, f: (e: unknown) => void) => { if (type === 'message') listeners.push(f); };
  const m = await fresh(tag), init = m.default();
  for (const f of listeners) f({ data: { replica }, stopImmediatePropagation: () => {} });
  return { m, init };
};
const scratch = () => { mkdirSync(new URL('../../../../.local/', import.meta.url), { recursive: true }); return mkdtempSync(join(new URL('../../../../.local/', import.meta.url).pathname, 'replica-cdn-')); };
const REPLICA = (from: string) => `export default async function init() {} export class StreamPlayer {} export const readPointer = () => ${JSON.stringify(from)};\n`;

test('the worker loads the CDN copy, without the origin path after the #', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'replica.js'), REPLICA('cdn'));
  const { m, init } = await worker('cdn', `${pathToFileURL(join(dir, 'replica.js')).href}#/w/eden/v2/replica/${V}/replica.js`);
  await init;
  assert.equal(m.readPointer(), 'cdn');
});

test('the worker loads the origin copy when the CDN copy does not load (its module, or its WASM)', async () => {
  const g = globalThis as Record<string, unknown>, suite = Object.getOwnPropertyDescriptor(g, 'location');
  const dir = scratch(), origin = join(dir, 'w/eden/v2/replica', V);
  mkdirSync(origin, { recursive: true });
  writeFileSync(join(origin, 'replica.js'), REPLICA('origin'));
  writeFileSync(join(dir, 'no-wasm.js'), 'export default async function init() { throw new Error("the WASM did not load"); }\n');
  // the worker's own origin: here a folder, so the origin path resolves to the file above
  Object.defineProperty(g, 'location', { value: { origin: pathToFileURL(dir).href }, configurable: true, writable: true });
  after(() => { if (suite) Object.defineProperty(g, 'location', suite); else delete g.location; });
  const path = `${new URL(pathToFileURL(dir).href).pathname}/w/eden/v2/replica/${V}/replica.js`;
  for (const [tag, cdn] of [['missing', 'missing.js'], ['nowasm', 'no-wasm.js']]) {
    const { m, init } = await worker(tag, `${pathToFileURL(join(dir, cdn)).href}#${path}`);
    await init;
    assert.equal(m.readPointer(), 'origin', tag);
  }
});

test('no origin copy after the #, or one that is not a replica path: a replica that does not load still fails', async () => {
  for (const [tag, address] of [['none', 'file:///nonexistent-replica-4986.js'], ['other', 'file:///nonexistent-replica-4986.js#//elsewhere.example/replica.js'], ['dots', 'file:///nonexistent-replica-4986.js#/w/../replica.js'], ['api', 'file:///nonexistent-replica-4986.js#/w/eden/v1/config']]) {
    const { init } = await worker(tag, address);
    await assert.rejects(init, Error, tag);
  }
});
