// B3-1: the switch command against a running launcher: one command routes a world's old page to the v2 stream (binding,
// static folder, body-assets folder served), `--back` turns it back; the launcher is never restarted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { notUnitData, staticWritable, unitWritable, v2Switch } from './v2-switch.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const scratch = new URL('../../.local/', import.meta.url);
mkdirSync(scratch, { recursive: true });
const command = new URL('./v2-switch.mjs', import.meta.url).pathname;
// asynchronous: the launcher under test answers the command's page read from this same process
const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [command, ...args])).stdout);

test('one command switches the old page to the v2 stream and --back switches it back, on a running launcher', async t => {
  const dir = mkdtempSync(new URL('b3-switch-', scratch)), data = join(dir, 'data'), binding = join(dir, 'binding.json');
  const client = join(dir, 'client'), bodies = join(dir, 'bodies'), staticDir = join(dir, 'static'), routes = join(dir, 'routes.json');
  const webDir = join(dir, 'web');
  for (const d of [data, client, join(bodies, 'models'), webDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><head><title>Souls</title></head><body></body></html>');
  writeFileSync(join(client, 'replica.js'), 'test module'); writeFileSync(join(client, 'replica_bg.wasm'), 'test wasm');
  writeFileSync(join(bodies, 'bodies.json'), '{"format":"souls/bodies/1","bodies":[]}');
  const model = `models/${'a'.repeat(64)}.glb`; writeFileSync(join(bodies, model), 'glb bytes');
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: [], worlds: [{ slug: 'eden', name: 'eden', template: 'empty', createdAt: 1, owner: 'synthetic-owner' }] }));
  const P = await testPort(3), base = `http://127.0.0.1:${P}`, fake = new URL('./fake-world.mjs', import.meta.url).pathname, started = [];
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, webDir, eager: 0, base: '/', log: () => {}, cutoverBindingFile: binding,
    command: (w, port) => { started.push(w.slug); return { cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } }; } });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const failed = async (...args) => { try { await run(...args); return null; } catch (e) { return JSON.parse(String(e.stderr)).code; } };

  assert.equal(await failed('--binding', binding, '--back'), 'v2-switch.no-binding', 'nothing to turn back');
  assert.equal(await failed('--binding', binding, '--slug', 'eden', '--stream', '/s/eden/', '--routes', routes, '--client', join(dir, 'nowhere'), '--static', staticDir), 'v2-switch.client-missing-replica');
  assert.equal(existsSync(binding), false, 'a refused switch writes nothing');

  const on = await run('--binding', binding, '--slug', 'eden', '--stream', '/s/eden/', '--routes', routes, '--client', client, '--static', staticDir, '--bodies', bodies, '--port', String(P));
  assert.deepEqual(on.page, { status: 200, v2Stream: '/s/eden/', v2Bodies: '/w/eden/v2/bodies/', v2Gateway: '/w/eden/v2/ws', v2Directory: '/' },
    'the page names the stream, the body catalogue, and (B3-2b) the gateway and the directory the owner\'s box reaches, as the front door routes them');
  assert.equal(on.engine, 'v2');
  assert.equal(JSON.parse(readFileSync(binding, 'utf8')).oldWorldId, 'eden-1', 'the registry id of a world without one (worldIdOf)');
  assert.equal(await (await fetch(`${base}/w/eden/replica.js`)).text(), 'test module', 'the page\'s replica, from the client folder');
  const catalogue = await fetch(`${base}/w/eden/v2/bodies/bodies.json`);
  assert.equal(catalogue.status, 200); assert.equal(catalogue.headers.get('content-type'), 'application/json');
  assert.equal(await (await fetch(`${base}/w/eden/v2/bodies/${model}`)).text(), 'glb bytes', 'a model from the body-assets folder');
  for (const path of ['../binding.json', 'models/..%2F..%2Fbinding.json', 'notes.txt']) assert.equal((await fetch(`${base}/w/eden/v2/bodies/${path}`)).status, 404, path);
  // D2b: switched, the world's old process is never started; a view none published is the stream's (404 world.new-engine)
  const snapshot = await fetch(`${base}/w/eden/v1/world/snapshot`);
  assert.equal(snapshot.status, 404); assert.equal((await snapshot.json()).code, 'world.new-engine');
  assert.deepEqual(started, [], 'no old world process was started while switched');

  const back = await run('--binding', binding, '--back', '--port', String(P));
  assert.deepEqual(back.page, { status: 200, v2Stream: null, v2Bodies: null, v2Gateway: null, v2Directory: null }, 'back: the page names none of them');
  assert.equal(back.engine, 'old');
  assert.equal(existsSync(join(staticDir, 'manifest.json')), false, 'back: the published views are removed');
  assert.equal((await fetch(`${base}/w/eden/v1/world/snapshot`)).headers.get('x-souls-static'), null, 'back: the old world answers');
  assert.notEqual((await fetch(`${base}/w/eden/v2/bodies/bodies.json`)).headers.get('content-type'), 'application/json', 'back: the body folder is not served');

  assert.equal((await run('--binding', binding, '--port', String(P))).page.v2Stream, '/s/eden/', 'the same command with the binding alone switches it on again');
});

test('24 Nov: a static folder the launcher unit cannot write is refused before anything is written', () => {
  assert.deepEqual(unitWritable('production'), ['/srv/sim-worlds-data/production'], 'from deploy/sim-worlds@.service ReadWritePaths');
  assert.throws(() => staticWritable('/var/lib/souls/eden-static'), /v2-switch.static-not-writable/, 'EROFS under ProtectSystem=strict');
  assert.throws(() => staticWritable('/srv/sim-worlds-data/staging/eden-static'), /v2-switch.static-not-writable/, 'another stage\'s data');
  staticWritable('/srv/sim-worlds-data/production/eden-static');
  staticWritable('/srv/sim-worlds-data/staging/eden-static', 'staging');
  const dir = mkdtempSync(new URL('static-unit-', scratch)), binding = join(dir, 'binding.json'), client = join(dir, 'client');
  try {
    mkdirSync(client); writeFileSync(join(client, 'replica.js'), 'm'); writeFileSync(join(client, 'replica_bg.wasm'), 'w');
    assert.throws(() => v2Switch({ binding, slug: 'eden', stream: '/s/eden/', routes: join(dir, 'routes.json'), client, staticDir: '/var/lib/souls/eden-static' }), /v2-switch.static-not-writable/);
    assert.equal(existsSync(binding), false, 'nothing written'); assert.equal(existsSync(join(dir, 'routes.json')), false);
    staticWritable(join(dir, 'static'));   // a checkout's or laptop's folder is not the unit's to judge
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('27 Nov: a harness\'s own launcher (unit: false, --no-unit) publishes from a per-run folder under /srv, never into a stage\'s data', () => {
  const runner = '/srv/runner/_work/_temp/timed-1-1/world/static';
  assert.throws(() => staticWritable(runner), /v2-switch.static-not-writable/, 'the unit could not write it');
  notUnitData(runner);
  assert.throws(() => notUnitData('/srv/sim-worlds-data/production/eden-static'), /v2-switch.static-in-unit-data/, 'production data');
  assert.throws(() => notUnitData('/srv/sim-worlds-data/staging/eden-static'), /v2-switch.static-in-unit-data/, 'any stage\'s data');
  const dir = mkdtempSync(new URL('static-nounit-', scratch)), binding = join(dir, 'binding.json'), client = join(dir, 'client');
  try {
    mkdirSync(client); writeFileSync(join(client, 'replica.js'), 'm'); writeFileSync(join(client, 'replica_bg.wasm'), 'w');
    const given = { binding, slug: 'eden', stream: '/s/eden/', routes: join(dir, 'routes.json'), client, unit: false };
    assert.throws(() => v2Switch({ ...given, staticDir: '/srv/sim-worlds-data/production/eden-static' }), /v2-switch.static-in-unit-data/);
    assert.equal(existsSync(binding), false, 'nothing written');
    v2Switch({ ...given, staticDir: join(dir, 'static') });
    assert.equal(existsSync(join(dir, 'static')), true, 'its own folder is made');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
