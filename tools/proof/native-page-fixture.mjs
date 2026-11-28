// Actual apps/web over a fresh native world. Product builds are pinned separately from the owning helper/driver.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {createRequire} from 'node:module';
import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { checkPort, portFree } from '../../e2e/local-smoke.mjs';
import { startOldPage } from '../playtest/arena/new-engine/old-page.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = name => { throw Error('proof.native-page-' + name); };
const inside = (root, file) => { const path = resolve(root, file), rel = relative(root, path); if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail('artifact-path'); return path; };
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function files(root, regular = false) {
  const found = {};
  for (const name of readdirSync(root).sort()) {
    const at = join(root, name), info = regular ? lstatSync(at) : statSync(at);
    if (info.isDirectory()) for (const [child, value] of Object.entries(files(at,regular))) found[name + '/' + child] = value;
    else if (info.isFile()) found[name] = hash(readFileSync(at));
    else fail('artifact-kind');
  }
  return found;
}
// Exactly the synchronous normal consumer and its two runtime data imports; type imports execute nothing.
const BODY_CONSUMER=['v2/web/body-assets.ts','mars/viewer/engine/bodies/models.ts','mars/viewer/engine/bodies/creatures.ts'];
const loadedConsumers=new Map();
export function nativePageBodyPackage(root,path,expected) {
  const directory=inside(root,path),consumer={};
  for(const file of BODY_CONSUMER){
    const absolute=inside(root,file),info=lstatSync(absolute);
    if(!info.isFile()||info.isSymbolicLink())fail('body-consumer');
    const bytes=readFileSync(absolute),recorded=execFileSync('git',['-C',root,'show',`HEAD:${file}`]);
    if(hash(bytes)!==hash(recorded)||expected&&expected.consumer?.[file]!==hash(bytes))fail('body-consumer');
    consumer[file]=hash(bytes);
  }
  const fingerprint=JSON.stringify(consumer),module=inside(root,BODY_CONSUMER[0]),prior=loadedConsumers.get(module);
  if(prior&&prior.fingerprint!==fingerprint)fail('body-consumer-reload');
  const api=prior?.api??createRequire(import.meta.url)(module);
  if(typeof api.bodyAssetFiles!=='function'||!Array.isArray(api.BODY_SOURCE_FILES))fail('body-consumer');
  loadedConsumers.set(module,{fingerprint,api});
  // This is the selected product's existing full admission/provenance policy, never the tool checkout's copy.
  api.bodyAssetFiles(directory,root);
  const sources=Object.fromEntries(api.BODY_SOURCE_FILES.map(file=>[file,hash(readFileSync(inside(root,file)))]));
  const tree=files(directory,true),result={path:relative(root,directory),consumer,sources,files:tree};
  if(expected&&JSON.stringify(result)!==JSON.stringify(expected))fail('body-package');
  return result;
}

export function createNativePageArtifacts(checkout, { template = 'worlds/templates/hello-hamlet.json', caddy, bodies }) {
  const root = resolve(checkout); if (git(root, 'status', '--porcelain')) fail('source-dirty');
  if (!git(root, 'ls-files', '--error-unmatch', '--', template)) fail('template-untracked');
  const source = Object.fromEntries(git(root, 'ls-files', '--', 'apps/web', 'tools/world-launcher', 'v2/tools/dev', 'v2/tools/import-eden', 'v2/client/served', 'v2/tools/ops/proxy', template).split('\n').filter(Boolean).map(file => [file, hash(readFileSync(inside(root, file)))]));
  const trees = Object.fromEntries(['apps/web/dist', 'v2/web/dist', 'mars/viewer/dist/client', 'v2/target/wasm-load/pkg'].map(path => [path, files(inside(root, path))]));
  const bins = Object.fromEntries(['worldd', 'gatewayd', 'directoryd', 'testworld', 'assets-check', 'register-world'].map(name => [name, { path: 'v2/target/release/' + name, hash: hash(readFileSync(join(root, 'v2/target/release', name))) }]));
  return { schema: 'native-page-proof-artifacts/1', sourceHead: git(root, 'rev-parse', 'HEAD'), template, source, trees, bins, ...(bodies?{bodies:nativePageBodyPackage(root,bodies)}:{}), caddy: { path: resolve(caddy), hash: hash(readFileSync(caddy)) } };
}
export function verifyNativePageArtifacts(checkout, pin) {
  const root = resolve(checkout); if (!pin?.file || !/^[a-f0-9]{64}$/.test(pin.hash)) fail('artifact-pin');
  const bytes = readFileSync(inside(resolve(pin.root ?? checkout), pin.file)); if (hash(bytes) !== pin.hash) fail('artifact-pin');
  const m = JSON.parse(bytes);
  if (m.schema !== 'native-page-proof-artifacts/1' || !/^[a-f0-9]{40}$/.test(m.sourceHead) || git(root, 'rev-parse', 'HEAD') !== m.sourceHead || git(root, 'status', '--porcelain')) fail('source-pin');
  if (!m.template?.startsWith('worlds/templates/') || !git(root, 'ls-files', '--error-unmatch', '--', m.template)) fail('template');
  for (const required of [m.template, 'apps/web/src/LiveWorld.tsx', 'tools/world-launcher/launcher.mjs', 'v2/tools/dev/run.sh']) if (!m.source?.[required]) fail('source-missing');
  for (const [file, expected] of Object.entries(m.source)) if (hash(readFileSync(inside(root, file))) !== expected) fail('source-file');
  for (const path of ['apps/web/dist', 'v2/web/dist', 'mars/viewer/dist/client', 'v2/target/wasm-load/pkg']) {
    if (!m.trees?.[path] || JSON.stringify(files(inside(root, path))) !== JSON.stringify(m.trees[path])) fail('artifact-files');
  }
  for (const name of ['worldd', 'gatewayd', 'directoryd', 'testworld', 'assets-check', 'register-world']) {
    if (m.bins?.[name]?.path !== 'v2/target/release/' + name || hash(readFileSync(inside(root, m.bins[name].path))) !== m.bins[name].hash) fail('binary');
  }
  if(m.bodies)nativePageBodyPackage(root,m.bodies.path,m.bodies);
  if (!isAbsolute(m.caddy?.path ?? '') || hash(readFileSync(m.caddy.path)) !== m.caddy.hash) fail('caddy');
  return m;
}
export function nativePagePorts(port) {
  const ports = [...Array.from({ length: 8 }, (_, i) => port + i), ...Array.from({ length: 21 }, (_, i) => port + 101 + i)];
  for (const p of ports) checkPort(p);
  return ports;
}
/** The recipe exposes the launched world's addresses and registers every later child with its owner. */
export function nativePageRecipe(checkout, world, children, onSpawn, verify, bodies) {
  const root = resolve(checkout);
  return { kind: 'native-page', checkout: root, pkg: join(root, 'v2/target/wasm-load/pkg'),
    ...(bodies?{bodies:{directory:inside(root,bodies.path),catalogue:inside(root,bodies.path+'/bodies.json'),sha256:bodies.files['bodies.json']}}:{}),
    world: { directory: world.directory, gateway: world.gateway, world: world.world, page: world.page },
    registerClient(child) { children.push(child); onSpawn(child, { processGroup: true }); },
    registerCommand(child) { onSpawn(child, { transient: true }); }, verify };
}
export async function startNativePageFixture({ checkout, data, log, port, artifacts, signal, onSpawn, timeoutMs = 180000 }) {
  const until = Date.now() + timeoutMs; signal?.throwIfAborted();
  for (const p of nativePagePorts(port).slice(0, 8)) if (!await portFree(p)) fail('occupied-port');
  const root = resolve(checkout), m = verifyNativePageArtifacts(root, artifacts), children = [];
  if (Date.now() >= until) fail('startup-timeout');
  const commandRecords = []; let ordinal = 0;
  const onCommand = event => { const id = ++ordinal; const record = { ...event, id }; commandRecords.push(record); writeFileSync(join(data, '..', `command-native-${id}.json`), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 }); return id; };
  writeFileSync(join(data, '..', 'native-page-provenance.json'), JSON.stringify({ artifactPin: artifacts, ...m }, null, 2), { flag: 'wx', mode: 0o600 });
  const runtime = await startOldPage({ checkout: root, ...(m.bodies?{bodies:inside(root,m.bodies.path)}:{}), template: m.template, dir: data, port, bin: join(root, 'v2/target/release'),
    marsWeb: join(root, 'mars/viewer/dist/client'), pkg: join(root, 'v2/target/wasm-load/pkg'), caddy: m.caddy.path, pinnedArtifacts: true, signal, timeoutMs: until - Date.now(),
    onCommand, onSpawn(child, mode) { if (!mode?.transient) children.push(child); onSpawn(child, mode); }, log: text => writeFileSync(log, text + '\n', { flag: 'a', mode: 0o600 }) });
  return { child: children[0], children, base: runtime.base, viewer: runtime.page, dataDir: resolve(data), recipe: nativePageRecipe(root, runtime.world, children, onSpawn, () => verifyNativePageArtifacts(root, artifacts),m.bodies) };
}
