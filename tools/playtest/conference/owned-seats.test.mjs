import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as unixServer } from 'node:net';
import { atSocket, runtimeOf } from '../../../v2/client/src/home/home.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { conferenceCaptureResources, conferenceWorldPage, downloadConferenceClient, ownedConferenceCommand, requireConferenceRecipe, startConferenceResident, conferenceCreatorArgs, verifyConferenceCreatorPermission, pairConferenceCreator } from './owned-seats.mjs';

const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(join(scratch, 'conference-owned-seat-tests-'));
const children = [];
const recipe = { registerCommand(child) { children.push(child); }, registerClient(child) { children.push(child); } };
const controller = new AbortController();
let ordinal = 0;
const options = () => ({ cwd: directory, env: { PATH: process.env.PATH, BRAIN_MODE: 'fake' }, signal: controller.signal, log: join(directory, `command-${++ordinal}.json`) });
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'close');
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await done;
  }
});

test('missing pinned recipe capabilities refuse before any pairing child exists', () => {
  assert.throws(() => requireConferenceRecipe({ kind: 'native-page' }), /pinned native-page recipe/);
  assert.equal(children.length, 0);
});

test('ordinary command is registered immediately and its JSON reply is forwarded', async () => {
  const before = children.length;
  const pending = ownedConferenceCommand(recipe, ['-e', 'console.log(JSON.stringify({ok:true,can:"no",says:"question_pending",fix:null}))'], options());
  assert.equal(children.length, before + 1, 'registration happens before awaiting output');
  assert.deepEqual(await pending, { ok: true, can: 'no', says: 'question_pending', fix: null });
  assert.equal(children.at(-1).exitCode, 0);
});

test('a failed pairing command cannot pass on success-looking partial stdout', async () => {
  const opts = options();
  await assert.rejects(ownedConferenceCommand(recipe, ['-e', 'console.log(JSON.stringify({ok:true,soul:"synthetic"}));process.exitCode=1'], opts), /command-exit:1/);
  const saved = JSON.parse(readFileSync(opts.log, 'utf8'));
  assert.equal(saved.code, 1); assert.equal(saved.signal, null);
  assert(saved.stdout.includes('synthetic'));
});

test('aborted command is stopped and retained as failure', async () => {
  const abort = new AbortController(), opts = { ...options(), signal: abort.signal };
  const pending = ownedConferenceCommand(recipe, ['-e', 'setInterval(()=>{},1000)'], opts);
  abort.abort(Error('test cancellation'));
  await assert.rejects(pending);
  assert.notEqual(JSON.parse(readFileSync(opts.log, 'utf8')).signal, null);
  assert.notEqual(children.at(-1).signalCode, null);
});

test('post-pair resident readiness failure stays owned and stops on owner cleanup', async () => {
  const root = join(directory, 'payload'), path = join(root, 'v2/client/src/daemon'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'daemon.mjs'), 'import{writeSync}from"node:fs";writeSync(3,"wrong\\n");setInterval(()=>{},1000);');
  const before = children.length;
  const pending = startConferenceResident({ recipe: { ...recipe, pkg: directory }, clientRoot: root,
    seat: { home: join(directory, 'fresh-home'), soul: 'synthetic', folder: directory, env: options().env },
    signal: controller.signal, log: join(directory, 'resident.log') });
  assert.equal(children.length, before + 1);
  await assert.rejects(pending, /resident-ready-invalid/);
  const child = children.at(-1), done = once(child, 'close'); process.kill(-child.pid, 'SIGTERM'); await done;
  assert.equal(child.signalCode, 'SIGTERM');
});

test('served client hash mismatch refuses without launching a child', async () => {
  const before = children.length;
  const server = createServer((req, res) => {
    if (req.url === '/w/conference/v1/config') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ soulClient: { sha256: '0'.repeat(64), bytes: 4 } })); }
    else res.end('wrong');
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    await assert.rejects(downloadConferenceClient({ base: `http://127.0.0.1:${server.address().port}/w/conference/`, paths: { data: directory, dir: directory }, signal: controller.signal }), /served client SHA256/);
  } finally { await new Promise((ok, no) => server.close(error => error ? no(error) : ok())); }
  assert.equal(children.length, before);
});

test('ordinary world discovery rejects ambiguity and a route leaving its owned origin', async () => {
  let worlds = [{ name: 'Presentation rehearsal', template: 'conference-rehearsal', url: '/w/conference/?dev=1' }];
  const server = createServer((req, res) => {
    assert.equal(req.url, '/__sim/worlds.json');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ worlds }));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await conferenceWorldPage({ base, signal: controller.signal }), base + '/w/conference/');
    worlds.push({ ...worlds[0] });
    await assert.rejects(conferenceWorldPage({ base, signal: controller.signal }), /unambiguous/);
    worlds = [{ ...worlds[0], url: 'https://example.invalid/w/conference/' }];
    await assert.rejects(conferenceWorldPage({ base, signal: controller.signal }), /owned origin/);
  } finally { await new Promise((ok, no) => server.close(error => error ? no(error) : ok())); }
});

test('capture preflight refuses missing recorder and changed bytes before any owned boot', () => {
  const cache = join(directory, 'capture-cache'), browser = join(cache, 'chrome'), ffmpeg = join(cache, 'ffmpeg-1013/ffmpeg-mac');
  mkdirSync(join(cache, 'ffmpeg-1013'), { recursive: true });
  const bytes = '#!/bin/sh\nexit 0\n', digest = value => createHash('sha256').update(value).digest('hex');
  writeFileSync(browser, bytes, { mode: 0o700 });
  const inputs = { browserCache: cache, browserExecutable: browser, ffmpegExecutable: ffmpeg, browserSHA256: digest(bytes), ffmpegSHA256: digest(bytes) };
  assert.throws(() => conferenceCaptureResources(inputs), /ffmpeg executable missing/);
  writeFileSync(ffmpeg, bytes, { mode: 0o700 });
  assert.deepEqual(conferenceCaptureResources(inputs), inputs);
  writeFileSync(ffmpeg, bytes + '# changed\n');
  assert.throws(() => conferenceCaptureResources(inputs), /ffmpeg SHA256 mismatch/);
  assert.throws(() => conferenceCaptureResources({ ...inputs, browserExecutable: join(directory, 'elsewhere') }), /browser outside explicit cache/);
});


test('Node permission mode blocks the real daemon auto-start path before a missing-socket child can exist', async () => {
  const root = resolve(import.meta.dirname, '../../..'), home = join(directory, 'permission-home');
  mkdirSync(home);
  const module = new URL('../../../v2/client/src/daemon/client.mjs', import.meta.url).href;
  const script = `import { call } from ${JSON.stringify(module)};
    try { await call(${JSON.stringify(home)}, 'c_public', {op:'describe'}, {within:500}); process.exitCode=2; }
    catch(error) { console.log(JSON.stringify({code:error.code,permission:error.permission,canSpawn:process.permission.has('child')})); }`;
  const result = await ownedConferenceCommand(recipe, ['--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${home}`,
    '--input-type=module', '-e', script], options());
  assert.deepEqual(result, { code: 'ERR_ACCESS_DENIED', permission: 'ChildProcess', canSpawn: false });
  const runtime = join(home, 'souls/c_public/runtime');
  assert(existsSync(join(runtime, 'daemon.log')), 'the real missing-socket launch path reached its pre-spawn log open');
  assert(!existsSync(join(runtime, 'daemon.lock')) && !existsSync(join(runtime, 'daemon.sock')), 'no resident was created');
});


test('creator capability preflight uses this exact executable and records its Node version without spawning', async () => {
  const data = join(directory, 'creator-preflight'); mkdirSync(data);
  const result = await verifyConferenceCreatorPermission({ recipe, paths: { data, dir: data },
    clientRoot: resolve(import.meta.dirname, '../../..'), signal: controller.signal });
  assert.equal(result.node, process.version); assert.equal(result.permission, 'ChildProcess');
  assert.equal(children.at(-1).spawnfile, process.execPath);
  assert(!children.at(-1).spawnargs.includes('--allow-child-process'));
});

test('the unchanged ordinary creator CLI answers on an owned socket and fails closed after that socket disappears', async () => {
  const root = resolve(import.meta.dirname, '../../..'), home = join(directory, 'creator-cli-home'); mkdirSync(home);
  const rt = runtimeOf(home, 'c_public'), requests = [];
  const server = unixServer(socket => {
    let text = ''; socket.on('data', bytes => {
      text += bytes; if (!text.includes('\n')) return;
      requests.push(JSON.parse(text.split('\n')[0]));
      socket.end(JSON.stringify({ ok: true, nodes: [{ id: 'ground', kind: 'eden:ground', parent: null }], kinds: {} }) + '\n');
    });
  });
  await new Promise(ok => atSocket(rt.socket, path => server.listen(path, ok)));
  const args = conferenceCreatorArgs({ clientRoot: root, home, soul: 'c_public' }, ['describe']);
  assert(!args.includes('--allow-child-process'));
  try {
    const answer = await ownedConferenceCommand(recipe, args, { ...options(), env: { ...options().env, SOULS_HOME: home } });
    assert.equal(answer.ok, true); assert.equal(answer.nodes[0].id, 'ground');
    assert.deepEqual(requests, [{ op: 'describe' }]);
  } finally { await new Promise(ok => server.close(ok)); }
  const opts = { ...options(), env: { ...options().env, SOULS_HOME: home } };
  await assert.rejects(ownedConferenceCommand(recipe, args, opts), /command-exit:1/);
  const log = JSON.parse(readFileSync(opts.log));
  assert.match(log.stdout, /ERR_ACCESS_DENIED/); assert.equal(requests.length, 1);
  assert(!existsSync(rt.lock));
});


// Protocol-boundary unit fixtures only: no native process, world, token or modified product client.
for (const [approvalStatus, readyLine, error] of [[403, 'ready', /synthetic creator approval/], [200, 'wrong', /resident-ready-invalid/]]) {
  test(`creator approval ${approvalStatus} and readiness ${readyLine} failures remain under the existing owner`, async () => {
    const run = mkdtempSync(join(directory, 'creator-boundary-')), data = join(run, 'data'); mkdirSync(data);
    const principal = 'a'.repeat(32) + '-0', home = join(data, 'seats/conference-creator/.souls');
    const root = join(home, 'bin/client/fixture'); mkdirSync(root, { recursive: true });
    const approvalFile = join(run, 'approved'), abort = new AbortController(), localChildren = [], residents = [];
    const server = createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk;
      assert.deepEqual(JSON.parse(text), { code: 'unit-approval', confirm: true, test_person: 'Ada' });
      if (approvalStatus === 200) writeFileSync(approvalFile, 'approved');
      res.writeHead(approvalStatus); res.end('{}');
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const files = {
      'v2/client/src/pair/pair.mjs': `import {existsSync} from 'node:fs'; console.log(JSON.stringify({step:'approve',code:'unit-approval'}));
while(!existsSync(${JSON.stringify(approvalFile)})) await new Promise(ok=>setTimeout(ok,10));
console.log(JSON.stringify({ok:true,soul:'c_${principal}'}));`,
      'v2/client/src/daemon/daemon.mjs': `import {writeSync} from 'node:fs'; writeSync(3,${JSON.stringify(readyLine + '\n')}); setInterval(()=>{},1000);`,
      'v2/client/src/cli/souls.mjs': '', 'v2/client/src/creator/souls-god.mjs': '',
    };
    for (const file of ['v2/client/src/daemon/client.mjs', 'v2/client/src/home/home.mjs', 'tools/lib/is-main.mjs'])
      files[file] = readFileSync(new URL('../../../' + file, import.meta.url), 'utf8');
    for (const [file, text] of Object.entries(files)) {
      const path = join(root, file); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text);
    }
    writeFileSync(join(root, '.whole'), 'unit fixture');
    const bundle = join(run, 'bundle.mjs'); writeFileSync(bundle, 'console.log(JSON.stringify({ok:true}));');
    const worldDir = join(run, 'world'); mkdirSync(worldDir); writeFileSync(join(worldDir, 'creator'), principal);
    const pkg = join(run, 'pkg'); mkdirSync(pkg); for (const file of ['replica.js', 'replica_bg.wasm']) writeFileSync(join(pkg, file), '');
    const owned = { kind: 'native-page', checkout: root, pkg,
      world: { directory: `http://127.0.0.1:${server.address().port}`, world: 'unit', gateway: 'ws://example.invalid', page: 'http://example.invalid/' },
      registerCommand(child) { localChildren.push(child); children.push(child); },
      registerClient(child) { localChildren.push(child); residents.push(child); children.push(child); } };
    owned.world.dir = worldDir;
    try {
      await assert.rejects(pairConferenceCreator({ recipe: owned, paths: { data, dir: run }, bundle, signal: abort.signal }), error);
      assert(localChildren.length >= 3, 'version, exact permission probe and pair were registered');
      assert.equal(residents.length, approvalStatus === 200 ? 1 : 0);
      assert(localChildren.every(child => child.spawnfile === process.execPath));
      const pair = localChildren.find(child => child.spawnargs.some(arg => arg.endsWith('/pair/pair.mjs')));
      assert(pair.spawnargs.includes('creator-' + principal)); assert(!pair.spawnargs.includes('--start'));
    } finally {
      abort.abort(Error('unit cleanup'));
      await Promise.all(localChildren.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const done = once(child, 'close').catch(() => {});
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        await done;
      }));
      await new Promise(ok => server.close(ok));
    }
  });
}
