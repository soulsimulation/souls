#!/usr/bin/env node
// W3b's finite, root-owned initializer. The path unit supplies no arguments: the inbox is request identity only.
import { isMain } from './is-main.mjs';
import { constants } from 'node:fs';
import { lstat, realpath, readdir, mkdir, open, rename, chmod, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateWorldRoute } from './proxy/route-config.mjs';

const REQUEST = /^[a-f0-9]{64}$/, PIN = /^1220[a-f0-9]{64}$/;
const SLUG = /^(?!-)[a-z0-9-]{1,40}(?<!-)$/, INSTANCE = /^[a-f0-9]{32}-[a-f0-9]{32}-[0-9]+$/;
const PRINCIPAL = /^[a-f0-9]{32}:[0-9]+$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const CONFIG = '/etc/souls/placement.json';
const fail = name => { throw Error(name); };

// Bounded T0 data decoder for immutable directory identity records; never evaluates or imports request data.
export function record(bytes) {
  if (bytes.length > 65536) fail('placement-record-too-large');
  let at = 0;
  const item = (depth = 0) => {
    if (depth > 16 || at >= bytes.length) fail('placement-record-invalid');
    const byte = bytes[at++], major = byte >> 5, info = byte & 31;
    let count = info;
    if (info >= 24) {
      if (info > 27) fail('placement-record-invalid');
      const size = 2 ** (info - 24); count = 0;
      if (at + size > bytes.length) fail('placement-record-invalid');
      for (let i = 0; i < size; i++) count = count * 256 + bytes[at++];
    }
    if (!Number.isSafeInteger(count) || (major >= 2 && count > 65536)) fail('placement-record-invalid');
    if (major === 0) return count;
    if (major === 2 || major === 3) {
      if (at + count > bytes.length) fail('placement-record-invalid');
      const value = bytes.subarray(at, at += count); return major === 2 ? value : value.toString('utf8');
    }
    if (major === 4) return Array.from({ length: count }, () => item(depth + 1));
    if (major === 5) {
      const value = new Map();
      for (let i = 0; i < count; i++) { const key = item(depth + 1); if (value.has(key)) fail('placement-record-invalid'); value.set(key, item(depth + 1)); }
      return value;
    }
    fail('placement-record-invalid');
  };
  const value = item(); if (at !== bytes.length) fail('placement-record-invalid'); return value;
}
const id = value => Array.isArray(value) && value.length === 2 && Buffer.isBuffer(value[0]) && value[0].length === 16 && Number.isSafeInteger(value[1])
  ? `${value[0].toString('hex')}:${value[1]}` : fail('placement-identity-invalid');

export async function beneath(root, path, { missing = false } = {}) {
  root = resolve(root); path = resolve(path);
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('placement-path-escape');
  let current = root;
  for (const part of ['', ...rel.split('/').filter(Boolean)]) {
    current = part ? join(current, part) : current;
    try { if ((await lstat(current)).isSymbolicLink()) fail('placement-symlink'); }
    catch (error) { if (missing && error.code === 'ENOENT') return path; throw error; }
  }
  if (await realpath(root) !== root) fail('placement-root-symlink');
  return path;
}
export async function data(path, max = 1 << 20) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) fail('placement-data-invalid'); return await handle.readFile(); }
  finally { await handle.close(); }
}
export async function atomic(path, value, mode = 0o640) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.new-${randomUUID()}`, handle = await open(temp, 'wx', mode);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
  const parent = await open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
export async function command(program, args, env = process.env) {
  const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // The last 600 bytes of its error output go into the refusal, so the journal says why a placement stopped.
  child.stdout.resume(); let tail = ''; child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-600); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 240_000);
  try { await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => code === 0 ? yes() : no(Error(`placement-command-failed: ${program.split('/').pop()} ${args.slice(0, 2).join(' ')} | ${tail.replace(/\s+/g, ' ')}`))); }); }
  finally { clearTimeout(timer); }
}
const pause = ms => new Promise(yes => setTimeout(yes, ms));

// The directory's store (#1960 B7): the bucket DIRECTORY_STORE_URL (or DIRECTORY_STORE_ENDPOINT) names in the
// directory's secrets file, else the folder <worldsRoot>/directory (the unit's DIRECTORYD_WORLD_STORE). The rule is
// directoryd's own (S3::from_env, then the folder); a bucket is read through the installed supervisor, which applies
// it with these settings, so placement, archive and the directory never read two stores.
export const SECRETS = '/etc/souls/secrets.env';
export const STORE_KEYS = ['DIRECTORY_STORE_URL','DIRECTORY_STORE_ENDPOINT','DIRECTORY_STORE_BUCKET','DIRECTORY_STORE_REGION',
  'DIRECTORY_STORE_ACCESS_KEY_ID','DIRECTORY_STORE_SECRET_ACCESS_KEY','DIRECTORY_STORE_PREFIX','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_DEFAULT_REGION'];
/** The store's settings from KEY=value lines (systemd's EnvironmentFile form, as register-world reads it); only these. */
export function storeSettings(text) {
  const out = {};
  for (let line of text.split('\n')) {
    line = line.trim(); if (line.startsWith('export ')) line = line.slice(7);
    const at = line.indexOf('='); if (line.startsWith('#') || at < 1) continue;
    const key = line.slice(0, at).trim(); let value = line.slice(at + 1).trim();
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (STORE_KEYS.includes(key)) out[key] = value;
  }
  return out;
}
export async function readStoreSettings(file = SECRETS) {
  try { return storeSettings((await data(file)).toString('utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export const bucketNamed = settings => Boolean(settings.DIRECTORY_STORE_URL?.trim()) || settings.DIRECTORY_STORE_ENDPOINT !== undefined;
const KEY = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
async function supervisorGet(config, key, settings) {
  const child = spawn(join(config.library, 'supervisor'), ['directory-get', key],
    { env: { PATH:'/usr/bin:/bin', WORLDS_ROOT:config.worldsRoot, ...settings }, stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks = []; let size = 0;
  child.stdout.on('data', chunk => { size += chunk.length; if (size > 1 << 20) child.kill('SIGTERM'); else chunks.push(chunk); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes); }).finally(() => clearTimeout(timer));
  if (code === 3) throw Object.assign(Error('placement-store-absent'), { code: 'ENOENT' });
  if (code !== 0 || size > 1 << 20) fail('placement-store-unreachable');
  return Buffer.concat(chunks);
}
/** The directory's store as `{ kind, get(key) }`; `get` throws an ENOENT error when there is no object. */
export function directoryStore(config, settings = {}, { read = supervisorGet } = {}) {
  const root = resolve(config.worldsRoot);
  const get = async key => {
    if (!KEY.test(key)) fail('placement-store-key-invalid');
    return bucketNamed(settings) ? read(config, key, settings) : data(await beneath(root, join(root, 'directory', key)));
  };
  return { kind: bucketNamed(settings) ? 'bucket' : 'folder', settings, get };
}
// Same safe segment contract as the origin's public stream paths, relative to this world's export.
export const streamPath = value => typeof value === 'string' && /^views\/(?:[A-Za-z0-9._-]+\/)+$/.test(value) && !value.split('/').some(segment => segment === '.' || segment === '..');
export function checkedConfig(config) {
  if (config.format !== 'souls/placement/1' || !PIN.test(config.build)
      || !['worldsRoot','templates','library','placement','backup','worldRoutes','routesOut'].every(key => typeof config[key] === 'string' && isAbsolute(config[key]))
      || !Number.isInteger(config.portFirst) || !Number.isInteger(config.portLast) || config.portFirst < 1 || config.portLast > 65535 || config.portLast < config.portFirst) fail('placement-config-invalid');
  for (const key of ['directory','originUpstream']) {
    const url = new URL(config[key]);
    if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('placement-service-invalid');
  }
}
export async function ready(config, world, port) {
  const until = Date.now() + 60_000; let last;
  while (Date.now() < until) {
    try {
      const health = JSON.parse(await data(join(world, 'health.json')));
      const response = await fetch(`http://127.0.0.1:${port}/v2/ws`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      const pointer = JSON.parse(await data(join(world, 'views/world.json')));
      if (response.status === 400 && streamPath(pointer.stream) && Number.isInteger(health.ticks?.count)) {
        const stream = await fetch(`${config.originUpstream}/w/${world.split('/').at(-1)}/${pointer.stream}pointer`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (!stream.ok) throw Error('stream-not-ready');
        const bytes = Buffer.from(await stream.arrayBuffer());
        if (last && last.count < health.ticks.count && !last.bytes.equals(bytes)) return;
        last = { count: health.ticks.count, bytes };
      }
    } catch { /* Existing units own startup; this observer never repairs a world or stops its clock. */ }
    await pause(100);
  }
  fail('placement-not-ready');
}
async function asSouls(mode, request) {
  await command(process.execPath, [fileURLToPath(import.meta.url), '--as-souls', mode, request], { PATH:'/usr/bin:/bin', BRAIN_MODE:'fake' });
}

export async function prepareData(config, phase, { run = command } = {}) {
  const { request, instance, port } = phase, root = resolve(config.worldsRoot);
  const template = await beneath(config.templates, join(config.templates, phase.template));
  const binary = await beneath(config.library, join(config.library, 'worldd'));
  if (`1220${sha(await data(binary, 256 << 20))}` !== config.build) fail('placement-build-mismatch');
  const buildDir = await beneath(root, join(root, 'builds', config.build), { missing:true });
  await mkdir(buildDir, { recursive:true });
  const installed = join(buildDir, 'worldd');
  try { if (`1220${sha(await data(installed, 256 << 20))}` !== config.build) fail('placement-build-mismatch'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await copyFile(binary, installed, constants.COPYFILE_EXCL); await chmod(installed, 0o755); }
  const staging = await beneath(root, join(root, 'creating', request), { missing:true });
  let staged;
  try { staged = JSON.parse(await data(join(staging, 'world.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!staged) {
    try { if ((await readdir(staging)).length) fail('placement-fork-incomplete'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await run(binary, ['fork','--from',join(template,'ckpt'),'--template',template,'--to',staging,'--through',phase.creator,'--scope',phase.lineage]);
    staged = JSON.parse(await data(join(staging,'world.json')));
  }
  if (staged.name !== instance || staged.creator !== phase.creator.replace(':','-') || staged.fork !== true) fail('placement-staged-mismatch');
  await run('/bin/bash', [join(config.library,'ops/place-world.sh'),staging,'--port',String(port),'--build',config.build,'--resume','--data-only']);
}

export async function publishData(config, phase) {
  const world = await beneath(config.worldsRoot, join(config.worldsRoot,'worlds',phase.instance));
  const pointer = JSON.parse(await data(join(world,'views/world.json')));
  if (!streamPath(pointer.stream)) fail('placement-stream-invalid');
  await updateWorldRoute(config.worldRoutes, phase.name, { canonical:true,gateway:`http://127.0.0.1:${phase.port}`,
    stream:`/s/w/${phase.instance}/${pointer.stream}`,history:`/s/w/${phase.instance}/history/` });
  await atomic(join(config.backup,phase.request), { format:'souls/placement-backup/1',receipt:phase,
    authority:JSON.parse(await data(join(config.placement,'authority.json'))) });
}

export async function placeRequest(config, request, { run = command, asSouls: underSouls = asSouls, store } = {}) {
  checkedConfig(config); if (!REQUEST.test(request)) fail('placement-request-invalid');
  const root = resolve(config.worldsRoot);
  store ??= directoryStore(config, await readStoreSettings());
  const intent = JSON.parse(await store.get(`world-create/${request}`));
  const row = intent.row, ask = intent.ask;
  if (intent.request !== request || !row || !ask || !SLUG.test(row.name) || !SLUG.test(row.template)
      || !PRINCIPAL.test(row.creator) || !/^[a-f0-9]{32}$/.test(row.lineage) || !PRINCIPAL.test(row.zone)
      || row.name !== ask.name || row.template !== ask.template || row.creator !== ask.creator || row.label !== ask.label) fail('placement-intent-invalid');
  const named = record(await store.get(`world-name/${row.name}`));
  if (!(named instanceof Map) || named.size !== 5 || !Buffer.isBuffer(named.get(1)) || named.get(1).toString('utf8') !== row.name
      || !Buffer.isBuffer(named.get(2)) || named.get(2).toString('hex') !== row.lineage || id(named.get(3)) !== row.zone || id(named.get(4)) !== row.creator) fail('placement-owner-mismatch');
  const template = await beneath(config.templates,join(config.templates,row.template));
  const manifest = record(await data(join(template,'template')));
  if (!(manifest instanceof Map) || !Buffer.isBuffer(manifest.get(2)) || !Buffer.isBuffer(named.get(5)) || !named.get(5).equals(manifest.get(2)) || id(manifest.get(3)) !== row.zone) fail('placement-template-mismatch');
  const list = JSON.parse(await store.get('world-list'));
  if (!list.worlds?.some(r => r.name === row.name && r.lineage === row.lineage && r.zone === row.zone && r.creator === row.creator)) fail('placement-row-mismatch');
  const instance = `${row.lineage}-${row.zone.replace(':','-')}`; if (!INSTANCE.test(instance)) fail('placement-identity-invalid');
  const statusPath = await beneath(config.placement,join(config.placement,'status',request),{missing:true});
  const phase = { request,name:row.name,template:row.template,zone:row.zone,lineage:row.lineage,creator:row.creator,ready:false,instance };
  let receipt;
  try { receipt = JSON.parse(await data(statusPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (receipt && ['request','name','template','zone','lineage','creator','instance'].some(k => receipt[k] !== phase[k])) fail('placement-status-mismatch');
  if (receipt?.ready) return receipt;
  let registry;
  const authorityPath = join(config.placement,'authority.json');
  try { registry = JSON.parse(await data(authorityPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; registry = {format:'souls/world-authority/1',worldsRoot:root,worlds:{}}; }
  if (registry.format !== 'souls/world-authority/1' || registry.worldsRoot !== root || !registry.worlds || Array.isArray(registry.worlds)) fail('placement-authority-invalid');
  const existing = registry.worlds[row.name];
  if (existing && ['instance','creator','lineage','zone'].some(k => existing[k] !== phase[k])) fail('placement-authority-conflict');
  const reservations = Object.entries(registry.worlds).filter(([name]) => name !== row.name).map(([,v]) => v.port).filter(Number.isInteger);
  for (const name of await readdir(join(config.placement,'status'))) {
    if (!REQUEST.test(name) || name === request) continue;
    const other = JSON.parse(await data(join(config.placement,'status',name))); if (Number.isInteger(other.port)) reservations.push(other.port);
  }
  if (!receipt) {
    try {
      const restored = JSON.parse(await data(await beneath(config.backup,join(config.backup,request))));
      if (restored.format !== 'souls/placement-backup/1' || ['request','name','template','zone','lineage','creator','instance'].some(k => restored.receipt?.[k] !== phase[k])) fail('placement-backup-mismatch');
      // Restore only this revalidated identity's bounded port. Never adopt another writable authority row.
      receipt = {port:restored.receipt.port};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const port = receipt?.port ?? existing?.port ?? (() => { for (let p = config.portFirst; p <= config.portLast; p++) if (!reservations.includes(p)) return p; fail('placement-port-unavailable'); })();
  if (!Number.isInteger(port) || port < config.portFirst || port > config.portLast || reservations.includes(port)) fail('placement-port-invalid');
  phase.port = port; await atomic(statusPath,phase);
  // Rule 10 of the directory's list: a create unplaced for 15 minutes ends, its row removed, then the placement asked
  // again. This status is written first and the row and name read again after, so one of the two sees the other.
  const still = record(await store.get(`world-name/${row.name}`)), again = JSON.parse(await store.get('world-list'));
  if (!(still instanceof Map) || !Buffer.isBuffer(still.get(2)) || still.get(2).toString('hex') !== row.lineage
      || !again.worlds?.some(r => r.name === row.name && r.lineage === row.lineage)) fail('placement-create-ended');
  await underSouls('prepare',request);
  await run('/bin/bash',[join(config.library,'ops/place-world.sh'),'--configuration-only','--instance',instance,'--creator',row.creator.replace(':','-'),
    '--port',String(port),'--build',config.build,'--resume','--directory',new URL(config.directory).host,
    // On a bucket the world reads it as the directory does (the install drop-in's secrets file); on a folder, named.
    ...(store.kind === 'folder' ? ['--folder-store'] : []),'--start']);
  await underSouls('probe',request);
  const entry = {instance,creator:row.creator,lineage:row.lineage,zone:row.zone,port};
  if (registry.worlds[row.name] && JSON.stringify(registry.worlds[row.name]) !== JSON.stringify(entry)) fail('placement-authority-conflict');
  registry.worlds[row.name] = entry; await atomic(authorityPath,registry);
  await underSouls('publish',request);
  // The existing route unit is the sole map writer. Starting an already-running oneshot may coalesce with an
  // earlier map snapshot, so require this request's actual activation marker before reporting ready.
  await run('/usr/bin/systemctl',['start','souls-routes.service']);
  const marker = join(config.routesOut,'slugs',row.name);
  try {
    await beneath(config.routesOut,marker);
    if (!(await lstat(marker)).isFile()) fail('placement-route-pending');
  } catch (error) { if (error.code === 'ENOENT') fail('placement-route-pending'); throw error; }
  phase.ready = true; await atomic(statusPath,phase); return phase;
}

export async function drain(config) {
  const inbox = await beneath(config.placement, join(config.placement, 'requests'));
  const retained = await beneath(config.placement, join(config.placement, 'attempts'));
  // systemd serializes this finite unit. Move each inbox entry out first, so malformed/stale entries cannot
  // retrigger a failure loop or block another valid request. No tree is recursively deleted. A request is kept under
  // its own name, each new attempt replacing the last, so the retained attempts are one per request (27 Nov: a page
  // retrying one failing create left 120 nameless ones); only a malformed entry gets a name of its own.
  let refused = 0;
  for (const request of await readdir(inbox)) {
    const path = join(inbox, request), kept = join(retained, REQUEST.test(request) ? request : `invalid-${randomUUID()}`);
    try {
      await rename(path, kept);
      if (!(await lstat(kept)).isFile() || !REQUEST.test(request)) fail('placement-request-invalid');
      const { archiveRequest } = await import('./archive-world.mjs');
      if (!await archiveRequest(config, request)) await placeRequest(config, request);
    } catch (error) { refused++; console.error(`placement: request refused (${error?.message ?? error}); retained identity-bound status and world data`); }
  }
  // A refused run lasts at least REFUSED_PAUSE_MS: a page asking again for the same failing create starts this unit at
  // most a few times in systemd's start limit (5 in 10 s), which would otherwise fail souls-place.path for good.
  if (refused) await pause(refusedPause());
}
export const refusedPause = () => Number(process.env.SOULS_PLACE_REFUSED_PAUSE_MS ?? 3000);

// No top-level await: drain imports archive-world.mjs, which imports this module, so an entry module still awaiting its
// own evaluation would never settle that import (Node exits 13, every request set aside unplaced; 26 Nov).
if (isMain(import.meta.url)) setImmediate(async () => {
  try {
    if (process.getuid?.() !== 0) fail('placement-root-only');
    const child = process.argv[2] === '--as-souls';
    if (child) {
      const [mode, request] = process.argv.slice(3);
      if (process.argv.length !== 5 || !['prepare', 'probe', 'publish'].includes(mode) || !REQUEST.test(request)) fail('placement-mode-invalid');
      const uid = Number(execFileSync('/usr/bin/id', ['-u', 'souls'], { encoding: 'utf8' }).trim());
      const gid = Number(execFileSync('/usr/bin/id', ['-g', 'souls'], { encoding: 'utf8' }).trim());
      if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) fail('placement-account-invalid');
      process.setgroups([gid]); process.setgid(gid); process.setuid(uid);
    } else if (process.argv.length !== 2) fail('placement-arguments-refused');
    const stat = await lstat(CONFIG);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) fail('placement-config-untrusted');
    const config = JSON.parse(await data(CONFIG));
    // The installed route unit binds this one source and owns this one output. Only the ignored namespace
    // fixture translates these paths through the exported functions; no request can select a unit or mount.
    if (config.worldRoutes !== '/var/lib/souls/routes/worlds.json' || config.routesOut !== '/var/lib/souls-routes') fail('placement-route-config-invalid');
    if (child) {
      const [mode, request] = process.argv.slice(3);
      const phase = JSON.parse(await data(await beneath(config.placement, join(config.placement, 'status', request))));
      if (phase.request !== request || !INSTANCE.test(phase.instance) || !SLUG.test(phase.name) || !SLUG.test(phase.template) || !PRINCIPAL.test(phase.creator)) fail('placement-descriptor-invalid');
      if (mode === 'prepare') await prepareData(config, phase);
      if (mode === 'probe') await ready(config, join(config.worldsRoot, 'worlds', phase.instance), phase.port);
      if (mode === 'publish') await publishData(config, phase);
    } else await drain(config);
  } catch (error) {
    console.error(`placement: ${error.message}`); process.exitCode = 1;
    // A run refused before its drain (its configuration, its folders) pauses too. One that cannot load at all cannot:
    // the release resets a failed path unit and says so (release.sh placement).
    if (process.argv[2] !== '--as-souls') await pause(refusedPause());
  }
});
