// B3-1: the switch command against a running launcher: one command routes a world's old page to the v2 stream (binding,
// static folder, body-assets folder served), `--back` turns it back; the launcher is never restarted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const scratch = new URL('../../.local/', import.meta.url);
mkdirSync(scratch, { recursive: true });
const command = new URL('./v2-switch.mjs', import.meta.url).pathname;
// asynchronous: the launcher under test answers the command's page read from this same process
const run = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [command, ...args])).stdout);

test('one command switches the old page to the v2 stream and --back switches it back, on a running launcher', async t => {
  const dir = mkdtempSync(new URL('b3-switch-', scratch)), data = join(dir, 'data'), binding = join(dir, 'binding.json');
  const client = join(dir, 'client'), bodies = join(dir, 'bodies'), staticDir = join(dir, 'static'), routes = join(dir, 'routes.json');
  for (const d of [data, client, join(bodies, 'models')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(client, 'replica.js'), 'test module'); writeFileSync(join(client, 'replica_bg.wasm'), 'test wasm');
  writeFileSync(join(bodies, 'bodies.json'), '{"format":"souls/bodies/1","bodies":[]}');
  const model = `models/${'a'.repeat(64)}.glb`; writeFileSync(join(bodies, model), 'glb bytes');
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: [], worlds: [{ slug: 'eden', name: 'eden', template: 'empty', createdAt: 1, owner: 'synthetic-owner' }] }));
  const P = await testPort(3), base = `http://127.0.0.1:${P}`, fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, eager: 0, base: '/', log: () => {}, cutoverBindingFile: binding,
    command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } }) });
  t.after(async () => { await launcher.close(); rmSync(dir, { recursive: true, force: true }); });
  const failed = async (...args) => { try { await run(...args); return null; } catch (e) { return JSON.parse(String(e.stderr)).code; } };

  assert.equal(await failed('--binding', binding, '--back'), 'v2-switch.no-binding', 'nothing to turn back');
  assert.equal(await failed('--binding', binding, '--slug', 'eden', '--stream', '/s/eden/', '--routes', routes, '--client', join(dir, 'nowhere'), '--static', staticDir), 'v2-switch.client-missing-replica');
  assert.equal(existsSync(binding), false, 'a refused switch writes nothing');

  const on = await run('--binding', binding, '--slug', 'eden', '--stream', '/s/eden/', '--routes', routes, '--client', client, '--static', staticDir, '--bodies', bodies, '--port', String(P));
  assert.deepEqual(on.page, { status: 200, v2Stream: '/s/eden/', v2Bodies: '/w/eden/v2/bodies/' }, 'the page names the stream and the body catalogue');
  assert.equal(on.engine, 'v2');
  assert.equal(JSON.parse(readFileSync(binding, 'utf8')).oldWorldId, 'eden-1', 'the registry id of a world without one (worldIdOf)');
  assert.equal(await (await fetch(`${base}/w/eden/replica.js`)).text(), 'test module', 'the page\'s replica, from the client folder');
  const catalogue = await fetch(`${base}/w/eden/v2/bodies/bodies.json`);
  assert.equal(catalogue.status, 200); assert.equal(catalogue.headers.get('content-type'), 'application/json');
  assert.equal(await (await fetch(`${base}/w/eden/v2/bodies/${model}`)).text(), 'glb bytes', 'a model from the body-assets folder');
  for (const path of ['../binding.json', 'models/..%2F..%2Fbinding.json', 'notes.txt']) assert.equal((await fetch(`${base}/w/eden/v2/bodies/${path}`)).status, 404, path);
  for (let i = 0; i < 100 && !existsSync(join(staticDir, 'manifest.json')); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await fetch(`${base}/w/eden/v1/world/snapshot`)).headers.get('x-souls-static'), 'published', 'the static scene from the static folder');

  const back = await run('--binding', binding, '--back', '--port', String(P));
  assert.deepEqual(back.page, { status: 200, v2Stream: null, v2Bodies: null }, 'back: the page names neither');
  assert.equal(back.engine, 'old');
  assert.equal(existsSync(join(staticDir, 'manifest.json')), false, 'back: the published views are removed');
  assert.equal((await fetch(`${base}/w/eden/v1/world/snapshot`)).headers.get('x-souls-static'), null, 'back: the old world answers');
  assert.notEqual((await fetch(`${base}/w/eden/v2/bodies/bodies.json`)).headers.get('content-type'), 'application/json', 'back: the body folder is not served');

  assert.equal((await run('--binding', binding, '--port', String(P))).page.v2Stream, '/s/eden/', 'the same command with the binding alone switches it on again');
});
