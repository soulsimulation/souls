import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLauncher } from './launcher.mjs';
import { bindingId, cutoverFence } from './cutover.mjs';
import { updateWorldRoute } from '../../v2/tools/ops/proxy/route-config.mjs';
import { servedBy } from '../../v2/client/src/upgrade/served.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const scratch = new URL('../../.local/', import.meta.url);
mkdirSync(scratch, { recursive: true });

test('configured binding damage refuses startup; absent initial configuration is disabled', () => {
  assert.equal(cutoverFence({ file: '/etc/souls/cutover-binding.json' }), null);
  assert.throws(() => cutoverFence({ binding: {} }), /cutover.binding-invalid/);
  assert.throws(() => cutoverFence({ file: new URL('missing-o19c-binding', scratch).pathname }), /cutover.binding-unavailable/);
  const binding = { oldWorldId: '7:stable-world', canonicalSlug: 'eden', routesFile: '/synthetic/routes.json', clientDir: '/synthetic/client' };
  assert.doesNotThrow(() => cutoverFence({ binding }), 'stable identity is not constrained to a public slug');
  for (const patch of [{ oldWorldId: 'changed-world' }, { clientDir: '/synthetic/other-client' }]) assert.notEqual(bindingId({ ...binding, ...patch }), bindingId(binding), 'a different authoritative binding cannot pass launcher confirmation');
});

test('actual launcher fences stable identity and aliases, preserves reads/other worlds, and gives rollback guidance', async t => {
  const dir = mkdtempSync(new URL('o19c-launcher-', scratch)), data = join(dir, 'data'), clientDir = join(dir, 'served'), routesFile = join(dir, 'routes.json');
  mkdirSync(data); mkdirSync(clientDir);
  const described = (name, text) => { const bytes = Buffer.from(text); writeFileSync(join(clientDir, name), bytes); return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const client = described('eden.mjs', 'actual served fixture bytes'), skill = described('skill.md', 'test skill');
  const files = [described('replica.js', 'test module'), described('replica_bg.wasm', 'test wasm')];
  writeFileSync(join(clientDir, 'soul-client.json'), JSON.stringify({ ...client, contract: 'souls-v2/1', version: '3.0.0', skill, files }));
  const worlds = [{ slug: 'eden', worldId: 'eden-original-1', aliases: ['eden-2026'] }, { slug: 'other' }].map(w => ({ ...w, name: w.slug, template: 'empty', createdAt: 1, owner: 'synthetic-owner' }));
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: ['/worlds'], worlds }));
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical: false } } }));
  const P = await testPort(3), base = `http://127.0.0.1:${P}`, hits = join(dir, 'hits');
  const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, eager: 0, base: '/', log: () => {},
    cutoverBinding: { oldWorldId: 'eden-original-1', canonicalSlug: 'eden', routesFile, clientDir },
    command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1', FAKE_HITS: hits } }) });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = path => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sim_s_soul1_secret' }, body: '{}' });
  assert.equal((await post('/w/eden/v1/edge/act')).status, 200);
  assert.equal((await fetch(base + '/__sim/op/cutover', { headers: { 'x-forwarded-for': 'forwarded' } })).status, 403);
  const prepared = await (await fetch(base + '/__sim/op/cutover')).json();
  assert.equal(prepared.configured, true); assert.equal(prepared.active, false);
  assert.equal(Object.hasOwn(prepared, 'routesFile'), false);
  await updateWorldRoute(routesFile, 'eden', { canonical: true });
  const before = readFileSync(hits, 'utf8');
  for (const path of ['/w/eden/v1/edge/act', '/w/eden-2026/v1/god/edit', '/worlds/w/eden-2026/v1/edge/act', '/worlds/__sim/worlds/eden-2026/unlisted']) {
    const r = await post(path); assert.equal(r.status, 409, path);
    const b = await r.json(); assert.equal(b.code, 'world.new-engine'); assert.match(b.message, /node eden\.mjs upgrade/);
  }
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(base + '/w/eden/v1/edge/view?gaze=1', { method })).status, 409);
  assert.equal(readFileSync(hits, 'utf8'), before, 'no refused act/edit/gaze reached the old world');
  assert.equal(await (await fetch(base + '/worlds/w/eden-2026/eden.mjs')).text(), 'actual served fixture bytes');
  assert.equal((await (await fetch(base + '/w/eden/v1/config')).json()).soulClient.version, '3.0.0');
  assert.equal((await fetch(base + '/w/eden/v1/world/snapshot')).status, 200, 'read-only views remain live');
  assert.equal((await post('/w/other/v1/edge/act')).status, 200, 'unrelated world still acts');
  writeFileSync(routesFile, '{damaged');
  const damaged = await post('/w/eden/v1/edge/act'); assert.equal(damaged.status, 503); assert.equal((await damaged.json()).code, 'cutover.activation-unavailable');
  assert.equal((await post('/w/other/v1/edge/act')).status, 200, 'unrelated world never loads damaged Eden activation');
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical: false } } }));
  assert.equal((await post('/w/eden-2026/v1/edge/act')).status, 200, 'rollback restores actual old act path');
  const old = await fetch(base + '/w/eden-2026/v1/config');
  assert.equal(old.headers.get('x-souls-engine'), 'old');
  await assert.rejects(servedBy(base + '/w/eden-2026'), { code: 'world.previous-engine', message: /upgrade --rollback/ });
});

test('a mutation waiting for actual child boot is fenced again after activation changes', async t => {
  const dir = mkdtempSync(new URL('o19c-boot-', scratch)), data = join(dir, 'data'), routesFile = join(dir, 'routes.json');
  mkdirSync(data);
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ worlds: [{ slug: 'eden', template: 'empty', createdAt: 1 }] }));
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical: false } } }));
  const P = await testPort(2), hits = join(dir, 'hits');
  let started;
  const booting = new Promise(resolve => { started = resolve; });
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 1], dataDir: data, eager: 0, base: '/', log: () => {},
    cutoverBinding: { oldWorldId: 'eden-1', canonicalSlug: 'eden', routesFile, clientDir: dir },
    command: (w, port) => { started(); return { cmd: process.execPath, args: [new URL('./fake-world.mjs', import.meta.url).pathname],
      env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1', FAKE_BOOT_MS: '200', FAKE_HITS: hits } }; } });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const pending = fetch(`http://127.0.0.1:${P}/w/eden/v1/edge/act`, { method: 'POST', headers: { authorization: 'Bearer sim_s_soul1_secret' }, body: '{}' });
  await Promise.race([booting, pending.then(r => { throw Error(`request answered ${r.status} before child boot`); })]);
  await updateWorldRoute(routesFile, 'eden', { canonical: true });
  const r = await pending;
  assert.equal(r.status, 409); assert.equal((await r.json()).code, 'world.new-engine');
  assert.doesNotMatch(readFileSync(hits, 'utf8'), /\/v1\/edge\/act/, 'only startup health probes reached the old process');
});
