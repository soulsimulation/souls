// #4177: the worker's replica is the one the front door serves: its address arrives as the worker's first message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('the served replica is loaded from the posted address, and that message never reaches the reader', async () => {
  const listeners: ((e: unknown) => void)[] = [];
  (globalThis as unknown as { addEventListener: unknown }).addEventListener = (type: string, f: (e: unknown) => void) => { if (type === 'message') listeners.push(f); };
  const m = await import('./replica-served.ts');
  mkdirSync(new URL('../../../../.local/', import.meta.url), { recursive: true });
  const dir = mkdtempSync(join(new URL('../../../../.local/', import.meta.url).pathname, 'replica-served-'));
  writeFileSync(join(dir, 'replica.js'), 'export let started = false; export default async function init() { started = true; } export class StreamPlayer {} export const readPointer = () => "{}";\n');
  const init = m.default();
  let stopped = 0;
  for (const f of listeners) f({ data: { stream: 'https://x/s/eden/' }, stopImmediatePropagation: () => { stopped++; } });
  assert.equal(stopped, 0, 'the stream message is the reader\'s');
  for (const f of listeners) f({ data: { replica: pathToFileURL(join(dir, 'replica.js')).href }, stopImmediatePropagation: () => { stopped++; } });
  await init;
  assert.equal(stopped, 1, 'the replica message stops there');
  assert.equal(typeof m.StreamPlayer, 'function'); assert.equal(m.readPointer(), '{}');
});
