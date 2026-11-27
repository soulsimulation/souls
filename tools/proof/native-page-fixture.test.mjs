import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createNativePageArtifacts, verifyNativePageArtifacts, nativePagePorts, nativePageClientRegistration, nativePageExportArgs, nativePageStartupRegistration } from './native-page-fixture.mjs';
import { stopOwnedChild } from './owned-attempt.mjs';
import { runOwnedCommand } from '../playtest/arena/new-engine/world.mjs';
const parent = resolve('.local/native-page-fixture-tests'); mkdirSync(parent, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, options = {}) {
  const root = mkdtempSync(join(parent, 'artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content = 'fixture') => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  for (const file of ['worlds/templates/hello-hamlet.json', 'apps/web/src/LiveWorld.tsx', 'tools/world-launcher/launcher.mjs', 'v2/tools/dev/run.sh', 'content/worlds/mars/map.json']) write(file);
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture']);
  // Synthetic source repository; ordinary configured commit hooks remain enabled.
  for (const path of ['apps/web/dist', 'v2/web/dist', 'mars/viewer/dist/client', 'v2/target/wasm-load/pkg']) write(path + '/fixture');
  for (const name of ['worldd', 'gatewayd', 'directoryd', 'testworld', 'assets-check', 'register-world']) write('v2/target/release/' + name);
  write('.gitignore', '.local/\n**/dist/\nv2/target/\n'); execFileSync('git', ['-C', root, 'add', '.gitignore']); execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'ignore outputs']);
  write('.local/caddy');
  const manifest = createNativePageArtifacts(root, { caddy: join(root, '.local/caddy'), ...options });
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
test('owned group cleanup kills descendants even after its direct leader has exited', async () => {
  const leader = spawn(process.execPath, ['-e', "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref();process.stdout.write('owned');"], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((ok, no) => { leader.once('error', no); leader.once('exit', ok); });
    assert.equal(leader.exitCode, 0); assert.doesNotThrow(() => process.kill(-leader.pid, 0));
    await stopOwnedChild(leader, { processGroup: true });
    assert.throws(() => process.kill(-leader.pid, 0), { code: 'ESRCH' });
  } finally { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} }
});

test('optional tracked map is pinned with template and cannot escape or borrow untracked bytes', t => {
  const f = fixture(t, { map: 'content/worlds/mars/map.json' });
  assert.equal(verifyNativePageArtifacts(f.root, f.pin).map, 'content/worlds/mars/map.json');
  assert.equal(f.manifest.source['content/worlds/mars/map.json'], hash(Buffer.from('fixture')));
  assert.throws(() => createNativePageArtifacts(f.root, { caddy: join(f.root, '.local/caddy'), map: '../map.json' }), /map-untracked/);
  assert.throws(() => createNativePageArtifacts(f.root, { caddy: join(f.root, '.local/caddy'), map: 'content/worlds/mars/missing.json' }));
  f.write('content/worlds/mars/map.json', 'changed');
  assert.throws(() => verifyNativePageArtifacts(f.root, f.pin), /source-pin/);
});

test('foreground controllers and finite commands enter the existing owner with distinct lifetimes', () => {
  const children = [], calls = [], recipe = nativePageClientRegistration(children, (child, mode) => calls.push({ child, mode }));
  const controller = {}, command = {};
  recipe.registerClient(controller); recipe.registerCommand(command);
  assert.deepEqual(children, [controller]);
  assert.deepEqual(calls, [{ child: controller, mode: { processGroup: true } }, { child: command, mode: { transient: true } }]);
});

test('tracked-map export uses the canonical exporter and fresh owned facts destination', t => {
  const f = fixture(t, { map: 'content/worlds/mars/map.json' }), facts = join(f.root, '.local/run/data/template.facts.json');
  assert.deepEqual(nativePageExportArgs(f.root, f.manifest, facts), [join(f.root, 'v2/tools/import-eden/export/export.ts'), '--template', join(f.root, f.manifest.template), '--out', facts, '--map', join(f.root, f.manifest.map)]);
  assert.throws(() => nativePageExportArgs(f.root, { ...f.manifest, map: '../escape' }, facts), /artifact-path/);
});

test('startup output is observed before forwarding the same child and mode to its existing owner', async () => {
  const { EventEmitter } = await import('node:events'), child = { stdout: new EventEmitter(), stderr: new EventEmitter() }, mode = { transient: true, processGroup: true }, output = [], calls = [];
  const register = nativePageStartupRegistration((seen, flags) => { assert.equal(seen, child); assert.equal(flags, mode); calls.push(seen); seen.stderr.emit('data', Buffer.from('missing dependency')); }, text => output.push(text));
  register(child, mode); child.stdout.emit('data', Buffer.from('export detail'));
  assert.deepEqual(output, ['startup stderr: missing dependency', 'startup stdout: export detail']); assert.deepEqual(calls, [child]);
});
