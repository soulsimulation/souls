import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLauncher } from './launcher.mjs';
import { bindingId, cutoverFence, withV2Stream } from './cutover.mjs';
import { originCacheClass, originCacheProblem } from '../cdn/origin-cache.mjs';
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
  // cdn-walk (24 Nov): the routed page loads the replica by version, so both files are immutable; the plain addresses
  // the Soul client's upgrade reads, and any other version, are kept nowhere (no-store), and the cdn-walk rule passes
  const { v2Replica } = await pageConfig('/w/eden/');
  const version = createHash('sha256').update('test module').update('test wasm').digest('hex').slice(0, 16);
  assert.equal(v2Replica, `/w/eden/v2/replica/${version}/replica.js`, 'routed: the replica by its version');
  for (const [path, body, cc] of [[v2Replica, 'test module', 'public, max-age=31536000, immutable'], [v2Replica.replace('replica.js', 'replica_bg.wasm'), 'test wasm', 'public, max-age=31536000, immutable'],
    ['/w/eden/v2/replica/0000000000000000/replica_bg.wasm', 'test wasm', 'no-store'], [`${v2Replica}?x=1`, 'test module', 'no-store'], ['/w/eden/replica_bg.wasm', 'test wasm', 'no-store'], ['/w/eden/replica.js', 'test module', 'no-store']]) {
    const r = await fetch(base + path);
    assert.deepEqual([r.status, r.headers.get('cache-control'), await r.text()], [200, cc, body], path);
    if (cc !== 'no-store') assert.equal(originCacheProblem({ path, status: 200, headers: Object.fromEntries(r.headers) }), null, path);
  }
  assert.equal(originCacheClass(v2Replica.replace('replica.js', 'replica_bg.wasm')), 'stable', 'cdn-walk judges the versioned wasm');
  // #4177: the page's arrival published the old world's static views beside the stream; the page's reads get those files
  for (let i = 0; i < 50 && !existsSync(join(staticDir, 'manifest.json')); i++) await new Promise(r => setTimeout(r, 20));
  const manifest = JSON.parse(readFileSync(join(staticDir, 'manifest.json')));
  assert.equal(manifest.stream, '/s/eden/'); assert.deepEqual(Object.keys(manifest.files).sort(), ['config.json', 'snapshot.json'], 'what the old world answered (the fake has no scene, items, platforms or kernel)');
  const published = readFileSync(join(staticDir, 'snapshot.json'), 'utf8');
  for (const path of ['/w/eden/v1/world/snapshot', '/w/eden-2026/v1/world/snapshot']) {
    const r = await fetch(base + path); assert.equal(r.headers.get('x-souls-static'), 'published', path); assert.equal(await r.text(), published, path);
  }
  const wire = await fetch(base + '/w/eden/v1/world/snapshot?defs=ref&cols=1');   // 24 Nov: the page's first read
  assert.equal(wire.headers.get('x-souls-static'), 'published', 'the wire form gets the plain published snapshot (no x-defs-ref: plain to the page)'); assert.equal(await wire.text(), published);
  assert.equal((await fetch(base + '/w/eden/v1/world/snapshot?other=1')).headers.get('x-souls-static'), null, 'any other query passes through to the old world');
  assert.equal((await fetch(base + '/w/eden/v1/scene')).headers.get('x-souls-static'), null, 'a view not published: the old world answers');
  assert.equal(JSON.parse(readFileSync(join(staticDir, 'config.json'))).worldKey, 'eden', 'the old config published beside the stream');
  const before = readFileSync(hits, 'utf8');
  for (const path of ['/w/eden/v1/edge/act', '/w/eden-2026/v1/god/edit', '/worlds/w/eden-2026/v1/edge/act', '/worlds/__sim/worlds/eden-2026/unlisted']) {
    const r = await post(path); assert.equal(r.status, 409, path);
    const b = await r.json(); assert.equal(b.code, 'world.new-engine'); assert.match(b.message, /node eden\.mjs upgrade/);
  }
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(base + '/w/eden/v1/edge/view?gaze=1', { method })).status, 409);
  assert.equal(readFileSync(hits, 'utf8'), before, 'no refused act/edit/gaze reached the old world');
  // V4: Explore's place pictures (a POST that changes nothing) are the old world's to render
  assert.notEqual((await post('/w/eden/v1/world/context/views')).status, 409, 'place pictures are not refused');
  assert.match(readFileSync(hits, 'utf8').slice(before.length), /\/v1\/world\/context\/views/, 'and reach the old world');
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
test('24 Nov: a static folder the launcher cannot write holds the views in memory; the page reads them the same, and a rollback drops them', async t => {
  const dir = mkdtempSync(new URL('static-ro-', scratch)), routesFile = join(dir, 'routes.json'), staticDir = join(dir, 'static');
  mkdirSync(staticDir); chmodSync(staticDir, 0o555);
  t.after(() => { chmodSync(staticDir, 0o755); rmSync(dir, { recursive: true, force: true }); });
  // read-only as the unit's sandbox makes it (EROFS there; EACCES here). Root writes past a mode: then a file stands in its place
  let ro = staticDir;
  try { writeFileSync(join(staticDir, 'probe'), ''); rmSync(join(staticDir, 'probe')); writeFileSync(join(dir, 'file'), ''); ro = join(dir, 'file', 'static'); } catch { /* read-only, as wanted */ }
  const routed = (canonical) => writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical } } }));
  const fence = cutoverFence({ binding: { oldWorldId: 'eden-1', canonicalSlug: 'eden', routesFile, clientDir: join(dir, 'client'), staticDir: ro } }), w = { slug: 'eden', worldId: 'eden-1' };
  let reads = 0;
  const hash = 'c'.repeat(64);   // the scene's capture: a freshly loaded old world answers it 404 (W4 prep), so it must be served
  const old = (path) => { reads++; return { status: path === '/v1/scene' || path === '/v1/world/snapshot' ? 200 : 404, body: Buffer.from(JSON.stringify({ path, at: 'held', ...(path === '/v1/scene' ? { renderSceneRef: { hash } } : {}) })) }; };
  const ask = (path) => { let out = null; const res = { writeHead: (status, headers) => ({ end: (b) => { out = { status, headers, body: String(b) }; } }) };
    return fence.handle({ method: 'GET' }, res, w, new URL(`http://x/w/eden${path}`)) ? out : null; };
  routed(true);
  const m = await fence.publish(w, old);
  assert.deepEqual(Object.keys(m.files), ['scene.json', 'snapshot.json']);
  assert.match(m.unwritable, /^.+: E[A-Z]+$/, 'the flight that held them names the folder and why, for the launcher\'s one log line');
  const got = ask('/v1/world/snapshot');
  assert.equal(got.status, 200); assert.equal(got.headers['x-souls-static'], 'published'); assert.match(got.body, /"at":"held"/, 'the page reads the held snapshot');
  assert.equal(ask('/v1/edge/items'), null, 'a view the old world did not answer: it answers live, as before');
  const capture = ask(`/v1/scenes/${hash}?world=eden-1`);
  assert.equal(capture.status, 200, 'the page\'s scenery from the held scene'); assert.equal(JSON.parse(capture.body).worldId, 'eden-1');
  const n = reads, again = await fence.publish(w, old);
  assert.equal(reads, n, 'once per routing: a later page arrival reads nothing again'); assert.equal(again.unwritable, undefined, 'and logs nothing again');
  routed(false);
  assert.equal(fence.v2Stream(w), null);
  routed(true);
  assert.equal(ask('/v1/world/snapshot'), null, 'rolled back: the held views are gone; a re-route publishes afresh');
});
test('W4 prep: a routed page\'s scenery is answered from the published scene, which the page verifies; any other hash passes through', async t => {
  const { captureRenderScene } = await import('../../packages/engine-contract/src/scene-capture.ts');
  const { decodeSceneCapturePublication } = await import('../../packages/protocol/src/scene-capture.ts');
  const dir = mkdtempSync(new URL('w4-scene-', scratch)), routesFile = join(dir, 'routes.json'), staticDir = join(dir, 'static');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { lab: { gateway: 'http://127.0.0.1:7312', stream: '/s/lab/', canonical: true } } }));
  const fence = cutoverFence({ binding: { oldWorldId: 'lab-1', canonicalSlug: 'lab', routesFile, clientDir: join(dir, 'client'), staticDir } }), w = { slug: 'lab', worldId: 'lab-1' };
  // the old world's /v1/scene answer: its render scene and that scene's reference (apps/server/src/http.ts)
  const scene = { scene: { name: 'lab' }, buildings: [{ file: 'hall.glb', p: [1, 0, 2] }], clock: { origin: 0, dayTicks: 72000 } };
  const ref = captureRenderScene('rules/1', scene).ref;
  const old = (path) => ({ status: path === '/v1/scene' || path === '/v1/world/snapshot' ? 200 : 404, body: Buffer.from(JSON.stringify(path === '/v1/scene' ? { ...scene, renderSceneRef: ref } : {})) });
  await fence.publish(w, old);
  const ask = (path) => { let out = null; const res = { writeHead: (status, headers) => ({ end: (b) => { out = { status, headers, body: String(b) }; } }) };
    return fence.handle({ method: 'GET' }, res, w, new URL(`http://x/w/lab${path}`)) ? out : null; };
  const got = ask(`/v1/scenes/${ref.hash}?world=lab-1`);
  assert.equal(got.status, 200); assert.equal(got.headers['x-souls-static'], 'published');
  const decoded = decodeSceneCapturePublication(JSON.parse(got.body));
  assert.equal(decoded.worldId, 'lab-1'); assert.deepEqual(decoded.ref, ref, 'the page re-hashes the body and finds the scene it was named');
  assert.equal(ask(`/v1/scenes/${ref.hash}`).status, 200, 'without the world: as the old world answers');
  assert.equal(ask(`/v1/scenes/${'0'.repeat(64)}?world=lab-1`), null, 'another scene: the old world answers');
  assert.equal(ask(`/v1/scenes/${ref.hash}?world=other-1`), null, 'another world named: the old world answers');
});

test('W1: one binding file, two worlds: each switches and turns back alone, its page names its own stream and static folder', async t => {
  const dir = mkdtempSync(new URL('w1-two-worlds-', scratch)), data = join(dir, 'data'), file = join(dir, 'binding.json'), routes = join(dir, 'routes.json');
  const client = join(dir, 'client'), bodies = join(dir, 'bodies');
  for (const d of [data, client, bodies]) mkdirSync(d, { recursive: true });
  const described = (name, text) => { const bytes = Buffer.from(text); writeFileSync(join(client, name), bytes); return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const files = [described('replica.js', 'test module'), described('replica_bg.wasm', 'test wasm')];
  writeFileSync(join(client, 'soul-client.json'), JSON.stringify({ ...described('eden.mjs', 'client'), contract: 'souls-v2/1', version: '3.0.0', skill: described('skill.md', 'skill'), files }));
  writeFileSync(join(bodies, 'bodies.json'), '{"format":"souls/bodies/1","bodies":[]}');
  const worlds = ['eden', 'mars'].map(slug => ({ slug, name: slug, template: 'empty', createdAt: 1, owner: 'synthetic-owner' }));
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: [], worlds }));
  const staticOf = (slug) => join(dir, `origin/s/${slug}/static`);
  // Eden's binding file as installed today: one world, read unchanged
  const { v2Switch } = await import('./v2-switch.mjs');
  v2Switch({ binding: file, slug: 'eden', stream: '/s/eden/', routes, client, staticDir: staticOf('eden'), bodies });
  const edenOnly = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(edenOnly.canonicalSlug, 'eden', 'one world bound: the file stays one world\'s'); assert.equal(Object.hasOwn(edenOnly, 'worlds'), false);
  const P = await testPort(3), base = `http://127.0.0.1:${P}`, fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, eager: 0, base: '/', log: () => {}, cutoverBindingFile: file,
    command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1' } }) });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const page = async (slug) => JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(await (await fetch(`${base}/w/${slug}/`, { headers: { accept: 'text/html' } })).text())[1]);
  const act = (slug) => fetch(`${base}/w/${slug}/v1/edge/act`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sim_s_soul1_secret' }, body: '{}' });
  const published = async (slug) => { for (let i = 0; i < 100 && !existsSync(join(staticOf(slug), 'manifest.json')); i++) await new Promise(r => setTimeout(r, 20)); return JSON.parse(readFileSync(join(staticOf(slug), 'manifest.json'))); };
  const settle = () => new Promise(r => setTimeout(r, 1100)); // the launcher looks at the binding file once a second

  assert.equal((await page('eden')).v2Stream, '/s/eden/', 'Eden switched'); assert.equal((await published('eden')).stream, '/s/eden/');
  assert.equal(Object.hasOwn(await page('mars'), 'v2Stream'), false, 'Mars not bound: its page names no stream');
  assert.equal((await act('mars')).status, 200, 'Mars still acts on the old engine');
  assert.equal((await act('eden')).status, 409, 'Eden refuses old acts');

  // a second world is added: it shares the routes, client and bodies folders, never Eden's static folder
  assert.throws(() => v2Switch({ binding: file, slug: 'mars', stream: '/s/mars/', staticDir: staticOf('eden') }), /cutover.binding-invalid/, 'one static folder per world');
  v2Switch({ binding: file, slug: 'mars', stream: '/s/mars/', staticDir: staticOf('mars') });
  const both = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(both.schema, 'souls/cutover-binding/2'); assert.deepEqual(both.worlds.map(b => [b.canonicalSlug, b.oldWorldId, b.routesFile === routes]), [['eden', 'eden-1', true], ['mars', 'mars-1', true]]);
  await settle();
  const mars = await page('mars');
  assert.equal(mars.v2Stream, '/s/mars/', 'Mars names its own stream'); assert.equal(mars.v2Bodies, '/w/mars/v2/bodies/');
  const marsManifest = await published('mars');
  assert.equal(marsManifest.stream, '/s/mars/'); assert.equal(marsManifest.world, 'mars', 'Mars publishes into its own static folder');
  assert.equal((await page('eden')).v2Stream, '/s/eden/', 'Eden unchanged'); assert.equal((await published('eden')).world, 'eden');
  assert.equal((await act('mars')).status, 409);
  assert.equal((await (await fetch(`${base}/__sim/op/cutover`)).json()).worlds.map(w => [w.canonicalSlug, w.active]).join(), 'eden,true,mars,true');

  // --back for one world returns that one only
  assert.throws(() => v2Switch({ binding: file, back: true }), /v2-switch.slug-needed/, 'two bound: the slug is needed');
  v2Switch({ binding: file, back: true, slug: 'eden' });
  const edenBack = await page('eden');
  assert.equal(Object.hasOwn(edenBack, 'v2Stream'), false, 'Eden back on the old engine');
  assert.equal(existsSync(join(staticOf('eden'), 'manifest.json')), false, 'Eden\'s published views removed');
  assert.equal((await act('eden')).status, 200, 'Eden acts on the old engine again');
  assert.equal((await page('mars')).v2Stream, '/s/mars/', 'Mars still switched'); assert.equal(existsSync(join(staticOf('mars'), 'manifest.json')), true, 'Mars\'s views kept');
  assert.equal((await act('mars')).status, 409);
  const table = JSON.parse(readFileSync(routes, 'utf8')).worlds;
  assert.deepEqual([table.eden.canonical, table.mars.canonical], [false, true]);
});

test('D2: a world with only a new-engine route is served at /w/<slug>/ by the old page, with no old process, and listed', async t => {
  const dir = mkdtempSync(new URL('d2-route-only-', scratch)), data = join(dir, 'data'), file = join(dir, 'binding.json'), routes = join(dir, 'routes.json');
  const client = join(dir, 'client'), bodies = join(dir, 'bodies'), web = join(dir, 'web');
  for (const d of [data, client, bodies, web]) mkdirSync(d, { recursive: true });
  const described = (name, text) => { const bytes = Buffer.from(text); writeFileSync(join(client, name), bytes); return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const files = [described('replica.js', 'test module'), described('replica_bg.wasm', 'test wasm')];
  writeFileSync(join(client, 'soul-client.json'), JSON.stringify({ ...described('eden.mjs', 'client'), contract: 'souls-v2/1', version: '3.0.0', skill: described('skill.md', 'skill'), files }));
  writeFileSync(join(bodies, 'bodies.json'), '{"format":"souls/bodies/1","bodies":[]}');
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>Souls</title><link rel="canonical" href="https://example.test/"></head><body><div id="root"></div></body></html>');
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: [], worlds: [{ slug: 'eden', name: 'Eden', template: 'empty', createdAt: 1, owner: 'synthetic-owner' }] }));
  const { v2Switch } = await import('./v2-switch.mjs');
  v2Switch({ binding: file, slug: 'eden', stream: '/s/eden/', routes, client, staticDir: join(dir, 'static-eden'), bodies });
  // four more routes, none bound and none in the registry: two routed to the new engine, one only previewed, one archived
  const table = JSON.parse(readFileSync(routes, 'utf8'));
  const route = (stream, more = {}) => ({ gateway: 'http://127.0.0.1:1', stream, history: stream.replace('/s/', '/s/h-'), ...more });
  table.worlds.fresh = route('/s/fresh/', { canonical: true }); table.worlds.quiet = route('/s/quiet/', { canonical: true });
  table.worlds.draft = route('/s/draft/', { canonical: false }); table.worlds.gone = route('/s/gone/', { canonical: true, archived: true });
  writeFileSync(routes, JSON.stringify(table));
  // the directory's world list names them; quiet is unlisted
  const { createServer } = await import('node:http');
  const directory = createServer((req, res) => res.writeHead(req.url === '/v1/worlds' ? 200 : 404, { 'content-type': 'application/json' })
    .end(JSON.stringify({ worlds: [{ name: 'fresh', label: 'Fresh Fields', template: 'empty', creator: 'abc:1', made: 1700000000 }, { name: 'quiet', label: 'Quiet', unlisted: true }] })));
  const D = await testPort(1); await new Promise(r => directory.listen(D, '127.0.0.1', r));
  const P = await testPort(3), base = `http://127.0.0.1:${P}`, fake = new URL('./fake-world.mjs', import.meta.url).pathname, started = [];
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, eager: 0, base: '/', log: () => {}, cutoverBindingFile: file, webDir: web, v2DirectoryUrl: `http://127.0.0.1:${D}`,
    command: (w, port) => { started.push(w.slug); return { cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } }; } });
  t.after(async () => { await launcher.close(); directory.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = (path, headers = {}) => fetch(`${base}${path}`, { headers: { accept: 'text/html', ...headers } });
  const config = (html) => JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(html)[1]);

  const list = await (await get('/__sim/worlds.json', { accept: 'application/json' })).json();
  const fresh = list.worlds.find(w => w.slug === 'fresh');
  assert.equal(fresh?.name, 'Fresh Fields', 'listed under its directory label'); assert.equal(fresh.engine, 'new'); assert.equal(fresh.url, '/w/fresh/?dev=1');
  assert.deepEqual(list.worlds.map(w => w.slug).sort(), ['eden', 'fresh'], 'the unlisted, previewed and archived routes are not listed');

  const page = await get('/w/fresh/');
  assert.equal(page.status, 200); assert.equal(page.headers.get('x-souls-engine'), 'new');
  const html = await page.text(), c = config(html);
  assert.match(html, /<title>Fresh Fields · Souls<\/title>/); assert.match(html, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/w\/fresh\/">/);
  assert.deepEqual([c.worldKey, c.worldPath, c.worldId, c.worldName, c.worldEngine, c.authProvider, c.devAuth], ['fresh', '/w/fresh', 'v2:fresh', 'Fresh Fields', true, 'dev', true]);
  assert.deepEqual([c.v2Stream, c.v2History, c.v2Bodies, c.v2Gateway, c.v2Directory], ['/s/fresh/', '/s/h-fresh/', '/w/fresh/v2/bodies/', '/w/fresh/v2/ws', '/']);
  assert.equal((await get('/w/fresh/eden.mjs')).status, 200, 'its client is the binding\'s');
  assert.equal(await (await get('/w/fresh/v2/bodies/bodies.json')).text(), '{"format":"souls/bodies/1","bodies":[]}', 'its bodies are the binding\'s');
  const act = await fetch(`${base}/w/fresh/v1/edge/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(act.status, 409); assert.equal((await act.json()).code, 'world.new-engine');
  const scene = await get('/w/fresh/v1/scene', { accept: 'application/json' });
  assert.equal(scene.status, 404); assert.equal((await scene.json()).code, 'world.new-engine', 'an old view is not here: the page draws from the stream');
  assert.equal((await get('/w/quiet/')).headers.get('x-robots-tag')?.includes('noindex'), true, 'an unlisted world is served, not indexed');
  for (const slug of ['draft', 'gone', 'nowhere']) assert.equal((await get(`/w/${slug}/`)).status, 404, `${slug}: not routed to the new engine`);
  assert.deepEqual(started, [], 'no old world process was started');

  // the route turned back off: the world leaves the page and the list at once
  table.worlds.fresh.canonical = false; writeFileSync(routes, JSON.stringify(table));
  assert.equal((await get('/w/fresh/')).status, 404);
  assert.equal((await (await get('/__sim/worlds.json', { accept: 'application/json' })).json()).worlds.some(w => w.slug === 'fresh'), false);
});

test('a routed world whose old process is unloaded gets its page and views with its static folder empty, and never loads the old process', async t => {
  // live, 24 Nov: with --unload-still the bare web page went out (no inline config); the page then read /v1/config, which
  // a routed world answers with the new client's fields only, and said "There is no world at this address". #4561 then
  // loaded the old world for its page (about 3 s); the page now is the launcher's own, and its views never wake it
  const dir = mkdtempSync(new URL('unloaded-routed-', scratch)), data = join(dir, 'data'), clientDir = join(dir, 'served'), routesFile = join(dir, 'routes.json'), webDir = join(dir, 'web');
  mkdirSync(data); mkdirSync(clientDir); mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><head><title>Souls</title><link rel="canonical" href="https://x/"></head><body></body></html>');
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  const described = (name, text) => { const bytes = Buffer.from(text); writeFileSync(join(clientDir, name), bytes); return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const client = described('eden.mjs', 'served fixture bytes'), skill = described('skill.md', 'test skill');
  const files = [described('replica.js', 'test module'), described('replica_bg.wasm', 'test wasm')];
  writeFileSync(join(clientDir, 'soul-client.json'), JSON.stringify({ ...client, contract: 'souls-v2/1', version: '3.0.0', skill, files }));
  const worlds = [{ slug: 'eden', worldId: 'eden-original-1' }, { slug: 'other' }].map(w => ({ ...w, name: w.slug, template: 'empty', createdAt: 1, owner: 'synthetic-owner' }));
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: ['/worlds'], worlds }));
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical: true } } }));
  const P = await testPort(3), base = `http://127.0.0.1:${P}`;
  const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, webDir, eager: 0, base: '/', log: () => {}, unloadStill: true, keepAlive: false, prewarm: false, stillEveryMs: 1e9, stillAlarmMs: 1e9,
    cutoverBinding: { oldWorldId: 'eden-original-1', canonicalSlug: 'eden', routesFile, clientDir, staticDir: join(dir, 'origin/s/eden/static') },
    command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } }) });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const page = (slug) => fetch(`${base}/w/${slug}/`, { headers: { accept: 'text/html' } });
  assert.equal((await fetch(`${base}/w/eden/assets/app.js`)).status, 200, 'the build\'s files still come from here');
  assert.equal(launcher.pool.status('eden').status, 'stopped', 'and load nothing');
  const eden = await page('eden');
  assert.equal(eden.status, 200); assert.notEqual(eden.headers.get('x-sim-cache'), 'unloaded', 'not the bare web page');
  assert.equal(eden.headers.get('x-souls-engine'), 'new', 'the launcher\'s page of a moved world');
  const config = JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(await eden.text())?.[1] ?? 'null');
  assert.deepEqual([config?.worldKey, config?.worldId, config?.worldPath, config?.v2Stream, config?.v2Gateway], ['eden', 'eden-original-1', '/w/eden', '/s/eden/', '/w/eden/v2/ws']);
  // its static folder empty (a fresh move, or views lost with a restart): no view wakes the old world; the page draws the
  // world from its stream (W2)
  const view = (path) => fetch(`${base}/w/eden${path}`);
  for (const path of ['/v1/scene', '/v1/world/snapshot?defs=ref&cols=1', '/v1/world/snapshot', '/v1/kernel', '/v1/edge/items', '/v1/edge/platforms']) {
    const r = await view(path);
    assert.equal(r.status, 404, path); assert.equal((await r.json()).code, 'world.new-engine', path);
  }
  assert.equal(launcher.pool.status('eden').status, 'stopped', 'the page and its views loaded nothing');
  // views published before (as a page of the running old world publishes them; kept on disk across restarts): served,
  // the snapshot's wire form too, still loading nothing
  const staticDir = join(dir, 'origin/s/eden/static'); mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, 'snapshot.json'), '{"contract":"world/1","entities":[]}');
  writeFileSync(join(staticDir, 'manifest.json'), JSON.stringify({ schema: 'souls/old-static/1', world: 'eden', oldWorldId: 'eden-original-1', stream: '/s/eden/', files: { 'snapshot.json': {} } }));
  const snap = await view('/v1/world/snapshot?defs=ref&cols=1&v=k1');
  assert.equal(snap.status, 200); assert.equal(snap.headers.get('x-souls-static'), 'published'); assert.equal(snap.headers.get('x-defs-ref'), null, 'the plain snapshot');
  assert.equal(await snap.text(), '{"contract":"world/1","entities":[]}');
  assert.equal(launcher.pool.status('eden').status, 'stopped', 'still nothing loaded');
  // a world not routed keeps the unloaded page (#2304 A3)
  const other = await page('other');
  assert.equal(other.headers.get('x-sim-cache'), 'unloaded'); assert.equal(launcher.pool.status('other').status, 'stopped');
});
