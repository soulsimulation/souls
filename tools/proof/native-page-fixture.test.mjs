import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createNativePageArtifacts, verifyNativePageArtifacts, nativePagePorts, nativePageRecipe } from './native-page-fixture.mjs';
import { stopOwnedChild } from './owned-attempt.mjs';
import { runOwnedCommand, addresses, WORLD } from '../playtest/arena/new-engine/world.mjs';
const parent = resolve('.local/native-page-fixture-tests'); mkdirSync(parent, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(parent, 'artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content = 'fixture') => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  for (const file of ['worlds/templates/hello-hamlet.json', 'apps/web/src/LiveWorld.tsx', 'tools/world-launcher/launcher.mjs', 'v2/tools/dev/run.sh']) write(file);
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture']);
  // Synthetic source repository; ordinary configured commit hooks remain enabled.
  for (const path of ['apps/web/dist', 'v2/web/dist', 'mars/viewer/dist/client', 'v2/target/wasm-load/pkg']) write(path + '/fixture');
  for (const name of ['worldd', 'gatewayd', 'directoryd', 'testworld', 'assets-check', 'register-world']) write('v2/target/release/' + name);
  write('.gitignore', '.local/\n**/dist/\nv2/target/\n'); execFileSync('git', ['-C', root, 'add', '.gitignore']); execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'ignore outputs']);
  write('.local/caddy');
  const manifest = createNativePageArtifacts(root, { caddy: join(root, '.local/caddy') });
  write('.local/pin.json', JSON.stringify(manifest));
  return { root, write, manifest, pin: { file: '.local/pin.json', hash: hash(readFileSync(join(root, '.local/pin.json'))) } };
}
test('pinned product, template, browser-independent asset trees and executable bytes are checked', t => {
  const f = fixture(t); assert.equal(verifyNativePageArtifacts(f.root, f.pin).sourceHead, f.manifest.sourceHead);
  f.write('apps/web/dist/fixture', 'changed'); assert.throws(() => verifyNativePageArtifacts(f.root, f.pin), /artifact-files/);
});
test('artifact receipts reject wrong pin, dirty product sources and path escapes', t => {
  const f = fixture(t); assert.throws(() => verifyNativePageArtifacts(f.root, { ...f.pin, hash: '0'.repeat(64) }), /artifact-pin/);
  assert.throws(() => verifyNativePageArtifacts(f.root, { ...f.pin, file: '../pin.json' }), /artifact-path/);
  f.write('apps/web/src/LiveWorld.tsx', 'changed'); assert.throws(() => verifyNativePageArtifacts(f.root, f.pin), /source-pin/);
});
test('finite startup command is registered before failure and timeout escalates an owned group', async () => {
  const seen = [], events = [];
  await assert.rejects(runOwnedCommand(process.execPath, ['-e', 'process.exit(3)'], { onSpawn: (child, mode) => { seen.push(child); assert.equal(mode.transient, true); assert.equal(mode.processGroup, true); }, onCommand: e => events.push(e), timeoutMs: 2000 }), /-exit/);
  assert.equal(seen.length, 1); assert.notEqual(seen[0].exitCode, null); assert.equal(events[0].phase, 'start'); assert.equal(events.at(-1).ok, false);
  let owned;
  await assert.rejects(runOwnedCommand(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { onSpawn: c => { owned = c; }, timeoutMs: 150 }), /-timeout/);
  assert.equal(owned.signalCode, 'SIGKILL');
});
test('abort cancels a finite child and no startup command starts after pre-abort', async () => {
  const controller = new AbortController(), children = [];
  const run = runOwnedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, onSpawn: c => { children.push(c); }, timeoutMs: 2000 });
  controller.abort(Error('interrupted')); await assert.rejects(run, /interrupted/); assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
  await assert.rejects(runOwnedCommand(process.execPath, ['-e', '0'], { signal: controller.signal, onSpawn: c => children.push(c) }), /interrupted/);
  assert.equal(children.length, 1);
});


test('derived page, native services and launcher ranges cannot include reserved ports', () => {
  assert.throws(() => nativePagePorts(7829), /reserved/);
  assert.throws(() => nativePagePorts(7729), /reserved/);
  assert.equal(nativePagePorts(19120).length, 29);
});
test('the launched-world recipe exports actual address fields and owns clients separately from finite commands', () => {
  const world = { ...addresses(19120), world: WORLD }, children = [], registrations = [];
  const verify = () => 'verified';
  const recipe = nativePageRecipe(parent, world, children, (child, mode) => registrations.push({ child, mode }), verify);
  assert.equal(recipe.checkout, parent); assert.equal(recipe.pkg, join(parent, 'v2/target/wasm-load/pkg'));
  assert.deepEqual(recipe.world, { directory: world.directory, gateway: world.gateway, world: WORLD, page: world.page });
  assert.equal(recipe.world.dir, undefined); assert.equal(recipe.verify(), 'verified');
  const client = { id: 'long-lived-client' }, command = { id: 'finite-command' };
  recipe.registerClient(client); recipe.registerCommand(command);
  assert.deepEqual(children, [client]);
  assert.deepEqual(registrations, [{ child: client, mode: { processGroup: true } }, { child: command, mode: { transient: true } }]);
});
test('owned group cleanup kills descendants even after its direct leader has exited', async () => {
  const leader = spawn(process.execPath, ['-e', "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref();process.stdout.write('owned');"], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((ok, no) => { leader.once('error', no); leader.once('exit', ok); });
    assert.equal(leader.exitCode, 0); assert.doesNotThrow(() => process.kill(-leader.pid, 0));
    await stopOwnedChild(leader, { processGroup: true });
    assert.throws(() => process.kill(-leader.pid, 0), { code: 'ESRCH' });
  } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} }
});
