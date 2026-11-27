// Actual apps/web over a fresh native world. Product builds are pinned separately from the owning helper/driver.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, closeSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { checkPort, portFree } from '../../e2e/local-smoke.mjs';
import { pairSeat } from '../playtest/arena/new-engine/seat.mjs';
import { startOldPage } from '../playtest/arena/new-engine/old-page.mjs';
import { verifySealedPublicInputs } from './sealed-public-inputs.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = name => { throw Error('proof.native-page-' + name); };
const inside = (root, file) => { const path = resolve(root, file), rel = relative(root, path); if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail('artifact-path'); return path; };
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function files(root) {
  const found = {};
  for (const name of readdirSync(root).sort()) {
    const at = join(root, name), info = statSync(at);
    if (info.isDirectory()) for (const [child, value] of Object.entries(files(at))) found[name + '/' + child] = value;
    else if (info.isFile()) found[name] = hash(readFileSync(at));
    else fail('artifact-kind');
  }
  return found;
}
export function createNativePageArtifacts(checkout, { template = 'worlds/templates/hello-hamlet.json', caddy }) {
  const root = resolve(checkout); if (git(root, 'status', '--porcelain')) fail('source-dirty');
  if (!git(root, 'ls-files', '--error-unmatch', '--', template)) fail('template-untracked');
  const source = Object.fromEntries(git(root, 'ls-files', '--', 'apps/web', 'tools/world-launcher', 'v2/tools/dev', 'v2/tools/import-eden', 'v2/client/served', 'v2/tools/ops/proxy', template).split('\n').filter(Boolean).map(file => [file, hash(readFileSync(inside(root, file)))]));
  const trees = Object.fromEntries(['apps/web/dist', 'v2/web/dist', 'mars/viewer/dist/client', 'v2/target/wasm-load/pkg'].map(path => [path, files(inside(root, path))]));
  const bins = Object.fromEntries(['worldd', 'gatewayd', 'directoryd', 'testworld', 'assets-check', 'register-world'].map(name => [name, { path: 'v2/target/release/' + name, hash: hash(readFileSync(join(root, 'v2/target/release', name))) }]));
  return { schema: 'native-page-proof-artifacts/1', sourceHead: git(root, 'rev-parse', 'HEAD'), template, source, trees, bins, caddy: { path: resolve(caddy), hash: hash(readFileSync(caddy)) } };
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
  if (!isAbsolute(m.caddy?.path ?? '') || hash(readFileSync(m.caddy.path)) !== m.caddy.hash) fail('caddy');
  return m;
}
export function nativePagePorts(port) {
  const ports = [...Array.from({ length: 8 }, (_, i) => port + i), ...Array.from({ length: 21 }, (_, i) => port + 101 + i)];
  for (const p of ports) checkPort(p);
  return ports;
}
export async function startNativePageFixture({ checkout, data, log, port, artifacts, sealedInputs, recordingArtifacts, costMeasurement, signal, onSpawn, timeoutMs = 180000 }) {
  const until = Date.now() + timeoutMs; signal?.throwIfAborted();
  for (const p of nativePagePorts(port).slice(0, 8)) if (!await portFree(p)) fail('occupied-port');
  const root = resolve(checkout), m = verifyNativePageArtifacts(root, artifacts), children = [];
  const sealedPublic = sealedInputs ? verifySealedPublicInputs(sealedInputs) : null;
  const recordingRoot = recordingArtifacts ? resolve(recordingArtifacts.checkout) : root;
  const recordingPin = recordingArtifacts?.artifacts ?? artifacts;
  const recording = recordingArtifacts ? verifyNativePageArtifacts(recordingRoot, recordingPin) : m;
  if (recordingArtifacts && !sealedPublic) fail('recording-without-seal');
  if (sealedPublic && sealedPublic.sourceHead !== recording.sourceHead) fail('sealed-source');
  if (sealedPublic) {
    if (sealedPublic.assets.artifactHash !== recordingPin.hash || sealedPublic.validator?.js !== recording.trees['v2/target/wasm-load/pkg']['replica.js'] || sealedPublic.validator?.wasm !== recording.trees['v2/target/wasm-load/pkg']['replica_bg.wasm']) fail('sealed-artifact');
    if (sealedPublic.validator.js !== m.trees['v2/target/wasm-load/pkg']['replica.js'] || sealedPublic.validator.wasm !== m.trees['v2/target/wasm-load/pkg']['replica_bg.wasm']) fail('playback-reader-mismatch');
    for (const path of ['apps/web/dist', 'v2/web/dist', 'mars/viewer/dist/client']) {
      const tree = sealedPublic.assets.trees.find(t => t.root === join(recordingRoot, path));
      if (!tree || JSON.stringify(Object.entries(tree.files).sort()) !== JSON.stringify(Object.entries(recording.trees[path]).sort())) fail('sealed-assets');
    }
  }
  if (costMeasurement && (!sealedPublic || typeof costMeasurement.observer !== 'boolean' || !Number.isSafeInteger(costMeasurement.targetTick * 50000) || costMeasurement.targetTick < 0 || (costMeasurement.witnesses && (!Array.isArray(costMeasurement.witnesses) || costMeasurement.witnesses.length > 8 || costMeasurement.witnesses.some(n => !Number.isSafeInteger(n) || n < 1))))) fail('cost-declaration');
  if (Date.now() >= until) fail('startup-timeout');
  const commandRecords = []; let ordinal = 0;
  const onCommand = event => { const id = ++ordinal; const record = { ...event, id }; commandRecords.push(record); writeFileSync(join(data, '..', `command-native-${id}.json`), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 }); return id; };
  writeFileSync(join(data, '..', 'native-page-provenance.json'), JSON.stringify({ artifactPin: artifacts, ...m, ...(sealedPublic ? { recording: { sourceHead: recording.sourceHead, artifactPin: recordingPin, sealedInputs }, playback: { sourceHead: m.sourceHead, artifactPin: artifacts } } : {}) }, null, 2), { flag: 'wx', mode: 0o600 });
  const runtime = await startOldPage({ checkout: root, template: m.template, dir: data, port, bin: join(root, 'v2/target/release'),
    marsWeb: join(root, 'mars/viewer/dist/client'), pkg: join(root, 'v2/target/wasm-load/pkg'), caddy: m.caddy.path, pinnedArtifacts: true, sealedPublic, signal, timeoutMs: until - Date.now(),
    onCommand, onSpawn(child, mode) { if (!mode?.transient) children.push(child); onSpawn(child, mode); }, log: text => writeFileSync(log, text + '\n', { flag: 'a', mode: 0o600 }) });
  const viewer = new URL(runtime.page);
  if (costMeasurement) {
    viewer.searchParams.set('camera-observation-cost', '1'); if (costMeasurement.observer) viewer.searchParams.set('camera-observe', '1');
    if (costMeasurement.witnesses?.length) viewer.searchParams.set('camera-cost-witness', costMeasurement.witnesses.join(','));
    viewer.hash = 't=' + String(costMeasurement.targetTick * 50000);
  }
  return { child: children[0], children, base: runtime.base, viewer: viewer.href, dataDir: resolve(data), recipe: { kind: 'native-page', costMeasurement, async joinActor(label='camera-subject') {
    if (sealedPublic) fail('sealed-actor-mutation');
    signal?.throwIfAborted();
    const seat=await pairSeat({world:runtime.world,dir:join(data,'actors'),label,name:'Camera Subject',pkg:join(root,'v2/target/wasm-load/pkg'),checkout:root,onSpawn,signal,approveMs:15000});
    signal?.throwIfAborted();const fd=openSync(log,'a',0o600);let daemon;
    try { daemon=spawn(process.execPath,[join(root,'v2/client/src/daemon/daemon.mjs'),'--home',seat.home,'--soul',seat.soul,'--pkg',join(root,'v2/target/wasm-load/pkg'),'--ready-fd','3'],{cwd:seat.folder,env:{PATH:process.env.PATH,BRAIN_MODE:'fake'},detached:true,stdio:['ignore',fd,fd,'pipe']});onSpawn(daemon,{processGroup:true}); } finally {closeSync(fd);}
    await waitActorReady(daemon,{signal,timeoutMs:15000});
    const joined=await seat.join({ms:15000});if(!joined.body)throw Error('native-actor-join-failed');
    return {body:joined.body,cli:(...words)=>seat.cli(...words)};
  }, verify: () => { const product = verifyNativePageArtifacts(root, artifacts); if (sealedInputs) verifySealedPublicInputs(sealedInputs); if (recordingArtifacts) verifyNativePageArtifacts(recordingRoot, recordingPin); return product; } } };
}

/** Readiness ownership is separate from process teardown, which remains with the attempt owner. */
export function waitActorReady(daemon,{signal,timeoutMs=15000}={}) {
 return new Promise((resolve,reject)=>{
  let text='',settled=false;const pipe=daemon.stdio[3];
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);pipe.off('data',data);daemon.off('error',failed);daemon.off('exit',exited);signal?.removeEventListener('abort',aborted);error?reject(error):resolve();};
  const data=d=>{text+=d;if(text.includes('ready\n'))finish();},failed=e=>finish(e),exited=()=>finish(Error('native-actor-daemon-exited')),aborted=()=>finish(signal.reason??Error('native-actor-daemon-aborted'));
  const timer=setTimeout(()=>finish(Error('native-actor-daemon-timeout')),timeoutMs);pipe.on('data',data);daemon.once('error',failed);daemon.once('exit',exited);signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
 });
}
