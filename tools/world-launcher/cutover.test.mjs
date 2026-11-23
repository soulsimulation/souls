import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLauncher } from './launcher.mjs';
import { bindingId, cutoverFence, withV2Stream } from './cutover.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const scratch = new URL('../../.local/', import.meta.url);
mkdirSync(scratch, { recursive: true });
// This test owns only its isolated fixture bytes; production activation writers remain in their own runtime.
const activate = (file) => {
  const data = JSON.parse(readFileSync(file));
  data.worlds.eden.canonical = true;
  writeFileSync(file, JSON.stringify(data));
};

test('configured binding damage refuses startup; an absent binding is disabled until one is written', () => {
  const none = cutoverFence({ file: '/etc/souls/cutover-binding.json' });
  assert.equal(none.v2Stream({ slug: 'eden' }), null); assert.equal(none.handle(), false); assert.equal(none.inspect(), undefined);
  assert.throws(() => cutoverFence({ binding: {} }), /cutover.binding-invalid/);
  const valid = { oldWorldId: 'w', canonicalSlug: 'eden', routesFile: '/synthetic/routes.json', clientDir: '/synthetic/client' };
  for (const bad of [{ staticDir: 'relative' }, { v2Bodies: '//elsewhere/' }, { v2Bodies: '/a/../b/' }, { v2Bodies: 'https://cdn.example/b/' },
    { v2Gateway: 'wss://elsewhere.example/ws' }, { v2Gateway: '//elsewhere/ws' }, { v2Directory: 'https://elsewhere.example' }]) assert.throws(() => cutoverFence({ binding: { ...valid, ...bad } }), /cutover.binding-invalid/, JSON.stringify(bad));
  // B3-1: the binding file is read again when it changes (once a second), so the switch command needs no restart
  const file = new URL(`b3-binding-${process.pid}.json`, scratch).pathname, logged = [];
  let clock = 0;
  rmSync(file, { force: true });
  const live = cutoverFence({ file, log: (s) => logged.push(s), now: () => clock });
  assert.equal(live.inspect(), undefined, 'no file yet: an ordinary launcher');
  writeFileSync(file, JSON.stringify({ oldWorldId: 'w', canonicalSlug: 'eden', routesFile: '/synthetic/routes.json', clientDir: '/synthetic/client' }));
  assert.equal(live.inspect(), undefined, 'not looked at again within the second');
  clock = 1000;
  assert.throws(() => live.inspect({ worlds: [] }), /cutover.binding-world-missing/, 'written: the binding is in force');
  writeFileSync(file, '{damaged'); clock = 2000;
  assert.throws(() => live.inspect({ worlds: [] }), /cutover.binding-world-missing/, 'damaged later: the last valid binding stays');
  assert.equal(logged.length, 1);
  assert.throws(() => cutoverFence({ file }), /cutover.binding-invalid/, 'damaged at startup: refused');
  rmSync(file); clock = 3000;
  assert.equal(live.inspect(), undefined, 'removed: an ordinary launcher again');
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
    cutoverBinding: { oldWorldId: 'eden-original-1', canonicalSlug: 'eden', routesFile, clientDir, staticDir: join(dir, 'origin/s/eden/static'), v2Bodies: '/v2/bodies/' },
    command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1', FAKE_HITS: hits } }) });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const staticDir = join(dir, 'origin/s/eden/static');
  const post = path => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sim_s_soul1_secret' }, body: '{}' });
  assert.equal((await post('/w/eden/v1/edge/act')).status, 200);
  assert.equal((await fetch(base + '/__sim/op/cutover', { headers: { 'x-forwarded-for': 'forwarded' } })).status, 403);
  const prepared = await (await fetch(base + '/__sim/op/cutover')).json();
  assert.equal(prepared.configured, true); assert.equal(prepared.active, false);
  assert.equal(Object.hasOwn(prepared, 'routesFile'), false);
  // #4177: the page names its v2 stream in its inline config when, and only when, the world is routed to v2
  const pageConfig = async (path) => {
    const html = await (await fetch(base + path, { headers: { accept: 'text/html' } })).text();
    return JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(html)[1]);
  };
  const notRouted = await pageConfig('/w/eden/');
  assert.equal(Object.hasOwn(notRouted, 'v2Stream') || Object.hasOwn(notRouted, 'v2Bodies'), false, 'not routed: no v2Stream, no v2Bodies');
  assert.equal((await fetch(base + '/w/eden/v1/world/snapshot')).headers.get('x-souls-static'), null, 'not routed: the old world answers');
  assert.equal(existsSync(staticDir), false, 'not routed: nothing published');
  activate(routesFile);
  for (let i = 0; i < 2; i++) {   // the world's answer, then the launcher's kept page
    const eden = await pageConfig('/w/eden/');
    assert.equal(eden.v2Stream, '/s/eden/', 'routed: the route\'s stream'); assert.equal(eden.worldKey, 'eden', 'the rest of the config kept');
    assert.equal(eden.v2Bodies, '/v2/bodies/', 'routed: the body catalogue\'s directory');
    assert.deepEqual([eden.v2Gateway, eden.v2Directory], ['/w/eden/v2/ws', '/'], 'routed (B3-2b): where the owner\'s box finds the gateway and the directory');
    assert.equal(Object.hasOwn(await pageConfig('/w/other/'), 'v2Stream'), false, 'another world is never given it');
  }
  // #4177: the page's arrival published the old world's static views beside the stream; the page's reads get those files
  for (let i = 0; i < 50 && !existsSync(join(staticDir, 'manifest.json')); i++) await new Promise(r => setTimeout(r, 20));
  const manifest = JSON.parse(readFileSync(join(staticDir, 'manifest.json')));
  assert.equal(manifest.stream, '/s/eden/'); assert.deepEqual(Object.keys(manifest.files).sort(), ['config.json', 'snapshot.json'], 'what the old world answered (the fake has no scene, items, platforms or kernel)');
  const published = readFileSync(join(staticDir, 'snapshot.json'), 'utf8');
  for (const path of ['/w/eden/v1/world/snapshot', '/w/eden-2026/v1/world/snapshot']) {
    const r = await fetch(base + path); assert.equal(r.headers.get('x-souls-static'), 'published', path); assert.equal(await r.text(), published, path);
  }
  assert.equal((await fetch(base + '/w/eden/v1/world/snapshot?defs=ref&cols=1')).headers.get('x-souls-static'), null, 'a wire form (other body and headers) passes through to the old world');
  assert.equal((await fetch(base + '/w/eden/v1/scene')).headers.get('x-souls-static'), null, 'a view not published: the old world answers');
  assert.equal(JSON.parse(readFileSync(join(staticDir, 'config.json'))).worldKey, 'eden', 'the old config published beside the stream');
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
  for (const value of [null, { schema: 'wrong', worlds: {} }, { schema: 'souls/world-routes/1', worlds: [] },
    { schema: 'souls/world-routes/1', worlds: {} }, { schema: 'souls/world-routes/1', worlds: { eden: [] } },
    { schema: 'souls/world-routes/1', worlds: { eden: { canonical: 'true' } } }]) {
    writeFileSync(routesFile, JSON.stringify(value));
    const r = await post('/w/eden/v1/edge/act'); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'cutover.activation-unavailable');
  }
  assert.equal((await post('/w/other/v1/edge/act')).status, 200, 'unrelated world never loads damaged Eden activation');
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical: false } } }));
  assert.equal((await post('/w/eden-2026/v1/edge/act')).status, 200, 'rollback restores actual old act path');
  const rolledBack = await pageConfig('/w/eden/');
  assert.equal(Object.hasOwn(rolledBack, 'v2Stream') || Object.hasOwn(rolledBack, 'v2Bodies'), false, 'rollback: the kept page no longer names the stream or the bodies');
  assert.equal((await fetch(base + '/w/eden/v1/world/snapshot')).headers.get('x-souls-static'), null, 'rollback: the old world answers its snapshot again');
  assert.deepEqual(readdirSync(staticDir), [], 'rollback: the published files are removed');
  const old = await fetch(base + '/w/eden-2026/v1/config');
  assert.equal(old.headers.get('x-souls-engine'), 'old');
  assert.equal((await old.json()).worldId, 'eden-1', 'rollback returns the actual old world config with its engine header');
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: {}, unrelated: 'not this reader\'s route' } }));
  assert.equal((await post('/w/eden/v1/edge/act')).status, 200, 'omitted canonical defaults false; old guard does not route or validate unrelated placements');
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
  activate(routesFile);
  const r = await pending;
  assert.equal(r.status, 409); assert.equal((await r.json()).code, 'world.new-engine');
  assert.doesNotMatch(readFileSync(hits, 'utf8'), /\/v1\/edge\/act/, 'only startup health probes reached the old process');
});

test('#4177: withV2Stream writes the stream into the inline config and leaves a page without one alone', () => {
  const page = '<html><head><script>window.__simConfig={"worldKey":"eden","n":"\\u003c/script>"}</script><title>x</title></head></html>';
  const out = withV2Stream(page, '/s/eden/');
  const config = JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(out)[1]);
  assert.deepEqual(config, { worldKey: 'eden', n: '</script>', v2Stream: '/s/eden/' });
  assert.ok(out.endsWith('<title>x</title></head></html>'));
  for (const other of ['<html><head></head></html>', '<script>window.__simConfig=[1]</script>', '<script>window.__simConfig={bad}</script>']) assert.equal(withV2Stream(other, '/s/eden/'), other);
});

test('#4177: a rollback removes the published views, and a re-route whose snapshot read fails serves none of them', async t => {
  const dir = mkdtempSync(new URL('o4177-static-', scratch)), routesFile = join(dir, 'routes.json'), staticDir = join(dir, 'static');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const routed = (canonical) => writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical } } }));
  const fence = cutoverFence({ binding: { oldWorldId: 'eden-1', canonicalSlug: 'eden', routesFile, clientDir: join(dir, 'client'), staticDir } }), w = { slug: 'eden', worldId: 'eden-1' };
  const old = (path) => ({ status: path === '/v1/scene' || path === '/v1/world/snapshot' ? 200 : 404, body: Buffer.from(JSON.stringify({ path, at: 'first routing' })) });
  const served = () => { let body = null; const res = { writeHead: () => ({ end: (b) => { body = String(b); } }) };
    return fence.handle({ method: 'GET' }, res, w, new URL('http://x/w/eden/v1/world/snapshot')) ? body : null; };
  routed(true);
  assert.deepEqual(Object.keys((await fence.publish(w, old)).files), ['scene.json', 'snapshot.json']);
  assert.match(served(), /first routing/);
  routed(false);
  assert.equal(fence.v2Stream(w), null);
  assert.deepEqual(readdirSync(staticDir), [], 'rolled back: nothing left');
  routed(true);
  await assert.rejects(fence.publish(w, (path) => (path === '/v1/world/snapshot' ? { status: 503, body: Buffer.from('{}') } : old(path))), /cutover.static-snapshot-unavailable/);
  assert.deepEqual(readdirSync(staticDir), [], 'a failed publish leaves nothing to serve');
  assert.equal(served(), null, 'the snapshot falls through to the live old view');
});
