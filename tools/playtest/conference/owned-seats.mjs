// Conference seats on an already-owned native world. This module never starts or stops a world/browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lastJson, pairArgs, seatEnv } from '../arena/new-engine/seat.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const privateJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

export function requireConferenceRecipe(recipe) {
  assert(recipe?.kind === 'native-page' && recipe.checkout && recipe.pkg && recipe.world?.directory,
    'conference-proof requires the pinned native-page recipe with its world and replica package');
  assert.equal(typeof recipe.registerClient, 'function', 'conference-proof requires native-page registerClient');
  assert.equal(typeof recipe.registerCommand, 'function', 'conference-proof requires native-page registerCommand');
  for (const name of ['replica.js', 'replica_bg.wasm']) assert(existsSync(join(recipe.pkg, name)), `conference-proof missing pinned ${name}`);
}

/** The family caller checks capture prerequisites before spending an owned native boot. No cache discovery. */
export function conferenceCaptureResources({ browserCache, browserExecutable, ffmpegExecutable, browserSHA256, ffmpegSHA256 }) {
  assert([browserCache, browserExecutable, ffmpegExecutable].every(p => typeof p === 'string' && isAbsolute(p)), 'conference-proof explicit capture paths required');
  for (const [role, file, expected] of [['browser', browserExecutable, browserSHA256], ['ffmpeg', ffmpegExecutable, ffmpegSHA256]]) {
    const rel = relative(resolve(browserCache), resolve(file));
    assert(rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), `conference-proof ${role} outside explicit cache`);
    assert(/^[a-f0-9]{64}$/.test(expected ?? ''), `conference-proof ${role} pinned SHA256 required`);
    try { accessSync(file, constants.R_OK | constants.X_OK); }
    catch { assert.fail(`conference-proof ${role} executable missing or unreadable`); }
    assert.equal(hash(readFileSync(file)), expected, `conference-proof ${role} SHA256 mismatch`);
  }
  assert.equal(relative(resolve(browserCache), resolve(ffmpegExecutable)), 'ffmpeg-1013/ffmpeg-mac', 'conference-proof recorder must match Playwright 1.64.1 cache layout');
  return { browserCache, browserExecutable, ffmpegExecutable, browserSHA256, ffmpegSHA256 };
}

/** Register before waiting; retain exit/signal truth even when a failed command prints success-looking JSON. */
export function ownedConferenceCommand(recipe, args, { cwd, env, signal, log, onLine, timeoutMs = 15000 }) {
  signal.throwIfAborted();
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', error;
    const timer = setTimeout(() => { error = Error('conference-proof.command-timeout'); child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', e => { error ??= e; });
    child.stdout.on('data', bytes => {
      stdout += bytes; pending += bytes;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('close', (code, killedBy) => {
      clearTimeout(timer);
      try {
        privateJson(log, { args, stdout, stderr, code, signal: killedBy, error: error ? String(error) : null });
        if (error || code !== 0 || killedBy !== null) throw error ?? Error(`conference-proof.command-exit:${code}/${killedBy}`);
        const answer = lastJson(stdout); assert(answer, 'conference-proof command returned no JSON'); ok(answer);
      } catch (e) { no(e); }
    });
    try { recipe.registerCommand(child); }
    catch (e) { error = e; child.kill('SIGKILL'); }
  });
}

/** Follow the public world-list route; the front-door origin itself is not a world's client endpoint. */
export async function conferenceWorldPage({ base, signal }) {
  const response = await fetch(new URL('/__sim/worlds.json', base), { signal });
  assert.equal(response.status, 200, 'conference-proof public world list');
  const catalog = await response.json();
  const worlds = catalog.worlds?.filter(w => w.name === 'Presentation rehearsal' && w.template === 'conference-rehearsal') ?? [];
  assert.equal(worlds.length, 1, 'conference-proof public world discovery must be unambiguous');
  const page = new URL(worlds[0].url, base);
  assert(page.origin === new URL(base).origin && /^\/w\/[a-z][a-z0-9-]*\/$/.test(page.pathname), 'conference-proof world page must stay on the owned origin');
  page.search = ''; page.hash = '';
  return page.href;
}

/** Fetch the actual served bytes; version only unpacks the loader and cannot start pairing or a daemon. */
export async function downloadConferenceClient({ base, paths, signal }) {
  const configResponse = await fetch(new URL('v1/config', base), { signal });
  assert.equal(configResponse.status, 200, 'conference-proof served config');
  const described = (await configResponse.json()).soulClient;
  const response = await fetch(new URL('eden.mjs', base), { signal });
  assert.equal(response.status, 200, 'conference-proof served client');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), described?.sha256, 'conference-proof served client SHA256');
  assert.equal(bytes.length, described?.bytes, 'conference-proof served client byte count');
  const file = join(paths.data, 'served-client.mjs'); writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  privateJson(join(paths.dir, 'conference-served-client.json'), { sha256: hash(bytes), bytes: bytes.length, version: described.version, commit: described.commit ?? null, source: described.source ?? null });
  return file;
}

/** Daemon ownership remains with registerClient and the enclosing runOwnedAttempt cleanup. */
export async function startConferenceResident({ recipe, clientRoot, seat, signal, log }) {
  signal.throwIfAborted();
  const fd = openSync(log, 'wx', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(clientRoot, 'v2/client/src/daemon/daemon.mjs'), '--home', seat.home,
      '--soul', seat.soul, '--pkg', recipe.pkg, '--ready-fd', '3'], {
      cwd: seat.folder, env: seat.env, detached: true, signal, stdio: ['ignore', fd, fd, 'pipe'],
    });
  } finally { closeSync(fd); }
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error('conference-proof.resident-ready-timeout')), 10000);
    const finish = error => { clearTimeout(timer); error ? no(error) : ok(); };
    let ready = '';
    child.stdio[3].on('data', data => { ready += data; if (ready.includes('\n')) finish(ready.trim() === 'ready' ? null : Error('conference-proof.resident-ready-invalid')); });
    child.once('error', finish);
    child.once('exit', () => finish(Error('conference-proof.resident-exited')));
    try { recipe.registerClient(child); }
    catch (error) { child.kill('SIGKILL'); finish(error); }
  });
  return child;
}

async function conferenceServedSource({ recipe, paths, bundle, seat, signal }) {
  const { folder, home, env, label } = seat;
  let ordinal = 0;
  const command = (args, options = {}) => ownedConferenceCommand(recipe, args, {
    cwd: folder, env, signal, log: join(paths.dir, `conference-command-${label}-${++ordinal}.json`), ...options,
  });
  await command([bundle, 'version']);
  const unpacked = join(home, 'bin/client');
  const versions = readdirSync(unpacked).filter(n => existsSync(join(unpacked, n, '.whole')));
  assert.equal(versions.length, 1, 'conference-proof fresh home has one served payload');
  const clientRoot = join(unpacked, versions[0]);
  // The served payload, not another checkout's client, supplies all three ordinary modules.
  for (const file of ['pair/pair.mjs', 'daemon/daemon.mjs', 'cli/souls.mjs']) {
    const source = join('v2/client/src', file);
    assert.equal(hash(readFileSync(join(clientRoot, source))), hash(readFileSync(join(recipe.checkout, source))),
      `conference-proof served source mismatch: ${source}`);
  }
  return { command, clientRoot };
}

export async function pairConferenceSeat({ recipe, paths, bundle, label, name, signal }) {
  requireConferenceRecipe(recipe);
  assert(/^[a-z][a-z0-9-]{0,31}$/.test(label), 'conference-proof synthetic seat label');
  const folder = join(paths.data, 'seats', label), home = join(folder, '.souls'); mkdirSync(folder, { recursive: true });
  const env = seatEnv(home, recipe.pkg), seat = { label, folder, home, env, soul: null, body: null };
  const { command, clientRoot } = await conferenceServedSource({ recipe, paths, bundle, seat, signal });
  let resolveApproval;
  const approval = new Promise(ok => { resolveApproval = ok; });
  const pairing = command([join(clientRoot, 'v2/client/src/pair/pair.mjs'), ...pairArgs(recipe.world, label), '--name', name], {
    timeoutMs: 20000, onLine: line => { const answer = lastJson(line); if (answer?.step === 'approve') resolveApproval(answer); },
  });
  // Observe early failure immediately, while the normal approval code arrives.
  const settled = pairing.then(answer => ({ answer }), error => ({ error }));
  const asked = await Promise.race([approval, settled.then(() => { throw Error('conference-proof.pair-ended-before-approval'); })]);
  const response = await fetch(new URL('/v1/pair/approve', recipe.world.directory), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ code: asked.code, confirm: true, test_person: label }),
  });
  assert.equal(response.status, 200, 'conference-proof synthetic owner approval');
  const result = await settled;
  if (result.error) throw result.error;
  assert.equal(result.answer?.ok, true, 'conference-proof pairing outcome');
  assert(result.answer.soul, 'conference-proof pairing names its Soul'); seat.soul = result.answer.soul;
  privateJson(join(paths.dir, `conference-seat-${label}.json`), { label, name, soul: seat.soul, clientRoot, bundleSHA256: hash(readFileSync(bundle)) });
  const resident = await startConferenceResident({ recipe, clientRoot, seat, signal, log: join(paths.dir, `conference-client-${label}.log`) });
  seat.cli = async (...words) => {
    signal.throwIfAborted();
    assert(resident.exitCode === null && resident.signalCode === null, 'conference-proof resident must remain alive');
    return command([bundle, ...words, '--soul', seat.soul]);
  };
  const until = Date.now() + 10000;
  while (!seat.body) {
    signal.throwIfAborted();
    const status = await seat.cli('status'); seat.body = status.body ?? null;
    assert(Date.now() < until, 'conference-proof named Soul body admission');
    if (!seat.body) await new Promise((ok, no) => {
      const abort = () => { clearTimeout(timer); no(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); ok(); }, 50);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  return seat;
}


/** Only this registered resident may start. Finite creator CLIs cannot auto-start another daemon. */
export function conferenceCreatorArgs({ clientRoot, home, soul }, words) {
  assert(typeof soul === 'string' && /^c_[A-Za-z0-9_-]+$/.test(soul), 'conference creator grant required');
  return ['--permission', `--allow-fs-read=${clientRoot}`, `--allow-fs-read=${resolve(home, '..')}`, `--allow-fs-write=${home}`,
    join(clientRoot, 'v2/client/src/creator/souls-god.mjs'), ...words, '--creator', soul];
}

/** Probe the actual Node executable on the real unchanged auto-start path before starting a creator resident. */
export async function verifyConferenceCreatorPermission({ recipe, paths, clientRoot, signal }) {
  const home = join(paths.data, 'creator-child-probe'); mkdirSync(home, { recursive: true });
  const module = pathToFileURL(join(clientRoot, 'v2/client/src/daemon/client.mjs')).href;
  const script = `import { call } from ${JSON.stringify(module)};
    try { await call(${JSON.stringify(home)}, 'c_public', {op:'describe'}, {within:500}); process.exitCode=2; }
    catch(error) { console.log(JSON.stringify({node:process.version,code:error.code,permission:error.permission,canSpawn:process.permission.has('child')})); }`;
  const result = await ownedConferenceCommand(recipe, ['--permission', `--allow-fs-read=${clientRoot}`,
    `--allow-fs-read=${home}`, `--allow-fs-write=${home}`, '--input-type=module', '-e', script], {
    cwd: home, env: { PATH: process.env.PATH, BRAIN_MODE: 'fake' }, signal,
    log: join(paths.dir, 'command-conference-creator-node.json'),
  });
  assert(result.node === process.version && result.code === 'ERR_ACCESS_DENIED' && result.permission === 'ChildProcess' && result.canSpawn === false,
    'conference creator Node must fail closed before daemon auto-spawn');
  return result;
}

export async function pairConferenceCreator({ recipe, paths, bundle, signal }) {
  requireConferenceRecipe(recipe);
  // The unchanged native-page fixture starts its world under paths.data/world;
  // recipe.world exposes public endpoints, not the world's filesystem directory.
  // This is run.sh's public seeded principal, never a token or stored credential.
  let principal;
  try { principal = readFileSync(join(paths.data, 'world', 'creator'), 'utf8').trim(); }
  catch { assert.fail('conference-proof public boot creator principal missing or unreadable'); }
  assert(/^[0-9a-f]{32}-[0-9]+$/.test(principal), 'conference-proof public boot creator principal malformed');
  const label = 'conference-creator', folder = join(paths.data, 'seats', label), home = join(folder, '.souls');
  mkdirSync(folder, { recursive: true });
  const seat = { label, folder, home, env: seatEnv(home, recipe.pkg), soul: null };
  const { command, clientRoot } = await conferenceServedSource({ recipe, paths, bundle, seat, signal });
  const creatorModule = 'v2/client/src/creator/souls-god.mjs';
  assert.equal(hash(readFileSync(join(clientRoot, creatorModule))), hash(readFileSync(join(recipe.checkout, creatorModule))),
    'conference-proof served creator source mismatch');
  await verifyConferenceCreatorPermission({ recipe, paths, clientRoot, signal });
  let resolveApproval;
  const approval = new Promise(ok => { resolveApproval = ok; });
  const pairing = command([join(clientRoot, 'v2/client/src/pair/pair.mjs'), ...pairArgs(recipe.world, label), '--creator', `creator-${principal}`], {
    timeoutMs: 20000, onLine: line => { const answer = lastJson(line); if (answer?.step === 'approve') resolveApproval(answer); },
  });
  const settled = pairing.then(answer => ({ answer }), error => ({ error }));
  const asked = await Promise.race([approval, settled.then(() => { throw Error('conference-proof.creator-pair-ended-before-approval'); })]);
  const response = await fetch(new URL('/v1/pair/approve', recipe.world.directory), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'Ada' }),
  });
  assert.equal(response.status, 200, 'conference-proof synthetic creator approval');
  const result = await settled;
  if (result.error) throw result.error;
  assert(result.answer?.ok === true && result.answer.soul === `c_${principal}`, 'conference-proof pairing must return the public creator grant');
  seat.soul = result.answer.soul;
  const resident = await startConferenceResident({ recipe, clientRoot, seat, signal, log: join(paths.dir, 'conference-client-creator.log') });
  seat.cli = async (...words) => {
    signal.throwIfAborted();
    assert(resident.exitCode === null && resident.signalCode === null, 'conference-proof creator resident must remain alive');
    // Node's directory read allowance covers descendants, not chdir back to the
    // allowance directory itself. Long socket paths temporarily change cwd.
    return command(conferenceCreatorArgs({ clientRoot, home, soul: seat.soul }, words), { cwd: home });
  };
  return seat;
}
