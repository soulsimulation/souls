// #1437: every runtime-policy key the host adopts is registered: an engine flag (#1365's registry) or a host-only flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marsFactory, RUNTIME_POLICY_FLAGS } from '@souls/engine-mars';
import { HOST_RUNTIME_POLICY_FLAGS } from './runtime-policy-host.ts';

const ENGINE = new Set<string>(RUNTIME_POLICY_FLAGS), HOST = new Set<string>(HOST_RUNTIME_POLICY_FLAGS);

test('#1437 every key the host adopts as runtime policy is an engine registry flag or a host-only flag', () => {
  const src = readFileSync(new URL('./world.ts', import.meta.url), 'utf8');
  const adopted = new Set([...src.matchAll(/runtimePolicy:\{[^}]*?\.\.\.this\.extra\.runtimePolicy as object,\s*([A-Za-z_]\w*)\s*:\s*true/g)].map((m) => m[1]));
  assert.ok(adopted.has('quarantineV1') && adopted.has('bodyStepGuardV1'), 'the scan sees the host adoptions');
  assert.deepEqual([...adopted].filter((k) => !ENGINE.has(k) && !HOST.has(k)), [], 'add the key to RUNTIME_POLICY_FLAGS (engine reads it) or HOST_RUNTIME_POLICY_FLAGS (host only)');
  assert.deepEqual([...HOST].filter((k) => ENGINE.has(k)), [], 'a flag is engine or host, not both');
  assert.deepEqual([...HOST].filter((k) => !adopted.has(k)), [], 'a host-only flag nothing adopts');
});

test('#1437 the engine never reads a host-only flag', async () => {
  const f = await marsFactory(), e = f.create(f.genesis('host-keys')), read = new Set<string>();
  const policy = new Proxy({}, { get: (_t, k) => { if (typeof k === 'string') read.add(k); return k === 'sleepBlockTicks' ? 1200 : true; }, has: (_t, k) => { if (typeof k === 'string') read.add(k); return true; } });
  e.configureRuntimePolicy!(policy as never);
  assert.deepEqual([...HOST].filter((k) => read.has(k)), []);
});
